/**
 * Panel de administración: login, productos (con foto, código, porción,
 * parrilla y extras), categorías, extras y parrillas.
 * Usa las funciones de js/comun.js (el, pedir, enviarJson, dinero, fijarCsrf).
 */

const API = '../api/';
const RUTA_FOTOS = '../uploads/';

let productos = [];
let categorias = [];
let estaciones = [];
let extras = [];
let gruposExtras = [];            // secciones de extras (Quitar, Aparte, Solo...) en el orden elegido
let variantesPropias = [];   // patrones de variante propios del negocio [{texto, seccion, precio}]

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
  for (const id of ['btn-categorias', 'btn-extras', 'btn-apariencia']) { const b = $(id); if (b) b.hidden = esGerente; }
  $('btn-sucursales').textContent = esGerente ? 'Mi sucursal y mesas' : 'Sucursales y mesas';
  mostrar('vista-panel');
  await cargarCatalogo();
  // Entra a la sección de la dirección (#usuarios…) si es válida y permitida; si no, al Inicio (reportes)
  const pedida = RUTAS[seccionDeLaDireccion()] && $(RUTAS[seccionDeLaDireccion()]);
  (pedida && !pedida.hidden ? pedida : $('btn-reportes')).click();
}

/** Barra lateral: usuario abajo (iniciales, nombre y rol) y, arriba a la derecha, la sucursal con la que se trabaja. */
function pintarUsuario(usuario) {
  const partes = String(usuario.nombre || '').trim().split(/\s+/).filter(Boolean);
  const iniciales = ((partes[0] || '?')[0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
  $('usuario-ini').textContent = iniciales;
  $('usuario-ini-movil').textContent = iniciales;
  $('usuario-nombre').textContent = usuario.nombre;
  const rol = usuario.rol === 'gerente' ? 'Gerente de sucursal' : 'Administrador';
  $('usuario-rol').textContent = rol;
  $('usuario-rol').hidden = rol.toLowerCase() === String(usuario.nombre).trim().toLowerCase();   // si el nombre ya dice el rol, no se repite
  const chip = $('chip-sucursal');
  chip.hidden = true;
  pedir(API + 'sesion.php').then((s) => {
    if (s.negocio) $('menu-negocio').textContent = s.negocio.nombre;
    const propia = usuario.rol === 'gerente' && (s.sucursales || []).find((x) => x.id === s.sucursal);
    chip.textContent = propia ? propia.nombre : (s.sucursales && s.sucursales.length > 1 ? 'Todas las sucursales' : ((s.sucursales || [])[0] || {}).nombre || '');
    chip.hidden = !chip.textContent;
  }).catch(() => { /* la barra funciona igual sin el nombre de la sucursal */ });
}

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
    variantesPropias = r.variantes_propias || [];
    pintarLista();
  } catch (err) {
    if (err.estado === 401) { await iniciar(); return; }
    avisar(err.message, true);
  }
}

function pintarLista() {
  const lista = $('lista');
  lista.replaceChildren();
  $('barra-expandir').replaceChildren();

  if (productos.length === 0) {
    lista.append(el('p', 'vacio',
      categorias.length === 0
        ? 'Empieza creando una categoría (botón “Categorías de platillos”) y luego agrega tu primer platillo.'
        : 'Aún no hay platillos. Toca “Nuevo platillo” para agregar el primero.'));
    return;
  }

  // Productos agrupados por categoría, cada grupo expandible/colapsable. Los que no pertenecen a ninguna
  // categoría conocida van al final en "Otros".
  const grupos = categorias.map((c) => ({ clave: String(c.id), nombre: c.nombre, items: productos.filter((p) => p.categoria_id === c.id) }));
  const conocidas = new Set(categorias.map((c) => c.id));
  const otros = productos.filter((p) => !conocidas.has(p.categoria_id));
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
  if (p.extras.length) etiquetas.append(el('span', 'chip', p.extras.length === 1 ? '1 extra' : `${p.extras.length} extras`));
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
  const mismos = productos.filter((x) => x.categoria_id === p.categoria_id);
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

/** Casillas con los extras (los desactivados se muestran solo si el producto los tiene). */
function pintarExtrasProducto(marcados, precios = {}) {
  const caja = $('f-extras');
  caja.replaceChildren();
  const visibles = extras.filter((x) => x.activo || marcados.includes(x.id));
  if (visibles.length === 0) {
    caja.append(el('p', 'vacio ayuda', 'Aún no hay extras. Créalos con el botón “Extras”.'));
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
      precio.title = 'Precio de este extra solo en este platillo (vacío = precio general)';
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

function marcarMenu(idBoton) {
  for (const b of document.querySelectorAll('.menu-lateral .nav-ico')) b.classList.toggle('activo', b.id === idBoton);
  const activo = $(idBoton);   // el nombre de la sección seleccionada se muestra en la barra superior
  if (activo) $('titulo-seccion').textContent = activo.dataset.titulo || activo.textContent.trim();
}

/** Muestra una sección como página: cierra la que estuviera abierta y oculta la lista de productos. */
/* Cada sección tiene su propia dirección: /<empresa>/admin/usuarios, /extras… (Inicio es solo /<empresa>/admin/).
   Se puede recargar, guardar en favoritos y usar "atrás". Las direcciones no llevan "#". */
const RUTAS = { inicio: 'btn-reportes', platillos: 'btn-productos', categorias: 'btn-categorias', extras: 'btn-extras', 'carga-masiva': 'btn-carga', sucursales: 'btn-sucursales', usuarios: 'btn-usuarios', 'ajustes-cocina': 'btn-prioridades', 'ajustes-pedidos': 'btn-pedidos-qr', 'ajustes-toma': 'btn-toma-pedidos', apariencia: 'btn-apariencia' };
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
  volverA = (dlg === dlgProducto || dlg === dlgCategorias) ? 'platillos' : 'inicio';
  for (const o of paginasPortal) if (o !== dlg && o.open) o.close();
  $('vista-platillos').hidden = true;
  if (!dlg.open) dlg.show();          // show() = no modal
  fijarRuta(dlg === dlgProducto ? 'btn-productos' : idBoton);
  marcarMenu(idBoton === 'btn-categorias' ? 'btn-productos' : idBoton);   // Categorías de platillos cuelga de Platillos
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
  $('dlg-titulo').textContent = p ? 'Editar platillo' : 'Nuevo platillo';

  const select = $('f-categoria');
  select.replaceChildren(...categorias.map((c) => new Option(c.nombre, String(c.id))));
  if (categorias.length === 0) {
    $('f-error').textContent = 'Primero crea una categoría (botón “Categorías de platillos”).';
  }

  pintarExtrasProducto(p ? p.extras : [], p ? p.extras_precios || {} : {});

  if (p) {
    $('f-codigo').value = p.codigo || '';
    $('f-porcion').value = p.porcion || '';
    $('f-nombre').value = p.nombre;
    select.value = String(p.categoria_id);
    $('f-precio').value = p.precio.toFixed(2);
    $('f-descripcion').value = p.descripcion || '';
    $('f-disponible').checked = p.disponible;
    $('f-pedir').checked = !!p.pedir_opciones;
    ponerVistaPrevia(p.foto ? RUTA_FOTOS + encodeURIComponent(p.foto) : null);
  } else {
    if (categoriaId !== null) select.value = String(categoriaId);
    $('f-disponible').checked = true;
    $('f-pedir').checked = false;
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
    datos.append('nombre', $('f-nombre').value.trim());
    datos.append('categoria_id', $('f-categoria').value);
    datos.append('precio', $('f-precio').value.trim());
    datos.append('descripcion', $('f-descripcion').value.trim());
    datos.append('disponible', $('f-disponible').checked ? '1' : '0');
    datos.append('pedir_opciones', $('f-pedir').checked ? '1' : '0');
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
  const mismos = productos.filter((x) => x.categoria_id === p.categoria_id);
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
  quien.append(el('strong', '', u.nombre), el('span', 'ayuda', '@' + u.usuario));
  const chips = el('div', 'us-chips');
  chips.append(el('span', 'chip rol-' + u.rol, ROL_TEXTO[u.rol]));
  const extra = (u.sucursales_extra || []).map((id) => (r.sucursales.find((x) => x.id === id) || {}).nombre).filter(Boolean);
  if (extra.length) chips.append(el('span', 'chip', '+ ' + extra.join(' + ')));
  if (u.id === r.yo) chips.append(el('span', 'chip', 'Tú'));
  chips.append(el('span', 'chip ' + (u.activo ? 'activo' : 'sin'), u.activo ? '● Activo' : 'Desactivado'));
  const editar = el('button', 'btn chico', '✎ Editar');
  editar.type = 'button';
  editar.addEventListener('click', () => abrirEditarUsuario(u));
  fila.append(quien, chips, editar);
  return fila;
}

/** Ventana (modal) para editar a una persona: datos, sucursales, contraseña y el interruptor "Activo". */
function abrirEditarUsuario(u) {
  const { r, ROLES_PERSONAL, hayVarias } = usuariosCtx;
  const dlg = $('dlg-usuario-editar');
  $('ue-error').textContent = '';
  $('ue-titulo').textContent = u.nombre;
  $('ue-usuario').textContent = '@' + u.usuario;
  $('ue-nombre').value = u.nombre;
  const esAdmin = u.rol === 'admin';
  $('ue-fila-rol').hidden = esAdmin;
  $('ue-fila-suc').hidden = esAdmin;
  $('ue-activo-fila').hidden = esAdmin || u.id === r.yo;   // al dueño (o a uno mismo) no se le desactiva
  $('ue-activo').checked = !!u.activo;
  const rol = $('ue-rol'); rol.replaceChildren();
  for (const [v, t] of ROLES_PERSONAL) { const o = document.createElement('option'); o.value = v; o.textContent = t; rol.append(o); }
  rol.value = u.rol;
  const suc = $('ue-sucursal'); suc.replaceChildren();
  for (const x of r.sucursales) { const o = document.createElement('option'); o.value = String(x.id); o.textContent = x.nombre; suc.append(o); }
  suc.value = String(u.sucursal_id || (r.sucursales[0] && r.sucursales[0].id) || '');
  const cajaExtra = $('ue-extra'); cajaExtra.replaceChildren();
  let extraFila = null;
  cajaExtra.hidden = esAdmin || !hayVarias;
  if (!esAdmin && hayVarias) { extraFila = casillasSucursalesExtra(r.sucursales, suc, u.sucursales_extra || []); cajaExtra.append(...extraFila.caja.childNodes); }

  $('ue-guardar').onclick = async () => {
    const activo = esAdmin ? u.activo : $('ue-activo').checked;
    if (u.activo && !activo && !(await confirmar(`¿Desactivar a ${u.nombre}? Perderá el acceso de inmediato.`, { si: 'Desactivar', peligro: true }))) return;
    $('ue-error').textContent = '';
    try {
      await enviarJson(API + 'admin/usuarios.php', {
        accion: 'editar', id: u.id, nombre: $('ue-nombre').value.trim(), rol: esAdmin ? u.rol : rol.value,
        sucursal_id: esAdmin ? null : Number(suc.value), ...(extraFila ? { sucursales_extra: extraFila.valor() } : {}), activo,
      });
      dlg.close();
      await cargarUsuarios();
      avisar('Usuario actualizado');
    } catch (err) { $('ue-error').textContent = err.message; }
  };
  $('ue-clave').onclick = async () => {
    const p = await pedirTexto(`Nueva contraseña para ${u.nombre} (mínimo 10 caracteres):`, { si: 'Cambiar', tipo: 'password', minimo: 10 });
    if (!p) return;
    try { await enviarJson(API + 'admin/usuarios.php', { accion: 'clave', id: u.id, password: p }); avisar('Contraseña cambiada'); }
    catch (err) { $('ue-error').textContent = err.message; }
  };
  dlg.showModal();
}
$('ue-cerrar').addEventListener('click', () => $('dlg-usuario-editar').close());

async function accionUsuario(cuerpo, mensajeOk) {
  $('us-error').textContent = '';
  try {
    await enviarJson(API + 'admin/usuarios.php', cuerpo);
    await cargarUsuarios();
    avisar(mensajeOk);
    return true;
  } catch (err) {
    $('us-error').textContent = err.message;
    return false;
  }
}

$('btn-usuarios').addEventListener('click', async () => {
  $('us-error').textContent = '';
  try { await cargarUsuarios(); } catch (err) { $('us-error').textContent = err.message; }
  abrirPagina(dlgUsuarios, 'btn-usuarios');
});
$('us-cerrar').addEventListener('click', () => dlgUsuarios.close());
$('form-nuevo-usuario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ok = await accionUsuario({
    accion: 'crear', nombre: $('us-nombre').value.trim(), usuario: $('us-usuario').value.trim(),
    password: $('us-password').value, rol: $('us-rol').value, sucursal_id: Number($('us-sucursal').value),
    ...(extraNuevo ? { sucursales_extra: extraNuevo.valor() } : {}),
  }, 'Usuario creado');
  if (ok) { $('us-nombre').value = ''; $('us-usuario').value = ''; $('us-password').value = ''; }
});

