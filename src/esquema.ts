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
  await ejecutar(`CREATE TABLE IF NOT EXISTS sesiones (
    id CHAR(64) NOT NULL PRIMARY KEY,
    contexto VARCHAR(60) NOT NULL,
    datos JSON NOT NULL,
    expira_en DATETIME NOT NULL,
    INDEX idx_sesiones_expira (expira_en)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
