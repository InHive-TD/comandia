/*
 * Entrada única del personal: /<empresa>/login/. Se inicia sesión una sola vez y cada quien llega a su pantalla
 * según su rol. La sesión es la misma de las demás pantallas, así que al llegar ya está dentro.
 */
const API = '../api/';
const PANTALLA_POR_ROL = {
  admin: 'admin/',
  gerente: 'admin/',
  caja: 'caja/',
  mesero: 'pedidos/',
  taquero: 'cocina/',
};

function mostrarVista(id) {
  for (const v of ['vista-login', 'vista-aviso']) $(v).hidden = v !== id;
}

function irAPantalla(usuario) {
  const destino = PANTALLA_POR_ROL[usuario.rol];
  if (!destino) {
    $('aviso-titulo').textContent = 'Tu usuario no tiene una pantalla asignada';
    $('aviso-texto').textContent = 'Pide al administrador que revise tu rol.';
    mostrarVista('vista-aviso');
    return;
  }
  location.replace('../' + destino);
}

async function iniciar() {
  try {
    const s = await pedir(API + 'sesion.php');
    fijarCsrf(s.csrf);
    if (s.negocio && s.negocio.nombre) $('titulo-negocio').textContent = s.negocio.nombre;
    if (s.autenticado) irAPantalla(s.usuario); else mostrarVista('vista-login');
  } catch (err) {
    $('aviso-titulo').textContent = 'No se pudo iniciar';
    $('aviso-texto').textContent = err.message;
    mostrarVista('vista-aviso');
  }
}

$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const boton = ev.target.querySelector('button[type="submit"]');
  $('login-msg').textContent = '';
  boton.disabled = true;
  try {
    const r = await enviarJson(API + 'login.php', { usuario: $('login-usuario').value.trim(), password: $('login-password').value });
    $('login-password').value = '';
    fijarCsrf(r.csrf);
    irAPantalla(r.usuario);
  } catch (err) {
    $('login-msg').textContent = err.message;
  } finally {
    boton.disabled = false;
  }
});

iniciar();
