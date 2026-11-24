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

export const FORMAS_MESA = ['cuadrada', 'redonda', 'larga'] as const;

/** Mesas de una sucursal con su lugar en el plano, y sus zonas (en orden). */
export async function planoDe(nid: number, sid: number, soloActivas: boolean) {
  const zonas = await filas('SELECT id, nombre, orden FROM zonas WHERE negocio_id = ? AND sucursal_id = ? ORDER BY orden, id', [nid, sid]);
  const mesas = await filas(`SELECT id, nombre, activa, zona_id, pos_x, pos_y, forma FROM mesas WHERE negocio_id = ? AND sucursal_id = ?${soloActivas ? ' AND activa = 1' : ''} ORDER BY orden, id`, [nid, sid]);
  return {
    zonas: zonas.map((z) => ({ id: Number(z['id']), nombre: String(z['nombre']) })),
    mesas: mesas.map((m) => ({
      id: Number(m['id']), nombre: String(m['nombre']), activa: Boolean(Number(m['activa'])),
      zona_id: m['zona_id'] === null ? null : Number(m['zona_id']),
      x: m['pos_x'] === null ? null : Number(m['pos_x']), y: m['pos_y'] === null ? null : Number(m['pos_y']),
      forma: String(m['forma'] ?? 'cuadrada'),
    })),
  };
}

/** Lo que necesita una pantalla para elegir mesa: mesas activas, zonas y si se usa el plano visual (activado + hay mesas ubicadas). */
export async function mesasParaElegir(nid: number, sid: number) {
  const plano = await planoDe(nid, sid, true);
  const usar = (await planoActivoEn(nid, sid)) && plano.zonas.length > 0 && plano.mesas.some((m) => m.zona_id !== null);
  return { mesas: plano.mesas, zonas: plano.zonas, plano: usar };
}
