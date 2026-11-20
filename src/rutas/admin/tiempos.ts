/**
 * Bitácora de tiempos de entrega (roles admin y gerente). Base para el portal de métricas.
 *
 *   GET /admin/tiempos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   (por defecto: hoy)
 *       &sucursal=ID  &modalidad=aqui|llevar|recoger  &resultado=anticipado|a_tiempo|atrasado  &reabierto=1
 *       &formato=csv   → descarga CSV en vez de JSON
 *   → { filas: [...], resumen: { total, anticipado, a_tiempo, atrasado, promedio_seg, promedio_diferencia_seg,
 *                                por_modalidad: {...}, por_posicion: [{posicion, total, promedio_seg, atrasados}] } }
 *
 * Sin ?sucursal= se juntan TODAS las sucursales de la empresa; el gerente solo ve la suya.
 */
import type { FastifyInstance } from 'fastify';
import { requerirGestion } from '../../auth.js';
import { filas } from '../../db.js';
import { sucursalesActivas } from '../../negocio.js';
import { entero } from '../../util.js';

interface Agregado {
  producto: string;
  codigo: string | null;
  cantidad: number;
  extras: string | null;
  despues_de_entrega: boolean;
}

/** Fila ya convertida: las columnas numéricas/booleanas tipadas y el resto tal como vino de MySQL. */
interface FilaTiempo extends Record<string, unknown> {
  id: number;
  orden_id: number;
  sucursal_id: number | null;
  entrega_n: number | null;
  turno: number | null;
  unidades: number | null;
  agendado: boolean;
  reabierto: boolean;
  posicion_cola: number | null;
  retrasados_delante: number | null;
  estimado_min: number | null;
  duracion_seg: number | null;
  diferencia_seg: number | null;
  n_agregados: number | null;
  agregados: Agregado[];
}

