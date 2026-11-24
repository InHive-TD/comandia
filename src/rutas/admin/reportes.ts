/**
 * Tablero de Inicio (roles admin y gerente).
 *
 *   GET /admin/reportes?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&sucursal=ID
 *       → el tablero completo: KPIs (con el periodo anterior), ventas por día / hora / día de la semana, modalidad, origen,
 *         pagos, sucursales, zonas y mesas, productos, categorías, modificadores, combinaciones, tiempos de entrega, clientes,
 *         y el catálogo del explorador.
 *   GET /admin/reportes?explorar=1&fuente=ordenes|renglones|pagos&dimension=…&metrica=…   (+ los mismos filtros)
 *       → { filas: [{ clave, valor, pedidos }] } para cualquier combinación del explorador.
 *
 * El explorador se arma solo con la estructura de la base de datos: toda columna NUEVA de tipo enum, sí/no, texto corto o fecha en
 * ordenes / orden_items / pagos aparece como dimensión, y toda columna numérica nueva como métrica, sin tocar este archivo.
 * "Vendido" = total de pedidos no cancelados; "Cobrado" = pagos de Caja sin anular. El gerente solo ve su sucursal.
 */
import type { FastifyInstance } from 'fastify';
import { requerirGestion } from '../../auth.js';
import { filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { redondear } from '../../ordenes.js';
import { entero } from '../../util.js';

const num = (v: unknown): number => redondear(Number(v ?? 0));
const ent = (v: unknown): number => Math.round(Number(v ?? 0));

type Fuente = 'ordenes' | 'renglones' | 'pagos';
interface Dim { id: string; etiqueta: string; expr: string; temporal?: boolean; auto?: boolean; numerica?: boolean }
interface Met { id: string; etiqueta: string; expr: string; formato: 'dinero' | 'numero' | 'minutos'; auto?: boolean }

/** Columnas que nunca se ofrecen (datos personales, claves o ids): no son para agrupar. */
const PRIVADAS = new Set(['nombre_cliente', 'telefono', 'clave_cliente', 'notas', 'codigo', 'nombre_producto', 'agregados', 'ip_hash', 'clave']);
const esId = (c: string): boolean => c === 'id' || c.endsWith('_id') || c === 'turno' || c === 'revision';

const FUENTES: Record<Fuente, { tabla: string; alias: string; desde: string; filtro: (s: boolean) => string; dims: Dim[]; mets: Met[]; solo?: string }> = {
  ordenes: {
    tabla: 'ordenes', alias: 'o', desde: 'ordenes o', solo: "o.estado <> 'cancelada'",
    filtro: (suc) => `o.negocio_id = ? AND o.fecha_turno BETWEEN ? AND ?${suc ? ' AND o.sucursal_id = ?' : ''}`,
    dims: [
      { id: 'dia', etiqueta: 'Día', expr: 'o.fecha_turno', temporal: true },
      { id: 'mes', etiqueta: 'Mes', expr: "DATE_FORMAT(o.fecha_turno, '%Y-%m')", temporal: true },
      { id: 'dia_semana', etiqueta: 'Día de la semana', expr: 'WEEKDAY(o.fecha_turno)', temporal: true },
      { id: 'hora', etiqueta: 'Hora del día', expr: 'HOUR(o.creado_en)', temporal: true },
      { id: 'sucursal', etiqueta: 'Sucursal', expr: '(SELECT nombre FROM sucursales s WHERE s.id = o.sucursal_id)' },
      { id: 'modalidad', etiqueta: 'Tipo de pedido', expr: 'o.modalidad' },
      { id: 'origen', etiqueta: 'Origen (QR / mostrador)', expr: 'o.origen' },
      { id: 'estado', etiqueta: 'Estado', expr: 'o.estado' },
      { id: 'zona', etiqueta: 'Zona de la mesa', expr: "COALESCE(o.mesa_zona, 'Sin mesa')" },
      { id: 'mesa', etiqueta: 'Mesa', expr: "COALESCE(CONCAT(o.mesa, IF(o.mesa_zona IS NULL, '', CONCAT(' · ', o.mesa_zona))), 'Sin mesa')" },
      { id: 'agendado', etiqueta: '¿Agendado?', expr: "IF(o.hora_prometida IS NULL, 'No', 'Sí')" },
      { id: 'pagado', etiqueta: '¿Pagado?', expr: "IF(o.pagado = 1, 'Sí', 'No')" },
      { id: 'pago_previsto', etiqueta: 'Cómo dijo que pagaría', expr: "COALESCE(o.pago_previsto, 'No dijo')" },
      { id: 'tiene_telefono', etiqueta: '¿Dejó teléfono?', expr: "IF(o.telefono IS NULL, 'No', 'Sí')" },
    ],
    mets: [
      { id: 'vendido', etiqueta: 'Vendido ($)', expr: 'SUM(o.total)', formato: 'dinero' },
      { id: 'pedidos', etiqueta: 'Pedidos', expr: 'COUNT(*)', formato: 'numero' },
      { id: 'ticket', etiqueta: 'Ticket promedio ($)', expr: 'AVG(o.total)', formato: 'dinero' },
      { id: 'espera', etiqueta: 'Espera estimada promedio (min)', expr: 'AVG(o.estimado_min)', formato: 'minutos' },
    ],
  },
  renglones: {
    tabla: 'orden_items', alias: 'i', desde: 'orden_items i JOIN ordenes o ON o.id = i.orden_id', solo: "o.estado <> 'cancelada'",
    filtro: (suc) => `o.negocio_id = ? AND o.fecha_turno BETWEEN ? AND ?${suc ? ' AND o.sucursal_id = ?' : ''}`,
    dims: [
      { id: 'producto', etiqueta: 'Platillo', expr: 'i.nombre_producto' },
      { id: 'categoria', etiqueta: 'Categoría', expr: "COALESCE(i.categoria, 'Sin categoría')" },
      { id: 'plato', etiqueta: 'Número de plato', expr: 'i.plato', temporal: true },
      { id: 'llevar', etiqueta: '¿Para llevar dentro del pedido?', expr: "IF(i.llevar = 1, 'Para llevar', 'Aquí')" },
      { id: 'dia', etiqueta: 'Día', expr: 'o.fecha_turno', temporal: true },
      { id: 'dia_semana', etiqueta: 'Día de la semana', expr: 'WEEKDAY(o.fecha_turno)', temporal: true },
      { id: 'hora', etiqueta: 'Hora del día', expr: 'HOUR(o.creado_en)', temporal: true },
      { id: 'sucursal', etiqueta: 'Sucursal', expr: '(SELECT nombre FROM sucursales s WHERE s.id = o.sucursal_id)' },
      { id: 'modalidad', etiqueta: 'Tipo de pedido', expr: 'o.modalidad' },
    ],
    mets: [
      { id: 'unidades', etiqueta: 'Unidades vendidas', expr: 'SUM(i.cantidad)', formato: 'numero' },
      { id: 'importe', etiqueta: 'Importe ($)', expr: 'SUM((i.precio_unitario + COALESCE(i.extras_precio, 0)) * i.cantidad)', formato: 'dinero' },
      { id: 'renglones', etiqueta: 'Renglones', expr: 'COUNT(*)', formato: 'numero' },
    ],
  },
  pagos: {
    tabla: 'pagos', alias: 'p', desde: 'pagos p', solo: 'p.anulado = 0',
    filtro: (suc) => `p.negocio_id = ? AND DATE(p.creado_en) BETWEEN ? AND ?${suc ? ' AND p.sucursal_id = ?' : ''}`,
    dims: [
      { id: 'metodo', etiqueta: 'Método de pago', expr: 'p.metodo' },
      { id: 'dia', etiqueta: 'Día', expr: 'DATE(p.creado_en)', temporal: true },
      { id: 'dia_semana', etiqueta: 'Día de la semana', expr: 'WEEKDAY(p.creado_en)', temporal: true },
      { id: 'hora', etiqueta: 'Hora del día', expr: 'HOUR(p.creado_en)', temporal: true },
      { id: 'sucursal', etiqueta: 'Sucursal', expr: '(SELECT nombre FROM sucursales s WHERE s.id = p.sucursal_id)' },
      { id: 'con_propina', etiqueta: '¿Con propina?', expr: "IF(p.propina > 0, 'Con propina', 'Sin propina')" },
    ],
    mets: [
      { id: 'monto', etiqueta: 'Cobrado ($)', expr: 'SUM(p.monto)', formato: 'dinero' },
      { id: 'propina', etiqueta: 'Propinas ($)', expr: 'SUM(p.propina)', formato: 'dinero' },
      { id: 'comision', etiqueta: 'Comisiones de tarjeta ($)', expr: 'SUM(p.comision)', formato: 'dinero' },
      { id: 'pagos', etiqueta: 'Pagos', expr: 'COUNT(*)', formato: 'numero' },
    ],
  },
};

const humanizar = (c: string): string => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** Suma al catálogo las columnas que se agreguen a las tablas (sin tocar este archivo). */
async function catalogo(fuente: Fuente): Promise<{ dims: Dim[]; mets: Met[] }> {
  const f = FUENTES[fuente];
  const cols = await filas(
    'SELECT COLUMN_NAME AS c, DATA_TYPE AS t, COLUMN_TYPE AS ct, CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [f.tabla],
  );
  const usadas = new Set([...f.dims, ...f.mets].map((x) => x.expr));
  const ya = (c: string): boolean => [...usadas].some((e) => e.includes(`${f.alias}.${c}`));
  const dims = [...f.dims];
  const mets = [...f.mets];
  for (const col of cols) {
    const c = String(col['c']);
    if (!/^[a-z][a-z0-9_]*$/.test(c) || PRIVADAS.has(c) || esId(c) || ya(c)) continue;
    const t = String(col['t']);
    const ct = String(col['ct']);
    const a = `${f.alias}.${c}`;
    if (t === 'enum') dims.push({ id: `col_${c}`, etiqueta: humanizar(c), expr: a, auto: true });
    else if (t === 'tinyint' && /\(1\)/.test(ct)) dims.push({ id: `col_${c}`, etiqueta: humanizar(c), expr: `IF(${a} = 1, 'Sí', 'No')`, auto: true });
    else if ((t === 'varchar' || t === 'char') && Number(col['n'] ?? 99) <= 40) dims.push({ id: `col_${c}`, etiqueta: humanizar(c), expr: `COALESCE(${a}, '—')`, auto: true });
    else if (t === 'date' || t === 'datetime' || t === 'timestamp') dims.push({ id: `col_${c}`, etiqueta: `${humanizar(c)} (por día)`, expr: `DATE(${a})`, temporal: true, auto: true });
    else if (t === 'decimal' || t === 'float' || t === 'double') {
      mets.push({ id: `suma_${c}`, etiqueta: `${humanizar(c)} (suma)`, expr: `SUM(${a})`, formato: 'dinero', auto: true });
      mets.push({ id: `prom_${c}`, etiqueta: `${humanizar(c)} (promedio)`, expr: `AVG(${a})`, formato: 'dinero', auto: true });
    } else if ((t === 'int' || t === 'smallint' || t === 'mediumint') && !/id$/.test(c)) {
      mets.push({ id: `suma_${c}`, etiqueta: `${humanizar(c)} (suma)`, expr: `SUM(${a})`, formato: 'numero', auto: true });
      mets.push({ id: `prom_${c}`, etiqueta: `${humanizar(c)} (promedio)`, expr: `AVG(${a})`, formato: 'numero', auto: true });
    }
  }
  return { dims, mets };
}

export async function rutasReportes(app: FastifyInstance): Promise<void> {
  app.get('/admin/reportes', async (req) => {
    const yo = await requerirGestion(req);
    const nid = req.negocio.id;
    const q = req.query as Record<string, unknown>;

    const fecha = (v: unknown, def: string): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : def);
    const hoy = String((await filas('SELECT CURDATE() AS f'))[0]?.['f']);
    let desde = fecha(q['desde'], hoy);
    let hasta = fecha(q['hasta'], desde);
    if (hasta < desde) [desde, hasta] = [hasta, desde];
    if (Date.parse(hasta) - Date.parse(desde) > 366 * 86400 * 1000) throw fallo('El periodo no puede pasar de un año.');

    const sucursales = (
      await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ?${yo.alcance !== null ? ` AND id = ${Math.trunc(yo.alcance)}` : ''} ORDER BY activa DESC, orden, id`, [nid])
    ).map((s) => ({ id: Number(s['id']), nombre: s['nombre'] as string }));
    const sucFiltro = yo.alcance !== null ? yo.alcance : entero(q['sucursal']);
    if (sucFiltro > 0 && !sucursales.some((s) => s.id === sucFiltro)) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
    const suc = sucFiltro > 0;
    const par = (d: string, h: string): unknown[] => (suc ? [nid, d, h, sucFiltro] : [nid, d, h]);

    // ---------------- Explorador: cualquier dimensión × métrica ----------------
    if (String(q['explorar'] ?? '') === '1') {
      const fuente = String(q['fuente'] ?? 'ordenes') as Fuente;
      if (!(fuente in FUENTES)) throw fallo('Fuente desconocida.');
      const f = FUENTES[fuente];
      const cat = await catalogo(fuente);
      const dim = cat.dims.find((d) => d.id === String(q['dimension'] ?? ''));
      const met = cat.mets.find((m) => m.id === String(q['metrica'] ?? ''));
      if (!dim || !met) throw fallo('Elige qué medir y cómo agrupar.');
      const cond = `${f.filtro(suc)}${f.solo ? ` AND ${f.solo}` : ''}`;
      const orden = dim.temporal ? 'clave' : 'valor DESC';
      const r = await filas(
        `SELECT ${dim.expr} AS clave, ${met.expr} AS valor, COUNT(DISTINCT ${fuente === 'pagos' ? 'p.orden_id' : 'o.id'}) AS pedidos
           FROM ${f.desde} WHERE ${cond} GROUP BY clave ORDER BY ${orden} LIMIT 60`, par(desde, hasta));
      return { ok: true, formato: met.formato, filas: r.map((x) => ({ clave: x['clave'] === null ? '—' : String(x['clave']), valor: Number(x['valor'] ?? 0), pedidos: ent(x['pedidos']) })) };
    }

    // ---------------- Periodo anterior (misma duración, justo antes) ----------------
    const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
    const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const hastaPrev = iso(Date.parse(desde) - 86400000);
    const desdePrev = iso(Date.parse(desde) - dias * 86400000);

    const fO = FUENTES.ordenes.filtro(suc);
    const fP = FUENTES.pagos.filtro(suc);
    const resumenDe = async (d: string, h: string) => {
      const r = (await filas(
        `SELECT SUM(o.estado <> 'cancelada') AS pedidos, COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' THEN o.total END), 0) AS vendido, SUM(o.estado = 'cancelada') AS cancelados,
                COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' AND o.hora_prometida IS NOT NULL THEN 1 END), 0) AS agendados,
                COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' AND o.origen = 'qr' THEN 1 END), 0) AS por_qr
           FROM ordenes o WHERE ${fO}`, par(d, h)))[0];
      const c = (await filas(`SELECT COALESCE(SUM(p.monto), 0) AS cobrado, COALESCE(SUM(p.propina), 0) AS propinas, COALESCE(SUM(p.comision), 0) AS comisiones, COUNT(*) AS pagos FROM pagos p WHERE ${fP} AND p.anulado = 0`, par(d, h)))[0];
      const it = (await filas(`SELECT COALESCE(SUM(i.cantidad), 0) AS piezas FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE ${fO} AND o.estado <> 'cancelada'`, par(d, h)))[0];
      const pedidos = ent(r?.['pedidos']);
      const vendido = num(r?.['vendido']);
      const t = (await filas(
        `SELECT COUNT(*) AS n, AVG(t.duracion_seg) AS prom, SUM(t.resultado <> 'atrasado') AS a_tiempo
           FROM tiempos_pedido t WHERE t.negocio_id = ? AND t.fecha BETWEEN ? AND ?${suc ? ' AND t.sucursal_id = ?' : ''}`, par(d, h)))[0];
      const entregas = ent(t?.['n']);
      return {
        pedidos, vendido, cancelados: ent(r?.['cancelados']), agendados: ent(r?.['agendados']), por_qr: ent(r?.['por_qr']),
        ticket: pedidos > 0 ? num(vendido / pedidos) : 0, piezas: ent(it?.['piezas']), piezas_por_pedido: pedidos > 0 ? Math.round((ent(it?.['piezas']) / pedidos) * 10) / 10 : 0,
        cobrado: num(c?.['cobrado']), propinas: num(c?.['propinas']), comisiones: num(c?.['comisiones']), pagos: ent(c?.['pagos']),
        entregas, minutos_entrega: entregas > 0 ? Math.round((Number(t?.['prom']) / 60) * 10) / 10 : null, pct_a_tiempo: entregas > 0 ? Math.round((Number(t?.['a_tiempo']) / entregas) * 100) : null,
      };
    };
    const resumen = await resumenDe(desde, hasta);
    const previo = await resumenDe(desdePrev, hastaPrev);

    const dia = async (d: string, h: string) =>
      (await filas(
        `SELECT o.fecha_turno AS fecha, SUM(o.estado <> 'cancelada') AS pedidos, COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' THEN o.total END), 0) AS vendido, SUM(o.estado = 'cancelada') AS cancelados
           FROM ordenes o WHERE ${fO} GROUP BY o.fecha_turno ORDER BY o.fecha_turno`, par(d, h)))
        .map((f) => ({ fecha: String(f['fecha']).slice(0, 10), pedidos: ent(f['pedidos']), vendido: num(f['vendido']), cancelados: ent(f['cancelados']) }));
    const porDia = await dia(desde, hasta);
    const porDiaPrevio = await dia(desdePrev, hastaPrev);

    const calor = (await filas(
      `SELECT WEEKDAY(o.fecha_turno) AS d, HOUR(o.creado_en) AS h, COUNT(*) AS pedidos, SUM(o.total) AS vendido
         FROM ordenes o WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY d, h`, par(desde, hasta)))
      .map((f) => ({ d: ent(f['d']), h: ent(f['h']), pedidos: ent(f['pedidos']), vendido: num(f['vendido']) }));

    const grupo = async (expr: string, nombre = 'clave') =>
      (await filas(`SELECT ${expr} AS ${nombre}, COUNT(*) AS pedidos, SUM(o.total) AS vendido FROM ordenes o WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY ${nombre} ORDER BY vendido DESC LIMIT 30`, par(desde, hasta)))
        .map((f) => ({ clave: f[nombre] === null ? '—' : String(f[nombre]), pedidos: ent(f['pedidos']), vendido: num(f['vendido']) }));
    const porModalidad = await grupo('o.modalidad');
    const porOrigen = await grupo('o.origen');
    const porZona = await grupo("COALESCE(o.mesa_zona, 'Sin zona')");
    const porMesa = (await grupo("COALESCE(CONCAT(o.mesa, IF(o.mesa_zona IS NULL, '', CONCAT(' · ', o.mesa_zona))), 'Sin mesa')")).filter((m) => m.clave !== 'Sin mesa').slice(0, 15);
    const mixto = (await filas(
      `SELECT COUNT(DISTINCT o.id) AS n FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE ${fO} AND o.estado <> 'cancelada' AND o.modalidad = 'aqui' AND i.llevar = 1`, par(desde, hasta)))[0];

    const porMetodo = (await filas(
      `SELECT p.metodo, COUNT(*) AS pagos, SUM(p.monto) AS monto, SUM(p.propina) AS propinas, SUM(p.comision) AS comision FROM pagos p WHERE ${fP} AND p.anulado = 0 GROUP BY p.metodo ORDER BY monto DESC`, par(desde, hasta)))
      .map((f) => ({ metodo: String(f['metodo']), pagos: ent(f['pagos']), monto: num(f['monto']), propinas: num(f['propinas']), comision: num(f['comision']) }));

    const ventas = new Map((await filas(`SELECT o.sucursal_id, SUM(o.estado <> 'cancelada') AS pedidos, COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' THEN o.total END), 0) AS vendido, SUM(o.estado = 'cancelada') AS cancelados FROM ordenes o WHERE ${fO} GROUP BY o.sucursal_id`, par(desde, hasta))).map((f) => [Number(f['sucursal_id']), f]));
    const cobros = new Map((await filas(`SELECT p.sucursal_id, SUM(p.monto) AS cobrado, SUM(p.propina) AS propinas FROM pagos p WHERE ${fP} AND p.anulado = 0 GROUP BY p.sucursal_id`, par(desde, hasta))).map((f) => [Number(f['sucursal_id']), f]));
    const porSucursal = sucursales.filter((s) => !suc || s.id === sucFiltro).map((s) => {
      const v = ventas.get(s.id);
      const cb = cobros.get(s.id);
      return { id: s.id, nombre: s.nombre, pedidos: v ? ent(v['pedidos']) : 0, vendido: v ? num(v['vendido']) : 0, cancelados: v ? ent(v['cancelados']) : 0, cobrado: cb ? num(cb['cobrado']) : 0, propinas: cb ? num(cb['propinas']) : 0 };
    });

    // Productos, categorías, modificadores y combinaciones
    const productos = (await filas(
      `SELECT i.nombre_producto AS nombre, COALESCE(i.categoria, 'Sin categoría') AS categoria, SUM(i.cantidad) AS unidades, SUM((i.precio_unitario + COALESCE(i.extras_precio, 0)) * i.cantidad) AS importe, COUNT(DISTINCT o.id) AS pedidos
         FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY i.nombre_producto, categoria ORDER BY unidades DESC, importe DESC LIMIT 60`, par(desde, hasta)))
      .map((f) => ({ nombre: String(f['nombre']), categoria: String(f['categoria']), unidades: ent(f['unidades']), importe: num(f['importe']), pedidos: ent(f['pedidos']) }));
    const nombresTop = productos.slice(0, 12).map((p) => p.nombre);
    const productoDia = nombresTop.length === 0 ? [] : (await filas(
      `SELECT i.nombre_producto AS nombre, o.fecha_turno AS fecha, SUM(i.cantidad) AS unidades FROM orden_items i JOIN ordenes o ON o.id = i.orden_id
        WHERE ${fO} AND o.estado <> 'cancelada' AND i.nombre_producto IN (${nombresTop.map(() => '?').join(',')}) GROUP BY i.nombre_producto, o.fecha_turno`, [...par(desde, hasta), ...nombresTop]))
      .map((f) => ({ nombre: String(f['nombre']), fecha: String(f['fecha']).slice(0, 10), unidades: ent(f['unidades']) }));
    const categorias = (await filas(
      `SELECT COALESCE(i.categoria, 'Sin categoría') AS clave, SUM(i.cantidad) AS unidades, SUM((i.precio_unitario + COALESCE(i.extras_precio, 0)) * i.cantidad) AS importe
         FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY clave ORDER BY importe DESC LIMIT 20`, par(desde, hasta)))
      .map((f) => ({ clave: String(f['clave']), unidades: ent(f['unidades']), importe: num(f['importe']) }));
    const extras = (await filas(
      `SELECT x.nombre AS clave, COUNT(*) AS veces FROM orden_item_extras x JOIN orden_items i ON i.id = x.item_id JOIN ordenes o ON o.id = i.orden_id
        WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY x.nombre ORDER BY veces DESC LIMIT 15`, par(desde, hasta)))
      .map((f) => ({ clave: String(f['clave']), veces: ent(f['veces']) }));
    const pares = (await filas(
      `SELECT a.nombre_producto AS a, b.nombre_producto AS b, COUNT(DISTINCT a.orden_id) AS veces
         FROM orden_items a JOIN orden_items b ON b.orden_id = a.orden_id AND a.nombre_producto < b.nombre_producto JOIN ordenes o ON o.id = a.orden_id
        WHERE ${fO} AND o.estado <> 'cancelada' GROUP BY a.nombre_producto, b.nombre_producto HAVING veces >= 2 ORDER BY veces DESC LIMIT 10`, par(desde, hasta)))
      .map((f) => ({ a: String(f['a']), b: String(f['b']), veces: ent(f['veces']) }));

    // Tiempos de entrega (bitácora tiempos_pedido)
    const fT = `t.negocio_id = ? AND t.fecha BETWEEN ? AND ?${suc ? ' AND t.sucursal_id = ?' : ''}`;
    const tiemposResultado = (await filas(`SELECT t.resultado AS clave, COUNT(*) AS n FROM tiempos_pedido t WHERE ${fT} GROUP BY t.resultado`, par(desde, hasta))).map((f) => ({ clave: String(f['clave']), n: ent(f['n']) }));
    const tiemposModalidad = (await filas(`SELECT t.modalidad AS clave, COUNT(*) AS n, AVG(t.duracion_seg) AS seg FROM tiempos_pedido t WHERE ${fT} GROUP BY t.modalidad`, par(desde, hasta))).map((f) => ({ clave: String(f['clave']), n: ent(f['n']), min: Math.round((Number(f['seg']) / 60) * 10) / 10 }));
    const tiemposHora = (await filas(`SELECT HOUR(t.inicio_en) AS h, COUNT(*) AS n, AVG(t.duracion_seg) AS seg FROM tiempos_pedido t WHERE ${fT} GROUP BY h ORDER BY h`, par(desde, hasta))).map((f) => ({ h: ent(f['h']), n: ent(f['n']), min: Math.round((Number(f['seg']) / 60) * 10) / 10 }));
    const histograma = (await filas(`SELECT LEAST(FLOOR(t.duracion_seg / 300), 12) AS b, COUNT(*) AS n FROM tiempos_pedido t WHERE ${fT} GROUP BY b ORDER BY b`, par(desde, hasta))).map((f) => ({ b: ent(f['b']), n: ent(f['n']) }));
    const cola = (await filas(`SELECT AVG(t.posicion_cola) AS pos, AVG(t.unidades) AS uni, SUM(t.reabierto) AS reabiertos, SUM(t.agendado) AS agendados FROM tiempos_pedido t WHERE ${fT}`, par(desde, hasta)))[0];

    // Clientes
    const cli = (await filas(
      `SELECT COUNT(DISTINCT o.telefono) AS con_tel, COUNT(DISTINCT CASE WHEN c.creado_en < ? THEN o.telefono END) AS recurrentes
         FROM ordenes o LEFT JOIN contactos c ON c.negocio_id = o.negocio_id AND c.telefono = o.telefono
        WHERE ${fO} AND o.estado <> 'cancelada' AND o.telefono IS NOT NULL`, [`${desde} 00:00:00`, ...par(desde, hasta)]))[0];
    const conTel = ent(cli?.['con_tel']);
    const recurrentes = ent(cli?.['recurrentes']);
    const promos = (await filas('SELECT COUNT(*) AS total, SUM(acepta_promos = 1) AS acepta, SUM(creado_en >= ? AND creado_en < ? + INTERVAL 1 DAY) AS nuevos FROM contactos WHERE negocio_id = ?', [desde, hasta, nid]))[0];
    const sinTel = (await filas(`SELECT COUNT(*) AS n FROM ordenes o WHERE ${fO} AND o.estado <> 'cancelada' AND o.telefono IS NULL`, par(desde, hasta)))[0];
    const topClientes = (await filas(
      `SELECT o.telefono, MAX(o.nombre_cliente) AS nombre, COUNT(*) AS pedidos, SUM(o.total) AS gastado, MAX(o.fecha_turno) AS ultimo
         FROM ordenes o WHERE ${fO} AND o.estado <> 'cancelada' AND o.telefono IS NOT NULL GROUP BY o.telefono ORDER BY gastado DESC LIMIT 10`, par(desde, hasta)))
      .map((f) => ({ nombre: String(f['nombre']), tel: `···· ${String(f['telefono']).slice(-4)}`, pedidos: ent(f['pedidos']), gastado: num(f['gastado']), ultimo: String(f['ultimo']).slice(0, 10) }));

    // Catálogo del explorador (se completa solo con las columnas que existan)
    const explorador: Record<string, { etiqueta: string; dimensiones: { id: string; etiqueta: string; temporal: boolean; auto: boolean }[]; metricas: { id: string; etiqueta: string; formato: string; auto: boolean }[] }> = {};
    const nombres: Record<Fuente, string> = { ordenes: 'Pedidos', renglones: 'Platillos vendidos', pagos: 'Pagos' };
    for (const fu of Object.keys(FUENTES) as Fuente[]) {
      const cat = await catalogo(fu);
      explorador[fu] = {
        etiqueta: nombres[fu],
        dimensiones: cat.dims.map((d) => ({ id: d.id, etiqueta: d.etiqueta, temporal: !!d.temporal, auto: !!d.auto })),
        metricas: cat.mets.map((m) => ({ id: m.id, etiqueta: m.etiqueta, formato: m.formato, auto: !!m.auto })),
      };
    }

    return {
      ok: true, desde, hasta, desde_previo: desdePrev, hasta_previo: hastaPrev, dias, sucursal: sucFiltro || null, sucursales,
      resumen, previo, por_dia: porDia, por_dia_previo: porDiaPrevio, calor,
      por_modalidad: porModalidad, por_origen: porOrigen, por_zona: porZona, por_mesa: porMesa, pedidos_mixtos: ent(mixto?.['n']),
      por_metodo: porMetodo, por_sucursal: porSucursal,
      productos, producto_dia: productoDia, categorias, extras, pares,
      tiempos: { resultado: tiemposResultado, por_modalidad: tiemposModalidad, por_hora: tiemposHora, histograma, posicion_prom: cola?.['pos'] === null ? null : Math.round(Number(cola?.['pos'] ?? 0) * 10) / 10, reabiertos: ent(cola?.['reabiertos']), agendados: ent(cola?.['agendados']) },
      clientes: { con_telefono: conTel, recurrentes, nuevos: Math.max(0, conTel - recurrentes), sin_telefono: ent(sinTel?.['n']), contactos: ent(promos?.['total']), acepta_promos: ent(promos?.['acepta']), contactos_nuevos: ent(promos?.['nuevos']), top: topClientes },
      explorador,
    };
  });
}
