/**
 * Panel de plataforma: alta y control de las empresas que contratan Comandia.
 * Usa las funciones de js/comun.js (el, pedir, enviarJson, confirmar, fijarCsrf).
 */

const API = '../api/plataforma/';
const $ = (id) => document.getElementById(id);

let negocios = [];

function mostrar(vista) {
  for (const id of ['vista-login', 'vista-aviso', 'vista-panel']) $(id).hidden = id !== vista;
  $('btn-salir').hidden = vista === 'vista-login';
}

let temporizadorAviso;
function avisar(texto, esError = false) {
  const t = $('toast');
  t.textContent = texto;
  t.className = 'toast' + (esError ? ' error' : '');
  t.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { t.hidden = true; }, 3500);
}

function mostrarAviso(titulo, texto) {
  $('aviso-titulo').textContent = titulo;
  $('aviso-texto').textContent = texto;
  mostrar('vista-aviso');
}

/* ---- Sesión ---- */
async function iniciar() {
  try {
    const s = await pedir(API + 'sesion.php');
    fijarCsrf(s.csrf);
    if (s.autenticado) await entrar(s.usuario); else mostrar('vista-login');
  } catch (err) {
    mostrarAviso('No se pudo iniciar', err.message);
  }
}

async function entrar(usuario) {
  $('quien').textContent = usuario.nombre;
  mostrar('vista-panel');
  await cargar();
}

$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('login-msg');
  const boton = ev.target.querySelector('button[type="submit"]');
  msg.textContent = '';
  boton.disabled = true;
  try {
    const r = await enviarJson(API + 'login.php', { usuario: $('login-usuario').value.trim(), password: $('login-password').value });
    fijarCsrf(r.csrf);
    $('login-password').value = '';
    await entrar(r.usuario);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    boton.disabled = false;
  }
});

$('btn-salir').addEventListener('click', async () => {
  try { await enviarJson(API + 'logout.php', {}); } catch { /* da igual */ }
  location.reload();
});

/* ---- Lista ---- */
function dominioBase() {
  // Misma carpeta que /plataforma/ pero sin ella: https://dominio.mx/  (o http://localhost/comandia/)
  return location.origin + location.pathname.replace(/plataforma\/?(index\.html)?$/, '');
}

function estadoDe(n) {
  if (!n.activo) return { clase: 'pausada', texto: 'Pausada' };
  if (n.vence_en && n.vence_en < new Date().toISOString().slice(0, 10)) return { clase: 'vencida', texto: 'Vencida' };
  return { clase: '', texto: 'Activa' };
}

async function cargar() {
  try {
    negocios = (await pedir(API + 'negocios.php')).negocios;
  } catch (err) {
    avisar(err.message, true);
    return;
  }
  const activas = negocios.filter((n) => n.activo).length;
  const resumen = $('resumen');
  resumen.replaceChildren();
  for (const [valor, texto] of [[negocios.length, 'empresas'], [activas, 'activas'], [negocios.reduce((a, n) => a + n.pedidos_hoy, 0), 'pedidos hoy'], [negocios.reduce((a, n) => a + n.pedidos_30d, 0), 'pedidos en 30 días']]) {
    const d = el('div', 'dato');
    d.append(el('b', '', String(valor)), el('span', '', texto));
    resumen.append(d);
  }

  const lista = $('lista');
  lista.replaceChildren();
  if (!negocios.length) {
    lista.append(el('p', 'ayuda', 'Aún no hay empresas. Pulsa “Nueva empresa” para dar de alta la primera.'));
    return;
  }
  for (const n of negocios) lista.append(tarjeta(n));
}

function tarjeta(n) {
  const est = estadoDe(n);
  const t = el('article', 'empresa' + (n.activo ? '' : ' pausada'));

  const cab = el('div', 'empresa-cab');
  cab.append(el('h3', '', n.nombre), el('span', 'etiqueta-estado ' + est.clase, est.texto));
  const url = dominioBase() + n.slug + '/';
  const enlace = el('a', 'enlace', url);
  enlace.href = url;
  enlace.target = '_blank';
  enlace.rel = 'noopener';

  const cifras = el('div', 'cifras');
  cifras.append(
    el('span', '', `Plan: ${n.plan}`),
    el('span', '', `${n.sucursales} sucursal${n.sucursales === 1 ? '' : 'es'}`),
    el('span', '', `${n.usuarios} usuario${n.usuarios === 1 ? '' : 's'}`),
    el('span', '', `Hoy: ${n.pedidos_hoy} pedidos`),
    el('span', '', `30 días: ${n.pedidos_30d}`),
    el('span', '', n.vence_en ? `Vence: ${n.vence_en}` : 'Sin vencimiento'),
  );

  const acciones = el('div', 'acciones');
  const bEditar = el('button', 'btn', 'Editar');
  bEditar.type = 'button';
  bEditar.addEventListener('click', () => abrirEmpresa(n));
  const bEstado = el('button', 'btn', n.activo ? 'Pausar' : 'Reactivar');
  bEstado.type = 'button';
  bEstado.addEventListener('click', () => cambiarEstado(n));
  const bClave = el('button', 'btn', 'Nueva contraseña del admin');
  bClave.type = 'button';
  bClave.addEventListener('click', () => nuevaClave(n));
  acciones.append(bEditar, bEstado, bClave);

  t.append(cab, enlace, cifras);
  if (n.contacto) t.append(el('div', 'nota', 'Contacto: ' + n.contacto));
  if (n.notas) t.append(el('div', 'nota', n.notas));
  t.append(acciones);
  return t;
}

