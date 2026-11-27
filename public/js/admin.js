/**
 * Panel de administración: login, productos (con foto, código, porción,
 * parrilla y extras), categorías, extras y parrillas.
 * Usa las funciones de js/comun.js (el, pedir, enviarJson, dinero, fijarCsrf).
 */

const API = '../api/';
const RUTA_FOTOS = '../uploads/';

let productos = [];
let sucursalesCarta = [];   // solo el dueño: sucursales para elegir de cuál ver/editar la carta
let filtroCarta = '';       // '' = todas · 'general' = solo la carta general · '<id>' = platillos propios de esa sucursal

/** Los platillos que se muestran según la carta elegida (el dueño ve todo o la de una sucursal; el gerente ya recibe solo lo suyo). */
function vistaProductos() {
  if (esGerente || filtroCarta === '') return productos;
  if (filtroCarta === 'general') return productos.filter((p) => p.sucursal_id === null);
  return productos.filter((p) => p.sucursal_id === Number(filtroCarta));
}
let categorias = [];
let estaciones = [];
let extras = [];
let gruposExtras = [];            // secciones de extras (Quitar, Aparte, Solo...) en el orden elegido
let gruposExtrasInfo = [];    // [{nombre, sucursal_id, propio}]: de quién es cada sección

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/*  Utilidades de pantalla                                             */
/* ------------------------------------------------------------------ */

function mostrar(vista) {
  for (const id of ['vista-login', 'vista-aviso', 'vista-panel']) {
    $(id).hidden = id !== vista;
  }
  $('btn-salir').hidden = vista === 'vista-login';
  document.body.classList.toggle('en-panel', vista === 'vista-panel');   // en el panel, la barra lateral reemplaza al encabezado
}

let temporizadorAviso;
function avisar(texto, esError = false) {
  const toast = $('toast');
  toast.textContent = texto;
  toast.className = 'toast' + (esError ? ' error' : '');
  toast.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { toast.hidden = true; }, 3500);
}

function mostrarAviso(titulo, texto) {
  $('aviso-titulo').textContent = titulo;
  $('aviso-texto').textContent = texto;
  mostrar('vista-aviso');
}

/* ------------------------------------------------------------------ */
/*  Sesión                                                             */
/* ------------------------------------------------------------------ */

async function iniciar() {
  try {
    const s = await pedir(API + 'sesion.php');
    fijarCsrf(s.csrf);
    if (s.autenticado) {
      await entrar(s.usuario);
    } else {
      mostrar('vista-login');
    }
  } catch (err) {
    mostrarAviso('No se pudo iniciar', err.message);
  }
}

let esGerente = false;   // el gerente ve solo su sucursal y no toca lo de toda la empresa

async function entrar(usuario) {
  $('quien').textContent = usuario.nombre;
  if (usuario.rol !== 'admin' && usuario.rol !== 'gerente') {
    mostrarAviso('Sin permiso', 'Tu usuario no puede administrar el catálogo. Entra con una cuenta de administrador o de gerente.');
    return;
  }
  esGerente = usuario.rol === 'gerente';
  pintarUsuario(usuario);
  for (const id of ['btn-categorias', 'btn-apariencia']) { const b = $(id); if (b) b.hidden = esGerente; }
  $('btn-sucursales').textContent = esGerente ? 'Mi sucursal' : 'Sucursales';
  document.querySelector('.menu-desp[data-grupo="sucursales"] .nav-sum').textContent = esGerente ? 'Mi sucursal y mesas' : 'Sucursales y mesas';
  $('btn-sucursales').dataset.titulo = esGerente ? 'Mi sucursal y mesas' : 'Sucursales y mesas';
  mostrar('vista-panel');
  if (typeof iniciarInventario === 'function') await iniciarInventario();
  await cargarCatalogo();
  // Entra a la sección de la dirección (#usuarios…) si es válida y permitida; si no, al Inicio (reportes)
  const pedida = RUTAS[seccionDeLaDireccion()] && $(RUTAS[seccionDeLaDireccion()]);
  (pedida && !pedida.hidden ? pedida : $('btn-reportes')).click();
}

/** Barra lateral: usuario abajo (iniciales, nombre y rol) y, arriba a la derecha, la sucursal con la que se trabaja. */
let perfil = { nombre: '', rol: '', foto: null, iniciales: '?' };

/** Pone la foto (o las iniciales) en los tres avatares: menú lateral, barra del celular y ventana de perfil. */
function pintarAvatares() {
  for (const id of ['usuario-ini', 'usuario-ini-movil', 'perfil-avatar']) {
    const a = $(id);
    if (perfil.foto) { a.style.backgroundImage = `url("${RUTA_FOTOS + encodeURIComponent(perfil.foto)}")`; a.textContent = ''; a.classList.add('con-foto'); }
    else { a.style.backgroundImage = ''; a.textContent = perfil.iniciales; a.classList.remove('con-foto'); }
  }
  $('perfil-quitar').hidden = !perfil.foto;
}

function pintarUsuario(usuario) {
  const partes = String(usuario.nombre || '').trim().split(/\s+/).filter(Boolean);
  perfil.iniciales = ((partes[0] || '?')[0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
  perfil.nombre = String(usuario.nombre || '').trim();
  perfil.rol = usuario.rol === 'gerente' ? 'Gerente de sucursal' : 'Administrador';
  perfil.foto = usuario.foto || null;
  // Arriba el puesto (Administrador) y abajo el nombre de la persona
  $('usuario-nombre').textContent = perfil.rol;
  $('usuario-rol').textContent = perfil.nombre;
  $('usuario-rol').hidden = perfil.nombre.toLowerCase() === perfil.rol.toLowerCase();
  $('perfil-rol').textContent = perfil.rol;
  $('perfil-nombre').textContent = perfil.nombre;
  pintarAvatares();
  const chip = $('chip-sucursal');
  chip.hidden = true;
  pedir(API + 'sesion.php').then((s) => {
    if (s.usuario && s.usuario.foto !== undefined && s.usuario.foto !== perfil.foto) { perfil.foto = s.usuario.foto; pintarAvatares(); }
    if (s.negocio) $('menu-negocio').textContent = s.negocio.nombre;
    const propia = usuario.rol === 'gerente' && (s.sucursales || []).find((x) => x.id === s.sucursal);
    chip.textContent = propia ? propia.nombre : (s.sucursales && s.sucursales.length > 1 ? 'Todas las sucursales' : ((s.sucursales || [])[0] || {}).nombre || '');
    chip.hidden = !chip.textContent;
  }).catch(() => { /* la barra funciona igual sin el nombre de la sucursal */ });
}

/* Mi perfil: cualquier usuario cambia o quita su propia foto tocando su avatar */
const dlgPerfil = $('dlg-perfil');
function abrirPerfil() { $('perfil-error').textContent = ''; menuAbierto(false); dlgPerfil.showModal(); }
$('usuario-ini').addEventListener('click', abrirPerfil);
$('perfil-cerrar').addEventListener('click', () => dlgPerfil.close());
$('perfil-cambiar').addEventListener('click', () => $('perfil-archivo').click());
async function enviarPerfil(datos) {
  $('perfil-error').textContent = '';
  try {
    const r = await pedir(API + 'perfil/foto.php', { method: 'POST', body: datos });
    perfil.foto = r.foto;
    pintarAvatares();
    avisar(r.foto ? 'Foto actualizada' : 'Foto quitada');
  } catch (err) { $('perfil-error').textContent = err.message; }
}
$('perfil-archivo').addEventListener('change', async () => {
  const archivo = $('perfil-archivo').files[0];
  $('perfil-archivo').value = '';
  if (!archivo) return;
  const datos = new FormData();
  datos.append('accion', 'subir');
  datos.append('foto', archivo);
  $('perfil-cambiar').disabled = true;
  await enviarPerfil(datos);
  $('perfil-cambiar').disabled = false;
});
$('perfil-quitar').addEventListener('click', () => { const d = new FormData(); d.append('accion', 'quitar'); enviarPerfil(d); });

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
document.querySelector('.menu-lateral').addEventListener('click', (ev) => { if (ev.target.closest('.nav-ico')) menuAbierto(false); });
window.matchMedia('(min-width: 901px)').addEventListener('change', (m) => { if (m.matches) menuAbierto(false); });

$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('login-msg');
  const boton = ev.target.querySelector('button[type="submit"]');
  msg.textContent = '';
  boton.disabled = true;
  try {
    const r = await enviarJson(API + 'login.php', {
      usuario: $('login-usuario').value.trim(),
      password: $('login-password').value,
    });
    $('login-password').value = '';
    fijarCsrf(r.csrf);
    await entrar(r.usuario);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    boton.disabled = false;
  }
});

$('btn-salir').addEventListener('click', async () => {
  try {
    await pedir(API + 'logout.php', { method: 'POST' });
  } catch { /* si falla, igual se vuelve a pedir la sesión */ }
  productos = [];
  categorias = [];
  estaciones = [];
  extras = [];
  await iniciar();
});

/* ------------------------------------------------------------------ */
/*  Catálogo                                                           */
/* ------------------------------------------------------------------ */

async function cargarCatalogo() {
  try {
    const r = await pedir(API + 'admin/productos.php');
    productos = r.productos;
    categorias = r.categorias;
    estaciones = r.estaciones;
    extras = r.extras;
    gruposExtras = r.grupos_extras || [];
    gruposExtrasInfo = r.grupos_extras_info || [];
    if (!esGerente) {
      try { sucursalesCarta = (await pedir(API + 'admin/sucursales.php')).sucursales.filter((x) => x.activa); } catch { /* sin selector */ }
      pintarFiltroCarta();
    }
    pintarLista();
  } catch (err) {
    if (err.estado === 401) { await iniciar(); return; }
    avisar(err.message, true);
  }
}

function pintarFiltroCarta() {
  const sel = $('filtro-carta');
  $('filtro-carta-caja').hidden = esGerente || sucursalesCarta.length < 2;
  sel.replaceChildren(new Option('Todas las cartas', ''), new Option('Carta general (la de toda la empresa)', 'general'));
  for (const s of sucursalesCarta) sel.append(new Option('Platillos propios de ' + s.nombre + (s.carta_propia ? ' · carta propia' : ''), String(s.id)));
  if (![...sel.options].some((o) => o.value === filtroCarta)) filtroCarta = '';
  sel.value = filtroCarta;
}
$('filtro-carta').addEventListener('change', () => { filtroCarta = $('filtro-carta').value; pintarLista(); });