/* ------------------------------------------------------------------ */
/*  Sucursales y mesas                                                 */
/* ------------------------------------------------------------------ */

const dlgSucursales = $('dlg-sucursales');
const sucAbierta = new Set();   // sucursales expandidas en la lista (por defecto todas colapsadas)
let sucMesas = null;            // sucursal cuya ventana de mesas está abierta

async function accionSucursal(url, cuerpo, mensaje) {
  $('su-error').textContent = '';
  $('mesas-error').textContent = '';
  try {
    await enviarJson(API + url, cuerpo);
    if (mensaje) avisar(mensaje);
    await cargarSucursales();
    if (sucMesas && $('dlg-mesas').open) await pintarMesas($('mesas-contenido'), sucMesas);   // refresca la ventana de mesas
    return true;
  } catch (err) {
    (sucMesas && $('dlg-mesas').open ? $('mesas-error') : $('su-error')).textContent = err.message;
    return false;
  }
}

/** Ventana (modal) con las mesas de una sucursal. */
function abrirMesas(s) {
  sucMesas = s;
  $('mesas-titulo').textContent = `Mesas · ${s.nombre}`;
  $('mesas-error').textContent = '';
  $('dlg-mesas').showModal();
  pintarMesas($('mesas-contenido'), s).catch((err) => { $('mesas-error').textContent = err.message; });
}
$('mesas-cerrar').addEventListener('click', () => $('dlg-mesas').close());

async function pintarMesas(caja, s) {
  caja.replaceChildren();
  const r = await pedir(API + 'admin/mesas.php?sucursal=' + s.id);
  const rejilla = el('div', 'mesas-rejilla');
  for (const m of r.mesas) {
    const chip = el('span', 'mesa-chip' + (m.activa ? '' : ' inactiva'));
    const nombre = document.createElement('input');
    nombre.type = 'text'; nombre.value = m.nombre; nombre.maxLength = 30; nombre.setAttribute('aria-label', 'Nombre de la mesa');
    nombre.addEventListener('change', () => accionSucursal('admin/mesas.php', { accion: 'renombrar', id: m.id, nombre: nombre.value.trim() }));
    const act = el('button', 'btn chico', m.activa ? 'Ocultar' : 'Mostrar');
    act.type = 'button';
    act.addEventListener('click', () => accionSucursal('admin/mesas.php', { accion: 'activar', id: m.id, activa: !m.activa }));
    const del = el('button', 'btn chico peligro', '✕');
    del.type = 'button'; del.title = 'Eliminar mesa';
    del.addEventListener('click', async () => {
      if (await confirmar(`¿Eliminar la ${m.nombre}? Los pedidos anteriores conservan el nombre.`, { si: 'Eliminar', no: 'Volver', peligro: true })) {
        accionSucursal('admin/mesas.php', { accion: 'eliminar', id: m.id });
      }
    });
    chip.append(nombre, act, del);
    rejilla.append(chip);
  }
  if (!r.mesas.length) rejilla.append(el('p', 'ayuda', 'Esta sucursal aún no tiene mesas.'));
  caja.append(rejilla);

  const uno = el('form', 'fila-mesas');
  const nuevo = document.createElement('input');
  nuevo.type = 'text'; nuevo.maxLength = 30; nuevo.placeholder = 'Nombre de la mesa (ej. Mesa 7, Terraza)'; nuevo.required = true;
  const b1 = el('button', 'btn', 'Agregar mesa'); b1.type = 'submit';
  uno.append(nuevo, b1);
  uno.addEventListener('submit', (ev) => { ev.preventDefault(); accionSucursal('admin/mesas.php', { accion: 'crear', sucursal_id: s.id, nombre: nuevo.value.trim() }, 'Mesa agregada'); });

  const lote = el('form', 'fila-mesas');
  const pref = document.createElement('input'); pref.type = 'text'; pref.maxLength = 20; pref.value = 'Mesa '; pref.setAttribute('aria-label', 'Prefijo');
  const d = document.createElement('input'); d.type = 'number'; d.min = '1'; d.max = '500'; d.value = '1'; d.setAttribute('aria-label', 'Desde');
  const h = document.createElement('input'); h.type = 'number'; h.min = '1'; h.max = '500'; h.placeholder = 'hasta'; h.required = true; h.setAttribute('aria-label', 'Hasta');
  const b2 = el('button', 'btn', 'Crear varias'); b2.type = 'submit';
  lote.append(el('span', 'ayuda', 'Varias de golpe:'), pref, d, el('span', '', 'a'), h, b2);
  lote.addEventListener('submit', (ev) => { ev.preventDefault(); accionSucursal('admin/mesas.php', { accion: 'lote', sucursal_id: s.id, prefijo: pref.value, desde: Number(d.value), hasta: Number(h.value) }, 'Mesas creadas'); });
  caja.append(uno, lote);
}

/** Dibuja el QR en un canvas grande (con margen blanco) y lo baja como PNG. */
function descargarQr(qr, nombreArchivo) {
  const n = qr.getModuleCount(), celda = 24, margen = 4 * celda, lado = n * celda + margen * 2;
  const lienzo = document.createElement('canvas');
  lienzo.width = lado; lienzo.height = lado;
  const c = lienzo.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, lado, lado);
  c.fillStyle = '#000000';
  for (let f = 0; f < n; f++) for (let col = 0; col < n; col++) if (qr.isDark(f, col)) c.fillRect(margen + col * celda, margen + f * celda, celda, celda);
  const a = document.createElement('a');
  a.href = lienzo.toDataURL('image/png'); a.download = nombreArchivo;
  document.body.append(a); a.click(); a.remove();
}

