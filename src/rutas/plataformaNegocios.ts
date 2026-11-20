import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { cuerpoJson } from '../auth.js';
import { ejecutar, fila, filas, transaccion } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import { SLUGS_RESERVADOS } from '../negocio.js';
import { requerirPlataforma } from './plataforma.js';

/** Fecha "AAAA-MM-DD" válida, o null si viene vacía. */
function leerFecha(v: unknown): string | null {
  const t = String(v ?? '').trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw fallo('La fecha de vencimiento no es válida.');
  }
  return t;
}

function textoOpcional(v: unknown, max: number, campo: string): string | null {
  const t = String(v ?? '').trim();
  if ([...t].length > max) throw fallo(`“${campo}” no puede pasar de ${max} caracteres.`);
  return t === '' ? null : t;
}

function leerPlan(v: unknown): string {
  const p = String(v ?? 'basico');
  return /^[a-z0-9_-]{1,30}$/.test(p) ? p : 'basico';
}

/**
 * Empresas de Comandia (solo el administrador de plataforma).
 *  GET → lista con sus números · POST { accion: crear | editar | estado | clave_admin }
 */
export async function rutasPlataformaNegocios(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/negocios',
    handler: async (req, reply) => {
      await requerirPlataforma(req);

      if (req.method === 'GET') {
        const r = await filas(
          `SELECT n.id, n.slug, n.nombre, n.activo, n.plan, n.vence_en, n.contacto, n.notas, n.creado_en,
                  (SELECT COUNT(*) FROM sucursales s WHERE s.negocio_id = n.id AND s.activa = 1) AS sucursales,
                  (SELECT COUNT(*) FROM usuarios u WHERE u.negocio_id = n.id AND u.activo = 1) AS usuarios,
                  (SELECT COUNT(*) FROM ordenes o WHERE o.negocio_id = n.id AND o.fecha_turno = CURDATE() AND o.estado <> 'cancelada') AS pedidos_hoy,
                  (SELECT COUNT(*) FROM ordenes o WHERE o.negocio_id = n.id AND o.fecha_turno >= CURDATE() - INTERVAL 30 DAY AND o.estado <> 'cancelada') AS pedidos_30d
             FROM negocios n ORDER BY n.activo DESC, n.nombre`,
        );
        return {
          ok: true,
          negocios: r.map((f) => ({
            ...f,
            id: Number(f['id']),
            activo: Boolean(Number(f['activo'])),
            sucursales: Number(f['sucursales']),
            usuarios: Number(f['usuarios']),
            pedidos_hoy: Number(f['pedidos_hoy']),
            pedidos_30d: Number(f['pedidos_30d']),
          })),
        };
      }

      const d = cuerpoJson(req);
      const accion = String(d['accion'] ?? '');

      if (accion === 'crear') {
        const nombre = String(d['nombre'] ?? '').trim();
        const slug = String(d['slug'] ?? '').trim().toLowerCase();
        const adminNombre = String(d['admin_nombre'] ?? '').trim();
        const adminUsuario = String(d['admin_usuario'] ?? '').trim().toLowerCase();
        const adminClave = String(d['admin_password'] ?? '');
        if (!nombre || [...nombre].length > 100) throw fallo('Escribe el nombre de la empresa (máximo 100 caracteres).');
        if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(slug) || slug.endsWith('-')) {
          throw fallo('La dirección debe tener de 2 a 39 caracteres: letras minúsculas sin acento, números y guiones (ej. lavale).');
        }
        if (SLUGS_RESERVADOS.has(slug)) throw fallo('Esa dirección está reservada por el sistema. Elige otra.');
        if (!adminNombre || [...adminNombre].length > 80) throw fallo('Escribe el nombre de quien administrará la empresa.');
        if (!/^[a-z0-9._-]{3,40}$/.test(adminUsuario)) {
          throw fallo('El usuario del administrador debe tener de 3 a 40 caracteres: letras sin acento, números, punto, guion o guion bajo.');
        }
        if ([...adminClave].length < 10 || [...adminClave].length > 200) throw fallo('La contraseña del administrador debe tener al menos 10 caracteres.');
        const existe = await fila('SELECT COUNT(*) AS n FROM negocios WHERE slug = ?', [slug]);
        if (Number(existe?.['n']) > 0) throw fallo('Ya hay una empresa con esa dirección. Elige otra.', 409);

        const vence = leerFecha(d['vence_en']);
        const contacto = textoOpcional(d['contacto'], 150, 'Contacto');
        const notas = textoOpcional(d['notas'], 255, 'Notas');
        const hash = await bcrypt.hash(adminClave, 10);
        const id = await transaccion(async (tx) => {
          const n = await tx.ejecutar('INSERT INTO negocios (slug, nombre, plan, vence_en, contacto, notas) VALUES (?, ?, ?, ?, ?, ?)', [slug, nombre, leerPlan(d['plan']), vence, contacto, notas]);
          const nid = n.insertId;
          // Lo mínimo para empezar: una sucursal, una parrilla, los ajustes y el administrador de la empresa.
          await tx.ejecutar('INSERT INTO sucursales (negocio_id, nombre, orden) VALUES (?, ?, 1)', [nid, 'Principal']);
          await tx.ejecutar('INSERT INTO estaciones (negocio_id, nombre, orden) VALUES (?, ?, 1)', [nid, 'Parrilla 1']);
          for (const [k, v] of [['bono_llevar', '5'], ['bono_aqui', '0'], ['min_preparacion', '15']] as const) {
            await tx.ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?)', [nid, k, v]);
          }
          await tx.ejecutar("INSERT INTO usuarios (negocio_id, nombre, usuario, password_hash, rol, sucursal_id) VALUES (?, ?, ?, ?, 'admin', NULL)", [nid, adminNombre, adminUsuario, hash]);
          return nid;
        });
        reply.code(201);
        return { ok: true, id, slug };
      }

      if (accion === 'editar') {
        const nombre = String(d['nombre'] ?? '').trim();
        if (!nombre || [...nombre].length > 100) throw fallo('Escribe el nombre de la empresa (máximo 100 caracteres).');
        await ejecutar('UPDATE negocios SET nombre = ?, plan = ?, vence_en = ?, contacto = ?, notas = ? WHERE id = ?', [
          nombre, leerPlan(d['plan']), leerFecha(d['vence_en']), textoOpcional(d['contacto'], 150, 'Contacto'), textoOpcional(d['notas'], 255, 'Notas'), Number(d['id'] ?? 0),
        ]);
        return { ok: true };
      }

      if (accion === 'estado') {
        const activo = Boolean(d['activo']);
        await ejecutar('UPDATE negocios SET activo = ? WHERE id = ?', [activo ? 1 : 0, Number(d['id'] ?? 0)]);
        return { ok: true, activo };
      }

      if (accion === 'clave_admin') {
        const id = Number(d['id'] ?? 0);
        const password = String(d['password'] ?? '');
        if ([...password].length < 10 || [...password].length > 200) throw fallo('La contraseña debe tener al menos 10 caracteres.');
        let usuario = String(d['usuario'] ?? '').trim().toLowerCase();
        // Sin indicar usuario: el administrador más antiguo de la empresa
        if (usuario === '') {
          const a = await fila("SELECT usuario FROM usuarios WHERE negocio_id = ? AND rol = 'admin' ORDER BY id LIMIT 1", [id]);
          usuario = String(a?.['usuario'] ?? '');
        }
        const existe = await fila("SELECT COUNT(*) AS n FROM usuarios WHERE negocio_id = ? AND usuario = ? AND rol = 'admin'", [id, usuario]);
        if (Number(existe?.['n']) === 0) throw fallo('No se encontró un administrador con ese usuario en esa empresa.', 404);
        await ejecutar("UPDATE usuarios SET password_hash = ?, activo = 1 WHERE negocio_id = ? AND usuario = ? AND rol = 'admin'", [await bcrypt.hash(password, 10), id, usuario]);
        return { ok: true, usuario };
      }

      throw new ErrorHttp(400, 'validacion', 'Acción no reconocida.');
    },
  });
}
