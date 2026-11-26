# Comandia en el VPS (Docker)

Una MySQL con dos bases (`comandia_stg`, `comandia_prod`) + dos contenedores de la app (`comandia-staging-1`, `comandia-prod-1`).
Proyecto aparte del de n8n; solo se une a su red (`n8n_default`, confirmada). Nada se publica a internet: entra todo por Caddy.
Verificado en el servidor (2026-11-25): n8n escucha solo en 127.0.0.1:5678; públicos: 22, 80, 443. Memoria libre ~2 GB.
No probado aún: la construcción del Dockerfile.

## Instalación
```bash
cd /opt/comandia/repo && git pull && cd deploy
./preparar.sh                       # genera contraseñas al azar y los 3 archivos .env (no las muestra)
nano .env.staging                   # escribir SMTP_PASS (contraseña del buzón no-reply). Igual en .env.prod
docker compose up -d db             # crea MySQL con las dos bases
docker compose build staging        # construye la imagen (tarda unos minutos)
```
Cargar los datos (la app NO arranca sin las tablas; por eso las apps se levantan después):
```bash
# desde Hostinger, vía conexión remota temporal solo para la IP del VPS (2.25.125.159):
mysqldump -h <host_hostinger> -u <usuario> -p --single-transaction --no-tablespaces <base> | docker exec -i comandia-db-1 sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" comandia_stg'
# fotos: copiar uploads/ de staging al volumen comandia_fotos_staging
docker compose up -d staging && docker logs comandia-staging-1 --tail 30
```
Prueba sin tocar dominios: `docker exec comandia-staging-1 node -e "fetch('http://127.0.0.1:3000/favicon.ico').then(r=>console.log(r.status))"`

## Caddy (único cambio al proyecto n8n)
```bash
cp /opt/n8n/Caddyfile /opt/n8n/Caddyfile.respaldo-$(date +%F)
cat >> /opt/n8n/Caddyfile <<'X'

staging.comandia.mx {
    encode zstd gzip
    reverse_proxy comandia-staging-1:3000
}
X
docker exec n8n-caddy-1 caddy validate --config /etc/caddy/Caddyfile && docker exec n8n-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```
Comprobar enseguida que `https://automations.techinhive.com` sigue respondiendo. Si algo falla: restaurar el respaldo del Caddyfile y recargar.

## Dominios (de uno en uno)
1. Bajar el TTL del registro A a 300 s. 2. Apuntar `staging.comandia.mx` a 2.25.125.159 (Caddy saca el certificado solo).
3. Producción: copia final de la base justo antes (ventana de poco movimiento), agregar su bloque a Caddy y apuntar `comandia.mx`.
El hosting actual queda encendido unos días como vuelta atrás.

## Respaldos y actualizaciones
Cron diario 03:15: `/opt/comandia/repo/deploy/respaldo-db.sh`. Actualizar staging: `cd /opt/comandia/repo && git pull && cd deploy && docker compose up -d --build staging`.
