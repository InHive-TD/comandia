/* Página del enlace del correo: confirma el correo y deja crear la contraseña. */
(() => {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('t') || '';
  const API = '../api/';
  const malo = (txt) => { $('ac-sub').textContent = ''; $('ac-form').hidden = true; $('ac-malo').hidden = false; $('ac-malo-txt').textContent = txt; };
  async function json(url, opciones) {
    const r = await fetch(url, { credentials: 'same-origin', ...opciones });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.mensaje || 'Ocurrió un error. Inténtalo de nuevo.');
    return d;
  }
  fetch(API + 'sesion.php').then((r) => r.json()).then((s) => { if (s.negocio) $('ac-negocio').textContent = s.negocio.nombre; }).catch(() => {});
  const olvide = new URLSearchParams(location.search).get('olvide') === '1';
  if (!token && olvide) {
    document.title = 'Restablecer contraseña · Comandia';
    $('ac-sub').textContent = 'Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva.';
    $('ol-form').hidden = false; $('ol-correo').focus();
    $('ol-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      $('ol-error').textContent = ''; $('ol-enviar').disabled = true;
      try {
        const d = await json(API + 'acceso/olvide.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correo: $('ol-correo').value.trim() }) });
        $('ol-form').hidden = true; $('ac-sub').textContent = ''; $('ol-txt').textContent = d.mensaje; $('ol-listo').hidden = false;
      } catch (e) { $('ol-error').textContent = e.message; $('ol-enviar').disabled = false; }
    });
    return;
  }
  // Sin código no hay nada que confirmar: quien entra a esta dirección a secas viene a iniciar sesión.
  if (!token) { location.replace('/' + location.pathname.split('/').filter(Boolean)[0] + '/login/'); return; }
  json(API + 'acceso/enlace.php?t=' + encodeURIComponent(token)).then((d) => {
    $('ac-sub').textContent = `Hola ${d.nombre}, ${d.tipo === 'restablecer' ? 'crea tu contraseña nueva.' : 'confirma tu correo creando tu contraseña.'}`;
    $('ac-form').hidden = false; $('ac-p1').focus();
  }).catch((e) => malo(e.message));

  const revisar = () => {
    const a = $('ac-p1').value, b = $('ac-p2').value;
    $('r-largo').classList.toggle('ok', [...a].length >= 10);
    $('r-igual').classList.toggle('ok', a !== '' && a === b);
  };
  $('ac-p1').addEventListener('input', revisar); $('ac-p2').addEventListener('input', revisar);
  $('ac-ojo').addEventListener('click', () => { const ver = $('ac-p1').type === 'password'; $('ac-p1').type = ver ? 'text' : 'password'; $('ac-p2').type = ver ? 'text' : 'password'; $('ac-ojo').textContent = ver ? '🙈' : '👁'; });
  $('ac-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('ac-error').textContent = '';
    if ($('ac-p1').value !== $('ac-p2').value) { $('ac-error').textContent = 'Las contraseñas no coinciden.'; return; }
    $('ac-enviar').disabled = true;
    try {
      const d = await json(API + 'acceso/clave.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, password: $('ac-p1').value }) });
      $('ac-ir').href = '../' + (d.destino || 'admin/');
      $('ac-form').hidden = true; $('ac-sub').textContent = ''; $('ac-exito').hidden = false;
    } catch (e) { $('ac-error').textContent = e.message; $('ac-enviar').disabled = false; }
  });
})();
