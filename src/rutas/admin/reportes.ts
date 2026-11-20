/**
 * Reportes de ventas (roles admin y gerente).
 *
 *   GET /admin/reportes?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   (por defecto: hoy)  &sucursal=ID  (sin esto: TODAS juntas)
 *   → { sucursales, resumen, por_sucursal, por_dia, por_metodo, por_modalidad, por_mesa, productos (los 15 más vendidos) }
 *
 * "Vendido" = total de los pedidos no cancelados; "Cobrado" = pagos registrados en Caja (sin anulados).
 * El gerente solo ve su sucursal (se fuerza aunque pida otra).
 */
import type { FastifyInstance } from 'fastify';
import { requerirGestion } from '../../auth.js';
import { filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { redondear } from '../../ordenes.js';
import { entero } from '../../util.js';

const num = (v: unknown): number => redondear(Number(v ?? 0));

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

    // Filtros reutilizables (siempre por empresa; la sucursal solo si se pidió una)
    let filtroO = 'o.negocio_id = ? AND o.fecha_turno BETWEEN ? AND ?';
    const parO: unknown[] = [nid, desde, hasta];
    let filtroP = 'p.negocio_id = ? AND p.anulado = 0 AND DATE(p.creado_en) BETWEEN ? AND ?';
    const parP: unknown[] = [nid, desde, hasta];
    if (sucFiltro > 0) {
      filtroO += ' AND o.sucursal_id = ?';
      parO.push(sucFiltro);
      filtroP += ' AND p.sucursal_id = ?';
      parP.push(sucFiltro);
    }

    // Resumen
    const r = (await filas(
      `SELECT SUM(o.estado <> 'cancelada') AS pedidos, COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' THEN o.total END), 0) AS vendido, SUM(o.estado = 'cancelada') AS cancelados
         FROM ordenes o WHERE ${filtroO}`, parO))[0];
    const c = (await filas(
      `SELECT COALESCE(SUM(p.monto), 0) AS cobrado, COALESCE(SUM(p.propina), 0) AS propinas, COALESCE(SUM(p.comision), 0) AS comisiones FROM pagos p WHERE ${filtroP}`, parP))[0];
    const pedidos = Number(r?.['pedidos'] ?? 0);
    const resumen = {
      pedidos, vendido: num(r?.['vendido']), cancelados: Number(r?.['cancelados'] ?? 0),
      ticket: pedidos > 0 ? num(Number(r?.['vendido']) / pedidos) : 0,
      cobrado: num(c?.['cobrado']), propinas: num(c?.['propinas']), comisiones: num(c?.['comisiones']),
    };

    // Por sucursal
    const ventas = new Map((await filas(
      `SELECT o.sucursal_id, SUM(o.estado <> 'cancelada') AS pedidos, COALESCE(SUM(CASE WHEN o.estado <> 'cancelada' THEN o.total END), 0) AS vendido
         FROM ordenes o WHERE ${filtroO} GROUP BY o.sucursal_id`, parO)).map((f) => [Number(f['sucursal_id']), f]));
    const cobros = new Map((await filas(
      `SELECT p.sucursal_id, SUM(p.monto) AS cobrado, SUM(p.propina) AS propinas FROM pagos p WHERE ${filtroP} GROUP BY p.sucursal_id`, parP)).map((f) => [Number(f['sucursal_id']), f]));
    const porSucursal = sucursales
      .filter((s) => sucFiltro <= 0 || s.id === sucFiltro)
      .map((s) => {
        const v = ventas.get(s.id);
        const cb = cobros.get(s.id);
        return { id: s.id, nombre: s.nombre, pedidos: v ? Number(v['pedidos']) : 0, vendido: v ? num(v['vendido']) : 0, cobrado: cb ? num(cb['cobrado']) : 0, propinas: cb ? num(cb['propinas']) : 0 };
      });

    const porDia = (await filas(
      `SELECT o.fecha_turno AS fecha, COUNT(*) AS pedidos, SUM(o.total) AS vendido FROM ordenes o WHERE ${filtroO} AND o.estado <> 'cancelada' GROUP BY o.fecha_turno ORDER BY o.fecha_turno`, parO))
      .map((f) => ({ fecha: f['fecha'], pedidos: Number(f['pedidos']), vendido: num(f['vendido']) }));
    const porMetodo = (await filas(
      `SELECT p.metodo, COUNT(*) AS pagos, SUM(p.monto) AS monto, SUM(p.propina) AS propinas FROM pagos p WHERE ${filtroP} GROUP BY p.metodo ORDER BY monto DESC`, parP))
      .map((f) => ({ metodo: f['metodo'], pagos: Number(f['pagos']), monto: num(f['monto']), propinas: num(f['propinas']) }));
    const porModalidad = (await filas(
      `SELECT o.modalidad, COUNT(*) AS pedidos, SUM(o.total) AS vendido FROM ordenes o WHERE ${filtroO} AND o.estado <> 'cancelada' GROUP BY o.modalidad ORDER BY vendido DESC`, parO))
      .map((f) => ({ modalidad: f['modalidad'], pedidos: Number(f['pedidos']), vendido: num(f['vendido']) }));
    const porMesa = (await filas(
      `SELECT o.mesa, COUNT(*) AS pedidos, SUM(o.total) AS vendido FROM ordenes o WHERE ${filtroO} AND o.estado <> 'cancelada' AND o.mesa IS NOT NULL GROUP BY o.mesa ORDER BY vendido DESC LIMIT 30`, parO))
      .map((f) => ({ mesa: f['mesa'], pedidos: Number(f['pedidos']), vendido: num(f['vendido']) }));
    const productos = (await filas(
      `SELECT i.nombre_producto AS nombre, SUM(i.cantidad) AS unidades, SUM((i.precio_unitario + COALESCE(i.extras_precio, 0)) * i.cantidad) AS importe
         FROM orden_items i JOIN ordenes o ON o.id = i.orden_id
        WHERE ${filtroO} AND o.estado <> 'cancelada' GROUP BY i.nombre_producto ORDER BY unidades DESC, importe DESC LIMIT 15`, parO))
      .map((f) => ({ nombre: f['nombre'], unidades: Number(f['unidades']), importe: num(f['importe']) }));

    return { ok: true, desde, hasta, sucursal: sucFiltro || null, sucursales, resumen, por_sucursal: porSucursal, por_dia: porDia, por_metodo: porMetodo, por_modalidad: porModalidad, por_mesa: porMesa, productos };
  });
}
