// Hostinger (LiteSpeed) carga el archivo de entrada con require().
// dist/server.js es ESM con await de nivel superior, así que este puente lo importa como ESM.
import('./dist/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
