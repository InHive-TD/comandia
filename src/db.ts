import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';

/** Desfase UTC de la zona del negocio, en el formato que entiende MySQL ("-06:00"). */
function desfaseMysql(zona: string): string {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: zona, timeZoneName: 'longOffset' }).formatToParts(new Date());
  const nombre = partes.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-]\d{2}:\d{2})/.exec(nombre);
  return m?.[1] ?? '+00:00';
}

let pool: Pool | null = null;

export function bd(): Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    ...config.db,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true,        // fechas como texto "2026-11-20 13:00:00", igual que en la versión PHP
    namedPlaceholders: false,
  });
  // Misma zona horaria del negocio en cada conexión (define cuándo cambia el "día" de los turnos).
  // México no tiene horario de verano; si algún día hiciera falta, bastaría recrear las conexiones.
  pool.pool.on('connection', (c: PoolConnection) => {
    c.query(`SET time_zone = '${desfaseMysql(config.zonaHoraria)}'`);
  });
  return pool;
}

export type Fila = RowDataPacket;

/** SELECT: devuelve todas las filas. */
export async function filas<T extends Fila = Fila>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await bd().execute<T[]>(sql, params as never[]);
  return r;
}

/** SELECT que espera como mucho una fila. */
export async function fila<T extends Fila = Fila>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await filas<T>(sql, params))[0];
}

/** INSERT / UPDATE / DELETE. */
export async function ejecutar(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await bd().execute<ResultSetHeader>(sql, params as never[]);
  return r;
}

export async function cerrarBd(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
