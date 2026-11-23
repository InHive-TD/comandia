/* Permite instalar Comandia como aplicación (acceso directo en el celular, tablet o computadora). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
