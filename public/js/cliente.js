/**
 * Pantalla del cliente (QR): arma su pedido, lo envía y lo sigue en tiempo real.
 * Cada pedido tiene una "clave" creada en este celular y guardada en localStorage:
 * por eso, aunque recargue o cierre la página, sigue viendo sus pedidos.
 * Puede tener varios pedidos a la vez; cada uno con varios platos.
 */

const API = 'api/';

/* Datos de pago por transferencia: vienen de la configuración de la sucursal (panel de administración). */
let CLABE_TRANSFERENCIA = '';
const $ = (id) => document.getElementById(id);
const ESTADO_ITEM = { pendiente: 'Pendiente', preparando: 'Preparando', listo: 'Listo' };
const CLAVE_LS = 'taqueria_pedidos';
const TERMINADOS = ['entregada', 'cancelada'];

let menu = [];
let categoriaActiva = 0;
let carrito = [];                 // [{producto, extras, cantidad, notas, plato}]
let claves = [];                  // claves de los pedidos de este celular
let ordenes = [];                 // última vista de cada pedido (del servidor)
let buscados = [];                // pedidos consultados por número + nombre (solo lectura): [{q}]
let ordenesBuscadas = [];         // su última vista
let destino = null;               // pedido al que se le agrega (null = pedido nuevo)
let claveNueva = null;            // clave del pedido nuevo mientras se envía
let modalidad = 'aqui';
let pedidosActivos = true;        // ¿el cliente puede levantar su pedido aquí? (si no, solo ve el menú)
let sucursalesNegocio = [];       // [{id, nombre, pedidos}]
const cuando = montarCuando($('cuando'));
const actualizarEspera = montarEspera($('espera-previa'), API + 'cliente/espera.php', () => ({
  modalidad,
  unidades: carrito.reduce((n, l) => n + l.cantidad, 0),
  agendado: Object.keys(cuando.datos()).length > 0,
  oculto: !!destino,
}));
cuando.onChange = actualizarEspera;
let modalidadesOk = ['aqui', 'llevar', 'recoger'];   // tipos de pedido que esta sucursal ofrece
let mixtoOk = false;                                  // ¿se puede elegir plato por plato (uno aquí y otro para llevar)?
const platosLlevar = new Set();                       // platos marcados «para llevar» dentro de un pedido para comer aquí
const mixtoPosible = () => mixtoOk && (destino ? destino.modalidad === 'aqui' : modalidad === 'aqui');
const esLlevar = (n) => mixtoPosible() && platosLlevar.has(n);
let mesasSuc = [];                                    // mesas activas de esta sucursal
let modoMesa = 'opcional';                            // 'no' | 'opcional' | 'obligatoria' (lo decide el negocio)
const mesaVisible = () => modalidad === 'aqui' && !destino && mesasSuc.length > 0 && modoMesa !== 'no';
const mesaObligatoria = () => mesaVisible() && modoMesa === 'obligatoria';
const campoMesa = crearCampoMesa($('mesa'), $('mesa-plano-btn'), () => actualizarMesaCliente());
/* El nombre es opcional si ya se eligió mesa; para llevar o recoger siempre se pide (la orden se entrega por nombre). */
const nombreOpcional = () => mesaVisible() && ($('mesa').value !== '' || modoMesa === 'obligatoria');
function actualizarMesaCliente() {
  const ver = mesaVisible();
  $('mesa-fila').hidden = !ver;
  if (!ver) $('mesa').value = '';
  campoMesa.refrescar();
  const op = nombreOpcional();
  $('mesa-rotulo').textContent = mesaObligatoria() ? 'Mesa (obligatoria)' : 'Mesa';
  $('cliente-rotulo').textContent = op ? 'Nombre (opcional)' : 'Nombre';
  $('cliente').placeholder = op ? 'Opcional' : 'Obligatorio';
}
function aplicarMesas(suc) {
  mesasSuc = Array.isArray(suc.mesas) ? suc.mesas : [];
  modoMesa = suc.mesa || 'opcional';
  campoMesa.poner({ mesas: mesasSuc, zonas: suc.zonas, plano: suc.plano }, 'Elige tu mesa…');
  const deLaDireccion = new URLSearchParams(location.search).get('mesa');   // QR de una mesa: /…?mesa=ID
  if (deLaDireccion && mesasSuc.some((m) => String(m.id) === deLaDireccion)) { $('mesa').value = deLaDireccion; campoMesa.refrescar(); }
  actualizarMesaCliente();
}
function aplicarTipos(suc) {
  modalidadesOk = Array.isArray(suc.modalidades) && suc.modalidades.length ? suc.modalidades : ['aqui', 'llevar', 'recoger'];
  mixtoOk = suc.mixto === true;
  fijarModalidad(modalidadesOk.includes(modalidad) ? modalidad : modalidadesOk[0]);
  aplicarMesas(suc);
}
function aplicarPago(suc) {
  const p = suc.pago;
  CLABE_TRANSFERENCIA = p ? p.clabe : '';
  const caja = document.getElementById('clabe');
  if (caja) caja.textContent = CLABE_TRANSFERENCIA.replace(/(\d{4})(?=\d)/g, '$1 ');
  $('transferencias').hidden = !p;
  $('sin-pago').hidden = !!p;
  for (const [id, valor] of [['transf-benef', p && p.beneficiario], ['transf-inst', p && p.institucion]]) {
    $(id).hidden = !valor;
    if (valor) $(id).querySelector('span').textContent = valor;
  }
}
function fijarModalidad(m) {
  modalidad = m;
  $('tel-nota').textContent = m === 'recoger' ? '(obligatorio para recoger)' : '(opcional)';
  $('telefono').placeholder = m === 'recoger' ? 'Obligatorio · 10 dígitos, ej. 322 123 4567' : '10 dígitos, ej. 322 123 4567';
  if (typeof actualizarEspera === 'function') actualizarEspera();
  if (typeof actualizarMesaCliente === 'function') actualizarMesaCliente();
  if (typeof pintarTipo === 'function') pintarTipo();
}

/* Tipo de pedido por plato: los tres botones se aplican al PLATO seleccionado.
   - Si todos los platos son iguales, el pedido entero es de ese tipo.
   - Si hay unos para comer aquí y otros para llevar, el pedido va en «comer aquí» (cocina) y esos platos se marcan «para llevar».
   - «Recoger» es de todo el pedido: se bloquea cuando hay mezcla. */
