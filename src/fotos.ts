import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cargarSharp } from './sharpPerezoso.js';
import { config } from './config.js';
import { fallo } from './errores.js';

/**
 * Procesamiento seguro de fotos de productos.
 * No se guarda el archivo tal como llega: se abre como imagen, se corrige su orientación, se reduce de tamaño
 * y se vuelve a guardar como JPEG con un nombre aleatorio. Así el menú carga rápido en el celular del cliente,
 * se eliminan datos ocultos (ubicación GPS, etc.) y nadie puede subir un archivo disfrazado de foto.
 */
const LADO_MAX = 1200;
const PIXELES_MAX = 40_000_000;

/** Valida y guarda una foto. Devuelve "<id de la empresa>/p_xxxxxxxxxxxxxxxx.jpg". */
export async function procesarFoto(buffer: Buffer, negocioId: number): Promise<string> {
  const sharp = await cargarSharp();
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: PIXELES_MAX }).metadata();
  } catch {
    throw fallo('El archivo no es una imagen válida.');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw fallo('Usa una foto en formato JPG, PNG o WebP.');
  if (!meta.width || !meta.height || meta.width * meta.height > PIXELES_MAX) throw fallo('La imagen tiene dimensiones demasiado grandes.');

  let salida: Buffer;
  try {
    salida = await sharp(buffer, { limitInputPixels: PIXELES_MAX })
      .rotate() // corrige la orientación de fotos tomadas con el celular
      .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // fondo blanco (PNG con transparencia)
      .jpeg({ quality: 82, progressive: true })
      .toBuffer(); // sin metadatos: se pierde el GPS y demás datos ocultos
  } catch {
    throw fallo('No se pudo leer la imagen.');
  }

  const carpeta = join(config.carpetaFotos, String(negocioId));
  try {
    await mkdir(carpeta, { recursive: true });
    const nombre = `p_${randomBytes(8).toString('hex')}.jpg`;
    await writeFile(join(carpeta, nombre), salida);
    return `${negocioId}/${nombre}`;
  } catch {
    throw fallo('El servidor no puede guardar fotos (revisa los permisos de la carpeta uploads).');
  }
}

/** Borra una foto del disco. Solo acepta los nombres que genera procesarFoto() y SOLO las de la empresa actual. */
export async function borrarFoto(nombre: string | null | undefined, negocioId: number): Promise<void> {
  if (!nombre || !new RegExp(`^(?:${negocioId}/)?p_[a-f0-9]{16}\\.jpg$`).test(nombre)) return;
  try {
    await unlink(join(config.carpetaFotos, nombre));
  } catch {
    /* ya no estaba */
  }
}
