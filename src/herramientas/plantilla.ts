/**
 * Genera la plantilla de carga masiva de platillos que se guarda en el repositorio (plantillas/plantilla-platillos.xlsx).
 * Trae listas de ejemplo; la que se descarga desde el portal de administración trae las listas REALES de cada empresa.
 *
 * Uso:  npm run plantilla
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generarPlantilla } from '../importacion.js';

const buffer = await generarPlantilla({
  categorias: ['Tacos', 'Tortas', 'Bebidas', 'Entradas', 'Postres'],
  parrillas: ['Parrilla', 'Plancha', 'Freidora'],
  extras: [
    { nombre: 'Queso', codigo: 'QSO', grupo: 'Agregar' },
    { nombre: 'Aguacate', codigo: 'AGU', grupo: 'Agregar' },
    { nombre: 'Sin cebolla', codigo: null, grupo: 'Quitar' },
  ],
});
const carpeta = fileURLToPath(new URL('../../plantillas/', import.meta.url));
await mkdir(carpeta, { recursive: true });
await writeFile(carpeta + 'plantilla-platillos.xlsx', buffer);
console.log('Plantilla guardada en plantillas/plantilla-platillos.xlsx');
process.exit(0);
