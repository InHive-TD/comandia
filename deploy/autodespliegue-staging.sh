#!/usr/bin/env bash
# Despliegue automático SOLO de staging: si hay un commit nuevo en la rama develop de GitHub, reconstruye y reinicia
# el contenedor de staging. Producción NO se toca nunca (esa se construye a mano con construir-prod.sh).
# Se ejecuta cada minuto desde cron del root; si ya hay un despliegue en curso, no hace nada.
set -euo pipefail
exec 9>/tmp/autodespliegue-staging.lock
flock -n 9 || exit 0
RAIZ=/opt/comandia/repo
MARCA=/opt/comandia/.staging-desplegado
cd "$RAIZ"
git fetch -q origin develop
NUEVO="$(git rev-parse origin/develop)"
[ -f "$MARCA" ] && [ "$(cat "$MARCA")" = "$NUEVO" ] && exit 0
echo "[$(date '+%F %T')] staging: desplegando ${NUEVO:0:7}"
git merge -q --ff-only origin/develop
cd deploy
nice -n 10 docker compose build staging
docker compose up -d staging
echo "$NUEVO" > "$MARCA"
echo "[$(date '+%F %T')] staging: listo ${NUEVO:0:7}"
