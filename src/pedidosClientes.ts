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

/**
 * Pestañas que ve el cliente en la pantalla del QR de una sucursal (el gerente o el dueño las prende y apaga):
 *   `cliente_ver_pedido@<id>`  → pestaña "Mi pedido"
 *   `cliente_ver_pagar@<id>`   → pestaña "Pagar"
 * Valor "0" = oculta; sin guardar = visible. Si se ocultan las dos, desaparece también la barra de pestañas y el cliente
 * ve únicamente el menú.
 */
export interface PestanasCliente {
  verPedido: boolean;
  verPagar: boolean;
}

export async function pestanasCliente(negocioId: number): Promise<Map<number, PestanasCliente>> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND (clave LIKE 'cliente\\_ver\\_pedido@%' OR clave LIKE 'cliente\\_ver\\_pagar@%')", [negocioId]);
  const mapa = new Map<number, PestanasCliente>();
  for (const f of r) {
    const [campo, idTexto] = String(f['clave']).split('@');
    const id = Number(idTexto);
    if (!(id > 0)) continue;
    const actual = mapa.get(id) ?? { verPedido: true, verPagar: true };
    const visible = String(f['valor']) !== '0';
    if (campo === 'cliente_ver_pedido') actual.verPedido = visible;
    else if (campo === 'cliente_ver_pagar') actual.verPagar = visible;
    mapa.set(id, actual);
  }
  return mapa;
}

export const pestanasDe = (m: Map<number, PestanasCliente>, sucursalId: number): PestanasCliente => m.get(sucursalId) ?? { verPedido: true, verPagar: true };
