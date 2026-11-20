import { ejecutar, fila, filas } from './db.js';
import { slugDeTexto } from './util.js';
import { ErrorHttp } from './errores.js';

export interface Negocio {
  id: number;
  slug: string;
  nombre: string;
}

export interface SucursalResumen {
  id: number;
  /** Nombre corto para el enlace del QR (?s=centro). Se asigna una sola vez y no cambia si la sucursal se renombra. */
  slug: string;
  nombre: string;
  direccion: string | null;
}

/** Nombres que no pueden usarse como empresa porque son carpetas o rutas de la app. */
export const SLUGS_RESERVADOS = new Set([
  'api', 'admin', 'caja', 'cocina', 'pedidos', 'cliente', 'css', 'js', 'img', 'uploads', 'database',
  'plataforma', 'www', 'app', 'static', 'assets', 'login', 'registro', 'soporte', 'ayuda', 'precios',
]);

const FORMATO_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function slugValido(s: string): boolean {
  return FORMATO_SLUG.test(s) && !SLUGS_RESERVADOS.has(s);
}

/** Datos de la empresa de esta ruta. 404 si no existe, 403 si está pausada. */
export async function cargarNegocio(slugCrudo: string): Promise<Negocio> {
  const slug = slugCrudo.toLowerCase();
  if (!slugValido(slug)) {
    throw new ErrorHttp(404, 'sin_negocio', 'Falta el nombre del negocio en la dirección.');
  }
  const f = await fila('SELECT id, slug, nombre, activo FROM negocios WHERE slug = ?', [slug]);
  if (!f) throw new ErrorHttp(404, 'negocio_no_existe', 'Este negocio no existe.');
  if (!Number(f['activo'])) {
    throw new ErrorHttp(403, 'negocio_pausado', 'Este negocio está pausado. Contacta a quien administra tu suscripción.');
  }
  return { id: Number(f['id']), slug: String(f['slug']), nombre: String(f['nombre']) };
}

/**
 * Da su "slug" (nombre para el enlace del QR) a las sucursales que aún no lo tienen: sucursales nuevas o de bases anteriores.
 * Es único dentro de la empresa ("centro", y si se repite "centro-2"). Una vez asignado no se vuelve a tocar,
 * para que los QR ya impresos sigan funcionando aunque se cambie el nombre de la sucursal.
 */
export async function completarSlugsSucursales(negocioId: number): Promise<void> {
  const todas = await filas('SELECT id, nombre, slug FROM sucursales WHERE negocio_id = ? ORDER BY id', [negocioId]);
  if (todas.every((x) => x['slug'])) return;
  const usados = new Set(todas.map((x) => x['slug']).filter(Boolean).map(String));
  for (const x of todas) {
    if (x['slug']) continue;
    const base = slugDeTexto(String(x['nombre']));
    let slug = base;
    for (let n = 2; usados.has(slug); n++) slug = `${base}-${n}`;
    usados.add(slug);
    await ejecutar('UPDATE sucursales SET slug = ? WHERE id = ? AND slug IS NULL', [slug, Number(x['id'])]);
  }
}

/** Sucursales activas de la empresa, en su orden. */
export async function sucursalesActivas(negocioId: number): Promise<SucursalResumen[]> {
  await completarSlugsSucursales(negocioId);
  const r = await filas('SELECT id, nombre, slug, direccion FROM sucursales WHERE negocio_id = ? AND activa = 1 ORDER BY orden, id', [negocioId]);
  return r.map((s) => ({ id: Number(s['id']), nombre: String(s['nombre']), slug: String(s['slug']), direccion: (s['direccion'] as string | null) ?? null }));
}