function pintarLista() {
  const lista = $('lista');
  lista.replaceChildren();
  $('barra-expandir').replaceChildren();

  const vista = vistaProductos();
  if (vista.length === 0) {
    lista.append(el('p', 'vacio',
      categorias.length === 0
        ? 'Empieza creando una categoría (botón “Categorías de platillos”) y luego agrega tu primer platillo.'
        : (productos.length > 0 ? 'Esta carta aún no tiene platillos propios. Toca “Nuevo platillo” o “Importar desde Excel” para agregarlos.' : 'Aún no hay platillos. Toca “Nuevo platillo” para agregar el primero.')));
    return;
  }

  // Productos agrupados por categoría, cada grupo expandible/colapsable. Los que no pertenecen a ninguna
  // categoría conocida van al final en "Otros".
  const grupos = categorias.map((c) => ({ clave: String(c.id), nombre: c.nombre, items: vista.filter((p) => p.categoria_id === c.id) }));
  const conocidas = new Set(categorias.map((c) => c.id));
  const otros = vista.filter((p) => !conocidas.has(p.categoria_id));
  if (otros.length) grupos.push({ clave: 'otros', nombre: 'Otros', items: otros });
  const visibles = grupos.filter((g) => g.items.length);
  // Primera vez en este navegador: se abre solo la primera categoría para no mostrar todo cerrado
  if (!yaGuardoAbiertas() && visibles.length) { categoriasAbiertas.add(visibles[0].clave); guardarAbiertas(); }

  // Barra con "Expandir todo / Colapsar todo"
  const barra = $('barra-expandir');
  const todo = el('button', 'btn chico', 'Expandir todo');
  todo.type = 'button';
  todo.addEventListener('click', () => { for (const g of visibles) categoriasAbiertas.add(g.clave); guardarAbiertas(); pintarLista(); });
  const nada = el('button', 'btn chico', 'Colapsar todo');
  nada.type = 'button';
  nada.addEventListener('click', () => { categoriasAbiertas.clear(); guardarAbiertas(); pintarLista(); });
  barra.append(todo, nada);

  for (const g of visibles) {
    const det = el('details', 'cat-grupo');
    det.open = categoriasAbiertas.has(g.clave);
    const resumen = el('summary', 'cat-resumen');
    resumen.append(el('span', 'cat-nombre', g.nombre), el('span', 'chip', g.items.length === 1 ? '1 platillo' : `${g.items.length} platillos`));
    // Botón "Agregar platillo" de la categoría (solo se ve con la categoría abierta, arriba a la derecha)
    if (g.clave !== 'otros') {
      const agregar = el('button', 'btn chico principal cat-agregar', '＋ Agregar platillo');
      agregar.type = 'button';
      agregar.title = `Agregar un platillo a ${g.nombre}`;
      agregar.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); abrirFormulario(null, Number(g.clave)); });
      resumen.append(agregar);
    }
    det.append(resumen);
    const rejilla = el('div', 'rejilla');
    for (const p of g.items) rejilla.append(tarjeta(p));
    det.append(rejilla);
    det.addEventListener('toggle', () => { if (det.open) categoriasAbiertas.add(g.clave); else categoriasAbiertas.delete(g.clave); guardarAbiertas(); });
    lista.append(det);
  }
}

/* Qué categorías están abiertas: se recuerda en este navegador (solo es una comodidad visual). */
const CLAVE_ABIERTAS = `cmd_cats_abiertas_${slugActual()}`;
const categoriasAbiertas = new Set((() => { try { return JSON.parse(localStorage.getItem(CLAVE_ABIERTAS) || '[]'); } catch { return []; } })());
function yaGuardoAbiertas() { try { return localStorage.getItem(CLAVE_ABIERTAS) !== null; } catch { return true; } }
function guardarAbiertas() { try { localStorage.setItem(CLAVE_ABIERTAS, JSON.stringify([...categoriasAbiertas])); } catch { /* sin almacenamiento: no pasa nada */ } }

function tarjeta(p) {
  const card = el('article', 'prod' + (p.disponible ? '' : ' agotado'));

  const foto = el('div', 'prod-foto');
  if (p.foto) {
    const img = document.createElement('img');
    img.src = RUTA_FOTOS + encodeURIComponent(p.foto);
    img.alt = p.nombre;
    img.loading = 'lazy';
    foto.append(img);
  } else {
    foto.classList.add('vacia');
    foto.append(el('span', 'sin-foto', '🌮'));
  }

  const info = el('div', 'prod-info');
  const general = esGerente && !p.propio;     // producto de la carta general: el gerente solo lo oculta o le cambia el precio
  const precioVisible = general && p.precio_sucursal != null ? p.precio_sucursal : p.precio;
  info.append(el('h3', '', p.nombre), el('p', 'prod-cat', p.categoria), el('p', 'prod-precio', dinero.format(precioVisible)));

  const etiquetas = el('div', 'etiquetas');
  if (p.codigo) etiquetas.append(el('span', 'chip codigo-chip', p.codigo));
  if (esGerente) etiquetas.append(el('span', 'chip', p.propio ? '⭐ Propio de mi sucursal' : '🌐 Carta general'));
  else if (p.sucursal) etiquetas.append(el('span', 'chip', '📍 Solo ' + p.sucursal));
  if (general && p.oculto) etiquetas.append(el('span', 'chip sin', 'Oculto en mi sucursal'));
  if (general && p.precio_sucursal != null) etiquetas.append(el('span', 'chip', 'Precio general: ' + dinero.format(p.precio)));
  if (p.porcion) etiquetas.append(el('span', 'chip', p.porcion));
  if (p.extras.length) etiquetas.append(el('span', 'chip', p.extras.length === 1 ? '1 modificador' : `${p.extras.length} modificadores`));
  info.append(etiquetas);

  const acciones = el('div', 'prod-acciones');
  if (general) {
    acciones.append(controlesSucursal(p));
    card.append(foto, info, acciones);
    return card;
  }
  const editar = el('button', 'btn', 'Editar');
  editar.type = 'button';
  editar.addEventListener('click', () => abrirFormulario(p));
  const mismos = vistaProductos().filter((x) => x.categoria_id === p.categoria_id);
  const idx = mismos.findIndex((x) => x.id === p.id);
  const mover = el('div', 'mover');
  mover.append(botonMover('▲', 'Subir platillo', idx <= 0, () => moverProducto(p, -1)), botonMover('▼', 'Bajar platillo', idx === mismos.length - 1, () => moverProducto(p, 1)));
  acciones.append(interruptor(p), editar, mover);

  card.append(foto, info, acciones);
  return card;
}

/** Carta general, vista del gerente: ocultar el producto o ponerle otro precio solo en su sucursal. */
function controlesSucursal(p) {
  const caja = el('div', 'ajuste-sucursal');
  const etiquetaOculto = el('label', 'casilla');
  const oculto = document.createElement('input');
  oculto.type = 'checkbox';
  oculto.checked = !!p.oculto;
  etiquetaOculto.append(oculto, el('span', '', 'Ocultar en mi sucursal'));
  const precio = document.createElement('input');
  precio.type = 'text'; precio.inputMode = 'decimal';
  precio.placeholder = 'Precio general ' + dinero.format(p.precio);
  precio.setAttribute('aria-label', 'Precio en mi sucursal');
  precio.value = p.precio_sucursal != null ? Number(p.precio_sucursal).toFixed(2) : '';
  const guardar = el('button', 'btn', 'Guardar');
  guardar.type = 'button';
  guardar.addEventListener('click', async () => {
    const datos = new FormData();
    datos.append('accion', 'ajuste_sucursal');
    datos.append('id', String(p.id));
    datos.append('oculto', oculto.checked ? '1' : '0');
    datos.append('precio', precio.value.trim());
    guardar.disabled = true;
    try {
      const r = await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
      p.oculto = r.oculto;
      p.precio_sucursal = r.precio_sucursal;
      avisar('Guardado para tu sucursal');
      pintarLista();
    } catch (err) {
      guardar.disabled = false;
      avisar(err.message, true);
    }
  });
  caja.append(etiquetaOculto, precio, guardar);
  return caja;
}

function interruptor(p) {
  const etiqueta = el('label', 'switch');
  const casilla = document.createElement('input');
  casilla.type = 'checkbox';
  casilla.checked = p.disponible;
  const deslizador = el('span', 'slider');
  const texto = el('span', '', p.disponible ? 'Disponible' : 'Agotado');

  casilla.addEventListener('change', async () => {
    casilla.disabled = true;
    const datos = new FormData();
    datos.append('accion', 'disponibilidad');
    datos.append('id', String(p.id));
    datos.append('disponible', casilla.checked ? '1' : '0');
    try {
      await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
      p.disponible = casilla.checked;
      pintarLista();
    } catch (err) {
      casilla.checked = !casilla.checked;
      casilla.disabled = false;
      avisar(err.message, true);
    }
  });

  etiqueta.append(casilla, deslizador, texto);
  return etiqueta;
}

/* ------------------------------------------------------------------ */
/*  Formulario de producto                                             */
/* ------------------------------------------------------------------ */

/** Opción obligatoria: el interruptor muestra la lista de secciones (Carne, Quitar…) de la que hay que elegir; vacío = cualquier opción. */
function pintarGrupoObligatorio(actual) {
  const secciones = [...new Set([...gruposExtras, ...extras.map((x) => x.grupo).filter(Boolean)])];
  const sel = $('f-grupo-oblig');
  sel.replaceChildren(new Option('Cualquier opción', ''), ...secciones.map((g) => new Option(g, g)));
  sel.value = secciones.includes(actual) ? actual : '';
  alCambiarObligatoria();
}
function alCambiarObligatoria() {
  const obligatoria = $('f-obligatoria').checked;
  $('f-grupo-fila').hidden = !obligatoria;
  if (obligatoria) $('f-pedir').checked = true;   // si es obligatoria, las opciones se abren siempre
  $('f-pedir').disabled = obligatoria;
}
$('f-obligatoria').addEventListener('change', alCambiarObligatoria);

