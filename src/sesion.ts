import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ejecutar, fila } from './db.js';

/**
 * Sesiones guardadas en MySQL (tabla "sesiones"): sobreviven a reinicios del servidor y no dependen de la memoria.
 * Cada empresa tiene su propia cookie (cmd_<slug>) que solo viaja dentro de su ruta /<slug>/; la plataforma tiene la suya.
 */

export interface ContextoSesion {
  /** Nombre de la cookie, p. ej. "cmd_lavale" o "cmd_plataforma". */
  cookie: string;
  /** Ruta de la cookie, p. ej. "/lavale/" o "/". */
  ruta: string;
}

export class Sesion {
  datos: Record<string, unknown> = {};
  destruida = false;

  constructor(
    public id: string,
    readonly contexto: ContextoSesion,
  ) {}

  obtener<T = unknown>(clave: string): T | undefined {
    return this.datos[clave] as T | undefined;
  }

  poner(clave: string, valor: unknown): void {
    this.datos[clave] = valor;
  }

  quitar(clave: string): void {
    delete this.datos[clave];
  }

  /** Nuevo identificador al iniciar sesión (evita la "fijación de sesión"); conserva los datos. */
  regenerar(): void {
    this.anterior = this.id;
    this.id = nuevoId();
  }
  anterior: string | null = null;

  destruir(): void {
    this.destruida = true;
    this.datos = {};
  }
}

const nuevoId = (): string => randomBytes(32).toString('hex');
const FORMATO_ID = /^[a-f0-9]{64}$/;

const porPeticion = new WeakMap<FastifyRequest, Sesion>();

/** La sesión de esta petición (la crea si no hay). */
export async function sesionDe(req: FastifyRequest, contexto: ContextoSesion): Promise<Sesion> {
  const existente = porPeticion.get(req);
  if (existente) return existente;

  let sesion: Sesion | null = null;
  const enviado = req.cookies[contexto.cookie];
  if (enviado && FORMATO_ID.test(enviado)) {
    const f = await fila('SELECT datos FROM sesiones WHERE id = ? AND contexto = ? AND expira_en > NOW()', [enviado, contexto.cookie]);
    if (f) {
      sesion = new Sesion(enviado, contexto);
      const crudo = f['datos'];
      const d: unknown = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
      sesion.datos = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
    }
  }
  // Modo estricto: un identificador desconocido se descarta y se crea uno nuevo.
  sesion ??= new Sesion(nuevoId(), contexto);
  porPeticion.set(req, sesion);
  return sesion;
}

/** Guarda la sesión y manda la cookie. Se llama desde el hook onSend. */
export async function persistirSesion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sesion = porPeticion.get(req);
  if (!sesion) return;
  const { cookie, ruta } = sesion.contexto;
  const opciones = { path: ruta, httpOnly: true, sameSite: 'lax' as const, secure: req.protocol === 'https' };

  if (sesion.anterior) await ejecutar('DELETE FROM sesiones WHERE id = ?', [sesion.anterior]);
  if (sesion.destruida) {
    await ejecutar('DELETE FROM sesiones WHERE id = ?', [sesion.id]);
    reply.clearCookie(cookie, opciones);
    return;
  }
  await ejecutar(
    `INSERT INTO sesiones (id, contexto, datos, expira_en) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
     ON DUPLICATE KEY UPDATE datos = VALUES(datos), expira_en = VALUES(expira_en)`,
    [sesion.id, cookie, JSON.stringify(sesion.datos), config.sesionSegundos],
  );
  reply.setCookie(cookie, sesion.id, { ...opciones, maxAge: config.sesionSegundos });
  if (Math.random() < 0.02) await ejecutar('DELETE FROM sesiones WHERE expira_en < NOW()');
}
