/**
 * Mesas de una sucursal. Lo usan el dueño (cualquier sucursal) y el gerente (solo la suya).
 *
 *   GET  ?sucursal=ID                                              → mesas de esa sucursal
 *   POST { accion: 'crear',     sucursal_id, nombre }
 *   POST { accion: 'lote',      sucursal_id, desde, hasta, prefijo? }   crea "1".."10" (o "Terraza 1".."Terraza 6")
 *   POST { accion: 'renombrar', id, nombre }
 *   POST { accion: 'activar',   id, activa }
 *   POST { accion: 'eliminar',  id }
 *
 * El gerente SIEMPRE trabaja sobre su sucursal: aunque mande otro sucursal_id, se usa la suya, y las acciones
 * por id (renombrar, activar, eliminar) solo afectan mesas de su sucursal.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { entero, esDuplicado, largo, noVacio } from '../../util.js';

function leerNombreMesa(v: unknown): string {
  const n = String(v ?? '').trim();
  if (n === '' || largo(n) > 30) throw fallo('El nombre de la mesa es obligatorio (máximo 30 caracteres).');
  return n;
}

export async function rutasAdminMesas(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/mesas',
    handler: async (req, reply) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      /** Sucursal sobre la que se trabaja: la pedida (dueño) o la propia (gerente). Debe existir en esta empresa. */
      const sucursalPropia = async (pedida: number): Promise<number> => {
        const id = alcance ?? pedida;
        const s = await fila('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [id, nid]);
        if (!s) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        return id;
      };
      // Para las acciones por id: el gerente solo alcanza mesas de su sucursal.
      const filtroMesa = alcance !== null ? ' AND sucursal_id = ?' : '';
      const parametrosFiltro = alcance !== null ? [alcance] : [];

      if (req.method === 'GET') {
        const q = req.query as Record<string, unknown>;
        const sid = await sucursalPropia(entero(q['sucursal']));
        const r = await filas('SELECT m.id, m.nombre, m.activa, m.orden, z.nombre AS zona FROM mesas m LEFT JOIN zonas z ON z.id = m.zona_id WHERE m.sucursal_id = ? AND m.negocio_id = ? ORDER BY m.orden, m.id', [sid, nid]);
        return { ok: true, mesas: r.map((m) => ({ id: Number(m['id']), nombre: m['nombre'], zona: m['zona'] ?? null, activa: Boolean(Number(m['activa'])), orden: Number(m['orden']) })) };
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM mesas WHERE sucursal_id = ?', [sid]);
          try {
            const r = await ejecutar('INSERT INTO mesas (negocio_id, sucursal_id, nombre, orden) VALUES (?, ?, ?, ?)', [nid, sid, leerNombreMesa(d['nombre']), Number(sig?.['n'])]);
            reply.code(201);
            return { ok: true, id: r.insertId };
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya existe una mesa con ese nombre en esta sucursal.');
            throw e;
          }
        }
        case 'lote': {
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          const desde = entero(d['desde'] ?? 1);
          const hasta = entero(d['hasta']);
          const prefijo = String(d['prefijo'] ?? '').trim();
          if (desde < 1 || hasta < desde || hasta - desde > 99) throw fallo('Indica un rango válido (por ejemplo del 1 al 10; máximo 100 mesas a la vez).');
          if (largo(prefijo) > 20) throw fallo('El prefijo no puede pasar de 20 caracteres.');
          const max = await fila('SELECT COALESCE(MAX(orden), 0) AS n FROM mesas WHERE sucursal_id = ?', [sid]);
          let orden = Number(max?.['n']);
          let creadas = 0;
          for (let i = desde; i <= hasta; i++) {
            // INSERT IGNORE: si una mesa con ese nombre ya existe, se salta sin error.
            const r = await ejecutar('INSERT IGNORE INTO mesas (negocio_id, sucursal_id, nombre, orden) VALUES (?, ?, ?, ?)', [nid, sid, leerNombreMesa((prefijo !== '' ? `${prefijo} ` : '') + i), ++orden]);
            creadas += r.affectedRows;
          }
          reply.code(201);
          return { ok: true, creadas };
        }
        case 'renombrar':
          try {
            await ejecutar(`UPDATE mesas SET nombre = ? WHERE id = ? AND negocio_id = ?${filtroMesa}`, [leerNombreMesa(d['nombre']), entero(d['id']), nid, ...parametrosFiltro]);
            return { ok: true };
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya existe una mesa con ese nombre en esta sucursal.');
            throw e;
          }
        case 'activar':
          await ejecutar(`UPDATE mesas SET activa = ? WHERE id = ? AND negocio_id = ?${filtroMesa}`, [noVacio(d['activa']) ? 1 : 0, entero(d['id']), nid, ...parametrosFiltro]);
          return { ok: true };

        case 'eliminar':
          // Los pedidos anteriores conservan el nombre de la mesa (ordenes.mesa), así que no se pierde historial.
          await ejecutar(`DELETE FROM mesas WHERE id = ? AND negocio_id = ?${filtroMesa}`, [entero(d['id']), nid, ...parametrosFiltro]);
          return { ok: true };

        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
