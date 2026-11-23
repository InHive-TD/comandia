/**
 * Apariencia de cada empresa: colores del tema y logo (equivalente de `api/lib_marca.php`).
 * Los valores se guardan en la tabla `ajustes` (claves marca_*) y se aplican con /api/tema (CSS) y /api/logo (imagen).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cargarSharp } from './sharpPerezoso.js';
import { config } from './config.js';
import { filas } from './db.js';
import { fallo } from './errores.js';

/** Colores por defecto de Comandia (los del tema original). */
export const MARCA_DEFECTO = {
  encabezado: '#601020', // barra principal
  acento: '#f8c000', // línea de la barra, detalles
  boton: '#2f7d3a', // botones y acciones (verde amable; el rojo se reserva para alertas y eliminar)
  fondo: '#fff7e0', // fondo de la página
  texto: '#2a1015', // texto
  llevar: '#3f8fcb', // "Para llevar": carril de cocina y platos para llevar dentro de un pedido para comer aquí
} as const;
export type ClaveColor = keyof typeof MARCA_DEFECTO;
export const CLAVES_COLOR = Object.keys(MARCA_DEFECTO) as ClaveColor[];

export const MARCA_NOMBRES: Record<ClaveColor, string> = {
  encabezado: 'Barra principal',
  acento: 'Acento (línea de la barra)',
  boton: 'Botones',
  fondo: 'Fondo',
  texto: 'Texto',
  llevar: 'Para llevar (cocina y pedidos)',
};

/** "#aabbcc" en minúsculas, o null si no es un color válido. */
export function hexValido(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Luminancia relativa (WCAG) de un color. */
function luminancia(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste entre dos colores (1 a 21); 4.5 o más se lee bien. */
export function contraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Blanco u oscuro, el que se lea mejor sobre ese color. */
export const textoSobre = (hex: string): string => (contraste(hex, '#ffffff') >= contraste(hex, '#1a1a1a') ? '#ffffff' : '#1a1a1a');

/** Mezcla `a` con `b` (0 = todo a, 1 = todo b). */
function mezclar(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return '#' + [0, 1, 2].map((i) => Math.round((x[i] ?? 0) + ((y[i] ?? 0) - (x[i] ?? 0)) * t).toString(16).padStart(2, '0')).join('');
}

export interface Marca extends Record<ClaveColor, string> {
  logo: string | null;
}

/** Colores guardados de la empresa (los que no estén guardados usan el valor por defecto). */
export async function marcaColores(negocioId: number): Promise<Marca> {
  const r = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave LIKE 'marca\\_%'", [negocioId]);
  const guardado = new Map(r.map((f) => [String(f['clave']).slice(6), String(f['valor'])]));
  const m = { logo: null } as Marca;
  for (const k of CLAVES_COLOR) m[k] = hexValido(guardado.get(k)) ?? MARCA_DEFECTO[k];
  const logo = guardado.get('logo');
  m.logo = logo !== undefined && /^logo_[a-f0-9]{12}\.png$/.test(logo) ? logo : null;
  return m;
}

/** CSS que sobrescribe las variables del tema. */
export function marcaCss(m: Marca): string {
  const suave = mezclar(m.fondo, m.acento, 0.22);
  const borde = mezclar(m.fondo, m.texto, 0.12);
  const tarjeta = luminancia(m.fondo) < 0.2 ? mezclar(m.fondo, '#ffffff', 0.08) : '#ffffff';
  return (
    ':root {\n' +
    `  --color-vino: ${m.encabezado};\n  --color-amarillo: ${m.acento};\n  --color-principal: ${m.boton};\n  --color-fondo: ${m.fondo};\n` +
    `  --color-oscuro: ${m.texto};\n  --color-tarjeta: ${tarjeta};\n  --color-suave: ${suave};\n  --color-borde: ${borde};\n` +
    `  --texto-encabezado: ${textoSobre(m.encabezado)};\n  --texto-boton: ${textoSobre(m.boton)};\n  --color-llevar: ${m.llevar};\n  --texto-llevar: ${contraste(m.llevar, '#ffffff') >= 3.2 ? '#ffffff' : '#1a1a1a'};\n}\n`
  );
}

/** Carpeta del logo de la empresa (la misma de sus fotos: uploads/<id>/). */
export const carpetaMarca = (negocioId: number): string => join(config.carpetaFotos, String(negocioId));

const PESO_LOGO_MAX = 5 * 1024 * 1024;
const PIXELES_MAX = 40_000_000;

/** Guarda el logo conservando la transparencia (PNG, máx. 512 px). Devuelve el nombre del archivo. */
export async function procesarLogo(buffer: Buffer, negocioId: number): Promise<string> {
  if (buffer.length > PESO_LOGO_MAX) throw fallo('El logo debe pesar menos de 5 MB.');
  const sharp = await cargarSharp();
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: PIXELES_MAX }).metadata();
  } catch {
    throw fallo('Usa un logo en formato PNG, JPG o WebP.');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw fallo('Usa un logo en formato PNG, JPG o WebP.');
  if (!meta.width || !meta.height || meta.width * meta.height > PIXELES_MAX) throw fallo('La imagen tiene dimensiones demasiado grandes.');
  let salida: Buffer;
  try {
    salida = await sharp(buffer, { limitInputPixels: PIXELES_MAX })
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 7 }) // conserva la transparencia
      .toBuffer();
  } catch {
    throw fallo('No se pudo leer la imagen.');
  }
  try {
    const carpeta = carpetaMarca(negocioId);
    await mkdir(carpeta, { recursive: true });
    const nombre = `logo_${randomBytes(6).toString('hex')}.png`;
    await writeFile(join(carpeta, nombre), salida);
    return nombre;
  } catch {
    throw fallo('El servidor no puede guardar el logo (revisa los permisos de la carpeta uploads).');
  }
}

/** Borra un logo del disco (solo nombres que genera procesarLogo, y solo de la empresa indicada). */
export async function borrarLogo(nombre: string | null, negocioId: number): Promise<void> {
  if (nombre !== null && /^logo_[a-f0-9]{12}\.png$/.test(nombre)) {
    try {
      await unlink(join(carpetaMarca(negocioId), nombre));
    } catch {
      /* ya no estaba */
    }
  }
}