const baseMod = () => (destino ? destino.modalidad : modalidad);
const modDePlato = (n) => (mixtoOk && baseMod() === 'aqui' && platosLlevar.has(n) ? 'llevar' : baseMod());
const platosEnUso = () => [...new Set([...carrito.map((l) => l.plato), platoActual])].sort((a, b) => a - b);
const hayMezcla = () => !destino && modalidad === 'aqui' && platosLlevar.size > 0;
function normalizarTipo() {
  if (destino) return;
  const con = new Set(carrito.map((l) => l.plato));
  for (const n of [...platosLlevar]) if (!con.has(n) && n !== platoActual) platosLlevar.delete(n);
  if (modalidad === 'aqui' && con.size > 0 && [...con].every((n) => platosLlevar.has(n))) { platosLlevar.clear(); fijarModalidad('llevar'); }
}
function elegirTipo(m) {
  const n = platoActual;
  if (destino) {   // pedido ya levantado: solo se decide por plato entre «aquí» y «para llevar»
    if (!mixtoPosible() || m === 'recoger') return;
    if (m === 'llevar') platosLlevar.add(n); else platosLlevar.delete(n);
    pintarCarrito();
    return;
  }
  if (m === 'recoger') { if (hayMezcla()) return; platosLlevar.clear(); fijarModalidad('recoger'); pintarCarrito(); return; }
  const platos = platosEnUso();
  if (!mixtoOk || platos.length === 1 || modalidad === 'recoger') { platosLlevar.clear(); fijarModalidad(m); pintarCarrito(); return; }
  const mods = platos.map((x) => (x === n ? m : modDePlato(x)));
  platosLlevar.clear();
  if (mods.every((x) => x === 'aqui')) fijarModalidad('aqui');
  else if (mods.every((x) => x === 'llevar')) fijarModalidad('llevar');
  else { platos.forEach((x, i) => { if (mods[i] === 'llevar') platosLlevar.add(x); }); fijarModalidad('aqui'); }
  pintarCarrito();
}
function pintarTipo() {
  const bloque = $('tipo-bloque');
  const botones = [...bloque.querySelectorAll('.mod-btn')];
  const ver = destino ? mixtoPosible() : modalidadesOk.length > 1;
  bloque.hidden = !ver;
  // «Recoger» es de todo el pedido: con 2 o más platos desaparece (para recoger se hace otro pedido)
  const variosPlatos = platosEnUso().length > 1 && modalidad !== 'recoger';
  const visibles = botones.filter((b) => (destino ? b.dataset.mod !== 'recoger' : modalidadesOk.includes(b.dataset.mod) && !(b.dataset.mod === 'recoger' && variosPlatos)));
  for (const b of botones) {
    b.hidden = !visibles.includes(b);
    b.setAttribute('aria-pressed', String(b.dataset.mod === modDePlato(platoActual)));
    b.disabled = b.dataset.mod === 'recoger' && hayMezcla();
    b.title = b.disabled ? 'No se puede recoger si unos platos son para comer aquí y otros para llevar' : '';
  }
  bloque.querySelector('.modalidad').style.gridTemplateColumns = `repeat(${Math.max(1, visibles.length)}, minmax(0, 1fr))`;
  const varios = platosEnUso().length > 1;
  $('tipo-plato').hidden = !varios;
  $('tipo-plato').textContent = `Tipo del plato ${platoActual} (elige el plato en «Plato:» más abajo)`;
}
bloqueTipoListo();
function bloqueTipoListo() { document.querySelectorAll('#tipo-bloque .mod-btn').forEach((b) => b.addEventListener('click', () => elegirTipo(b.dataset.mod))); }
let platoActual = 1;
let enviando = false;
let temporizador = null;
const estadosVistos = new Map();  // clave -> último estado (para avisar cuando queda listo)

/* ------------------------------------------------------------------ */
/*  Almacenamiento (puede fallar en modo privado)                      */
/* ------------------------------------------------------------------ */
function leerClaves() {
  try {
    const v = JSON.parse(localStorage.getItem(claveLS(CLAVE_LS)) || '[]');
    return Array.isArray(v) ? v.filter((c) => /^[a-f0-9]{32}$/.test(c)).slice(-10) : [];
  } catch { return []; }
}
function guardarClaves() { try { localStorage.setItem(claveLS(CLAVE_LS), JSON.stringify(claves.slice(-10))); } catch { /* sin almacenamiento */ } }

function nuevaClave() {
  const b = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/*  Pantallas                                                          */
/* ------------------------------------------------------------------ */
function mostrar(vista) {
  for (const id of ['vista-cargando', 'vista-aviso', 'vista-pedido', 'vista-mis', 'vista-pagar']) $(id).hidden = id !== vista;
  $('subtitulo-texto').textContent = vista === 'vista-mis' ? 'Sigue tus pedidos' : vista === 'vista-pagar' ? 'Paga por transferencia' : 'Menú sucursal';
  if (vista === 'vista-mis') iniciarSondeo(); else detenerSondeo();
}

let temporizadorAviso;
function avisar(texto, esError = false) {
  const t = $('toast');
  t.textContent = texto;
  t.className = 'toast' + (esError ? ' error' : '');
  t.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { t.hidden = true; }, 3000);
}

function falloGrave(titulo, texto) {
  $('aviso-titulo').textContent = titulo;
  $('aviso-texto').textContent = texto;
  mostrar('vista-aviso');
}
$('aviso-reintentar').addEventListener('click', iniciar);

/* Sucursal: la fija la DIRECCIÓN del QR (/lavale/centro/). El cliente no puede cambiarla ni elegirla, para que nadie levante
   un pedido en una sucursal equivocada. Sin sucursal en la dirección solo se atiende si la empresa tiene una única sucursal. */
async function cargarNegocio() {
  const r = await pedir(API + 'negocio.php');
  sucursalesNegocio = r.sucursales;
  const deLaDireccion = sucursalDeLaDireccion();
  let suc = null;
  if (deLaDireccion) {
    suc = r.sucursales.find((s) => s.slug === deLaDireccion) || null;
    if (!suc) throw new Error('Esta sucursal no está disponible por ahora. Pregunta en el mostrador.');
  } else if (r.sucursales.length === 1) {
    suc = r.sucursales[0];
  } else {
    throw new Error('Escanea el código QR de tu sucursal para ver el menú y hacer tu pedido.');
  }
  const elegida = String(suc.id);
  mostrar('vista-cargando');
  sucursalPublica = Number(elegida);
  aplicarPestanas(suc);
  aplicarTipos(suc);
  aplicarPago(suc);
  aplicarModoPedidos();
  // Con varias sucursales se muestra, fija y bien visible, en cuál está el cliente (no es un selector).
  const fija = $('sucursal-fija');
  fija.hidden = r.sucursales.length < 2;
  fija.textContent = suc.nombre;   // solo el nombre dentro de la etiqueta; "Menú sucursal" va antes, como texto
}

