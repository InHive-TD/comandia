import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { fila, filas } from './db.js';
import { ErrorHttp } from './errores.js';
import { sucursalesActivas } from './negocio.js';
import { type ContextoSesion, type Sesion, sesionDe } from './sesion.js';

export type Rol = 'admin' | 'gerente' | 'caja' | 'mesero' | 'taquero';

export interface Usuario {
  id: number;
  nombre: string;
  usuario: string;
  rol: Rol;
  /** Sucursal principal. null = el administrador (puede cambiar entre todas). */
  sucursalId: number | null;
  /** Todas las sucursales donde puede trabajar (la principal + las adicionales). null = el dueño: todas. */
  sucursalesPermitidas: number[] | null;
  /** Sucursal con la que trabaja ahora (0 si la empresa no tiene sucursales activas). */
  sucursalActiva: number;
  /** null = dueño (toda la empresa); id = gerente (solo su sucursal). */
  alcance: number | null;
}

export function contextoNegocio(req: FastifyRequest): ContextoSesion {
  const { slug } = req.negocio;
  return { cookie: 'cmd_' + slug.replaceAll('-', '_'), ruta: `/${slug}/` };
}

export const contextoPlataforma: ContextoSesion = { cookie: 'cmd_plataforma', ruta: '/' };

export const sesionDeNegocio = (req: FastifyRequest): Promise<Sesion> => sesionDe(req, contextoNegocio(req));

/** Código CSRF de la sesión: la pantalla lo manda en el encabezado X-CSRF-Token al modificar datos. */
export function csrfToken(sesion: Sesion): string {
  let t = sesion.obtener<string>('csrf');
  if (!t) {
    t = randomBytes(32).toString('hex');
    sesion.poner('csrf', t);
  }
  return t;
}

export function verificarCsrf(req: FastifyRequest, sesion: Sesion): void {
  const enviado = req.headers['x-csrf-token'];
  const esperado = csrfToken(sesion);
  const ok =
    typeof enviado === 'string' &&
    enviado.length === esperado.length &&
    timingSafeEqual(Buffer.from(enviado), Buffer.from(esperado));
  if (!ok) throw new ErrorHttp(403, 'csrf', 'La sesión caducó. Recarga la página e inténtalo de nuevo.');
}

