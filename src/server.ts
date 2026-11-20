/**
 * Punto de entrada: prepara la base de datos, arranca el servidor HTTP y lo apaga limpiamente con Ctrl+C.
 * Se corre con `npm run dev` (desarrollo, se reinicia solo al guardar) o `npm start` (producción, tras `npm run build`).
 */
import { crearApp } from './app.js';
import { config } from './config.js';
import { cerrarBd } from './db.js';
import { asegurarEsquema } from './esquema.js';

const app = await crearApp();
try {
  await asegurarEsquema();
  await app.listen({ port: config.puerto, host: config.host });
} catch (err) {
  app.log.error(err);
  await cerrarBd();
  process.exit(1);
}

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    void app.close().then(cerrarBd).then(() => process.exit(0));
  });
}