/* Pestañas "Mi pedido" y "Pagar": cada sucursal puede ocultarlas. Si se ocultan las dos, desaparece toda la barra
   (la de "Menú" sola no sirve de nada) y el menú sube hasta arriba. */
let verPedido = true, verPagar = true, verMenu = true;
function aplicarPestanas(suc) {
  verMenu = suc.ver_menu !== false;
  verPedido = suc.ver_pedido !== false;
  verPagar = suc.ver_pagar !== false && suc.transferencia !== false;   // sin pago por transferencia, la pestaña «Pagar» no tiene nada que mostrar
  const formas = $('formas-pago');
  if (formas) formas.textContent = suc.transferencia === false ? 'efectivo y tarjeta' : 'efectivo, transferencia y tarjeta';
  if (!verMenu && !verPedido && !verPagar) verMenu = true;   // por seguridad, nunca queda la pantalla vacía
  $('nav-menu').hidden = !verMenu;
  $('nav-pedido').hidden = !verPedido;
  $('nav-pagar').hidden = !verPagar;
  document.querySelector('.cliente-nav').hidden = [verMenu, verPedido, verPagar].filter(Boolean).length < 2;   // con una sola pestaña, la barra no sirve
}

/* Si en esta sucursal el cliente no puede pedir (lo desactivó el dueño o el gerente), la pantalla queda en "solo menú":
   se ven los productos, pero sin carrito ni botones para agregar. El servidor también rechaza esos pedidos. */
function aplicarModoPedidos() {
  const suc = sucursalesNegocio.find((s) => s.id === sucursalPublica);
  pedidosActivos = (!suc || suc.pedidos !== false) && verMenu;   // sin la pestaña Menú no se arman pedidos
  document.body.classList.toggle('solo-menu', !pedidosActivos);
  $('subtitulo-texto').textContent = 'Menú sucursal';
}

async function iniciar() {
  mostrar('vista-cargando');
  try {
    await cargarNegocio();
    await cargarMenu();
    claves = leerClaves();
    try { const b = JSON.parse(localStorage.getItem(claveLS('taqueria_buscados')) || '[]'); buscados = Array.isArray(b) ? b.filter((x) => x && typeof x.q === 'string' && x.q).slice(0, 5) : []; } catch { buscados = []; }
    if (verPedido && (claves.length || buscados.length)) {   // sin la pestaña "Mi pedido" no se abre el seguimiento
      await refrescar();
      if (ordenes.length || ordenesBuscadas.length) { mostrar('vista-mis'); pintarMis(); return; }
    }
    irANuevoPedido();
  } catch (err) {
    falloGrave('No pudimos abrir el menú', err.message);
  }
}

function recordarContacto() {
  try {
    const c = JSON.parse(localStorage.getItem(claveLS('taqueria_contacto')) || 'null');
    if (c) { if (!$('cliente').value) $('cliente').value = c.nombre || ''; if (!$('telefono').value) $('telefono').value = c.telefono || ''; $('promos-fila').hidden = $('telefono').value.trim() === ''; }
  } catch { /* sin almacenamiento */ }
}
/* Concepto de la transferencia: se busca con el número de pedido (o se llena solo con el pedido propio) */
function fijarConcepto(nombre) {
  const res = document.getElementById('transf-concepto');
  if (!res || !nombre) return;
  res.textContent = nombre;
  document.getElementById('concepto-res').hidden = false;
}
function guardarContacto(nombre, telefono) { try { localStorage.setItem(claveLS('taqueria_contacto'), JSON.stringify({ nombre, telefono })); } catch { /* nada */ } }

function irANuevoPedido() {
  platosLlevar.clear();
  fijarModalidad(modalidadesOk.includes('aqui') ? 'aqui' : modalidadesOk[0]);
  cuando.fijar(null);
  destino = null;
  claveNueva = null;
  carrito = [];
  platoActual = 1;
  $('pedido-error').textContent = '';
  recordarContacto();
  pintarCarrito();
  if (!verMenu) {   // esta sucursal ocultó el menú: se abre la primera pestaña que sí muestra
    if (verPedido) { mostrar('vista-mis'); pintarMis(); } else mostrar('vista-pagar');
    return;
  }
  mostrar('vista-pedido');
}

/* ------------------------------------------------------------------ */
/*  Menú                                                               */
/* ------------------------------------------------------------------ */
async function cargarMenu() {
  const r = await pedir(API + 'productos.php');
  menu = r.menu;
  if (categoriaActiva >= menu.length) categoriaActiva = 0;
  pintarCategorias();
  pintarProductos();
}

function pintarCategorias() {
  const caja = $('cats');
  caja.replaceChildren();
  menu.forEach((c, i) => {
    const b = el('button', 'cat', c.categoria);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === categoriaActiva));
    b.addEventListener('click', () => { categoriaActiva = i; pintarCategorias(); pintarProductos(); });
    caja.append(b);
  });
}

function pintarProductos() {
  const caja = $('productos');
  caja.replaceChildren();
  if (menu.length === 0) { caja.append(el('p', 'vacio', 'Por ahora no hay productos disponibles.')); return; }
  for (const p of menu[categoriaActiva].productos) {
    const b = el('button', 'pr' + (p.agotado ? ' agotado' : ''));
    b.type = 'button';
    if (p.agotado) b.disabled = true;
    const foto = el('div', 'pr-foto');
    if (p.foto) {
      const img = document.createElement('img');
      img.src = p.foto; img.alt = ''; img.loading = 'lazy';
      foto.append(img);
    } else {
      foto.classList.add('vacia');
      foto.append(el('span', 'sin-foto', '🌮'));
    }
    const info = el('div', 'pr-info');
    info.append(el('span', 'pr-nombre', p.nombre));
    if (p.porcion) info.append(el('span', 'pr-meta', p.porcion));
    // Descripción (2 líneas); si no cabe completa aparece "Ver más ›", que abre el detalle del platillo
    const desc = p.descripcion ? el('span', 'pr-desc', p.descripcion) : null;
    if (desc) info.append(desc);
    const verMas = desc ? el('button', 'pr-ver-mas', 'Ver más ›') : null;
    if (verMas) { verMas.type = 'button'; verMas.hidden = true; info.append(verMas); verMas.addEventListener('click', (ev) => { ev.stopPropagation(); abrirDetalle(p); }); }
    info.append(el('span', 'pr-precio', dinero.format(p.precio)));
    if (p.agotado) info.append(el('span', 'pr-agotado', 'Agotado por hoy'));
    else if (p.extras.length) info.append(el('span', 'pr-mas', 'con opciones ›'));
    b.append(foto, info);
    mantenerPresionado(b, () => abrirDetalle(p));   // mantener presionado = ver el platillo en grande (foto y descripción)
    b.addEventListener('click', (ev) => {
      if (ignorarClic) return;   // venía de un presionado largo: ya se abrió el detalle, no se agrega
      if (!pedidosActivos) { abrirDetalle(p); return; }     // solo se puede ver el menú: un toque muestra el detalle del platillo
      const desdeFoto = !!ev.target.closest('.pr-foto');
      if (p.extras.length && (!desdeFoto || p.pedir_opciones)) abrirOpciones(p);
      else { agregarLinea(p, [], 1, ''); avisar(`${p.nombre} agregado`); }
    });
    caja.append(b);
    // ¿La descripción quedó cortada? Entonces se muestra "Ver más ›" (se mide ya con la tarjeta en pantalla)
    if (desc) requestAnimationFrame(() => { verMas.hidden = !(desc.scrollHeight > desc.clientHeight + 1); });
  }
}

