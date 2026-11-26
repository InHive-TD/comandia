#!/usr/bin/env bash
# Construye la imagen de PRODUCCIÓN (comandia-app:prod) con el código de la rama main.
# Usa el Dockerfile de esta carpeta (develop) pero el código de main, en una copia aparte.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO=/opt/comandia/main
git -C "$RAIZ" fetch -q origin main
if [ -d "$DESTINO" ]; then git -C "$RAIZ" worktree remove --force "$DESTINO"; fi
git -C "$RAIZ" worktree add -q --detach "$DESTINO" origin/main
cp "$RAIZ/.dockerignore" "$DESTINO/.dockerignore"
docker build -q -f "$RAIZ/deploy/Dockerfile" -t comandia-app:prod "$DESTINO"
echo "Imagen comandia-app:prod lista, código de main $(git -C "$DESTINO" rev-parse --short HEAD)"