/** Casillas con los extras (los desactivados se muestran solo si el producto los tiene). */
function pintarExtrasProducto(marcados, precios = {}) {
  const caja = $('f-extras');
  caja.replaceChildren();
  const visibles = extras.filter((x) => x.activo || marcados.includes(x.id));
  if (visibles.length === 0) {
    caja.append(el('p', 'vacio ayuda', 'Aún no hay modificadores. Créalos con el botón “Modificadores”.'));
    return;
  }
  const grupos = new Map(gruposExtras.map((g) => [g, []]));   // secciones en el orden que eligió el dueño
  for (const x of visibles) {
    const g = x.grupo && grupos.has(x.grupo) ? x.grupo : 'Otros';
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  for (const [g, lista] of [...grupos].filter(([, l]) => l.length)) {
    // Encabezado de sección con acceso rápido: marcar / quitar toda la sección en este platillo
    const cab = el('div', 'grupo-cab');
    cab.append(el('p', 'grupo-titulo', g));
    const todos = el('button', 'btn-mini', 'Todos');
    todos.type = 'button';
    const ninguno = el('button', 'btn-mini', 'Ninguno');
    ninguno.type = 'button';
    cab.append(todos, ninguno);
    caja.append(cab);
    const filas = [];
    for (const x of lista) {
      const fila = el('label', 'casilla fila-extra-prod');
      const caja_ = document.createElement('input');
      caja_.type = 'checkbox';
      caja_.value = String(x.id);
      caja_.checked = marcados.includes(x.id);
      const texto = el('span', '', (x.codigo ? `${x.codigo} · ` : '') + x.nombre + ' ');
      texto.append(el('small', '', x.precio > 0 ? `+${dinero.format(x.precio)}` : 'sin costo'));
      // Precio propio en ESTE platillo (vacío = usa el precio general del extra)
      const precio = document.createElement('input');
      precio.type = 'number';
      precio.min = '0';
      precio.step = '0.50';
      precio.className = 'precio-extra-prod';
      precio.placeholder = `$ ${x.precio}`;
      precio.title = 'Precio de este modificador solo en este platillo (vacío = precio general)';
      precio.dataset.extra = String(x.id);
      if (precios[x.id] !== undefined) precio.value = String(precios[x.id]);
      const sync = () => { precio.hidden = !caja_.checked; };
      caja_.addEventListener('change', sync);
      sync();
      fila.append(caja_, texto, precio);
      caja.append(fila);
      filas.push([caja_, sync]);
    }
    todos.addEventListener('click', () => filas.forEach(([c, sync]) => { c.checked = true; sync(); }));
    ninguno.addEventListener('click', () => filas.forEach(([c, sync]) => { c.checked = false; sync(); }));
  }
}


/* ------------------------------------------------------------------ */
/*  Secciones como páginas (en vez de ventanas)                        */
/* ------------------------------------------------------------------ */
// Cada sección del menú lateral es un <dialog class="pagina"> mostrado en el área de contenido (sin ventana flotante).
// Solo hay una abierta a la vez; al cerrarla se vuelve a la lista de productos.
const paginasPortal = [...document.querySelectorAll('dialog.pagina')];
for (const d of paginasPortal) $('panel-contenido').append(d);   // dentro del área de contenido, junto a la lista

/* Grupos desplegables del menú (Cliente / Pedidos / Cocina): se recuerda cuáles están abiertos y el de la sección activa se abre solo */
const CLAVE_DESP = 'comandia_menu_desp';
const despAbiertos = (() => { try { return new Set(JSON.parse(localStorage.getItem(CLAVE_DESP) || '[]')); } catch { return new Set(); } })();
function pintarDesp(g) {
  const abierto = despAbiertos.has(g.dataset.grupo);
  g.classList.toggle('abierto', abierto);
  g.querySelector('.nav-sum').setAttribute('aria-expanded', String(abierto));
}
document.querySelectorAll('.menu-desp').forEach((g) => {
  pintarDesp(g);
  g.querySelector('.nav-sum').addEventListener('click', () => {
    const k = g.dataset.grupo;
    if (despAbiertos.has(k)) despAbiertos.delete(k); else despAbiertos.add(k);
    try { localStorage.setItem(CLAVE_DESP, JSON.stringify([...despAbiertos])); } catch { /* sin almacenamiento */ }
    pintarDesp(g);
  });
});

function marcarMenu(idBoton) {
  for (const b of document.querySelectorAll('.menu-lateral .nav-ico')) b.classList.toggle('activo', b.id === idBoton);
  document.querySelectorAll('.menu-desp').forEach((g) => {
    const dentro = !!idBoton && !!g.querySelector('#' + idBoton);
    g.classList.toggle('tiene-activo', dentro);
    if (dentro && !despAbiertos.has(g.dataset.grupo)) { despAbiertos.add(g.dataset.grupo); pintarDesp(g); }   // el grupo de la sección abierta se despliega solo
  });
  const activo = $(idBoton);   // el nombre de la sección seleccionada se muestra en la barra superior
  if (activo) $('titulo-seccion').textContent = activo.dataset.titulo || activo.textContent.trim();
}

/** Muestra una sección como página: cierra la que estuviera abierta y oculta la lista de productos. */
/* Cada sección tiene su propia dirección: /<empresa>/admin/usuarios, /extras… (Inicio es solo /<empresa>/admin/).
   Se puede recargar, guardar en favoritos y usar "atrás". Las direcciones no llevan "#". */
const RUTAS = { inicio: 'btn-reportes', platillos: 'btn-productos', categorias: 'btn-categorias', extras: 'btn-extras', 'carga-masiva': 'btn-carga', sucursales: 'btn-sucursales', usuarios: 'btn-usuarios', 'ajustes-cocina': 'btn-prioridades', 'ajustes-pedidos': 'btn-pedidos-qr', 'ajustes-pago': 'btn-pago', 'ajustes-caja': 'btn-caja-cfg', 'ajustes-plano': 'btn-plano', 'ajustes-toma': 'btn-toma-pedidos', 'ajustes-carriles': 'btn-carriles', apariencia: 'btn-apariencia', inventario: 'btn-inventario' };
const BASE_ADMIN = location.pathname.replace(/\/admin(\/.*)?$/, '/admin/');   // "/lavale/admin/"
const seccionDeLaDireccion = () => {
  const n = (location.pathname.startsWith(BASE_ADMIN) ? location.pathname.slice(BASE_ADMIN.length).replace(/\/+$/, '') : '') || 'inicio';
  return n === 'ajustes' ? 'ajustes-cocina' : n;   // "ajustes" era la dirección anterior de Cocina
};
let rutaActual = seccionDeLaDireccion();
function fijarRuta(idBoton) {
  const nombre = Object.keys(RUTAS).find((k) => RUTAS[k] === idBoton);
  if (!nombre || nombre === rutaActual) return;
  rutaActual = nombre;
  if (seccionDeLaDireccion() === nombre) return;   // la dirección ya es la de esta sección (carga directa o botón "atrás"): no se agrega otra entrada
  history.pushState({ seccion: nombre }, '', nombre === 'inicio' ? BASE_ADMIN : BASE_ADMIN + nombre);
}
window.addEventListener('popstate', () => {
  const nombre = seccionDeLaDireccion();
  const b = RUTAS[nombre] && $(RUTAS[nombre]);
  if (!b || b.hidden || nombre === rutaActual) return;
  b.click();
});
let volverA = 'inicio';   // a dónde regresa al cerrar una página: 'platillos' (formulario y categorías) o 'inicio' (reportes)
function abrirPagina(dlg, idBoton) {
  volverA = (dlg === dlgProducto || dlg === dlgCategorias || dlg.id === 'dlg-carga') ? 'platillos' : 'inicio';
  for (const o of paginasPortal) if (o !== dlg && o.open) o.close();
  $('vista-platillos').hidden = true;
  if (!dlg.open) dlg.show();          // show() = no modal
  fijarRuta(dlg === dlgProducto ? 'btn-productos' : idBoton);
  marcarMenu(idBoton === 'btn-categorias' || idBoton === 'btn-carga' ? 'btn-productos' : idBoton);   // Categorías de platillos cuelga de Platillos
  window.scrollTo({ top: 0 });
}

// Al cerrarse una página, si ya no queda ninguna abierta se regresa a Productos
for (const d of paginasPortal) d.addEventListener('close', () => {
  if (paginasPortal.some((o) => o.open)) return;
  if (volverA === 'platillos') { $('vista-platillos').hidden = false; marcarMenu('btn-productos'); fijarRuta('btn-productos'); }
  else $('btn-reportes').click();   // sin nada abierto se vuelve a Inicio (reportes)
});
// "Platillos" del menú: cierra la página abierta y muestra la lista de platillos
$('btn-productos').addEventListener('click', () => {
  volverA = 'platillos';
  const abiertas = paginasPortal.filter((o) => o.open);
  if (abiertas.length) abiertas.forEach((o) => o.close());
  else { $('vista-platillos').hidden = false; marcarMenu('btn-productos'); }
  fijarRuta('btn-productos');
  window.scrollTo({ top: 0 });
});

const dlgProducto = $('dlg-producto');
const formProducto = $('form-producto');
let urlVistaPrevia = null;

function limpiarVistaPrevia() {
  if (urlVistaPrevia) URL.revokeObjectURL(urlVistaPrevia);
  urlVistaPrevia = null;
}

function ponerVistaPrevia(url) {
  const img = $('f-vista');
  if (url) { img.src = url; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
}

/** Abre el formulario de platillo. Con categoriaId (botón de una categoría) el platillo nuevo ya viene en esa categoría. */
function abrirFormulario(p = null, categoriaId = null) {
  formProducto.reset();
  limpiarVistaPrevia();
  $('f-error').textContent = '';
  $('f-id').value = p ? String(p.id) : '';
  const sucDestino = !p && !esGerente && /^\d+$/.test(filtroCarta) ? sucursalesCarta.find((x) => String(x.id) === filtroCarta) : null;
  $('dlg-titulo').textContent = p ? 'Editar platillo' : (sucDestino ? 'Nuevo platillo · solo en ' + sucDestino.nombre : 'Nuevo platillo');

  const select = $('f-categoria');
  select.replaceChildren(...categorias.map((c) => new Option(c.nombre, String(c.id))));
  if (categorias.length === 0) {
    $('f-error').textContent = 'Primero crea una categoría (botón “Categorías de platillos”).';
  }

  pintarExtrasProducto(p ? p.extras : extras.filter((x) => x.todos && x.activo).map((x) => x.id), p ? p.extras_precios || {} : {});   // un platillo nuevo trae marcados los que van en todos

  if (p) {
    $('f-codigo').value = p.codigo || '';
    $('f-porcion').value = p.porcion || '';
    $('f-nombre').value = p.nombre;
    select.value = String(p.categoria_id);
    $('f-precio').value = p.precio.toFixed(2);
    $('f-descripcion').value = p.descripcion || '';
    $('f-disponible').checked = p.disponible;
    $('f-pedir').checked = !!p.pedir_opciones;
    $('f-obligatoria').checked = !!p.opciones_obligatorias;
    pintarGrupoObligatorio(p.grupo_obligatorio || '');
    ponerVistaPrevia(p.foto ? RUTA_FOTOS + encodeURIComponent(p.foto) : null);
  } else {
    if (categoriaId !== null) select.value = String(categoriaId);
    $('f-disponible').checked = true;
    $('f-pedir').checked = false;
    $('f-obligatoria').checked = false;
    pintarGrupoObligatorio('');
    ponerVistaPrevia(null);
  }

  $('f-quitar-fila').hidden = !(p && p.foto);
  $('f-eliminar').hidden = !p;
  $('f-eliminar').dataset.nombre = p ? p.nombre : '';
  abrirPagina(dlgProducto, 'btn-productos');
}

$('btn-nuevo').addEventListener('click', () => abrirFormulario());
$('f-cancelar').addEventListener('click', () => dlgProducto.close());
dlgProducto.addEventListener('close', limpiarVistaPrevia);

$('f-foto').addEventListener('change', () => {
  limpiarVistaPrevia();
  const archivo = $('f-foto').files[0];
  if (archivo) {
    urlVistaPrevia = URL.createObjectURL(archivo);
    ponerVistaPrevia(urlVistaPrevia);
    $('f-quitar').checked = false;
  }
});

/**
 * Reduce la foto en el propio celular/tablet antes de enviarla:
 * sube más rápido, gasta menos datos y el servidor trabaja menos.
 * (El servidor la vuelve a revisar y procesar de todos modos.)
 */
async function reducirImagen(archivo, ladoMax = 1200, calidad = 0.85) {
  if (!archivo.type.startsWith('image/')) return archivo;
  try {
    const bmp = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
    const escala = Math.min(1, ladoMax / Math.max(bmp.width, bmp.height));
    const ancho = Math.max(1, Math.round(bmp.width * escala));
    const alto = Math.max(1, Math.round(bmp.height * escala));

    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ancho, alto);
    ctx.drawImage(bmp, 0, 0, ancho, alto);
    if (bmp.close) bmp.close();

    const blob = await new Promise((resolver) => lienzo.toBlob(resolver, 'image/jpeg', calidad));
    return blob || archivo;
  } catch {
    return archivo;   // si el navegador no puede, se manda tal cual y el servidor decide
  }
}

formProducto.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const error = $('f-error');
  const guardar = $('f-guardar');
  error.textContent = '';
  guardar.disabled = true;
  guardar.textContent = 'Guardando…';

  try {
    const id = $('f-id').value;
    const datos = new FormData();
    datos.append('accion', id ? 'actualizar' : 'crear');
    if (id) datos.append('id', id);
    else if (!esGerente && /^\d+$/.test(filtroCarta)) datos.append('sucursal_id', filtroCarta);   // el dueño crea en la carta de la sucursal elegida
    datos.append('nombre', $('f-nombre').value.trim());
    datos.append('categoria_id', $('f-categoria').value);
    datos.append('precio', $('f-precio').value.trim());
    datos.append('descripcion', $('f-descripcion').value.trim());
    datos.append('disponible', $('f-disponible').checked ? '1' : '0');
    datos.append('pedir_opciones', $('f-pedir').checked ? '1' : '0');
    datos.append('opciones_obligatorias', $('f-obligatoria').checked ? '1' : '0');
    datos.append('grupo_obligatorio', $('f-obligatoria').checked ? $('f-grupo-oblig').value : '');
    datos.append('codigo', $('f-codigo').value.trim());
    datos.append('porcion', $('f-porcion').value.trim());
    datos.append('extras', [...$('f-extras').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value).join(','));
    // Precios propios de este platillo: solo los extras marcados que tengan un precio escrito
    const preciosExtra = {};
    for (const i of $('f-extras').querySelectorAll('input.precio-extra-prod')) {
      if (!i.hidden && i.value.trim() !== '') preciosExtra[i.dataset.extra] = i.value.trim();
    }
    datos.append('precios_extra', JSON.stringify(preciosExtra));
    if ($('f-quitar').checked) datos.append('quitar_foto', '1');

    const archivo = $('f-foto').files[0];
    if (archivo) {
      datos.append('foto', await reducirImagen(archivo), 'foto.jpg');
    }

    await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
    categoriasAbiertas.add($('f-categoria').value); guardarAbiertas();   // al volver, esa categoría se ve abierta con el platillo
    dlgProducto.close();
    await cargarCatalogo();
    avisar('Platillo guardado');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    guardar.disabled = false;
    guardar.textContent = 'Guardar';
  }
});