/* Detalle del platillo: foto grande, descripción completa y, si hay pedidos activos, botón para agregarlo */
const dlgDetalle = $('dlg-detalle');
function abrirDetalle(p) {
  $('dt-titulo').textContent = p.nombre;
  $('dt-meta').textContent = p.porcion || '';
  $('dt-meta').hidden = !p.porcion;
  $('dt-desc').textContent = p.descripcion || '';
  $('dt-desc').hidden = !p.descripcion;
  $('dt-precio').textContent = dinero.format(p.precio);
  const img = $('dt-foto');
  if (p.foto) { img.src = p.foto; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  const puede = pedidosActivos && !p.agotado;
  $('dt-agregar').hidden = !puede;
  $('dt-agregar').onclick = () => {
    dlgDetalle.close();
    abrirOpciones(p);   // misma ventana para todo: cantidad ＋/−, extras si los hay, y sigue abierta para agregar más (se sale con la ✕)
  };
  dlgDetalle.showModal();
}
$('dt-cerrar').addEventListener('click', () => dlgDetalle.close());

/* Hoja de opciones */
const dlgOpciones = $('dlg-opciones');
let opProducto = null, opCantidad = 1;

/** Platillos con opción obligatoria (ej. burrito): texto de lo que falta elegir ('' si ya está completo). */
function faltaOpcion(p, ids) {
  if (!p.obligatorias || !p.extras.length) return '';
  const g = p.grupo_obligatorio;
  const validas = g ? p.extras.filter((x) => (x.grupo || 'Otros') === g) : p.extras;
  if (!validas.length || ids.some((id) => validas.some((x) => x.id === id))) return '';
  return g ? `Elige una opción de «${g}».` : 'Elige una opción.';
}
function pintarRequisito(p) {
  const r = $('op-requisito');
  r.textContent = p.obligatorias && p.extras.length ? (p.grupo_obligatorio ? `Obligatorio: elige una opción de «${p.grupo_obligatorio}».` : 'Obligatorio: elige una opción.') : '';
  r.hidden = !r.textContent;
  $('op-error').textContent = '';
}
$('op-extras').addEventListener('change', () => { $('op-error').textContent = ''; });

function abrirOpciones(p) {
  opProducto = p; opCantidad = 1;
  $('op-agregados').hidden = true; $('op-agregados').replaceChildren();
  pintarRequisito(p);
  $('op-cantidad').textContent = '1';
  $('op-titulo').textContent = p.nombre;
  $('op-precio').textContent = dinero.format(p.precio) + (p.porcion ? ` · ${p.porcion}` : '');
  $('op-notas').value = '';
  $('op-desc').textContent = p.descripcion || '';
  $('op-desc').hidden = !p.descripcion;
  const caja = $('op-extras');
  caja.replaceChildren();
  const grupos = new Map();
  for (const x of p.extras) {
    const g = x.grupo || 'Otros';
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  for (const [g, lista] of grupos) {
    if (grupos.size > 1) caja.append(el('p', 'grupo-titulo', g));
    for (const x of lista) {
      const f = el('label', 'opcion');
      const c = document.createElement('input');
      c.type = 'checkbox'; c.value = String(x.id);
      f.append(c, el('span', '', x.nombre), el('span', 'precio-extra', x.precio > 0 ? `+${dinero.format(x.precio)}` : ''));
      caja.append(f);
    }
  }
  limitarCarnes(caja, p, p.extras);
  $('op-extras-caja').hidden = p.extras.length === 0;
  dlgOpciones.showModal();
}
$('op-menos').addEventListener('click', () => { opCantidad = Math.max(1, opCantidad - 1); $('op-cantidad').textContent = String(opCantidad); });
$('op-mas').addEventListener('click', () => { opCantidad = Math.min(50, opCantidad + 1); $('op-cantidad').textContent = String(opCantidad); });
$('op-cancelar').addEventListener('click', () => dlgOpciones.close());
$('form-opciones').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const ids = [...$('op-extras').querySelectorAll('input:checked')].map((c) => Number(c.value));
  const falta = faltaOpcion(opProducto, ids);
  if (falta) { $('op-error').textContent = falta; return; }
  const elegidos = opProducto.extras.filter((x) => ids.includes(x.id));
  const notas = $('op-notas').value.trim();
  agregarLinea(opProducto, elegidos, opCantidad, notas);
  // La ventana NO se cierra: se anota lo agregado arriba y se limpia todo para pedir otra variante (se sale con la ✕).
  const lista = $('op-agregados');
  lista.hidden = false;
  lista.append(el('li', '', `✔ ${opCantidad} × ${opProducto.nombre}` + (elegidos.length ? ' · ' + elegidos.map(nombreExtra).join(', ') : '') + (notas ? ` · “${notas}”` : '') + ' agregado'));
  opCantidad = 1; $('op-cantidad').textContent = '1';
  $('op-notas').value = '';
  $('op-error').textContent = '';
  for (const c of $('op-extras').querySelectorAll('input[type=checkbox]')) { c.checked = false; c.disabled = false; }   // también rehabilita las bloqueadas por el máximo de carnes
  dlgOpciones.scrollTop = 0;
});

