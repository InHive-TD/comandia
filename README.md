# Comandia (TypeScript)

Pedidos, cocina y caja para taquerías, fondas y restaurantes: multi-empresa (cada una en su ruta, `dominio/lavale/`), multi-sucursal, con roles de dueño, gerente, mesero, caja y cocina.

Esta es la reescritura en **TypeScript** de la versión PHP (repo `comandia-php`). Usa la **misma base de datos MySQL**, las **mismas rutas de API** y las **mismas pantallas** (`public/`), así que se puede probar contra los datos existentes.

**Pila:** Node 22+ · TypeScript · Fastify · MySQL (mysql2) · sesiones en MySQL · bcrypt.

## Arrancar en tu computadora

1. Instala Node.js LTS. Enciende MySQL (XAMPP).
2. Crea la base de datos `comandia` e impórtale `database/schema.sql` (o usa una base que ya tenga los datos de la versión PHP).
3. Copia `.env.example` como `.env` y ajusta los datos de la base.
4. En la carpeta del proyecto:

```
npm install
npm run dev
```

5. Abre `http://localhost:3000/plataforma/` (super administrador) o `http://localhost:3000/lavale/admin/` (empresa).

## Estado de la migración

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Servidor, base de datos, empresas por ruta, sesiones, CSRF, login/logout, sucursal activa, sesión de plataforma | ✅ |
| 2 | Menú, categorías, parrillas, extras, productos (con fotos), sucursales, mesas y usuarios (incluye gerente y carta por sucursal) | ✅ |
| 3 | Pedidos, cocina y caja | ✅ listo (pedidos, cocina, caja, agotar, prioridades, tiempos) |
| 4 | Cliente por QR, reportes, apariencia | pendiente |
| 5 | Panel de plataforma: empresas (lista, crear, editar, pausar, clave) | ✅ (falta la migración de bases viejas) |

Las pantallas llaman a `/api/xxx.php`; el servidor acepta esos nombres (quita el `.php` internamente).

## Estructura

```
src/
  server.ts   arranque          app.ts      rutas, estáticos y errores
  config.ts   variables (.env)  db.ts       conexión MySQL
  negocio.ts  empresa por ruta  sesion.ts   sesiones en MySQL
  auth.ts     roles, CSRF, sucursal   rutas/  endpoints
public/       pantallas (HTML/CSS/JS)
database/     schema.sql
```
