/**
 * Conexión a MySQL (un "pool" de conexiones que se reutilizan) y funciones para consultar.
 *
 *   filas(sql, params)    → SELECT, todas las filas
 *   fila(sql, params)     → SELECT, una sola fila (o undefined)
 *   ejecutar(sql, params) → INSERT / UPDATE / DELETE
 *   transaccion(fn)       → varias consultas como una sola operación (todo o nada)
 *
 * IMPORTANTE: los valores SIEMPRE se pasan en `params` (los "?" del SQL), nunca pegados al texto de la consulta.
 * Eso evita la inyección de SQL. Las fechas llegan como texto ("2026-11-20 13:00:00"), igual que en la versión PHP.
 */
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

/** Ejecuta varias consultas como una sola operación: si algo falla, no se guarda nada. */
export interface Tx {
  ejecutar(sql: string, params?: unknown[]): Promise<ResultSetHeader>;
  filas<T extends Fila = Fila>(sql: string, params?: unknown[]): Promise<T[]>;
}

export async function transaccion<T>(trabajo: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await bd().getConnection();
  try {
    await c.beginTransaction();
    const r = await trabajo({
      ejecutar: async (sql, params = []) => (await c.execute<ResultSetHeader>(sql, params as never[]))[0],
      filas: async <T extends Fila = Fila>(sql: string, params: unknown[] = []) => (await c.execute<T[]>(sql, params as never[]))[0],
    });
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
