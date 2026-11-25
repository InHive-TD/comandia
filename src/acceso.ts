/**
 * Acceso por correo: enlaces de un solo uso para crear o restablecer la contraseña.
 * Del enlace solo se guarda su hash (SHA-256): si alguien viera la base de datos no podría usarlos.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { cuerpoJson } from './auth.js';
import { config } from './config.js';
import { enviarInvitacion, correoListo } from './correo.js';
import { ejecutar, fila } from './db.js';
import { ErrorHttp, fallo } from './errores.js';
import { largo } from './util.js';

export const HORAS_ENLACE = 48;
export const CORREO_VALIDO = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export const rutaInicioDeRol = (rol: string): string => (rol === 'admin' || rol === 'gerente' ? 'admin/' : rol === 'caja' ? 'caja/' : rol === 'taquero' ? 'cocina/' : 'pedidos/');

export function exigirCorreoListo(): void {
  if (!correoListo()) throw new ErrorHttp(503, 'correo', 'El envío de correos aún no está configurado en el servidor. Avisa a quien administra Comandia.');
}

/** Crea el enlace (invalida los anteriores del mismo usuario) y manda el correo. */
export async function mandarEnlace(negocio: { id: number; slug: string; nombre: string }, usuarioId: number, tipo: 'invitacion' | 'restablecer'): Promise<void> {
  const u = await fila('SELECT nombre, correo, rol FROM usuarios WHERE id = ? AND negocio_id = ?', [usuarioId, negocio.id]);
  if (!u || !u['correo']) throw fallo('Esta persona no tiene correo registrado.');
  const token = randomBytes(32).toString('hex');
  await ejecutar('UPDATE tokens_usuario SET usado_en = NOW() WHERE usuario_id = ? AND usado_en IS NULL', [usuarioId]);
  await ejecutar('INSERT INTO tokens_usuario (negocio_id, usuario_id, tipo, token_hash, expira_en) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))', [negocio.id, usuarioId, tipo, hash(token), HORAS_ENLACE]);
  try {
    await enviarInvitacion({
      para: String(u['correo']), nombre: String(u['nombre']), rol: String(u['rol']), negocio, tipo, horas: HORAS_ENLACE,
      enlace: `${config.urlPublica}/${negocio.slug}/acceso/?t=${token}`,
    });
  } catch (e) {
    console.error('No se pudo enviar el correo:', (e as Error).message);
    throw new ErrorHttp(502, 'correo', 'No se pudo enviar el correo. Revisa que la dirección sea correcta y vuelve a intentarlo con «Reenviar».');
  }
}

async function buscar(negocioId: number, t: string) {
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  return fila(
    `SELECT k.id AS token_id, k.tipo, u.id AS usuario_id, u.nombre, u.rol, u.correo
       FROM tokens_usuario k JOIN usuarios u ON u.id = k.usuario_id
      WHERE k.negocio_id = ? AND k.token_hash = ? AND k.usado_en IS NULL AND k.expira_en > NOW() AND u.activo = 1`,
    [negocioId, hash(t)],
  );
}

export async function rutasAcceso(app: FastifyInstance): Promise<void> {
  /** Anti adivinanza: 20 enlaces inválidos por conexión cada 10 minutos. */
  async function limitar(negocioId: number, ip: string): Promise<void> {
    const n = await fila("SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND ip = ? AND usuario = '@enlace' AND creado_en > (NOW() - INTERVAL 10 MINUTE)", [negocioId, ip]);
    if (Number(n?.['n']) >= 20) throw new ErrorHttp(429, 'bloqueado', 'Demasiados intentos. Espera 10 minutos.');
  }
  const invalido = (): ErrorHttp => new ErrorHttp(410, 'enlace', 'Este enlace ya no es válido: venció o ya se usó. Pide al administrador que te envíe uno nuevo.');

  app.get('/acceso/enlace', async (req) => {
    const ip = req.ip.slice(0, 45);
    await limitar(req.negocio.id, ip);
    const f = await buscar(req.negocio.id, String((req.query as Record<string, unknown>)['t'] ?? ''));
    if (!f) {
      await ejecutar("INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, '@enlace')", [req.negocio.id, ip]);
      throw invalido();
    }
    return { ok: true, nombre: f['nombre'], tipo: f['tipo'], negocio: req.negocio.nombre };
  });

  /** «Olvidé mi contraseña»: siempre responde lo mismo exista o no la cuenta, para no revelar quién tiene acceso. */
  app.post('/acceso/olvide', async (req) => {
    const ip = req.ip.slice(0, 45);
    const n = await fila("SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND ip = ? AND usuario = '@olvido' AND creado_en > (NOW() - INTERVAL 10 MINUTE)", [req.negocio.id, ip]);
    if (Number(n?.['n']) >= 5) throw new ErrorHttp(429, 'bloqueado', 'Demasiados intentos. Espera 10 minutos.');
    await ejecutar("INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, '@olvido')", [req.negocio.id, ip]);
    const correo = String(cuerpoJson(req)['correo'] ?? '').trim().toLowerCase();
    if (!CORREO_VALIDO.test(correo)) throw fallo('Escribe un correo válido.');
    const respuesta = { ok: true, mensaje: `Si ese correo tiene acceso a ${req.negocio.nombre}, te enviamos un enlace para crear una contraseña nueva. Revisa tu bandeja (y la carpeta de spam).` };
    if (!correoListo()) return respuesta;
    const u = await fila('SELECT id, clave_pendiente FROM usuarios WHERE negocio_id = ? AND correo = ? AND activo = 1', [req.negocio.id, correo]);
    if (!u) return respuesta;
    // Un correo cada 2 minutos por persona: evita que alguien llene la bandeja de otro.
    const reciente = await fila("SELECT id FROM tokens_usuario WHERE usuario_id = ? AND creado_en > (NOW() - INTERVAL 2 MINUTE) LIMIT 1", [Number(u['id'])]);
    if (reciente) return respuesta;
    try {
      await mandarEnlace(req.negocio, Number(u['id']), Number(u['clave_pendiente']) === 1 ? 'invitacion' : 'restablecer');
    } catch (e) {
      console.error('Olvidé mi contraseña: no se pudo enviar:', (e as Error).message);
    }
    return respuesta;
  });

  app.post('/acceso/clave', async (req) => {
    const ip = req.ip.slice(0, 45);
    await limitar(req.negocio.id, ip);
    const d = cuerpoJson(req);
    const password = String(d['password'] ?? '');
    const f = await buscar(req.negocio.id, String(d['t'] ?? ''));
    if (!f) {
      await ejecutar("INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, '@enlace')", [req.negocio.id, ip]);
      throw invalido();
    }
    if (largo(password) < 10) throw fallo('La contraseña debe tener al menos 10 caracteres.');
    if (largo(password) > 200) throw fallo('La contraseña es demasiado larga.');
    await ejecutar('UPDATE usuarios SET password_hash = ?, clave_pendiente = 0 WHERE id = ? AND negocio_id = ?', [await bcrypt.hash(password, 10), Number(f['usuario_id']), req.negocio.id]);
    await ejecutar('UPDATE tokens_usuario SET usado_en = NOW() WHERE usuario_id = ? AND usado_en IS NULL', [Number(f['usuario_id'])]);
    return { ok: true, correo: f['correo'], destino: rutaInicioDeRol(String(f['rol'])) };
  });
}
