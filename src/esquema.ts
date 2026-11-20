/**
 * Preparación de la base de datos al arrancar. No crea el esquema completo (eso lo hace database/schema.sql):
 * solo comprueba que exista y agrega lo que la versión TypeScript necesita (tabla de sesiones y dos columnas
 * que la versión PHP creaba sola). Es seguro correrlo muchas veces.
 */
import { ejecutar, fila } from './db.js';

/**
 * Tablas propias de la versión TypeScript. Se crean solas (es idempotente).
 * Las demás tablas vienen de database/schema.sql (o de una base que ya usó la versión PHP).
 */
export async function asegurarEsquema(): Promise<void> {
  const base = await fila(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'negocios'`);
  if (!base || Number(base['n']) === 0) {
    throw new Error('La base de datos no tiene las tablas de Comandia. Importa database/schema.sql primero.');
  }
  await asegurarColumna('orden_items', 'llevar', 'TINYINT(1) NOT NULL DEFAULT 0');
  await asegurarColumna('ordenes', 'pago_previsto', 'VARCHAR(15) NULL');
  await ejecutar(`CREATE TABLE IF NOT EXISTS sesiones (
    id CHAR(64) NOT NULL PRIMARY KEY,
    contexto VARCHAR(60) NOT NULL,
    datos JSON NOT NULL,
    expira_en DATETIME NOT NULL,
    INDEX idx_sesiones_expira (expira_en)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

/** Agrega una columna si falta (bases creadas con una versión anterior de schema.sql). */
async function asegurarColumna(tabla: string, columna: string, definicion: string): Promise<void> {
  const f = await fila(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tabla, columna],
  );
  if (Number(f?.['n']) === 0) await ejecutar(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
