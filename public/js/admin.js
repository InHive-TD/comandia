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
  if (typeof iniciarRecetas === 'function') iniciarRecetas();
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

/** Opción obligatoria: el interruptor muestra la lista de tipos (Carne, Quitar…) de la que hay que elegir; vacío = cualquier opción. */
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
let fGruposOrden = null;   // orden propio de los tipos en el platillo que se edita (null = el estándar de la pestaña Modificadores)

/** Lo marcado y los precios propios que hay ahora en el formulario (para volver a pintar sin perderlos). */
function leerExtrasForm() {
  const marcados = [...$('f-extras').querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
  const precios = {};
  for (const i of $('f-extras').querySelectorAll('input.precio-extra-prod')) if (!i.hidden && i.value.trim() !== '') precios[i.dataset.extra] = i.value.trim();
  return { marcados, precios };
}

/** Tipos de modificador que muestra el formulario, en el orden que se ve. */
const tiposEnFormulario = () => [...$('f-extras').querySelectorAll('.grupo-cab .grupo-titulo')].map((t) => t.textContent);

/** Ventanita para reordenar los tipos de modificador (de un platillo o de una categoría).
 *  leer(): tipos en el orden actual · aplicar(lista | null): guarda el nuevo orden (null = volver al de más arriba). */
function dialogoOrdenTipos({ titulo, tip, textoEstandar, leer, aplicar, quitar = null, vacio = '' }) {
  const d = document.createElement('dialog');
  d.className = 'dlg-confirmar';
  const cab = el('p', 'confirmar-texto', titulo + ' ');
  const info = el('span', 'tip', 'i'); info.dataset.tip = tip; info.tabIndex = 0;
  cab.append(info);
  const lista = el('div', 'ord-tipos');
  const pintar = () => {
    lista.replaceChildren();
    const orden = leer();
    if (!orden.length && vacio) lista.append(el('p', 'ayuda', vacio));
    orden.forEach((g, i) => {
      const fila = el('div', 'ord-tipo');
      const mover = async (dir) => {
        const nuevo = [...orden]; const j = i + dir;
        [nuevo[i], nuevo[j]] = [nuevo[j], nuevo[i]];
        await aplicar(nuevo);
        pintar();
      };
      const sube = el('button', 'btn chico', '↑'); sube.type = 'button'; sube.disabled = i === 0; sube.addEventListener('click', () => mover(-1));
      const baja = el('button', 'btn chico', '↓'); baja.type = 'button'; baja.disabled = i === orden.length - 1; baja.addEventListener('click', () => mover(1));
      fila.append(el('span', 'ord-nombre', g), sube, baja);
      if (quitar) {   // quitar este tipo de todos los platillos (con confirmación)
        const q = el('button', 'btn chico peligro', 'Quitar'); q.type = 'button'; q.title = 'Quitar este tipo de todos los platillos de la categoría';
        q.addEventListener('click', async () => { if (await quitar(g)) pintar(); });
        fila.append(q);
      }
      lista.append(fila);
    });
  };
  const botones = el('div', 'confirmar-botones');
  const estandar = el('button', 'btn', textoEstandar); estandar.type = 'button';
  estandar.addEventListener('click', async () => { await aplicar(null); pintar(); });
  const listo = el('button', 'btn principal', 'Listo'); listo.type = 'button';
  listo.addEventListener('click', () => d.close());
  botones.append(estandar, listo);
  d.append(cab, lista, botones);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  pintar();
  d.showModal();
}

/** Orden propio de la categoría elegida en el formulario (vacío = el estándar). */
const ordenDeCategoria = (id) => ((categorias.find((c) => String(c.id) === String(id)) || {}).grupos_orden || []);

/** Reordenar los tipos de modificador solo en este platillo (se guarda al guardar el platillo). */
function abrirOrdenTipos() {
  dialogoOrdenTipos({
    titulo: 'Orden de los tipos de modificador en este platillo',
    tip: 'Por defecto este platillo usa el orden de su categoría y, si la categoría no tiene, el de la pestaña Modificadores. Aquí lo cambias solo para este platillo; «Usar el de la categoría» vuelve al de siempre.',
    textoEstandar: 'Usar el de la categoría',
    leer: tiposEnFormulario,
    aplicar: (nuevo) => { const { marcados, precios } = leerExtrasForm(); fGruposOrden = nuevo; pintarExtrasProducto(marcados, precios); acActualizar(); },
  });
}
$('f-ordenar-tipos').addEventListener('click', abrirOrdenTipos);
$('f-categoria').addEventListener('change', () => { const { marcados, precios } = leerExtrasForm(); pintarExtrasProducto(marcados, precios); });

/** Ventana «Agregar modificadores»: todos los modificadores por tipo; se marca un tipo completo o solo algunos. */
function dialogoAgregarMods() {
  const { marcados, precios } = leerExtrasForm();
  const sel = new Set(marcados);
  const visibles = extras.filter((x) => x.activo || sel.has(x.id));
  const porTipo = new Map(gruposExtras.map((g) => [g, []]));
  for (const x of visibles) { const g = x.grupo && porTipo.has(x.grupo) ? x.grupo : 'Otros'; if (!porTipo.has(g)) porTipo.set(g, []); porTipo.get(g).push(x); }
  const d = document.createElement('dialog');
  d.className = 'dlg-confirmar dlg-agregar-mods';
  d.append(el('h3', '', 'Agregar modificadores al platillo'));
  const cuerpo = el('div', 'agm-lista');
  const refrescar = [];
  for (const [g, lista] of porTipo) {
    if (!lista.length) continue;
    const caja = el('div', 'agm-tipo');
    const cab = el('label', 'agm-cab');
    const tc = document.createElement('input'); tc.type = 'checkbox';
    const items = [];
    const filas = el('div', 'agm-filas');
    filas.hidden = true;   // por defecto cada tipo aparece colapsado
    const cuenta = el('small', 'agm-cuenta', '');
    const flecha = el('button', 'agm-flecha', '▸'); flecha.type = 'button'; flecha.setAttribute('aria-expanded', 'false'); flecha.title = 'Mostrar u ocultar';
    const alternar = () => { filas.hidden = !filas.hidden; flecha.textContent = filas.hidden ? '▸' : '▾'; flecha.setAttribute('aria-expanded', String(!filas.hidden)); };
    flecha.addEventListener('click', alternar);
    const nombreTipo = el('strong', '', g); nombreTipo.addEventListener('click', (ev) => { ev.preventDefault(); alternar(); });
    cab.append(tc, nombreTipo, cuenta, flecha);
    for (const x of lista) {
      const f = el('label', 'agm-fila');
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = sel.has(x.id);
      f.append(c, el('span', '', (x.codigo ? `${x.codigo} · ` : '') + x.nombre + (x.precio > 0 ? ` (+${dinero.format(x.precio)})` : '')));
      c.addEventListener('change', () => { if (c.checked) sel.add(x.id); else sel.delete(x.id); estado(); });
      items.push([x, c]); filas.append(f);
    }
    const estado = () => { const n = items.filter(([, c]) => c.checked).length; tc.checked = n === items.length; tc.indeterminate = n > 0 && n < items.length; cuenta.textContent = `${n}/${items.length}`; };
    tc.addEventListener('change', () => { for (const [x, c] of items) { c.checked = tc.checked; if (tc.checked) sel.add(x.id); else sel.delete(x.id); } estado(); });
    estado();
    caja.append(cab, filas); cuerpo.append(caja);
  }
  const fila = el('div', 'confirmar-botones');
  const cancelar = el('button', 'btn', 'Cancelar'); cancelar.type = 'button';
  const ok = el('button', 'btn principal', 'Agregar'); ok.type = 'button';
  cancelar.addEventListener('click', () => d.close());
  ok.addEventListener('click', () => {
    const conservar = Object.fromEntries(Object.entries(precios).filter(([id]) => sel.has(Number(id))));
    pintarExtrasProducto([...sel], conservar); acActualizar(); d.close();
  });
  fila.append(cancelar, ok);
  d.append(cuerpo, fila);
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal();
}
$('f-agregar-mods').addEventListener('click', dialogoAgregarMods);

function pintarExtrasProducto(marcados, precios = {}) {
  const caja = $('f-extras');
  caja.replaceChildren();
  const visibles = extras.filter((x) => x.activo || marcados.includes(x.id));
  $('f-agregar-mods').hidden = visibles.length === 0;
  if (visibles.length === 0) {
    $('f-ordenar-tipos').hidden = true;
    caja.append(el('p', 'vacio ayuda', 'Aún no hay modificadores. Créalos con el botón “Modificadores”.'));
    return;
  }
  let grupos = new Map(gruposExtras.map((g) => [g, []]));   // secciones en el orden que eligió el dueño
  for (const x of visibles) {
    const g = x.grupo && grupos.has(x.grupo) ? x.grupo : 'Otros';
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  const propio = fGruposOrden && fGruposOrden.length ? fGruposOrden : ordenDeCategoria($('f-categoria').value);   // el del platillo; si no tiene, el de su categoría
  if (propio.length) {   // los tipos que no estén en esa lista van después, en el orden estándar
    const resto = [...grupos.keys()].filter((g) => !propio.includes(g));
    grupos = new Map([...propio, ...resto].filter((g) => grupos.has(g)).map((g) => [g, grupos.get(g)]));
  }
  // Solo se muestran los tipos que tienen al menos un modificador activo en este platillo (los demás se agregan con «＋ Agregar modificadores»)
  const mostrados = [...grupos].filter(([, l]) => l.some((x) => marcados.includes(x.id)));
  $('f-ordenar-tipos').hidden = mostrados.length < 2;
  if (mostrados.length === 0) caja.append(el('p', 'vacio ayuda', 'Este platillo no tiene modificadores. Agrégalos con «＋ Agregar modificadores».'));
  for (const [g, lista] of mostrados) {
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
/* Guardar de cada página de ajustes: un solo botón en la barra superior (a la derecha). Cada página se registra aquí:
   { sucio(): hay cambios sin guardar, guardar(): guarda y devuelve true si todo salió bien, bloqueado?(): impide guardar,
     extra?: { texto, fn } botón secundario (ej. Restablecer) }. Estructura para todas las páginas de ajustes nuevas. */
const PAG = {};
const regAbierto = () => { const d = paginasPortal.find((o) => o.open && PAG[o.id]); return d ? PAG[d.id] : null; };
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
const RUTAS = { inicio: 'btn-reportes', platillos: 'btn-productos', categorias: 'btn-categorias', extras: 'btn-extras', 'carga-masiva': 'btn-carga', inventario: 'btn-inv-existencias', insumos: 'btn-inv-insumos', recetas: 'btn-inv-recetas', proveedores: 'btn-inv-proveedores', mermas: 'btn-inv-mermas', sucursales: 'btn-sucursales', usuarios: 'btn-usuarios', 'ajustes-cocina': 'btn-prioridades', 'ajustes-pedidos': 'btn-pedidos-qr', 'ajustes-pago': 'btn-pago', 'ajustes-caja': 'btn-caja-cfg', 'ajustes-plano': 'btn-plano', 'ajustes-toma': 'btn-toma-pedidos', 'ajustes-carriles': 'btn-carriles', apariencia: 'btn-apariencia' };
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
  acActualizar();
}

// Al cerrarse una página, si ya no queda ninguna abierta se regresa a Productos
for (const d of paginasPortal) d.addEventListener('close', () => {
  acActualizar();
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

  fGruposOrden = p && p.grupos_orden && p.grupos_orden.length ? [...p.grupos_orden] : null;
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
  { const ex = leerExtrasForm(); pintarExtrasProducto(ex.marcados, ex.precios); }   // ya con la categoría elegida: usa su orden de tipos

  $('f-quitar-fila').hidden = !(p && p.foto);
  $('f-eliminar').hidden = !p;
  $('f-eliminar').dataset.nombre = p ? p.nombre : '';
  prBase = productoSnap();
  abrirPagina(dlgProducto, 'btn-productos');
  mostrarBarraProducto();
}

$('btn-nuevo').addEventListener('click', () => abrirFormulario());
$('f-cancelar').addEventListener('click', () => dlgProducto.close());
dlgProducto.addEventListener('close', limpiarVistaPrevia);
// Cambios sin guardar del platillo: foto de la ficha tal como se abrió contra como está ahora
let prBase = null;
const productoSnap = () => JSON.stringify([
  ['f-nombre', 'f-codigo', 'f-porcion', 'f-categoria', 'f-precio', 'f-descripcion', 'f-grupo-oblig'].map((i) => $(i).value),
  ['f-disponible', 'f-pedir', 'f-obligatoria', 'f-quitar'].map((i) => $(i).checked),
  [...$('f-extras').querySelectorAll('input[type=checkbox]')].map((c) => c.checked),
  [...$('f-extras').querySelectorAll('input.precio-extra-prod')].map((c) => c.value),
  fGruposOrden || [], $('f-foto').files.length,
]);
PAG['dlg-producto'] = {
  sucio: () => prBase !== null && dlgProducto.open && productoSnap() !== prBase,
  guardar: async () => {
    $('f-guardar').click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 150)); if (!dlgProducto.open) return true; if (!$('f-guardar').disabled && i > 2) break; }
    return !dlgProducto.open;
  },
};
$('form-producto').addEventListener('input', () => acActualizar());
$('form-producto').addEventListener('change', () => acActualizar());
$('f-disponible').addEventListener('change', () => acActualizar());
// Guardar / Eliminar / ✕ del platillo viven en la barra superior, a la derecha
const mostrarBarraProducto = () => { $('barra-producto').hidden = !dlgProducto.open; if (!dlgProducto.open) prBase = null; $('bp-eliminar').hidden = $('f-eliminar').hidden; };
$('bp-guardar').addEventListener('click', () => $('f-guardar').click());
$('bp-eliminar').addEventListener('click', () => $('f-eliminar').click());
$('bp-cerrar').addEventListener('click', () => dlgProducto.close());
dlgProducto.addEventListener('close', mostrarBarraProducto);
new MutationObserver(() => { $('bp-guardar').disabled = $('f-guardar').disabled; $('bp-guardar').textContent = $('f-guardar').textContent; }).observe($('f-guardar'), { attributes: true, childList: true, characterData: true, subtree: true });

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
    datos.append('grupos_orden', JSON.stringify(fGruposOrden || []));
    if ($('f-quitar').checked) datos.append('quitar_foto', '1');

    const archivo = $('f-foto').files[0];
    if (archivo) {
      datos.append('foto', await reducirImagen(archivo), 'foto.jpg');
    }

    const resp = await pedir(API + 'admin/productos.php', { method: 'POST', body: datos });
    categoriasAbiertas.add($('f-categoria').value); guardarAbiertas();   // al volver a la lista, esa categoría se ve abierta con el platillo
    await cargarCatalogo();
    // Se queda dentro del platillo: se vuelve a cargar tal como quedó guardado (y un platillo nuevo pasa a ser «Editar»)
    const guardado = productos.find((x) => String(x.id) === String(id || (resp && resp.id)));
    if (guardado) { const y = window.scrollY; abrirFormulario(guardado); window.scrollTo({ top: y }); }
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

    const tipos = el('button', 'btn', '↕ Modificadores');
    tipos.type = 'button';
    tipos.title = 'Ordenar o quitar los tipos de modificador de los platillos de esta categoría';
    tipos.addEventListener('click', () => dialogoOrdenTipos({
      titulo: `Orden de los tipos de modificador · ${c.nombre}`,
      tip: 'Solo aparecen los tipos que usan los platillos de esta categoría. El orden vale para los platillos que no tengan uno propio (se cambia al editar el platillo); «Orden estándar» usa el de la pestaña Modificadores. «Quitar» lo saca de todos los platillos de la categoría.',
      textoEstandar: 'Orden estándar',
      vacio: 'Los platillos de esta categoría todavía no tienen modificadores. Se agregan al editar cada platillo.',
      // Solo los tipos que de verdad tienen los platillos de esta categoría, en su orden
      leer: () => {
        const cat = categorias.find((x) => x.id === c.id) || c;
        const todos = [...new Set([...gruposExtras, 'Otros'])].filter((g) => (cat.grupos_presentes || []).includes(g));
        const propio = (cat.grupos_orden || []).filter((g) => todos.includes(g));
        return [...propio, ...todos.filter((g) => !propio.includes(g))];
      },
      quitar: async (g) => {
        if (!(await confirmar(`¿Seguro que quieres quitar «${g}»? Esto lo quitará de todos los platillos de la categoría «${c.nombre}» (también sus precios propios y los marcados «por defecto»). Los modificadores no se borran: podrás volver a agregarlos al editar cada platillo.`, { si: 'Quitar', peligro: true }))) return false;
        try {
          const r = await enviarJson(API + 'admin/categorias.php', { accion: 'quitar_tipo', id: c.id, grupo: g });
          await cargarCatalogo(); pintarCategorias();
          avisar(`«${g}» se quitó de ${r.platillos} platillo${r.platillos === 1 ? '' : 's'}`);
          return true;
        } catch (err) { avisar(err.message, true); return false; }
      },
      aplicar: async (nuevo) => {
        try { await enviarJson(API + 'admin/categorias.php', { accion: 'grupos_orden', id: c.id, grupos: nuevo || [] }); await cargarCatalogo(); avisar(nuevo ? 'Orden guardado para esta categoría' : 'Esta categoría usa el orden estándar'); }
        catch (err) { avisar(err.message, true); }
      },
    }));
    fila.append(mover, nombre, guardar, tipos, borrar, el('span', 'cuenta', c.productos === 1 ? '1 platillo' : `${c.productos} platillos`));
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
$('c-volver').addEventListener('click', () => $('btn-productos').click());

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
  const editar = el('button', 'btn chico', '✎ Editar');
  editar.type = 'button';
  editar.addEventListener('click', () => abrirEditarUsuario(u));
  fila.append(quien, chips, ...(desbloquear ? [desbloquear] : []), editar);
  return fila;
}