$('f-eliminar').addEventListener('click', async () => {
  const id = $('f-id').value;
  const nombre = $('f-eliminar').dataset.nombre;
  if (!id || !(await confirmar(`¿Eliminar “${nombre}”? Esta acción no se puede deshacer.\n\nLas ventas anteriores no se alteran. Si solo se acabó por hoy, mejor márcalo como Agotado.`, { si: 'Eliminar', peligro: true }))) return;

  const datos = new FormData();
  datos.append('accion', 'eliminar');
  datos.append('id', id);
  try {
    await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
    dlgProducto.close();
    await cargarCatalogo();
    avisar('Producto eliminado');
  } catch (err) {
    $('f-error').textContent = err.message;
  }
});

/* ------------------------------------------------------------------ */
/*  Categorías                                                         */
/* ------------------------------------------------------------------ */

const dlgCategorias = $('dlg-categorias');

function pintarCategorias() {
  const caja = $('lista-categorias');
  caja.replaceChildren();

  if (categorias.length === 0) {
    caja.append(el('p', '', 'Todavía no hay categorías. Agrega la primera arriba (por ejemplo, Tacos).'));
    return;
  }

  categorias.forEach((c, idx) => {
    const fila = el('div', 'fila-categoria');
    const mover = el('div', 'mover');
    // ⤒ al principio · ▲ subir uno · ▼ bajar uno · ⤓ al final
    mover.append(
      botonMover('⤒', 'Mandar hasta arriba', idx === 0, () => moverCategoria(idx, -idx)),
      botonMover('▲', 'Subir categoría', idx === 0, () => moverCategoria(idx, -1)),
      botonMover('▼', 'Bajar categoría', idx === categorias.length - 1, () => moverCategoria(idx, 1)),
      botonMover('⤓', 'Mandar hasta abajo', idx === categorias.length - 1, () => moverCategoria(idx, categorias.length - 1 - idx)),
    );

    const nombre = document.createElement('input');
    nombre.type = 'text';
    nombre.maxLength = 60;
    nombre.value = c.nombre;
    nombre.setAttribute('aria-label', 'Nombre de la categoría');

    const guardar = el('button', 'btn', 'Guardar');
    guardar.type = 'button';
    guardar.addEventListener('click', () => accionCategoria({ accion: 'renombrar', id: c.id, nombre: nombre.value.trim() }, 'Categoría actualizada'));

    const borrar = el('button', 'btn peligro', 'Eliminar');
    borrar.type = 'button';
    borrar.addEventListener('click', async () => {
      if (await confirmar(`¿Eliminar la categoría de platillos “${c.nombre}”?` + (c.productos ? ` Tiene ${c.productos} platillo${c.productos === 1 ? '' : 's'}; el servidor no la borrará mientras los tenga.` : ''), { si: 'Eliminar', peligro: true })) {
        accionCategoria({ accion: 'eliminar', id: c.id }, 'Categoría eliminada');
      }
    });

    fila.append(mover, nombre, guardar, borrar, el('span', 'cuenta', c.productos === 1 ? '1 platillo' : `${c.productos} platillos`));
    caja.append(fila);
  });
}

function botonMover(texto, etiqueta, desactivado, alClic) {
  const b = el('button', 'btn mover-btn', texto);
  b.type = 'button';
  b.title = etiqueta;
  b.setAttribute('aria-label', etiqueta);
  b.disabled = desactivado;
  b.addEventListener('click', alClic);
  return b;
}

async function moverCategoria(idx, delta) {
  const ids = categorias.map((c) => c.id);
  const j = idx + delta;
  if (j < 0 || j >= ids.length || delta === 0) return;
  // Se saca la categoría de su lugar y se inserta en el nuevo (sirve igual para un paso que para ir al extremo)
  const [movida] = ids.splice(idx, 1);
  ids.splice(j, 0, movida);
  await accionCategoria({ accion: 'ordenar', ids }, 'Orden de categorías guardado');
}

async function moverProducto(p, delta) {
  const mismos = vistaProductos().filter((x) => x.categoria_id === p.categoria_id);
  const idx = mismos.findIndex((x) => x.id === p.id);
  const j = idx + delta;
  if (idx < 0 || j < 0 || j >= mismos.length) return;
  const ids = mismos.map((x) => x.id);
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  const datos = new FormData();
  datos.append('accion', 'ordenar');
  ids.forEach((id) => datos.append('ids[]', String(id)));
  try {
    await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
    await cargarCatalogo();
  } catch (err) { avisar(err.message, true); }
}

async function accionCategoria(cuerpo, mensajeOk) {
  $('c-error').textContent = '';
  try {
    await enviarJson(API + 'admin/categorias.php', cuerpo);
    await cargarCatalogo();
    pintarCategorias();
    avisar(mensajeOk);
  } catch (err) {
    $('c-error').textContent = err.message;
  }
}

$('btn-categorias').addEventListener('click', () => {
  $('c-error').textContent = '';
  pintarCategorias();
  abrirPagina(dlgCategorias, 'btn-categorias');
});
$('c-cerrar').addEventListener('click', () => dlgCategorias.close());

$('form-nueva-categoria').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const campo = $('c-nueva');
  await accionCategoria({ accion: 'crear', nombre: campo.value.trim() }, 'Categoría creada');
  if (!$('c-error').textContent) campo.value = '';
});

/* ------------------------------------------------------------------ */
/*  Usuarios del equipo                                                */
/* ------------------------------------------------------------------ */

const dlgUsuarios = $('dlg-usuarios');
const ROL_TEXTO = { admin: 'Administrador', gerente: 'Gerente', caja: 'Caja', mesero: 'Mesero', taquero: 'Cocina' };
const ROLES_ORDEN = ['mesero', 'caja', 'taquero', 'gerente'];

/**
 * "También trabaja en": casillas con las demás sucursales (solo las ve el dueño). La principal se elige en el selector
 * de al lado y su casilla se desactiva sola. Devuelve { caja, valor() } con las sucursales adicionales marcadas.
 */
function casillasSucursalesExtra(sucursales, selPrincipal, marcadas) {
  const caja = el('div', 'us-extra');
  caja.append(el('span', 'ayuda', 'También trabaja en (podrá cambiar de sucursal desde la pantalla):'));
  const fila = el('div', 'lote-lista');
  const casillas = [];
  for (const s of sucursales) {
    const f = el('label', 'lote-op');
    const x = document.createElement('input');
    x.type = 'checkbox'; x.value = String(s.id); x.checked = marcadas.includes(s.id);
    casillas.push(x);
    f.append(x, el('span', '', s.nombre));
    fila.append(f);
  }
  caja.append(fila);
  const sincronizar = () => casillas.forEach((x) => { const esPrincipal = x.value === selPrincipal.value; x.disabled = esPrincipal; if (esPrincipal) x.checked = false; });
  selPrincipal.addEventListener('change', sincronizar);
  sincronizar();
  return { caja, valor: () => casillas.filter((x) => x.checked && !x.disabled).map((x) => Number(x.value)) };
}

let extraNuevo = null;   // casillas del formulario "Nuevo usuario"

