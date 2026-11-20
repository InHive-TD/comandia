/** Utilidades de lectura de datos que llegan de la pantalla (siempre se valida en el servidor). */

/** Largo en caracteres (no en bytes): "ñ" y los emojis cuentan como uno. */
export const largo = (s: string): number => [...s].length;

/** Como (int) de PHP: "12abc" → 12, "abc" → 0, true → 1. */
export function entero(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Como !empty() de PHP: "", "0", 0, false, null y [] son "vacío". */
export function noVacio(v: unknown): boolean {
  return !(v === undefined || v === null || v === '' || v === 0 || v === '0' || v === false || (Array.isArray(v) && v.length === 0));
}

/** Lista de ids enteros sin repetir, en el mismo orden. */
export function enteros(v: unknown): number[] {
  const lista = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return [...new Set(lista.map(entero))];
}

export const mayusculas = (s: string): string => s.toLocaleUpperCase('es-MX');

/** ¿El error es "valor duplicado" de MySQL (índice único)? */
export function esDuplicado(e: unknown): boolean {
  return (e as { errno?: number }).errno === 1062;
}
