#!/usr/bin/env bash
# Respaldo diario de la base de Comandia (staging). Guarda 14 días en /opt/comandia/respaldos.
# Cron sugerido (root):  15 3 * * *  /opt/comandia/deploy/respaldo-db.sh
set -euo pipefail
DESTINO=/opt/comandia/respaldos
mkdir -p "$DESTINO"
ARCHIVO="$DESTINO/comandia-staging-$(date +%F-%H%M).sql.gz"
docker exec comandia-staging-db-1 sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' | gzip > "$ARCHIVO"
find "$DESTINO" -name 'comandia-staging-*.sql.gz' -mtime +14 -delete
echo "Respaldo listo: $ARCHIVO"
