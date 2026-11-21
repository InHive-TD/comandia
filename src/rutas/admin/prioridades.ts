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
import { bonosModalidad, categoriasLote, contexto, enTransaccion, minutosPreparacion, productosLote } from '../../ordenes.js';
import { enteros, entero, noVacio } from '../../util.js';
import { filas } from '../../db.js';

/** ¿El dueño dejó el código rápido activo para toda la empresa? (por defecto sí) */
export async function codigoRapidoGeneral(nid: number): Promise<boolean> {
  const r = await filas("SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = 'codigo_rapido'", [nid]);
  return r.length === 0 || r[0]!['valor'] !== '0';
}

/** ¿Está activo el código rápido en esta sucursal? Necesita el interruptor general Y el de la sucursal (ambos por defecto sí). */
export async function codigoRapidoEn(nid: number, sid: number): Promise<boolean> {
  if (!(await codigoRapidoGeneral(nid))) return false;
  const r = await filas('SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, `codigo_rapido@${sid}`]);
  return r.length === 0 || r[0]!['valor'] !== '0';
}

/** ¿Las comandas de Cocina van en UNA fila con scroll lateral (true) o apiladas hacia abajo (false, por defecto)?
 *  Cada sucursal puede tener su propio valor (clave cocina_horizontal@ID); si no lo tiene, usa el de toda la empresa. */
export async function cocinaHorizontalEn(nid: number, sid: number): Promise<boolean> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN ('cocina_horizontal', ?)", [nid, `cocina_horizontal@${sid}`]);
  const propio = r.find((f) => f['clave'] === `cocina_horizontal@${sid}`);
  const general = r.find((f) => f['clave'] === 'cocina_horizontal');
  return (propio ?? general)?.['valor'] === '1';
}

/** Estado para el panel: interruptor general de Cocina horizontal y el efectivo de cada sucursal (el gerente solo ve la suya). */
async function estadoCocinaHorizontal(nid: number, alcance: number | null) {
  const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
  const g = await filas("SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = 'cocina_horizontal'", [nid]);
  const out = [];
  for (const s of sucs) out.push({ id: Number(s['id']), nombre: s['nombre'], activo: await cocinaHorizontalEn(nid, Number(s['id'])) });
  return { general: g[0]?.['valor'] === '1', puede_general: alcance === null, sucursales: out };
}

/** Estado para el panel: interruptor general y el de cada sucursal (el gerente solo ve la suya). */
async function estadoCodigoRapido(nid: number, alcance: number | null) {
  const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
  const general = await codigoRapidoGeneral(nid);
  const propios = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave LIKE 'codigo_rapido@%'", [nid]);
  const apagadas = new Set(propios.filter((f) => f['valor'] === '0').map((f) => Number(String(f['clave']).split('@')[1])));
  return { general, puede_general: alcance === null, sucursales: sucs.map((s) => ({ id: Number(s['id']), nombre: s['nombre'], activo: !apagadas.has(Number(s['id'])) })) };
}

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
        return { ok: true, estaciones, productos, modalidad: await bonosModalidad(c, general), min_preparacion: await minutosPreparacion(c, general), lote: await categoriasLote(c, general), lote_productos: await productosLote(c, general), general,
          codigo_rapido: await estadoCodigoRapido(c.nid, alcance), cocina_horizontal: await estadoCocinaHorizontal(c.nid, alcance) };
      }

      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const accion = String(datos['accion'] ?? '');
      if (alcance !== null && !['lote', 'modalidad', 'codigo_rapido', 'cocina_horizontal'].includes(accion)) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto.');
      const guardar = (clave: string, valor: string) =>
        c.ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [c.nid, clave, valor]);

      // Activa o desactiva el buscador por código rápido (y su botón "Agregar") en Tomar pedidos.
      // El dueño lo cambia para toda la empresa o para cualquier sucursal; el gerente solo para la suya
      // y no puede encenderlo si el dueño lo apagó en toda la empresa.
      if (accion === 'codigo_rapido') {
        const activo = noVacio(datos['activo']);
        if (datos['ambito'] === 'general') {
          if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
          await guardar('codigo_rapido', activo ? '1' : '0');
        } else {
          const sid = alcance ?? entero(datos['sucursal_id']);
          if ((await c.filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, c.nid])).length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          if (activo && alcance !== null && !(await codigoRapidoGeneral(c.nid))) throw new ErrorHttp(403, 'validacion', 'El dueño desactivó el código rápido en toda la empresa. Pídele que lo active para poder activarlo aquí.');
          await guardar(`codigo_rapido@${sid}`, activo ? '1' : '0');
        }
        return { ok: true, codigo_rapido: await estadoCodigoRapido(c.nid, alcance) };
      }

      // Distribución de las comandas en Cocina: apiladas hacia abajo o en una fila con scroll izquierda-derecha.
      // El dueño la fija para toda la empresa (y limpia lo particular de cada sucursal) o para una sucursal; el gerente, solo la suya.
      if (accion === 'cocina_horizontal') {
        const activo = noVacio(datos['activo']);
        if (datos['ambito'] === 'general') {
          if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
          await guardar('cocina_horizontal', activo ? '1' : '0');
          await c.ejecutar("DELETE FROM ajustes WHERE negocio_id = ? AND clave LIKE 'cocina\\_horizontal@%'", [c.nid]);
        } else {
          const sid = alcance ?? entero(datos['sucursal_id']);
          if ((await c.filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, c.nid])).length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          await guardar(`cocina_horizontal@${sid}`, activo ? '1' : '0');
        }
        return { ok: true, cocina_horizontal: await estadoCocinaHorizontal(c.nid, alcance) };
      }

      if (accion === 'lote') {
        await guardar('lote_categorias' + sufijo, JSON.stringify(enteros(datos['categorias'])));
        // Platillos sueltos (opcional): solo se aceptan los que existen en ESTA empresa
        if (datos['productos'] !== undefined) {
          const pedidos = enteros(datos['productos']);
          const validos = pedidos.length ? (await c.filas(`SELECT id FROM productos WHERE negocio_id = ? AND id IN (${pedidos.map(() => '?').join(',')})`, [c.nid, ...pedidos])).map((f) => Number(f['id'])) : [];
          await guardar('lote_productos' + sufijo, JSON.stringify(validos));
        }
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
