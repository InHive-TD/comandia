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
  // Precio propio de un extra en un platillo concreto (NULL = precio general del extra)
  await asegurarColumna('producto_extras', 'precio', 'DECIMAL(10,2) NULL');
  await asegurarColumna('pagos', 'comision', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
  // Platillos con opción obligatoria (ej. el burrito: hay que elegir de qué). grupo_obligatorio: NULL = cualquier opción; con nombre = una de esa sección.
  await asegurarColumna('productos', 'opciones_obligatorias', 'TINYINT(1) NOT NULL DEFAULT 0');
  await asegurarColumna('productos', 'grupo_obligatorio', 'VARCHAR(40) NULL');
  // Foto de perfil de cada usuario (nombre del archivo en uploads, igual que las fotos de platillos)
  await asegurarColumna('usuarios', 'foto', 'VARCHAR(80) NULL');
  // Plano de mesas: zonas de una sucursal (Piso 1, Patio…) y la posición de cada mesa dentro de su zona (en % del lienzo)
  await ejecutar(`CREATE TABLE IF NOT EXISTS zonas (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    nombre VARCHAR(40) NOT NULL,
    orden INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_zona (sucursal_id, nombre)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await asegurarColumna('mesas', 'zona_id', 'INT UNSIGNED NULL');
  await asegurarColumna('mesas', 'pos_x', 'DECIMAL(5,2) NULL');
  await asegurarColumna('mesas', 'pos_y', 'DECIMAL(5,2) NULL');
  await asegurarColumna('mesas', 'forma', "VARCHAR(12) NOT NULL DEFAULT 'cuadrada'");
  await asegurarColumna('mesas', 'escala', 'DECIMAL(3,2) NOT NULL DEFAULT 1.00');   // tamaño de la mesa en el plano (0.5 a 2.5)
  await asegurarColumna('zonas', 'poligono', 'TEXT NULL');   // forma irregular de la zona: JSON [[x,y],…] en % del lienzo (NULL = rectángulo)
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
  // Secciones (grupos) de extras: "Quitar", "Aparte", "Solo"... El dueño las crea, renombra, ordena y elimina.
  // extras.grupo guarda el NOMBRE de la sección; esta tabla guarda cuáles existen y en qué orden (incluso vacías).
  await ejecutar(`CREATE TABLE IF NOT EXISTS extra_grupos (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    nombre     VARCHAR(40) NOT NULL,
    orden      INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_extra_grupo (negocio_id, nombre)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Sucursales ADICIONALES de un usuario (además de usuarios.sucursal_id, que es la principal). Sin filas = una sola sucursal.
  await ejecutar(`CREATE TABLE IF NOT EXISTS usuario_sucursales (
    usuario_id  INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    negocio_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (usuario_id, sucursal_id),
    INDEX idx_us_sucursal (sucursal_id),
    CONSTRAINT fk_us_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_us_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}
