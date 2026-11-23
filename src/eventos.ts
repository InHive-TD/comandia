/**
 * Avisos en vivo (Server-Sent Events). En lugar de que cada pantalla pregunte al servidor cada 2-5 segundos
 * "¿hay algo nuevo?", el servidor avisa solo cuando algo cambió (pedido nuevo, cambio de estado, cobro...).
 * El aviso no lleva datos: la pantalla, al recibirlo, vuelve a pedir lo suyo con su permiso de siempre.
 * Vive en memoria de este proceso (Comandia corre en un solo proceso).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';

const suscriptores = new Map<number, Set<ServerResponse>>();
const pendientes = new Map<number, NodeJS.Timeout>();
const LATIDO_MS = 20_000;
const MAX_POR_NEGOCIO = 200;

/** Avisa a las pantallas abiertas de ese negocio (junta varios cambios seguidos en un solo aviso). */
export function avisarCambio(negocioId: number): void {
  const set = suscriptores.get(negocioId);
  if (!set || set.size === 0 || pendientes.has(negocioId)) return;
  pendientes.set(
    negocioId,
    setTimeout(() => {
      pendientes.delete(negocioId);
      for (const r of set) r.write('data: cambio\n\n');
    }, 120),
  );
}

/**
 * Hook de Fastify: cualquier acción que modifica datos con éxito avisa a las pantallas del negocio.
 * Debe agregarse en el mismo nivel donde se registran las rutas (los hooks no se heredan hacia los lados).
 */
export async function avisarAlGuardar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (reply.statusCode >= 400 || !req.negocio) return;
  avisarCambio(req.negocio.id);
}

export async function rutasEventos(app: FastifyInstance): Promise<void> {
  app.get('/eventos', (req, reply) => {
    const id = req.negocio?.id;
    if (!id) return reply.code(404).send({ ok: false, error: 'no_encontrado', mensaje: 'No encontrado.' });
    let set = suscriptores.get(id);
    if (!set) suscriptores.set(id, (set = new Set()));
    if (set.size >= MAX_POR_NEGOCIO) return reply.code(503).send({ ok: false, error: 'ocupado', mensaje: 'Demasiadas pantallas abiertas.' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-LiteSpeed-Cache-Control': 'no-cache',
    });
    res.write('retry: 3000\n\ndata: hola\n\n');
    set.add(res);
    // Señal de vida: la pantalla la usa para saber que la conexión sigue buena.
    const latido = setInterval(() => res.write('data: latido\n\n'), LATIDO_MS);
    req.raw.on('close', () => {
      clearInterval(latido);
      set.delete(res);
      if (set.size === 0) suscriptores.delete(id);
    });
  });
}
