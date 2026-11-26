import type { FastifyInstance } from 'fastify';
import { cuerpoJson } from '../auth.js';
import { ejecutar, filas } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import { cifrar, descifrar } from '../secreto.js';
import { requerirPlataforma } from './plataforma.js';

/** Ajustes de integraciones de TODA la plataforma (tabla plataforma_config). La llave de OpenRouter va cifrada y nunca se devuelve. */
const CLAVE_LLAVE = 'openrouter_llave';
export const MODELO_IA_DEFECTO = 'google/gemini-2.5-flash-lite';
export const MODELO_STT_DEFECTO = 'openai/whisper-large-v3';
/** Límite diario de tokens de IA por empresa (cada empresa puede tener el suyo propio). */
export const LIMITE_VOZ_DEFECTO = 600_000;

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
    limite_diario: Number(c.get('voz_limite_tokens') ?? LIMITE_VOZ_DEFECTO),
    activa: (c.get('voz_activa') ?? '1') === '1',
  };
}

interface ModeloLista { id: string; nombre: string; entrada: number | null; salida: number | null; minuto: number | null }
let cacheModelos: { en: number; datos: { ia: ModeloLista[]; stt: ModeloLista[] } } | null = null;

const aNumero = (v: unknown): number | null => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
};

/** Convierte la respuesta de OpenRouter a una lista corta: precio por millón de tokens (texto) o por minuto (voz). */
function normalizar(lista: unknown, esVoz: boolean): ModeloLista[] {
  const arr = (lista as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(arr)) return [];
  const salida: ModeloLista[] = [];
  for (const m of arr as Array<Record<string, any>>) {
    const id = String(m['id'] ?? '');
    if (!modeloValido(id)) continue;
    const p = (m['pricing'] ?? {}) as Record<string, unknown>;
    const porToken = (v: unknown) => { const n = aNumero(v); return n === null ? null : n * 1_000_000; };
    const audioSeg = aNumero(p['audio']) ?? aNumero(p['request']);
    salida.push({
      id,
      nombre: String(m['name'] ?? id).slice(0, 80),
      entrada: porToken(p['prompt']),
      salida: porToken(p['completion']),
      minuto: esVoz && audioSeg !== null && audioSeg > 0 ? audioSeg * 60 : null,
    });
  }
  return salida.sort((a, b) => a.id.localeCompare(b.id));
}

async function pedirModelos(url: string, llave: string | null): Promise<unknown> {
  const r = await fetch(url, { headers: llave ? { Authorization: `Bearer ${llave}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw fallo(`OpenRouter respondió con un error (${r.status}) al pedir la lista de modelos.`);
  return r.json();
}

/** Modelos de texto (para entender el pedido) y de transcripción (voz a texto). Se guarda 10 minutos. */
async function listarModelos(): Promise<{ ia: ModeloLista[]; stt: ModeloLista[] }> {
  if (cacheModelos && Date.now() - cacheModelos.en < 10 * 60_000) return cacheModelos.datos;
  const llave = await llaveOpenRouter();
  try {
    const [t, v] = await Promise.all([
      pedirModelos('https://openrouter.ai/api/v1/models', llave),
      pedirModelos('https://openrouter.ai/api/v1/models?output_modalities=transcription', llave).catch(() => null),
    ]);
    const datos = { ia: normalizar(t, false), stt: normalizar(v, true) };
    if (datos.ia.length === 0) throw fallo('OpenRouter no devolvió modelos.');
    cacheModelos = { en: Date.now(), datos };
    return datos;
  } catch (e) {
    if (e instanceof ErrorHttp) throw e;
    throw fallo('No se pudo obtener la lista de modelos de OpenRouter. Puedes escribir el nombre del modelo a mano.');
  }
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
        if (!Number.isInteger(limite) || limite < 0 || limite > 1_000_000_000) throw fallo('El límite diario debe ser un número entero de tokens (0 a 1,000,000,000).');
        await guardar('voz_modelo_ia', ia);
        await guardar('voz_modelo_stt', stt);
        await guardar('voz_limite_tokens', String(limite));
        await guardar('voz_activa', d['activa'] === true || d['activa'] === '1' || d['activa'] === 1 ? '1' : '0');
        return estado();
      }
      if (accion === 'modelos') return { ok: true, ...(await listarModelos()) };
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