/* ------------------------------------------------------------------ */
/*  Carrito (con platos)                                               */
/* ------------------------------------------------------------------ */
const platosBase = () => (destino ? Math.max(1, ...destino.items.map((i) => i.plato)) : 1);
const maxPlato = () => Math.max(platoActual, platosBase(), ...carrito.map((l) => l.plato));
const claveLinea = (l) => `${l.plato}|${l.producto.id}|${l.extras.map((x) => x.id).sort((a, b) => a - b).join(',')}|${l.notas}`;
const precioLinea = (l) => (l.producto.precio + l.extras.reduce((s, x) => s + x.precio, 0)) * l.cantidad;

function agregarLinea(producto, extras, cantidad, notas) {
  const nueva = { producto, extras, cantidad, notas, plato: platoActual };
  const igual = carrito.find((l) => claveLinea(l) === claveLinea(nueva));
  if (igual) igual.cantidad = Math.min(50, igual.cantidad + cantidad); else carrito.push(nueva);
  pintarCarrito();
}

function pintarPlatos() {
  const caja = $('platos');
  caja.replaceChildren(el('span', 'platos-et', 'Plato:'));
  for (let n = 1; n <= maxPlato(); n++) {
    const b = el('button', 'btn plato-chip' + (n === platoActual ? ' activo' : ''), String(n));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(n === platoActual));
    b.addEventListener('click', () => { platoActual = n; pintarCarrito(); });
    caja.append(b);
  }
  if (maxPlato() < 20) {
    const mas = el('button', 'btn plato-chip', '＋ Plato');
    mas.type = 'button';
    mas.addEventListener('click', () => { platoActual = maxPlato() + 1; pintarCarrito(); });
    caja.append(mas);
  }
}

/* Cierra la hoja del pedido (celular) y lleva al inicio del menú */
function irAlMenu() {
  $('carrito').classList.remove('abierto');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pintarCarrito() {
  normalizarTipo();
  const caja = $('lineas');
  caja.replaceChildren();
  pintarPlatos();
  if (carrito.length === 0) {
    const vacio = el('div', 'carrito-vacio');
    const ir = el('button', 'btn principal grande', '🌮 Ver el menú y agregar platillos');
    ir.type = 'button';
    ir.addEventListener('click', irAlMenu);
    vacio.append(el('p', 'vacio-titulo', 'Tu pedido está vacío'), el('p', 'ayuda', 'Elige tus platillos del menú; toca uno cada vez que quieras sumar otro.'), ir);
    caja.append(vacio);
  }
  const hayVarios = maxPlato() > 1;
  const mezcla = (destino ? destino.modalidad === 'aqui' && mixtoOk : modalidad === 'aqui') && platosLlevar.size > 0;
  let ultimo = 0;
  for (const l of [...carrito].sort((a, b) => a.plato - b.plato)) {
    if (hayVarios && l.plato !== ultimo) {
      const piezas = carrito.filter((x) => x.plato === l.plato).reduce((n, x) => n + x.cantidad, 0);
      caja.append(el('h3', 'plato-titulo' + (esLlevar(l.plato) ? ' llevar' : ''), `Plato ${l.plato} · ${piezas} pza` + (esLlevar(l.plato) ? ' · 🥡 PARA LLEVAR' : (mezcla ? ' · 🍽 PARA COMER AQUÍ' : ''))));
    }
    ultimo = l.plato;
    const fila = el('div', 'linea');
    fila.append(el('span', 'linea-nombre', l.producto.nombre), el('span', 'linea-precio', dinero.format(precioLinea(l))));
    const detalle = [...l.extras.map(nombreExtra), ...(l.notas ? [`“${l.notas}”`] : [])].join(' · ');
    if (detalle) fila.append(el('span', 'linea-detalle', detalle));
    const ctl = el('div', 'linea-ctl');
    const menos = el('button', 'btn', '−'); menos.type = 'button'; menos.setAttribute('aria-label', 'Menos');
    const num = el('output', '', String(l.cantidad));
    const mas = el('button', 'btn', '＋'); mas.type = 'button'; mas.setAttribute('aria-label', 'Más');
    const quitar = el('button', 'btn peligro quitar', 'Quitar'); quitar.type = 'button';
    menos.addEventListener('click', () => { if (l.cantidad > 1) l.cantidad--; else carrito = carrito.filter((x) => x !== l); pintarCarrito(); });
    mas.addEventListener('click', () => { l.cantidad = Math.min(50, l.cantidad + 1); pintarCarrito(); });
    quitar.addEventListener('click', () => { carrito = carrito.filter((x) => x !== l); pintarCarrito(); });
    ctl.append(menos, num, mas, quitar);
    fila.append(ctl);
    caja.append(fila);
  }
  const total = dinero.format(carrito.reduce((s, l) => s + precioLinea(l), 0));
  const piezas = carrito.reduce((s, l) => s + l.cantidad, 0);
  $('total').textContent = total;
  actualizarEspera();
  $('barra-total').textContent = total;
  $('barra-texto').textContent = piezas ? `Ver tu pedido (${piezas})` : 'Ver tu pedido';
  $('datos-pedido').hidden = !!destino;
  $('campos-cliente').hidden = !!destino;
  pintarTipo();
  $('agregando').hidden = !destino;
  $('ver-mis').hidden = !!destino || ordenes.length === 0;
  $('ver-mis-n').textContent = String(ordenes.length);
  $('btn-levantar').textContent = destino ? 'Agregar a mi pedido' : 'Enviar pedido';
  if (destino) $('agregando-texto').textContent = `Agregando al pedido #${destino.numero} de ${destino.cliente}`;
}

$('telefono').addEventListener('input', () => { $('promos-fila').hidden = $('telefono').value.trim() === ''; });
$('ver-aviso').addEventListener('click', (ev) => { ev.preventDefault(); $('dlg-aviso').showModal(); });
$('aviso-cerrar').addEventListener('click', () => $('dlg-aviso').close());
$('btn-vaciar').addEventListener('click', async () => { if (carrito.length === 0 || await confirmar('¿Vaciar tu pedido?', { si: 'Vaciar', peligro: true })) { carrito = []; platosLlevar.clear(); platoActual = destino ? platosBase() : 1; pintarCarrito(); } });
$('barra-carrito').addEventListener('click', () => $('carrito').classList.add('abierto'));
$('btn-cerrar-carrito').addEventListener('click', () => $('carrito').classList.remove('abierto'));
$('agregando-volver').addEventListener('click', verMisPedidos);
$('ver-mis').addEventListener('click', verMisPedidos);

function verMisPedidos() {
  destino = null; carrito = [];
  $('carrito').classList.remove('abierto');
  mostrar('vista-mis');
  pintarMis();
  refrescar();
}

const itemsParaEnviar = () => carrito.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad, extras: l.extras.map((x) => x.id), notas: l.notas, plato: l.plato, llevar: esLlevar(l.plato) }));

