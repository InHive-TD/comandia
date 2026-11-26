/** Configuración leída del entorno (archivo .env). Falla pronto si algo no tiene sentido. */

function texto(nombre: string, porDefecto: string): string {
  const v = process.env[nombre];
  return v === undefined || v === '' ? porDefecto : v;
}

function entero(nombre: string, porDefecto: number): number {
  const n = Number(texto(nombre, String(porDefecto)));
  if (!Number.isInteger(n) || n < 0) throw new Error(`La variable ${nombre} debe ser un número entero.`);
  return n;
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const config = {
  /** Carpeta donde se guardan las fotos (uploads/<id de la empresa>/p_xxx.jpg). */
  carpetaFotos: resolve(texto('UPLOADS_DIR', fileURLToPath(new URL('../uploads', import.meta.url)))),
  puerto: entero('PORT', 3000),
  host: texto('HOST', '127.0.0.1'),
  confiarProxy: texto('CONFIAR_PROXY', 'false') === 'true',
  zonaHoraria: texto('ZONA_HORARIA', 'America/Mexico_City'),
  db: {
    host: texto('DB_HOST', '127.0.0.1'),
    port: entero('DB_PORT', 3306),
    database: texto('DB_NAME', 'comandia'),
    user: texto('DB_USER', 'root'),
    password: texto('DB_PASSWORD', ''),
  },
  /** Correo saliente (SMTP). Si falta SMTP_HOST el sistema funciona igual, pero no puede enviar invitaciones. */
  smtp: {
    host: texto('SMTP_HOST', '').trim(),
    port: Number.parseInt(texto('SMTP_PORT', '465').trim(), 10) || 465,   // permisivo: un valor mal escrito no debe impedir que el servidor arranque
    usuario: texto('SMTP_USER', '').trim(),
    password: texto('SMTP_PASS', ''),
  },
  /** Dirección pública del sistema, sin "/" al final (para los enlaces de los correos). */
  urlPublica: texto('APP_URL', '').trim().replace(/\/+$/, ''),
  /** Dirección del panel de plataforma (solo el dueño de Comandia): /<ruta>/. Por defecto /plataforma/; se puede cambiar con PLATAFORMA_RUTA. */
  rutaPlataforma: texto('PLATAFORMA_RUTA', 'plataforma').trim().toLowerCase(),
  /** Duración de una sesión iniciada: 12 horas. */
  sesionSegundos: 12 * 60 * 60,
} as const;
