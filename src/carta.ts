/**
 * Carta de la SUCURSAL = carta general de la empresa (productos.sucursal_id NULL) + los productos propios de la sucursal,
 * menos lo que la sucursal ocultó, con su precio propio (si lo cambió) y su "agotado hoy".
 * Uso: FROM productos p <cartaUnir(suc)> WHERE p.negocio_id = ? <cartaVisible(suc)> ...  y las columnas CARTA_PRECIO / CARTA_AGOTADO.
 * (suc siempre es un número entero que fija el servidor, nunca texto de la pantalla.)
 */
export const cartaUnir = (suc: number): string => ` LEFT JOIN producto_sucursal ps ON ps.producto_id = p.id AND ps.sucursal_id = ${Math.trunc(suc)} `;
export const cartaVisible = (suc: number): string =>
  ` AND ${cartaOrigen(suc)} AND COALESCE(ps.oculto, 0) = 0 `;
/** La carta general se ve salvo que la sucursal tenga carta propia (sucursales.carta_propia = 1). Siempre se ven sus platillos propios. */
export const cartaOrigen = (suc: number, alias = 'p'): string =>
  `(${alias}.sucursal_id = ${Math.trunc(suc)} OR (${alias}.sucursal_id IS NULL AND NOT EXISTS (SELECT 1 FROM sucursales sc WHERE sc.id = ${Math.trunc(suc)} AND sc.carta_propia = 1)))`;
export const CARTA_PRECIO = 'COALESCE(ps.precio, p.precio)';
export const CARTA_AGOTADO = '(p.agotado_fecha = CURDATE() OR ps.agotado_fecha = CURDATE())';

/** SQL: el modificador `alias` se ve en la sucursal `suc` (es general o de esa sucursal, y no está deshabilitado ahí). */
export const extraVisible = (suc: number, alias = 'e'): string =>
  `(${alias}.sucursal_id IS NULL OR ${alias}.sucursal_id = ${Number(suc)}) AND NOT EXISTS (SELECT 1 FROM extra_sucursal_off eso WHERE eso.extra_id = ${alias}.id AND eso.sucursal_id = ${Number(suc)})`;
