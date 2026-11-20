/**
 * Sucursales de la empresa.
 *
 *   GET  → las sucursales (con # de mesas y de personas). El dueño ve todas; el gerente solo la suya.
 *   POST { accion: 'crear', nombre, direccion? }                       solo el dueño
 *   POST { accion: 'editar', id, nombre, direccion?, activa }          solo el dueño
 *
 * Una empresa siempre conserva al menos UNA sucursal activa (si no, nadie podría trabajar).
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { entero, largo, noVacio } from '../../util.js';

function leerNombre(d: Record<string, unknown>): string {
  const n = String(d['nombre'] ?? '').trim();
  if (n === '' || largo(n) > 80) throw fallo('Escribe el nombre de la sucursal (máximo 80 caracteres).');
  return n;
}

function leerDireccion(d: Record<string, unknown>): string | null {
  const v = String(d['direccion'] ?? '').trim();
  if (largo(v) > 200) throw fallo('La dirección no puede pasar de 200 caracteres.');
  return v === '' ? null : v;
}

export async function rutasSucursales(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/sucursales',
    handler: async (req, reply) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      if (req.method === 'GET') {
        const r = await filas(
          `SELECT s.id, s.nombre, s.direccion, s.activa, s.orden,
                  (SELECT COUNT(*) FROM mesas m WHERE m.sucursal_id = s.id AND m.activa = 1) AS mesas,
                  (SELECT COUNT(*) FROM usuarios u WHERE u.sucursal_id = s.id AND u.activo = 1) AS usuarios
             FROM sucursales s WHERE s.negocio_id = ?${alcance !== null ? ' AND s.id = ?' : ''} ORDER BY s.activa DESC, s.orden, s.id`,
          alcance !== null ? [nid, alcance] : [nid],
        );
        return {
          ok: true,
          sucursales: r.map((s) => ({
            id: Number(s['id']), nombre: s['nombre'], direccion: s['direccion'], activa: Boolean(Number(s['activa'])),
            orden: Number(s['orden']), mesas: Number(s['mesas']), usuarios: Number(s['usuarios']),
          })),
        };
      }

      exigirMetodo(req, 'POST');
      if (alcance !== null) throw new ErrorHttp(403, 'sin_permiso', 'Solo el dueño de la empresa puede crear o cambiar sucursales.');
      const d = cuerpoJson(req);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM sucursales WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT INTO sucursales (negocio_id, nombre, direccion, orden) VALUES (?, ?, ?, ?)', [nid, leerNombre(d), leerDireccion(d), Number(sig?.['n'])]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'editar': {
          const id = entero(d['id']);
          const activa = noVacio(d['activa']) ? 1 : 0;
          const actual = await fila('SELECT activa FROM sucursales WHERE id = ? AND negocio_id = ?', [id, nid]);
          if (!actual) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          // No se puede pausar la última sucursal activa.
          if (!activa && Number(actual['activa']) === 1) {
            const otras = await fila('SELECT COUNT(*) AS n FROM sucursales WHERE negocio_id = ? AND activa = 1 AND id <> ?', [nid, id]);
            if (Number(otras?.['n']) === 0) throw new ErrorHttp(409, 'validacion', 'La empresa necesita al menos una sucursal activa.');
          }
          await ejecutar('UPDATE sucursales SET nombre = ?, direccion = ?, activa = ? WHERE id = ? AND negocio_id = ?', [leerNombre(d), leerDireccion(d), activa, id, nid]);
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
