/**
 * Convierte una base de datos de la versión de UN solo negocio (taqueria-app) a Comandia (multiempresa).
 * Todo lo que ya existe pasa a ser el primer negocio (con su sucursal "Principal").
 * Equivale a `api/migracion.php` de la versión PHP. Se puede ejecutar más de una vez: si ya está migrada, no hace nada.
 *
 * Se usa desde la herramienta de línea de comandos:  npm run migrar -- <direccion> "<Nombre del negocio>"
 * (HAZ UNA COPIA DE SEGURIDAD de la base antes: los cambios de estructura de MySQL no se pueden deshacer.)
 */
import { bd, fila } from './db.js';
import { slugValido } from './negocio.js';

/** Ejecuta una sentencia de estructura (CREATE/ALTER). Se usa `query` porque son sentencias sin parámetros. */
const ddl = async (sql: string): Promise<void> => {
  await bd().query(sql);
};
const dato = async (sql: string, params: unknown[] = []): Promise<number> => Number((await fila(sql, params))?.['n'] ?? 0);

const existeColumna = async (t: string, c: string): Promise<boolean> =>
  (await dato('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c])) > 0;
const existeTabla = async (t: string): Promise<boolean> =>
  (await dato('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t])) > 0;
const existeIndice = async (t: string, i: string): Promise<boolean> =>
  (await dato('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i])) > 0;

/** Nombres de los índices ÚNICOS que contienen SOLO la columna indicada. */
async function unicosDe(tabla: string, columna: string): Promise<string[]> {
  const [r] = await bd().query(
    `SELECT INDEX_NAME AS i FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
      GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = ?`,
    [tabla, columna],
  );
  return (r as { i: string }[]).map((x) => x.i);
}

async function agregarColumna(tabla: string, columna: string, definicion: string, log: string[]): Promise<void> {
  if (!(await existeColumna(tabla, columna))) {
    await ddl(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
    log.push(`Columna ${tabla}.${columna} agregada`);
  }
}

/** Migra la base conectada. Devuelve el registro de lo que hizo. Lanza un Error con un mensaje claro si no se puede. */
export async function migrarAMultinegocio(slug: string, nombre: string): Promise<string[]> {
  const log: string[] = [];

  if (await existeColumna('usuarios', 'negocio_id')) return ['La base ya está en formato multiempresa. No se cambió nada.'];
  if (!(await existeTabla('usuarios')) || !(await existeTabla('ordenes'))) {
    throw new Error('No parece una base de datos de la taquería. Importa primero database/schema.sql (instalación nueva) o la base anterior.');
  }
  if (!slugValido(slug)) throw new Error('La dirección debe ser de 2 a 39 caracteres (letras minúsculas, números, guiones) y no estar reservada.');
  if (nombre.trim() === '' || [...nombre].length > 100) throw new Error('Escribe el nombre del negocio (máximo 100 caracteres).');

  // 0) Columnas de versiones anteriores (por si faltaban)
  await agregarColumna('productos', 'orden', 'INT NOT NULL DEFAULT 0', log);
  await agregarColumna('orden_items', 'llevar', 'TINYINT(1) NOT NULL DEFAULT 0', log);
  await agregarColumna('ordenes', 'pago_previsto', 'VARCHAR(15) NULL', log);
  await agregarColumna('pagos', 'comision', 'DECIMAL(10,2) NOT NULL DEFAULT 0', log);

  // 1) Tablas nuevas
  await ddl(`CREATE TABLE IF NOT EXISTS negocios (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(40) NOT NULL, nombre VARCHAR(100) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1, plan VARCHAR(30) NOT NULL DEFAULT 'basico', vence_en DATE NULL,
    contacto VARCHAR(150) NULL, notas VARCHAR(255) NULL, creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_negocio_slug (slug)) ENGINE=InnoDB`);
  await ddl(`CREATE TABLE IF NOT EXISTS plataforma_admins (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(80) NOT NULL, usuario VARCHAR(40) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, activo TINYINT(1) NOT NULL DEFAULT 1,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
  await ddl(`CREATE TABLE IF NOT EXISTS sucursales (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, negocio_id INT UNSIGNED NOT NULL, nombre VARCHAR(80) NOT NULL,
    direccion VARCHAR(200) NULL, activa TINYINT(1) NOT NULL DEFAULT 1, orden INT NOT NULL DEFAULT 0,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_sucursal_negocio (negocio_id)) ENGINE=InnoDB`);
  await ddl(`CREATE TABLE IF NOT EXISTS mesas (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, negocio_id INT UNSIGNED NOT NULL, sucursal_id INT UNSIGNED NOT NULL,
    nombre VARCHAR(30) NOT NULL, orden INT NOT NULL DEFAULT 0, activa TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_mesa (sucursal_id, nombre)) ENGINE=InnoDB`);

  // 2) El primer negocio y su sucursal
  const [n] = await bd().execute('INSERT INTO negocios (slug, nombre) VALUES (?, ?)', [slug, nombre.trim()]);
  const nid = (n as { insertId: number }).insertId;
  const [s] = await bd().execute('INSERT INTO sucursales (negocio_id, nombre, orden) VALUES (?, ?, 1)', [nid, 'Principal']);
  const sid = (s as { insertId: number }).insertId;
  log.push(`Negocio “${nombre.trim()}” creado (dirección: /${slug}/, id ${nid}) con su sucursal Principal (id ${sid})`);

  // 3) negocio_id (y sucursal_id donde toca) en las tablas existentes; todo lo anterior pasa al primer negocio
  for (const t of ['usuarios', 'categorias', 'estaciones', 'productos', 'extras', 'ordenes', 'contactos', 'intentos_pedido', 'intentos_login', 'pagos', 'tiempos_pedido']) {
    if (!(await existeTabla(t))) continue;
    await ddl(`ALTER TABLE \`${t}\` ADD COLUMN negocio_id INT UNSIGNED NOT NULL DEFAULT 0`);
    await bd().execute(`UPDATE \`${t}\` SET negocio_id = ?`, [nid]);
  }
  for (const t of ['ordenes', 'pagos', 'tiempos_pedido', 'intentos_pedido']) {
    if (!(await existeTabla(t))) continue;
    await ddl(`ALTER TABLE \`${t}\` ADD COLUMN sucursal_id INT UNSIGNED NOT NULL DEFAULT 0`);
    await bd().execute(`UPDATE \`${t}\` SET sucursal_id = ?`, [sid]);
  }
  await ddl('ALTER TABLE ordenes ADD COLUMN mesa_id INT UNSIGNED NULL');
  await ddl('ALTER TABLE ordenes ADD COLUMN mesa VARCHAR(30) NULL');
  await ddl('ALTER TABLE usuarios ADD COLUMN sucursal_id INT UNSIGNED NULL');
  await ddl("ALTER TABLE usuarios MODIFY rol ENUM('taquero','caja','admin','mesero','gerente') NOT NULL DEFAULT 'taquero'");
  await bd().execute("UPDATE usuarios SET sucursal_id = ? WHERE rol <> 'admin'", [sid]);

  // 4) Ajustes: la clave pasa a ser (negocio, clave)
  if (!(await existeColumna('ajustes', 'negocio_id'))) {
    await ddl('ALTER TABLE ajustes DROP PRIMARY KEY');
    await ddl('ALTER TABLE ajustes ADD COLUMN negocio_id INT UNSIGNED NOT NULL DEFAULT 0 FIRST');
    await bd().execute('UPDATE ajustes SET negocio_id = ?', [nid]);
    await ddl('ALTER TABLE ajustes ADD PRIMARY KEY (negocio_id, clave)');
  }

  // 5) Únicos que ahora son POR NEGOCIO (o por sucursal)
  for (const ix of await unicosDe('usuarios', 'usuario')) await ddl(`ALTER TABLE usuarios DROP INDEX \`${ix}\``);
  await ddl('ALTER TABLE usuarios ADD UNIQUE KEY uq_usuario_negocio (negocio_id, usuario)');
  for (const ix of await unicosDe('productos', 'codigo')) await ddl(`ALTER TABLE productos DROP INDEX \`${ix}\``);
  await ddl('ALTER TABLE productos ADD UNIQUE KEY uq_producto_codigo (negocio_id, codigo)');
  for (const ix of await unicosDe('extras', 'codigo')) await ddl(`ALTER TABLE extras DROP INDEX \`${ix}\``);
  await ddl('ALTER TABLE extras ADD UNIQUE KEY uq_extra_codigo (negocio_id, codigo)');
  if (await existeIndice('ordenes', 'uq_turno')) await ddl('ALTER TABLE ordenes DROP INDEX uq_turno');
  await ddl('ALTER TABLE ordenes ADD UNIQUE KEY uq_turno (sucursal_id, fecha_turno, turno)');
  if (await existeIndice('ordenes', 'idx_estado_fecha')) await ddl('ALTER TABLE ordenes DROP INDEX idx_estado_fecha');
  await ddl('ALTER TABLE ordenes ADD INDEX idx_estado_fecha (negocio_id, sucursal_id, estado, creado_en)');
  if (await existeIndice('contactos', 'uq_contacto_tel')) await ddl('ALTER TABLE contactos DROP INDEX uq_contacto_tel');
  await ddl('ALTER TABLE contactos ADD UNIQUE KEY uq_contacto_tel (negocio_id, telefono)');

  log.push(`Todos los datos anteriores (menú, usuarios, pedidos, pagos…) ahora pertenecen al negocio “${nombre.trim()}”`);
  return log;
}