$('btn-levantar').addEventListener('click', async () => {
  if (enviando) return;
  const error = $('pedido-error');
  error.textContent = '';
  if (carrito.length === 0) { error.textContent = 'Agrega al menos un producto.'; return; }
  const nombre = $('cliente').value.trim();
  const telefono = $('telefono').value.trim();
  if (!destino && cuando.incompleto()) { error.textContent = 'Completa la hora del pedido agendado (hora, minutos y AM/PM) o quita la agenda.'; return; }
  if (!destino && modalidad === 'recoger' && !telefono) { error.textContent = 'Para recoger tu pedido escribe tu teléfono de 10 dígitos (te avisamos cuando esté listo).'; $('telefono').focus(); return; }
  if (!destino && telefono && !/^(\+?52)?\D*(\d\D*){10}$/.test(telefono)) { error.textContent = 'El teléfono debe tener 10 dígitos' + (modalidad === 'recoger' ? '.' : ' (o déjalo vacío).'); $('telefono').focus(); return; }
  if (!destino && mesaObligatoria() && !$('mesa').value) { error.textContent = 'Elige tu mesa.'; $('mesa').focus(); return; }
  if (!destino && !nombre && !nombreOpcional()) { error.textContent = modalidad === 'aqui' ? 'Elige tu mesa o escribe tu nombre.' : 'Escribe tu nombre para entregarte tu pedido.'; $('cliente').focus(); return; }

  enviando = true;
  const boton = $('btn-levantar');
  boton.disabled = true;
  boton.textContent = 'Enviando…';
  try {
    if (destino) {
      await enviarJson(API + 'cliente/pedido.php', { accion: 'agregar', clave: destino.clave, items: itemsParaEnviar() });
      avisar('Agregamos tus productos');
    } else {
      // La clave se crea una sola vez: si el envío se repite por mala señal, el servidor devuelve el mismo pedido.
      if (!claveNueva) claveNueva = nuevaClave();
      const creado = await enviarJson(API + 'cliente/pedido.php', {
        accion: 'crear', clave: claveNueva, nombre_cliente: nombre, modalidad, mesa_id: mesaVisible() && $('mesa').value ? Number($('mesa').value) : undefined, ...cuando.datos(), telefono, acepta_promos: !!telefono && $('acepta-promos').checked, notas: $('notas-orden').value.trim(), web: $('web').value, items: itemsParaEnviar(),
      });
      if (creado.orden && creado.orden.estimado != null) avisar(`¡Pedido enviado! Tiempo de espera: unos ${creado.orden.estimado} min`);
      guardarContacto(nombre, telefono);
      if (!claves.includes(claveNueva)) claves.push(claveNueva);
      guardarClaves();
      $('notas-orden').value = '';
      // el teléfono y el nombre se quedan para el siguiente pedido
    }
    destino = null; claveNueva = null; carrito = []; platosLlevar.clear(); platoActual = 1;
    $('carrito').classList.remove('abierto');
    await refrescar();
    mostrar('vista-mis');
    pintarMis();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    enviando = false;
    boton.disabled = false;
    boton.textContent = destino ? 'Agregar a mi pedido' : 'Enviar pedido';
  }
});

/* ------------------------------------------------------------------ */
/*  Mis pedidos: seguimiento en tiempo real                            */
/* ------------------------------------------------------------------ */
const TEXTOS = {
  nueva: ['Recibimos tu pedido', 'En un momento empezamos a prepararlo.'],
  programado: ['Tu pedido está agendado', 'Lo empezamos a preparar poco antes para que esté fresco a la hora que pediste.'],
  preparando: ['Estamos preparando tu pedido', 'Te avisamos aquí mismo cuando esté listo.'],
  lista: ['¡Tu pedido está listo!', 'Pasa por él. Te lo entregamos con tu nombre.'],
  entregada: ['Entregado. ¡Buen provecho!', 'Gracias por pedir con nosotros.'],
  cancelada: ['Pedido cancelado', 'Si fue un error, acércate a caja.'],
};

function iniciarSondeo() { detenerSondeo(); temporizador = suscribirCambios(refrescar, { respaldoMs: 4000, url: API + 'eventos' }); }
function detenerSondeo() { if (temporizador) temporizador.detener(); temporizador = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('vista-mis').hidden) refrescar(); });

/* Pedidos consultados por número + nombre (solo lectura): se vuelven a consultar en cada ciclo */
async function refrescarBuscados() {
  const vistas = [];
  const vigentes = [];
  for (const b of buscados) {
    try {
      const r = await pedir(API + 'cliente/pedido.php?buscar=' + encodeURIComponent(b.q));
      for (const o of r.ordenes) vistas.push({ ...o, buscaKey: b.q });
      vigentes.push(b);
    } catch (e) {
      if (e.status === 404 || /No encontramos/.test(e.message || '')) continue;   // ya no existe: se olvida
      vigentes.push(b);                                                           // sin conexión: se conserva
      vistas.push(...ordenesBuscadas.filter((x) => x.buscaKey === b.q));
    }
  }
  buscados = vigentes;
  ordenesBuscadas = vistas;
  try { localStorage.setItem(claveLS('taqueria_buscados'), JSON.stringify(buscados)); } catch { /* sin almacenamiento */ }
}

async function refrescar() {
  await refrescarBuscados();
  if (claves.length === 0) { ordenes = []; if (!$('vista-mis').hidden) pintarMis(); return; }
  try {
    const r = await pedir(API + 'cliente/pedido.php?claves=' + claves.join(','));
    ordenes = r.ordenes;
    // Las claves que el servidor ya no conoce se olvidan
    const conocidas = new Set(ordenes.map((o) => o.clave));
    if (claves.some((c) => !conocidas.has(c))) { claves = claves.filter((c) => conocidas.has(c)); guardarClaves(); }
    for (const o of ordenes) {
      const antes = estadosVistos.get(o.clave);
      if (antes && antes !== 'lista' && o.estado === 'lista') {
        try { navigator.vibrate && navigator.vibrate([200, 100, 200, 100, 300]); } catch { /* sin vibración */ }
        document.title = '✅ ¡Tu pedido está listo!';
        avisar(`¡El pedido #${o.numero} de ${o.cliente} está listo!`);
      }
      estadosVistos.set(o.clave, o.estado);
    }
    if (!$('vista-mis').hidden) pintarMis();
  } catch { /* sin conexión: se reintenta en el siguiente ciclo */ }
}

