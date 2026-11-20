/**
 * Prioridades por parrilla y ajustes de cocina (roles admin y gerente).
 *
 *   GET  /admin/prioridades → { estaciones, productos: [{id, nombre, categoria_id, categoria, prioridades: {estacion_id: nivel}}],
 *                               modalidad, min_preparacion, lote, general }
 *   POST { accion: 'producto',  producto_id,  estacion_id, nivel }     nivel: 0 = Normal, 1 = Alta, 2 = Urgente
 *        { accion: 'categoria', categoria_id, estacion_id, nivel }
 *        { accion: 'lote',      categorias: [ids] }                    categorías que cocina ve juntas ("Preparar en lote")
 *        { accion: 'modalidad', aqui, llevar, prep? }                  minutos extra por tipo de pedido y tiempo de preparación
 *
 * Los ajustes de cocina (lote / modalidad / prep) se guardan con la clave general de la empresa (dueño) o con la clave
 * "clave@<sucursal>" (gerente: sus propios ajustes). Las prioridades por producto son SOLO del dueño.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { fallo, ErrorHttp } from '../../errores.js';
import { bonosModalidad, categoriasLote, contexto, enTransaccion, minutosPreparacion } from '../../ordenes.js';
import { enteros, entero } from '../../util.js';

export async function rutasPrioridades(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/prioridades',
    handler: async (req) => {
      const yo = await requerirGestion(req);
      const c = contexto(req);
      const alcance = yo.alcance; // gerente: sus ajustes de cocina (clave@ID); dueño: los generales
      const sufijo = alcance !== null ? `@${alcance}` : '';

      if (req.method === 'GET') {
        const estaciones = (await c.filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [c.nid])).map((e) => ({ id: Number(e['id']), nombre: e['nombre'] }));
        const niveles = new Map<number, Record<string, number>>();
        for (const x of await c.filas('SELECT pr.producto_id, pr.estacion_id, pr.nivel FROM prioridades pr JOIN estaciones es ON es.id = pr.estacion_id WHERE pr.nivel > 0 AND es.negocio_id = ?', [c.nid])) {
          const k = Number(x['producto_id']);
          niveles.set(k, { ...(niveles.get(k) ?? {}), [String(x['estacion_id'])]: Number(x['nivel']) });
        }
        const productos = (
          await c.filas(
            `SELECT p.id, p.nombre, c.id AS categoria_id, c.nombre AS categoria
               FROM productos p JOIN categorias c ON c.id = p.categoria_id
              WHERE p.negocio_id = ? AND c.negocio_id = p.negocio_id ORDER BY c.orden, c.id, p.nombre`,
            [c.nid],
          )
        ).map((f) => ({ id: Number(f['id']), nombre: f['nombre'], categoria_id: Number(f['categoria_id']), categoria: f['categoria'], prioridades: niveles.get(Number(f['id'])) ?? {} }));
        const general = alcance === null;
        return { ok: true, estaciones, productos, modalidad: await bonosModalidad(c, general), min_preparacion: await minutosPreparacion(c, general), lote: await categoriasLote(c, general), general };
      }

      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const accion = String(datos['accion'] ?? '');
      if (alcance !== null && !['lote', 'modalidad'].includes(accion)) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto.');
      const guardar = (clave: string, valor: string) =>
        c.ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [c.nid, clave, valor]);

      if (accion === 'lote') {
        await guardar('lote_categorias' + sufijo, JSON.stringify(enteros(datos['categorias'])));
        return { ok: true };
      }
      if (accion === 'modalidad') {
        for (const [k, clave] of [['aqui', 'bono_aqui'], ['llevar', 'bono_llevar']] as const) {
          const v = entero(datos[k]);
          if (v < 0 || v > 60) throw fallo('Los minutos extra deben ir de 0 a 60.');
          await guardar(clave + sufijo, String(v));
        }
        if (datos['prep'] !== undefined && datos['prep'] !== null) {
          const prep = entero(datos['prep']);
          if (prep < 0 || prep > 120) throw fallo('El tiempo de preparación debe ir de 0 a 120 minutos.');
          await guardar('min_preparacion' + sufijo, String(prep));
        }
        return { ok: true };
      }

      const estacionId = entero(datos['estacion_id']);
      const nivel = datos['nivel'] === undefined ? -1 : entero(datos['nivel']);
      if (nivel < 0 || nivel > 2) throw fallo('El nivel debe ser Normal, Alta o Urgente.');
      const est = await c.filas('SELECT id FROM estaciones WHERE id = ? AND negocio_id = ?', [estacionId, c.nid]);
      if (est.length === 0) throw fallo('Esa parrilla ya no existe.', 404);

      let ids: number[];
      if (accion === 'producto') ids = [entero(datos['producto_id'])];
      else if (accion === 'categoria') ids = (await c.filas('SELECT id FROM productos WHERE categoria_id = ? AND negocio_id = ?', [entero(datos['categoria_id']), c.nid])).map((f) => Number(f['id']));
      else throw fallo('Acción no reconocida.');
      if (ids.length === 0) throw fallo('No hay productos que cambiar.', 404);

      await enTransaccion(c, async (t) => {
        for (const pid of ids) {
          const ok = await t.filas('SELECT id FROM productos WHERE id = ? AND negocio_id = ?', [pid, t.nid]);
          if (ok.length === 0) throw fallo('Ese producto ya no existe.', 404);
          await t.ejecutar('DELETE FROM prioridades WHERE estacion_id = ? AND producto_id = ?', [estacionId, pid]); // se reemplaza (portable MySQL/MariaDB)
          if (nivel > 0) await t.ejecutar('INSERT INTO prioridades (estacion_id, producto_id, nivel) VALUES (?, ?, ?)', [estacionId, pid, nivel]);
        }
      });
      return { ok: true, cambiados: ids.length };
    },
  });
}