/** Ventana (modal) para editar a una persona: datos, sucursales, contraseña y el interruptor "Activo". */
function abrirEditarUsuario(u) {
  const { r, ROLES_PERSONAL, hayVarias } = usuariosCtx;
  const dlg = $('dlg-usuario-editar');
  $('ue-error').textContent = '';
  $('ue-titulo').textContent = u.nombre;
  $('ue-usuario').textContent = '@' + u.usuario;
  $('ue-correo').textContent = u.correo ? `Correo: ${u.correo}${u.pendiente ? ' · aún no crea su contraseña' : ''}` : 'Sin correo registrado: entra con usuario y contraseña.';
  $('ue-reenviar').textContent = u.correo ? (u.pendiente ? '✉ Reenviar invitación' : '✉ Restablecer contraseña por correo') : '✉ Agregar correo e invitar';
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
  $('ue-reenviar').onclick = async () => {
    $('ue-error').textContent = '';
    try {
      if (!u.correo) {
        const c = await pedirTexto(`Correo de ${u.nombre}:`, { si: 'Enviar invitación' });
        if (!c) return;
        await enviarJson(API + 'admin/usuarios.php', { accion: 'correo', id: u.id, correo: c.trim() });
        avisar('Invitación enviada');
      } else {
        const aviso = u.pendiente ? `¿Reenviar la invitación a ${u.correo}?` : `¿Restablecer la contraseña de ${u.nombre}? Su contraseña actual dejará de servir y se le enviará un enlace a ${u.correo}.`;
        if (!(await confirmar(aviso, { si: u.pendiente ? 'Reenviar' : 'Restablecer', peligro: !u.pendiente }))) return;
        await enviarJson(API + 'admin/usuarios.php', { accion: 'reenviar', id: u.id });
        avisar('Enlace enviado a ' + u.correo);
      }
      $('dlg-usuario-editar').close();
      await cargarUsuarios();
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
  const correo = $('us-correo').value.trim();
  const comun = { nombre: $('us-nombre').value.trim(), rol: $('us-rol').value, sucursal_id: Number($('us-sucursal').value), ...(extraNuevo ? { sucursales_extra: extraNuevo.valor() } : {}) };
  const boton = $('us-enviar'); boton.disabled = true;
  const ok = correo
    ? await accionUsuario({ accion: 'invitar', correo, ...comun }, 'Invitación enviada a ' + correo)
    : await accionUsuario({ accion: 'crear', usuario: $('us-usuario').value.trim(), password: $('us-password').value, ...comun }, 'Usuario creado');
  boton.disabled = false;
  if (ok) { for (const id of ['us-nombre', 'us-correo', 'us-usuario', 'us-password']) $(id).value = ''; sincronizarCorreoUsuario(); }
});
function sincronizarCorreoUsuario() {
  const conCorreo = $('us-correo').value.trim() !== '';
  $('us-fila-usuario').hidden = conCorreo; $('us-fila-password').hidden = conCorreo;
  $('us-usuario').required = !conCorreo; $('us-password').required = !conCorreo;
  $('us-enviar').textContent = conCorreo ? '✉ Enviar invitación' : 'Crear usuario';
}
$('us-correo').addEventListener('input', sincronizarCorreoUsuario);
sincronizarCorreoUsuario();

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
    chip.title = m.zona ? 'Zona: ' + m.zona : 'Sin ubicar en el plano';
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
    resumen.append(el('span', 'cat-nombre', s.nombre), el('span', 'chip', `${s.mesas} mesas`), el('span', 'chip', `${s.usuarios} personas`), el('span', 'chip', s.carta_propia ? 'Carta propia' : 'Carta general'), el('span', 'chip ' + (s.activa ? 'activo' : 'sin'), s.activa ? '● Activa' : 'Desactivada'));
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
  const carta = (document.querySelector('input[name="su-carta"]:checked') || {}).value || 'general';
  const ok = await accionSucursal('admin/sucursales.php', { accion: 'crear', nombre: $('su-nombre').value.trim(), direccion: $('su-direccion').value.trim(), carta }, 'Sucursal creada');
  if (ok) { $('su-nombre').value = ''; $('su-direccion').value = ''; document.querySelector('input[name="su-carta"][value="general"]').checked = true; }
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
  else if (r === '30') { a.setDate(a.getDate() - 29); }
  else if (r === 'mes') { a = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }
  else if (r === 'mesant') { a = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1); b = new Date(hoy.getFullYear(), hoy.getMonth(), 0); }
  $('rp-desde').value = isoLocal(a);
  $('rp-hasta').value = isoLocal(b);
}

