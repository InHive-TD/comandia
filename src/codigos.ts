/**
 * Los códigos cortos (los que ve la cocina) no se repiten en toda la empresa, entre platillos, modificadores y secciones.
 * Devuelve quién ya usa el código, o null si está libre. `excluir` es lo que se está editando (para no chocar consigo mismo).
 */
import { fila } from './db.js';

export interface QuienUsa { tipo: 'platillo' | 'modificador' | 'sección'; nombre: string; sucursal_id: number | null }

export async function codigoEnUso(
  nid: number,
  codigo: string,
  excluir: { producto?: number; extra?: number; grupo?: string } = {},
  tipos: ('platillo' | 'modificador' | 'sección')[] = ['platillo', 'modificador', 'sección'],
): Promise<QuienUsa | null> {
  if (tipos.includes('platillo')) {
    const p = await fila('SELECT nombre, sucursal_id FROM productos WHERE negocio_id = ? AND codigo = ? AND id <> ?', [nid, codigo, excluir.producto ?? 0]);
    if (p) return { tipo: 'platillo', nombre: String(p['nombre']), sucursal_id: p['sucursal_id'] === null ? null : Number(p['sucursal_id']) };
  }
  if (tipos.includes('modificador')) {
    const e = await fila('SELECT nombre, sucursal_id FROM extras WHERE negocio_id = ? AND codigo = ? AND id <> ?', [nid, codigo, excluir.extra ?? 0]);
    if (e) return { tipo: 'modificador', nombre: String(e['nombre']), sucursal_id: e['sucursal_id'] === null ? null : Number(e['sucursal_id']) };
  }
  if (tipos.includes('sección')) {
    const g = await fila('SELECT nombre, sucursal_id FROM extra_grupos WHERE negocio_id = ? AND codigo = ? AND nombre <> ?', [nid, codigo, excluir.grupo ?? '']);
    if (g) return { tipo: 'sección', nombre: String(g['nombre']), sucursal_id: g['sucursal_id'] === null ? null : Number(g['sucursal_id']) };
  }
  return null;
}

/** Mensaje para quien pide; al gerente no se le revela el nombre de lo que es de OTRA sucursal. */
export function mensajeCodigo(codigo: string, q: QuienUsa, alcance: number | null): string {
  const ajeno = alcance !== null && q.sucursal_id !== null && q.sucursal_id !== alcance;
  return ajeno ? `El código ${codigo} ya está en uso. Elige otro.` : `El código ${codigo} ya lo usa ${q.tipo === 'sección' ? 'la sección' : q.tipo === 'platillo' ? 'el platillo' : 'el modificador'} “${q.nombre}”. Elige otro.`;
}
