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

/** ¿En Tomar pedidos se pide por MESA (true) o por NOMBRE del cliente (false, por defecto)?
 *  Cada sucursal puede tener su valor (clave pedir_por_mesa@ID); si no lo tiene, usa el de toda la empresa. */
export async function pedirPorMesaEn(nid: number, sid: number): Promise<boolean> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN ('pedir_por_mesa', ?)", [nid, `pedir_por_mesa@${sid}`]);
  const propio = r.find((f) => f['clave'] === `pedir_por_mesa@${sid}`);
  const general = r.find((f) => f['clave'] === 'pedir_por_mesa');
  return (propio ?? general)?.['valor'] === '1';
}

async function estadoPedirPorMesa(nid: number, alcance: number | null) {
  const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
  const g = await filas("SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = 'pedir_por_mesa'", [nid]);
  const out = [];
  for (const s of sucs) out.push({ id: Number(s['id']), nombre: s['nombre'], activo: await pedirPorMesaEn(nid, Number(s['id'])) });
  return { general: g[0]?.['valor'] === '1', puede_general: alcance === null, sucursales: out };
}

/* ---------------------------------------------------------------------------------------------
 * Carriles de cocina: cómo se acomodan los pedidos en la pantalla de Cocina.
 * Cada carril tiene nombre, color y una regla (tipo de pedido, estaciones y/o categorías). Un pedido va al
 * PRIMER carril cuya regla cumple; lo que no entra en ninguno cae en "Otros". Se guarda como JSON en ajustes:
 * `cocina_carriles` (toda la empresa) y `cocina_carriles@ID` (una sucursal; si no existe, usa el de la empresa).
 * ------------------------------------------------------------------------------------------- */
export interface Carril { id: string; nombre: string; color: string; tipos: string[]; estaciones: number[]; categorias: string[] }
const COLORES_CARRIL = ['verde', 'naranja', 'azul', 'morado', 'rojo', 'gris'];
const TIPOS_CARRIL = ['aqui', 'llevar', 'recoger'];
const MAX_CARRILES = 8;
export const CARRILES_DEFECTO: Carril[] = [
  { id: 'aqui', nombre: '🍽 Comer aquí', color: 'verde', tipos: ['aqui'], estaciones: [], categorias: [] },
  { id: 'llevar', nombre: '🥡 Para llevar', color: 'naranja', tipos: ['llevar', 'recoger'], estaciones: [], categorias: [] },
];

/** Lee lo guardado con tolerancia (si el JSON está dañado se usan los carriles por defecto). */
function carrilesGuardados(valor: unknown): Carril[] | null {
  try {
    const bruto = JSON.parse(String(valor));
    if (!Array.isArray(bruto) || bruto.length === 0) return null;
    const lista = bruto.slice(0, MAX_CARRILES).map((c: Record<string, unknown>, n: number): Carril => ({
      id: /^[a-z0-9_]{1,24}$/.test(String(c['id'])) ? String(c['id']) : `c${n + 1}`,
      nombre: String(c['nombre'] ?? '').slice(0, 40) || `Carril ${n + 1}`,
      color: COLORES_CARRIL.includes(String(c['color'])) ? String(c['color']) : 'gris',
      tipos: (Array.isArray(c['tipos']) ? c['tipos'] : []).map(String).filter((t) => TIPOS_CARRIL.includes(t)),
      estaciones: enteros(c['estaciones']),
      categorias: (Array.isArray(c['categorias']) ? c['categorias'] : []).map(String).slice(0, 60),
    }));
    return lista;
  } catch { return null; }
}

/** Ids de carriles que la sucursal tiene apagados (cocina_carriles_off@ID). */
function carrilesApagados(valor: unknown): string[] {
  try { const l = JSON.parse(String(valor)); return Array.isArray(l) ? l.map(String).slice(0, MAX_CARRILES * 2) : []; } catch { return []; }
}

