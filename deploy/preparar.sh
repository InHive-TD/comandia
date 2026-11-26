#!/usr/bin/env bash
# Genera las contraseñas al azar y escribe .env.db, .env.staging y .env.prod (permisos 600) SIN mostrarlas.
# No sobrescribe nada que ya exista. Después hay que escribir a mano SMTP_PASS en .env.staging y .env.prod (nano).
set -euo pipefail
cd "$(dirname "$0")"
[ -e .env.db ] && { echo "Ya existe .env.db: no toco nada."; exit 0; }
umask 177
R=$(openssl rand -hex 24); S=$(openssl rand -hex 24); P=$(openssl rand -hex 24)
printf 'MYSQL_ROOT_PASSWORD=%s\nSTG_PASSWORD=%s\nPROD_PASSWORD=%s\n' "$R" "$S" "$P" > .env.db
comun='ZONA_HORARIA=America/Mexico_City
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=no-reply@comandia.mx
SMTP_PASS='
printf 'DB_NAME=comandia_stg\nDB_USER=stg\nDB_PASSWORD=%s\nAPP_URL=https://staging.comandia.mx\n%s\n' "$S" "$comun" > .env.staging
printf 'DB_NAME=comandia_prod\nDB_USER=prod\nDB_PASSWORD=%s\nAPP_URL=https://comandia.mx\n%s\n' "$P" "$comun" > .env.prod
echo "Listo: .env.db, .env.staging y .env.prod creados (contraseñas al azar, no mostradas)."
echo "Falta: escribir SMTP_PASS en .env.staging y .env.prod con nano."
