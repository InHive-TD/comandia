/*
 * Avisos en vivo: el servidor avisa cuando algo cambia y la pantalla recarga en ese momento, en lugar de preguntar cada
 * pocos segundos. Si la conexión no da señales de vida (algunos servidores la cortan o la retienen), la pantalla vuelve
 * sola al sondeo de siempre, así que nunca se queda sin actualizarse.
 *
 *   const live = suscribirCambios(recargar, { respaldoMs: 2500 });
 *   live.detener();  // al salir de la pantalla
 *
 * Con la conexión sana, además hace una recarga de seguridad cada 60 s por si se perdió algún aviso.
 */
function suscribirCambios(alCambiar, { respaldoMs = 5000, url = 'eventos', seguridadMs = 60000 } = {}) {
  let es = null, ultimaSenal = 0, activo = true, timerRespaldo = null, timerSeguridad = null, vigilante = null, sano = false;

  const hayPantalla = () => !document.hidden;
  const pedir = () => { if (activo && hayPantalla()) alCambiar(); };

  function ponerRespaldo(on) {
    if (on && !timerRespaldo) timerRespaldo = setInterval(pedir, respaldoMs);
    if (!on && timerRespaldo) { clearInterval(timerRespaldo); timerRespaldo = null; }
  }
  function estaSano(on) {
    if (on === sano) return;
    sano = on;
    ponerRespaldo(!on);
    if (on && !timerSeguridad) timerSeguridad = setInterval(pedir, seguridadMs);
    if (!on && timerSeguridad) { clearInterval(timerSeguridad); timerSeguridad = null; }
  }
  function conectar() {
    if (!activo || typeof EventSource === 'undefined') return;
    es = new EventSource(url);
    es.onmessage = (ev) => {
      ultimaSenal = Date.now();
      if (ev.data === 'hola') { estaSano(true); pedir(); }
      else if (ev.data === 'cambio') pedir();
    };
    es.onerror = () => { estaSano(false); };   // EventSource reintenta solo
  }

  ponerRespaldo(true);            // hasta que haya conexión sana, se pregunta como antes
  conectar();
  vigilante = setInterval(() => { if (sano && Date.now() - ultimaSenal > 45000) estaSano(false); }, 10000);
  const alVolver = () => { if (!document.hidden) pedir(); };
  document.addEventListener('visibilitychange', alVolver);

  return {
    detener() {
      activo = false;
      if (es) es.close();
      clearInterval(timerRespaldo); clearInterval(timerSeguridad); clearInterval(vigilante);
      document.removeEventListener('visibilitychange', alVolver);
    },
  };
}
