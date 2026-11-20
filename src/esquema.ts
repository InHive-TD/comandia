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
  // La base debe ser multiempresa (con negocio_id). Una base de un solo negocio primero se migra (Fase 5).
  if ((await tipoColumna('usuarios', 'negocio_id')) === null) {
    throw new Error('Esta base de datos es de un solo negocio (sin negocio_id). Hay que migrarla a multiempresa antes de usarla.');
  }
  await actualizarV2();
  await asegurarColumna('sucursales', 'slug', 'VARCHAR(60) NULL');
  await asegurarColumna('orden_items', 'llevar', 'TINYINT(1) NOT NULL DEFAULT 0');
  await asegurarColumna('ordenes', 'pago_previsto', 'VARCHAR(15) NULL');
  await asegurarColumna('pagos', 'comision', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
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

/** Tipo de una columna ("enum('a','b')", "int unsigned"…) o null si no existe. */
async function tipoColumna(tabla: string, columna: string): Promise<string | null> {
  const f = await fila(
    'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tabla, columna],
  );
  return f ? String(f['t']) : null;
}

/**
 * Versión 2 del esquema (igual que `api/esquema.php` de la versión PHP): gerente de sucursal y carta por sucursal.
 * Las bases creadas antes de esto no tienen el rol "gerente", productos.sucursal_id ni la tabla producto_sucursal.
 * Es seguro repetirlo: cada paso solo actúa si falta.
 */
async function actualizarV2(): Promise<void> {
  const rol = await tipoColumna('usuarios', 'rol');
  if (rol !== null && !rol.includes("'gerente'")) {
    await ejecutar("ALTER TABLE usuarios MODIFY rol ENUM('taquero','caja','admin','mesero','gerente') NOT NULL DEFAULT 'taquero'");
  }
  if ((await tipoColumna('productos', 'sucursal_id')) === null) {
    await ejecutar('ALTER TABLE productos ADD COLUMN sucursal_id INT UNSIGNED NULL, ADD INDEX idx_producto_sucursal (sucursal_id)');
  }
  await ejecutar(`CREATE TABLE IF NOT EXISTS producto_sucursal (
    producto_id   INT UNSIGNED NOT NULL,
    sucursal_id   INT UNSIGNED NOT NULL,
    negocio_id    INT UNSIGNED NOT NULL,
    oculto        TINYINT(1) NOT NULL DEFAULT 0,
    precio        DECIMAL(10,2) NULL,
    agotado_fecha DATE NULL,
    PRIMARY KEY (producto_id, sucursal_id),
    INDEX idx_ps_sucursal (sucursal_id),
    CONSTRAINT fk_ps_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE,
    CONSTRAINT fk_ps_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}
