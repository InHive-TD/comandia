/**
 * Usuarios del equipo de una empresa. Lo usan el dueño y el gerente.
 *
 *   GET  → lista de usuarios, las sucursales disponibles y los roles que quien consulta puede asignar.
 *   POST { accion: 'crear',  nombre, usuario, password, rol, sucursal_id }
 *   POST { accion: 'editar', id, nombre, rol, activo, sucursal_id }
 *   POST { accion: 'clave',  id, password }
 *
 * Roles asignables:
 *   - Dueño:   cocina (taquero), caja, mesero y gerente.
 *   - Gerente: cocina, caja y mesero, siempre en SU sucursal. No ve ni toca a otros gerentes ni al dueño.
 * Los administradores (dueños) no se crean ni se degradan desde aquí; solo se les puede cambiar el nombre.
 */
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { sucursalesActivas } from '../../negocio.js';
import { entero, largo, noVacio } from '../../util.js';

const ROLES_DUENO = ['taquero', 'caja', 'mesero', 'gerente'];
const ROLES_GERENTE = ['taquero', 'caja', 'mesero'];

function validarPassword(p: string): void {
  if (largo(p) < 10) throw fallo('La contraseña debe tener al menos 10 caracteres.');
  if (largo(p) > 200) throw fallo('La contraseña es demasiado larga.');
}

export async function rutasUsuarios(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/usuarios',
    handler: async (req, reply) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance; // null = dueño (toda la empresa) · id = gerente (solo su sucursal)
      const roles = alcance === null ? ROLES_DUENO : ROLES_GERENTE;
      const textoRoles = alcance === null ? 'Cocina, Mesero, Caja o Gerente' : 'Cocina, Mesero o Caja';
      const activas = await sucursalesActivas(nid);

      /** Sucursal del personal: el gerente solo da de alta en la suya; el dueño elige entre las activas. */
      const sucursalDelPersonal = (v: unknown): number => {
        const id = alcance ?? entero(v);
        if (!activas.some((s) => s.id === id)) throw fallo('Elige la sucursal donde trabaja esta persona.');
        return id;
      };

      /** ¿Puede quien consulta tocar a este usuario? El gerente solo al personal de su sucursal. */
      const puedeTocar = (o: { rol: string; sucursal_id: number | null }): boolean =>
        alcance === null || (ROLES_GERENTE.includes(o.rol) && o.sucursal_id === alcance);

      if (req.method === 'GET') {
        const r = await filas(
          `SELECT u.id, u.nombre, u.usuario, u.rol, u.activo, u.creado_en, u.sucursal_id, s.nombre AS sucursal
             FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
            WHERE u.negocio_id = ?${alcance !== null ? " AND u.sucursal_id = ? AND u.rol IN ('taquero','caja','mesero')" : ''}
            ORDER BY u.activo DESC, u.rol = 'admin' DESC, u.nombre`,
          alcance !== null ? [nid, alcance] : [nid],
        );
        return {
          ok: true,
          yo: yo.id,
          usuarios: r.map((u) => ({
            id: Number(u['id']), nombre: u['nombre'], usuario: u['usuario'], rol: u['rol'], activo: Boolean(Number(u['activo'])), creado_en: u['creado_en'],
            sucursal_id: u['sucursal_id'] === null ? null : Number(u['sucursal_id']), sucursal: u['sucursal'],
          })),
          sucursales: alcance === null ? activas : activas.filter((s) => s.id === alcance),
          roles,
        };
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);

      /** Busca al usuario objetivo en esta empresa; si el gerente no puede tocarlo, "ya no existe". */
      const objetivo = async (id: number): Promise<{ rol: string; sucursal_id: number | null }> => {
        const o = await fila('SELECT rol, sucursal_id FROM usuarios WHERE id = ? AND negocio_id = ?', [id, nid]);
        const dato = o ? { rol: String(o['rol']), sucursal_id: o['sucursal_id'] === null ? null : Number(o['sucursal_id']) } : null;
        if (!dato || !puedeTocar(dato)) throw new ErrorHttp(404, 'validacion', 'Ese usuario ya no existe.');
        return dato;
      };

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const nombre = String(d['nombre'] ?? '').trim();
          const usuario = String(d['usuario'] ?? '').trim().toLowerCase();
          const rol = String(d['rol'] ?? '');
          const password = String(d['password'] ?? '');
          if (nombre === '' || largo(nombre) > 80) throw fallo('Escribe el nombre de la persona (máximo 80 caracteres).');
          if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw fallo('El usuario debe tener de 3 a 40 caracteres: letras sin acento, números, punto, guion o guion bajo.');
          if (!roles.includes(rol)) throw fallo(`Elige el rol: ${textoRoles}.`);
          validarPassword(password);
          const sucursalId = sucursalDelPersonal(d['sucursal_id']);
          const existe = await fila('SELECT COUNT(*) AS n FROM usuarios WHERE negocio_id = ? AND usuario = ?', [nid, usuario]);
          if (Number(existe?.['n']) > 0) throw new ErrorHttp(409, 'validacion', 'Ya existe un usuario con ese nombre de acceso. Elige otro.');
          const r = await ejecutar('INSERT INTO usuarios (negocio_id, sucursal_id, nombre, usuario, password_hash, rol) VALUES (?, ?, ?, ?, ?, ?)', [
            nid, sucursalId, nombre, usuario, await bcrypt.hash(password, 10), rol,
          ]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'editar': {
          const id = entero(d['id']);
          const o = await objetivo(id);
          const nombre = String(d['nombre'] ?? '').trim();
          if (nombre === '' || largo(nombre) > 80) throw fallo('Escribe el nombre de la persona (máximo 80 caracteres).');
          if (o.rol === 'admin') {
            // A un administrador solo se le puede cambiar el nombre.
            await ejecutar('UPDATE usuarios SET nombre = ? WHERE id = ? AND negocio_id = ?', [nombre, id, nid]);
            return { ok: true };
          }
          const rol = String(d['rol'] ?? '');
          if (!roles.includes(rol)) throw fallo(`Elige el rol: ${textoRoles}.`);
          await ejecutar('UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, sucursal_id = ? WHERE id = ? AND negocio_id = ?', [
            nombre, rol, noVacio(d['activo']) ? 1 : 0, sucursalDelPersonal(d['sucursal_id']), id, nid,
          ]);
          return { ok: true };
        }
        case 'clave': {
          const id = entero(d['id']);
          const password = String(d['password'] ?? '');
          validarPassword(password);
          await objetivo(id);
          await ejecutar('UPDATE usuarios SET password_hash = ? WHERE id = ? AND negocio_id = ?', [await bcrypt.hash(password, 10), id, nid]);
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