/** Carriles configurados para la sucursal (los suyos, o los de la empresa, o los de siempre), sin quitar los apagados. */
async function carrilesConfigurados(nid: number, sid: number): Promise<{ lista: Carril[]; apagados: string[] }> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN ('cocina_carriles', ?, ?)", [nid, `cocina_carriles@${sid}`, `cocina_carriles_off@${sid}`]);
  const propio = r.find((f) => f['clave'] === `cocina_carriles@${sid}`);
  const general = r.find((f) => f['clave'] === 'cocina_carriles');
  const off = r.find((f) => f['clave'] === `cocina_carriles_off@${sid}`);
  const lista = (propio && carrilesGuardados(propio['valor'])) || (general && carrilesGuardados(general['valor'])) || CARRILES_DEFECTO;
  return { lista, apagados: off ? carrilesApagados(off['valor']) : [] };
}

/** Carriles que se muestran en la pantalla de Cocina de la sucursal: los configurados menos los que apagó (siempre queda al menos uno). */
export async function carrilesEn(nid: number, sid: number): Promise<Carril[]> {
  const { lista, apagados } = await carrilesConfigurados(nid, sid);
  const activos = lista.filter((c) => !apagados.includes(c.id));
  return activos.length ? activos : lista;
}

/** Estado para el panel: el dueño ve y edita todo; el gerente solo ve (y enciende/apaga) los de su sucursal. */
async function estadoCarriles(nid: number, alcance: number | null) {
  const ajustes = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave LIKE 'cocina_carriles%'", [nid]);
  const g = ajustes.find((f) => f['clave'] === 'cocina_carriles');
  const general = (g && carrilesGuardados(g['valor'])) || null;
  const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
  const sucursales = sucs.map((s) => {
    const sid = Number(s['id']);
    const p = ajustes.find((f) => f['clave'] === `cocina_carriles@${sid}`);
    const off = ajustes.find((f) => f['clave'] === `cocina_carriles_off@${sid}`);
    const propios = (p && carrilesGuardados(p['valor'])) || null;
    return { id: sid, nombre: s['nombre'], propio: propios !== null, carriles: propios ?? general ?? CARRILES_DEFECTO, apagados: off ? carrilesApagados(off['valor']) : [] };
  });
  const estaciones = (await filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((e) => ({ id: Number(e['id']), nombre: e['nombre'] }));
  const categorias = (await filas('SELECT nombre FROM categorias WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((k) => String(k['nombre']));
  return { puede_editar: true, puede_general: alcance === null, general: general ?? CARRILES_DEFECTO, general_propio: general !== null, defecto: CARRILES_DEFECTO, sucursales, estaciones, categorias };
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
          codigo_rapido: await estadoCodigoRapido(c.nid, alcance), cocina_horizontal: await estadoCocinaHorizontal(c.nid, alcance), pedir_por_mesa: await estadoPedirPorMesa(c.nid, alcance), carriles: await estadoCarriles(c.nid, alcance) };
      }

      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const accion = String(datos['accion'] ?? '');
      if (alcance !== null && !['lote', 'modalidad', 'codigo_rapido', 'cocina_horizontal', 'pedir_por_mesa', 'carril_activo', 'carriles'].includes(accion)) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto.');
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

      // Encender / apagar un carril en UNA sucursal: el dueño en cualquiera y el gerente en la suya. No cambia la definición del carril.
      if (accion === 'carril_activo') {
        const sid = alcance ?? entero(datos['sucursal_id']);
        if ((await c.filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, c.nid])).length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        const { lista, apagados } = await carrilesConfigurados(c.nid, sid);
        const id = String(datos['carril_id'] ?? '');
        if (!lista.some((k) => k.id === id)) throw new ErrorHttp(400, 'validacion', 'Ese carril aún no está guardado. Guarda los carriles primero.');
        const nuevo = new Set(apagados.filter((x) => lista.some((k) => k.id === x)));
        if (noVacio(datos['activo'])) nuevo.delete(id); else nuevo.add(id);
        if (lista.every((k) => nuevo.has(k.id))) throw new ErrorHttp(400, 'validacion', 'Debe quedar al menos un carril activo.');
        await guardar(`cocina_carriles_off@${sid}`, JSON.stringify([...nuevo]));
        return { ok: true, carriles: await estadoCarriles(c.nid, alcance) };
      }

      // Carriles de cocina: el dueño los define para toda la empresa o para cualquier sucursal; el gerente, solo para la suya.
      if (accion === 'carriles') {
        if (datos['ambito'] === 'general' && alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar los carriles de toda la empresa.');
        const sidAmbito = alcance ?? entero(datos['sucursal_id']);
        const clave = datos['ambito'] === 'general' ? 'cocina_carriles' : `cocina_carriles@${sidAmbito}`;
        if (datos['ambito'] !== 'general') {
          const sid = sidAmbito;
          if ((await c.filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, c.nid])).length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        }
        if (noVacio(datos['heredar'])) {   // sucursal: volver a usar los de la empresa · empresa: volver a los de siempre
          await c.ejecutar('DELETE FROM ajustes WHERE negocio_id = ? AND clave = ?', [c.nid, clave]);
          return { ok: true, carriles: await estadoCarriles(c.nid, alcance) };
        }
        const bruto = Array.isArray(datos['carriles']) ? (datos['carriles'] as Record<string, unknown>[]) : [];
        if (bruto.length < 1 || bruto.length > MAX_CARRILES) throw new ErrorHttp(400, 'validacion', `Crea entre 1 y ${MAX_CARRILES} carriles.`);
        const estacionesValidas = new Set((await c.filas('SELECT id FROM estaciones WHERE negocio_id = ?', [c.nid])).map((f) => Number(f['id'])));
        const categoriasValidas = new Set((await c.filas('SELECT nombre FROM categorias WHERE negocio_id = ?', [c.nid])).map((f) => String(f['nombre'])));
        const usados = new Set<string>();
        const lista: Carril[] = bruto.map((x, n) => {
          const nombre = String(x['nombre'] ?? '').trim();
          if (nombre === '' || [...nombre].length > 40) throw new ErrorHttp(400, 'validacion', `El carril ${n + 1} necesita un nombre (máximo 40 letras).`);
          let id = /^[a-z0-9_]{1,24}$/.test(String(x['id'])) ? String(x['id']) : `c${n + 1}`;
          while (usados.has(id)) id += 'x';
          usados.add(id);
          return {
            id, nombre,
            color: COLORES_CARRIL.includes(String(x['color'])) ? String(x['color']) : 'gris',
            tipos: [...new Set((Array.isArray(x['tipos']) ? x['tipos'] : []).map(String).filter((t) => TIPOS_CARRIL.includes(t)))],
            estaciones: enteros(x['estaciones']).filter((e) => estacionesValidas.has(e)),
            categorias: [...new Set((Array.isArray(x['categorias']) ? x['categorias'] : []).map(String).filter((k) => categoriasValidas.has(k)))],
          };
        });
        await guardar(clave, JSON.stringify(lista));
        return { ok: true, carriles: await estadoCarriles(c.nid, alcance) };
      }

      if (accion === 'pedir_por_mesa') {
        const activo = noVacio(datos['activo']);
        if (datos['ambito'] === 'general') {
          if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
          await guardar('pedir_por_mesa', activo ? '1' : '0');
        } else {
          const sid = alcance ?? entero(datos['sucursal_id']);
          if ((await c.filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, c.nid])).length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          await guardar(`pedir_por_mesa@${sid}`, activo ? '1' : '0');
        }
        return { ok: true, pedir_por_mesa: await estadoPedirPorMesa(c.nid, alcance) };
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