async function cargarSucursales() {
  const [r, pq] = await Promise.all([pedir(API + 'admin/sucursales.php'), pedir(API + 'admin/cliente-pedidos.php')]);
  const pedidosQr = new Map(pq.sucursales.map((x) => [x.id, x.activo]));   // ¿el cliente puede levantar pedidos desde el QR de cada sucursal?
  const lista = $('lista-sucursales');
  lista.replaceChildren();
  $('su-nueva-det').hidden = esGerente;
  for (const s of r.sucursales) {
    // Cada sucursal es un bloque colapsado; al expandirlo aparecen sus datos y acciones
    const det = el('details', 'su-grupo' + (s.activa ? '' : ' inactivo'));
    det.open = esGerente || sucAbierta.has(s.id);
    det.addEventListener('toggle', () => { if (det.open) sucAbierta.add(s.id); else sucAbierta.delete(s.id); });
    const resumen = el('summary', 'su-resumen');
    resumen.append(el('span', 'cat-nombre', s.nombre), el('span', 'chip', `${s.mesas} mesas`), el('span', 'chip', `${s.usuarios} personas`), el('span', 'chip ' + (s.activa ? 'activo' : 'sin'), s.activa ? '● Activa' : 'Desactivada'));
    det.append(resumen);

    const cuerpo = el('div', 'su-cuerpo');
    const nombre = document.createElement('input'); nombre.type = 'text'; nombre.value = s.nombre; nombre.maxLength = 80; nombre.setAttribute('aria-label', 'Nombre');
    const dir = document.createElement('input'); dir.type = 'text'; dir.value = s.direccion || ''; dir.maxLength = 160; dir.placeholder = 'Calle y colonia'; dir.setAttribute('aria-label', 'Dirección');

    // Botones arriba a la derecha del bloque: Guardar cambios y Desactivar/Reactivar sucursal
    if (!esGerente) {
      const barra = el('div', 'su-barra');
      const pausa = el('button', 'btn chico' + (s.activa ? ' peligro' : ''), s.activa ? 'Desactivar sucursal' : 'Reactivar sucursal'); pausa.type = 'button';
      pausa.addEventListener('click', async () => {
        if (s.activa && !(await confirmar(`¿Desactivar la sucursal “${s.nombre}”? Dejará de recibir pedidos hasta que la reactives.`, { si: 'Desactivar', peligro: true }))) return;
        accionSucursal('admin/sucursales.php', { accion: 'editar', id: s.id, nombre: nombre.value.trim(), direccion: dir.value.trim(), activa: !s.activa }, s.activa ? 'Sucursal desactivada' : 'Sucursal reactivada');
      });
      const guardar = el('button', 'btn chico principal', 'Guardar cambios'); guardar.type = 'button';
      guardar.addEventListener('click', () => accionSucursal('admin/sucursales.php', { accion: 'editar', id: s.id, nombre: nombre.value.trim(), direccion: dir.value.trim(), activa: s.activa }, 'Sucursal actualizada'));
      barra.append(pausa, guardar);
      cuerpo.append(barra);
      const l1 = el('label', '', 'Nombre'); l1.append(nombre);
      const l2 = el('label', '', 'Dirección (opcional)'); l2.append(dir);
      cuerpo.append(l1, l2);
    } else if (s.direccion) {
      cuerpo.append(el('p', 'ayuda', s.direccion));
    }

    // Enlace para el QR de esta sucursal (el cliente abre el menú y sus pedidos van a esta sucursal)
    const enlace = location.origin + location.pathname.replace(/admin(\/.*)?$/, '') + (s.slug || '') + '/';
    const campoEnlace = document.createElement('input');
    campoEnlace.type = 'text'; campoEnlace.readOnly = true; campoEnlace.value = enlace; campoEnlace.setAttribute('aria-label', 'Enlace QR para menú de sucursal');
    campoEnlace.addEventListener('focus', () => campoEnlace.select());
    const copiar = el('button', 'btn chico', 'Copiar enlace'); copiar.type = 'button';
    copiar.addEventListener('click', async () => { try { await navigator.clipboard.writeText(enlace); avisar('Enlace copiado'); } catch { campoEnlace.select(); } });
    const filaQr = el('div', 'su-qr');
    filaQr.append(campoEnlace, copiar);
    const lq = el('div', 'su-campo'); lq.append(el('span', 'su-etq', 'Enlace QR para menú de sucursal'), el('span', 'ayuda', 'Este enlace es para que el cliente lo escanee con su celular y vea el menú y/o levante pedidos en esta sucursal.'), filaQr);
    // Código QR del enlace, debajo, con botón para descargarlo como imagen (para imprimirlo)
    const qr = qrcode(0, 'M');
    qr.addData(enlace);
    qr.make();
    const cajaQr = el('div', 'su-qr-img');
    cajaQr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });   // SVG que genera la librería (solo cuadros, sin texto del usuario)
    cajaQr.setAttribute('role', 'img'); cajaQr.setAttribute('aria-label', 'Código QR de ' + s.nombre);
    const bajar = el('button', 'btn chico', 'Descargar QR (PNG)'); bajar.type = 'button';
    bajar.addEventListener('click', () => descargarQr(qr, `qr-${s.slug || 'sucursal'}.png`));
    lq.append(cajaQr, bajar);
    cuerpo.append(lq);

    // Interruptor: ¿el cliente puede levantar pedidos desde el QR o solo ver el menú? (mismo ajuste que Ajustes → pedidos de clientes por QR)
    if (pedidosQr.has(s.id)) {
      const bloqueado = !pq.general && !pq.puede_general;   // el dueño lo apagó para toda la empresa y el gerente no puede encenderlo
      const sw = el('label', 'switch');
      const caja = document.createElement('input');
      caja.type = 'checkbox'; caja.checked = pedidosQr.get(s.id); caja.disabled = bloqueado;
      const texto = el('span', '', caja.checked ? 'El cliente puede levantar pedidos' : 'Solo ver el menú');
      sw.append(caja, el('span', 'slider'), texto);
      caja.addEventListener('change', async () => {
        caja.disabled = true;
        $('su-error').textContent = '';
        try {
          await enviarJson(API + 'admin/cliente-pedidos.php', { accion: 'sucursal', sucursal_id: s.id, activo: caja.checked });
          texto.textContent = caja.checked ? 'El cliente puede levantar pedidos' : 'Solo ver el menú';
          avisar(caja.checked ? 'Ahora el cliente puede levantar pedidos desde el QR' : 'Ahora el cliente solo verá el menú');
        } catch (err) { caja.checked = !caja.checked; $('su-error').textContent = err.message; }
        caja.disabled = false;
      });
      const lp = el('div', 'su-campo');
      lp.append(el('span', 'su-etq', 'Pedidos desde el QR'), sw,
        el('span', 'ayuda', bloqueado
          ? 'El dueño desactivó los pedidos de clientes en toda la empresa; aquí no se pueden activar.'
          : 'Activado: el cliente que escanea el QR puede levantar su pedido. Desactivado: solo ve el menú.'));
      cuerpo.append(lp);
    }

    // Las mesas se administran en su propia ventana
    const mesasBtn = el('button', 'btn', `Mesas (${s.mesas})`); mesasBtn.type = 'button';
    mesasBtn.addEventListener('click', () => abrirMesas(s));
    const lm = el('div', 'su-campo'); lm.append(el('span', 'su-etq', 'Mesas para comer aquí'), mesasBtn);
    cuerpo.append(lm);

    det.append(cuerpo);
    lista.append(det);
  }
}

$('btn-sucursales').addEventListener('click', async () => {
  $('su-error').textContent = '';
  try { await cargarSucursales(); } catch (err) { $('su-error').textContent = err.message; }
  abrirPagina(dlgSucursales, 'btn-sucursales');
});
$('su-cerrar').addEventListener('click', () => dlgSucursales.close());
$('form-nueva-sucursal').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ok = await accionSucursal('admin/sucursales.php', { accion: 'crear', nombre: $('su-nombre').value.trim(), direccion: $('su-direccion').value.trim() }, 'Sucursal creada');
  if (ok) { $('su-nombre').value = ''; $('su-direccion').value = ''; }
});

/* ------------------------------------------------------------------ */
/*  Reportes                                                           */
/* ------------------------------------------------------------------ */

const dlgReportes = $('dlg-reportes');
const NOMBRE_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };
const NOMBRE_MODALIDAD = { aqui: 'Comer aquí', llevar: 'Para llevar', recoger: 'Recoger' };
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function fijarRango(r) {
  const hoy = new Date();
  let a = new Date(hoy), b = new Date(hoy);
  if (r === 'ayer') { a.setDate(a.getDate() - 1); b = new Date(a); }
  else if (r === '7') { a.setDate(a.getDate() - 6); }
  else if (r === 'mes') { a = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }
  $('rp-desde').value = isoLocal(a);
  $('rp-hasta').value = isoLocal(b);
}

function tablaRep(titulo, columnas, filas, vacio = 'Sin datos en este periodo.') {
  const sec = el('section', 'rep-bloque');
  sec.append(el('h3', '', titulo));
  if (!filas.length) { sec.append(el('p', 'ayuda', vacio)); return sec; }
  const t = document.createElement('table');
  t.className = 'rep-tabla';
  const cab = document.createElement('tr');
  columnas.forEach((c, i) => { const th = document.createElement('th'); th.textContent = c; if (i) th.className = 'num'; cab.append(th); });
  t.append(cab);
  for (const f of filas) {
    const tr = document.createElement('tr');
    f.forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i) td.className = 'num'; tr.append(td); });
    t.append(tr);
  }
  sec.append(t);
  return sec;
}

async function cargarReporte() {
  $('rp-error').textContent = '';
  const q = new URLSearchParams({ desde: $('rp-desde').value, hasta: $('rp-hasta').value });
  if ($('rp-sucursal').value) q.set('sucursal', $('rp-sucursal').value);
  let r;
  try { r = await pedir(API + 'admin/reportes.php?' + q); } catch (err) { $('rp-error').textContent = err.message; return; }

  const sel = $('rp-sucursal');
  if (sel.options.length !== r.sucursales.length + 1) {
    const actual = sel.value;
    sel.replaceChildren();
    const todas = document.createElement('option'); todas.value = ''; todas.textContent = 'Todas (en conjunto)'; sel.append(todas);
    for (const s of r.sucursales) { const o = document.createElement('option'); o.value = String(s.id); o.textContent = s.nombre; sel.append(o); }
    sel.value = actual;
  }

  const caja = $('rp-contenido');
  caja.replaceChildren();
  const m = r.resumen;
  const tarjetas = el('div', 'rep-tarjetas');
  for (const [t, v] of [['Pedidos', String(m.pedidos)], ['Vendido', dinero.format(m.vendido)], ['Ticket promedio', dinero.format(m.ticket)], ['Cobrado en caja', dinero.format(m.cobrado)], ['Propinas', dinero.format(m.propinas)], ['Comisión de terminal', dinero.format(m.comisiones)], ['Cancelados', String(m.cancelados)]]) {
    const c = el('div', 'rep-tarjeta');
    c.append(el('span', '', t), el('strong', '', v));
    tarjetas.append(c);
  }
  caja.append(tarjetas);
  caja.append(el('p', 'ayuda', '“Vendido” es el total de los pedidos (sin cancelados). “Cobrado” es lo que se registró en Caja.'));

  if (!$('rp-sucursal').value && r.sucursales.length > 1) {
    caja.append(tablaRep('Por sucursal', ['Sucursal', 'Pedidos', 'Vendido', 'Cobrado', 'Propinas'],
      r.por_sucursal.map((s) => [s.nombre, s.pedidos, dinero.format(s.vendido), dinero.format(s.cobrado), dinero.format(s.propinas)])));
  }
  caja.append(tablaRep('Por día', ['Día', 'Pedidos', 'Vendido'], r.por_dia.map((d) => [d.fecha, d.pedidos, dinero.format(d.vendido)])));
  caja.append(tablaRep('Formas de pago', ['Método', 'Pagos', 'Monto', 'Propinas'], r.por_metodo.map((x) => [NOMBRE_METODO[x.metodo] || x.metodo, x.pagos, dinero.format(x.monto), dinero.format(x.propinas)])));
  caja.append(tablaRep('Comer aquí / llevar / recoger', ['Tipo', 'Pedidos', 'Vendido'], r.por_modalidad.map((x) => [NOMBRE_MODALIDAD[x.modalidad] || x.modalidad, x.pedidos, dinero.format(x.vendido)])));
  caja.append(tablaRep('Por mesa', ['Mesa', 'Pedidos', 'Vendido'], r.por_mesa.map((x) => [x.mesa, x.pedidos, dinero.format(x.vendido)]), 'Aún no hay pedidos con mesa en este periodo.'));
  caja.append(tablaRep('Lo que más se vende', ['Producto', 'Unidades', 'Importe'], r.productos.map((p) => [p.nombre, p.unidades, dinero.format(p.importe)])));
}

