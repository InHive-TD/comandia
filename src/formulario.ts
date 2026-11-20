import '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { ErrorHttp } from './errores.js';

export const FOTO_PESO_MAX = 8 * 1024 * 1024;

/** Formulario enviado por la pantalla (FormData): campos de texto y, opcionalmente, una foto. */
export class Formulario {
  constructor(
    private readonly valores: Map<string, string[]>,
    /** Archivo recibido (la foto de un producto o el logo, según el campo que se pidió leer). */
    readonly foto: Buffer | null,
  ) {}

  /** Texto de un campo ("" si no vino). */
  texto(nombre: string, porDefecto = ''): string {
    return this.valores.get(nombre)?.at(-1) ?? porDefecto;
  }

  /** Campo repetido (ids[]) o lista separada por comas ("1,4,7"). */
  lista(nombre: string): string[] {
    const v = this.valores.get(nombre) ?? [];
    return v.length === 1 ? (v[0] ?? '').split(',') : v;
  }
}

/** Lee un FormData (multipart). Si la petición viene como JSON, usa sus campos. */
export async function leerFormulario(req: FastifyRequest, campoArchivo = 'foto'): Promise<Formulario> {
  const valores = new Map<string, string[]>();
  let foto: Buffer | null = null;

  if (req.isMultipart()) {
    try {
      for await (const parte of req.parts({ limits: { fileSize: FOTO_PESO_MAX, files: 1, fields: 40 } })) {
        if (parte.type === 'file') {
          const buf = await parte.toBuffer();
          if (parte.file.truncated) throw new ErrorHttp(400, 'validacion', 'La foto pesa más de 8 MB.');
          if (buf.length > 0 && parte.fieldname === campoArchivo) foto = buf;
        } else {
          const nombre = parte.fieldname.replace(/\[\]$/, '');
          valores.set(nombre, [...(valores.get(nombre) ?? []), String(parte.value ?? '')]);
        }
      }
    } catch (e) {
      if (e instanceof ErrorHttp) throw e;
      throw new ErrorHttp(413, 'validacion', 'La foto es demasiado pesada para enviarla. Usa una más pequeña.');
    }
  } else if (req.body && typeof req.body === 'object') {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      valores.set(k.replace(/\[\]$/, ''), Array.isArray(v) ? v.map(String) : [String(v ?? '')]);
    }
  }
  return new Formulario(valores, foto);
}
