#!/bin/bash
# Se ejecuta UNA vez, al crear la base por primera vez. Crea las dos bases y un usuario para cada una,
# con permisos solo sobre la suya (la app de staging no puede ver producción, ni al revés).
set -euo pipefail
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE comandia_stg  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE comandia_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'stg'@'%'  IDENTIFIED BY '${STG_PASSWORD}';
CREATE USER 'prod'@'%' IDENTIFIED BY '${PROD_PASSWORD}';
GRANT ALL PRIVILEGES ON comandia_stg.*  TO 'stg'@'%';
GRANT ALL PRIVILEGES ON comandia_prod.* TO 'prod'@'%';
FLUSH PRIVILEGES;
SQL