let tablero = null;
let rangoBase = null;          // rango elegido antes de entrar a un solo día
let cargaRep = 0;
async function cargarReporte(dia) {
  if (!tablero) tablero = Tablero.montar($('rp-contenido'), { alCargar: (d) => {
    if (d) { rangoBase = { desde: $('rp-desde').value, hasta: $('rp-hasta').value }; $('rp-desde').value = d; $('rp-hasta').value = d; }
    else if (rangoBase) { $('rp-desde').value = rangoBase.desde; $('rp-hasta').value = rangoBase.hasta; rangoBase = null; }
    cargarReporte(d || null);
  } });
  $('rp-error').textContent = '';
  tablero.cargando();
  const mia = ++cargaRep;
  const q = new URLSearchParams({ desde: $('rp-desde').value, hasta: $('rp-hasta').value });
  if ($('rp-sucursal').value) q.set('sucursal', $('rp-sucursal').value);
  let r;
  try { r = await pedir(API + 'admin/reportes.php?' + q); } catch (err) { if (mia === cargaRep) $('rp-error').textContent = err.message; return; }
  if (mia !== cargaRep) return;
  const sel = $('rp-sucursal');
  if (sel.options.length !== r.sucursales.length + 1) {
    const actual = sel.value;
    sel.replaceChildren();
    const todas = document.createElement('option'); todas.value = ''; todas.textContent = 'Todas (en conjunto)'; sel.append(todas);
    for (const s of r.sucursales) { const o = document.createElement('option'); o.value = String(s.id); o.textContent = s.nombre; sel.append(o); }
    sel.value = actual;
  }
  tablero.marcarDia(dia && typeof dia === 'string' ? dia : null);
  tablero.poner(r);
}

$('btn-reportes').addEventListener('click', () => {
  if (!$('rp-desde').value) fijarRango('7');
  abrirPagina(dlgReportes, 'btn-reportes');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  cargarReporte();
});
$('rp-cerrar').addEventListener('click', () => dlgReportes.close());
document.querySelectorAll('.rep-rapidos [data-rango]').forEach((b) => b.addEventListener('click', () => { rangoBase = null; fijarRango(b.dataset.rango); cargarReporte(); }));
['rp-desde', 'rp-hasta', 'rp-sucursal'].forEach((id) => $(id).addEventListener('change', () => { rangoBase = null; cargarReporte(); }));
$('rp-actualizar').addEventListener('click', () => cargarReporte(rangoBase ? $('rp-desde').value : null));

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
  acActualizar();
}
const apMalo = () => !!apColores.texto && apContraste(apColores.texto, apColores.fondo) < 4.5;

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
  acActualizar();
}

$('btn-apariencia').addEventListener('click', async () => {
  $('ap-error').textContent = '';
  try { await apCargar(); } catch (err) { $('ap-error').textContent = err.message; }
  abrirPagina(dlgApariencia, 'btn-apariencia');
});
dlgApariencia.addEventListener('close', apQuitarVistaPrevia);
$('ap-cerrar').addEventListener('click', () => dlgApariencia.close());
/** Guarda los colores (se ven al instante como vista previa). Devuelve true si salió bien; se queda en la misma página. */
async function guardarApariencia() {
  $('ap-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/marca.php', { accion: 'colores', colores: apColores });
    apDatos.colores = { ...apColores };
    apRecargarTema();
    avisar(r.avisos && r.avisos.length ? r.avisos[0] : 'Apariencia guardada', !!(r.avisos && r.avisos.length));
    acActualizar();
    return true;
  } catch (err) { $('ap-error').textContent = err.message; return false; }
}
async function restablecerApariencia() {
  if (!(await confirmar('¿Volver a los colores originales de Comandia?', { si: 'Restablecer', no: 'Volver' }))) return;
  try { await enviarJson(API + 'admin/marca.php', { accion: 'restablecer' }); apRecargarTema(); await apCargar(); avisar('Colores restablecidos'); }
  catch (err) { $('ap-error').textContent = err.message; }
}
PAG['dlg-apariencia'] = { sucio: () => !!apDatos && JSON.stringify(apColores) !== JSON.stringify(apDatos.colores), bloqueado: apMalo, guardar: guardarApariencia, extra: { texto: 'Restablecer', fn: restablecerApariencia } };
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

/** Distribución de comandas en Cocina (apiladas / una fila con scroll lateral): interruptor general (dueño) y por sucursal. Se guarda con el botón Guardar. */
let chOrig = null;
let chEstado = new Map();
function pintarCocinaHorizontal(ch) {
  chOrig = { general: ch.general, puede_general: ch.puede_general, sucursales: ch.sucursales.map((s) => ({ id: s.id, activo: s.activo })) };
  chEstado = new Map(ch.sucursales.map((s) => [s.id, s.activo]));
  $('ch-general-fila').hidden = !ch.puede_general;
  $('ch-general').checked = ch.general;
  const lista = $('ch-lista');
  lista.replaceChildren();
  for (const s of ch.sucursales) {
    const x = el('input'); x.type = 'checkbox'; x.checked = s.activo;
    x.addEventListener('change', () => { chEstado.set(s.id, x.checked); acActualizar(); });
    const fila = el('label', 'lote-op'); fila.append(x, el('span', '', s.nombre));
    lista.append(fila);
  }
}
function chCambios() {
  if (!chOrig) return [];
  const c = [];
  if (chOrig.puede_general && $('ch-general').checked !== chOrig.general) c.push({ ambito: 'general', activo: $('ch-general').checked });
  for (const s of chOrig.sucursales) if (chEstado.get(s.id) !== s.activo) c.push({ ambito: 'sucursal', sucursal_id: s.id, activo: chEstado.get(s.id) });
  return c;
}
$('ch-general').addEventListener('change', acActualizar);

async function cargarAjustes() {
  datosPrio = await pedir(API + 'admin/prioridades.php');
  pintarCocinaHorizontal(datosPrio.cocina_horizontal);
  $('pm-prep').value = datosPrio.min_preparacion;
  pintarLote();
  acActualizar();
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
    marca.addEventListener('change', () => { if (marca.checked) loteCats.add(c.id); else loteCats.delete(c.id); refrescarLote(); acActualizar(); });
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
      x.addEventListener('change', () => { if (x.checked) loteProds.add(p.id); else loteProds.delete(p.id); refrescarLote(); acActualizar(); });
      f.append(x, el('span', '', p.nombre));
      cuerpo.append(f);
      casillas.push({ p, x });
    }
    det.append(cuerpo);
    lista.append(det);
    c._ui = { marca, cuenta, casillas };
  }
  refrescarLote();
  loteOrig = loteSnap();
}
const loteSnap = () => JSON.stringify({ c: [...loteCats].sort(), p: [...loteProds].sort() });
let loteOrig = '';

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
  acActualizar();
}

/* Ajustes de cliente: un solo botón «Guardar» en la barra superior para tipos de pedido y pestañas. */
let ctBase = null;       // foto de los tipos de pedido tal como se pintaron (para saber si hay cambios)
let ctAmbitoPrevio = null;
const ctSnap = () => JSON.stringify({ a: $('ct-ambito').value, m: [...document.querySelectorAll('#ct-mods input')].filter((x) => x.checked).map((x) => x.dataset.mod), x: $('ct-mixto').checked, s: $('ct-mesa').value });
const ctSucio = () => ctBase !== null && ctSnap() !== ctBase;
const acSucio = () => { const r = regAbierto(); return !!r && !!r.sucio(); };
function acActualizar() {
  const r = regAbierto();
  const barra = $('barra-accion');
  if (!barra) return;
  const prod = !!r && r === PAG['dlg-producto'];
  barra.hidden = !r || prod;
  const pend = $('bp-pendiente'); if (pend) pend.hidden = !(prod && r.sucio());
  if (!r || prod) return;
  const sucio = !!r.sucio();
  $('ac-guardar').disabled = !sucio || !!(r.bloqueado && r.bloqueado());
  $('ac-pendiente').hidden = !sucio;
  const ex = $('ac-extra');
  ex.hidden = !r.extra; if (r.extra) ex.textContent = r.extra.texto;
}
/** Pregunta qué hacer con los cambios pendientes: 'guardar', 'descartar' o null (seguir editando). */
function decidirCambios(mensaje) {
  return new Promise((resolver) => {
    const d = document.createElement('dialog');
    d.className = 'dlg-confirmar';
    const p = el('p', 'confirmar-texto', mensaje);
    const fila = el('div', 'confirmar-botones');
    let r = null;
    for (const [txt, val, clase] of [['Cancelar', null, 'btn'], ['Descartar', 'descartar', 'btn peligro'], ['Guardar', 'guardar', 'btn principal']]) {
      const b = el('button', clase, txt); b.type = 'button';
      b.addEventListener('click', () => { r = val; d.close(); });
      fila.append(b);
    }
    d.append(p, fila);
    d.addEventListener('close', () => { d.remove(); resolver(r); });
    document.body.append(d);
    d.showModal();
  });
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
    const vm = document.querySelector(`#cp-pestanas input[data-id="${s.id}"][data-campo="menu"]`);
    const vp = document.querySelector(`#cp-pestanas input[data-id="${s.id}"][data-campo="pedido"]`);
    const vg = document.querySelector(`#cp-pestanas input[data-id="${s.id}"][data-campo="pagar"]`);
    if (vm && vp && vg && (vm.checked !== s.ver_menu || vp.checked !== s.ver_pedido || vg.checked !== s.ver_pagar)) cambios.push({ accion: 'pestanas', sucursal_id: s.id, ver_menu: vm.checked, ver_pedido: vp.checked, ver_pagar: vg.checked });
  }
  return cambios;
}