function pintarMis() {
  const todos = [...ordenes, ...ordenesBuscadas];
  const activos = todos.filter((o) => !TERMINADOS.includes(o.estado));
  const fin = todos.filter((o) => TERMINADOS.includes(o.estado));
  $('mis-vacio').hidden = todos.length > 0;
  $('mis-activos').replaceChildren(...activos.map(tarjetaPedido));
  $('mis-fin').replaceChildren(...fin.map(tarjetaPedido));
  $('mis-activos-t').hidden = activos.length === 0;
  $('mis-fin-t').hidden = fin.length === 0;
}

function tarjetaPedido(o) {
  const c = el('article', 'tarjeta seg-orden');
  fijarConcepto(o.cliente);
  c.dataset.clave = o.clave;
  const [titulo, texto] = TEXTOS[o.programado ? 'programado' : o.estado] || ['', ''];
  const banner = el('div', 'estado-banner ' + (o.programado ? 'nueva' : o.estado));
  banner.append(el('p', 'estado-titulo', titulo), el('p', 'estado-texto', texto));
  c.append(banner);

  const ident = el('div', 'seg-ident');
  const izq = el('div');
  izq.append(el('p', 'seg-nombre', o.cliente), el('p', 'ayuda', `${infoMod(o.modalidad).largo} · Pedido a las ${hora12(o.hora)}` + (o.para ? ` · 🕒 Para las ${hora12(o.para)}` : '')));
  ident.append(izq, el('div', 'seg-num', '#' + o.numero));
  c.append(ident);

  const total = o.items.length;
  const listos = o.items.filter((i) => i.estado === 'listo').length;
  const entregado = o.estado === 'entregada';
  const prog = el('div', 'seg-progreso');
  const rel = el('div', 'seg-relleno');
  rel.style.width = `${entregado ? 100 : total ? Math.round((listos / total) * 100) : 0}%`;
  prog.append(rel);
  c.append(prog, el('p', 'seg-cuenta', entregado ? 'Todo entregado' : `${listos} de ${total} listos`));
  if (o.estimado != null && !o.programado) c.append(el('p', 'estimado', `⏱ Tiempo estimado: unos ${o.estimado} min`));
  if (o.delante > 0) c.append(el('p', 'ayuda', o.delante === 1 ? 'Hay 1 pedido antes que el tuyo.' : `Hay ${o.delante} pedidos antes que el tuyo.`));

  const items = el('div', 's-items');
  const varios = new Set(o.items.map((i) => i.plato)).size > 1;
  let platoVisto = 0;
  for (const i of o.items) {
    if (varios && i.plato !== platoVisto) { platoVisto = i.plato; items.append(el('h4', 'plato-titulo', `Plato ${i.plato}`)); }
    items.append(filaItem(o, i));
  }
  c.append(items);

  const tot = el('div', 'total-fila');
  tot.append(el('span', '', 'Total'), el('strong', '', dinero.format(o.total)));
  c.append(tot, el('p', 'ayuda', o.pagado ? 'Pagado ✓' : 'El pago se hace en caja (efectivo, transferencia o tarjeta).'));
  const err = el('p', 'msg-error');
  err.setAttribute('role', 'alert');
  c.append(err);

  const acc = el('div', 'acciones-dialogo');
  if (o.editable) {
    // En modo solo menú no se ofrece "Agregar más" (el cliente ya no arma pedidos desde el QR).
    if (pedidosActivos) {
      const ag = el('button', 'btn principal grande', '＋ Agregar más'); ag.type = 'button';
      ag.addEventListener('click', () => agregarAPedido(o));
      acc.append(ag);
    }
    if (o.items.every((i) => i.estado === 'pendiente')) {
      const ca = el('button', 'btn peligro', 'Cancelar pedido'); ca.type = 'button';
      ca.addEventListener('click', async () => { if (await confirmar('¿Cancelar este pedido?', { si: 'Cancelar pedido', no: 'Volver', peligro: true })) await accion(o, err, { accion: 'cancelar' }); });
      acc.append(ca);
    }
  } else {
    const q = el('button', 'btn', 'Quitar de mi lista'); q.type = 'button';
    q.addEventListener('click', () => {
      if (o.soloLectura) { buscados = buscados.filter((b) => b.q !== o.buscaKey); ordenesBuscadas = ordenesBuscadas.filter((x) => x.buscaKey !== o.buscaKey); try { localStorage.setItem(claveLS('taqueria_buscados'), JSON.stringify(buscados)); } catch { /* nada */ } pintarMis(); return; }
      claves = claves.filter((x) => x !== o.clave); guardarClaves(); ordenes = ordenes.filter((x) => x.clave !== o.clave); pintarMis();
    });
    acc.append(q);
  }
  c.append(acc);
  return c;
}

function filaItem(o, i) {
  const f = el('div', 'estado-' + i.estado + ' s-item');
  const cab = el('div', 's-item-cab');
  cab.append(el('span', 's-item-nombre', `${i.cantidad}× ${i.nombre}`), el('span', 'estado-chip', o.estado === 'entregada' ? 'Entregado' : ESTADO_ITEM[i.estado]));
  f.append(cab);
  const detalle = [...i.extras, ...(i.notas ? [`“${i.notas}”`] : [])].join(' · ');
  if (detalle) f.append(el('p', 'linea-detalle', detalle));
  if (o.editable) {
    const ctl = el('div', 'linea-ctl');
    const menos = el('button', 'btn', '−'); menos.type = 'button'; menos.disabled = i.bloqueado || i.cantidad <= 1;
    menos.setAttribute('aria-label', 'Una pieza menos');
    const num = el('output', '', String(i.cantidad));
    const mas = el('button', 'btn', '＋'); mas.type = 'button'; mas.disabled = i.cantidad >= 50;
    mas.setAttribute('aria-label', 'Una pieza más');
    const dondeError = () => f.closest('.seg-orden').querySelector('.msg-error');
    menos.addEventListener('click', () => accion(o, dondeError(), { accion: 'cantidad', item_id: i.id, cantidad: i.cantidad - 1 }));
    mas.addEventListener('click', () => accion(o, dondeError(), { accion: 'cantidad', item_id: i.id, cantidad: i.cantidad + 1 }));
    ctl.append(menos, num, mas);
    if (!i.bloqueado) {
      const q = el('button', 'btn peligro quitar', 'Quitar'); q.type = 'button';
      q.addEventListener('click', async () => { if (await confirmar(`¿Quitar ${i.nombre} de tu pedido?`, { si: 'Quitar', peligro: true })) accion(o, dondeError(), { accion: 'quitar', item_id: i.id }); });
      ctl.append(q);
    }
    f.append(ctl);
    if (i.bloqueado) f.append(el('p', 's-bloqueo', '🔒 Ya se está preparando o ya está listo: puedes pedir más, pero para bajarlo o quitarlo acércate a caja.'));
  }
  return f;
}

