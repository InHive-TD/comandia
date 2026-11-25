/* Pantalla de entrada del personal: marca de la empresa, «usuario o correo» y ojito para ver la contraseña. */
(() => {
  const caja = document.getElementById('vista-login');
  if (!caja || caja.dataset.listo) return;
  caja.dataset.listo = '1';
  const marca = document.createElement('div');
  marca.className = 'ac-marca';
  const logo = document.createElement('img');
  logo.className = 'ac-logo'; logo.alt = ''; logo.src = '../api/logo.php';
  const nombre = document.createElement('h1'); nombre.className = 'ac-negocio';
  const sub = document.createElement('p'); sub.className = 'ac-sub'; sub.textContent = 'Inicia sesión para continuar';
  marca.append(logo, nombre, sub);
  caja.prepend(marca);

  const usuario = document.getElementById('login-usuario'), pass = document.getElementById('login-password');
  if (usuario) {
    usuario.setAttribute('autocomplete', 'username'); usuario.placeholder = 'tucorreo@ejemplo.com o tu usuario'; usuario.setAttribute('inputmode', 'email');
    const t = usuario.closest('label'); if (t && t.firstChild) t.firstChild.textContent = 'Correo o usuario';
  }
  if (pass) {
    pass.placeholder = '••••••••••';
    const envoltura = document.createElement('span'); envoltura.className = 'ac-campo';
    pass.parentNode.insertBefore(envoltura, pass); envoltura.append(pass);
    const ojo = document.createElement('button'); ojo.type = 'button'; ojo.className = 'ac-ojo'; ojo.textContent = '👁'; ojo.setAttribute('aria-label', 'Mostrar contraseña');
    ojo.addEventListener('click', () => { const ver = pass.type === 'password'; pass.type = ver ? 'text' : 'password'; ojo.textContent = ver ? '🙈' : '👁'; ojo.setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña'); });
    envoltura.append(ojo);
  }
  const boton = caja.querySelector('button[type="submit"]'); if (boton) boton.textContent = 'Entrar';
  const ayuda = document.createElement('p'); ayuda.className = 'ac-ayuda'; const enlaceOlvide = document.createElement('a'); enlaceOlvide.href = '../acceso/?olvide=1'; enlaceOlvide.textContent = '¿Olvidaste tu contraseña?'; ayuda.append(enlaceOlvide);
  const pie = document.createElement('p'); pie.className = 'ac-pie'; pie.innerHTML = 'Con tecnología de <b>Comandia</b>';
  caja.append(ayuda, pie);
  fetch('../api/sesion.php', { credentials: 'same-origin' }).then((r) => r.json()).then((s) => { if (s && s.negocio) nombre.textContent = s.negocio.nombre; }).catch(() => {});
})();
