/**
 * Tema de la empresa, público (lo cargan todas las pantallas, también la del cliente sin sesión):
 *   GET /tema → hoja de estilos con los colores de la empresa (se carga después de los demás CSS).
 *   GET /logo → logo de la empresa (o el de Comandia si aún no subió uno).
 * Ambos usan ETag: el navegador pregunta y recibe 304 si no cambió, así los cambios se ven al instante.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { carpetaMarca, marcaColores, marcaCss } from '../marca.js';

const LOGO_COMANDIA = fileURLToPath(new URL('../../public/img/comandia.png', import.meta.url));

/** Responde 304 si el navegador ya tiene esta versión; si no, devuelve false para que se envíe el contenido. */
function noModificado(req: FastifyRequest, reply: FastifyReply, etag: string): boolean {
  reply.header('Cache-Control', 'no-cache').header('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    reply.code(304).send();
    return true;
  }
  return false;
}

export async function rutasTema(app: FastifyInstance): Promise<void> {
  app.get('/tema', async (req, reply) => {
    const css = marcaCss(await marcaColores(req.negocio.id));
    if (noModificado(req, reply, `"${createHash('md5').update(css).digest('hex')}"`)) return reply;
    return reply.type('text/css; charset=utf-8').send(css);
  });

  app.get('/logo', async (req, reply) => {
    const m = await marcaColores(req.negocio.id);
    let ruta = LOGO_COMANDIA;
    if (m.logo !== null) {
      const propio = join(carpetaMarca(req.negocio.id), m.logo);
      try {
        await stat(propio);
        ruta = propio;
      } catch {
        /* el archivo ya no está: se usa el de Comandia */
      }
    }
    const info = await stat(ruta);
    if (noModificado(req, reply, `"${createHash('md5').update(ruta + info.mtimeMs).digest('hex')}"`)) return reply;
    return reply.type('image/png').send(await readFile(ruta));
  });
}
