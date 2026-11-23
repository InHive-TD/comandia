/* Service worker mínimo: hace que el navegador ofrezca "Instalar aplicación". No guarda nada en caché: Comandia
   siempre muestra datos en vivo, así que todas las peticiones van directo a la red. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