async function cargarClientePedidos() {
  const r = await pedir(API + 'admin/cliente-pedidos.php');
  cpOriginal = { general: r.general, puede_general: r.puede_general, sucursales: r.sucursales.map((s) => ({ id: s.id, activo: s.activo, ver_pedido: s.ver_pedido, ver_pagar: s.ver_pagar, ver_menu: s.ver_menu !== false })) };
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
    for (const [campo, texto, valor] of [['menu', 'Mostrar «Menú»', s.ver_menu !== false], ['pedido', 'Mostrar «Mi pedido»', s.ver_pedido], ['pagar', 'Mostrar «Pagar»', s.ver_pagar]]) {
      const f = el('label', 'lote-op');
      const x = document.createElement('input');
      x.type = 'checkbox'; x.checked = valor; x.dataset.id = String(s.id); x.dataset.campo = campo;
      x.addEventListener('change', () => {
        const cajas = [...fila.querySelectorAll('input')];
        if (!cajas.some((c) => c.checked)) { x.checked = true; avisar('Deja al menos una pestaña visible.', true); }
        cpActualizarPendiente();
      });
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

/** Envía al servidor todos los cambios pendientes (tipos de pedido y pestañas) y vuelve a leer el estado real. Devuelve true si todo se guardó. */
async function guardarClientePedidos() {
  $('cp-error').textContent = ''; $('ct-error').textContent = '';
  $('ac-guardar').disabled = true;
  let ok = true;
  try {
    if (ctSucio()) await guardarTiposPedido();
    for (const cambio of cpCambios()) await enviarJson(API + 'admin/cliente-pedidos.php', cambio);
    avisar('Configuración guardada');
  } catch (err) { ok = false; $('cp-error').textContent = err.message; }
  try { await cargarClientePedidos(); await cargarCfgCliente(); } catch { /* se queda como estaba */ }
  return ok;
}
$('cp-general').addEventListener('change', cpActualizarPendiente);
$('ac-guardar').addEventListener('click', guardarClientePedidos);

/* Al salir de una página de ajustes con cambios sin guardar se pregunta: Guardar / Descartar / Cancelar. */
let acSaltar = false;
$('ac-guardar').addEventListener('click', async () => { const r = regAbierto(); if (r) { $('ac-guardar').disabled = true; await r.guardar(); acActualizar(); } });
$('ac-extra').addEventListener('click', () => { const r = regAbierto(); if (r && r.extra) r.extra.fn(); });
document.addEventListener('click', async (ev) => {
  if (acSaltar || !acSucio()) return;
  const b = ev.target.closest('.menu-lateral .nav-ico, .barra-movil button, dialog.pagina [id$="-cerrar"]:not(#pl-cerrar), #bp-cerrar, #ct-ir-pago');
  if (!b || b.id === 'ac-guardar' || b.id === 'ac-extra') return;
  if (b.classList.contains('activo')) return;   // el botón de la misma página
  ev.preventDefault(); ev.stopImmediatePropagation();
  const r = await decidirCambios('Tienes cambios sin guardar en esta página. ¿Qué quieres hacer?');
  if (r === null) return;
  if (r === 'guardar' && !(await regAbierto().guardar())) return;
  acSaltar = true; b.click(); acSaltar = false;
}, true);
window.addEventListener('beforeunload', (ev) => { if (acSucio()) { ev.preventDefault(); ev.returnValue = ''; } });
/** Selector «¿Para quién?»: si hay cambios, pregunta antes de repintar con otros valores. */
function protegerSelector(sel, sucio, guardar, repintar) {
  let previo = sel.value;
  const recordar = () => { previo = sel.value; };   // el valor que se veía justo antes de que el usuario lo cambiara
  sel.addEventListener('focus', recordar); sel.addEventListener('pointerdown', recordar);
  sel.addEventListener('change', async () => {
    const nuevo = sel.value;
    sel.value = previo;
    if (sucio()) {
      const r = await decidirCambios('Tienes cambios sin guardar para esta selección. ¿Qué quieres hacer?');
      if (r === null) return;
      if (r === 'guardar' && !(await guardar())) return;
    }
    sel.value = nuevo; previo = nuevo;
    repintar();
  });
}

const cocinaSucio = () => !!datosPrio && ((Number($('pm-prep').value) || 0) !== datosPrio.min_preparacion || chCambios().length > 0 || loteSnap() !== loteOrig);

/** Guarda todo lo pendiente de Ajustes de cocina (minutos de agenda, distribución y preparar en lote). Devuelve true si salió bien. */
async function guardarCocina() {
  $('pr-error').textContent = '';
  try {
    if ((Number($('pm-prep').value) || 0) !== datosPrio.min_preparacion) await enviarJson(API + 'admin/prioridades.php', { accion: 'modalidad', aqui: datosPrio.modalidad.aqui, llevar: datosPrio.modalidad.llevar, prep: Number($('pm-prep').value) || 0 });
    for (const c of chCambios()) await enviarJson(API + 'admin/prioridades.php', { accion: 'cocina_horizontal', ...c });
    if (loteSnap() !== loteOrig) {
      // Los platillos de una categoría completa ya van incluidos: solo se guardan los sueltos de las demás
      const completas = new Set(datosPrio.productos.filter((p) => loteCats.has(p.categoria_id)).map((p) => p.id));
      await enviarJson(API + 'admin/prioridades.php', { accion: 'lote', categorias: [...loteCats], productos: [...loteProds].filter((id) => !completas.has(id)) });
    }
    avisar('Ajustes de cocina guardados');
    await cargarAjustes();
    return true;
  } catch (err) { $('pr-error').textContent = err.message; return false; }
}
PAG['dlg-prioridades'] = { sucio: cocinaSucio, guardar: guardarCocina };

$('btn-prioridades').addEventListener('click', async () => {
  $('pr-error').textContent = '';
  try { await cargarAjustes(); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgAjustes, 'btn-prioridades');
});
$('pm-prep').addEventListener('input', acActualizar);
$('pr-cerrar').addEventListener('click', () => dlgAjustes.close());

/* Ajustes de tomar pedidos: interruptor del código rápido. Lo cambian el dueño (empresa o cualquier sucursal) y el gerente
   (solo su sucursal). Se guarda con el botón Guardar de la barra. */
const dlgTomaPedidos = $('dlg-toma-pedidos');

let tpOrig = null; let tpEstado = new Map(); let tpSucursales = [];
let tmOrig = null; let tmEstado = new Map();

/** Dibuja el interruptor general y una casilla por sucursal con el estado que manda el servidor. */
function pintarCodigoRapido(cr) {
  tpOrig = { general: cr.general, puede_general: cr.puede_general, sucursales: cr.sucursales.map((s) => ({ id: s.id, activo: s.activo })) };
  tpEstado = new Map(cr.sucursales.map((s) => [s.id, s.activo]));
  tpSucursales = cr.sucursales;
  $('tp-general-fila').hidden = !cr.puede_general;
  $('tp-general').checked = cr.general;
  $('tp-nota').hidden = cr.general || cr.puede_general;
  tpPintarLista();
}
function tpPintarLista() {
  const lista = $('tp-lista');
  lista.replaceChildren();
  for (const s of tpSucursales) {
    const x = el('input'); x.type = 'checkbox'; x.checked = $('tp-general').checked && tpEstado.get(s.id); x.disabled = !$('tp-general').checked;
    x.addEventListener('change', () => { tpEstado.set(s.id, x.checked); acActualizar(); });
    const fila = el('label', 'lote-op'); fila.append(x, el('span', '', s.nombre));
    lista.append(fila);
  }
}
function tpCambios() {
  if (!tpOrig) return [];
  const g = $('tp-general').checked; const c = [];
  if (tpOrig.puede_general && g !== tpOrig.general) c.push({ ambito: 'general', activo: g });
  if (g) for (const s of tpOrig.sucursales) if (tpEstado.get(s.id) !== s.activo) c.push({ ambito: 'sucursal', sucursal_id: s.id, activo: tpEstado.get(s.id) });
  return c;
}
function pintarPedirPorMesa(pm) {
  tmOrig = { general: pm.general, puede_general: pm.puede_general, sucursales: pm.sucursales.map((s) => ({ id: s.id, activo: s.activo })) };
  tmEstado = new Map(pm.sucursales.map((s) => [s.id, s.activo]));
  $('tm-general-fila').hidden = !pm.puede_general;
  $('tm-general').checked = pm.general;
  const lista = $('tm-lista');
  lista.replaceChildren();
  for (const s of pm.sucursales) {
    const x = el('input'); x.type = 'checkbox'; x.checked = s.activo;
    x.addEventListener('change', () => { tmEstado.set(s.id, x.checked); acActualizar(); });
    const fila = el('label', 'lote-op'); fila.append(x, el('span', '', s.nombre + ' · pedir por mesa'));
    lista.append(fila);
  }
}
function tmCambios() {
  if (!tmOrig) return [];
  const c = [];
  if (tmOrig.puede_general && $('tm-general').checked !== tmOrig.general) c.push({ ambito: 'general', activo: $('tm-general').checked });
  for (const s of tmOrig.sucursales) if (tmEstado.get(s.id) !== s.activo) c.push({ ambito: 'sucursal', sucursal_id: s.id, activo: tmEstado.get(s.id) });
  return c;
}
/** Guarda lo pendiente de Ajustes de pedidos (pedir por mesa y código rápido). Devuelve true si salió bien. */
async function guardarTomaPedidos() {
  $('tp-error').textContent = ''; $('tm-error').textContent = '';
  try {
    for (const c of tmCambios()) await enviarJson(API + 'admin/prioridades.php', { accion: 'pedir_por_mesa', ...c });
    for (const c of tpCambios()) await enviarJson(API + 'admin/prioridades.php', { accion: 'codigo_rapido', ...c });
    avisar('Ajustes de pedidos guardados');
    const ap = await pedir(API + 'admin/prioridades.php');
    pintarCodigoRapido(ap.codigo_rapido); pintarPedirPorMesa(ap.pedir_por_mesa); acActualizar();
    return true;
  } catch (err) {
    $('tp-error').textContent = err.message;
    try { const ap = await pedir(API + 'admin/prioridades.php'); pintarCodigoRapido(ap.codigo_rapido); pintarPedirPorMesa(ap.pedir_por_mesa); acActualizar(); } catch { /* se queda como estaba */ }
    return false;
  }
}
$('tm-general').addEventListener('change', acActualizar);
$('tp-general').addEventListener('change', () => { tpPintarLista(); acActualizar(); });
PAG['dlg-toma-pedidos'] = { sucio: () => tpCambios().length > 0 || tmCambios().length > 0, guardar: guardarTomaPedidos };

$('btn-toma-pedidos').addEventListener('click', async () => {
  $('tp-error').textContent = '';
  try { const ap = await pedir(API + 'admin/prioridades.php'); pintarCodigoRapido(ap.codigo_rapido); pintarPedirPorMesa(ap.pedir_por_mesa); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgTomaPedidos, 'btn-toma-pedidos');
});
$('tp-cerrar').addEventListener('click', () => dlgTomaPedidos.close());


/* ---- Carriles de cocina (solo el dueño): nombre, color y regla de cada carril, para toda la empresa o por sucursal ---- */
const dlgCarriles = $('dlg-carriles');
let crEstado = null;     // lo que manda el servidor (carriles de la empresa y de cada sucursal, estaciones y categorías)
let crLista = [];        // carriles que se están editando
const COLORES_CR = [['verde', '🟢 Verde'], ['naranja', '🟠 Naranja'], ['azul', '🔵 Azul'], ['morado', '🟣 Morado'], ['rojo', '🔴 Rojo'], ['gris', '⚪ Gris']];
const TIPOS_CR = [['aqui', '🍽 Comer aquí'], ['llevar', '🥡 Para llevar'], ['recoger', '🛍 Recoger']];
const copiaCarriles = (l) => l.map((c) => ({ ...c, tipos: [...c.tipos], estaciones: [...c.estaciones], categorias: [...c.categorias] }));

function crAmbito() { const v = $('cr-ambito').value; return v === 'general' ? { ambito: 'general' } : { ambito: 'sucursal', sucursal_id: Number(v) }; }

function crCargarAmbito() {
  const v = $('cr-ambito').value;
  const suc = crEstado.sucursales.find((s) => String(s.id) === v);
  $('cr-heredar-fila').hidden = v === 'general' && !crEstado.general_propio;
  if (v === 'general') {
    $('cr-heredar-fila').hidden = false;
    $('cr-heredar').checked = !crEstado.general_propio;
    $('cr-heredar').nextElementSibling.textContent = 'Usar los de siempre (Comer aquí / Para llevar)';
    crLista = copiaCarriles(crEstado.general);
  } else {
    $('cr-heredar-fila').hidden = false;
    $('cr-heredar').checked = !suc.propio;
    $('cr-heredar').nextElementSibling.textContent = 'Usar los carriles de toda la empresa';
    crLista = copiaCarriles(suc.carriles);
  }
  crPintar();
  crBase = crSnap();
  acActualizar();
}

function crPintar() {
  const editar = crEstado.puede_editar;
  const hereda = !editar || $('cr-heredar').checked;     // se edita cuando el ámbito no usa los carriles heredados
  const suc = crEstado.sucursales.find((s) => String(s.id) === $('cr-ambito').value);
  $('cr-heredado').hidden = !editar || !$('cr-heredar').checked || $('cr-ambito').value === 'general';
  $('cr-acciones').hidden = hereda;
  $('cr-heredar-fila').hidden = !editar;
  $('cr-ambito').closest('label').hidden = $('cr-ambito').options.length < 2;   // el gerente solo tiene su sucursal
  const caja = $('cr-lista');
  caja.replaceChildren();
  crLista.forEach((c, n) => {
    const t = el('article', 'cr-carril' + (hereda ? ' solo-lectura' : ''));
    const cab = el('div', 'cr-cab');
    const nombre = document.createElement('input');
    nombre.type = 'text'; nombre.maxLength = 40; nombre.value = c.nombre; nombre.placeholder = 'Ej. 🦐 Mariscos'; nombre.setAttribute('aria-label', 'Nombre del carril'); nombre.disabled = hereda;
    nombre.addEventListener('input', () => { c.nombre = nombre.value; });
    const color = document.createElement('select');
    color.setAttribute('aria-label', 'Color'); color.disabled = hereda;
    for (const [v, tx] of COLORES_CR) color.append(new Option(tx, v));
    color.value = c.color;
    color.addEventListener('change', () => { c.color = color.value; });
    cab.append(el('span', 'cr-num', String(n + 1)), nombre, color);
    if (suc) {   // en una sucursal: interruptor para mostrar u ocultar este carril solo ahí (se guarda al momento)
      const interr = el('label', 'cr-activo');
      const sw = document.createElement('input'); sw.type = 'checkbox'; sw.checked = !suc.apagados.includes(c.id);
      sw.addEventListener('change', async () => {
        $('cr-error').textContent = '';
        try {
          const r = await enviarJson(API + 'admin/prioridades.php', { accion: 'carril_activo', sucursal_id: suc.id, carril_id: c.id, activo: sw.checked });
          const nuevo = r.carriles.sucursales.find((x) => x.id === suc.id);
          if (nuevo) suc.apagados = nuevo.apagados;
          avisar(sw.checked ? 'Carril activado en esta sucursal' : 'Carril desactivado en esta sucursal');
        } catch (err) { sw.checked = !sw.checked; $('cr-error').textContent = err.message; }
      });
      interr.append(sw, el('span', '', 'Activo'));
      cab.append(interr);
    }
    if (!hereda) {
      const mover = (d) => { const j = n + d; if (j < 0 || j >= crLista.length) return; [crLista[n], crLista[j]] = [crLista[j], crLista[n]]; crPintar(); };
      const sube = el('button', 'btn chico', '↑'); sube.type = 'button'; sube.title = 'Subir'; sube.disabled = n === 0; sube.addEventListener('click', () => mover(-1));
      const baja = el('button', 'btn chico', '↓'); baja.type = 'button'; baja.title = 'Bajar'; baja.disabled = n === crLista.length - 1; baja.addEventListener('click', () => mover(1));
      const borra = el('button', 'btn chico peligro', '🗑'); borra.type = 'button'; borra.title = 'Quitar carril'; borra.disabled = crLista.length <= 1;
      borra.addEventListener('click', () => { crLista.splice(n, 1); crPintar(); });
      cab.append(sube, baja, borra);
    }
    t.append(cab);
    const grupo = (titulo, opciones, marcados, alCambiar, vacio) => {
      const g = el('fieldset', 'cr-grupo');
      g.append(el('legend', '', titulo));
      if (!opciones.length) { g.append(el('p', 'ayuda', vacio)); t.append(g); return; }
      const fila = el('div', 'lote-lista');
      for (const [v, tx] of opciones) {
        const x = document.createElement('input'); x.type = 'checkbox'; x.checked = marcados.includes(v); x.disabled = hereda;
        x.addEventListener('change', () => alCambiar(v, x.checked));
        const l = el('label', 'lote-op'); l.append(x, el('span', '', tx));
        fila.append(l);
      }
      g.append(fila); t.append(g);
    };
    const poner = (lista, v, si) => { const i = lista.indexOf(v); if (si && i < 0) lista.push(v); if (!si && i >= 0) lista.splice(i, 1); };
    grupo('Tipo de pedido', TIPOS_CR, c.tipos, (v, si) => poner(c.tipos, v, si), '');
    grupo('Estación (parrilla) de los platillos', crEstado.estaciones.map((e) => [e.id, e.nombre]), c.estaciones, (v, si) => poner(c.estaciones, v, si), 'Aún no hay estaciones. Créalas en Ajustes · Cocina.');
    grupo('Categoría de los platillos', crEstado.categorias.map((k) => [k, k]), c.categorias, (v, si) => poner(c.categorias, v, si), 'Aún no hay categorías.');
    caja.append(t);
  });
  acActualizar();
}

async function abrirCarriles() {
  $('cr-error').textContent = '';
  try { crEstado = (await pedir(API + 'admin/prioridades.php')).carriles; } catch (err) { avisar(err.message, true); return; }
  if (!crEstado) { avisar('No se pudieron cargar los carriles.', true); return; }
  const sel = $('cr-ambito');
  sel.replaceChildren();
  if (crEstado.puede_general) sel.append(new Option('Toda la empresa', 'general'));
  for (const s of crEstado.sucursales) sel.append(new Option('Sucursal · ' + s.nombre, String(s.id)));
  crCargarAmbito();
  abrirPagina(dlgCarriles, 'btn-carriles');
}
$('btn-carriles').addEventListener('click', abrirCarriles);
protegerSelector($('cr-ambito'), () => crSucio(), () => guardarCarriles(), () => crCargarAmbito());
$('cr-heredar').addEventListener('change', () => {
  if (!$('cr-heredar').checked && $('cr-ambito').value !== 'general') {
    // Empieza con una copia de lo que usa hoy para editarla
    const suc = crEstado.sucursales.find((s) => String(s.id) === $('cr-ambito').value);
    crLista = copiaCarriles(suc.carriles);
  }
  crPintar();
});
$('cr-agregar').addEventListener('click', () => {
  if (crLista.length >= 8) { $('cr-error').textContent = 'Máximo 8 carriles.'; return; }
  crLista.push({ id: 'c' + Date.now().toString(36).slice(-6), nombre: '', color: 'azul', tipos: [], estaciones: [], categorias: [] });
  crPintar();
});
$('cr-defecto').addEventListener('click', () => { crLista = copiaCarriles(crEstado.defecto); crPintar(); });
for (const ev of ['input', 'change', 'click']) $('cr-lista').addEventListener(ev, () => setTimeout(acActualizar, 0));
let crBase = null;
const crSnap = () => JSON.stringify({ a: $('cr-ambito').value, h: $('cr-heredar').checked, l: crLista });
const crSucio = () => !!crEstado && crEstado.puede_editar && crBase !== null && crSnap() !== crBase;
/** Guarda los carriles de lo seleccionado en «¿Para quién?». Devuelve true si salió bien. */
async function guardarCarriles() {
  $('cr-error').textContent = '';
  const hereda = $('cr-heredar').checked;
  const cuerpo = { accion: 'carriles', ...crAmbito() };
  if (hereda) cuerpo.heredar = true; else cuerpo.carriles = crLista;
  try {
    const r = await enviarJson(API + 'admin/prioridades.php', cuerpo);
    crEstado = r.carriles;
    crCargarAmbito();
    avisar('Carriles guardados');
    return true;
  } catch (err) { $('cr-error').textContent = err.message; return false; }
}
PAG['dlg-carriles'] = { sucio: crSucio, guardar: guardarCarriles };
$('cr-cerrar').addEventListener('click', () => dlgCarriles.close());

/* Ajustes de pedidos por QR: su propia página */
const dlgPedidosQr = $('dlg-pedidos-qr');
PAG['dlg-caja'] = { sucio: () => false, guardar: async () => true };   // Ajustes de caja aún no tiene opciones propias: el botón queda listo para cuando las tenga
$('btn-pedidos-qr').addEventListener('click', async () => {
  $('cp-error').textContent = '';
  try { await cargarClientePedidos(); await cargarCfgCliente(); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgPedidosQr, 'btn-pedidos-qr');
});
PAG['dlg-pedidos-qr'] = { sucio: () => !!cpOriginal && (cpCambios().length > 0 || ctSucio()), guardar: () => guardarClientePedidos() };

/* Tipos de pedido, plato por plato y datos de pago: por empresa (dueño) y por sucursal (dueño o gerente) */
let cfgCliente = null;   // lo que manda el servidor: { puede_general, general, sucursales: [{ id, nombre, propio, efectivo }] }
const TODOS_TIPOS = ['aqui', 'llevar', 'recoger'];

async function cargarCfgCliente() {
  const r = await pedir(API + 'admin/cliente-config.php');
  const antes = { tipos: $('ct-ambito').value, pago: $('pg-ambito').value };
  cfgCliente = r;
  for (const sel of [$('ct-ambito'), $('pg-ambito')]) {
    sel.replaceChildren();
    if (r.puede_general) sel.append(new Option('Toda la empresa (valor por defecto)', 'general'));
    for (const s of r.sucursales) sel.append(new Option(s.nombre, String(s.id)));
  }
  const elige = (sel, v) => { if ([...sel.options].some((o) => o.value === v)) sel.value = v; };
  elige($('ct-ambito'), antes.tipos); elige($('pg-ambito'), antes.pago);
  ctPintar(); pgPintar();
}
const cfgAmbito = (sel) => (sel.value === 'general' ? { ambito: 'general' } : { ambito: 'sucursal', sucursal_id: Number(sel.value) });

function ctPintar() {
  const v = $('ct-ambito').value;
  const suc = cfgCliente.sucursales.find((s) => String(s.id) === v);
  const mods = v === 'general' ? (cfgCliente.general.modalidades || TODOS_TIPOS) : suc.efectivo.modalidades;
  const mixto = v === 'general' ? (cfgCliente.general.mixto ?? true) : (suc.propio.mixto ?? suc.efectivo.mixto);
  document.querySelectorAll('#ct-mods input').forEach((x) => { x.checked = mods.includes(x.dataset.mod); });
  $('ct-mixto').checked = mixto && mods.includes('aqui') && mods.includes('llevar');
  $('ct-mixto').disabled = !(mods.includes('aqui') && mods.includes('llevar'));
  const heredado = suc && suc.propio.modalidades === null && suc.propio.mixto === null && suc.propio.mesa === null;
  $('ct-mesa').value = v === 'general' ? (cfgCliente.general.mesa || 'opcional') : (suc.efectivo.mesa || 'opcional');
  $('ct-nota').hidden = !heredado;
  $('ct-nota').textContent = heredado ? 'Esta sucursal usa la configuración de la empresa. Al guardar, tendrá la suya.' : '';
  ctBase = ctSnap(); ctAmbitoPrevio = v;
  acActualizar();
}
protegerSelector($('ct-ambito'), ctSucio, () => guardarClientePedidos(), ctPintar);
for (const id of ['ct-mods', 'ct-mixto', 'ct-mesa']) $(id).addEventListener('change', acActualizar);
$('ct-mods').addEventListener('change', (ev) => {
  const marcados = [...document.querySelectorAll('#ct-mods input')].filter((x) => x.checked);
  if (marcados.length === 0) { ev.target.checked = true; avisar('Deja al menos un tipo de pedido.', true); }
  const m = [...document.querySelectorAll('#ct-mods input')].filter((x) => x.checked).map((x) => x.dataset.mod);
  const dos = m.includes('aqui') && m.includes('llevar');
  $('ct-mixto').disabled = !dos;
  if (!dos) $('ct-mixto').checked = false;
});
/** Guarda los tipos de pedido de lo que está seleccionado en «¿Para quién?». Lanza el error si falla. */
async function guardarTiposPedido() {
  const modalidades = [...document.querySelectorAll('#ct-mods input')].filter((x) => x.checked).map((x) => x.dataset.mod);
  await enviarJson(API + 'admin/cliente-config.php', { accion: 'tipos', ...cfgAmbito($('ct-ambito')), modalidades, mixto: $('ct-mixto').checked, mesa: $('ct-mesa').value });
}

const dlgPago = $('dlg-pago');
function pgPintar() {
  const v = $('pg-ambito').value;
  const suc = cfgCliente.sucursales.find((s) => String(s.id) === v);
  const propio = v === 'general' ? cfgCliente.general.pago : suc.propio.pago;
  const mostrado = propio || (suc && suc.efectivo.pago) || null;
  $('pg-clabe').value = mostrado ? mostrado.clabe : '';
  $('pg-benef').value = mostrado ? mostrado.beneficiario : '';
  $('pg-inst').value = mostrado ? mostrado.institucion : '';
  // ¿Se acepta transferencia? El gerente no puede encenderla si el dueño la apagó para toda la empresa
  const generalOk = cfgCliente.general.transferencia === true;
  $('pg-activo').checked = v === 'general' ? generalOk : (generalOk && suc.propio.transferencia !== false);
  $('pg-activo').disabled = v !== 'general' && !generalOk && !cfgCliente.puede_general;
  $('pg-activo-nota').hidden = !($('pg-activo').disabled || (v !== 'general' && !generalOk));
  $('pg-activo-nota').textContent = !generalOk ? 'El pago por transferencia no está activado en toda la empresa.' + (cfgCliente.puede_general ? ' Actívalo en «Toda la empresa» para poder usarlo en una sucursal.' : ' Solo el dueño puede activarlo.') : '';
  $('pg-campos').hidden = !$('pg-activo').checked;
  $('pg-quitar').hidden = !(suc && propio);
  $('pg-nota').hidden = !(suc && !propio);
  pgBase = pgSnap(); acActualizar();
  $('pg-nota').textContent = suc && !propio ? (mostrado ? 'Esta sucursal usa los datos de la empresa. Al guardar, tendrá los suyos.' : 'Esta sucursal todavía no tiene datos de pago: el cliente ve «paga en caja».') : '';
}
protegerSelector($('pg-ambito'), () => pgBase !== null && pgSnap() !== pgBase, guardarPago, pgPintar);
$('pg-activo').addEventListener('change', () => { $('pg-campos').hidden = !$('pg-activo').checked; acActualizar(); });
for (const id of ['pg-clabe', 'pg-benef', 'pg-inst']) $(id).addEventListener('input', acActualizar);
PAG['dlg-pago'] = { sucio: () => pgBase !== null && pgSnap() !== pgBase, guardar: guardarPago };
/** Guarda los datos de pago de lo seleccionado en «¿Para quién?». Devuelve true si salió bien. */
async function guardarPago() {
  $('pg-error').textContent = '';
  try {
    const ambito = cfgAmbito($('pg-ambito'));
    const v = $('pg-ambito').value;
    const suc = cfgCliente.sucursales.find((s) => String(s.id) === v);
    const antes = v === 'general' ? cfgCliente.general.transferencia === true : suc.propio.transferencia !== false && cfgCliente.general.transferencia === true;
    if (!$('pg-activo').disabled && $('pg-activo').checked !== antes) await enviarJson(API + 'admin/cliente-config.php', { accion: 'transferencia', ...ambito, activo: $('pg-activo').checked });
    if ($('pg-activo').checked && ($('pg-clabe').value.trim() || !(v === 'general' ? cfgCliente.general.pago : (suc.propio.pago || suc.efectivo.pago)))) await enviarJson(API + 'admin/cliente-config.php', { accion: 'pago', ...ambito, clabe: $('pg-clabe').value, beneficiario: $('pg-benef').value, institucion: $('pg-inst').value });
    avisar('Pago por transferencia guardado');
    await cargarCfgCliente();
    return true;
  } catch (err) { $('pg-error').textContent = err.message; return false; }
}
let pgBase = null;
const pgSnap = () => JSON.stringify({ a: $('pg-ambito').value, t: $('pg-activo').checked, c: $('pg-clabe').value, b: $('pg-benef').value, i: $('pg-inst').value });
$('pg-quitar').addEventListener('click', async () => {
  $('pg-error').textContent = '';
  try {
    await enviarJson(API + 'admin/cliente-config.php', { accion: 'pago_quitar', ...cfgAmbito($('pg-ambito')) });
    avisar('Esta sucursal volvió a usar los datos de la empresa');
    await cargarCfgCliente();
  } catch (err) { $('pg-error').textContent = err.message; }
});
async function abrirPago() {
  $('pg-error').textContent = '';
  try { await cargarCfgCliente(); } catch (err) { avisar(err.message, true); return; }
  abrirPagina(dlgPago, 'btn-pago');
}
$('btn-pago').addEventListener('click', abrirPago);
$('ct-ir-pago').addEventListener('click', abrirPago);
$('pg-cerrar').addEventListener('click', () => dlgPago.close());
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
  if (!esGerente && $('cm-destino').value) datos.append('sucursal', $('cm-destino').value);
  return pedir(API + 'admin/productos-importar.php', { method: 'POST', body: datos });
}

$('btn-carga').addEventListener('click', async () => {
  $('cm-error').textContent = '';
  // El dueño elige dónde cargar: la carta general o directo en una sucursal (quedan como platillos propios de ella)
  if (!esGerente) {
    try {
      const r = await pedir(API + 'admin/sucursales.php');
      const sel = $('cm-destino');
      const previo = sel.value;
      sel.replaceChildren(new Option('Carta general de la empresa', ''));
      for (const s of r.sucursales.filter((x) => x.activa)) sel.append(new Option('Solo en la sucursal: ' + s.nombre + (s.carta_propia ? ' (carta propia)' : ''), String(s.id)));
      const quiere = /^\d+$/.test(filtroCarta) ? filtroCarta : previo;   // si estás viendo la carta de una sucursal, la carga va ahí
      sel.value = [...sel.options].some((o) => o.value === quiere) ? quiere : '';
      $('cm-destino-caja').hidden = r.sucursales.length < 2;
    } catch { $('cm-destino-caja').hidden = true; }
  }
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
for (const id of ['cm-planilla', 'cm-zip', 'cm-destino']) $(id).addEventListener('change', () => { $('cm-resultado').hidden = true; });
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
  campo.setAttribute('aria-label', 'Precio del modificador');
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


/**
 * Tarjetas de extras, agrupadas en secciones (por "grupo"). Cada tarjeta muestra de un vistazo:
 *   · el nombre, su código para cocina y si es gratis o cuesta (+$10);
 *   · en qué categorías está disponible (✓ todos · 3/5 algunos · ○ ninguno). Tocar una categoría lo pone (o lo quita)
 *     en TODOS los platillos de esa categoría; para elegir platillo por platillo se hace desde el producto;
 *   · "Editar" abre el formulario de esa tarjeta (nombre, código, grupo, costo, activo) con su botón Guardar.
 */

/* Buscador de modificadores: sin acentos ni mayúsculas; busca en nombre, código, tipo y «tipo + nombre» */
let exBusqueda = '';
/* Qué tipos están abiertos: se recuerda en este navegador (solo es una comodidad visual). */
const CLAVE_TIPOS = `cmd_tipos_abiertos_${slugActual()}`;
const tiposAbiertos = new Set((() => { try { return JSON.parse(localStorage.getItem(CLAVE_TIPOS) || '[]'); } catch { return []; } })());
const tiposYaGuardados = () => { try { return localStorage.getItem(CLAVE_TIPOS) !== null; } catch { return true; } };
const guardarTipos = () => { try { localStorage.setItem(CLAVE_TIPOS, JSON.stringify([...tiposAbiertos])); } catch { /* sin almacenamiento */ } };
const sinAcentos = (t) => String(t).toLowerCase().split('').map((c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join('');
/** Devuelve el texto con los caracteres que cuadran con la búsqueda marcados. */
function resaltar(texto, q = exBusqueda) {
  const t = String(texto);
  if (!q) return t;
  const i = sinAcentos(t).indexOf(q);
  if (i < 0) return t;
  const f = document.createDocumentFragment();
  const m = document.createElement('mark');
  m.textContent = t.slice(i, i + q.length);
  f.append(t.slice(0, i), m, t.slice(i + q.length));
  return f;
}
const extraCuadra = (x, q) => [x.nombre, x.codigo || '', x.grupo || '', (x.grupo || '') + ' ' + x.nombre].some((t) => sinAcentos(t).includes(q));
$('ex-buscar').addEventListener('input', () => { exBusqueda = sinAcentos($('ex-buscar').value.trim()); pintarExtras(); });

function pintarExtras() {
  // Sugerencias de grupo (los que ya existen)
  $('lista-grupos').replaceChildren(...gruposExtras.map((g) => new Option(g)));
  pintarSeccionesExtras();

  const caja = $('lista-extras');
  caja.replaceChildren();
  if (extras.length === 0) {
    caja.append(el('p', 'ayuda ex-vacio', 'Todavía no hay modificadores. Toca “＋ Modificador” (arriba a la derecha) para crear el primero (por ejemplo, Sin cebolla).'));
    return;
  }
  $('ex-leyenda').textContent = categorias.length ? 'Cada tarjeta muestra en qué categorías aparece el modificador (verde = en todos sus platillos, amarillo = en algunos, ej. 1/11). Para cambiarlo, toca «Editar» y elige los platillos.' : '';

  // Tipos en el orden elegido (las vacías también se muestran); los extras sin tipo van al final, en "Otros"
  const q = exBusqueda;
  const grupos = new Map(gruposExtras.map((g) => [g, []]));
  for (const x of extras) {
    if (q && !extraCuadra(x, q)) continue;
    const g = x.grupo && grupos.has(x.grupo) ? x.grupo : 'Otros';
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  if (grupos.has('Otros') && grupos.get('Otros').length === 0) grupos.delete('Otros');
  if (q) {
    for (const [g, lista] of [...grupos]) if (lista.length === 0) grupos.delete(g);   // buscando: solo los tipos con resultados
    if (grupos.size === 0) { caja.append(el('p', 'ayuda ex-vacio', 'Ningún modificador coincide con la búsqueda.')); return; }
  }
  // Un bloque desplegable por tipo; se recuerda cuáles están abiertos. Buscando, se abren los que tienen resultados.
  const claves = [...grupos.keys()];
  if (!tiposYaGuardados() && claves.length) { tiposAbiertos.add(claves[0]); guardarTipos(); }
  const barra = $('ex-expandir');
  barra.replaceChildren();
  const todo = el('button', 'btn chico', 'Expandir todo'); todo.type = 'button';
  todo.addEventListener('click', () => { for (const k of claves) tiposAbiertos.add(k); guardarTipos(); pintarExtras(); });
  const nada = el('button', 'btn chico', 'Colapsar todo'); nada.type = 'button';
  nada.addEventListener('click', () => { for (const k of claves) tiposAbiertos.delete(k); guardarTipos(); pintarExtras(); });
  barra.append(todo, nada);
  for (const [g, lista] of grupos) {
    const det = el('details', 'cat-grupo');
    det.open = !!q || tiposAbiertos.has(g);
    const resumen = el('summary', 'cat-resumen');
    const nombreTipo = el('span', 'cat-nombre'); nombreTipo.append(resaltar(g));
    resumen.append(nombreTipo, el('span', 'chip', lista.length === 0 ? 'vacío' : lista.length === 1 ? '1 modificador' : `${lista.length} modificadores`));
    det.append(resumen);
    if (lista.length === 0) det.append(el('p', 'ayuda', 'Sin modificadores todavía. Crea uno con “＋ Modificador” y elige este tipo.'));
    else {
      const rejilla = el('div', 'ex-rejilla');
      for (const x of lista) rejilla.append(tarjetaExtra(x));
      det.append(rejilla);
    }
    det.addEventListener('toggle', () => { if (q) return; if (det.open) tiposAbiertos.add(g); else tiposAbiertos.delete(g); guardarTipos(); });
    caja.append(det);
  }
}

function tarjetaExtra(x) {
  const tarjeta = el('article', 'ex-tarjeta' + (x.activo && !x.deshabilitado ? '' : ' inactivo'));

  // Cabecera: nombre, código y precio
  const cab = el('div', 'ex-cab');
  const titulo = el('div', 'ex-titulo');
  const nom = el('strong', 'ex-nombre'); nom.append(resaltar(x.nombre)); titulo.append(nom);
  if (x.codigo) { const cc = el('span', 'chip'); cc.append(resaltar(x.codigo)); titulo.append(cc); }
  if (!x.activo) titulo.append(el('span', 'chip sin', 'Desactivado'));
  if (x.deshabilitado) titulo.append(el('span', 'chip sin', 'Deshabilitado en tu sucursal'));
  if (x.sucursal_id !== null) titulo.append(el('span', 'chip', esGerente ? 'Mío' : 'Solo ' + (sucursalesCarta.find((s) => s.id === x.sucursal_id) || { nombre: x.sucursal || 'una sucursal' }).nombre));
  else if (!esGerente && x.todos) titulo.append(el('span', 'chip ex-res todos', 'En todos los platillos'));
  cab.append(titulo, el('span', 'ex-precio' + (x.precio > 0 ? ' paga' : ''), x.precio > 0 ? `+${dinero.format(x.precio)}` : 'Gratis'));
  tarjeta.append(cab);

  // Dónde aparece (solo informativo; se cambia desde «Editar»)
  if (categorias.length) tarjeta.append(resumenDisponibilidad((p) => p.extras.includes(x.id)));

  // Pie: cuántos platillos lo llevan + editar / eliminar
  const usado = productos.filter((p) => p.extras.includes(x.id)).length;
  const pie = el('div', 'ex-pie');
  pie.append(el('span', 'ex-cuenta', usado === 0 ? 'Aún no está en ningún platillo' : `En ${usado} platillo${usado === 1 ? '' : 's'}`));
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
let epExtra = null, epOriginal = new Set(), epMarcados = new Set(), epModo = 'aparece', epSoloIds = null;   // epModo 'cobro' = elegir dónde se cobra; epSoloIds = limitar a esos platillos

function epPintar() {
  const q = $('ep-buscar').value.trim().toLowerCase();
  const lista = $('ep-lista');
  lista.replaceChildren();
  let visibles = 0;
  for (const c of categorias) {
    const deCat = productos.filter((p) => p.categoria_id === c.id && (!epSoloIds || epSoloIds.has(p.id)));
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
  epModo = 'aparece'; epSoloIds = null;
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
$('ep-todos').addEventListener('click', () => { for (const p of productos) if (!epSoloIds || epSoloIds.has(p.id)) epMarcados.add(p.id); epPintar(); });
$('ep-ninguno').addEventListener('click', () => { epMarcados.clear(); epPintar(); });
$('ep-cancelar').addEventListener('click', () => dlgEP.close());
$('ep-x').addEventListener('click', () => dlgEP.close());
$('ep-guardar').addEventListener('click', async () => {
  $('ep-error').textContent = '';
  if (epModo === 'defecto') { efDefSel = new Set(epMarcados); epModo = 'aparece'; epSoloIds = null; if (!efExtra && !$('ef-modo-todos').checked) for (const id of efDefSel) efSel.add(id); dlgEP.close(); pintarDefecto(); efDonde(); return; }
  if (epModo === 'cobro') { efCobroSel = new Set(epMarcados); epModo = 'aparece'; epSoloIds = null; if (!efExtra && !$('ef-modo-todos').checked) for (const id of efCobroSel) efSel.add(id); dlgEP.close(); pintarCobro(); efDonde(); return; }
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
/*  Tipos de extras (Quitar, Aparte, Solo...) y variantes          */
/* ------------------------------------------------------------------ */

/** Panel "Tipos": subir/bajar, renombrar y quitar. Quitar un tipo NO borra sus extras (pasan a "Otros"). */
function pintarSeccionesExtras() {
  const caja = $('ex-sec-lista');
  caja.replaceChildren();
  if (gruposExtras.length === 0) { caja.append(el('p', 'ayuda', 'Todavía no hay tipos. Agrega la primera abajo.')); return; }
  if (esGerente) caja.append(el('p', 'ayuda', 'Los tipos con candado los creó el administrador de la empresa: no se pueden cambiar ni quitar, pero sus modificadores sí puedes deshabilitarlos en tu sucursal.'));
  const propias = gruposExtras.filter((g) => (gruposExtrasInfo.find((i) => i.nombre === g) || { propio: true }).propio);   // las que se pueden mover (en orden)
  gruposExtras.forEach((g) => {
    const info = gruposExtrasInfo.find((i) => i.nombre === g) || { propio: true, sucursal_id: null };
    const fila = el('div', 'ex-sec-fila');
    const n = extras.filter((x) => x.grupo === g).length;
    const nombre = el('span', 'ex-sec-nombre'); nombre.append(el('strong', '', (info.propio ? '' : '🔒 ') + g), el('small', '', ` · ${n} modificador${n === 1 ? '' : 'es'}`));
    if (info.codigo) nombre.append(el('span', 'chip', info.codigo));
    if (info.descripcion) nombre.append(el('span', 'tip', 'i')), nombre.lastChild.dataset.tip = info.descripcion, nombre.lastChild.tabIndex = 0;
    if (!esGerente && info.sucursal_id !== null) {
      const suc = sucursalesCarta.find((x) => x.id === info.sucursal_id);
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
    const renombrar = el('button', 'btn chico', '✎ Editar'); renombrar.type = 'button';
    renombrar.addEventListener('click', () => abrirEditarSeccion(g, info));
    const quitar = el('button', 'btn chico peligro', '🗑'); quitar.type = 'button'; quitar.title = 'Quitar tipo'; quitar.setAttribute('aria-label', 'Quitar tipo');
    quitar.addEventListener('click', async () => {
      const aviso = n ? ` Sus ${n} modificador${n === 1 ? '' : 'es'} NO se borran: pasan a “Otros”.` : '';
      if (await confirmar(`¿Quitar el tipo “${g}”?${aviso}`, { si: 'Quitar tipo', peligro: true })) accionExtra({ accion: 'grupo_eliminar', nombre: g }, 'Tipo quitado');
    });
    fila.append(...botones, nombre, renombrar, quitar);
    caja.append(fila);
  });
}

/** Ventana para editar un tipo: nombre, código y "se lee junto al nombre". */
let seccionEditando = null;
function abrirEditarSeccion(nombre, info) {
  seccionEditando = nombre;
  $('se-titulo').textContent = nombre === null ? 'Nuevo tipo de modificador' : 'Editar tipo';
  $('se-nombre').value = nombre || '';
  $('se-codigo').value = (info && info.codigo) || '';
  $('se-descripcion').value = (info && info.descripcion) || '';
  $('se-error').textContent = '';
  $('dlg-seccion-editar').showModal();
  $('se-nombre').focus();
}
$('se-cancelar').addEventListener('click', () => $('dlg-seccion-editar').close());
$('form-seccion').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const campos = { codigo: $('se-codigo').value.trim(), descripcion: $('se-descripcion').value.trim() };
    if (seccionEditando === null) await enviarJson(API + 'admin/extras.php', { accion: 'grupo_crear', nombre: $('se-nombre').value.trim(), ...campos });
    else await enviarJson(API + 'admin/extras.php', { accion: 'grupo_editar', nombre: seccionEditando, nuevo: $('se-nombre').value.trim(), ...campos });
    $('dlg-seccion-editar').close();
    await cargarCatalogo();
    pintarExtras();
    avisar(seccionEditando === null ? 'Tipo creado' : 'Tipo actualizado');
  } catch (err) { $('se-error').textContent = err.message; }
});

/** Dos páginas dentro de Modificadores: la lista de modificadores y la de sus tipos. */
function mostrarVistaExtras(tipos) {
  $('ex-vista-mods').hidden = tipos;
  $('ex-tipos').hidden = !tipos;
  for (const [id, activo] of [['ex-tab-mods', !tipos], ['ex-tab-secs', tipos]]) {
    $(id).classList.toggle('principal', activo);
    $(id).setAttribute('aria-selected', String(activo));
  }
  $('x-error').textContent = '';
}
$('ex-tab-mods').addEventListener('click', () => mostrarVistaExtras(false));
$('ex-tab-secs').addEventListener('click', () => mostrarVistaExtras(true));
$('ex-sec-nuevo-abrir').addEventListener('click', () => abrirEditarSeccion(null, null));

/** Cierra los paneles de arriba (nuevo extra, variantes, tipos) para que solo haya uno abierto a la vez. */

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
  $('ex-buscar').value = ''; exBusqueda = '';
  mostrarVistaExtras(false);
  pintarExtras();
  abrirPagina(dlgExtras, 'btn-extras');
});
$('x-cerrar').addEventListener('click', () => dlgExtras.close());
/* ---- Ventana para crear o editar un extra ---- */
const dlgExtraForm = $('dlg-extra-form');
let efExtra = null;       // el extra que se edita (null = nuevo)
let efDefSel = new Set();      // platillos donde viene marcado de fábrica (modo «solo en algunos»)
let efDefInicial = 'no';
const efDefModo = () => ($('ef-def-todos').checked ? 'todos' : $('ef-def-algunos').checked ? 'algunos' : 'no');
function pintarDefecto() {
  const m = efDefModo();
  $('ef-def-elegir').hidden = m !== 'algunos';
  $('ef-def-resumen').replaceChildren();
  if (m === 'algunos') $('ef-def-resumen').append(el('span', 'chip ex-res' + (efDefSel.size ? ' algunos' : ''), efDefSel.size ? `Por defecto en ${efDefSel.size} platillo${efDefSel.size === 1 ? '' : 's'}` : 'Aún no eliges en qué platillos'));
}
for (const id of ['ef-def-no', 'ef-def-todos', 'ef-def-algunos']) $(id).addEventListener('change', pintarDefecto);
$('ef-def-elegir').addEventListener('click', () => {
  epModo = 'defecto'; epExtra = efExtra; epSoloIds = null;
  epOriginal = new Set(); epMarcados = new Set(efDefSel);
  $('ep-titulo').textContent = `¿En qué platillos se establece por defecto${efExtra ? ' «' + efExtra.nombre + '»' : ' el modificador'}? Ahí también aparecerá.`;
  $('ep-buscar').value = ''; $('ep-error').textContent = '';
  epPintar();
  dlgEP.showModal();
});

let efCobroSel = new Set();   // platillos donde se cobra (modo «solo en algunos»)
let efCobroInicial = 'no';    // cómo estaba el cobro al abrir (para limpiar precios propios si cambia)

function pintarOpcionesGrupo(actual) {
  const sel = $('ef-grupo');
  // Todo modificador va dentro de un tipo que ya exista (se crean en «＋ Tipo de modificador»): no hay «sin tipo» ni creación aquí.
  const vacio = new Option('Elige un tipo…', ''); vacio.disabled = true;
  sel.replaceChildren(vacio);
  const nombres = [...gruposExtras];
  if (actual && !nombres.includes(actual)) nombres.push(actual);
  for (const g of nombres) sel.append(new Option(g, g));
  sel.value = actual || '';
}

/** Bloque «Disponible en» del formulario de edición: resumen + elegir platillos + igualar precio. */
let efSel = new Set();   // platillos elegidos para un extra NUEVO (todavía no existe en el servidor)
function efDonde() {
  $('ef-elegir').hidden = $('ef-modo-todos').checked;
  if ($('ef-modo-todos').checked) { $('ef-resumen').replaceChildren(el('span', 'chip ex-res todos', 'Todos los platillos')); $('ef-igualar').hidden = true; pintarPreviaExtra(); return; }
  pintarPreviaExtra();
  $('ef-resumen').replaceChildren(resumenDisponibilidad(efExtra ? (p) => p.extras.includes(efExtra.id) : (p) => efSel.has(p.id)));
  $('ef-igualar').hidden = !efExtra || !productos.some((p) => p.extras_precios && p.extras_precios[efExtra.id] !== undefined);
}
$('ef-elegir').addEventListener('click', () => abrirExtraPlatillos(efExtra));
for (const id of ['ef-modo-todos', 'ef-modo-elegir']) $(id).addEventListener('change', efDonde);

/** Vista previa: cómo lo ve el cliente al armar el platillo (título de el tipo y el modificador debajo). */
const efCobroModo = () => ($('ef-cobro-todos').checked ? 'todos' : $('ef-cobro-algunos').checked ? 'algunos' : 'no');
const efPrecio = () => $('ef-precio').value.trim().replace(',', '.') || '0';
function pintarCobro() {
  const m = efCobroModo();
  $('ef-cobro-detalle').hidden = m === 'no';
  $('ef-cobro-elegir').hidden = m !== 'algunos';
  $('ef-cobro-resumen').replaceChildren();
  if (m === 'algunos') $('ef-cobro-resumen').append(el('span', 'chip ex-res' + (efCobroSel.size ? ' algunos' : ''), efCobroSel.size ? `Se cobra en ${efCobroSel.size} platillo${efCobroSel.size === 1 ? '' : 's'}; en los demás es gratis` : 'Aún no eliges dónde se cobra'));
  pintarPreviaExtra();
}
for (const id of ['ef-cobro-no', 'ef-cobro-todos', 'ef-cobro-algunos']) $(id).addEventListener('change', pintarCobro);
$('ef-precio').addEventListener('input', pintarPreviaExtra);
$('ef-cobro-elegir').addEventListener('click', () => {
  epModo = 'cobro'; epExtra = efExtra;
  epSoloIds = null;
  epOriginal = new Set(); epMarcados = new Set(efCobroSel);
  $('ep-titulo').textContent = `¿En qué platillos se cobra${efExtra ? ' «' + efExtra.nombre + '»' : ' el modificador'}? Ahí también aparecerá; en los demás será gratis.`;
  $('ep-buscar').value = ''; $('ep-error').textContent = '';
  epPintar();
  dlgEP.showModal();
});

function pintarPreviaExtra() {
  const sel = $('ef-grupo').value;
  const seccion = sel;
  const nombre = $('ef-nombre').value.trim();
  const caja = $('ef-previa');
  caja.replaceChildren();
  if (!nombre) { caja.append(el('span', 'ayuda', 'Escribe el nombre para ver cómo se verá.')); return; }
  const costo = efCobroModo() === 'no' ? 0 : Number(efPrecio().replace(',', '.')) || 0;
  caja.append(el('span', 'ef-prev-sec', seccion || 'Otros'));
  const info = gruposExtrasInfo.find((g) => g.nombre === seccion);
  const chip = el('span', 'ef-prev-chip', seccion ? `${seccion} ${nombre}` : nombre);
  if (costo > 0) chip.append(el('b', '', ` +${dinero.format(costo)}${efCobroModo() === 'algunos' ? ' (solo en algunos)' : ''}`));
  caja.append(chip);
  if (info && info.codigo) caja.append(el('small', 'ayuda', `Cocina verá: ${info.codigo} ${($('ef-codigo').value.trim() || nombre).toUpperCase()}`));
}
for (const id of ['ef-nombre', 'ef-grupo']) { $(id).addEventListener('input', pintarPreviaExtra); $(id).addEventListener('change', pintarPreviaExtra); }
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
  // Cobro: gratis · en todos donde aparece · solo en algunos platillos (precio propio en esos y gratis en el resto)
  const conPrecio = x ? productos.filter((p) => p.extras.includes(x.id) && p.extras_precios && Number(p.extras_precios[x.id]) > 0) : [];
  efCobroSel = new Set(conPrecio.map((p) => p.id));
  efCobroInicial = x && x.precio > 0 ? 'todos' : conPrecio.length ? 'algunos' : 'no';
  $('ef-cobro-no').checked = efCobroInicial === 'no';
  $('ef-cobro-todos').checked = efCobroInicial === 'todos';
  $('ef-cobro-algunos').checked = efCobroInicial === 'algunos';
  $('ef-precio').value = x && x.precio > 0 ? x.precio.toFixed(2) : conPrecio.length ? Number(conPrecio[0].extras_precios[x.id]).toFixed(2) : '';
  const conDef = x ? productos.filter((p) => p.extras.includes(x.id) && (p.extras_defecto || []).includes(x.id)) : [];
  efDefSel = new Set(conDef.map((p) => p.id));
  efDefInicial = x && x.defecto ? 'todos' : conDef.length ? 'algunos' : 'no';
  $('ef-def-no').checked = efDefInicial === 'no'; $('ef-def-todos').checked = efDefInicial === 'todos'; $('ef-def-algunos').checked = efDefInicial === 'algunos';
  pintarDefecto();
  pintarOpcionesGrupo(x ? (x.grupo || '') : '');
  $('ef-activo-fila').hidden = !x;
  $('ef-activo').checked = x ? x.activo : true;
  $('ef-otro').hidden = !!x;
  $('ef-todos-fila').hidden = esGerente || (!!x && x.sucursal_id !== null);
  $('ef-modo-todos').checked = !!(x && x.todos) && !$('ef-todos-fila').hidden;
  $('ef-modo-elegir').checked = !$('ef-modo-todos').checked;
  $('ef-error').textContent = '';
  efSel = new Set();
  efDonde();
  pintarCobro();
  dlgExtraForm.showModal();
  $('ef-nombre').focus();
}

async function guardarFormExtra() {
  $('ef-error').textContent = '';
  const nombre = $('ef-nombre').value.trim();
  if (!nombre) { $('ef-error').textContent = 'Escribe cómo se llama el modificador.'; $('ef-nombre').focus(); return false; }
  const g = $('ef-grupo').value;
  if (!g) { $('ef-error').textContent = 'Elige el tipo del modificador (si no hay ninguno, primero crea un tipo con «＋ Tipo de modificador»).'; $('ef-grupo').focus(); return false; }
  if (!efExtra && efSel.size === 0 && efCobroModo() !== 'algunos' && efDefModo() !== 'algunos' && !$('ef-modo-todos').checked) { $('ef-error').textContent = 'Elige en qué platillos va a aparecer (todos, o con «Elegir categorías o platillos…»).'; return false; }
  const modoCobro = efCobroModo();
  if (modoCobro !== 'no' && !(Number(efPrecio()) > 0)) { $('ef-error').textContent = 'Escribe el precio con el que se cobra (por ejemplo 10).'; $('ef-precio').focus(); return false; }
  if (efDefModo() === 'algunos' && efDefSel.size === 0) { $('ef-error').textContent = 'Elige en qué platillos se establece por defecto (botón «Elegir platillos…»).'; return false; }
  if (modoCobro === 'algunos' && efCobroSel.size === 0) { $('ef-error').textContent = 'Elige en qué platillos se cobra (botón «Elegir dónde se cobra…»).'; return false; }
  const cuerpo = { accion: efExtra ? 'actualizar' : 'crear', nombre, codigo: $('ef-codigo').value.trim(), grupo: g, precio: modoCobro === 'todos' ? efPrecio() : '0' };
  if (efExtra) { cuerpo.id = efExtra.id; cuerpo.activo = $('ef-activo').checked; }
  try {
    const r = await enviarJson(API + 'admin/extras.php', cuerpo);
    const idExtra = efExtra ? efExtra.id : r.id;
    if (!efExtra) efSel = new Set([...efSel, ...(modoCobro === 'algunos' ? efCobroSel : []), ...(efDefModo() === 'algunos' ? efDefSel : [])]);
    if (!efExtra && efSel.size) await enviarJson(API + 'admin/extras.php', { accion: 'asignar_platillos', id: idExtra, agregar: [...efSel], quitar: [] });
    if (efExtra && (modoCobro === 'algunos' || efDefModo() === 'algunos') && !$('ef-modo-todos').checked) {   // donde se cobra o viene marcado, también aparece
      const faltan = [...new Set([...(modoCobro === 'algunos' ? efCobroSel : []), ...(efDefModo() === 'algunos' ? efDefSel : [])])].filter((id) => { const p = productos.find((x) => x.id === id); return p && !p.extras.includes(efExtra.id); });
      if (faltan.length) await enviarJson(API + 'admin/extras.php', { accion: 'asignar_platillos', id: idExtra, agregar: faltan, quitar: [] });
    }
    if (!$('ef-todos-fila').hidden && $('ef-modo-todos').checked !== !!(efExtra && efExtra.todos)) await enviarJson(API + 'admin/extras.php', { accion: 'predeterminado', id: idExtra, valor: $('ef-modo-todos').checked });
    if (efDefModo() !== 'no' || efDefInicial !== 'no') await enviarJson(API + 'admin/extras.php', { accion: 'defecto', id: idExtra, modo: efDefModo(), platillos: [...efDefSel] });
    if (modoCobro === 'algunos') await enviarJson(API + 'admin/extras.php', { accion: 'cobro_platillos', id: idExtra, precio: efPrecio(), platillos: [...efCobroSel] });
    else if (efCobroInicial === 'algunos') await enviarJson(API + 'admin/extras.php', { accion: 'precio_general', id: idExtra });   // deja de cobrar con precios propios
    await cargarCatalogo();
    pintarExtras();
    avisar(efExtra ? 'Modificador actualizado' : $('ef-modo-todos').checked ? 'Modificador creado en todos los platillos' : `Modificador creado en ${efSel.size} platillo${efSel.size === 1 ? '' : 's'}`);
    return true;
  } catch (err) {
    $('ef-error').textContent = err.message;
    return false;
  }
}
$('ex-nuevo-abrir').addEventListener('click', () => {
  if (!gruposExtras.length) {   // sin tipos todavía: primero se crea uno
    avisar('Primero crea un tipo de modificador (por ejemplo «Con» o «Sin»); luego podrás agregar modificadores dentro de él.', true);
    abrirEditarSeccion(null, null);
    return;
  }
  abrirFormExtra(null);
});
$('ef-cancelar').addEventListener('click', () => dlgExtraForm.close());
$('form-extra').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (await guardarFormExtra()) dlgExtraForm.close();
});
$('ef-otro').addEventListener('click', async () => {
  const grupo = $('ef-grupo').value;
  const sel = new Set(efSel);
  if (await guardarFormExtra()) { abrirFormExtra(null); pintarOpcionesGrupo(grupo); efSel = sel; efDonde(); }   // la misma tipo se conserva para el siguiente
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

function plMarcarSucio(v = true) { plSucio = v; acActualizar(); }

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
/** Guarda el plano de la sucursal (mesas y zonas). Devuelve true si salió bien. */
async function guardarPlano() {
  $('pl-error').textContent = '';
  try {
    const r = await enviarJson(API + 'admin/plano.php', { accion: 'guardar', sucursal_id: pl.sucursal, mesas: plMesas.map((m) => ({ id: m.id, zona_id: m.zona_id, x: m.x, y: m.y, forma: m.forma, ancho_cm: m.ancho_cm || null, alto_cm: m.forma === 'rectangular' ? (m.alto_cm || null) : null })), zonas: pl.zonas.map((z) => ({ id: z.id, poligono: plPoli.get(z.id) || null, ancho_m: plAncho.get(z.id) || 10 })) });
    plMarcarSucio(false);
    plAplicar(r, false);
    avisar('Plano guardado');
    return true;
  } catch (err) { $('pl-error').textContent = err.message; return false; }
}
PAG['dlg-plano'] = { sucio: () => plSucio, guardar: guardarPlano };
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
