/**
 * Lo que el cliente ve y puede hacer en su pantalla (QR), configurable por empresa y por sucursal (tabla `ajustes`):
 *
 *   `cliente_modalidades`  / `cliente_modalidades@<sid>`  → JSON ["aqui","llevar","recoger"]: qué botones de tipo de pedido existen
 *   `cliente_mixto`        / `cliente_mixto@<sid>`        → "1"/"0": ¿puede elegir plato por plato (uno aquí y otro para llevar)?
 *   `cliente_pago`         / `cliente_pago@<sid>`         → JSON { clabe, beneficiario, institucion }: datos de la pestaña "Pagar"
 *
 * La sucursal manda si tiene su propio valor; si no, el de toda la empresa; si tampoco, el valor por defecto
 * (todos los tipos, mixto activado, y sin datos de pago).
 */
import { filas } from './db.js';

export const TIPOS_PEDIDO = ['aqui', 'llevar', 'recoger'] as const;

export interface PagoCliente { clabe: string; beneficiario: string; institucion: string }

export interface ConfigCliente {
  modalidades: string[];
  mixto: boolean;
  pago: PagoCliente | null;
}

/** Valores guardados, tal cual, de un solo nivel (empresa o una sucursal); null = sin valor propio. */
export interface NivelCliente {
  modalidades: string[] | null;
  mixto: boolean | null;
  pago: PagoCliente | null;
}

export type AjustesCliente = Map<string, string>;

export async function cargarAjustesCliente(negocioId: number): Promise<AjustesCliente> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND (clave LIKE 'cliente\\_modalidades%' OR clave LIKE 'cliente\\_mixto%' OR clave LIKE 'cliente\\_pago%')", [negocioId]);
  return new Map(r.map((f) => [String(f['clave']), String(f['valor'] ?? '')]));
}

function leerModalidades(v: string | undefined): string[] | null {
  if (v === undefined) return null;
  try {
    const a: unknown = JSON.parse(v);
    if (!Array.isArray(a)) return null;
    const ok = TIPOS_PEDIDO.filter((t) => a.includes(t));
    return ok.length > 0 ? ok : null;
  } catch { return null; }
}

function leerPago(v: string | undefined): PagoCliente | null {
  if (v === undefined) return null;
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    const clabe = String(o['clabe'] ?? '').replace(/\D+/g, '');
    if (clabe === '') return null;
    return { clabe, beneficiario: String(o['beneficiario'] ?? '').trim(), institucion: String(o['institucion'] ?? '').trim() };
  } catch { return null; }
}

/** Valores propios de un nivel: sucursal = id, empresa = null. */
export function nivelCliente(a: AjustesCliente, sucursalId: number | null): NivelCliente {
  const sufijo = sucursalId === null ? '' : `@${sucursalId}`;
  const mixto = a.get(`cliente_mixto${sufijo}`);
  return {
    modalidades: leerModalidades(a.get(`cliente_modalidades${sufijo}`)),
    mixto: mixto === undefined ? null : mixto !== '0',
    pago: leerPago(a.get(`cliente_pago${sufijo}`)),
  };
}

/** Lo que de verdad ve el cliente de una sucursal. */
export function configEfectiva(a: AjustesCliente, sucursalId: number): ConfigCliente {
  const s = nivelCliente(a, sucursalId);
  const g = nivelCliente(a, null);
  const modalidades = s.modalidades ?? g.modalidades ?? [...TIPOS_PEDIDO];
  // "Uno aquí y otro para llevar" necesita que existan los dos tipos
  const mixto = (s.mixto ?? g.mixto ?? true) && modalidades.includes('aqui') && modalidades.includes('llevar');
  return { modalidades, mixto, pago: s.pago ?? g.pago };
}

export async function configClienteDe(negocioId: number, sucursalId: number): Promise<ConfigCliente> {
  return configEfectiva(await cargarAjustesCliente(negocioId), sucursalId);
}
