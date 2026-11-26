#!/usr/bin/env bash
# Respaldo diario de las dos bases de Comandia. Guarda 14 días en /opt/comandia/respaldos.
# Cron sugerido (root):  15 3 * * *  /opt/comandia/repo/deploy/respaldo-db.sh
set -euo pipefail
DESTINO=/opt/comandia/respaldos
mkdir -p "$DESTINO"
for B in comandia_stg comandia_prod; do
  ARCHIVO="$DESTINO/$B-$(date +%F-%H%M).sql.gz"
  docker exec comandia-db-1 sh -c "mysqldump -u root -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --routines --triggers $B" | gzip > "$ARCHIVO"
  echo "Respaldo listo: $ARCHIVO"
done
find "$DESTINO" -name 'comandia_*.sql.gz' -mtime +14 -delete