/** Campo CSV entre comillas si hace falta. */
const csv = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export async function rutasTiempos(app: FastifyInstance): Promise<void> {
  app.get('/admin/tiempos', async (req, reply) => {
    const yo = await requerirGestion(req);
    const nid = req.negocio.id;
    const q = req.query as Record<string, unknown>;

    const fecha = (v: unknown, def: string): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : def);
    const hoy = String((await filas('SELECT CURDATE() AS f'))[0]?.['f']);
    const desde = fecha(q['desde'], hoy);
    const hasta = fecha(q['hasta'], desde);

    const donde = ['t.negocio_id = ?', 't.fecha BETWEEN ? AND ?'];
    const par: unknown[] = [nid, desde, hasta];
    const sucursalFiltro = yo.alcance !== null ? yo.alcance : entero(q['sucursal']); // el gerente solo ve su sucursal
    if (sucursalFiltro > 0) {
      donde.push('t.sucursal_id = ?');
      par.push(sucursalFiltro);
    }
    if (['aqui', 'llevar', 'recoger'].includes(String(q['modalidad']))) {
      donde.push('t.modalidad = ?');
      par.push(q['modalidad']);
    }
    if (['anticipado', 'a_tiempo', 'atrasado'].includes(String(q['resultado']))) {
      donde.push('t.resultado = ?');
      par.push(q['resultado']);
    }
    if (q['reabierto'] === '1') donde.push('t.reabierto = 1');

    const crudas = await filas(
      `SELECT t.id, t.orden_id, t.entrega_n, t.fecha, t.turno, t.modalidad, t.origen, t.unidades, t.agendado, t.reabierto,
              t.posicion_cola, t.retrasados_delante, t.estimado_min, t.inicio_en, t.prometido_en, t.entregado_en,
              t.duracion_seg, t.diferencia_seg, t.resultado, t.n_agregados, t.agregados, t.sucursal_id, s.nombre AS sucursal, o.nombre_cliente
         FROM tiempos_pedido t JOIN ordenes o ON o.id = t.orden_id LEFT JOIN sucursales s ON s.id = t.sucursal_id
        WHERE ${donde.join(' AND ')} ORDER BY t.entregado_en DESC, t.id DESC LIMIT 5000`,
      par,
    );
    const entero0 = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const lista = crudas.map((f): FilaTiempo => {
      let agregados: Agregado[] = [];
      if (f['agregados'] !== null && f['agregados'] !== undefined) {
        try {
          const j: unknown = typeof f['agregados'] === 'string' ? JSON.parse(f['agregados']) : f['agregados'];
          agregados = Array.isArray(j) ? (j as Agregado[]) : [];
        } catch {
          agregados = [];
        }
      }
      return {
        ...(f as Record<string, unknown>),
        id: Number(f['id']), orden_id: Number(f['orden_id']), sucursal_id: entero0(f['sucursal_id']), entrega_n: entero0(f['entrega_n']), turno: entero0(f['turno']),
        unidades: entero0(f['unidades']), agendado: Boolean(Number(f['agendado'])), reabierto: Boolean(Number(f['reabierto'])), posicion_cola: entero0(f['posicion_cola']),
        retrasados_delante: entero0(f['retrasados_delante']), estimado_min: entero0(f['estimado_min']), duracion_seg: entero0(f['duracion_seg']),
        diferencia_seg: entero0(f['diferencia_seg']), n_agregados: entero0(f['n_agregados']), agregados,
      };
    });

    if (q['formato'] === 'csv') {
      const cab = ['sucursal', 'fecha', 'turno', 'cliente', 'modalidad', 'origen', 'piezas', 'agendado', 'reabierto', 'posicion_cola', 'retrasados_delante',
        'estimado_min', 'inicio', 'prometido', 'entregado', 'duracion_seg', 'diferencia_seg', 'resultado', 'agregados'];
      const lineas = [cab.join(',')];
      for (const f of lista) {
        const ag = f.agregados.map((a) => `${a.cantidad}× ${a.codigo || a.producto}${a.extras ? ` (${a.extras})` : ''}${a.despues_de_entrega ? ' [tras entrega]' : ''}`).join(' | ');
        lineas.push([f['sucursal'], f['fecha'], f.turno, f['nombre_cliente'], f['modalidad'], f['origen'], f.unidades, f.agendado ? 1 : 0, f.reabierto ? 1 : 0, f.posicion_cola, f.retrasados_delante,
          f.estimado_min, f['inicio_en'], f['prometido_en'], f['entregado_en'], f.duracion_seg, f.diferencia_seg, f['resultado'], ag].map(csv).join(','));
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="tiempos_${desde}_${hasta}.csv"`);
      return '﻿' + lineas.join('\r\n') + '\r\n';
    }

    // Resumen
    const total = lista.length;
    const res = {
      total, anticipado: 0, a_tiempo: 0, atrasado: 0,
      promedio_seg: null as number | null, promedio_diferencia_seg: null as number | null,
      por_modalidad: {} as Record<string, { total: number; atrasado: number; promedio_seg: number }>,
      por_posicion: [] as { posicion: number; total: number; promedio_seg: number; atrasados: number }[],
    };
    let sumD = 0;
    let sumF = 0;
    const modal = new Map<string, { total: number; atrasado: number; suma: number }>();
    const pos = new Map<number, { total: number; suma: number; atrasados: number }>();
    for (const f of lista) {
      const r = String(f['resultado']) as 'anticipado' | 'a_tiempo' | 'atrasado';
      res[r]++;
      sumD += f.duracion_seg ?? 0;
      sumF += f.diferencia_seg ?? 0;
      const m = modal.get(String(f['modalidad'])) ?? { total: 0, atrasado: 0, suma: 0 };
      m.total++;
      m.atrasado += r === 'atrasado' ? 1 : 0;
      m.suma += f.duracion_seg ?? 0;
      modal.set(String(f['modalidad']), m);
      if (f.posicion_cola !== null && !f.reabierto) {
        // los reabiertos siempre van primero: no cuentan para posición
        const p = pos.get(f.posicion_cola) ?? { total: 0, suma: 0, atrasados: 0 };
        p.total++;
        p.suma += f.duracion_seg ?? 0;
        p.atrasados += r === 'atrasado' ? 1 : 0;
        pos.set(f.posicion_cola, p);
      }
    }
    if (total > 0) {
      res.promedio_seg = Math.round(sumD / total);
      res.promedio_diferencia_seg = Math.round(sumF / total);
    }
    for (const [k, m] of modal) res.por_modalidad[k] = { total: m.total, atrasado: m.atrasado, promedio_seg: Math.round(m.suma / m.total) };
    res.por_posicion = [...pos.entries()].sort((a, b) => a[0] - b[0]).map(([posicion, p]) => ({ posicion, total: p.total, promedio_seg: Math.round(p.suma / p.total), atrasados: p.atrasados }));

    return { ok: true, sucursales: await sucursalesActivas(nid), sucursal: sucursalFiltro || null, desde, hasta, filas: lista, resumen: res };
  });
}
