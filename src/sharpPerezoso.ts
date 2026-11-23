/**
 * sharp (procesamiento de imágenes) pesa ~20 MB de memoria solo por cargarlo, y se usa únicamente al subir una foto o
 * un logo. Se carga la primera vez que hace falta (no al arrancar) y se limita su caché e hilos para no saturar el hosting.
 */
import type { Sharp, SharpOptions } from 'sharp';

type FabricaSharp = (entrada?: Buffer | Uint8Array, opciones?: SharpOptions) => Sharp;

let cargado: Promise<FabricaSharp> | null = null;

export function cargarSharp(): Promise<FabricaSharp> {
  cargado ??= import('sharp').then(({ default: sharp }) => {
    sharp.cache({ memory: 32, files: 0, items: 20 });
    sharp.concurrency(1);
    return sharp as unknown as FabricaSharp;
  });
  return cargado;
}
