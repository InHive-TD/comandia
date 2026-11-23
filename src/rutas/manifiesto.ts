/**
 * Manifiesto para instalar Comandia como aplicación (acceso directo en celular, tablet o computadora).
 * Cada pantalla (cliente, pedidos, cocina, caja, administración) se instala como su propia aplicación, con el nombre
 * de la empresa y abriendo directo en su pantalla: así la cocina instala "La Vale · Cocina" y la caja "La Vale · Caja".
 *   GET /<empresa>/api/manifest?p=cocina[&s=<sucursal>]   (público: no lleva datos de nadie)
 */
import type { FastifyInstance } from 'fastify';

const PANTALLAS: Record<string, string> = {
  cliente: 'Pedidos',
  pedidos: 'Tomar pedidos',
  cocina: 'Cocina',
  caja: 'Caja',
  admin: 'Administración',
};

export async function rutasManifiesto(app: FastifyInstance): Promise<void> {
  app.get('/manifest', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const p = String(q['p'] ?? 'cliente');
    const pantalla = Object.hasOwn(PANTALLAS, p) ? p : 'cliente';
    const suc = String(q['s'] ?? '');
    const base = `/${req.negocio.slug}/`;
    const inicio = pantalla === 'cliente' ? (/^[a-z0-9-]{1,40}$/.test(suc) ? `${base}${suc}/` : base) : `${base}${pantalla}/`;
    const nombre = req.negocio.nombre;
    return reply
      .type('application/manifest+json; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(JSON.stringify({
        id: inicio,
        name: `${nombre} · ${PANTALLAS[pantalla]}`,
        short_name: pantalla === 'cliente' ? nombre.slice(0, 12) : PANTALLAS[pantalla]!.slice(0, 12),
        description: `${PANTALLAS[pantalla]} de ${nombre}, con tecnología Comandia`,
        start_url: inicio,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        lang: 'es-MX',
        background_color: '#fff7e0',
        theme_color: '#601020',
        icons: [
          { src: '/img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }));
  });
}
