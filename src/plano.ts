/**
 * Plano visual de mesas: ¿se usa al elegir la mesa en Tomar pedidos?
 *   `plano_mesas` (toda la empresa) y `plano_mesas@<sucursal>`: "1" = sí. La sucursal manda si tiene valor propio.
 * Por defecto está apagado; se enciende desde el panel (Pedidos → Plano de mesas).
 */
import { filas } from './db.js';

export async function planoActivoEn(nid: number, sid: number): Promise<boolean> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN ('plano_mesas', ?)", [nid, `plano_mesas@${sid}`]);
  const propio = r.find((f) => f['clave'] === `plano_mesas@${sid}`);
  const general = r.find((f) => f['clave'] === 'plano_mesas');
  return (propio ?? general)?.['valor'] === '1';
}

/** Forma irregular de una zona: lista de puntos [x, y] en % del lienzo (3 a 40). null = rectángulo. */
export function leerPoligono(v: unknown): [number, number][] | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const a: unknown = typeof v === 'string' ? JSON.parse(v) : v;
    if (!Array.isArray(a) || a.length < 3 || a.length > 40) return null;
    const pts = a.map((p) => [Math.min(100, Math.max(0, Number((p as unknown[])[0]))), Math.min(100, Math.max(0, Number((p as unknown[])[1])))] as [number, number]);
    return pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) ? pts.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100] as [number, number]) : null;
  } catch { return null; }
}

export const FORMAS_MESA = ['cuadrada', 'redonda', 'larga'] as const;

/** Mesas de una sucursal con su lugar en el plano, y sus zonas (en orden). */
export async function planoDe(nid: number, sid: number, soloActivas: boolean) {
  const zonas = await filas('SELECT id, nombre, orden, poligono FROM zonas WHERE negocio_id = ? AND sucursal_id = ? ORDER BY orden, id', [nid, sid]);
  const mesas = await filas(`SELECT id, nombre, activa, zona_id, pos_x, pos_y, forma, escala FROM mesas WHERE negocio_id = ? AND sucursal_id = ?${soloActivas ? ' AND activa = 1' : ''} ORDER BY orden, id`, [nid, sid]);
  return {
    zonas: zonas.map((z) => ({ id: Number(z['id']), nombre: String(z['nombre']), poligono: leerPoligono(z['poligono']) })),
    mesas: mesas.map((m) => ({
      id: Number(m['id']), nombre: String(m['nombre']), activa: Boolean(Number(m['activa'])),
      zona_id: m['zona_id'] === null ? null : Number(m['zona_id']),
      x: m['pos_x'] === null ? null : Number(m['pos_x']), y: m['pos_y'] === null ? null : Number(m['pos_y']),
      forma: String(m['forma'] ?? 'cuadrada'), escala: Number(m['escala'] ?? 1),
    })),
  };
}

/** Lo que necesita una pantalla para elegir mesa: mesas activas, zonas y si se usa el plano visual (activado + hay mesas ubicadas). */
export async function mesasParaElegir(nid: number, sid: number) {
  const plano = await planoDe(nid, sid, true);
  const usar = (await planoActivoEn(nid, sid)) && plano.zonas.length > 0 && plano.mesas.some((m) => m.zona_id !== null);
  return { mesas: plano.mesas, zonas: plano.zonas, plano: usar };
}