$('btn-reportes').addEventListener('click', () => {
  if (!$('rp-desde').value) fijarRango('hoy');
  abrirPagina(dlgReportes, 'btn-reportes');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // que no quede resaltado el campo de fecha
  cargarReporte();
});
$('rp-cerrar').addEventListener('click', () => dlgReportes.close());
document.querySelectorAll('.rep-rapidos [data-rango]').forEach((b) => b.addEventListener('click', () => { fijarRango(b.dataset.rango); cargarReporte(); }));
['rp-desde', 'rp-hasta', 'rp-sucursal'].forEach((id) => $(id).addEventListener('change', cargarReporte));

/* ------------------------------------------------------------------ */
/*  Apariencia: logo y colores                                         */
/* ------------------------------------------------------------------ */

const dlgApariencia = $('dlg-apariencia');
let apDatos = null;           // { colores, defecto, nombres }
let apColores = {};
const AP_PRESETS = [
  { nombre: 'Comandia', colores: { encabezado: '#0a6b4e', acento: '#ff7a30', boton: '#0a6b4e', fondo: '#f3f7f4', texto: '#10241c' } },
  { nombre: 'Clásico', colores: { encabezado: '#601020', acento: '#f8c000', boton: '#2f7d3a', fondo: '#fff7e0', texto: '#2a1015' } },
  { nombre: 'Verde fresco', colores: { encabezado: '#1f5e3b', acento: '#f2c94c', boton: '#2f7d3a', fondo: '#f4faf1', texto: '#14231a' } },
  { nombre: 'Azul moderno', colores: { encabezado: '#12355b', acento: '#ffb703', boton: '#1d6fd1', fondo: '#f3f7fc', texto: '#101c2b' } },
  { nombre: 'Morado y rosa', colores: { encabezado: '#4a1d6b', acento: '#ff8fb1', boton: '#8e44ad', fondo: '#faf5fd', texto: '#24102f' } },
  { nombre: 'Carbón y naranja', colores: { encabezado: '#222222', acento: '#ff7a00', boton: '#d9480f', fondo: '#f6f4f1', texto: '#1c1c1c' } },
];

/* Mismas cuentas que el servidor (api/lib_marca.php) para ver la vista previa al instante */
const apRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const apLum = (h) => { const [r, g, b] = apRgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const apContraste = (a, b) => { const x = apLum(a), y = apLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const apTextoSobre = (h) => (apContraste(h, '#ffffff') >= apContraste(h, '#1a1a1a') ? '#ffffff' : '#1a1a1a');
const apMezcla = (a, b, t) => { const x = apRgb(a), y = apRgb(b); return '#' + [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, '0')).join(''); };

function apAplicar(c) {
  const s = document.documentElement.style;
  s.setProperty('--color-vino', c.encabezado);
  s.setProperty('--color-amarillo', c.acento);
  s.setProperty('--color-principal', c.boton);
  s.setProperty('--color-fondo', c.fondo);
  s.setProperty('--color-oscuro', c.texto);
  s.setProperty('--color-tarjeta', apLum(c.fondo) < 0.2 ? apMezcla(c.fondo, '#ffffff', 0.08) : '#ffffff');
  s.setProperty('--color-suave', apMezcla(c.fondo, c.acento, 0.22));
  s.setProperty('--color-borde', apMezcla(c.fondo, c.texto, 0.12));
  s.setProperty('--texto-encabezado', apTextoSobre(c.encabezado));
  s.setProperty('--texto-boton', apTextoSobre(c.boton));
  s.setProperty('--color-llevar', c.llevar);
  s.setProperty('--texto-llevar', apContraste(c.llevar, '#ffffff') >= 3.2 ? '#ffffff' : '#1a1a1a');   // letras en negritas grandes: basta contraste 3.2 (así el azul de siempre conserva letras blancas)
  const malo = apContraste(c.texto, c.fondo) < 4.5;
  $('ap-aviso').textContent = malo ? '⚠ El texto casi no se lee sobre ese fondo; elige colores con más contraste.' : '';
  $('ap-guardar').disabled = malo;
}

function apQuitarVistaPrevia() {
  const s = document.documentElement.style;
  ['--color-vino', '--color-amarillo', '--color-principal', '--color-fondo', '--color-oscuro', '--color-tarjeta', '--color-suave', '--color-borde', '--texto-encabezado', '--texto-boton', '--color-llevar', '--texto-llevar'].forEach((p) => s.removeProperty(p));
}

function apRecargarTema() {
  apQuitarVistaPrevia();
  const link = document.querySelector('link[href*="api/tema.php"]');
  if (link) link.href = '../api/tema.php?t=' + Date.now();
}

function apRecargarLogo() {
  const url = '../api/logo.php?t=' + Date.now();
  document.querySelectorAll('img.logo, #ap-logo-img').forEach((i) => { i.src = url; });
}

function apPintar() {
  const caja = $('ap-colores');
  caja.replaceChildren();
  for (const k of Object.keys(apDatos.nombres)) {
    const fila = el('label', 'ap-color');
    const sel = document.createElement('input');
    sel.type = 'color'; sel.value = apColores[k]; sel.id = 'ap-' + k;
    sel.addEventListener('input', () => { apColores[k] = sel.value; apAplicar(apColores); });
    fila.append(sel, el('span', '', apDatos.nombres[k]));
    caja.append(fila);
  }
  const pre = $('ap-presets');
  pre.replaceChildren();
  for (const p of AP_PRESETS) {
    const b = el('button', 'ap-preset');
    b.type = 'button';
    b.title = p.nombre;
    for (const k of ['encabezado', 'acento', 'boton', 'fondo']) { const m = el('i', ''); m.style.background = p.colores[k]; b.append(m); }
    b.append(el('span', '', p.nombre));
    b.addEventListener('click', () => { apColores = { ...apColores, ...p.colores };   // los temas no cambian el color de "Para llevar"
    apPintar(); apAplicar(apColores); });
    pre.append(b);
  }
}

async function apCargar() {
  apDatos = await pedir(API + 'admin/marca.php');
  apColores = { ...apDatos.colores };
  apPintar();
  apAplicar(apColores);
  $('ap-logo-quitar').hidden = !apDatos.logo;
}

$('btn-apariencia').addEventListener('click', async () => {
  $('ap-error').textContent = '';
  try { await apCargar(); } catch (err) { $('ap-error').textContent = err.message; }
  abrirPagina(dlgApariencia, 'btn-apariencia');
});
dlgApariencia.addEventListener('close', apQuitarVistaPrevia);
$('ap-cerrar').addEventListener('click', () => dlgApariencia.close());
$('ap-guardar').addEventListener('click', async () => {
  $('ap-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/marca.php', { accion: 'colores', colores: apColores });
    apRecargarTema();
    avisar(r.avisos && r.avisos.length ? r.avisos[0] : 'Apariencia guardada', !!(r.avisos && r.avisos.length));
    dlgApariencia.close();
  } catch (err) { $('ap-error').textContent = err.message; }
});
$('ap-restablecer').addEventListener('click', async () => {
  if (!(await confirmar('¿Volver a los colores originales de Comandia?', { si: 'Restablecer', no: 'Volver' }))) return;
  try { await enviarJson(API + 'admin/marca.php', { accion: 'restablecer' }); apRecargarTema(); await apCargar(); avisar('Colores restablecidos'); }
  catch (err) { $('ap-error').textContent = err.message; }
});
$('ap-logo-archivo').addEventListener('change', async (ev) => {
  const archivo = ev.target.files[0];
  ev.target.value = '';
  if (!archivo) return;
  $('ap-error').textContent = '';
  const datos = new FormData();
  datos.append('accion', 'logo');
  datos.append('logo', archivo);
  try { await pedir(API + 'admin/marca.php', { method: 'POST', body: datos }); apRecargarLogo(); $('ap-logo-quitar').hidden = false; avisar('Logo actualizado'); }
  catch (err) { $('ap-error').textContent = err.message; }
});
$('ap-logo-quitar').addEventListener('click', async () => {
  if (!(await confirmar('¿Quitar el logo de tu empresa? Se volverá a usar el logo de Comandia.', { si: 'Quitar logo', peligro: true }))) return;
  try { await enviarJson(API + 'admin/marca.php', { accion: 'quitar_logo' }); apRecargarLogo(); $('ap-logo-quitar').hidden = true; avisar('Logo quitado'); }
  catch (err) { $('ap-error').textContent = err.message; }
});

/* ------------------------------------------------------------------ */
/*  Ajustes de cocina                                                  */
/* ------------------------------------------------------------------ */

const dlgAjustes = $('dlg-prioridades');
let datosPrio = null;

/** Distribución de comandas en Cocina (apiladas / una fila con scroll lateral): interruptor general (dueño) y por sucursal. Se guarda al marcar. */
function pintarCocinaHorizontal(ch) {
  $('ch-general-fila').hidden = !ch.puede_general;
  $('ch-general').checked = ch.general;
  const lista = $('ch-lista');
  lista.replaceChildren();
  for (const s of ch.sucursales) {
    const x = el('input'); x.type = 'checkbox'; x.checked = s.activo;
    x.addEventListener('change', () => guardarCocinaHorizontal({ ambito: 'sucursal', sucursal_id: s.id, activo: x.checked }));
    const fila = el('label', 'lote-op'); fila.append(x, el('span', '', s.nombre));
    lista.append(fila);
  }
}
async function guardarCocinaHorizontal(cambio) {
  $('pr-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/prioridades.php', { accion: 'cocina_horizontal', ...cambio });
    pintarCocinaHorizontal(r.cocina_horizontal);
    avisar('Guardado');
  } catch (err) {
    $('pr-error').textContent = err.message;
    try { pintarCocinaHorizontal((await pedir(API + 'admin/prioridades.php')).cocina_horizontal); } catch { /* se queda como estaba */ }
  }
}
$('ch-general').addEventListener('change', () => guardarCocinaHorizontal({ ambito: 'general', activo: $('ch-general').checked }));