async function cargarUsuarios() {
  const r = await pedir(API + 'admin/usuarios.php');
  const ROLES_PERSONAL = ROLES_ORDEN.filter((v) => r.roles.includes(v)).map((v) => [v, ROL_TEXTO[v]]);
  const selRol = $('us-rol');
  const rolPrevio = selRol.value;
  selRol.replaceChildren();
  for (const [v, t] of ROLES_PERSONAL) { const o = document.createElement('option'); o.value = v; o.textContent = v === 'gerente' ? 'Gerente (administra su sucursal)' : t; selRol.append(o); }
  if (rolPrevio && r.roles.includes(rolPrevio)) selRol.value = rolPrevio;
  const sel = $('us-sucursal');
  const previa = sel.value;
  sel.replaceChildren();
  for (const s of r.sucursales) { const o = document.createElement('option'); o.value = String(s.id); o.textContent = s.nombre; sel.append(o); }
  if (previa) sel.value = previa;
  // Solo el dueño (que ve más de una sucursal) asigna sucursales adicionales.
  const hayVarias = r.sucursales.length > 1;
  const marcadasPrevias = extraNuevo ? extraNuevo.valor() : [];
  $('us-extra-caja').replaceChildren();
  $('us-extra-caja').hidden = !hayVarias;
  extraNuevo = null;
  if (hayVarias) {
    extraNuevo = casillasSucursalesExtra(r.sucursales, sel, marcadasPrevias);
    $('us-extra-caja').append(...extraNuevo.caja.childNodes);
  }
  // ---- Lista jerárquica y colapsada: Administración → cada sucursal (gerente, caja, mesero, cocina) ----
  const caja = $('lista-usuarios');
  caja.replaceChildren();
  usuariosCtx = { r, ROLES_PERSONAL, hayVarias };
  const JERARQUIA = ['gerente', 'caja', 'mesero', 'taquero'];       // orden dentro de cada sucursal
  const porRol = (a, b) => (JERARQUIA.indexOf(a.rol) - JERARQUIA.indexOf(b.rol)) || a.nombre.localeCompare(b.nombre, 'es');

  const duenos = r.usuarios.filter((u) => u.rol === 'admin');
  if (duenos.length) caja.append(grupoUsuarios('dueno', '👑 Administración de la empresa', duenos, r, false));
  const sinSucursal = r.usuarios.filter((u) => u.rol !== 'admin' && !r.sucursales.some((s) => s.id === u.sucursal_id));
  for (const s of r.sucursales) {
    const gente = r.usuarios.filter((u) => u.rol !== 'admin' && u.sucursal_id === s.id).sort(porRol);
    caja.append(grupoUsuarios('s' + s.id, '📍 ' + s.nombre, gente, r, true));
  }
  if (sinSucursal.length) caja.append(grupoUsuarios('sin', 'Sin sucursal asignada', sinSucursal.sort(porRol), r, true));
}

let usuariosCtx = null;                 // datos de la última carga (para la ventana de edición)
const usuariosAbiertos = new Set();     // grupos expandidos (por defecto todos colapsados)

/** Un grupo (administración o sucursal) con sus renglones compactos; las sucursales se expanden/colapsan. */
function grupoUsuarios(clave, titulo, gente, r, colapsable) {
  const det = el('details', 'us-grupo');
  det.open = !colapsable || usuariosAbiertos.has(clave);
  const resumen = el('summary', 'us-grupo-resumen');
  const activos = gente.filter((u) => u.activo).length;
  resumen.append(el('span', 'cat-nombre', titulo), el('span', 'chip', `${gente.length} persona${gente.length === 1 ? '' : 's'}`));
  if (activos !== gente.length) resumen.append(el('span', 'chip sin', `${gente.length - activos} desactivada${gente.length - activos === 1 ? '' : 's'}`));
  det.append(resumen);
  if (!colapsable) resumen.classList.add('fijo');
  if (gente.length === 0) det.append(el('p', 'ayuda us-vacio', 'Aún no hay personas en esta sucursal.'));
  for (const u of gente) det.append(renglonUsuario(u, r));
  if (colapsable) det.addEventListener('toggle', () => { if (det.open) usuariosAbiertos.add(clave); else usuariosAbiertos.delete(clave); });
  else det.addEventListener('click', (ev) => { if (ev.target.closest('summary')) ev.preventDefault(); });   // el grupo del dueño siempre visible
  return det;
}

/** Renglón compacto: nombre, usuario, rol, estado y botón Editar. */
function renglonUsuario(u, r) {
  const fila = el('div', 'us-renglon' + (u.activo ? '' : ' inactivo'));
  const quien = el('div', 'us-quien');
  quien.append(el('strong', '', u.nombre), el('span', 'ayuda', u.correo || '@' + u.usuario));
  const chips = el('div', 'us-chips');
  chips.append(el('span', 'chip rol-' + u.rol, ROL_TEXTO[u.rol]));
  const extra = (u.sucursales_extra || []).map((id) => (r.sucursales.find((x) => x.id === id) || {}).nombre).filter(Boolean);
  if (extra.length) chips.append(el('span', 'chip', '+ ' + extra.join(' + ')));
  if (u.id === r.yo) chips.append(el('span', 'chip', 'Tú'));
  if (u.pendiente) chips.append(el('span', 'chip sin', '✉ Pendiente de crear contraseña'));
  if (u.bloqueado) chips.append(el('span', 'chip sin', '🔒 Bloqueado'));
  else if (u.bloqueo_temporal) chips.append(el('span', 'chip sin', '⏳ Bloqueo temporal'));
  chips.append(el('span', 'chip ' + (u.activo ? 'activo' : 'sin'), u.activo ? '● Activo' : 'Desactivado'));
  const desbloquear = (u.bloqueado || u.bloqueo_temporal) ? el('button', 'btn chico', '🔓 Desbloquear') : null;
  if (desbloquear) {
    desbloquear.type = 'button';
    desbloquear.addEventListener('click', async () => {
      try { await enviarJson(API + 'admin/usuarios.php', { accion: 'desbloquear', id: u.id }); avisar(u.nombre + ' ya puede iniciar sesión'); await cargarUsuarios(); }
      catch (err) { avisar(err.message, true); }
    });
  }
  if (!x.propio) {
    // Modificador general visto por un gerente: solo se puede deshabilitar en su sucursal, no editar ni quitar.
    const alterna = el('button', 'btn chico', x.deshabilitado ? 'Habilitar en mi sucursal' : 'Deshabilitar en mi sucursal');
    alterna.type = 'button';
    alterna.addEventListener('click', () => accionExtra({ accion: 'sucursal_deshabilitar', id: x.id, deshabilitar: !x.deshabilitado }, x.deshabilitado ? 'Modificador habilitado en tu sucursal' : 'Modificador deshabilitado en tu sucursal'));
    const candado = el('button', 'btn chico', '🔒');
    candado.type = 'button'; candado.title = 'No puedes editarlo ni quitarlo porque no fue creado por ti';
    candado.addEventListener('click', () => avisar('No puedes editarlo ni quitarlo porque no fue creado por ti. Solo puedes deshabilitarlo en tu sucursal.', true));
    pie.append(alterna, candado);
    tarjeta.append(pie);
    return tarjeta;
  }
  const editar = el('button', 'btn chico', '✎ Editar');
  editar.type = 'button';
  editar.addEventListener('click', () => abrirFormExtra(x));
  const borrar = el('button', 'btn chico peligro', '🗑');
  borrar.type = 'button'; borrar.title = 'Eliminar modificador'; borrar.setAttribute('aria-label', 'Eliminar modificador');
  borrar.addEventListener('click', async () => {
    if (await confirmar(`¿Eliminar el modificador “${x.nombre}”? Se quita de todos los platillos.`, { si: 'Eliminar', peligro: true })) {
      accionExtra({ accion: 'eliminar', id: x.id }, 'Modificador eliminado');
    }
  });
  pie.append(editar, borrar);
  tarjeta.append(pie);

  return tarjeta;
}

/** Resumen de solo lectura: en qué categorías aparece el extra y en cuántos platillos de cada una. */
function resumenDisponibilidad(tiene) {
  const caja = el('div', 'ex-resumen');
  const total = productos.length;
  const con = productos.filter(tiene).length;
  if (con === 0) { caja.append(el('span', 'ex-etq', 'Aún no está en ningún platillo')); return caja; }
  caja.append(el('span', 'ex-etq', 'Aparece en:'));
  if (con === total) { caja.append(el('span', 'chip ex-res todos', `Todos los platillos (${total})`)); return caja; }
  for (const c of categorias) {
    const deCat = productos.filter((p) => p.categoria_id === c.id);
    const n = deCat.filter(tiene).length;
    if (n === 0) continue;
    caja.append(el('span', 'chip ex-res' + (n === deCat.length ? ' todos' : ' algunos'), n === deCat.length ? `${c.nombre} (${n})` : `${c.nombre} ${n}/${deCat.length}`));
  }
  return caja;
}

/* Elegir en qué platillos aparece un extra: categoría completa (casilla con ➖ si va a medias) o platillo por platillo */
const dlgEP = $('dlg-extra-platillos');
let epExtra = null, epOriginal = new Set(), epMarcados = new Set();

function epPintar() {
  const q = $('ep-buscar').value.trim().toLowerCase();
  const lista = $('ep-lista');
  lista.replaceChildren();
  let visibles = 0;
  for (const c of categorias) {
    const deCat = productos.filter((p) => p.categoria_id === c.id);
    if (deCat.length === 0) continue;
    const mostrar = q ? deCat.filter((p) => p.nombre.toLowerCase().includes(q)) : deCat;
    if (mostrar.length === 0) continue;
    const marcados = deCat.filter((p) => epMarcados.has(p.id)).length;
    const cab = el('div', 'ep-cat');
    const cx = document.createElement('input');
    cx.type = 'checkbox'; cx.checked = marcados === deCat.length; cx.indeterminate = marcados > 0 && marcados < deCat.length;
    cx.setAttribute('aria-label', `Toda la categoría ${c.nombre}`);
    cx.addEventListener('change', () => { for (const p of deCat) { if (cx.checked) epMarcados.add(p.id); else epMarcados.delete(p.id); } epPintar(); });
    const rot = el('label', '');
    rot.append(c.nombre + ' ', el('small', '', `${marcados} de ${deCat.length}`));
    rot.prepend(cx);
    cab.append(rot);
    lista.append(cab);
    for (const p of mostrar) {
      visibles++;
      const fila = el('div', 'ep-prod');
      const x = document.createElement('input');
      x.type = 'checkbox'; x.checked = epMarcados.has(p.id); x.id = 'ep-p' + p.id;
      x.addEventListener('change', () => { if (x.checked) epMarcados.add(p.id); else epMarcados.delete(p.id); epPintar(); });
      const l = el('label', '', p.nombre); l.htmlFor = x.id;
      fila.append(x, l);
      lista.append(fila);
    }
  }
  if (visibles === 0) lista.append(el('p', 'ayuda', 'No hay platillos con ese nombre.'));
  const cambios = [...epMarcados].filter((id) => !epOriginal.has(id)).length + [...epOriginal].filter((id) => !epMarcados.has(id)).length;
  $('ep-cuenta').textContent = `${epMarcados.size} platillo${epMarcados.size === 1 ? '' : 's'} marcado${epMarcados.size === 1 ? '' : 's'}` + (cambios ? ` · ${cambios} cambio${cambios === 1 ? '' : 's'} sin guardar` : '');
  $('ep-guardar').disabled = cambios === 0;
}
function abrirExtraPlatillos(x) {
  epExtra = x;   // null = extra nuevo: la elección queda en el formulario y se guarda junto con el extra
  epOriginal = x ? new Set(productos.filter((p) => p.extras.includes(x.id)).map((p) => p.id)) : new Set();
  epMarcados = x ? new Set(epOriginal) : new Set(efSel);
  $('ep-titulo').textContent = x ? `¿En qué platillos aparece «${x.nombre}»?` : '¿En qué platillos aparece el modificador nuevo?';
  $('ep-buscar').value = '';
  $('ep-error').textContent = '';
  epPintar();
  dlgEP.showModal();
}
$('ep-buscar').addEventListener('input', epPintar);
$('ep-todos').addEventListener('click', () => { for (const p of productos) epMarcados.add(p.id); epPintar(); });
$('ep-ninguno').addEventListener('click', () => { epMarcados.clear(); epPintar(); });
$('ep-cancelar').addEventListener('click', () => dlgEP.close());
$('ep-x').addEventListener('click', () => dlgEP.close());
$('ep-guardar').addEventListener('click', async () => {
  $('ep-error').textContent = '';
  if (!epExtra) { efSel = new Set(epMarcados); dlgEP.close(); efDonde(); return; }
  const agregar = [...epMarcados].filter((id) => !epOriginal.has(id));
  const quitar = [...epOriginal].filter((id) => !epMarcados.has(id));
  try {
    await enviarJson(API + 'admin/extras.php', { accion: 'asignar_platillos', id: epExtra.id, agregar, quitar });
    dlgEP.close();
    await cargarCatalogo();
    pintarExtras();
    efDonde();
    avisar('Platillos del modificador actualizados');
  } catch (err) { $('ep-error').textContent = err.message; }
});

