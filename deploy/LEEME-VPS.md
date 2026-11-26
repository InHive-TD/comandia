# Comandia en el VPS (staging primero)

Estado: **preparado, aún no instalado** (falta acceso root al VPS). Nada de esto toca el proyecto de n8n salvo el
paso 4 (añadir 2 líneas al Caddyfile). No probado en el servidor: el Dockerfile no se pudo construir en el equipo de trabajo.

## Antes de empezar
1. Snapshot del VPS (hecho el 2026-11-25 20:23). Repetirlo justo antes de tocar el Caddyfile.
2. Entrar por la consola web / SSH como root.
3. Ver cómo está montado n8n (solo lectura):
   `cat /opt/n8n/Caddyfile` · `cat /opt/n8n/docker-compose.yml` · `ss -tlnp` · `docker network ls`
   El panel de Hostinger muestra `5678:5678` público para n8n; confirmar con `ss -tlnp` y, si es público, cerrarlo con el firewall.

## Instalación (staging)
```bash
mkdir -p /opt/comandia && cd /opt/comandia
git clone https://github.com/InHive-TD/comandia.git repo && cd repo && git checkout develop
cd deploy
cp env.staging.ejemplo .env.staging && nano .env.staging     # rellenar contraseñas (generar largas, distintas)
docker network ls                                            # confirmar el nombre de la red de Caddy (n8n_default)
docker compose -f docker-compose.staging.yml up -d --build db
```
Cargar los datos de staging (exportados desde phpMyAdmin con "DROP TABLE" incluido) y las fotos:
```bash
gunzip -c staging.sql.gz | docker exec -i comandia-staging-db-1 sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
# fotos: copiar la carpeta uploads/ al volumen "fotos" (docker cp)
docker compose -f docker-compose.staging.yml up -d --build app
docker logs comandia-staging-app-1 --tail 50                 # debe decir que escucha en el puerto 3000
```
Sin DNS todavía, probar desde dentro del servidor: `docker exec comandia-staging-app-1 node -e "fetch('http://127.0.0.1:3000/favicon.ico').then(r=>console.log(r.status))"`

## Conectar con Caddy (único cambio al proyecto n8n)
1. `cp /opt/n8n/Caddyfile /opt/n8n/Caddyfile.respaldo-$(date +%F)`
2. Añadir al final el bloque de `Caddyfile.comandia` (staging).
3. Validar y recargar sin reiniciar: `docker exec n8n-caddy-1 caddy validate --config /etc/caddy/Caddyfile && docker exec n8n-caddy-1 caddy reload --config /etc/caddy/Caddyfile`
4. Probar que n8n sigue respondiendo en `https://automations.techinhive.com`.

## Cambiar el dominio (al final, cuando todo esté probado)
Apuntar el registro A de `staging.comandia.mx` a `2.25.125.159`. Hasta entonces el hosting actual sigue sirviendo staging.
Bajar antes el TTL del registro a 300 s para poder volver atrás rápido.

## Respaldos
`deploy/respaldo-db.sh` (cron diario 03:15, 14 días). Además el respaldo semanal de Hostinger del servidor completo.

## Despliegue de cambios
`cd /opt/comandia/repo && git pull && cd deploy && docker compose -f docker-compose.staging.yml up -d --build app`

## Producción
No se migra hasta que se pida. Se repite este proceso con otro proyecto (`comandia-prod`), otra base y otro bloque en Caddy.
Vigilar memoria: n8n ~1.7 GB + Comandia staging (~1 GB tope) + producción. Con 4 GB y 1 núcleo, producción puede requerir un VPS aparte.