async function accion(o, zonaError, cuerpo) {
  if (zonaError) zonaError.textContent = '';
  try {
    await enviarJson(API + 'cliente/pedido.php', { ...cuerpo, clave: o.clave });
  } catch (err) {
    if (zonaError) zonaError.textContent = err.message;
  }
  await refrescar();
}

function agregarAPedido(o) {
  if (!pedidosActivos) { avisar('Por ahora los pedidos se toman en el mostrador.', true); return; }
  destino = o;
  carrito = [];
  platosLlevar.clear(); (o.items || []).filter((i) => i.llevar).forEach((i) => platosLlevar.add(i.plato));
  platoActual = platosBase();
  $('pedido-error').textContent = '';
  pintarCarrito();
  mostrar('vista-pedido');
}

$('mis-nuevo').addEventListener('click', () => {
  document.title = 'Pide aquí · ' + (nombreNegocio || 'Comandia');
  irANuevoPedido();
});

function hora12(hhmm) {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

iniciar();


/* Transferencias: copiar la CLABE y el concepto con un toque; el concepto se busca por número de pedido */
async function copiarTexto(texto, zona, boton) {
  let ok = false;
  try { await navigator.clipboard.writeText(texto); ok = true; } catch { /* sin permiso: se usa el método de respaldo */ }
  if (!ok) {
    const r = document.createRange();
    r.selectNodeContents(zona);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  boton.textContent = ok ? '✓ Copiado' : 'Selecciónalo y copia';
  setTimeout(() => { boton.textContent = 'Copiar'; }, 2200);
}
(function () {
  const caja = document.getElementById('clabe');
  if (!caja) return;
  caja.textContent = CLABE_TRANSFERENCIA.replace(/(\d{4})(?=\d)/g, '$1 ');   // se ve en grupos, se copia sin espacios
  document.getElementById('clabe-copiar').addEventListener('click', (ev) => copiarTexto(CLABE_TRANSFERENCIA, caja, ev.currentTarget));
  const concepto = document.getElementById('transf-concepto');
  document.getElementById('concepto-copiar').addEventListener('click', (ev) => copiarTexto(concepto.textContent, concepto, ev.currentTarget));
  const err = document.getElementById('concepto-error');
  document.getElementById('concepto-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const numero = document.getElementById('concepto-numero').value.replace(/\D/g, '');
    err.textContent = '';
    document.getElementById('concepto-res').hidden = true;
    if (!numero) { err.textContent = 'Escribe el número de tu pedido.'; return; }
    try {
      const r = await fetch(API + 'cliente/concepto.php?numero=' + encodeURIComponent(numero), { headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { err.textContent = d.mensaje || 'No pudimos buscar el pedido. Inténtalo de nuevo.'; return; }
      fijarConcepto(d.concepto);
    } catch { err.textContent = 'Sin conexión. Inténtalo de nuevo.'; }
  });
})();

/* ------------------------------------------------------------------ */
/*  Atajos (Menú / Mi pedido / Transferencia) y búsqueda de pedido     */
/* ------------------------------------------------------------------ */
function marcarNav() {
  $('nav-menu').classList.toggle('activo', !$('vista-pedido').hidden);
  $('nav-pedido').classList.toggle('activo', !$('vista-mis').hidden);
  $('nav-pagar').classList.toggle('activo', !$('vista-pagar').hidden);
}
new MutationObserver(marcarNav).observe(document.querySelector('main'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });

$('nav-menu').addEventListener('click', () => {
  if ($('vista-pedido').hidden) { if (!destino && carrito.length) mostrar('vista-pedido'); else irANuevoPedido(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('nav-pedido').addEventListener('click', async () => {
  if ($('vista-cargando').hidden === false) return;
  mostrar('vista-mis');
  pintarMis();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  refrescar();
});
$('nav-pagar').addEventListener('click', () => {
  if ($('vista-cargando').hidden === false) return;
  mostrar('vista-pagar');
  window.scrollTo({ top: 0 });
});

$('buscar-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('buscar-error');
  let q = $('buscar-texto').value.trim();
  if (/^#?\d+$/.test(q)) q = q.replace('#', '').replace(/^0+(?=\d)/, '');   // "#042" = "42"
  err.textContent = '';
  if (!q) { err.textContent = 'Escribe tu número de pedido o el nombre con el que lo pediste.'; return; }
  try {
    await pedir(API + 'cliente/pedido.php?buscar=' + encodeURIComponent(q));
  } catch (e) { err.textContent = e.message || 'No pudimos buscar el pedido.'; return; }
  if (!buscados.some((b) => b.q.toLowerCase() === q.toLowerCase())) buscados.push({ q });
  buscados = buscados.slice(-5);
  $('buscar-texto').value = '';
  await refrescar();
  pintarMis();
});

/* Las categorías (Tacos, Volcanes…) se quedan fijas justo debajo de la barra de secciones */
function medirNav() {
  const n = document.querySelector('.cliente-nav');
  if (n) document.documentElement.style.setProperty('--alto-nav', n.offsetHeight + 'px');
}
medirNav();
window.addEventListener('resize', medirNav);
window.addEventListener('load', medirNav);

/* En el menú, la barra de secciones se esconde al bajar (para ver más platillos) y reaparece al subir */
(function () {
  const nav = document.querySelector('.cliente-nav');
  if (!nav) return;
  let ultimo = window.scrollY;
  function ajustar() {
    const y = window.scrollY;
    const baja = y > ultimo + 6, sube = y < ultimo - 6;
    const enMenu = !$('vista-pedido').hidden;
    if (!enMenu || y < 80 || sube) document.body.classList.remove('nav-oculta');
    else if (baja) document.body.classList.add('nav-oculta');
    if (baja || sube) ultimo = y;
    document.documentElement.style.setProperty('--alto-nav', document.body.classList.contains('nav-oculta') ? '0px' : nav.offsetHeight + 'px');
  }
  window.addEventListener('scroll', ajustar, { passive: true });
  new MutationObserver(() => { document.body.classList.remove('nav-oculta'); ajustar(); }).observe($('vista-pedido'), { attributes: true, attributeFilter: ['hidden'] });
})();