/* ------------------------------------------------------------------ */
/*  Secciones de extras (Quitar, Aparte, Solo...) y variantes          */
/* ------------------------------------------------------------------ */

/** Panel "Secciones": subir/bajar, renombrar y quitar. Quitar una sección NO borra sus extras (pasan a "Otros"). */
function pintarSeccionesExtras() {
  const caja = $('ex-sec-lista');
  caja.replaceChildren();
  if (gruposExtras.length === 0) { caja.append(el('p', 'ayuda', 'Todavía no hay secciones. Agrega la primera abajo.')); return; }
  if (esGerente) caja.append(el('p', 'ayuda', 'Las secciones con candado las creó el administrador de la empresa: no se pueden cambiar ni quitar, pero sus modificadores sí puedes deshabilitarlos en tu sucursal.'));
  const propias = gruposExtras.filter((g) => (gruposExtrasInfo.find((i) => i.nombre === g) || { propio: true }).propio);   // las que se pueden mover (en orden)
  gruposExtras.forEach((g) => {
    const info = gruposExtrasInfo.find((i) => i.nombre === g) || { propio: true, sucursal_id: null };
    const fila = el('div', 'ex-sec-fila');
    const n = extras.filter((x) => x.grupo === g).length;
    const nombre = el('span', 'ex-sec-nombre'); nombre.append(el('strong', '', (info.propio ? '' : '🔒 ') + g), el('small', '', ` · ${n} modificador${n === 1 ? '' : 'es'}`));
    if (!esGerente && info.sucursal_id !== null) {
      const suc = (typeof sucursalesCarta !== 'undefined' ? sucursalesCarta : []).find((x) => x.id === info.sucursal_id);
      nombre.append(el('span', 'chip', 'Solo ' + (suc ? suc.nombre : 'una sucursal')));
    }
    if (!info.propio) {
      fila.append(nombre, el('span', 'ayuda', 'No fue creada por ti'));
      caja.append(fila);
      return;
    }
    const k = propias.indexOf(g);
    const botones = [['⤒', 'Mover hasta arriba', 'inicio', k === 0], ['▲', 'Subir', 'subir', k === 0], ['▼', 'Bajar', 'bajar', k === propias.length - 1], ['⤓', 'Mover hasta abajo', 'fin', k === propias.length - 1]].map(([txt, etq, dir, off]) => {
      const b = el('button', 'btn chico', txt); b.type = 'button'; b.disabled = off; b.title = etq; b.setAttribute('aria-label', etq);
      b.addEventListener('click', () => accionExtra({ accion: 'grupo_mover', nombre: g, direccion: dir }));
      return b;
    });
    const renombrar = el('button', 'btn chico', '✎ Renombrar'); renombrar.type = 'button';
    renombrar.addEventListener('click', async () => {
      const nuevo = await pedirTexto(`Nuevo nombre para la sección “${g}”:`, { si: 'Guardar', valor: g });
      if (nuevo && nuevo.trim() && nuevo.trim() !== g) accionExtra({ accion: 'grupo_renombrar', nombre: g, nuevo: nuevo.trim() }, 'Sección renombrada');
    });
    const quitar = el('button', 'btn chico peligro', '🗑'); quitar.type = 'button'; quitar.title = 'Quitar sección'; quitar.setAttribute('aria-label', 'Quitar sección');
    quitar.addEventListener('click', async () => {
      const aviso = n ? ` Sus ${n} modificador${n === 1 ? '' : 'es'} NO se borran: pasan a “Otros”.` : '';
      if (await confirmar(`¿Quitar la sección “${g}”?${aviso}`, { si: 'Quitar sección', peligro: true })) accionExtra({ accion: 'grupo_eliminar', nombre: g }, 'Sección quitada');
    });
    fila.append(...botones, nombre, renombrar, quitar);
    caja.append(fila);
  });
}

$('ex-sec-abrir').addEventListener('click', () => { const abrir = $('ex-secciones').hidden; cerrarPanelesExtras(); $('ex-secciones').hidden = !abrir; });
$('ex-sec-cerrar').addEventListener('click', () => { $('ex-secciones').hidden = true; });
$('ex-sec-x').addEventListener('click', () => { $('ex-secciones').hidden = true; });
$('ex-sec-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await accionExtra({ accion: 'grupo_crear', nombre: $('ex-sec-nueva').value.trim() }, 'Sección creada');
  if (!$('x-error').textContent) $('ex-sec-nueva').value = '';
});

/** Cierra los paneles de arriba (nuevo extra, secciones) para que solo haya uno abierto a la vez. */
function cerrarPanelesExtras() {
  $('ex-secciones').hidden = true;
}
$('ex-nuevo-abrir').addEventListener('click', cerrarPanelesExtras, true);   // fase de captura: cierra los otros antes de abrir este

async function accionExtra(cuerpo, mensajeOk) {
  $('x-error').textContent = '';
  try {
    await enviarJson(API + 'admin/extras.php', cuerpo);
    await cargarCatalogo();
    pintarExtras();
    avisar(mensajeOk);
  } catch (err) {
    $('x-error').textContent = err.message;
  }
}

$('btn-extras').addEventListener('click', () => {
  $('x-error').textContent = '';
  pintarExtras();
  abrirPagina(dlgExtras, 'btn-extras');
});
$('x-cerrar').addEventListener('click', () => dlgExtras.close());
/* ---- Ventana para crear o editar un extra ---- */
const dlgExtraForm = $('dlg-extra-form');
let efExtra = null;       // el extra que se edita (null = nuevo)
let efCosto = null;

function pintarOpcionesGrupo(actual) {
  const sel = $('ef-grupo');
  sel.replaceChildren(new Option('Sin sección (Otros)', ''));
  const nombres = [...gruposExtras];
  if (actual && !nombres.includes(actual)) nombres.push(actual);
  for (const g of nombres) sel.append(new Option(g, g));
  sel.append(new Option('＋ Nueva sección…', '__nueva'));
  sel.value = actual || '';
  $('ef-grupo-nuevo').hidden = true; $('ef-grupo-nuevo').value = '';
}
$('ef-grupo').addEventListener('change', () => {
  const nueva = $('ef-grupo').value === '__nueva';
  $('ef-grupo-nuevo').hidden = !nueva;
  if (nueva) $('ef-grupo-nuevo').focus();
});

/** Sección «Disponible en» del formulario de edición: resumen + elegir platillos + igualar precio. */
let efSel = new Set();   // platillos elegidos para un extra NUEVO (todavía no existe en el servidor)
function efDonde() {
  $('ef-resumen').replaceChildren(resumenDisponibilidad(efExtra ? (p) => p.extras.includes(efExtra.id) : (p) => efSel.has(p.id)));
  $('ef-igualar').hidden = !efExtra || !productos.some((p) => p.extras_precios && p.extras_precios[efExtra.id] !== undefined);
}
$('ef-elegir').addEventListener('click', () => abrirExtraPlatillos(efExtra));
$('ef-igualar').addEventListener('click', async () => {
  if (!efExtra) return;
  $('ef-error').textContent = '';
  try {
    await enviarJson(API + 'admin/extras.php', { accion: 'precio_general', id: efExtra.id });
    await cargarCatalogo(); pintarExtras(); efDonde();
    avisar('Precio general aplicado a todos');
  } catch (err) { $('ef-error').textContent = err.message; }
});

function abrirFormExtra(x) {
  efExtra = x || null;
  $('ef-titulo').textContent = x ? 'Editar modificador' : 'Nuevo modificador';
  $('ef-nombre').value = x ? x.nombre : '';
  $('ef-codigo').value = x ? (x.codigo || '') : '';
  efCosto = campoCosto(x ? x.precio : 0);
  $('ef-costo-caja').replaceChildren(...efCosto.caja.children);
  pintarOpcionesGrupo(x ? (x.grupo || '') : '');
  $('ef-activo-fila').hidden = !x;
  $('ef-activo').checked = x ? x.activo : true;
  $('ef-otro').hidden = !!x;
  $('ef-todos-fila').hidden = esGerente || (!!x && x.sucursal_id !== null);
  $('ef-todos').checked = !!(x && x.todos);
  $('ef-error').textContent = '';
  efSel = new Set();
  efDonde();
  dlgExtraForm.showModal();
  $('ef-nombre').focus();
}

