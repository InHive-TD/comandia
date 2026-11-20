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

export const config = {
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
  /** Duración de una sesión iniciada: 12 horas. */
  sesionSegundos: 12 * 60 * 60,
} as const;
