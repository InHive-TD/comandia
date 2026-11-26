import { randomBytes } from 'node:crypto';
import { copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { Tx } from './db.js';

/**
 * Copia la carta general de la empresa (platillos con sucursal_id NULL) a una sucursal, como platillos PROPIOS de ella.
 * Se copian también los extras de cada platillo y sus prioridades en cocina. Cada foto se copia a un archivo nuevo
 * (así borrar o cambiar la foto en una sucursal no afecta a las demás). El código rápido NO se copia: es único en toda
 * la empresa, así que cada sucursal asigna los suyos. Devuelve cuántos platillos se copiaron y las fotos nuevas
 * (para borrarlas si la operación falla).
 */
export async function copiarCartaGeneral(tx: Tx, negocioId: number, sucursalId: number, fotosNuevas: string[]): Promise<number> {
  const origen = await tx.filas(
    `SELECT id, categoria_id, nombre, descripcion, precio, foto, disponible, codigo_cocina, pedir_opciones, opciones_obligatorias,
            grupo_obligatorio, max_carnes, porcion, estacion_id, orden
       FROM productos WHERE negocio_id = ? AND sucursal_id IS NULL ORDER BY id`,
    [negocioId],
  );
  for (const p of origen) {
    let foto: string | null = null;
    const f = p['foto'] ? String(p['foto']) : '';
    if (new RegExp(`^(?:${negocioId}/)?p_[a-f0-9]{16}\\.jpg$`).test(f)) {
      const nombre = `${negocioId}/p_${randomBytes(8).toString('hex')}.jpg`;
      try {
        await copyFile(join(config.carpetaFotos, f), join(config.carpetaFotos, nombre));
        foto = nombre;
        fotosNuevas.push(nombre);
      } catch { foto = null; /* la foto original ya no estaba: el platillo se copia sin foto */ }
    }
    const r = await tx.ejecutar(
      `INSERT INTO productos (negocio_id, categoria_id, nombre, descripcion, precio, foto, disponible, codigo, codigo_cocina, pedir_opciones,
                              opciones_obligatorias, grupo_obligatorio, max_carnes, porcion, estacion_id, sucursal_id, orden)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [negocioId, p['categoria_id'], p['nombre'], p['descripcion'], p['precio'], foto, p['disponible'], p['codigo_cocina'], p['pedir_opciones'],
       p['opciones_obligatorias'], p['grupo_obligatorio'], p['max_carnes'], p['porcion'], p['estacion_id'], sucursalId, p['orden']],
    );
    const nuevo = r.insertId;
    await tx.ejecutar('INSERT INTO producto_extras (producto_id, extra_id, precio) SELECT ?, extra_id, precio FROM producto_extras WHERE producto_id = ?', [nuevo, p['id']]);
    await tx.ejecutar('INSERT INTO prioridades (estacion_id, producto_id, nivel) SELECT estacion_id, ?, nivel FROM prioridades WHERE producto_id = ?', [nuevo, p['id']]);
  }
  return origen.length;
}

export async function borrarFotosCopiadas(nombres: string[]): Promise<void> {
  for (const n of nombres) { try { await unlink(join(config.carpetaFotos, n)); } catch { /* ya no estaba */ } }
}