async function guardarFormExtra() {
  $('ef-error').textContent = '';
  const nombre = $('ef-nombre').value.trim();
  if (!nombre) { $('ef-error').textContent = 'Escribe cómo se llama el modificador.'; $('ef-nombre').focus(); return false; }
  const g = $('ef-grupo').value === '__nueva' ? $('ef-grupo-nuevo').value.trim() : $('ef-grupo').value;
  if ($('ef-grupo').value === '__nueva' && !g) { $('ef-error').textContent = 'Escribe el nombre de la nueva sección.'; $('ef-grupo-nuevo').focus(); return false; }
  if (!efExtra && efSel.size === 0 && !$('ef-todos').checked) { $('ef-error').textContent = 'Elige en qué platillos va a aparecer este modificador (botón «Elegir platillos…»).'; return false; }
  const cuerpo = { accion: efExtra ? 'actualizar' : 'crear', nombre, codigo: $('ef-codigo').value.trim(), grupo: g, precio: efCosto.valor() };
  if (efExtra) { cuerpo.id = efExtra.id; cuerpo.activo = $('ef-activo').checked; }
  try {
    const r = await enviarJson(API + 'admin/extras.php', cuerpo);
    const idExtra = efExtra ? efExtra.id : r.id;
    if (!efExtra && efSel.size) await enviarJson(API + 'admin/extras.php', { accion: 'asignar_platillos', id: idExtra, agregar: [...efSel], quitar: [] });
    if (!$('ef-todos-fila').hidden && $('ef-todos').checked !== !!(efExtra && efExtra.todos)) await enviarJson(API + 'admin/extras.php', { accion: 'predeterminado', id: idExtra, valor: $('ef-todos').checked });
    await cargarCatalogo();
    pintarExtras();
    avisar(efExtra ? 'Modificador actualizado' : $('ef-todos').checked ? 'Modificador creado en todos los platillos' : `Modificador creado en ${efSel.size} platillo${efSel.size === 1 ? '' : 's'}`);
    return true;
  } catch (err) {
    $('ef-error').textContent = err.message;
    return false;
  }
}
$('ex-nuevo-abrir').addEventListener('click', () => abrirFormExtra(null));
$('ef-cancelar').addEventListener('click', () => dlgExtraForm.close());
$('form-extra').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (await guardarFormExtra()) dlgExtraForm.close();
});
$('ef-otro').addEventListener('click', async () => {
  const grupo = $('ef-grupo').value === '__nueva' ? $('ef-grupo-nuevo').value.trim() : $('ef-grupo').value;
  const sel = new Set(efSel);
  if (await guardarFormExtra()) { abrirFormExtra(null); pintarOpcionesGrupo(grupo); efSel = sel; efDonde(); }   // la misma sección se conserva para el siguiente
});

iniciar();


/* Enlaces «Ver la pantalla…» (se abren en otra pestaña): cliente, cocina y pedidos */
const RAIZ_EMPRESA = BASE_ADMIN.replace(/admin\/$/, '');   // "/lavale/"
function actualizarEnlacesPagina() {
  const slugCliente = (() => {
    if (!cfgCliente || !cfgCliente.sucursales.length) return '';
    const ambito = $('pg-ambito').offsetParent !== null ? $('pg-ambito') : $('ct-ambito');
    const suc = cfgCliente.sucursales.find((x) => String(x.id) === ambito.value) || cfgCliente.sucursales[0];
    return suc.slug || '';
  })();
  document.querySelectorAll('.ver-pagina').forEach((a) => {
    const pag = a.dataset.pagina;
    a.href = location.origin + RAIZ_EMPRESA + (pag === 'cliente' ? (slugCliente ? slugCliente + '/' : 'cliente/') : pag + '/');
  });
}
for (const id of ['ct-ambito', 'pg-ambito']) $(id).addEventListener('change', actualizarEnlacesPagina);
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('.ver-pagina')) actualizarEnlacesPagina(); }, true);

const dlgCaja = $('dlg-caja');
$('btn-caja-cfg').addEventListener('click', () => { abrirPagina(dlgCaja, 'btn-caja-cfg'); actualizarEnlacesPagina(); });
$('caja-cerrar').addEventListener('click', () => dlgCaja.close());


/* ------------------------------------------------------------------ */
/*  Plano de mesas: zonas por sucursal y mesas arrastrables            */
/* ------------------------------------------------------------------ */
const dlgPlano = $('dlg-plano');
let pl = null;                 // estado del servidor: { sucursal, sucursales, activo, activo_propio, general_activo, puede_general, zonas, mesas }
let plMesas = [];              // copia local editable de las mesas (zona_id, x, y, forma)
let plZona = null;             // id de la zona que se está viendo
let plSel = null;              // id de la mesa seleccionada
let plSucio = false;           // ¿hay posiciones sin guardar?
let plPoli = new Map();        // forma de cada zona (id → [[x,y],…] o null = rectángulo), con lo que aún no se guarda
let plAncho = new Map();       // ancho real (m) de cada zona, con lo que aún no se guarda
let plForma = false;           // ¿se está dibujando la forma de la zona?
let plPunto = null;            // punto del contorno elegido

function plMarcarSucio(v = true) { plSucio = v; $('pl-guardar').disabled = !v; $('pl-pendiente').hidden = !v; }

/** Lee el estado del servidor; con `conservar` se mantienen los cambios locales de las mesas que siguen existiendo. */
async function plCargar(sid, conservar = false) {
  const r = await pedir(API + 'admin/plano.php' + (sid ? '?sucursal=' + sid : ''));
  plAplicar(r, conservar);
}
function plAplicar(r, conservar) {
  const locales = new Map(plMesas.map((m) => [m.id, m]));
  const mismaSucursal = pl && pl.sucursal === r.sucursal;
  const previas = plPoli; const previasAncho = plAncho;
  pl = r;
  plPoli = new Map(r.zonas.map((z) => [z.id, conservar && mismaSucursal && plSucio && previas.has(z.id) ? previas.get(z.id) : z.poligono]));
  plAncho = new Map(r.zonas.map((z) => [z.id, conservar && mismaSucursal && plSucio && previasAncho.has(z.id) ? previasAncho.get(z.id) : z.ancho_m]));
  plMesas = r.mesas.map((m) => {
    const l = conservar && mismaSucursal ? locales.get(m.id) : null;
    // lo que el usuario movió y aún no guardó se conserva, salvo que su zona ya no exista
    return l && plSucio && (l.zona_id === null || r.zonas.some((z) => z.id === l.zona_id)) ? { ...m, zona_id: l.zona_id, x: l.x, y: l.y, forma: l.forma, ancho_cm: l.ancho_cm, alto_cm: l.alto_cm } : { ...m };
  });
  if (!conservar || !mismaSucursal) plMarcarSucio(false);
  if (!r.zonas.some((z) => z.id === plZona)) plZona = r.zonas.length ? r.zonas[0].id : null;
  if (!plMesas.some((m) => m.id === plSel)) plSel = null;
  plPintar();
}

function plPintar() {
  const sel = $('pl-suc');
  sel.replaceChildren(...pl.sucursales.map((s) => new Option(s.nombre, String(s.id))));
  sel.value = String(pl.sucursal);
  $('pl-suc-fila').hidden = pl.sucursales.length < 2;
  $('pl-activo').checked = pl.activo;
  $('pl-general-fila').hidden = !pl.puede_general;
  $('pl-general').checked = pl.general_activo;

  // Pestañas de zonas
  const tabs = $('pl-zonas');
  tabs.replaceChildren();
  for (const z of pl.zonas) {
    const b = el('button', 'btn', z.nombre);
    b.type = 'button'; b.setAttribute('aria-pressed', String(z.id === plZona));
    b.addEventListener('click', () => { plZona = z.id; plSel = null; plForma = false; plPunto = null; plPintar(); });
    tabs.append(b);
  }
  const nueva = el('button', 'btn', '＋ Zona'); nueva.type = 'button';
  nueva.addEventListener('click', plNuevaZona);
  tabs.append(nueva);
  if (pl.zonas.length === 0) {
    const ej = el('button', 'btn', '✨ Cargar plano de ejemplo'); ej.type = 'button';
    ej.addEventListener('click', plEjemplo);
    tabs.append(ej);
  }
  $('pl-zona-acc').hidden = plZona === null;

  // Lienzo
  const lienzo = $('pl-lienzo');
  pintarLienzoZona(lienzo, { poligono: plZona === null ? null : plPoli.get(plZona) });
  $('pl-forma-barra').hidden = !(plForma && plZona !== null);
  $('pl-forma-btn').hidden = plForma;
  if (plZona === null) {
    lienzo.append(el('div', 'plano-vacio', 'Crea tu primera zona con «＋ Zona» (por ejemplo: Piso 1, Patio o Comedor principal).'));
  } else {
    const aqui = plMesas.filter((m) => m.zona_id === plZona);
    if (aqui.length === 0 && !plForma) lienzo.append(el('div', 'plano-vacio', 'Esta zona está vacía. Toca una mesa de «Mesas sin ubicar» para ponerla aquí.'));
    for (const m of aqui) lienzo.append(plToken(m));
    if (plForma) plPuntos(lienzo);
  }

  // Edición de la mesa seleccionada
  const m = plMesas.find((x) => x.id === plSel);
  $('pl-edicion').hidden = !m;
  if (m) {
    $('pl-sel-nombre').textContent = 'Mesa ' + m.nombre;
    document.querySelectorAll('#pl-edicion [data-forma]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.forma === m.forma)));
    const [w, h] = medidasMesa(m);
    $('pl-ancho-et').textContent = m.forma === 'redonda' ? 'Diámetro (cm)' : m.forma === 'cuadrada' ? 'Lado (cm)' : 'Ancho (cm)';
    $('pl-ancho').value = String(w);
    $('pl-alto-fila').hidden = m.forma !== 'rectangular';
    $('pl-alto').value = String(h);
  }
  $('pl-zona-ancho').value = plZona === null ? '' : String(plAncho.get(plZona) || 10);

  // Mesas sin ubicar
  const sin = $('pl-sin');
  sin.replaceChildren();
  const libres = plMesas.filter((x) => x.zona_id === null);
  if (libres.length === 0) sin.append(el('span', 'ayuda', 'Todas las mesas están ubicadas.'));
  for (const x of libres) {
    const b = el('button', 'btn chico' + (x.activa ? '' : ' inactiva'), x.nombre + (x.activa ? '' : ' (inactiva)'));
    b.type = 'button';
    b.disabled = plZona === null;
    b.title = plZona === null ? 'Primero crea una zona' : 'Ponerla en la zona de arriba';
    b.addEventListener('click', () => {
      const n = plMesas.filter((y) => y.zona_id === plZona).length;
      x.zona_id = plZona; x.x = 15 + ((n * 13) % 70); x.y = 20 + ((n * 17) % 60);
      plSel = x.id; plMarcarSucio(); plPintar();
    });
    sin.append(b);
  }
}

/** Mesa arrastrable. Un toque sin mover la selecciona; arrastrar la reubica (con el dedo o el mouse). */
function plToken(m) {
  const b = el('button', 'plano-mesa editable ' + m.forma + (m.id === plSel ? ' sel' : '') + (m.activa ? '' : ' inactiva'), m.nombre);
  b.type = 'button';
  b.style.left = m.x + '%'; b.style.top = m.y + '%'; aplicarTamanoMesa(b, m, plAncho.get(plZona));
  if (plForma) { b.classList.add('fija'); return b; }
  let inicio = null;
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    b.setPointerCapture(ev.pointerId);
    inicio = { x: ev.clientX, y: ev.clientY, movido: false };
  });
  b.addEventListener('pointermove', (ev) => {
    if (!inicio) return;
    if (!inicio.movido && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) < 5) return;
    inicio.movido = true;
    const r = $('pl-lienzo').getBoundingClientRect();
    m.x = Math.min(97, Math.max(3, ((ev.clientX - r.left) / r.width) * 100));
    m.y = Math.min(95, Math.max(5, ((ev.clientY - r.top) / r.height) * 100));
    b.style.left = m.x + '%'; b.style.top = m.y + '%';
  });
  const soltar = () => {
    if (!inicio) return;
    const movido = inicio.movido;
    inicio = null;
    if (movido) plMarcarSucio();
    plSel = m.id;
    plPintar();
  };
  b.addEventListener('pointerup', soltar);
  b.addEventListener('pointercancel', () => { inicio = null; });
  return b;
}

