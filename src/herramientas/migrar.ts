/**
 * Herramienta de línea de comandos: pasa una base de datos de la versión anterior (UN solo negocio) a Comandia.
 *
 *   npm run migrar -- lavale "Los Tacos D'La Vale"
 *
 * Usa la base indicada en tu archivo .env. Lo que ya existe se convierte en el PRIMER negocio.
 * Haz una copia de seguridad de la base antes (HeidiSQL → Exportar).
 */
import { cerrarBd } from '../db.js';
import { migrarAMultinegocio } from '../migracion.js';

const [slug, ...resto] = process.argv.slice(2);
const nombre = resto.join(' ');
if (!slug || !nombre) {
  console.error('Uso:  npm run migrar -- <direccion> "<Nombre del negocio>"\nEjemplo:  npm run migrar -- lavale "Los Tacos D\'La Vale"');
  process.exit(1);
}
try {
  for (const linea of await migrarAMultinegocio(slug.toLowerCase(), nombre)) console.log('•', linea);
  console.log(`\nListo. Siguiente paso: npm run crear-plataforma (si aún no tienes usuario de plataforma) y arranca con npm run dev → /${slug.toLowerCase()}/`);
} catch (e) {
  console.error('No se pudo migrar:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cerrarBd();
}
