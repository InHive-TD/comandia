/**
 * Administración de parrillas / estaciones de cocina. Solo el dueño de la empresa.
 *
 *   POST (JSON) → { accion: 'crear' | 'renombrar' | 'eliminar', id?, nombre? }
 *
 * La lista de parrillas viene dentro de GET /admin/productos.
 * Al eliminar una parrilla, sus productos quedan "sin parrilla" (la base de datos lo hace sola con
 * ON DELETE SET NULL) y se reasignan después.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../../auth.js';
import { ejecutar, fila } from '../../db.js';
import { fallo } from '../../errores.js';
import { entero, largo } from '../../util.js';

function leerNombre(v: unknown): string {
  const nombre = String(v ?? '').trim();
  if (nombre === '' || largo(nombre) > 40) throw fallo('El nombre de la parrilla es obligatorio (máximo 40 caracteres).');
  return nombre;
}

export async function rutasEstaciones(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/estaciones',
    handler: async (req, reply) => {
      exigirMetodo(req, 'POST');
      await requerirRol(req, 'admin');
      const nid = req.negocio.id;
      const d = cuerpoJson(req);
      const id = entero(d['id']);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM estaciones WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT INTO estaciones (negocio_id, nombre, orden) VALUES (?, ?, ?)', [nid, leerNombre(d['nombre']), Number(sig?.['n'])]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'renombrar':
          await ejecutar('UPDATE estaciones SET nombre = ? WHERE id = ? AND negocio_id = ?', [leerNombre(d['nombre']), id, nid]);
          return { ok: true };
        case 'eliminar':
          await ejecutar('DELETE FROM estaciones WHERE id = ? AND negocio_id = ?', [id, nid]);
          return { ok: true };
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
