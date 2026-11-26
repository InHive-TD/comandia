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
  document.body.classList.toggle('en-panel', vista === 'vista-panel');   // en el panel, la barra lateral reemplaza al encabezado
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

/* ---- Mostrar/ocultar contraseña ---- */
$('login-ojo').addEventListener('click', () => {
  const campo = $('login-password');
  const ver = campo.type === 'password';
  campo.type = ver ? 'text' : 'password';
  $('login-ojo').textContent = ver ? '🙈' : '👁';
  $('login-ojo').setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
});

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
  $('usuario-nombre').textContent = usuario.nombre;
  const ini = (usuario.nombre || '?').trim().charAt(0).toUpperCase();
  $('usuario-ini').textContent = ini;
  $('usuario-ini-movil').textContent = ini;
  mostrar('vista-panel');
  await cargar();
  await cargarIntegraciones();
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

/* ---- Secciones de la barra lateral ---- */
function irA(sec) {
  for (const b of document.querySelectorAll('.menu-lateral [data-sec]')) {
    const activa = b.dataset.sec === sec;
    b.classList.toggle('activo', activa);
    if (activa) { $('titulo-seccion').textContent = b.dataset.titulo; b.setAttribute('aria-current', 'page'); } else b.removeAttribute('aria-current');
  }
  for (const x of document.querySelectorAll('.sec-plat')) x.hidden = x.id !== 'sec-' + sec;
  if (sec === 'sucursales') cargarSucursales();
  menuAbierto(false);
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('.menu-lateral [data-sec]')) b.addEventListener('click', () => irA(b.dataset.sec));

async function cargarSucursales() {
  const cont = $('lista-sucursales');
  let lista;
  try { lista = (await pedir(API + 'sucursales.php')).sucursales; } catch (err) { avisar(err.message, true); return; }
  cont.replaceChildren();
  if (!lista.length) { cont.append(el('p', 'ayuda', 'Aún no hay sucursales.')); return; }
  let actual = null;
  for (const x of lista) {
    if (x.negocio_id !== actual) {
      actual = x.negocio_id;
      cont.append(el('h3', 'grupo-empresa', x.negocio + (x.negocio_activo ? '' : ' (pausada)')));
    }
    const t = el('article', 'empresa' + (x.activa && x.negocio_activo ? '' : ' pausada'));
    const cab = el('div', 'empresa-cab');
    cab.append(el('h3', '', x.nombre), el('span', 'etiqueta-estado ' + (x.activa ? '' : 'pausada'), x.activa ? 'Activa' : 'Inactiva'));
    const cifras = el('div', 'cifras');
    cifras.append(el('span', '', `${x.mesas} mesa${x.mesas === 1 ? '' : 's'}`), el('span', '', `Hoy: ${x.pedidos_hoy} pedidos`));
    t.append(cab);
    if (x.direccion) t.append(el('p', 'nota', x.direccion));
    t.append(cifras);
    cont.append(t);
  }
}