async function cambiarEstado(n) {
  const pausar = n.activo;
  const ok = await confirmar(pausar
    ? `¿Pausar “${n.nombre}”? Nadie de esa empresa podrá entrar ni pedir hasta que la reactives. No se borra nada.`
    : `¿Reactivar “${n.nombre}”?`, { si: pausar ? 'Pausar' : 'Reactivar', peligro: pausar });
  if (!ok) return;
  try {
    await enviarJson(API + 'negocios.php', { accion: 'estado', id: n.id, activo: !pausar });
    avisar(pausar ? 'Empresa pausada' : 'Empresa reactivada');
    await cargar();
  } catch (err) { avisar(err.message, true); }
}

async function nuevaClave(n) {
  const clave = await pedirTexto(`Nueva contraseña para el administrador de “${n.nombre}” (mínimo 10 caracteres):`, { si: 'Cambiar', minimo: 10 });
  if (clave === null) return;
  try {
    const r = await enviarJson(API + 'negocios.php', { accion: 'clave_admin', id: n.id, password: clave });
    avisar(`Contraseña cambiada (usuario: ${r.usuario})`);
  } catch (err) { avisar(err.message, true); }
}

/* ---- Alta / edición ---- */
function abrirEmpresa(n = null) {
  $('form-empresa').reset();
  $('e-error').textContent = '';
  $('e-id').value = n ? n.id : '';
  $('e-titulo').textContent = n ? 'Editar empresa' : 'Nueva empresa';
  $('e-slug-caja').hidden = !!n;
  $('e-admin-caja').hidden = !!n;
  $('e-slug').required = !n;
  if (n) {
    $('e-nombre').value = n.nombre;
    $('e-plan').value = n.plan;
    $('e-vence').value = n.vence_en || '';
    $('e-contacto').value = n.contacto || '';
    $('e-notas').value = n.notas || '';
  } else {
    $('e-plan').value = 'basico';
    pintarVistaSlug();
  }
  $('dlg-empresa').showModal();
}

function pintarVistaSlug() {
  const slug = $('e-slug').value.trim().toLowerCase();
  $('e-slug-vista').textContent = dominioBase() + (slug || 'lavale') + '/';
}

function sugerirSlug(nombre) {
  return nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
}

let slugEditadoAMano = false;
$('e-slug').addEventListener('input', () => { slugEditadoAMano = true; pintarVistaSlug(); });
$('e-nombre').addEventListener('input', () => {
  if (!$('e-id').value && !slugEditadoAMano) { $('e-slug').value = sugerirSlug($('e-nombre').value); pintarVistaSlug(); }
});
$('btn-nueva').addEventListener('click', () => { slugEditadoAMano = false; abrirEmpresa(); });
$('e-cancelar').addEventListener('click', () => $('dlg-empresa').close());

$('form-empresa').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('e-id').value;
  const base = {
    nombre: $('e-nombre').value.trim(), plan: $('e-plan').value.trim() || 'basico', vence_en: $('e-vence').value,
    contacto: $('e-contacto').value.trim(), notas: $('e-notas').value.trim(),
  };
  const cuerpo = id
    ? { accion: 'editar', id: Number(id), ...base }
    : { accion: 'crear', slug: $('e-slug').value.trim().toLowerCase(), admin_nombre: $('e-admin-nombre').value.trim(),
        admin_usuario: $('e-admin-usuario').value.trim().toLowerCase(), admin_password: $('e-admin-password').value, ...base };
  const boton = $('e-guardar');
  boton.disabled = true;
  $('e-error').textContent = '';
  try {
    const r = await enviarJson(API + 'negocios.php', cuerpo);
    $('dlg-empresa').close();
    avisar(id ? 'Empresa actualizada' : `Empresa creada: ${dominioBase()}${r.slug}/`);
    await cargar();
  } catch (err) {
    $('e-error').textContent = err.message;
  } finally {
    boton.disabled = false;
  }
});

iniciar();