async function cargarAjustes() {
  datosPrio = await pedir(API + 'admin/prioridades.php');
  pintarCocinaHorizontal(datosPrio.cocina_horizontal);
  $('pm-prep').value = datosPrio.min_preparacion;
  pintarLote();
}

/* "Preparar en lote": categorías colapsadas; al expandir una se ven sus platillos. Se puede elegir la categoría completa
   (incluye también los platillos que agregues después) o solo platillos concretos. Se guarda al marcar. */
const loteCats = new Set();      // categorías elegidas completas
const loteProds = new Set();     // platillos sueltos elegidos
const loteAbiertas = new Set();  // categorías expandidas en pantalla

function pintarLote() {
  loteCats.clear(); loteProds.clear();
  for (const c of datosPrio.lote) if (c.activa) loteCats.add(c.id);
  for (const id of datosPrio.lote_productos || []) loteProds.add(id);
  const lista = $('lote-lista');
  lista.replaceChildren();
  for (const c of datosPrio.lote) {
    const platillos = datosPrio.productos.filter((p) => p.categoria_id === c.id);
    const det = el('details', 'lote-cat');
    det.open = loteAbiertas.has(c.id);
    det.addEventListener('toggle', () => { if (det.open) loteAbiertas.add(c.id); else loteAbiertas.delete(c.id); });
    const resumen = el('summary', 'lote-cat-resumen');
    const marca = document.createElement('input');
    marca.type = 'checkbox'; marca.className = 'lote-cat-marca';
    marca.setAttribute('aria-label', `Toda la categoría ${c.nombre}`);
    marca.addEventListener('click', (ev) => ev.stopPropagation());
    marca.addEventListener('change', () => { if (marca.checked) loteCats.add(c.id); else loteCats.delete(c.id); refrescarLote(); guardarLote(); });
    const cuenta = el('span', 'chip');
    resumen.append(marca, el('span', 'cat-nombre', c.nombre), cuenta);
    det.append(resumen);
    const cuerpo = el('div', 'lote-cat-cuerpo');
    const casillas = [];
    if (platillos.length === 0) cuerpo.append(el('p', 'ayuda', 'Esta categoría aún no tiene platillos.'));
    for (const p of platillos) {
      const f = el('label', 'lote-op');
      const x = document.createElement('input');
      x.type = 'checkbox'; x.value = String(p.id);
      x.addEventListener('change', () => { if (x.checked) loteProds.add(p.id); else loteProds.delete(p.id); refrescarLote(); guardarLote(); });
      f.append(x, el('span', '', p.nombre));
      cuerpo.append(f);
      casillas.push({ p, x });
    }
    det.append(cuerpo);
    lista.append(det);
    c._ui = { marca, cuenta, casillas };
  }
  refrescarLote();
}

/** Pone al día las casillas y los contadores según lo elegido (categoría completa → sus platillos quedan marcados y fijos). */
function refrescarLote() {
  for (const c of datosPrio.lote) {
    const { marca, cuenta, casillas } = c._ui;
    const completa = loteCats.has(c.id);
    const sueltos = casillas.filter(({ p }) => loteProds.has(p.id)).length;
    marca.checked = completa;
    marca.indeterminate = !completa && sueltos > 0;
    for (const { p, x } of casillas) { x.checked = completa || loteProds.has(p.id); x.disabled = completa; }
    cuenta.textContent = completa ? 'Toda la categoría' : sueltos ? `${sueltos} de ${casillas.length} platillos` : 'Ninguno';
    cuenta.classList.toggle('activo', completa || sueltos > 0);
  }
}

/* Pedidos del cliente por QR: interruptor de toda la empresa (dueño) y de cada sucursal (dueño o gerente).
   Los cambios NO se guardan al marcar: se acumulan y se aplican al tocar "Guardar configuración". */
let cpOriginal = null;   // estado guardado en el servidor: { general, puede_general, sucursales: [{id, activo}] }

/** Compara lo marcado en pantalla con lo guardado; habilita el botón solo si hay cambios. */
function cpActualizarPendiente() {
  if (!cpOriginal) return;
  const cambios = cpCambios().length > 0;
  $('cp-guardar').disabled = !cambios;
  $('cp-pendiente').hidden = !cambios;
}

/** Lista de cambios (en el orden en que deben aplicarse): primero el general, luego cada sucursal. */
function cpCambios() {
  const cambios = [];
  if (cpOriginal.puede_general && $('cp-general').checked !== cpOriginal.general) {
    cambios.push({ accion: 'general', activo: $('cp-general').checked });
  }
  document.querySelectorAll('#cp-lista input').forEach((x) => {
    const id = Number(x.dataset.id);
    const antes = cpOriginal.sucursales.find((s) => s.id === id);
    if (antes && x.checked !== antes.activo) cambios.push({ accion: 'sucursal', sucursal_id: id, activo: x.checked });
  });
  // Pestañas "Mi pedido" / "Pagar" de cada sucursal (se mandan juntas si cambió cualquiera de las dos)
  for (const s of cpOriginal.sucursales) {
    const vp = document.querySelector(`#cp-pestanas input[data-id="${s.id}"][data-campo="pedido"]`);
    const vg = document.querySelector(`#cp-pestanas input[data-id="${s.id}"][data-campo="pagar"]`);
    if (vp && vg && (vp.checked !== s.ver_pedido || vg.checked !== s.ver_pagar)) cambios.push({ accion: 'pestanas', sucursal_id: s.id, ver_pedido: vp.checked, ver_pagar: vg.checked });
  }
  return cambios;
}

async function cargarClientePedidos() {
  const r = await pedir(API + 'admin/cliente-pedidos.php');
  cpOriginal = { general: r.general, puede_general: r.puede_general, sucursales: r.sucursales.map((s) => ({ id: s.id, activo: s.activo, ver_pedido: s.ver_pedido, ver_pagar: s.ver_pagar })) };
  $('cp-general-fila').hidden = !r.puede_general;
  $('cp-general').checked = r.general;
  const lista = $('cp-lista');
  lista.replaceChildren();
  for (const s of r.sucursales) {
    const f = el('label', 'lote-op');
    const x = document.createElement('input');
    x.type = 'checkbox'; x.checked = s.activo; x.dataset.id = String(s.id);
    x.disabled = !r.general && !r.puede_general;   // el gerente no puede encenderlo si la empresa lo apagó
    x.addEventListener('change', cpActualizarPendiente);
    f.append(x, el('span', '', s.nombre + (s.activo && !s.efectivo ? ' (apagado por la empresa)' : '')));
    lista.append(f);
  }
  // Pestañas visibles para el cliente, por sucursal
  const pest = $('cp-pestanas');
  pest.replaceChildren();
  for (const s of r.sucursales) {
    const bloque = el('div', 'cp-pest-suc');
    if (r.sucursales.length > 1) bloque.append(el('strong', '', s.nombre));
    const fila = el('div', 'lote-lista');
    for (const [campo, texto, valor] of [['pedido', 'Mostrar «Mi pedido»', s.ver_pedido], ['pagar', 'Mostrar «Pagar»', s.ver_pagar]]) {
      const f = el('label', 'lote-op');
      const x = document.createElement('input');
      x.type = 'checkbox'; x.checked = valor; x.dataset.id = String(s.id); x.dataset.campo = campo;
      x.addEventListener('change', cpActualizarPendiente);
      f.append(x, el('span', '', texto));
      fila.append(f);
    }
    bloque.append(fila);
    pest.append(bloque);
  }
  const nota = $('cp-nota');
  nota.hidden = r.general || r.puede_general;
  nota.textContent = 'El dueño desactivó los pedidos por QR en toda la empresa. Solo él puede volver a activarlos.';
  cpActualizarPendiente();
}

/** Envía al servidor todos los cambios pendientes y vuelve a leer el estado real. */
async function guardarClientePedidos() {
  $('cp-error').textContent = '';
  const boton = $('cp-guardar');
  boton.disabled = true;
  try {
    for (const cambio of cpCambios()) await enviarJson(API + 'admin/cliente-pedidos.php', cambio);
    avisar('Configuración guardada');
  } catch (err) { $('cp-error').textContent = err.message; }
  try { await cargarClientePedidos(); } catch { /* se queda como estaba */ }
}
$('cp-general').addEventListener('change', cpActualizarPendiente);
$('cp-guardar').addEventListener('click', guardarClientePedidos);

async function guardarLote() {
  $('pr-error').textContent = '';
  const cats = [...loteCats];
  // Los platillos de una categoría completa ya van incluidos: solo se guardan los sueltos de las demás
  const completas = new Set(datosPrio.productos.filter((p) => loteCats.has(p.categoria_id)).map((p) => p.id));
  const prods = [...loteProds].filter((id) => !completas.has(id));
  try {
    await enviarJson(API + 'admin/prioridades.php', { accion: 'lote', categorias: cats, productos: prods });
    avisar('Guardado: cocina verá esas categorías y platillos en “Preparar en lote”');
  } catch (err) { $('pr-error').textContent = err.message; }
}

async function guardarAjustes() {
  $('pr-error').textContent = '';
  try {
    await enviarJson(API + 'admin/prioridades.php', { accion: 'modalidad', aqui: datosPrio.modalidad.aqui, llevar: datosPrio.modalidad.llevar, prep: Number($('pm-prep').value) || 0 });
    await cargarAjustes();
    avisar('Ajuste guardado');
  } catch (err) {
    $('pr-error').textContent = err.message;
  }
}

$('btn-prioridades').addEventListener('click', async () => {
  $('pr-error').textContent = '';
  try { await cargarAjustes(); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgAjustes, 'btn-prioridades');
});
$('pm-prep').addEventListener('change', guardarAjustes);
$('pr-cerrar').addEventListener('click', () => dlgAjustes.close());

/* Ajustes de tomar pedidos: interruptor del código rápido. Lo cambian el dueño (empresa o cualquier sucursal) y el gerente
   (solo su sucursal). Se guarda al marcar. */
const dlgTomaPedidos = $('dlg-toma-pedidos');