/* ---- Lista ---- */
function dominioBase() {
  // Misma carpeta que la del panel de plataforma pero sin ella: https://dominio.mx/  (o http://localhost/comandia/)
  return location.origin + location.pathname.replace(/[^/]*\/?(index\.html)?$/, '');
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
    el('span', '', n.voz_activa ? 'Voz: activa' : 'Voz: apagada'),
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
  $('e-voz-caja').hidden = !n;
  $('e-admin-caja').hidden = !!n;
  $('e-slug').required = !n;
  if (n) {
    $('e-nombre').value = n.nombre;
    $('e-plan').value = n.plan;
    $('e-vence').value = n.vence_en || '';
    $('e-contacto').value = n.contacto || '';
    $('e-notas').value = n.notas || '';
    $('e-voz-activa').checked = !!n.voz_activa;
    $('e-voz-limite').value = n.voz_limite_tokens ?? '';
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
    ? { accion: 'editar', id: Number(id), ...base, voz_activa: $('e-voz-activa').checked, voz_limite_tokens: $('e-voz-limite').value.trim() }
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

/* ---- Integraciones: voz con IA (OpenRouter) ---- */
function pintarIntegraciones(e) {
  const est = $('int-estado');
  est.textContent = e.llave.ilegible ? 'La llave guardada no se pudo leer: guarda una nueva'
    : e.llave.configurada ? 'Configurada: sk-or-…' + e.llave.ultimos : 'Sin configurar';
  est.className = e.llave.configurada ? 'ok' : '';
  $('int-llave').value = '';
  $('int-modelo-ia').value = e.modelo_ia;
  $('int-modelo-stt').value = e.modelo_stt;
  $('int-limite').value = e.limite_diario;
  pintarPrecio('ia'); pintarPrecio('stt');
  $('int-activa').checked = e.activa;
}

async function cargarIntegraciones() {
  try {
    const e = await pedir(API + 'integraciones.php');
    pintarIntegraciones(e);
    if (e.llave.configurada) cargarModelos();
  } catch (err) { avisar(err.message, true); }
}

$('int-guardar-llave').addEventListener('click', async () => {
  const llave = $('int-llave').value.trim();
  if (!llave) { avisar('Pega primero la llave.', true); return; }
  try {
    pintarIntegraciones(await enviarJson(API + 'integraciones.php', { accion: 'guardar_llave', llave }));
    $('int-resultado').textContent = 'Llave guardada. Usa «Probar» para comprobar que funciona.';
    avisar('Llave guardada');
  } catch (err) { avisar(err.message, true); }
});

$('int-quitar').addEventListener('click', async () => {
  if (!(await confirmar('¿Quitar la llave de OpenRouter? La voz dejará de funcionar hasta que guardes otra.', { si: 'Quitar', peligro: true }))) return;
  try {
    pintarIntegraciones(await enviarJson(API + 'integraciones.php', { accion: 'quitar_llave' }));
    $('int-resultado').textContent = '';
    avisar('Llave quitada');
  } catch (err) { avisar(err.message, true); }
});

$('int-probar').addEventListener('click', async () => {
  const boton = $('int-probar');
  boton.disabled = true;
  $('int-resultado').textContent = 'Probando…';
  try {
    const r = await enviarJson(API + 'integraciones.php', { accion: 'probar' });
    const dinero = (n) => '$' + Number(n).toFixed(2);
    const partes = ['La llave funciona ✓'];
    if (r.limite !== null && r.limite !== undefined) partes.push('límite de la llave ' + dinero(r.limite));
    if (r.restante !== null && r.restante !== undefined) partes.push('restante ' + dinero(r.restante));
    if (r.gastado !== null && r.gastado !== undefined) partes.push('gastado ' + dinero(r.gastado));
    $('int-resultado').textContent = partes.join(' · ');
  } catch (err) {
    $('int-resultado').textContent = err.message;
  } finally { boton.disabled = false; }
});

$('int-guardar').addEventListener('click', async () => {
  try {
    pintarIntegraciones(await enviarJson(API + 'integraciones.php', {
      accion: 'ajustes', modelo_ia: $('int-modelo-ia').value.trim(), modelo_stt: $('int-modelo-stt').value.trim(),
      limite_diario: Number($('int-limite').value), activa: $('int-activa').checked,
    }));
    avisar('Ajustes guardados');
  } catch (err) { avisar(err.message, true); }
});

/* ---- Selector de modelos (se llena con la lista real de OpenRouter) ---- */
const modelosPorId = { ia: new Map(), stt: new Map() };
const usd = (n) => '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

function textoPrecio(m, esVoz) {
  if (!m) return '';
  if (esVoz && m.minuto !== null) return `${m.nombre} · ${usd(m.minuto)} por minuto de audio`;
  if (m.entrada !== null && m.salida !== null) return `${m.nombre} · ${usd(m.entrada)} entrada / ${usd(m.salida)} salida por millón de tokens`;
  return m.nombre;
}

function pintarPrecio(tipo) {
  const campo = tipo === 'ia' ? 'int-modelo-ia' : 'int-modelo-stt';
  const m = modelosPorId[tipo].get($(campo).value.trim());
  $(tipo === 'ia' ? 'int-precio-ia' : 'int-precio-stt').textContent = m ? textoPrecio(m, tipo === 'stt') : (modelosPorId[tipo].size ? 'Ese nombre no está en la lista de OpenRouter.' : '');
}

function llenarLista(tipo, modelos) {
  const dl = $(tipo === 'ia' ? 'lista-modelos-ia' : 'lista-modelos-stt');
  dl.replaceChildren();
  modelosPorId[tipo] = new Map(modelos.map((m) => [m.id, m]));
  for (const m of modelos) {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = textoPrecio(m, tipo === 'stt');
    dl.append(o);
  }
  pintarPrecio(tipo);
}

async function cargarModelos() {
  const boton = $('int-modelos');
  boton.disabled = true;
  $('int-resultado').textContent = 'Cargando modelos…';
  try {
    const r = await enviarJson(API + 'integraciones.php', { accion: 'modelos' });
    llenarLista('ia', r.ia);
    llenarLista('stt', r.stt);
    $('int-resultado').textContent = `${r.ia.length} modelos de IA y ${r.stt.length} de voz. Escribe en el campo para buscar y elige de la lista.`;
  } catch (err) { $('int-resultado').textContent = err.message; }
  finally { boton.disabled = false; }
}
$('int-modelos').addEventListener('click', cargarModelos);
$('int-modelo-ia').addEventListener('input', () => pintarPrecio('ia'));
$('int-modelo-stt').addEventListener('input', () => pintarPrecio('stt'));

$('btn-salir-menu').addEventListener('click', () => $('btn-salir').click());

/* Menú lateral como capa deslizable en celular y tablet vertical */
function menuAbierto(abrir) {
  document.body.classList.toggle('menu-abierto', abrir);
  $('btn-menu').setAttribute('aria-expanded', String(abrir));
  $('btn-menu').setAttribute('aria-label', abrir ? 'Cerrar menú' : 'Abrir menú');
}
$('btn-menu').addEventListener('click', () => menuAbierto(!document.body.classList.contains('menu-abierto')));
$('menu-velo').addEventListener('click', () => menuAbierto(false));
$('usuario-ini-movil').addEventListener('click', () => menuAbierto(true));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') menuAbierto(false); });

iniciar();