/** Cuerpo JSON de la petición como objeto (vacío si no vino o no es válido). */
export function cuerpoJson(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** Usuario con sesión iniciada (y activo) en esta empresa, o null. */
export async function usuarioActual(req: FastifyRequest): Promise<Omit<Usuario, 'sucursalActiva' | 'alcance'> | null> {
  const ses = await sesionDeNegocio(req);
  const id = ses.obtener<number>('usuario_id');
  if (!id) return null;
  // La sesión pertenece a UNA empresa: si llega a otra, no sirve.
  if (Number(ses.obtener('negocio_id') ?? 0) !== req.negocio.id) return null;

  // Se consulta en cada petición: si desactivas a alguien, pierde el acceso al instante.
  const f = await fila('SELECT id, nombre, usuario, rol, sucursal_id FROM usuarios WHERE id = ? AND negocio_id = ? AND activo = 1', [id, req.negocio.id]);
  if (!f) {
    ses.datos = {};
    return null;
  }
  const sucursalId = f['sucursal_id'] === null ? null : Number(f['sucursal_id']);
  let sucursalesPermitidas: number[] | null = null;
  if (sucursalId !== null) {
    const extra = await filas('SELECT sucursal_id FROM usuario_sucursales WHERE usuario_id = ?', [Number(f['id'])]);
    sucursalesPermitidas = [sucursalId, ...extra.map((x) => Number(x['sucursal_id']))];
  }
  return { id: Number(f['id']), nombre: String(f['nombre']), usuario: String(f['usuario']), rol: f['rol'] as Rol, sucursalId, sucursalesPermitidas };
}

/**
 * Sucursal de trabajo. El dueño: la que eligió (o la primera). El personal: la que eligió entre las suyas
 * (si trabaja en varias), o su sucursal principal. 0 si no tiene ninguna activa.
 */
export async function resolverSucursal(req: FastifyRequest, u: { sucursalId: number | null; sucursalesPermitidas: number[] | null }): Promise<number> {
  const todas = (await sucursalesActivas(req.negocio.id)).map((s) => s.id);
  const activas = u.sucursalesPermitidas === null ? todas : todas.filter((id) => (u.sucursalesPermitidas as number[]).includes(id));
  const ses = await sesionDeNegocio(req);
  const elegida = Number(ses.obtener('sucursal_id') ?? 0);
  if (elegida && activas.includes(elegida)) return elegida;
  if (u.sucursalId !== null && activas.includes(u.sucursalId)) return u.sucursalId;
  return activas[0] ?? 0;
}

/**
 * Exige sesión iniciada y, opcionalmente, uno de los roles. En peticiones que modifican datos exige también el CSRF.
 * Fija la sucursal de la petición (req.sucursalId).
 */
export async function requerirRol(req: FastifyRequest, ...roles: Rol[]): Promise<Usuario> {
  const u = await usuarioActual(req);
  if (!u) throw new ErrorHttp(401, 'no_autenticado', 'Inicia sesión para continuar.');
  if (roles.length && !roles.includes(u.rol)) throw new ErrorHttp(403, 'sin_permiso', 'No tienes permiso para hacer esto.');
  if (req.method !== 'GET') verificarCsrf(req, await sesionDeNegocio(req));
  const suc = await resolverSucursal(req, u);
  if (suc < 1) {
    throw new ErrorHttp(403, 'sin_sucursal', 'Tu usuario no tiene una sucursal activa asignada. Pide al administrador que la configure.');
  }
  req.sucursalId = suc;
  // El gerente administra la sucursal en la que está trabajando ahora (si tiene varias, la que eligió en el selector).
  return { ...u, sucursalActiva: suc, alcance: u.rol === 'gerente' ? suc : null };
}

/** Panel de administración: el dueño (alcance = empresa) o el gerente (alcance = su sucursal). */
export async function requerirGestion(req: FastifyRequest): Promise<Usuario> {
  const u = await requerirRol(req, 'admin', 'gerente');
  if (u.rol === 'gerente' && u.sucursalId === null) {
    throw new ErrorHttp(403, 'sin_sucursal', 'Tu usuario de gerente no tiene sucursal asignada.');
  }
  return u;
}

/** Cliente por QR: la sucursal viene en ?s=<nombre corto> (ej. "centro") o ?s=<id> (QR antiguos), o en el encabezado X-Sucursal; sin eso, la primera activa. */
export async function fijarSucursalPublica(req: FastifyRequest): Promise<void> {
  const q = req.query as Record<string, unknown>;
  const cab = req.headers['x-sucursal'];
  const pedida = String(q['s'] ?? (typeof cab === 'string' ? cab : '')).trim().toLowerCase();
  const lista = await sucursalesActivas(req.negocio.id);
  const primera = lista[0];
  if (!primera) throw new ErrorHttp(404, 'sin_sucursal', 'Este negocio aún no tiene sucursales.');
  req.sucursalId = (lista.find((s) => s.slug === pedida) ?? lista.find((s) => String(s.id) === pedida))?.id ?? primera.id;
}

/** Pantallas que usan personal y cliente: con sesión, la sucursal del usuario; si no, la del QR. */
export async function fijarSucursalAuto(req: FastifyRequest): Promise<void> {
  const u = await usuarioActual(req);
  const suc = u ? await resolverSucursal(req, u) : 0;
  if (suc > 0) {
    req.sucursalId = suc;
    return;
  }
  await fijarSucursalPublica(req);
}

/** Rechaza la petición si no usa uno de los métodos permitidos. */
export function exigirMetodo(req: FastifyRequest, ...permitidos: string[]): void {
  if (!permitidos.includes(req.method)) throw new ErrorHttp(405, 'metodo', 'Método no permitido.');
}