/** Dibuja el interruptor general y una casilla por sucursal con el estado que manda el servidor. */
function pintarCodigoRapido(cr) {
  $('tp-general-fila').hidden = !cr.puede_general;
  $('tp-general').checked = cr.general;
  $('tp-nota').hidden = cr.general || cr.puede_general;
  const lista = $('tp-lista');
  lista.replaceChildren();
  for (const s of cr.sucursales) {
    const x = el('input'); x.type = 'checkbox'; x.checked = cr.general && s.activo; x.disabled = !cr.general;
    x.addEventListener('change', () => guardarCodigoRapido({ ambito: 'sucursal', sucursal_id: s.id, activo: x.checked }));
    const fila = el('label', 'lote-op'); fila.append(x, el('span', '', s.nombre));
    lista.append(fila);
  }
}

async function guardarCodigoRapido(cambio) {
  $('tp-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/prioridades.php', { accion: 'codigo_rapido', ...cambio });
    pintarCodigoRapido(r.codigo_rapido);
    avisar('Guardado');
  } catch (err) {
    $('tp-error').textContent = err.message;
    try { pintarCodigoRapido((await pedir(API + 'admin/prioridades.php')).codigo_rapido); } catch { /* se queda como estaba */ }
  }
}
$('tp-general').addEventListener('change', () => guardarCodigoRapido({ ambito: 'general', activo: $('tp-general').checked }));

$('btn-toma-pedidos').addEventListener('click', async () => {
  $('tp-error').textContent = '';
  try { pintarCodigoRapido((await pedir(API + 'admin/prioridades.php')).codigo_rapido); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgTomaPedidos, 'btn-toma-pedidos');
});
$('tp-cerrar').addEventListener('click', () => dlgTomaPedidos.close());

/* Ajustes de pedidos por QR: su propia página */
const dlgPedidosQr = $('dlg-pedidos-qr');
$('btn-pedidos-qr').addEventListener('click', async () => {
  $('cp-error').textContent = '';
  try { await cargarClientePedidos(); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgPedidosQr, 'btn-pedidos-qr');
});
$('cp-cerrar').addEventListener('click', () => dlgPedidosQr.close());


/* ------------------------------------------------------------------ */
/*  Carga masiva de platillos (plantilla de Excel + ZIP de fotos)      */
/* ------------------------------------------------------------------ */
const dlgCarga = $('dlg-carga');
const ETIQUETA_CARGA = { crear: '➕ Nuevo', actualizar: '✏️ Actualiza', error: '⛔ Error' };
const ETIQUETA_FOTO = { nueva: '🖼 Foto nueva', conserva: '🖼 Conserva la actual', ninguna: 'Sin foto', falta: '⚠️ Foto no encontrada' };
let cargaListaParaImportar = false;   // ya se revisó la planilla actual y se puede confirmar

/** Pinta la vista previa (o el resultado final, cuando ya se importó). */
function pintarCarga(r) {
  const caja = $('cm-resultado');
  caja.hidden = false;
  $('cm-titulo').textContent = r.confirmado ? '✅ Carga terminada' : 'Vista previa (todavía no se guardó nada)';
  const chips = [
    ['cm-ok', `${r.nuevos} ${r.confirmado ? 'creados' : 'nuevos'}`],
    ['cm-ok', `${r.actualizados} ${r.confirmado ? 'actualizados' : 'se actualizan'}`],
    [r.con_error ? 'cm-mal' : 'cm-ok', `${r.con_error} con error${r.con_error ? (r.confirmado ? ' (no se guardaron)' : ' (se omiten)') : ''}`],
  ];
  $('cm-resumen').replaceChildren(...chips.map(([c, t]) => el('span', 'cm-chip ' + c, t)));
  const notas = [];
  if (r.categorias_nuevas.length) notas.push(`${r.confirmado ? 'Categorías creadas' : 'Se crearán las categorías'}: ${r.categorias_nuevas.join(', ')}.`);
  if (r.fotos_sin_usar.length) notas.push(`Fotos del ZIP que ningún platillo usa: ${r.fotos_sin_usar.slice(0, 12).join(', ')}${r.fotos_sin_usar.length > 12 ? ` y ${r.fotos_sin_usar.length - 12} más` : ''}.`);
  $('cm-extra').textContent = notas.join(' ');
  $('cm-extra').hidden = notas.length === 0;

  const lista = $('cm-filas');
  lista.replaceChildren();
  for (const f of r.filas) {
    const fila = el('div', 'cm-fila cm-' + f.accion);
    const cab = el('div', 'cm-cab');
    cab.append(el('span', 'cm-est', ETIQUETA_CARGA[f.accion]), el('strong', 'cm-nombre', f.nombre || '(sin nombre)'), el('span', 'cm-fn', `fila ${f.fila}`));
    const det = el('div', 'cm-det', [f.categoria, f.precio ? dinero.format(Number(f.precio)) : '', f.codigo ? `código ${f.codigo}` : '', ETIQUETA_FOTO[f.foto]].filter(Boolean).join(' · '));
    fila.append(cab, det);
    for (const e of f.errores) fila.append(el('div', 'cm-msg cm-msg-error', '⛔ ' + e));
    for (const a of f.avisos) fila.append(el('div', 'cm-msg cm-msg-aviso', '⚠️ ' + a));
    lista.append(fila);
  }
  const buenos = r.nuevos + r.actualizados;
  $('cm-importar').hidden = r.confirmado || buenos === 0;
  $('cm-importar').textContent = `Importar ${buenos} platillo${buenos === 1 ? '' : 's'}`;
  $('cm-ver').hidden = !r.confirmado;
  caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Envía la planilla (y el ZIP) al servidor. confirmar = false → solo vista previa. */
async function enviarCarga(confirmar) {
  const datos = new FormData();
  datos.append('planilla', $('cm-planilla').files[0]);
  if ($('cm-zip').files[0]) datos.append('fotos', $('cm-zip').files[0]);
  datos.append('confirmar', confirmar ? '1' : '0');
  return pedir(API + 'admin/productos-importar.php', { method: 'POST', body: datos });
}

$('btn-carga').addEventListener('click', () => {
  $('cm-error').textContent = '';
  abrirPagina(dlgCarga, 'btn-carga');
});
$('cm-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('cm-error').textContent = '';
  const b = $('cm-revisar');
  b.disabled = true; b.textContent = 'Revisando…';
  try { pintarCarga(await enviarCarga(false)); }
  catch (err) { $('cm-error').textContent = err.message; $('cm-resultado').hidden = true; }
  finally { b.disabled = false; b.textContent = 'Revisar planilla'; }
});
// Si cambian los archivos, la vista previa anterior ya no vale
for (const id of ['cm-planilla', 'cm-zip']) $(id).addEventListener('change', () => { $('cm-resultado').hidden = true; });
$('cm-importar').addEventListener('click', async () => {
  $('cm-error').textContent = '';
  const b = $('cm-importar');
  b.disabled = true; b.textContent = 'Importando… (puede tardar con muchas fotos)';
  try {
    const r = await enviarCarga(true);
    pintarCarga(r);
    await cargarCatalogo();
    avisar(`Listo: ${r.nuevos} creados, ${r.actualizados} actualizados`);
  } catch (err) { $('cm-error').textContent = err.message; }
  finally { b.disabled = false; }
});
$('cm-ver').addEventListener('click', () => { dlgCarga.close(); });
$('cm-cerrar').addEventListener('click', () => dlgCarga.close());

/* ------------------------------------------------------------------ */
/*  Extras                                                             */
/* ------------------------------------------------------------------ */

const dlgExtras = $('dlg-extras');

/**
 * "Con costo": una casilla que, al marcarla, muestra el campo del precio.
 * Sin marcar el extra es gratis (precio 0).
 */
function campoCosto(precioInicial = 0) {
  const caja = el('div', 'costo');
  const etiqueta = el('label', 'casilla');
  const marca = document.createElement('input');
  marca.type = 'checkbox';
  marca.checked = precioInicial > 0;
  etiqueta.append(marca, el('span', '', 'Con costo'));

  const campo = document.createElement('input');
  campo.type = 'text';
  campo.inputMode = 'decimal';
  campo.placeholder = '$ precio';
  campo.setAttribute('aria-label', 'Precio del extra');
  campo.value = precioInicial > 0 ? precioInicial.toFixed(2) : '';
  campo.hidden = !marca.checked;

  marca.addEventListener('change', () => {
    campo.hidden = !marca.checked;
    if (marca.checked) campo.focus(); else campo.value = '';
  });
  caja.append(etiqueta, campo);
  return {
    caja,
    valor: () => (marca.checked ? (campo.value.trim() || '0') : '0'),
    reiniciar: () => { marca.checked = false; campo.value = ''; campo.hidden = true; },
  };
}

const costoNuevo = campoCosto(0);
$('x-costo-caja').append(...costoNuevo.caja.children);

/**
 * Tarjetas de extras, agrupadas en secciones (por "grupo"). Cada tarjeta muestra de un vistazo:
 *   · el nombre, su código para cocina y si es gratis o cuesta (+$10);
 *   · en qué categorías está disponible (✓ todos · 3/5 algunos · ○ ninguno). Tocar una categoría lo pone (o lo quita)
 *     en TODOS los platillos de esa categoría; para elegir platillo por platillo se hace desde el producto;
 *   · "Editar" abre el formulario de esa tarjeta (nombre, código, grupo, costo, activo) con su botón Guardar.
 */
const extraAbierto = new Set();   // tarjetas con el formulario de edición desplegado