async function plConfirmarDescartar() {
  return !plSucio || (await confirmar('Tienes cambios sin guardar en el plano. Si sigues, se pierden.', { si: 'Descartar cambios', peligro: true }));
}
async function plEjemplo() {
  if (!(await confirmar('Esto crea la zona «Piso 1» con 10 mesas de muestra (1 al 10) y activa el plano en esta sucursal. Después puedes moverlas, renombrarlas o quitarlas.', { si: 'Crear ejemplo' }))) return;
  try { plAplicar(await enviarJson(API + 'admin/plano.php', { accion: 'ejemplo', sucursal_id: pl.sucursal }), false); avisar('Plano de ejemplo creado'); }
  catch (err) { $('pl-error').textContent = err.message; }
}
async function plNuevaZona() {
  const nombre = await pedirTexto('Nombre de la nueva zona (ej. Piso 1, Patio, Comedor principal):', { si: 'Crear zona' });
  if (!nombre || !nombre.trim()) return;
  try {
    const r = await enviarJson(API + 'admin/plano.php', { accion: 'zona_crear', sucursal_id: pl.sucursal, nombre: nombre.trim() });
    plZona = r.zonas[r.zonas.length - 1].id;
    plAplicar(r, true);
  } catch (err) { $('pl-error').textContent = err.message; }
}
$('pl-zona-renombrar').addEventListener('click', async () => {
  const z = pl.zonas.find((x) => x.id === plZona);
  const nombre = z && await pedirTexto(`Nuevo nombre para la zona «${z.nombre}»:`, { si: 'Guardar', valor: z.nombre });
  if (!nombre || !nombre.trim() || nombre.trim() === z.nombre) return;
  try { plAplicar(await enviarJson(API + 'admin/plano.php', { accion: 'zona_renombrar', id: plZona, nombre: nombre.trim() }), true); }
  catch (err) { $('pl-error').textContent = err.message; }
});
$('pl-zona-eliminar').addEventListener('click', async () => {
  const z = pl.zonas.find((x) => x.id === plZona);
  if (!z) return;
  const n = plMesas.filter((m) => m.zona_id === z.id).length;
  if (!(await confirmar(`¿Quitar la zona «${z.nombre}»?${n ? ` Sus ${n} mesa${n === 1 ? '' : 's'} NO se borran: quedan «sin ubicar».` : ''}`, { si: 'Quitar zona', peligro: true }))) return;
  try { plAplicar(await enviarJson(API + 'admin/plano.php', { accion: 'zona_eliminar', id: z.id }), true); }
  catch (err) { $('pl-error').textContent = err.message; }
});
document.querySelectorAll('#pl-edicion [data-forma]').forEach((b) => b.addEventListener('click', () => {
  const m = plMesas.find((x) => x.id === plSel);
  if (m) { m.forma = b.dataset.forma; if (m.forma === 'rectangular' && !m.alto_cm) m.alto_cm = 80; plMarcarSucio(); plPintar(); }
}));
const plMedida = (v) => Math.min(800, Math.max(30, Math.round(Number(v)) || 80));
$('pl-ancho').addEventListener('change', () => {
  const m = plMesas.find((x) => x.id === plSel);
  if (!m) return;
  m.ancho_cm = plMedida($('pl-ancho').value);
  plMarcarSucio(); plPintar();
});
$('pl-alto').addEventListener('change', () => {
  const m = plMesas.find((x) => x.id === plSel);
  if (!m) return;
  m.alto_cm = plMedida($('pl-alto').value);
  plMarcarSucio(); plPintar();
});
$('pl-zona-ancho').addEventListener('change', () => {
  if (plZona === null) return;
  plAncho.set(plZona, Math.min(100, Math.max(2, Math.round((Number($('pl-zona-ancho').value) || 10) * 10) / 10)));
  plMarcarSucio(); plPintar();
});
$('pl-quitar').addEventListener('click', () => {
  const m = plMesas.find((x) => x.id === plSel);
  if (m) { m.zona_id = null; m.x = null; m.y = null; plSel = null; plMarcarSucio(); plPintar(); }
});
$('pl-nueva').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('pl-error').textContent = '';
  const nombre = $('pl-nueva-nombre').value.trim();
  if (!nombre) return;
  try {
    await enviarJson(API + 'admin/mesas.php', { accion: 'crear', sucursal_id: pl.sucursal, nombre });
    $('pl-nueva-nombre').value = '';
    await plCargar(pl.sucursal, true);
    avisar('Mesa creada: tócala en «Mesas sin ubicar» para ponerla en el plano');
  } catch (err) { $('pl-error').textContent = err.message; }
});
$('pl-guardar').addEventListener('click', async () => {
  $('pl-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/plano.php', { accion: 'guardar', sucursal_id: pl.sucursal, mesas: plMesas.map((m) => ({ id: m.id, zona_id: m.zona_id, x: m.x, y: m.y, forma: m.forma, ancho_cm: m.ancho_cm || null, alto_cm: m.forma === 'rectangular' ? (m.alto_cm || null) : null })), zonas: pl.zonas.map((z) => ({ id: z.id, poligono: plPoli.get(z.id) || null, ancho_m: plAncho.get(z.id) || 10 })) });
    plMarcarSucio(false);
    plAplicar(r, false);
    avisar('Plano guardado');
  } catch (err) { $('pl-error').textContent = err.message; }
});
$('pl-suc').addEventListener('change', async () => {
  if (!(await plConfirmarDescartar())) { $('pl-suc').value = String(pl.sucursal); return; }
  plMarcarSucio(false); plZona = null; plSel = null; plForma = false; plPunto = null;
  try { await plCargar(Number($('pl-suc').value)); } catch (err) { $('pl-error').textContent = err.message; }
});
$('pl-activo').addEventListener('change', async () => {
  try { plAplicar(await enviarJson(API + 'admin/plano.php', { accion: 'activar', ambito: 'sucursal', sucursal_id: pl.sucursal, activo: $('pl-activo').checked }), true); avisar($('pl-activo').checked ? 'Plano activado en esta sucursal' : 'Plano desactivado en esta sucursal'); }
  catch (err) { $('pl-error').textContent = err.message; $('pl-activo').checked = pl.activo; }
});
$('pl-general').addEventListener('change', async () => {
  try { plAplicar(await enviarJson(API + 'admin/plano.php', { accion: 'activar', ambito: 'general', sucursal_id: pl.sucursal, activo: $('pl-general').checked }), true); avisar('Valor por defecto de la empresa guardado'); }
  catch (err) { $('pl-error').textContent = err.message; $('pl-general').checked = pl.general_activo; }
});
$('btn-plano').addEventListener('click', async () => {
  $('pl-error').textContent = '';
  plMarcarSucio(false); plMesas = []; pl = null; plZona = null; plSel = null; plForma = false; plPunto = null; plPoli = new Map(); plAncho = new Map();
  try { await plCargar(0); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgPlano, 'btn-plano');
  actualizarEnlacesPagina();
});
$('pl-cerrar').addEventListener('click', async () => { if (await plConfirmarDescartar()) { plMarcarSucio(false); dlgPlano.close(); } });


/* Forma irregular de la zona: puntos del contorno que se arrastran; un ＋ entre dos puntos agrega otro */
const PL_RECT = () => [[4, 6], [96, 6], [96, 94], [4, 94]];
function plPuntos(lienzo) {
  const poli = plPoli.get(plZona);
  const svgPol = lienzo.querySelector('polygon');
  const redibujarPoligono = () => svgPol && svgPol.setAttribute('points', poli.map((p) => p.join(',')).join(' '));
  poli.forEach((p, i) => {
    const q = poli[(i + 1) % poli.length];
    const medio = el('button', 'plano-medio', '＋');
    medio.type = 'button'; medio.title = 'Agregar un punto aquí';
    medio.style.left = (p[0] + q[0]) / 2 + '%'; medio.style.top = (p[1] + q[1]) / 2 + '%';
    medio.addEventListener('click', () => { poli.splice(i + 1, 0, [Math.round((p[0] + q[0]) * 50) / 100, Math.round((p[1] + q[1]) * 50) / 100]); plPunto = i + 1; plMarcarSucio(); plPintar(); });
    lienzo.append(medio);
  });
  poli.forEach((p, i) => {
    const b = el('button', 'plano-punto' + (i === plPunto ? ' sel' : ''));
    b.type = 'button'; b.setAttribute('aria-label', 'Punto ' + (i + 1));
    b.style.left = p[0] + '%'; b.style.top = p[1] + '%';
    let ini = null;
    b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); b.setPointerCapture(ev.pointerId); ini = { x: ev.clientX, y: ev.clientY, movido: false }; });
    b.addEventListener('pointermove', (ev) => {
      if (!ini) return;
      if (!ini.movido && Math.hypot(ev.clientX - ini.x, ev.clientY - ini.y) < 4) return;
      ini.movido = true;
      const r = lienzo.getBoundingClientRect();
      p[0] = Math.round(Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100)) * 100) / 100;
      p[1] = Math.round(Math.min(100, Math.max(0, ((ev.clientY - r.top) / r.height) * 100)) * 100) / 100;
      b.style.left = p[0] + '%'; b.style.top = p[1] + '%';
      redibujarPoligono();
    });
    b.addEventListener('pointerup', () => { if (!ini) return; const movido = ini.movido; ini = null; plPunto = i; if (movido) plMarcarSucio(); plPintar(); });
    b.addEventListener('pointercancel', () => { ini = null; });
    lienzo.append(b);
  });
  $('pl-punto-quitar').disabled = plPunto === null || poli.length <= 3;
}
$('pl-forma-btn').addEventListener('click', () => {
  if (plZona === null) return;
  if (!plPoli.get(plZona)) { plPoli.set(plZona, PL_RECT()); plMarcarSucio(); }
  plForma = true; plPunto = null; plSel = null; plPintar();
});
$('pl-forma-ok').addEventListener('click', () => { plForma = false; plPunto = null; plPintar(); });
$('pl-forma-rect').addEventListener('click', () => { plPoli.set(plZona, null); plForma = false; plPunto = null; plMarcarSucio(); plPintar(); });
$('pl-punto-quitar').addEventListener('click', () => {
  const poli = plPoli.get(plZona);
  if (!poli || plPunto === null || poli.length <= 3) return;
  poli.splice(plPunto, 1); plPunto = null; plMarcarSucio(); plPintar();
});
