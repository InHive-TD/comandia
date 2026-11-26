#!/usr/bin/env bash
# Prueba de carga SOLO contra staging. Genera la carga desde un contenedor temporal con CPU limitada,
# vigila docker stats y borra los pedidos de prueba (nombre ZZCARGA*) al terminar.
set -euo pipefail
ETAPAS="${1:-10,25,50,75,100,150}"; SEG="${2:-60}"; export PEDIDO_CADA_S="${3:-30}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "== Antes =="; uptime; docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' comandia-staging-1 comandia-db-1 n8n-n8n-1
( while sleep 15; do echo "[stats] $(date +%T) $(docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} net={{.NetIO}}' comandia-staging-1 comandia-db-1 n8n-n8n-1 | tr '\n' ' ') load=$(cut -d' ' -f1 /proc/loadavg) $(free -m | awk '/Mem/{print "ram_usada_mb="$3"/"$2}') disco=$(df -h / | awk 'NR==2{print $3"/"$2}')"; done ) &
VIGIA=$!
trap 'kill $VIGIA 2>/dev/null || true' EXIT
docker run --rm -e PEDIDO_CADA_S --network n8n_default --cpus 0.4 --memory 256m -v "$DIR":/p:ro node:22-bookworm-slim \
  node /p/prueba-carga.mjs http://comandia-staging-1:3000 lavale "$ETAPAS" "$SEG"
kill $VIGIA 2>/dev/null || true
echo "== Limpieza de pedidos de prueba =="
docker exec comandia-db-1 sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" comandia_stg -e "DELETE FROM ordenes WHERE nombre_cliente LIKE \"ZZCARGA%\"; SELECT ROW_COUNT() AS borrados;"' 2>&1 | grep -v Warning
echo "== Después =="; uptime; docker ps --format '{{.Names}} {{.Status}}' | grep -E "n8n|comandia"
