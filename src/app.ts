/**
 * Arma la aplicación web (Fastify): plugins, manejo de errores, rutas de la API y entrega de las pantallas.
 *
 * Mapa de rutas (igual que la versión PHP, para reutilizar las pantallas sin cambios):
 *   /api/plataforma/...      API del dueño de Comandia (sesión aparte)
 *   /<empresa>/api/...       API de cada empresa (login, menú, administración...)
 *   /<empresa>/              pantalla del cliente (QR)
 *   /<empresa>/admin/ ...    pantallas del personal (admin, pedidos, cocina, caja)
 *   /plataforma/, /css, /js  pantallas y archivos comunes
 *   /<empresa>/uploads/...   fotos de productos
 * Las pantallas llaman a "/api/xxx.php": el servidor quita el ".php" internamente (ver rewriteUrl).
 */
import { join, normalize, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import estatico from '@fastify/static';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { ErrorHttp } from './errores.js';
import { cargarNegocio, slugValido } from './negocio.js';
import { persistirSesion } from './sesion.js';
import { rutasEmpresa } from './rutas/empresa.js';
import { rutasPlataforma } from './rutas/plataforma.js';
import './tipos.js';

const RAIZ_PUBLICA = resolve(fileURLToPath(new URL('../public', import.meta.url)));

export async function crearApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    trustProxy: config.confiarProxy,
    // La pantalla llama a /api/login.php, /api/ordenes.php... Aceptamos esos nombres tal cual (sin el ".php" internamente).
    rewriteUrl: (req) => (req.url ?? '/').replace(/\.php(?=\?|$)/, ''),
    bodyLimit: 12 * 1024 * 1024,
  });

  await app.register(cookie);
  // Formularios con foto (FormData). El límite de tamaño de la foto se aplica en formulario.ts.
  await app.register(multipart);
  await app.register(estatico, { root: RAIZ_PUBLICA, serve: false, cacheControl: true, maxAge: 0 });

  // JSON tolerante: un cuerpo vacío o inválido se lee como {} (igual que la versión PHP).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, cuerpo, hecho) => {
    try {
      hecho(null, cuerpo ? JSON.parse(cuerpo as string) : {});
    } catch {
      hecho(null, {});
    }
  });

  // Formularios clásicos (application/x-www-form-urlencoded): los campos repetidos se vuelven listas.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, cuerpo, hecho) => {
    const campos: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(cuerpo as string)) {
      const previo = campos[k];
      campos[k] = previo === undefined ? v : Array.isArray(previo) ? [...previo, v] : [previo, v];
    }
    hecho(null, campos);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    await persistirSesion(req, reply);
    reply.header('Cache-Control', req.url.includes('/api/') ? 'no-store' : reply.getHeader('Cache-Control') ?? 'no-cache');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErrorHttp) {
      return reply.code(err.estado).send({ ok: false, error: err.codigo, mensaje: err.message });
    }
    const estado = (err as { statusCode?: number }).statusCode;
    if (estado && estado < 500) {
      req.log.warn({ err, url: req.url }, 'petición rechazada');
      return reply.code(estado).send({ ok: false, error: 'peticion', mensaje: 'Petición no válida.' });
    }
    req.log.error(err);
    return reply.code(500).send({ ok: false, error: 'bd', mensaje: 'Ocurrió un error en el servidor.' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, error: 'no_encontrado', mensaje: 'No encontrado.' }));

  // API de la plataforma (el dueño de Comandia) y API de cada empresa (/<slug>/api/...)
  await app.register(rutasPlataforma, { prefix: '/api/plataforma' });
  await app.register(
    async (empresa) => {
      empresa.addHook('onRequest', async (req) => {
        const { slug } = req.params as { slug: string };
        req.negocio = await cargarNegocio(slug);
      });
      await empresa.register(rutasEmpresa);
    },
    { prefix: '/:slug/api' },
  );

  app.get('/favicon.ico', (_req, reply) => reply.sendFile('img/favicon.png'));

  // Pantallas y archivos: /css, /js, /img (raíz) y /<empresa>/ + admin|pedidos|cocina|caja|... (como hacía el router.php)
  app.get('/*', async (req, reply) => {
    const ruta = decodeURIComponent(req.url.split('?')[0] ?? '/');
    const partes = ruta.split('/').filter(Boolean);
    const primero = partes[0]?.toLowerCase() ?? '';
    let relativa: string;

    if (partes.length === 0) {
      relativa = 'index.html';
    } else if (slugValido(primero)) {
      const resto = partes.slice(1).join('/');
      if (!ruta.endsWith('/') && partes.length === 1) return reply.redirect(ruta + '/', 302);
      if (!ruta.endsWith('/') && /^(admin|pedidos|cocina|caja)$/.test(resto)) return reply.redirect(ruta + '/', 302);
      relativa = resto === '' ? 'cliente/index.html' : resto;
    } else {
      relativa = partes.join('/');
    }

    // Fotos de productos: viven en la carpeta de uploads (no en public/). Solo se entregan los nombres que genera
    // fotos.ts ("<id>/p_xxxxxxxxxxxxxxxx.jpg"); cualquier otra ruta bajo /uploads/ no existe.
    if (relativa.startsWith('uploads/')) {
      const foto = relativa.slice('uploads/'.length);
      if (!/^(?:\d+\/)?p_[a-f0-9]{16}\.jpg$/.test(foto)) return reply.code(404).send('No encontrado');
      return reply.sendFile(foto, config.carpetaFotos);
    }

    let archivo = resolve(join(RAIZ_PUBLICA, normalize(relativa)));
    if (!archivo.startsWith(RAIZ_PUBLICA + sep) && archivo !== RAIZ_PUBLICA) return reply.code(404).send('No encontrado');
    if (existsSync(archivo) && statSync(archivo).isDirectory()) archivo = join(archivo, 'index.html');
    if (!existsSync(archivo) || !statSync(archivo).isFile()) return reply.code(404).send('No encontrado');
    // sendFile espera rutas con "/" aunque en Windows las rutas del sistema usen "\".
    return reply.sendFile(archivo.slice(RAIZ_PUBLICA.length + 1).split(sep).join('/'));
  });

  return app;
}