function pintarExtras() {
  // Sugerencias de grupo (los que ya existen)
  $('lista-grupos').replaceChildren(...gruposExtras.map((g) => new Option(g)));
  pintarSeccionesExtras();
  pintarVariantesTipos();

  const caja = $('lista-extras');
  caja.replaceChildren();
  if (extras.length === 0) {
    caja.append(el('p', 'ayuda ex-vacio', 'Todavía no hay extras. Toca “＋ Nuevo extra” para crear el primero (por ejemplo, Sin cebolla).'));
    return;
  }
  if (categorias.length) caja.append(el('p', 'ayuda ex-leyenda', 'Toca una categoría para poner el extra (o quitarlo) en todos sus platillos. Verde = en todos · amarillo = en algunos · gris = en ninguno.'));

  // Secciones en el orden elegido (las vacías también se muestran); los extras sin sección van al final, en "Otros"
  const grupos = new Map(gruposExtras.map((g) => [g, []]));
  for (const x of extras) {
    const g = x.grupo && grupos.has(x.grupo) ? x.grupo : 'Otros';
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  if (grupos.has('Otros') && grupos.get('Otros').length === 0) grupos.delete('Otros');
  for (const [g, lista] of grupos) {
    if (grupos.size > 1 || lista.length === 0) caja.append(el('h3', 'ex-grupo', lista.length ? `${g} (${lista.length})` : `${g} (vacía)`));
    if (lista.length === 0) { caja.append(el('p', 'ayuda', 'Sin extras todavía. Crea uno con “＋ Nuevo extra” y elige esta sección en “Más opciones”.')); continue; }
    const rejilla = el('div', 'ex-rejilla');
    for (const x of lista) rejilla.append(tarjetaExtra(x));
    caja.append(rejilla);
  }
}

function tarjetaExtra(x) {
  const abierta = extraAbierto.has(x.id);
  const tarjeta = el('article', 'ex-tarjeta' + (x.activo ? '' : ' inactivo'));

  // Cabecera: nombre, código y precio
  const cab = el('div', 'ex-cab');
  const titulo = el('div', 'ex-titulo');
  titulo.append(el('strong', 'ex-nombre', x.nombre));
  if (x.codigo) titulo.append(el('span', 'chip', x.codigo));
  if (!x.activo) titulo.append(el('span', 'chip sin', 'Desactivado'));
  cab.append(titulo, el('span', 'ex-precio' + (x.precio > 0 ? ' paga' : ''), x.precio > 0 ? `+${dinero.format(x.precio)}` : 'Gratis'));
  tarjeta.append(cab);

  // Disponibilidad por categoría
  if (categorias.length) {
    const disp = el('div', 'ex-disp');
    disp.append(el('span', 'ex-etq', 'Disponible en:'));
    // Atajo: ponerlo (o quitarlo) en TODOS los platillos de golpe; luego se afina platillo por platillo
    const totalProd = productos.length;
    const conTodos = productos.filter((p) => p.extras.includes(x.id)).length;
    const todosOk = totalProd > 0 && conTodos === totalProd;
    const btnTodos = el('button', 'ex-cat ex-todos ' + (todosOk ? 'todos' : 'ninguno'), todosOk ? '✓ Todos los platillos' : '★ Todos los platillos');
    btnTodos.type = 'button';
    btnTodos.title = todosOk ? 'Toca para quitarlo de todos los platillos.' : 'Toca para ponerlo en todos los platillos (después puedes quitarlo en los que no).';
    btnTodos.addEventListener('click', () => accionExtra({ accion: 'asignar_todos', id: x.id, asignar: !todosOk }, todosOk ? 'Quitado de todos los platillos' : 'Agregado a todos los platillos'));
    disp.append(btnTodos);
    if (productos.some((p) => p.extras_precios && p.extras_precios[x.id] !== undefined)) {
      const igualar = el('button', 'ex-cat algunos', '↺ Igualar precio en todos');
      igualar.type = 'button';
      igualar.title = 'Algunos platillos cobran este extra con precio propio. Toca para que todos cobren el precio general.';
      igualar.addEventListener('click', () => accionExtra({ accion: 'precio_general', id: x.id }, 'Precio general aplicado a todos'));
      disp.append(igualar);
    }
    for (const c of categorias) {
      const deCat = productos.filter((p) => p.categoria_id === c.id);
      if (deCat.length === 0) continue;
      const con = deCat.filter((p) => p.extras.includes(x.id)).length;
      const estado = con === 0 ? 'ninguno' : con === deCat.length ? 'todos' : 'algunos';
      const chip = el('button', 'ex-cat ' + estado, `${estado === 'todos' ? '✓ ' : ''}${c.nombre}${estado === 'algunos' ? ` ${con}/${deCat.length}` : ''}`);
      chip.type = 'button';
      chip.title = estado === 'todos'
        ? `Está en todos los platillos de ${c.nombre}. Toca para quitarlo de todos.`
        : `Toca para ponerlo en todos los platillos de ${c.nombre}.`;
      chip.addEventListener('click', () => accionExtra({ accion: 'asignar', id: x.id, categoria_id: c.id, asignar: estado !== 'todos' },
        estado === 'todos' ? `Quitado de ${c.nombre}` : `Agregado a ${c.nombre}`));
      disp.append(chip);
    }
    tarjeta.append(disp);
  }

  // Pie: cuántos platillos lo llevan + editar / eliminar
  const usado = productos.filter((p) => p.extras.includes(x.id)).length;
  const pie = el('div', 'ex-pie');
  pie.append(el('span', 'ex-cuenta', usado === 0 ? 'Aún no está en ningún platillo' : `En ${usado} platillo${usado === 1 ? '' : 's'}`));
  const editar = el('button', 'btn chico', abierta ? 'Cerrar edición' : '✎ Editar');
  editar.type = 'button';
  editar.addEventListener('click', () => { if (abierta) extraAbierto.delete(x.id); else extraAbierto.add(x.id); pintarExtras(); });
  const borrar = el('button', 'btn chico peligro', '🗑');
  borrar.type = 'button'; borrar.title = 'Eliminar extra'; borrar.setAttribute('aria-label', 'Eliminar extra');
  borrar.addEventListener('click', async () => {
    if (await confirmar(`¿Eliminar el extra “${x.nombre}”? Se quita de todos los platillos.`, { si: 'Eliminar', peligro: true })) {
      extraAbierto.delete(x.id);
      accionExtra({ accion: 'eliminar', id: x.id }, 'Extra eliminado');
    }
  });
  pie.append(editar, borrar);
  tarjeta.append(pie);

  // Formulario de edición (desplegable)
  if (abierta) {
    const form = el('div', 'ex-editar');
    const campo = (texto, input) => { const l = el('label', '', texto); l.append(input); return l; };
    const nombre = document.createElement('input');
    nombre.type = 'text'; nombre.maxLength = 60; nombre.value = x.nombre;
    const codigo = document.createElement('input');
    codigo.type = 'text'; codigo.className = 'cod'; codigo.maxLength = 20; codigo.value = x.codigo || ''; codigo.placeholder = 'Ej. XQ';
    const grupo = document.createElement('input');
    grupo.type = 'text'; grupo.maxLength = 40; grupo.setAttribute('list', 'lista-grupos'); grupo.autocomplete = 'off'; grupo.value = x.grupo || ''; grupo.placeholder = 'Ej. Salsas';
    const costo = campoCosto(x.precio);
    const activo = el('label', 'switch');
    const casilla = document.createElement('input');
    casilla.type = 'checkbox'; casilla.checked = x.activo;
    activo.append(casilla, el('span', 'slider'), el('span', '', 'Disponible para pedir'));
    const guardar = el('button', 'btn principal', 'Guardar cambios');
    guardar.type = 'button';
    guardar.addEventListener('click', () => accionExtra(
      { accion: 'actualizar', id: x.id, nombre: nombre.value.trim(), codigo: codigo.value.trim(), grupo: grupo.value.trim(), precio: costo.valor(), activo: casilla.checked },
      'Extra actualizado'));
    const costoFila = el('div', 'ex-campo');
    costoFila.append(el('span', 'ex-etq', '¿Se cobra aparte?'), costo.caja);
    form.append(campo('Nombre', nombre), costoFila, campo('Código para la cocina', codigo), campo('Grupo', grupo), activo, guardar);
    tarjeta.append(form);
  }
  return tarjeta;
}

/* ------------------------------------------------------------------ */
/*  Secciones de extras (Quitar, Aparte, Solo...) y variantes          */
/* ------------------------------------------------------------------ */

/** Panel "Secciones": subir/bajar, renombrar y quitar. Quitar una sección NO borra sus extras (pasan a "Otros"). */
function pintarSeccionesExtras() {
  const caja = $('ex-sec-lista');
  caja.replaceChildren();
  if (gruposExtras.length === 0) { caja.append(el('p', 'ayuda', 'Todavía no hay secciones. Agrega la primera abajo.')); return; }
  gruposExtras.forEach((g, i) => {
    const fila = el('div', 'ex-sec-fila');
    const sube = el('button', 'btn chico', '▲'); sube.type = 'button'; sube.disabled = i === 0; sube.setAttribute('aria-label', 'Subir');
    const baja = el('button', 'btn chico', '▼'); baja.type = 'button'; baja.disabled = i === gruposExtras.length - 1; baja.setAttribute('aria-label', 'Bajar');
    sube.addEventListener('click', () => accionExtra({ accion: 'grupo_mover', nombre: g, direccion: 'subir' }));
    baja.addEventListener('click', () => accionExtra({ accion: 'grupo_mover', nombre: g, direccion: 'bajar' }));
    const n = extras.filter((x) => x.grupo === g).length;
    const nombre = el('span', 'ex-sec-nombre'); nombre.append(el('strong', '', g), el('small', '', ` · ${n} extra${n === 1 ? '' : 's'}`));
    const renombrar = el('button', 'btn chico', '✎ Renombrar'); renombrar.type = 'button';
    renombrar.addEventListener('click', async () => {
      const nuevo = await pedirTexto(`Nuevo nombre para la sección “${g}”:`, { si: 'Guardar', valor: g });
      if (nuevo && nuevo.trim() && nuevo.trim() !== g) accionExtra({ accion: 'grupo_renombrar', nombre: g, nuevo: nuevo.trim() }, 'Sección renombrada');
    });
    const quitar = el('button', 'btn chico peligro', '🗑'); quitar.type = 'button'; quitar.title = 'Quitar sección'; quitar.setAttribute('aria-label', 'Quitar sección');
    quitar.addEventListener('click', async () => {
      const aviso = n ? ` Sus ${n} extra${n === 1 ? '' : 's'} NO se borran: pasan a “Otros”.` : '';
      if (await confirmar(`¿Quitar la sección “${g}”?${aviso}`, { si: 'Quitar sección', peligro: true })) accionExtra({ accion: 'grupo_eliminar', nombre: g }, 'Sección quitada');
    });
    fila.append(sube, baja, nombre, renombrar, quitar);
    caja.append(fila);
  });
}

$('ex-sec-abrir').addEventListener('click', () => { const abrir = $('ex-secciones').hidden; cerrarPanelesExtras(); $('ex-secciones').hidden = !abrir; });
$('ex-sec-cerrar').addEventListener('click', () => { $('ex-secciones').hidden = true; });
$('ex-sec-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await accionExtra({ accion: 'grupo_crear', nombre: $('ex-sec-nueva').value.trim() }, 'Sección creada');
  if (!$('x-error').textContent) $('ex-sec-nueva').value = '';
});

