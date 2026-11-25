/**
 * Preparación de la base de datos al arrancar. No crea el esquema completo (eso lo hace database/schema.sql):
 * solo comprueba que exista y agrega lo que la versión TypeScript necesita (tabla de sesiones y dos columnas
 * que la versión PHP creaba sola). Es seguro correrlo muchas veces.
 */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { bd, ejecutar, fila } from './db.js';

/** Corre cambios de esquema en una conexión que espera pocos segundos por candados; si falla, avisa y sigue (no tumba el servidor). */
async function esquemaSuave(paso: (c: PoolConnection) => Promise<void>): Promise<void> {
  const c = await bd().getConnection();
  try {
    await c.query('SET SESSION lock_wait_timeout = 8');
    await paso(c);
  } catch (e) {
    console.warn('Cambio de esquema omitido (se reintentará al reiniciar):', (e as Error).message);
  } finally {
    c.release();
  }
}

/**
 * Tablas propias de la versión TypeScript. Se crean solas (es idempotente).
 * Las demás tablas vienen de database/schema.sql (o de una base que ya usó la versión PHP).
 */
/**
 * Un ALTER que quedó a medias de un arranque anterior (o consultas esperando su candado) deja la tabla bloqueada
 * y toda la app se cuelga, incluso al leer information_schema. Se cancelan los de esta misma base y usuario ANTES de todo.
 */
async function liberarCandados(): Promise<void> {
  try {
    const c = await bd().getConnection();
    try {
      const [lista] = await c.query<RowDataPacket[]>('SHOW FULL PROCESSLIST');
      const [yo] = await c.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id, DATABASE() AS bd');
      const miId = Number(yo[0]?.['id']);
      const miBd = String(yo[0]?.['bd']);
      for (const p of lista) {
        const id = Number(p['Id']);
        if (id === miId || String(p['db']) !== miBd) continue;
        const info = String(p['Info'] ?? '');
        const estado = String(p['State'] ?? '');
        if (/^\s*ALTER TABLE/i.test(info) || /metadata lock/i.test(estado)) {
          console.warn(`Cancelando proceso colgado ${id}: ${estado} ${info.slice(0, 80)}`);
          try { await c.query(`KILL ${id}`); } catch { /* ya terminó */ }
        }
      }
    } finally {
      c.release();
    }
  } catch (e) {
    console.warn('No se pudo revisar procesos colgados:', (e as Error).message);
  }
}

export async function asegurarEsquema(): Promise<void> {
  await liberarCandados();
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
  // Acceso con correo: el admin invita, la persona confirma el correo y crea su propia contraseña.
  // Estos pasos no esperan candados: si la base está ocupada, avisan y el servidor arranca igual (se reintentan al siguiente arranque).
  await esquemaSuave(async (c) => {
    const hay = async (sql: string, p: unknown[]): Promise<boolean> => Number(((await c.query<RowDataPacket[]>(sql, p))[0][0] as RowDataPacket)['n']) > 0;
    const col = `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = ?`;
    if (!(await hay(col, ['correo']))) await c.query('ALTER TABLE usuarios ADD COLUMN correo VARCHAR(150) NULL');
    if (!(await hay(col, ['clave_pendiente']))) await c.query('ALTER TABLE usuarios ADD COLUMN clave_pendiente TINYINT(1) NOT NULL DEFAULT 0');
    if (!(await hay(col, ['fallos_login']))) {
      await c.query('ALTER TABLE usuarios ADD COLUMN fallos_login TINYINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN nivel_bloqueo TINYINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN bloqueo_hasta DATETIME NULL, ADD COLUMN bloqueado TINYINT(1) NOT NULL DEFAULT 0');
    }
    if (!(await hay(`SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND INDEX_NAME = 'uq_usuario_correo'`, []))) {
      await c.query('ALTER TABLE usuarios ADD UNIQUE KEY uq_usuario_correo (negocio_id, correo)');
    }
    await c.query(`CREATE TABLE IF NOT EXISTS tokens_usuario (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      negocio_id INT UNSIGNED NOT NULL,
      usuario_id INT UNSIGNED NOT NULL,
      tipo ENUM('invitacion','restablecer') NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expira_en DATETIME NOT NULL,
      usado_en DATETIME NULL,
      creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_token (token_hash),
      INDEX idx_token_usuario (usuario_id)
    ) ENGINE=InnoDB`);
  });
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
  // El nombre de una mesa es único POR ZONA (puede haber «9» en el Patio y «9» en el Piso 1); sin zona, único entre las no ubicadas.
  try {
    await asegurarColumna('mesas', 'zona_clave', 'INT UNSIGNED AS (COALESCE(zona_id, 0)) STORED');
    const idx = async (nombre: string) => Number((await fila('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', ['mesas', nombre]))?.['n']) > 0;
    if (!(await idx('uq_mesa_zona'))) await ejecutar('ALTER TABLE mesas ADD UNIQUE KEY uq_mesa_zona (sucursal_id, zona_clave, nombre)');
    if (await idx('uq_mesa')) await ejecutar('ALTER TABLE mesas DROP INDEX uq_mesa');
  } catch (e) {
    console.error('No se pudo pasar el nombre único de mesa a «por zona»:', e);
  }
  await asegurarColumna('ordenes', 'mesa_zona', 'VARCHAR(40) NULL');   // zona de la mesa (Piso 1, Patio…) al levantar el pedido
  await asegurarColumna('mesas', 'ancho_cm', 'SMALLINT UNSIGNED NULL');   // medidas reales de la mesa (cm); NULL = las de su forma
  await asegurarColumna('mesas', 'alto_cm', 'SMALLINT UNSIGNED NULL');
  await asegurarColumna('zonas', 'ancho_m', 'DECIMAL(5,1) NOT NULL DEFAULT 10.0');   // ancho real del espacio que muestra el plano (m)
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
