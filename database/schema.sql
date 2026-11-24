-- =====================================================================
--  COMANDIA · Base de datos (multi-negocio)
--  Cómo usarla: elige (o crea) la base en phpMyAdmin / HeidiSQL y ejecuta este archivo completo.
--  Es seguro volver a ejecutarla: no borra nada que ya exista.
--
--  MULTI-NEGOCIO: todos los negocios comparten estas tablas. Cada fila lleva su negocio_id
--  y el servidor SIEMPRE filtra por el negocio de la ruta (tudominio.mx/lavale/ -> negocio "lavale").
--  Los negocios se dan de alta desde el panel /plataforma/.
-- =====================================================================

-- ---------------------------------------------------------------------
-- NEGOCIOS: cada cliente de Comandia (una taquería, una fonda, un restaurante...).
--   slug: lo que va en la dirección (tudominio.mx/lavale/). Solo minúsculas, números y guiones.
--   activo: 0 = suscripción pausada (nadie entra); vence_en: fecha en que vence su suscripción.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS negocios (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug       VARCHAR(40)  NOT NULL,
    nombre     VARCHAR(100) NOT NULL,
    activo     TINYINT(1)   NOT NULL DEFAULT 1,
    plan       VARCHAR(30)  NOT NULL DEFAULT 'basico',
    vence_en   DATE NULL,
    contacto   VARCHAR(150) NULL,           -- nombre / teléfono / correo del dueño (para ti)
    notas      VARCHAR(255) NULL,
    creado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_negocio_slug (slug)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- SUCURSALES: cada empresa tiene una o varias. Cada sucursal lleva su propio registro
-- (turnos, pedidos, cocina, caja, mesas). El menú y los usuarios son de la empresa.
-- El administrador de la empresa ve los reportes de todas juntas o de una en una.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sucursales (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    nombre     VARCHAR(80)  NOT NULL,
    slug       VARCHAR(60)  NULL,           -- nombre corto para el QR (?s=centro); se asigna solo y no cambia al renombrar
    direccion  VARCHAR(200) NULL,
    activa     TINYINT(1)   NOT NULL DEFAULT 1,
    orden      INT NOT NULL DEFAULT 0,
    creado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sucursal_negocio (negocio_id),
    CONSTRAINT fk_sucursal_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- MESAS: las mesas de cada sucursal (el mesero elige a cuál llevar el pedido).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zonas (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id  INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    nombre      VARCHAR(40) NOT NULL,
    orden       INT NOT NULL DEFAULT 0,
    ancho_m     DECIMAL(5,1) NOT NULL DEFAULT 10.0, -- ancho real del espacio que muestra el plano (m)
    poligono    TEXT NULL,                        -- forma irregular: JSON [[x,y],…] en % del lienzo (NULL = rectángulo)
    UNIQUE KEY uq_zona (sucursal_id, nombre)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mesas (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id  INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    nombre      VARCHAR(30) NOT NULL,            -- "1", "2", "Terraza 3"...
    orden       INT NOT NULL DEFAULT 0,
    activa      TINYINT(1) NOT NULL DEFAULT 1,
    zona_id     INT UNSIGNED NULL,                -- zona del plano (Piso 1, Patio…); NULL = sin ubicar
    pos_x       DECIMAL(5,2) NULL,                -- posición en el plano, en % del lienzo
    pos_y       DECIMAL(5,2) NULL,
    forma       VARCHAR(12) NOT NULL DEFAULT 'cuadrada',
    escala      DECIMAL(3,2) NOT NULL DEFAULT 1.00,  -- (en desuso)
    ancho_cm    SMALLINT UNSIGNED NULL,           -- medidas reales en el plano; NULL = las de su forma
    alto_cm     SMALLINT UNSIGNED NULL,
    UNIQUE KEY uq_mesa (sucursal_id, nombre),
    CONSTRAINT fk_mesa_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PLATAFORMA_ADMINS: quienes administran Comandia (tú). Entran en /plataforma/.
-- No tienen relación con los usuarios de cada negocio.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plataforma_admins (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    nombre         VARCHAR(80)  NOT NULL,
    usuario        VARCHAR(40)  NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    activo         TINYINT(1)   NOT NULL DEFAULT 1,
    creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- USUARIOS: quienes entran a cocina, caja y administración.
-- (Los clientes NO tienen usuario: piden con solo su nombre.)
-- La contraseña nunca se guarda tal cual, sino cifrada (password_hash).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id     INT UNSIGNED NOT NULL,
    nombre         VARCHAR(80)  NOT NULL,
    usuario        VARCHAR(40)  NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    rol            ENUM('taquero','caja','admin','mesero','gerente') NOT NULL DEFAULT 'taquero',   -- admin = dueño · gerente = jefe de UNA sucursal · taquero = Cocina · mesero = Órdenes (mesas)
    sucursal_id    INT UNSIGNED NULL,             -- NULL = ve todas las sucursales (administrador); si no, solo la suya
    activo         TINYINT(1)   NOT NULL DEFAULT 1,
    foto           VARCHAR(80)  NULL,             -- foto de perfil (archivo en uploads)
    creado_en      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_usuario_negocio (negocio_id, usuario),
    CONSTRAINT fk_usuario_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- CATEGORIAS: Tacos, Tortas, Bebidas...
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id  INT UNSIGNED NOT NULL,
    nombre      VARCHAR(60) NOT NULL,
    orden       INT NOT NULL DEFAULT 0,         -- para decidir cuál se muestra primero
    INDEX idx_categoria_negocio (negocio_id),
    CONSTRAINT fk_categoria_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- ESTACIONES: las parrillas de cocina (cada tablet atiende una).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estaciones (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    nombre     VARCHAR(40) NOT NULL,
    orden      INT NOT NULL DEFAULT 0,
    INDEX idx_estacion_negocio (negocio_id),
    CONSTRAINT fk_estacion_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PRODUCTOS: lo que vendes, con su foto y precio.
--   codigo: clave corta que usa el taquero para anotar (ej. "P1")
--   porcion: texto libre (ej. "3 tacos", "250 g")
--   estacion_id: en qué parrilla se prepara
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id    INT UNSIGNED NOT NULL,
    categoria_id  INT UNSIGNED NOT NULL,
    nombre        VARCHAR(100) NOT NULL,
    descripcion   VARCHAR(255) NULL,
    precio        DECIMAL(10,2) NOT NULL,
    foto          VARCHAR(255) NULL,        -- nombre del archivo dentro de uploads/
    disponible    TINYINT(1) NOT NULL DEFAULT 1,   -- 0 = agotado, se oculta al cliente
    creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    codigo        VARCHAR(20) NULL,
    codigo_cocina VARCHAR(20) NULL,         -- lo que ve el cocinero si es distinto de codigo (ej. HCh en la especial)
    pedir_opciones TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = al tocar la foto también se piden las opciones
    opciones_obligatorias TINYINT(1) NOT NULL DEFAULT 0,  -- 1 = hay que elegir una opción (siempre se abre la hoja de opciones)
    grupo_obligatorio VARCHAR(40) NULL,     -- NULL = vale cualquier opción; con nombre = hay que elegir una de esa sección
    max_carnes    TINYINT UNSIGNED NULL,    -- máximo de carnes a elegir (NULL = sin límite)
    porcion       VARCHAR(40) NULL,
    estacion_id   INT UNSIGNED NULL,
    agotado_fecha DATE NULL,                -- agotado solo ese día (se marca desde Tomar pedidos)
    sucursal_id   INT UNSIGNED NULL,        -- NULL = carta general de la empresa; con valor = producto propio de esa sucursal
    orden         INT NOT NULL DEFAULT 0,   -- orden manual dentro de la categoría (0 = por nombre)
    UNIQUE KEY uq_producto_codigo (negocio_id, codigo),
    INDEX idx_producto_sucursal (sucursal_id),
    CONSTRAINT fk_producto_negocio
        FOREIGN KEY (negocio_id) REFERENCES negocios(id),
    CONSTRAINT fk_producto_categoria
        FOREIGN KEY (categoria_id) REFERENCES categorias(id),
    CONSTRAINT fk_producto_estacion
        FOREIGN KEY (estacion_id) REFERENCES estaciones(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PRODUCTO_SUCURSAL: ajustes de UNA sucursal sobre la carta general
-- (ocultar un producto, cambiar su precio o marcarlo agotado hoy solo ahí).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS producto_sucursal (
    producto_id   INT UNSIGNED NOT NULL,
    sucursal_id   INT UNSIGNED NOT NULL,
    negocio_id    INT UNSIGNED NOT NULL,
    oculto        TINYINT(1) NOT NULL DEFAULT 0,
    precio        DECIMAL(10,2) NULL,         -- NULL = usa el precio general
    agotado_fecha DATE NULL,
    PRIMARY KEY (producto_id, sucursal_id),
    INDEX idx_ps_sucursal (sucursal_id),
    CONSTRAINT fk_ps_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE,
    CONSTRAINT fk_ps_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- EXTRAS: variantes ("sin cebolla", "con queso" +$10...) con precio opcional,
-- y PRODUCTO_EXTRAS: en qué productos se puede elegir cada una.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extras (
    id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    nombre  VARCHAR(60) NOT NULL,
    precio  DECIMAL(10,2) NOT NULL DEFAULT 0,
    activo  TINYINT(1) NOT NULL DEFAULT 1,
    orden   INT NOT NULL DEFAULT 0,
    codigo  VARCHAR(20) NULL,                -- ej. "XQ" = extra queso (se ve en la comanda)
    grupo   VARCHAR(40) NULL,                -- ej. "Ensaladas", "Salsas": agrupa al elegir
    UNIQUE KEY uq_extra_codigo (negocio_id, codigo),
    CONSTRAINT fk_extra_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS producto_extras (
    producto_id INT UNSIGNED NOT NULL,
    extra_id    INT UNSIGNED NOT NULL,
    precio      DECIMAL(10,2) NULL,   -- precio de este extra SOLO en este platillo (NULL = usa el precio general del extra)
    PRIMARY KEY (producto_id, extra_id),
    CONSTRAINT fk_pe_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE,
    CONSTRAINT fk_pe_extra    FOREIGN KEY (extra_id)    REFERENCES extras(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- ORDENES: un pedido completo.
--   origen: de dónde vino  (mostrador = lo tomó un taquero, qr = el cliente,
--           pickup = el cliente lo recoge a una hora)
--   hora_prometida: solo para pickup; sirve para priorizar en cocina
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordenes (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id      INT UNSIGNED NOT NULL,
    sucursal_id     INT UNSIGNED NOT NULL,
    mesa_id         INT UNSIGNED NULL,
    mesa            VARCHAR(30) NULL,          -- nombre de la mesa al levantar el pedido (se conserva aunque se borre la mesa)
    nombre_cliente  VARCHAR(80) NOT NULL,
    origen          ENUM('mostrador','qr','pickup') NOT NULL DEFAULT 'mostrador',
    estado          ENUM('nueva','preparando','lista','entregada','cancelada') NOT NULL DEFAULT 'nueva',
    hora_prometida  DATETIME NULL,
    total           DECIMAL(10,2) NOT NULL DEFAULT 0,
    pagado          TINYINT(1) NOT NULL DEFAULT 0,
    notas           VARCHAR(255) NULL,
    creado_en       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    fecha_turno     DATE NULL,                 -- turno = fecha + consecutivo del día (2026-10-30-007)
    turno           INT UNSIGNED NULL,
    creado_por      INT UNSIGNED NULL,
    clave_cliente   CHAR(32) NULL,             -- clave secreta del cliente que pidió por QR
    telefono        VARCHAR(15) NULL,          -- 10 dígitos (opcional, pedido por QR)
    modalidad       ENUM('aqui','llevar','recoger') NOT NULL DEFAULT 'aqui',   -- comer aquí / para llevar / recoger
    revision        INT UNSIGNED NOT NULL DEFAULT 0,   -- sube con cada edición de renglones (aviso en cocina)
    editado_en      DATETIME NULL,
    cancelado_en    DATETIME NULL,
    estimado_min    SMALLINT NULL,   -- estimado prometido al levantar el pedido (el cronómetro lo descuenta)
    activada_en     DATETIME NULL,   -- cuando un pedido agendado entró a la fila de cocina
    prioritario     TINYINT(1) NOT NULL DEFAULT 0,     -- reabierto tras entregarse: va primero en cocina
    posicion_cola   SMALLINT NULL,     -- lugar en la fila al levantarse (1 = nadie delante)
    retrasados_delante SMALLINT NULL,  -- cuántos de adelante ya iban retrasados
    pago_previsto   VARCHAR(15) NULL,  -- cómo dijo que pagaría (efectivo / tarjeta / transferencia)
    INDEX idx_estado_fecha (negocio_id, sucursal_id, estado, creado_en),
    UNIQUE KEY uq_turno (sucursal_id, fecha_turno, turno),
    UNIQUE KEY uq_clave_cliente (clave_cliente),     -- la clave es aleatoria: única en toda la plataforma
    CONSTRAINT fk_orden_negocio FOREIGN KEY (negocio_id) REFERENCES negocios(id)
) ENGINE=InnoDB;

-- Pedidos hechos desde el QR por dirección (anti-abuso: se limita cuántos por rato)
CREATE TABLE IF NOT EXISTS intentos_pedido (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL DEFAULT 0,
    ip_hash    CHAR(64) NOT NULL,
    creado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ip (negocio_id, ip_hash, creado_en)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- ORDEN_ITEMS: cada renglón de una orden (3 de pastor, 1 coca...).
-- Se guardan el nombre y el precio EN EL MOMENTO de la venta, para que si
-- mañana cambias un precio, las ventas de ayer no se alteren.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orden_items (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    orden_id         INT UNSIGNED NOT NULL,
    producto_id      INT UNSIGNED NULL,
    nombre_producto  VARCHAR(100) NOT NULL,
    precio_unitario  DECIMAL(10,2) NOT NULL,
    cantidad         INT UNSIGNED NOT NULL DEFAULT 1,
    notas            VARCHAR(255) NULL,      -- nota libre del renglón
    codigo           VARCHAR(20) NULL,       -- foto del código del producto al vender
    categoria        VARCHAR(60) NULL,       -- foto de la categoría (reportes)
    estacion_id      INT UNSIGNED NULL,      -- parrilla que lo prepara
    extras_precio    DECIMAL(10,2) NOT NULL DEFAULT 0,   -- suma de extras por pieza
    estado           ENUM('pendiente','preparando','listo') NOT NULL DEFAULT 'pendiente',
    plato            TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- plato 1, 2, 3... dentro de un pedido grande
    llevar           TINYINT(1) NOT NULL DEFAULT 0,         -- plato para llevar dentro de una orden para comer aquí
    CONSTRAINT fk_item_orden
        FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_producto
        FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL,
    CONSTRAINT fk_item_estacion
        FOREIGN KEY (estacion_id) REFERENCES estaciones(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Extras elegidos en cada renglón (también como foto de nombre, código y precio).
CREATE TABLE IF NOT EXISTS orden_item_extras (
    id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id   INT UNSIGNED NOT NULL,
    extra_id  INT UNSIGNED NULL,
    nombre    VARCHAR(60) NOT NULL,
    codigo    VARCHAR(20) NULL,
    precio    DECIMAL(10,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_oie_item  FOREIGN KEY (item_id)  REFERENCES orden_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_oie_extra FOREIGN KEY (extra_id) REFERENCES extras(id)      ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PRIORIDADES: qué tan urgente es cada producto en cada parrilla.
-- Se configura en Administración → Prioridades.
-- ---------------------------------------------------------------------
-- Prioridad de cada producto en cada parrilla (0 = normal, 1 = alta, 2 = urgente)
CREATE TABLE IF NOT EXISTS prioridades (
    estacion_id INT UNSIGNED NOT NULL,
    producto_id INT UNSIGNED NOT NULL,
    nivel       TINYINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (estacion_id, producto_id),
    CONSTRAINT fk_prio_estacion FOREIGN KEY (estacion_id) REFERENCES estaciones(id) ON DELETE CASCADE,
    CONSTRAINT fk_prio_producto FOREIGN KEY (producto_id) REFERENCES productos(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- INTENTOS_LOGIN: registra contraseñas fallidas para bloquear a quien
-- intente adivinarlas (5 fallos por usuario cada 10 minutos).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentos_login (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL DEFAULT 0,       -- 0 = intento en el panel de plataforma
    ip         VARCHAR(45) NOT NULL,
    usuario    VARCHAR(40) NOT NULL,
    creado_en  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ip_fecha (negocio_id, ip, creado_en)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- CONTACTOS: teléfonos que dejan los clientes al pedir por QR.
-- Solo se mandan promociones a quien marcó "acepta_promos" (consentimiento).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contactos (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id       INT UNSIGNED NOT NULL,
    telefono         VARCHAR(15) NOT NULL,
    nombre           VARCHAR(80) NULL,
    acepta_promos    TINYINT(1) NOT NULL DEFAULT 0,
    consentido_en    DATETIME NULL,
    creado_en        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_pedido_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pedidos          INT UNSIGNED NOT NULL DEFAULT 1,
    UNIQUE KEY uq_contacto_tel (negocio_id, telefono)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- AJUSTES: valores configurables desde la administración.
--   bono_llevar / bono_aqui = minutos "extra" de prioridad en cocina según el tipo de pedido.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ajustes (
    negocio_id INT UNSIGNED NOT NULL,
    clave      VARCHAR(40) NOT NULL,
    valor      VARCHAR(100) NOT NULL,
    PRIMARY KEY (negocio_id, clave)
) ENGINE=InnoDB;
-- (los valores iniciales de cada negocio se crean al darlo de alta: bono_llevar 5, bono_aqui 0, min_preparacion 15)

-- ---------------------------------------------------------------------
-- PAGOS: cada cobro de un pedido. Un pedido puede pagarse en partes
-- (ej. mitad efectivo, mitad tarjeta). La propina va SEPARADA de la venta:
-- monto = lo que cubre la cuenta; propina = extra para el equipo.
-- Un pago anulado (anulado = 1) no cuenta en ningún total.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagos (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id  INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    orden_id    INT UNSIGNED NOT NULL,
    monto       DECIMAL(10,2) NOT NULL,
    propina     DECIMAL(10,2) NOT NULL DEFAULT 0,
    comision    DECIMAL(10,2) NOT NULL DEFAULT 0,      -- comisión de tarjeta que se le cobra al cliente (no es venta)
    metodo      ENUM('efectivo','tarjeta','transferencia') NOT NULL DEFAULT 'efectivo',
    creado_en   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    creado_por  INT UNSIGNED NULL,
    anulado     TINYINT(1) NOT NULL DEFAULT 0,
    anulado_en  DATETIME NULL,
    INDEX idx_pago_orden (orden_id),
    INDEX idx_pago_fecha (negocio_id, sucursal_id, creado_en),
    CONSTRAINT fk_pago_orden FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Bitácora de tiempos de entrega (una fila por entrega; un pedido reabierto y vuelto a entregar agrega otra).
CREATE TABLE IF NOT EXISTS tiempos_pedido (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id          INT UNSIGNED NOT NULL,
    sucursal_id         INT UNSIGNED NOT NULL,
    orden_id            INT UNSIGNED NOT NULL,
    entrega_n           TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- 1 = primera entrega; 2, 3… = tras reabrirse
    fecha               DATE NOT NULL,                          -- fecha del turno
    turno               SMALLINT UNSIGNED NOT NULL,
    modalidad           ENUM('aqui','llevar','recoger') NOT NULL,
    origen              VARCHAR(20) NULL,
    unidades            SMALLINT UNSIGNED NOT NULL,
    agendado            TINYINT(1) NOT NULL DEFAULT 0,
    reabierto           TINYINT(1) NOT NULL DEFAULT 0,
    posicion_cola       SMALLINT UNSIGNED NULL,                 -- lugar en la fila al levantarse / entrar a cocina (1 = nadie delante)
    retrasados_delante  SMALLINT UNSIGNED NULL,                 -- cuántos de adelante ya iban retrasados en ese momento
    estimado_min        SMALLINT UNSIGNED NULL,                 -- minutos prometidos
    inicio_en           DATETIME NOT NULL,                      -- levantado (agendado: entró a la fila; reabierto: se reabrió)
    prometido_en        DATETIME NOT NULL,                      -- hora en que debía estar entregado
    entregado_en        DATETIME NOT NULL,
    duracion_seg        INT NOT NULL,                           -- cronómetro: inicio → entrega
    diferencia_seg      INT NOT NULL,                           -- entregado − prometido (negativo = antes de tiempo)
    resultado           ENUM('anticipado','a_tiempo','atrasado') NOT NULL,
    agregados           TEXT NULL,                              -- JSON: lo que se agregó al pedido en esta entrega
    n_agregados         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    UNIQUE KEY uq_entrega (orden_id, entrega_n),
    INDEX idx_tiempos_fecha (negocio_id, sucursal_id, fecha),
    INDEX idx_tiempos_resultado (resultado),
    CONSTRAINT fk_tiempos_orden FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Bitácora: platillos que se agregaron a un pedido ya levantado (y a cuál entrega pertenecen).
CREATE TABLE IF NOT EXISTS pedido_agregados (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    orden_id            INT UNSIGNED NOT NULL,
    agregado_en         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    producto_id         INT UNSIGNED NULL,
    nombre_producto     VARCHAR(120) NOT NULL,
    codigo              VARCHAR(20) NULL,
    cantidad            SMALLINT UNSIGNED NOT NULL,
    extras              VARCHAR(255) NULL,
    plato               SMALLINT UNSIGNED NULL,
    despues_de_entrega  TINYINT(1) NOT NULL DEFAULT 0,     -- 1 = el pedido ya se había entregado y se reabrió
    entrega_n           TINYINT UNSIGNED NULL,             -- a qué entrega quedó ligado (NULL = aún sin entregar)
    INDEX idx_agregados_orden (orden_id),
    CONSTRAINT fk_agregados_orden FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Nota de "pedido modificado": qué se le cambió a un pedido (se ve en Caja al cobrar).
CREATE TABLE IF NOT EXISTS orden_cambios (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    orden_id            INT UNSIGNED NOT NULL,
    creado_en           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detalle             VARCHAR(250) NOT NULL,
    despues_de_entrega  TINYINT(1) NOT NULL DEFAULT 0,     -- 1 = el pedido ya estaba lista/entregada
    INDEX idx_cambios_orden (orden_id),
    CONSTRAINT fk_cambios_orden FOREIGN KEY (orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sucursales adicionales de un usuario (además de usuarios.sucursal_id, la principal). La app también la crea sola al arrancar.
CREATE TABLE IF NOT EXISTS usuario_sucursales (
    usuario_id  INT UNSIGNED NOT NULL,
    sucursal_id INT UNSIGNED NOT NULL,
    negocio_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (usuario_id, sucursal_id),
    INDEX idx_us_sucursal (sucursal_id),
    CONSTRAINT fk_us_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_us_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Secciones (grupos) de extras: Quitar, Aparte, Solo... (extras.grupo guarda el nombre). La app también la crea sola al arrancar.
CREATE TABLE IF NOT EXISTS extra_grupos (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT UNSIGNED NOT NULL,
    nombre     VARCHAR(40) NOT NULL,
    orden      INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_extra_grupo (negocio_id, nombre)
) ENGINE=InnoDB;
