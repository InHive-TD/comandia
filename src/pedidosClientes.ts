/**
 * ¿Puede el cliente levantar su propio pedido desde el QR, o solo ver el menú?
 *
 * Se decide en DOS niveles (se guardan en la tabla `ajustes`):
 *   - toda la empresa:  clave `cliente_pedidos`        (lo cambia el dueño)
 *   - por sucursal:     clave `cliente_pedidos@<id>`   (lo cambia el gerente de esa sucursal, o el dueño)
 * Valor "0" = desactivado ("solo ver el menú"); cualquier otro valor, o sin guardar = activado.
 * El pedido del cliente solo se permite si AMBOS niveles lo permiten: si el dueño lo apaga para toda la empresa,
 * ninguna sucursal puede encenderlo; si lo deja encendido, cada sucursal decide.
 */
import { filas } from './db.js';

export interface EstadoPedidosCliente {
  /** Interruptor de toda la empresa. */
  general: boolean;
  /** Interruptor propio de cada sucursal (id → activo). */
  porSucursal: Map<number, boolean>;
}

export async function estadoPedidosCliente(negocioId: number): Promise<EstadoPedidosCliente> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND (clave = 'cliente_pedidos' OR clave LIKE 'cliente\\_pedidos@%')", [negocioId]);
  let general = true;
  const porSucursal = new Map<number, boolean>();
  for (const f of r) {
    const clave = String(f['clave']);
    const activo = String(f['valor']) !== '0';
    if (clave === 'cliente_pedidos') general = activo;
    else {
      const id = Number(clave.split('@')[1]);
      if (id > 0) porSucursal.set(id, activo);
    }
  }
  return { general, porSucursal };
}

/** Estado efectivo para una sucursal: ¿puede el cliente pedir desde el QR? */
export const efectivo = (e: EstadoPedidosCliente, sucursalId: number): boolean => e.general && (e.porSucursal.get(sucursalId) ?? true);

export async function clientePuedePedir(negocioId: number, sucursalId: number): Promise<boolean> {
  return efectivo(await estadoPedidosCliente(negocioId), sucursalId);
}
