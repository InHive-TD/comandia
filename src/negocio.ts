import { fila, filas } from './db.js';
import { ErrorHttp } from './errores.js';

export interface Negocio {
  id: number;
  slug: string;
  nombre: string;
}

export interface SucursalResumen {
  id: number;
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

/** Sucursales activas de la empresa, en su orden. */
export async function sucursalesActivas(negocioId: number): Promise<SucursalResumen[]> {
  const r = await filas('SELECT id, nombre, direccion FROM sucursales WHERE negocio_id = ? AND activa = 1 ORDER BY orden, id', [negocioId]);
  return r.map((s) => ({ id: Number(s['id']), nombre: String(s['nombre']), direccion: (s['direccion'] as string | null) ?? null }));
}