/** Cierra los paneles de arriba (nuevo extra, variantes, secciones) para que solo haya uno abierto a la vez. */
function cerrarPanelesExtras() {
  $('form-nuevo-extra').hidden = true; $('ex-nuevo-abrir').hidden = false;
  $('form-variantes').hidden = true;
  $('ex-secciones').hidden = true;
}
$('ex-nuevo-abrir').addEventListener('click', cerrarPanelesExtras, true);   // fase de captura: cierra los otros antes de abrir este

/* ---- Variantes de un ingrediente: "Sin X", "X aparte", "Solo X"... ---- */
const VARIANTES_BASE = [
  { texto: 'Sin {x}', seccion: 'Quitar', activo: true },
  { texto: '{x} aparte', seccion: 'Aparte', activo: true },
  { texto: 'Solo {x}', seccion: 'Solo', activo: true },
  { texto: 'Extra {x}', seccion: 'Extras', activo: false, precio: '' },
  { texto: 'Poco {x}', seccion: 'Cantidad', activo: false },
  { texto: 'Mucho {x}', seccion: 'Cantidad', activo: false },
  { texto: 'Doble {x}', seccion: 'Cantidad', activo: false, precio: '' },
  { texto: '{x} al lado', seccion: 'Aparte', activo: false },
];
let variantesEstado = null;     // [{texto, seccion, activo, precio}] editable en pantalla
let varCategorias = new Set();  // categorías elegidas

const mayusInicial = (t) => t.charAt(0).toLocaleUpperCase('es-MX') + t.slice(1);

/** Nombre real de la sección si ya existe con otras mayúsculas ("quitar" → "Quitar"). */
const seccionExistente = (nombre) => gruposExtras.find((g) => g.toLowerCase() === nombre.trim().toLowerCase()) || nombre.trim();

function ingredientesEscritos() {
  return [...new Set($('var-ingredientes').value.split(',').map((t) => t.trim()).filter(Boolean))];
}

/** Lista de extras que se crearían con lo que hay en pantalla (con su estado: nuevo o ya existe). */
function variantesPorCrear() {
  const lista = [];
  for (const ing of ingredientesEscritos()) {
    for (const v of variantesEstado) {
      if (!v.activo || !v.texto.trim()) continue;
      const patron = v.texto.includes('{x}') ? v.texto : `${v.texto} {x}`;   // sin {x}, el ingrediente va al final
      const nombre = mayusInicial(patron.replaceAll('{x}', ing.toLocaleLowerCase('es-MX')).trim());
      const seccion = v.seccion.trim() ? seccionExistente(v.seccion) : '';
      const existe = extras.some((x) => x.nombre.toLowerCase() === nombre.toLowerCase() && (x.grupo || '').toLowerCase() === seccion.toLowerCase());
      lista.push({ nombre, seccion, precio: v.precio.trim() || '0', existe });
    }
  }
  return lista;
}

function pintarVariantesTipos() {
  // Estado inicial: las variantes base + las propias que el negocio guardó (estas últimas marcadas como propias)
  if (!variantesEstado) variantesEstado = [...VARIANTES_BASE.map((v) => ({ ...v, precio: v.precio || '' })), ...variantesPropias.map((v) => ({ texto: v.texto, seccion: v.seccion, precio: v.precio || '', activo: false, propia: true }))];
  const caja = $('var-tipos');
  caja.replaceChildren();
  variantesEstado.forEach((v) => {
    const fila = el('div', 'var-tipo' + (v.activo ? '' : ' apagado'));
    const marca = document.createElement('input'); marca.type = 'checkbox'; marca.checked = v.activo; marca.setAttribute('aria-label', 'Crear esta variante');
    const texto = document.createElement('input'); texto.type = 'text'; texto.maxLength = 50; texto.value = v.texto; texto.setAttribute('aria-label', 'Texto de la variante ({x} es el ingrediente)');
    const seccion = document.createElement('input'); seccion.type = 'text'; seccion.maxLength = 40; seccion.value = v.seccion; seccion.setAttribute('list', 'lista-grupos'); seccion.setAttribute('aria-label', 'Sección'); seccion.placeholder = 'Sección';
    const precio = document.createElement('input'); precio.type = 'text'; precio.inputMode = 'decimal'; precio.value = v.precio; precio.placeholder = 'Gratis'; precio.setAttribute('aria-label', 'Costo (vacío = gratis)');
    const cambio = () => { v.activo = marca.checked; v.texto = texto.value; v.seccion = seccion.value; v.precio = precio.value; fila.classList.toggle('apagado', !v.activo); pintarVistaVariantes(); };
    for (const c of [marca, texto, seccion, precio]) c.addEventListener('input', cambio);
    fila.append(marca, texto, seccion, precio);
    if (v.propia) {
      // Las variantes propias se pueden quitar de la lista guardada del negocio
      const quitar = el('button', 'btn chico peligro', '✕');
      quitar.type = 'button'; quitar.title = 'Quitar esta variante de mi lista'; quitar.setAttribute('aria-label', 'Quitar variante propia');
      quitar.addEventListener('click', async () => {
        if (!(await confirmar(`¿Quitar la variante propia “${v.texto || 'sin texto'}” de tu lista? Los extras que ya creaste con ella no se borran.`, { si: 'Quitar variante', peligro: true }))) return;
        variantesEstado = variantesEstado.filter((o) => o !== v);
        await guardarVariantesPropias();
        pintarVariantesTipos();
      });
      fila.append(quitar);
      fila.classList.add('propia');
    }
    caja.append(fila);
  });
  const cats = $('var-cats');
  cats.replaceChildren();
  for (const c of categorias) {
    const chip = el('button', 'ex-cat ' + (varCategorias.has(c.id) ? 'todos' : 'ninguno'), (varCategorias.has(c.id) ? '✓ ' : '') + c.nombre);
    chip.type = 'button';
    chip.addEventListener('click', () => { if (varCategorias.has(c.id)) varCategorias.delete(c.id); else varCategorias.add(c.id); pintarVariantesTipos(); });
    cats.append(chip);
  }
  pintarVistaVariantes();
}

function pintarVistaVariantes() {
  const lista = variantesPorCrear();
  const nuevos = lista.filter((x) => !x.existe);
  const vista = $('var-vista');
  vista.replaceChildren();
  if (lista.length === 0) { vista.textContent = 'Escribe un ingrediente para ver qué se va a crear.'; $('var-crear').disabled = true; return; }
  vista.append(el('strong', '', nuevos.length ? `Se crearán ${nuevos.length} extra${nuevos.length === 1 ? '' : 's'}:` : 'No hay nada nuevo que crear.'));
  const ul = el('div', 'var-lista');
  for (const x of lista) ul.append(el('span', 'chip' + (x.existe ? ' sin' : ''), `${x.nombre}${x.seccion ? ' · ' + x.seccion : ''}${Number(x.precio.replace(',', '.')) > 0 ? ' · +$' + x.precio : ''}${x.existe ? ' (ya existe)' : ''}`));
  vista.append(ul);
  $('var-crear').disabled = nuevos.length === 0;
}

$('var-ingredientes').addEventListener('input', pintarVistaVariantes);
$('ex-var-abrir').addEventListener('click', () => {
  const abrir = $('form-variantes').hidden;
  cerrarPanelesExtras();
  $('form-variantes').hidden = !abrir;
  if (abrir) { pintarVariantesTipos(); $('var-ingredientes').focus(); }
});
$('var-cancelar').addEventListener('click', () => { $('form-variantes').hidden = true; });
$('form-variantes').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nuevos = variantesPorCrear().filter((x) => !x.existe);
  if (nuevos.length === 0) return;
  $('x-error').textContent = '';
  await guardarVariantesPropias();   // lo que el dueño escribió como variante propia queda guardado para la próxima
  try {
    const r = await enviarJson(API + 'admin/extras.php', { accion: 'crear_varios', extras: nuevos.map((x) => ({ nombre: x.nombre, precio: x.precio, grupo: x.seccion })), categorias: [...varCategorias] });
    await cargarCatalogo();
    $('var-ingredientes').value = '';
    variantesEstado = null;   // se reconstruye con la lista propia ya guardada
    pintarExtras();
    avisar(`${r.creados.length} extra${r.creados.length === 1 ? '' : 's'} creado${r.creados.length === 1 ? '' : 's'}` + (varCategorias.size ? ' y agregados a las categorías elegidas' : ''));
  } catch (err) {
    $('x-error').textContent = err.message;
  }
});


/** Guarda en el servidor la lista de variantes propias (para reusarlas con cualquier ingrediente). */
async function guardarVariantesPropias() {
  const lista = variantesEstado.filter((v) => v.propia && v.texto.trim()).map((v) => ({ texto: v.texto.trim(), seccion: v.seccion.trim(), precio: v.precio.trim() }));
  try {
    await enviarJson(API + 'admin/extras.php', { accion: 'variantes_guardar', lista });
    variantesPropias = lista.map((v) => ({ ...v, texto: v.texto.includes('{x}') ? v.texto : v.texto + ' {x}' }));
  } catch (err) {
    $('x-error').textContent = err.message;
  }
}

$('var-propia').addEventListener('click', () => {
  // Fila nueva y vacía, ya marcada para crear; se guarda en la lista del negocio al crear los extras
  variantesEstado.push({ texto: '', seccion: '', precio: '', activo: true, propia: true });
  pintarVariantesTipos();
  const textos = $('var-tipos').querySelectorAll('.var-tipo.propia input[type="text"]:first-of-type');
  textos[textos.length - 1]?.focus();
});

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
$('ex-nuevo-abrir').addEventListener('click', () => { $('form-nuevo-extra').hidden = false; $('ex-nuevo-abrir').hidden = true; $('x-nombre').focus(); });
$('ex-nuevo-cancelar').addEventListener('click', () => { $('form-nuevo-extra').hidden = true; $('ex-nuevo-abrir').hidden = false; });
$('form-nuevo-extra').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await accionExtra({
    accion: 'crear', nombre: $('x-nombre').value.trim(), codigo: $('x-codigo').value.trim(),
    grupo: $('x-grupo').value.trim(), precio: costoNuevo.valor(),
  }, 'Extra creado');
  if (!$('x-error').textContent) {
    $('x-nombre').value = ''; $('x-codigo').value = '';
    costoNuevo.reiniciar();        // el grupo se conserva: se suelen agregar varios seguidos; el formulario sigue abierto para el siguiente
    $('x-nombre').focus();
  }
});

iniciar();
