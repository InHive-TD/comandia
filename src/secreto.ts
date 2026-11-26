/**
 * Cifrado de secretos guardados en la base de datos (por ejemplo, la llave de OpenRouter).
 * AES-256-GCM. La clave de cifrado sale de la variable APP_SECRET; si no existe, se genera sola una vez y se guarda en
 * <carpeta de uploads>/_privado/secreto (el volumen de fotos NO entra en los respaldos de la base, y esa carpeta nunca se sirve por la web).
 * Así un respaldo de la base por sí solo no revela la llave.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

let claveCache: Buffer | null = null;

async function clave(): Promise<Buffer> {
  if (claveCache) return claveCache;
  const env = (process.env['APP_SECRET'] ?? '').trim();
  let base = env;
  if (!base) {
    const carpeta = join(config.carpetaFotos, '_privado');
    const archivo = join(carpeta, 'secreto');
    try {
      base = (await readFile(archivo, 'utf8')).trim();
    } catch {
      base = randomBytes(32).toString('hex');
      await mkdir(carpeta, { recursive: true });
      await writeFile(archivo, base, { mode: 0o600 });
      await chmod(archivo, 0o600).catch(() => undefined);
    }
  }
  claveCache = createHash('sha256').update(`comandia-secreto-v1:${base}`).digest();
  return claveCache;
}

/** "v1:<iv>:<etiqueta>:<texto cifrado>" en base64. */
export async function cifrar(texto: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await clave(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

export async function descifrar(valor: string): Promise<string> {
  const [v, iv, tag, datos] = valor.split(':');
  if (v !== 'v1' || !iv || !tag || !datos) throw new Error('Formato de secreto desconocido.');
  const d = createDecipheriv('aes-256-gcm', await clave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
}
