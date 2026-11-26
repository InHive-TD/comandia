import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contextoPlataforma, csrfToken, cuerpoJson, verificarCsrf } from '../auth.js';
import { ejecutar, fila } from '../db.js';
import { ErrorHttp } from '../errores.js';
import { type Sesion, sesionDe } from '../sesion.js';
import { rutasPlataformaIntegraciones } from './plataformaIntegraciones.js';
import { rutasPlataformaNegocios } from './plataformaNegocios.js';

const HASH_RELLENO = bcrypt.hashSync('relleno-para-igualar-tiempos', 10);
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const sesionPlataforma = (req: FastifyRequest): Promise<Sesion> => sesionDe(req, contextoPlataforma);

export async function plataformaActual(req: FastifyRequest): Promise<{ id: number; nombre: string; usuario: string } | null> {
  const ses = await sesionPlataforma(req);
  const id = ses.obtener<number>('plat_id');
  if (!id) return null;
  const f = await fila('SELECT id, nombre, usuario FROM plataforma_admins WHERE id = ? AND activo = 1', [id]);
  if (!f) {
    ses.quitar('plat_id');
    return null;
  }
  return { id: Number(f['id']), nombre: String(f['nombre']), usuario: String(f['usuario']) };
}

/** Exige sesión de plataforma (y CSRF si la petición modifica datos). */
export async function requerirPlataforma(req: FastifyRequest): Promise<{ id: number; nombre: string; usuario: string }> {
  const u = await plataformaActual(req);
  if (!u) throw new ErrorHttp(401, 'no_autenticado', 'Inicia sesión para continuar.');
  if (req.method !== 'GET') verificarCsrf(req, await sesionPlataforma(req));
  return u;
}

/** Panel del dueño de Comandia (sesión aparte de la de las empresas). Cuelga de /api/plataforma. */
export async function rutasPlataforma(app: FastifyInstance): Promise<void> {
  await app.register(rutasPlataformaNegocios);
  await app.register(rutasPlataformaIntegraciones);

  app.get('/sesion', async (req) => {
    const ses = await sesionPlataforma(req);
    const u = await plataformaActual(req);
    return { ok: true, autenticado: u !== null, usuario: u ? { nombre: u.nombre } : null, csrf: csrfToken(ses) };
  });

  app.post('/login', async (req) => {
    const ses = await sesionPlataforma(req);
    verificarCsrf(req, ses);
    const d = cuerpoJson(req);
    const usuario = String(d['usuario'] ?? '').trim();
    const password = String(d['password'] ?? '');
    if (!usuario || !password || [...usuario].length > 40 || password.length > 200) {
      throw new ErrorHttp(400, 'validacion', 'Escribe tu usuario y contraseña.');
    }
    const ip = req.ip.slice(0, 45);
    await ejecutar('DELETE FROM intentos_login WHERE creado_en < (NOW() - INTERVAL 1 DAY)');
    const n = await fila('SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = 0 AND ip = ? AND creado_en > (NOW() - INTERVAL 10 MINUTE)', [ip]);
    if (Number(n?.['n']) >= 8) throw new ErrorHttp(429, 'bloqueado', 'Demasiados intentos. Espera 10 minutos e inténtalo de nuevo.');

    const f = await fila('SELECT id, nombre, password_hash FROM plataforma_admins WHERE usuario = ? AND activo = 1', [usuario]);
    const correcto = await bcrypt.compare(password, f ? String(f['password_hash']) : HASH_RELLENO);
    if (!f || !correcto) {
      await ejecutar('INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (0, ?, ?)', [ip, usuario]);
      await esperar(400);
      throw new ErrorHttp(401, 'credenciales', 'Usuario o contraseña incorrectos.');
    }
    await ejecutar('DELETE FROM intentos_login WHERE negocio_id = 0 AND ip = ?', [ip]);
    ses.regenerar();
    ses.poner('plat_id', Number(f['id']));
    return { ok: true, usuario: { nombre: String(f['nombre']) }, csrf: csrfToken(ses) };
  });

  app.post('/logout', async (req) => {
    const ses = await sesionPlataforma(req);
    verificarCsrf(req, ses);
    ses.destruir();
    return { ok: true };
  });
}
