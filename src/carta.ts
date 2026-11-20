/**
 * Carta de la SUCURSAL = carta general de la empresa (productos.sucursal_id NULL) + los productos propios de la sucursal,
 * menos lo que la sucursal ocultó, con su precio propio (si lo cambió) y su "agotado hoy".
 * Uso: FROM productos p <cartaUnir(suc)> WHERE p.negocio_id = ? <cartaVisible(suc)> ...  y las columnas CARTA_PRECIO / CARTA_AGOTADO.
 * (suc siempre es un número entero que fija el servidor, nunca texto de la pantalla.)
 */
export const cartaUnir = (suc: number): string => ` LEFT JOIN producto_sucursal ps ON ps.producto_id = p.id AND ps.sucursal_id = ${Math.trunc(suc)} `;
export const cartaVisible = (suc: number): string =>
  ` AND (p.sucursal_id IS NULL OR p.sucursal_id = ${Math.trunc(suc)}) AND COALESCE(ps.oculto, 0) = 0 `;
export const CARTA_PRECIO = 'COALESCE(ps.precio, p.precio)';
export const CARTA_AGOTADO = '(p.agotado_fecha = CURDATE() OR ps.agotado_fecha = CURDATE())';
