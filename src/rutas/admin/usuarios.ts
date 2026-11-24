/**
 * Usuarios del equipo de una empresa. Lo usan el dueño y el gerente.
 *
 *   GET  → lista de usuarios, las sucursales disponibles y los roles que quien consulta puede asignar.
 *   POST { accion: 'crear',  nombre, usuario, password, rol, sucursal_id, sucursales_extra? }
 *   POST { accion: 'editar', id, nombre, rol, activo, sucursal_id, sucursales_extra? }
 *   POST { accion: 'clave',  id, password }
 *
 * Roles asignables:
 *   - Dueño:   cocina (taquero), caja, mesero y gerente.
 *   - Gerente: cocina, caja y mesero, siempre en SU sucursal. No ve ni toca a otros gerentes ni al dueño.
 * Varias sucursales: sucursal_id es la principal y sucursales_extra (solo el dueño la envía) las demás; la persona cambia
 * entre ellas con el selector de la pantalla. Un gerente solo ve y administra al personal que trabaja ÚNICAMENTE en su sucursal.
 * Los administradores (dueños) no se crean ni se degradan desde aquí; solo se les puede cambiar el nombre.
 */
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { sucursalesActivas } from '../../negocio.js';
import { CORREO_VALIDO, exigirCorreoListo, mandarEnlace } from '../../acceso.js';
import { correoListo } from '../../correo.js';
import { randomBytes } from 'node:crypto';
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
      const puedeTocar = (o: { rol: string; sucursal_id: number | null; extras: number }): boolean =>
        alcance === null || (ROLES_GERENTE.includes(o.rol) && o.sucursal_id === alcance && o.extras === 0);

      /** Sucursales adicionales que envía el dueño (sin repetir la principal). undefined = no se mandó, no se toca. */
      const extrasDe = (v: unknown, principal: number): number[] | undefined => {
        if (alcance !== null || v === undefined) return undefined;
        const ids = [...new Set((Array.isArray(v) ? v : []).map(entero))].filter((id) => id !== principal);
        for (const id of ids) if (!activas.some((s) => s.id === id)) throw fallo('Una de las sucursales elegidas ya no existe.');
        return ids;
      };
      /** Reemplaza las sucursales adicionales de un usuario. */
      const guardarExtras = async (usuarioId: number, ids: number[] | undefined): Promise<void> => {
        if (ids === undefined) return;
        await ejecutar('DELETE FROM usuario_sucursales WHERE usuario_id = ?', [usuarioId]);
        for (const sid of ids) await ejecutar('INSERT INTO usuario_sucursales (usuario_id, sucursal_id, negocio_id) VALUES (?, ?, ?)', [usuarioId, sid, nid]);
      };

      if (req.method === 'GET') {
        const r = await filas(
          `SELECT u.id, u.nombre, u.usuario, u.correo, u.clave_pendiente, u.rol, u.activo, u.creado_en, u.sucursal_id, s.nombre AS sucursal
             FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
            WHERE u.negocio_id = ?${alcance !== null ? " AND u.sucursal_id = ? AND u.rol IN ('taquero','caja','mesero') AND NOT EXISTS (SELECT 1 FROM usuario_sucursales x WHERE x.usuario_id = u.id)" : ''}
            ORDER BY u.activo DESC, u.rol = 'admin' DESC, u.nombre`,
          alcance !== null ? [nid, alcance] : [nid],
        );
        const extras = await filas('SELECT usuario_id, sucursal_id FROM usuario_sucursales WHERE negocio_id = ?', [nid]);
        const extrasDeUsuario = (id: number): number[] => extras.filter((x) => Number(x['usuario_id']) === id).map((x) => Number(x['sucursal_id']));
        return {
          ok: true,
          yo: yo.id,
          usuarios: r.map((u) => ({
            id: Number(u['id']), nombre: u['nombre'], usuario: u['usuario'], correo: u['correo'] ?? null, pendiente: Boolean(Number(u['clave_pendiente'])), rol: u['rol'], activo: Boolean(Number(u['activo'])), creado_en: u['creado_en'],
            sucursal_id: u['sucursal_id'] === null ? null : Number(u['sucursal_id']), sucursal: u['sucursal'],
            sucursales_extra: extrasDeUsuario(Number(u['id'])),
          })),
          sucursales: alcance === null ? activas : activas.filter((s) => s.id === alcance),
          roles,
          correo_listo: correoListo(),
        };
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);

      /** Busca al usuario objetivo en esta empresa; si el gerente no puede tocarlo, "ya no existe". */
      const objetivo = async (id: number): Promise<{ rol: string; sucursal_id: number | null; extras: number }> => {
        const o = await fila('SELECT rol, sucursal_id, (SELECT COUNT(*) FROM usuario_sucursales x WHERE x.usuario_id = usuarios.id) AS extras FROM usuarios WHERE id = ? AND negocio_id = ?', [id, nid]);
        const dato = o ? { rol: String(o['rol']), sucursal_id: o['sucursal_id'] === null ? null : Number(o['sucursal_id']), extras: Number(o['extras']) } : null;
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
          await guardarExtras(r.insertId, extrasDe(d['sucursales_extra'], sucursalId));
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
          const principal = sucursalDelPersonal(d['sucursal_id']);
          const extras = extrasDe(d['sucursales_extra'], principal);
          await ejecutar('UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, sucursal_id = ? WHERE id = ? AND negocio_id = ?', [
            nombre, rol, noVacio(d['activo']) ? 1 : 0, principal, id, nid,
          ]);
          // Si cambió la principal y no se mandaron extras, se quita la nueva principal de las adicionales (no se repite).
          if (extras === undefined) await ejecutar('DELETE FROM usuario_sucursales WHERE usuario_id = ? AND sucursal_id = ?', [id, principal]);
          await guardarExtras(id, extras);
          return { ok: true };
        }
        case 'invitar': {
          exigirCorreoListo();
          const nombre = String(d['nombre'] ?? '').trim();
          const correo = String(d['correo'] ?? '').trim().toLowerCase();
          const rol = String(d['rol'] ?? '');
          if (nombre === '' || largo(nombre) > 80) throw fallo('Escribe el nombre de la persona (máximo 80 caracteres).');
          if (!CORREO_VALIDO.test(correo) || largo(correo) > 150) throw fallo('Escribe un correo válido.');
          if (!roles.includes(rol)) throw fallo(`Elige el rol: ${textoRoles}.`);
          const sucursalId = sucursalDelPersonal(d['sucursal_id']);
          const dup = await fila('SELECT COUNT(*) AS n FROM usuarios WHERE negocio_id = ? AND correo = ?', [nid, correo]);
          if (Number(dup?.['n']) > 0) throw new ErrorHttp(409, 'validacion', 'Ya existe una persona con ese correo.');
          // Nombre de acceso interno: la parte del correo antes de la @ (único dentro de la empresa).
          let base = (correo.split('@')[0] ?? '').replace(/[^a-z0-9._-]/g, '').slice(0, 34);
          if (base.length < 3) base = (base + 'usuario').slice(0, 10);
          let usuario = base;
          for (let i = 2; Number((await fila('SELECT COUNT(*) AS n FROM usuarios WHERE negocio_id = ? AND usuario = ?', [nid, usuario]))?.['n']) > 0; i++) usuario = `${base}${i}`;
          const r = await ejecutar('INSERT INTO usuarios (negocio_id, sucursal_id, nombre, usuario, correo, clave_pendiente, password_hash, rol) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', [
            nid, sucursalId, nombre, usuario, correo, await bcrypt.hash(randomBytes(24).toString('hex'), 10), rol,
          ]);
          await guardarExtras(r.insertId, extrasDe(d['sucursales_extra'], sucursalId));
          await mandarEnlace(req.negocio, r.insertId, 'invitacion');
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'reenviar': {
          // Primera invitación sin terminar → se reenvía; si ya tenía contraseña → se restablece (la anterior deja de servir).
          exigirCorreoListo();
          const id = entero(d['id']);
          await objetivo(id);
          const u = await fila('SELECT correo, clave_pendiente FROM usuarios WHERE id = ? AND negocio_id = ?', [id, nid]);
          if (!u?.['correo']) throw fallo('Esta persona no tiene correo registrado. Agrégaselo primero.');
          const pendiente = Number(u['clave_pendiente']) === 1;
          if (!pendiente) {
            await ejecutar('UPDATE usuarios SET password_hash = ?, clave_pendiente = 1 WHERE id = ? AND negocio_id = ?', [await bcrypt.hash(randomBytes(24).toString('hex'), 10), id, nid]);
            await ejecutar("DELETE FROM sesiones WHERE JSON_EXTRACT(datos, '$.usuario_id') = ? AND JSON_EXTRACT(datos, '$.negocio_id') = ?", [id, nid]);
          }
          await mandarEnlace(req.negocio, id, pendiente ? 'invitacion' : 'restablecer');
          return { ok: true };
        }
        case 'correo': {
          // A alguien que ya entra con usuario y contraseña se le agrega correo; conserva su contraseña hasta que cree una nueva.
          exigirCorreoListo();
          const id = entero(d['id']);
          await objetivo(id);
          const correo = String(d['correo'] ?? '').trim().toLowerCase();
          if (!CORREO_VALIDO.test(correo) || largo(correo) > 150) throw fallo('Escribe un correo válido.');
          const dup = await fila('SELECT COUNT(*) AS n FROM usuarios WHERE negocio_id = ? AND correo = ? AND id <> ?', [nid, correo, id]);
          if (Number(dup?.['n']) > 0) throw new ErrorHttp(409, 'validacion', 'Ya existe una persona con ese correo.');
          await ejecutar('UPDATE usuarios SET correo = ? WHERE id = ? AND negocio_id = ?', [correo, id, nid]);
          await mandarEnlace(req.negocio, id, 'invitacion');
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
