import type { FastifyInstance } from 'fastify';
import { cuerpoJson } from '../auth.js';
import { ejecutar, filas } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import { cifrar, descifrar } from '../secreto.js';
import { requerirPlataforma } from './plataforma.js';

/** Ajustes de integraciones de TODA la plataforma (tabla plataforma_config). La llave de OpenRouter va cifrada y nunca se devuelve. */
const CLAVE_LLAVE = 'openrouter_llave';
export const MODELO_IA_DEFECTO = 'anthropic/claude-haiku-4.5';
export const MODELO_STT_DEFECTO = 'openai/gpt-4o-transcribe';
export const LIMITE_VOZ_DEFECTO = 150;

export async function leerConfigPlataforma(): Promise<Map<string, string>> {
  const r = await filas('SELECT clave, valor FROM plataforma_config');
  return new Map(r.map((f) => [String(f['clave']), String(f['valor'])]));
}

async function guardar(clave: string, valor: string): Promise<void> {
  await ejecutar('INSERT INTO plataforma_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor]);
}

/** Llave de OpenRouter descifrada (solo para uso interno del servidor). null si no hay. */
export async function llaveOpenRouter(): Promise<string | null> {
  const c = await leerConfigPlataforma();
  const v = c.get(CLAVE_LLAVE);
  if (!v) return null;
  try { return await descifrar(v); } catch { return null; }
}

async function estado() {
  const c = await leerConfigPlataforma();
  const llave = await llaveOpenRouter();
  return {
    ok: true,
    llave: { configurada: llave !== null, ultimos: llave ? llave.slice(-4) : null, ilegible: c.has(CLAVE_LLAVE) && llave === null },
    modelo_ia: c.get('voz_modelo_ia') ?? MODELO_IA_DEFECTO,
    modelo_stt: c.get('voz_modelo_stt') ?? MODELO_STT_DEFECTO,
    limite_diario: Number(c.get('voz_limite_diario') ?? LIMITE_VOZ_DEFECTO),
    activa: (c.get('voz_activa') ?? '1') === '1',
  };
}

const modeloValido = (m: string): boolean => /^[A-Za-z0-9._:\/-]{3,80}$/.test(m);

export async function rutasPlataformaIntegraciones(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/integraciones',
    handler: async (req) => {
      await requerirPlataforma(req);
      if (req.method === 'GET') return estado();

      const d = cuerpoJson(req);
      const accion = String(d['accion'] ?? '');

      if (accion === 'guardar_llave') {
        const llave = String(d['llave'] ?? '').trim();
        if (llave.length < 20 || llave.length > 200 || /\s/.test(llave)) throw fallo('La llave no parece válida. Cópiala completa desde OpenRouter.');
        await guardar(CLAVE_LLAVE, await cifrar(llave));
        return estado();
      }
      if (accion === 'quitar_llave') {
        await ejecutar('DELETE FROM plataforma_config WHERE clave = ?', [CLAVE_LLAVE]);
        return estado();
      }
      if (accion === 'ajustes') {
        const ia = String(d['modelo_ia'] ?? '').trim();
        const stt = String(d['modelo_stt'] ?? '').trim();
        const limite = Number(d['limite_diario']);
        if (!modeloValido(ia) || !modeloValido(stt)) throw fallo('El nombre del modelo no es válido (ejemplo: anthropic/claude-haiku-4.5).');
        if (!Number.isInteger(limite) || limite < 0 || limite > 100000) throw fallo('El límite diario debe ser un número entero entre 0 y 100,000.');
        await guardar('voz_modelo_ia', ia);
        await guardar('voz_modelo_stt', stt);
        await guardar('voz_limite_diario', String(limite));
        await guardar('voz_activa', d['activa'] === true || d['activa'] === '1' || d['activa'] === 1 ? '1' : '0');
        return estado();
      }
      if (accion === 'probar') {
        const llave = await llaveOpenRouter();
        if (!llave) throw fallo('Primero guarda la llave de OpenRouter.');
        try {
          const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${llave}` }, signal: AbortSignal.timeout(10_000) });
          if (r.status === 401 || r.status === 403) throw fallo('OpenRouter rechazó la llave (revócala y crea una nueva, o revisa que esté completa).');
          if (!r.ok) throw fallo(`OpenRouter respondió con un error (${r.status}). Inténtalo en un momento.`);
          const j = (await r.json().catch(() => ({}))) as { data?: { label?: string; limit?: number | null; limit_remaining?: number | null; usage?: number } };
          const x = j.data ?? {};
          return { ok: true, valida: true, etiqueta: x.label ?? null, limite: x.limit ?? null, restante: x.limit_remaining ?? null, gastado: x.usage ?? null };
        } catch (e) {
          if (e instanceof ErrorHttp) throw e;
          if ((e as Error)?.name === 'TimeoutError') throw fallo('OpenRouter no respondió a tiempo. Inténtalo de nuevo.');
          throw fallo('No se pudo contactar a OpenRouter desde el servidor.');
        }
      }
      throw fallo('Acción desconocida.');
    },
  });
}
