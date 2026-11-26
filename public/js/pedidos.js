/**
 * Toma de pedidos: menú completo (con nombres y fotos), extras, código rápido
 * y envío del pedido. El servidor vuelve a calcular precios y totales.
 */

const API = '../api/';
const RUTA_FOTOS = '../uploads/';
const $ = (id) => document.getElementById(id);

let menu = [];                 // [{categoria, productos:[...]}]
let porId = new Map();         // id → producto
let porCodigo = new Map();     // CÓDIGO → producto
let categoriaActiva = 0;
let carrito = [];              // [{producto, extras:[extra], cantidad, notas}]
let tokenPedido = nuevoToken();
let enviando = false;

function nuevoToken() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/*  Pantallas, avisos y sesión                                         */
/* ------------------------------------------------------------------ */

const hashInicial = location.hash;   // antes de que mostrar() lo reescriba
function mostrar(vista) {
  if (vista !== 'vista-seguimiento') detenerSeguimiento();
  for (const id of ['vista-login', 'vista-aviso', 'vista-pedido', 'vista-seguimiento']) $(id).hidden = id !== vista;
  $('btn-salir').hidden = vista === 'vista-login';
  $('btn-caja').hidden = vista === 'vista-login' || vista === 'vista-aviso';
  const sesion = vista === 'vista-pedido' || vista === 'vista-seguimiento';
  $('btn-tomar').hidden = !sesion;
  $('btn-seguimiento').hidden = !sesion;
  $('btn-tomar').classList.toggle('activo', vista === 'vista-pedido');
  $('btn-seguimiento').classList.toggle('activo', vista === 'vista-seguimiento');
  $('btn-tomar').setAttribute('aria-current', String(vista === 'vista-pedido'));
  $('btn-seguimiento').setAttribute('aria-current', String(vista === 'vista-seguimiento'));
  document.body.classList.toggle('pedido-activo', vista === 'vista-pedido');
  // La dirección recuerda la pantalla: al recargar en Preparando se queda en Preparando
  if (sesion) history.replaceState(null, '', location.pathname + location.search + (vista === 'vista-seguimiento' ? '#preparando' : ''));
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

async function iniciar() {
  try {
    const s = await pedir(API + 'sesion.php');
    fijarCsrf(s.csrf);
    if (s.autenticado) await entrar(s.usuario); else mostrar('vista-login');
  } catch (err) {
    $('aviso-titulo').textContent = 'No se pudo iniciar';
    $('aviso-texto').textContent = err.message;
    mostrar('vista-aviso');
  }
}

/* Mesas de la sucursal: el mesero elige a cuál lleva el pedido (si la sucursal tiene mesas).
   Con el plano activado se elige tocando la mesa en el dibujo (zonas: piso 1, patio…). */
let mesas = [];
let planoActivo = false;
let zonasPed = [];
const campoMesa = crearCampoMesa($('mesa'), $('mesa-plano-btn'), () => actualizarMesa());
async function cargarMesas() {
  let r = { mesas: [], zonas: [], plano: false };
  try { r = await pedir(API + 'mesas.php'); } catch { /* sin mesas */ }
  mesas = r.mesas || []; zonasPed = r.zonas || []; planoActivo = r.plano === true;
  campoMesa.poner(r, 'Elige la mesa…');
  const ed = $('ed-mesa');
  ed.replaceChildren(new Option('Sin mesa', ''), ...mesas.map((m) => new Option(etiquetaMesaLista(m, r.zonas), String(m.id))));
  actualizarMesa();
}
let pedirPorMesa = false; // ajuste del administrador: en pedidos "aquí" la mesa es obligatoria y el nombre opcional
function mesaObligatoria() { return pedirPorMesa && modalidad === 'aqui' && !ordenDestino; }
/* El nombre es opcional si ya se eligió mesa; para llevar o recoger siempre se pide. */
function nombreOpcional() { return !ordenDestino && modalidad === 'aqui' && mesas.length > 0 && ($('mesa').value !== '' || pedirPorMesa); }
function actualizarMesa() {
  $('mesa-fila').hidden = !(mesas.length && modalidad === 'aqui' && !ordenDestino);
  if ($('mesa-fila').hidden) $('mesa').value = '';
  campoMesa.refrescar();
  // Sin mesas en esta sucursal no hay nada que elegir: se avisa en vez de esconderlo sin explicación
  const sinMesas = !mesas.length && modalidad === 'aqui' && !ordenDestino;
  $('mesa-aviso').hidden = !sinMesas;
  $('mesa-aviso').textContent = sinMesas ? 'Esta sucursal no tiene mesas todavía (se pide por nombre). ¿Estás en la sucursal correcta? Cámbiala arriba o crea las mesas en Ajustes → Sucursales y mesas.' : '';
  const op = nombreOpcional();
  $('mesa-rotulo').textContent = mesaObligatoria() ? 'Mesa (obligatoria)' : 'Mesa';
  $('cliente-rotulo').textContent = op ? 'Nombre (opcional)' : 'Nombre';
  $('cliente').placeholder = op ? 'Opcional' : 'Obligatorio';
}

async function entrar(usuario) {
  $('quien').textContent = document.body.dataset.shell ? '' : usuario.nombre;   // con el menú lateral el nombre va abajo, junto a la foto
  montarSucursal();
  await cargarMesas();
  mostrar('vista-pedido');
  restaurarCarrito();
  await cargarMenu();
  if (pendiente && pendiente.destino && pendiente.destino.id) {
    venimosDeCocina = !!pendiente.destino.desdeCocina;
    fijarDestino(pendiente.destino);
    platoActual = pendiente.plato || platoActual;
    pintarCarrito();
  }
  await entrarDesdeCocina();
  await entrarReabriendo();
  entrarVista();
}

/* La cocina manda aquí con ?agregar=ID para sumar platillos a un pedido */
async function entrarDesdeCocina() {
  const id = Number(new URLSearchParams(location.search).get('agregar'));
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  try {
    const r = await pedir(API + 'ordenes.php');
    const o = r.ordenes.find((x) => x.id === id);
    if (!o) { avisar('No encontré ese pedido', true); return; }
    if (o.estado === 'entregada') {
      // Ya salió de cocina: se reabre (con prioridad) para poder agregarle platillos
      if (!(await confirmar(`El pedido de ${o.nombre_cliente} ya se marcó como entregado.\n\n¿Reabrirlo para agregar platillos? Pasará a cocina con PRIORIDAD.`, { si: 'Reabrir' }))) return;
      await enviarJson(API + 'cocina.php', { accion: 'reabrir_entregada', orden_id: o.id });
    } else if (!['nueva', 'preparando', 'lista'].includes(o.estado)) {
      avisar(`Ese pedido está ${o.estado === 'cancelada' ? 'cancelado' : 'cerrado'} y no se puede editar`, true); return;
    }
    venimosDeCocina = true;
    fijarDestino({ id: o.id, turno: o.turno, nombre_cliente: o.nombre_cliente, modalidad: o.modalidad, llevarPlatos: o.items.filter((i) => i.llevar).map((i) => i.plato), platos: Math.max(1, ...o.items.map((i) => i.plato || 1)) });
  } catch (err) { avisar(err.message, true); }
}
let venimosDeCocina = false;

/* Pedido ya entregado al que el cliente quiere agregar algo: se reabre (con prioridad en cocina) y se abre el editor */
async function reabrirYEditar(id, nombre) {
  if (!(await confirmar(`¿Reabrir el pedido de ${nombre} para agregar o cambiar algo?\n\nLo que agregues pasará a cocina con PRIORIDAD, antes que todos los demás.`, { si: 'Reabrir' }))) return false;
  try {
    await enviarJson(API + 'cocina.php', { accion: 'reabrir_entregada', orden_id: id });
  } catch (err) { avisar(err.message, true); return false; }
  await abrirEditar(id);
  return true;
}

/* Enlaces desde Caja: ?vista=curso */
function entrarVista() {
  if (hashInicial === '#preparando') { abrirSeguimiento(); return; }
  const v = new URLSearchParams(location.search).get('vista');
  if (!v) return;
  history.replaceState(null, '', location.pathname);
  if (v === 'curso') abrirSeguimiento();
}

async function entrarReabriendo() {
  const id = Number(new URLSearchParams(location.search).get('reabrir'));
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  try {
    const r = await pedir(API + 'ordenes.php');
    const o = r.ordenes.find((x) => x.id === id);
    if (!o) { avisar('No encontré ese pedido', true); return; }
    if (o.estado === 'entregada') await reabrirYEditar(o.id, o.nombre_cliente);
    else if (['nueva', 'preparando', 'lista'].includes(o.estado)) await abrirEditar(o.id);
    else avisar('Ese pedido ya no se puede editar', true);
  } catch (err) { avisar(err.message, true); }
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
    await entrar(r.usuario);
  } catch (err) {
    $('login-msg').textContent = err.message;
  } finally {
    boton.disabled = false;
  }
});

$('btn-salir').addEventListener('click', async () => {
  try { await pedir(API + 'logout.php', { method: 'POST' }); } catch { /* da igual */ }
  vaciarTodo();
  await iniciar();
});

/* ------------------------------------------------------------------ */
/*  Menú                                                               */
/* ------------------------------------------------------------------ */

async function cargarMenu() {
  try {
    const r = await pedir(API + 'productos.php');
    menu = r.menu;
    // El dueño puede apagar el buscador por código rápido: se oculta toda la sección (campo, botón y mensajes)
    $('form-codigo').hidden = r.codigo_rapido === false;
    pedirPorMesa = r.pedir_por_mesa === true;
    actualizarMesa();
    if (r.codigo_rapido === false) $('codigo-msg').textContent = '';
    porId = new Map();
    porCodigo = new Map();
    for (const c of menu) for (const p of c.productos) {
      porId.set(p.id, p);
      if (p.codigo) porCodigo.set(p.codigo.toUpperCase(), p);
    }
    if (categoriaActiva >= menu.length) categoriaActiva = 0;
    // El carrito recuperado se reconstruye con datos frescos (precios, agotados)
    carrito = carrito.map((l) => {
      const p = porId.get(l.producto.id);
      if (!p || p.agotado) return null;
      const extras = l.extras.map((x) => p.extras.find((e) => e.id === x.id)).filter(Boolean);
      return { ...l, producto: p, extras };
    }).filter(Boolean);
    pintarCategorias();
    pintarProductos();
    pintarCarrito();
    consultarVoz();
  } catch (err) {
    if (err.estado === 401) { await iniciar(); return; }
    avisar(err.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Pedir con voz                                                      */
/* ------------------------------------------------------------------ */

const MAX_VOZ_SEG = 30;
const dlgVoz = $('dlg-voz');
let vozGrabador = null, vozPartes = [], vozTimer = null, vozInicio = 0, vozProcesando = false;
let vozPropuesta = { lineas: [], dudas: [], pedido: {} };
let vozMod = 'aqui';
let vozPendientesOpciones = [];
const NOMBRE_MOD = { aqui: 'Comer aquí', llevar: 'Para llevar', recoger: 'Recoger' };
const MIC_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>';

/** Muestra el botón del micrófono solo si la voz está activada para esta empresa y hay micrófono disponible. */
async function consultarVoz() {
  const btn = $('btn-voz');
  btn.hidden = true;
  if (!navigator.mediaDevices || !window.MediaRecorder) return;
  try {
    const r = await pedir(API + 'voz/estado.php');
    btn.hidden = !r.disponible;
  } catch { /* sin voz: no pasa nada */ }
}

function tipoAudio() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

/** Qué se ve según el momento: 'grabando' (control grande) o 'resultado' (pedido armado + micrófono redondo arriba). */
function vozVista(v) {
  const resultado = v === 'resultado';
  $('voz-controles').hidden = resultado;
  $('voz-resultado').hidden = !resultado;
  $('voz-agregar').hidden = !resultado;
  $('voz-regrabar').hidden = !resultado;
}

function vozReiniciar() {
  $('voz-error').textContent = '';
  vozPropuesta = { lineas: [], dudas: [], pedido: {} };
  vozVista('grabando');
  $('voz-estado').textContent = 'Toca el micrófono y di el pedido.';
  $('voz-grabar').textContent = '🎤 Empezar a hablar';
  $('voz-grabar').disabled = false;
}

function vozDetener(cancelar = false) {
  $('voz-grabar').classList.remove('grabando');
  $('voz-regrabar').classList.remove('grabando');
  clearInterval(vozTimer);
  vozTimer = null;
  if (vozGrabador && vozGrabador.state !== 'inactive') {
    if (cancelar) vozGrabador.onstop = null;
    vozGrabador.stop();
  }
  if (vozGrabador) for (const t of vozGrabador.stream.getTracks()) t.stop();
  if (cancelar) vozGrabador = null;
}

async function vozEmpezar() {
  $('voz-error').textContent = '';
  let flujo;
  try { flujo = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $('voz-error').textContent = 'No se pudo usar el micrófono. Revisa el permiso del navegador.'; return; }
  vozPartes = [];
  const tipo = tipoAudio();
  vozGrabador = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
  vozGrabador.ondataavailable = (e) => { if (e.data.size) vozPartes.push(e.data); };
  vozGrabador.onstop = vozEnviar;
  vozGrabador.start();
  vozInicio = Date.now();
  vozVista('grabando');   // si venía de un resultado (hablar otra vez), vuelve al control de grabar
  $('voz-grabar').disabled = false;
  $('voz-grabar').textContent = '⏹ Listo, enviar';
  $('voz-grabar').classList.add('grabando');
  const pintar = () => {
    const s = Math.floor((Date.now() - vozInicio) / 1000);
    $('voz-estado').textContent = `Escuchando… ${s} s (máximo ${MAX_VOZ_SEG})`;
    if (s >= MAX_VOZ_SEG) vozDetener();
  };
  pintar();
  vozTimer = setInterval(pintar, 500);
}

function aBase64(blob) {
  return new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = mal; r.readAsDataURL(blob); });
}

async function vozEnviar() {
  const segundos = Math.max(1, Math.round((Date.now() - vozInicio) / 1000));
  const tipo = (vozGrabador && vozGrabador.mimeType) || 'audio/webm';
  const blob = new Blob(vozPartes, { type: tipo });
  vozGrabador = null;
  vozProcesando = true;
  $('voz-grabar').disabled = true;
  $('voz-grabar').classList.remove('grabando');
  $('voz-estado').textContent = 'Entendiendo el pedido…';
  try {
    const formato = tipo.includes('mp4') ? 'mp4' : tipo.includes('ogg') ? 'ogg' : 'webm';
    const r = await enviarJson(API + 'voz.php', { audio: await aBase64(blob), formato, segundos });
    vozPintar(r);
  } catch (err) {
    $('voz-error').textContent = err.message;
    $('voz-estado').textContent = 'No se pudo. Intenta otra vez.';
    $('voz-grabar').textContent = '🎤 Hablar otra vez';
  } finally {
    vozProcesando = false;
    $('voz-grabar').disabled = false;
  }
}

const campoVozMesa = crearCampoMesa($('voz-mesa'), $('voz-mesa-plano'), () => vozPintarDatos());

function vozPintar(r) {
  const pd = r.pedido || {};
  vozPropuesta = { lineas: (r.lineas || []).map((l) => ({ ...l, plato: l.plato || 1 })), dudas: r.dudas || [], pedido: pd };
  // Punto de partida: lo que dijo el mesero; si no dijo nada, lo que ya estaba elegido en la pantalla
  vozMod = pd.modalidad || modalidad;
  campoVozMesa.poner({ mesas, zonas: zonasPed, plano: planoActivo }, 'Elige la mesa…');
  $('voz-mesa').value = pd.mesa_id && mesas.some((m) => m.id === pd.mesa_id) ? String(pd.mesa_id) : ($('mesa').value || '');
  campoVozMesa.refrescar();
  $('voz-nombre').value = pd.nombre || $('cliente').value || '';
  $('voz-notas-pedido').value = pd.notas || '';
  $('voz-texto').textContent = r.texto ? `«${r.texto}»` : '(nada)';
  $('voz-no').textContent = (r.no_encontrados || []).length ? 'No encontré en el menú: ' + r.no_encontrados.join(', ') : '';
  $('voz-estado').textContent = r.aviso ? 'Ya llevas más del 80% del límite de voz de hoy.' : 'Revisa, corrige lo que haga falta y agrégalo al pedido.';
  $('voz-error').textContent = '';
  vozVista('resultado');
  vozPintarDatos();
  vozPintarPlatos();
}

/** ¿Falta algo para poder levantar el pedido? Mismas reglas que el formulario normal. */
function vozFalta() {
  if (ordenDestino) return null;
  const mesaVal = $('voz-mesa').value;
  if (vozMod === 'aqui' && mesas.length && pedirPorMesa && !mesaVal) return { campo: 'voz-mesa', texto: 'Elige la mesa del pedido.' };
  const opcional = vozMod === 'aqui' && mesas.length > 0 && (mesaVal !== '' || pedirPorMesa);
  if (!$('voz-nombre').value.trim() && !opcional) return { campo: 'voz-nombre', texto: vozMod === 'aqui' && mesas.length ? 'Elige la mesa o escribe el nombre del cliente.' : 'Escribe el nombre del cliente.' };
  return null;
}

/** Tipo de pedido, mesa y nombre (lo que cambia según el tipo). */
function vozPintarDatos() {
  const nuevo = !ordenDestino;
  $('voz-mod').hidden = !nuevo;
  for (const b of $('voz-mod').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mod === vozMod));
  $('voz-mesa-fila').hidden = !(nuevo && vozMod === 'aqui' && mesas.length);
  $('voz-nombre-fila').hidden = !nuevo;
  const mesaVal = $('voz-mesa').value;
  const opcional = vozMod === 'aqui' && mesas.length > 0 && (mesaVal !== '' || pedirPorMesa);
  $('voz-nombre-fila').firstChild.textContent = opcional ? 'Nombre del cliente (opcional)' : 'Nombre del cliente';
  $('voz-mesa-fila').firstChild.textContent = pedirPorMesa ? 'Mesa (obligatoria)' : 'Mesa';
  campoVozMesa.refrescar();
  vozPintarPlatos();
}
for (const b of $('voz-mod').querySelectorAll('button')) b.addEventListener('click', () => { vozMod = b.dataset.mod; vozPintarDatos(); });
$('voz-nombre').addEventListener('input', () => { $('voz-error').textContent = ''; vozPintarDatos(); });

const vozPrecioLinea = (l) => {
  const p = porId.get(l.producto_id);
  if (!p) return 0;
  const extras = l.extras.map((x) => p.extras.find((e) => e.id === x.id)).filter(Boolean);
  return precioLinea({ producto: p, extras, cantidad: l.cantidad });
};

/** El pedido armado, ordenado por plato como se verá en las órdenes: tipo del plato, platillos, modificadores y notas. */
function vozPintarPlatos() {
  const cont = $('voz-platos');
  cont.replaceChildren();
  const numeros = [...new Set(vozPropuesta.lineas.map((l) => l.plato))].sort((a, b) => a - b);
  for (const n of numeros) {
    const lineas = vozPropuesta.lineas.filter((l) => l.plato === n);
    const llevar = vozMod === 'llevar' || (vozMod === 'aqui' && lineas.every((l) => l.llevar));
    const caja = el('section', 'voz-plato');
    const cab = el('div', 'voz-plato-cab');
    cab.append(el('b', '', numeros.length > 1 || n > 1 ? `Plato ${n}` : 'Pedido'));
    if (vozMod === 'aqui' && !ordenDestino || (ordenDestino && ordenDestino.modalidad === 'aqui')) {
      const seg = el('div', 'voz-seg chico');
      for (const [valor, texto] of [[false, 'Aquí'], [true, 'Para llevar']]) {
        const b = el('button', '', texto); b.type = 'button'; b.setAttribute('aria-pressed', String(llevar === valor));
        b.addEventListener('click', () => { for (const l of lineas) l.llevar = valor; vozPintarPlatos(); });
        seg.append(b);
      }
      cab.append(seg);
    } else cab.append(el('span', 'chip-mod', NOMBRE_MOD[ordenDestino ? ordenDestino.modalidad : vozMod]));
    caja.append(cab);

    for (const l of lineas) {
      const p = porId.get(l.producto_id);
      const fila = el('div', 'voz-linea');
      const arriba = el('div', 'voz-linea-arriba');
      const cant = el('div', 'voz-cant');
      const menos = el('button', 'btn chico', '−'); menos.type = 'button'; menos.setAttribute('aria-label', 'Menos');
      const mas = el('button', 'btn chico', '＋'); mas.type = 'button'; mas.setAttribute('aria-label', 'Más');
      menos.addEventListener('click', () => { if (l.cantidad > 1) l.cantidad--; vozPintarPlatos(); });
      mas.addEventListener('click', () => { l.cantidad = Math.min(50, l.cantidad + 1); vozPintarPlatos(); });
      cant.append(menos, el('output', '', String(l.cantidad)), mas);
      const nombre = el('div', 'voz-nombre');
      nombre.append(el('strong', '', l.nombre));
      if (l.extras.length) nombre.append(el('div', 'voz-extras', l.extras.map((x) => x.nombre).join(' · ')));
      if (l.falta_opcion) nombre.append(el('div', 'voz-aviso', 'Falta elegir la opción obligatoria'));
      const precio = el('span', 'voz-precio', dinero.format(vozPrecioLinea(l)));
      const quitar = el('button', 'btn chico', '✕'); quitar.type = 'button'; quitar.setAttribute('aria-label', 'Quitar');
      quitar.addEventListener('click', () => { vozPropuesta.lineas.splice(vozPropuesta.lineas.indexOf(l), 1); vozPintarPlatos(); });
      arriba.append(cant, nombre, precio, quitar);
      fila.append(arriba);

      // Modificadores del platillo: se eligen igual que en el menú (los marcados son los que se entendieron)
      if (p && p.extras.length) {
        const det = el('details', 'voz-mods');
        det.append(el('summary', '', l.extras.length ? 'Cambiar modificadores' : 'Agregar modificadores'));
        const grupos = new Map();
        for (const x of p.extras) grupos.set(x.grupo || 'Extras', [...(grupos.get(x.grupo || 'Extras') || []), x]);
        for (const [g, xs] of grupos) {
          const fil = el('div', 'voz-mods-grupo');
          fil.append(el('span', 'voz-mods-nombre', g));
          for (const x of xs) {
            const on = l.extras.some((e) => e.id === x.id);
            const b = el('button', 'voz-chip', x.nombre + (x.precio > 0 ? ` +${dinero.format(x.precio)}` : '')); b.type = 'button'; b.setAttribute('aria-pressed', String(on));
            b.addEventListener('click', () => {
              l.extras = on ? l.extras.filter((e) => e.id !== x.id) : [...l.extras, { id: x.id, nombre: x.nombre }];
              l.falta_opcion = p.obligatorias && l.extras.length === 0;
              vozPintarPlatos();
            });
            fil.append(b);
          }
          det.append(fil);
        }
        if (l.extras.length === 0 || l.falta_opcion) det.open = !!l.falta_opcion;
        fila.append(det);
      }
      if (l.notas) fila.append(el('div', 'voz-nota', 'Nota: ' + l.notas));
      caja.append(fila);
    }
    cont.append(caja);
  }
  if (!numeros.length) cont.append(el('p', 'ayuda', 'No quedó ningún platillo. Toca el micrófono para volver a decirlo.'));

  // Dudas: la IA no estaba segura; el mesero elige
  const dudas = $('voz-dudas');
  dudas.replaceChildren();
  vozPropuesta.dudas.forEach((d, i) => {
    const caja = el('div', 'voz-duda');
    caja.append(el('p', 'ayuda', `No estoy seguro de «${d.texto}» (${d.cantidad}). ¿Cuál es?`));
    for (const o of d.opciones) {
      const b = el('button', 'btn chico', o.nombre); b.type = 'button';
      b.addEventListener('click', () => {
        vozPropuesta.lineas.push({ producto_id: o.id, nombre: o.nombre, cantidad: d.cantidad, extras: [], notas: '', plato: 1, llevar: false, falta_opcion: !!(porId.get(o.id) || {}).obligatorias });
        vozPropuesta.dudas.splice(i, 1);
        vozPintarPlatos();
      });
      caja.append(b);
    }
    const ninguno = el('button', 'btn chico', 'Ninguno'); ninguno.type = 'button';
    ninguno.addEventListener('click', () => { vozPropuesta.dudas.splice(i, 1); vozPintarPlatos(); });
    caja.append(ninguno);
    dudas.append(caja);
  });

  const total = vozPropuesta.lineas.reduce((s, l) => s + vozPrecioLinea(l), 0);
  $('voz-total').hidden = !vozPropuesta.lineas.length;
  $('voz-total').textContent = 'Total: ' + dinero.format(total);
  $('voz-agregar').disabled = vozPropuesta.lineas.length === 0 || vozPropuesta.dudas.length > 0;
}

/** Pasa lo confirmado al pedido en curso (con el mismo flujo de siempre). Los platillos que piden opción obligatoria abren su hoja de opciones. */
function vozAgregar() {
  const falta = vozFalta();
  if (falta) {   // se pide aquí mismo, para no perder lo que ya se armó
    $('voz-error').textContent = falta.texto;
    const campo = $(falta.campo);
    if (campo.offsetParent === null && falta.campo === 'voz-mesa') $('voz-mesa-plano').click(); else campo.focus();
    return;
  }
  const faltan = [];

  // Tipo de pedido, nombre y mesa (solo en pedidos nuevos; a un pedido ya levantado solo se le agregan platillos)
  if (!ordenDestino) {
    const llevarPlatos = new Set(vozPropuesta.lineas.filter((l) => l.llevar).map((l) => l.plato));
    const todosPlatos = new Set(vozPropuesta.lineas.map((l) => l.plato));
    platosLlevar.clear();
    if (vozMod === 'recoger') fijarModalidad('recoger');
    else if (vozMod === 'llevar' || (llevarPlatos.size > 0 && llevarPlatos.size === todosPlatos.size && !carrito.length)) fijarModalidad('llevar');
    else {
      fijarModalidad('aqui');
      for (const n of llevarPlatos) platosLlevar.add(n);
    }
    $('cliente').value = $('voz-nombre').value.trim();
    if (modalidad === 'aqui' && $('voz-mesa').value && mesas.some((m) => String(m.id) === $('voz-mesa').value)) $('mesa').value = $('voz-mesa').value;
  } else if (ordenDestino.modalidad === 'aqui') {
    for (const l of vozPropuesta.lineas) if (l.llevar) platosLlevar.add(l.plato); else platosLlevar.delete(l.plato);
  }
  const notasPedido = $('voz-notas-pedido').value.trim();
  if (notasPedido) { const a = $('notas-orden').value.trim(); if (!a.includes(notasPedido)) $('notas-orden').value = a ? `${a} · ${notasPedido}` : notasPedido; }

  for (const l of vozPropuesta.lineas) {
    const p = porId.get(l.producto_id);
    if (!p || p.agotado) { avisar(`${l.nombre} ya no está disponible`, true); continue; }
    if (l.falta_opcion) { faltan.push(p); continue; }
    const extras = l.extras.map((x) => p.extras.find((e) => e.id === x.id)).filter(Boolean);
    // Cada plato nuevo toma el siguiente número (sin saltarse ninguno)
    const plato = l.plato > 1 ? Math.min(l.plato, maxPlato() + 1) : platoActual;
    agregarLinea(p, extras, l.cantidad, l.notas, plato);
  }
  actualizarMesa();
  pintarCarrito();
  dlgVoz.close();
  avisar('Agregado al pedido');
  vozPendientesOpciones = faltan;
  vozSiguienteOpcion();
}

function vozSiguienteOpcion() {
  const p = vozPendientesOpciones.shift();
  if (!p) return;
  avisar(`Elige la opción de ${p.nombre}`);
  abrirOpciones(p);
}
$('dlg-opciones').addEventListener('close', () => { if (vozPendientesOpciones.length) setTimeout(vozSiguienteOpcion, 150); });

// Al tocar el micrófono se abre la ventana y empieza a grabar de inmediato
$('btn-voz').addEventListener('click', () => { vozReiniciar(); dlgVoz.showModal(); vozEmpezar(); });
$('voz-grabar').addEventListener('click', () => {
  if (vozProcesando) return;
  if (vozGrabador && vozGrabador.state === 'recording') vozDetener(); else vozEmpezar();
});
// «Hablar otra vez»: el micrófono redondo junto a «Agregar al pedido» vuelve a grabar de inmediato
$('voz-regrabar').addEventListener('click', () => { if (!vozProcesando) vozEmpezar(); });
$('voz-agregar').addEventListener('click', vozAgregar);
$('voz-cancelar').addEventListener('click', () => dlgVoz.close());
dlgVoz.addEventListener('close', () => vozDetener(true));

function pintarCategorias() {
  const caja = $('cats');
  caja.replaceChildren();
  menu.forEach((c, i) => {
    const b = el('button', 'cat', c.categoria);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === categoriaActiva));
    b.addEventListener('click', () => {
      categoriaActiva = i; pintarCategorias(); pintarProductos();
      if (window.matchMedia('(max-width: 640px)').matches) $('productos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    caja.append(b);
  });
}

function pintarProductos() {
  const caja = $('productos');
  caja.replaceChildren();
  if (menu.length === 0) {
    caja.append(el('p', 'vacio', 'No hay productos disponibles. Agrégalos desde la administración.'));
    return;
  }
  for (const p of menu[categoriaActiva].productos) {
    const b = el('button', 'pr' + (p.agotado ? ' agotado' : ''));
    b.type = 'button';

    const foto = el('div', 'pr-foto');
    if (p.foto) {
      const img = document.createElement('img');
      img.src = '../' + p.foto;
      img.alt = '';
      img.loading = 'lazy';
      foto.append(img);
    } else {
      foto.classList.add('vacia');
      foto.append(el('span', 'sin-foto', '🌮'));
    }

    const info = el('div', 'pr-info');
    info.append(el('span', 'pr-nombre', p.nombre));
    if (p.porcion) info.append(el('span', 'pr-meta', p.porcion));
    if (p.descripcion) info.append(el('span', 'pr-desc', p.descripcion));
    info.append(el('span', 'pr-precio', dinero.format(p.precio)));

    b.append(foto, info);
    if (p.codigo) b.append(el('span', 'pr-cod', p.codigo));
    if (p.agotado) info.append(el('span', 'pr-agotado', 'AGOTADO HOY'));
    else if (p.extras.length) info.append(el('span', 'pr-mas', 'con opciones ›'));
    b.addEventListener('click', (ev) => { if (!ignorarClic) tocarProducto(p, !!ev.target.closest('.pr-foto')); });
    mantenerPresionado(b, () => abrirAccionesPlato(p));
    caja.append(b);
  }
}

/* Mantener presionado un producto = menú con dos opciones: ver el platillo (como lo ve el cliente) o darlo de baja / habilitarlo hoy */
const dlgAcciones = $('dlg-acciones-plato');
let accionesProducto = null;
function abrirAccionesPlato(p) {
  accionesProducto = p;
  $('pa-titulo').textContent = p.nombre;
  $('pa-baja').textContent = p.agotado ? 'Volver a habilitar' : 'Dar de baja (agotado hoy)';
  $('pa-baja').classList.toggle('peligro', !p.agotado);
  dlgAcciones.showModal();
}
$('pa-ver').addEventListener('click', () => { dlgAcciones.close(); abrirDetalle(accionesProducto); });
$('pa-baja').addEventListener('click', () => { dlgAcciones.close(); alternarAgotado(accionesProducto); });   // pide confirmación
$('pa-cerrar').addEventListener('click', () => dlgAcciones.close());

/* Detalle del platillo: igual que lo ve el cliente (foto grande y descripción completa) */
const dlgDetalle = $('dlg-detalle');
function abrirDetalle(p) {
  $('dt-titulo').textContent = p.nombre;
  $('dt-meta').textContent = p.porcion || '';
  $('dt-meta').hidden = !p.porcion;
  $('dt-desc').textContent = p.descripcion || '';
  $('dt-desc').hidden = !p.descripcion;
  $('dt-precio').textContent = dinero.format(p.precio) + (p.agotado ? ' · Agotado hoy' : '');
  const img = $('dt-foto');
  if (p.foto) { img.src = p.foto; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  $('dt-agregar').hidden = !!p.agotado;
  $('dt-agregar').onclick = () => { dlgDetalle.close(); tocarProducto(p); };
  dlgDetalle.showModal();
}
$('dt-cerrar').addEventListener('click', () => dlgDetalle.close());

async function alternarAgotado(p) {
  const habilitar = !!p.agotado;
  const pregunta = habilitar
    ? `¿Volver a habilitar “${p.nombre}”?`
    : `¿Marcar “${p.nombre}” como AGOTADO por hoy?\n\nYa no se podrá pedir (tampoco desde el celular del cliente). Mañana vuelve a estar habilitado solo.`;
  if (!(await confirmar(pregunta, habilitar ? { si: 'Habilitar' } : { si: 'Marcar agotado', peligro: true }))) return;
  try {
    await enviarJson(API + 'agotar.php', { producto_id: p.id, disponible: habilitar });
    await cargarMenu();
    avisar(habilitar ? `${p.nombre} habilitado` : `${p.nombre} marcado como agotado`);
  } catch (err) { avisar(err.message, true); }
}

/** Con extras disponibles se abre la hoja de opciones; si no, se agrega directo. */
/** Tocar la foto agrega el platillo completo (sin opciones); tocar la parte de abajo abre las opciones. */
function tocarProducto(p, desdeFoto = false) {
  if (p.agotado) { avisar(`${p.nombre} está agotado hoy. Mantén presionado para verlo o habilitarlo.`, true); return; }
  if (p.extras.length && (!desdeFoto || p.pedir_opciones)) abrirOpciones(p);
  else { agregarLinea(p, [], 1, ''); avisar(`${p.nombre} agregado`); }
}

/* ------------------------------------------------------------------ */
/*  Hoja de opciones (cantidad + extras + nota)                        */
/* ------------------------------------------------------------------ */

const dlgOpciones = $('dlg-opciones');
let opProducto = null;
let opCantidad = 1;

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
let opEditando = null;   // línea del carrito que se está editando (null = se agrega una nueva)

/** Abre la hoja de opciones. Con `linea` se edita esa línea del carrito: sale con sus extras, cantidad y nota ya marcados. */
function abrirOpciones(p, linea = null) {
  opProducto = p;
  opEditando = linea;
  pintarRequisito(p);
  opCantidad = linea ? linea.cantidad : 1;
  $('op-cantidad').textContent = String(opCantidad);
  $('op-agregar').textContent = linea ? 'Guardar cambios' : 'Agregar';
  $('op-agregados').hidden = true; $('op-agregados').replaceChildren();
  $('op-titulo').textContent = p.nombre;
  $('op-precio').textContent = dinero.format(p.precio) + (p.porcion ? ` · ${p.porcion}` : '');
  $('op-notas').value = linea ? linea.notas : '';
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
    c.type = 'checkbox';
    c.value = String(x.id);
    c.checked = !!linea && linea.extras.some((e) => e.id === x.id);
    f.append(c, el('span', '', x.nombre));
    if (x.codigo) f.append(el('span', 'cod-extra', x.codigo));
    f.append(el('span', 'precio-extra', x.precio > 0 ? `+${dinero.format(x.precio)}` : ''));
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
/** Extras marcados en la hoja de opciones. */
const extrasElegidos = () => {
  const ids = [...$('op-extras').querySelectorAll('input:checked')].map((c) => Number(c.value));
  return opProducto.extras.filter((x) => ids.includes(x.id));
};

$('form-opciones').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const extras = extrasElegidos();
  const notas = $('op-notas').value.trim();
  const falta = faltaOpcion(opProducto, extras.map((x) => x.id));
  if (falta) { $('op-error').textContent = falta; return; }
  if (opEditando) {
    // Editar: la línea cambia sus extras/cantidad/nota en el MISMO plato; si queda igual a otra línea, se juntan
    const l = opEditando;
    carrito = carrito.filter((x) => x !== l);
    agregarLinea(l.producto, extras, opCantidad, notas, l.plato);
    dlgOpciones.close();
    avisar(`${l.producto.nombre} actualizado`);
    return;
  }
  // Agregar NO cierra la ventana: queda abierta, anota lo agregado abajo y limpia las opciones para pedir otra variante
  // (por ejemplo un combinado de arrachera y luego otro de pastor). Se sale con la ✕.
  agregarLinea(opProducto, extras, opCantidad, notas);
  const lista = $('op-agregados');
  lista.hidden = false;
  lista.append(el('li', '', `✔ ${opCantidad} × ${opProducto.nombre}` + (extras.length ? ' · ' + extras.map((x) => x.nombre).join(', ') : '') + (notas ? ` · “${notas}”` : '')));
  opCantidad = 1; $('op-cantidad').textContent = '1';
  $('op-notas').value = '';
  for (const c of $('op-extras').querySelectorAll('input[type=checkbox]')) { c.checked = false; c.disabled = false; }   // rehabilita las bloqueadas por el máximo de carnes
});

/* ------------------------------------------------------------------ */
/*  Carrito                                                            */
/* ------------------------------------------------------------------ */

const clave = (l) => `${l.plato}|${l.producto.id}|${l.extras.map((x) => x.id).sort((a, b) => a - b).join(',')}|${l.notas}`;
const precioLinea = (l) => (l.producto.precio + l.extras.reduce((s, x) => s + x.precio, 0)) * l.cantidad;
const totalCarrito = () => carrito.reduce((s, l) => s + precioLinea(l), 0);

let modalidad = 'aqui';
const cuando = montarCuando($('cuando'));
const actualizarEspera = montarEspera($('espera-previa'), API + 'cliente/espera.php', () => ({
  modalidad,
  unidades: carrito.reduce((n, l) => n + l.cantidad, 0),
  agendado: Object.keys(cuando.datos()).length > 0,
  oculto: !!ordenDestino,
}), { detalle: true });
cuando.onChange = actualizarEspera;
const textoModalidad = (m) => infoMod(m).corto;
const chipModalidad = (m) => el('span', 'chip-mod ' + infoMod(m).clase, textoModalidad(m));
function fijarModalidad(m) {
  modalidad = m;
  $('tel-fila').hidden = m !== 'recoger';
  if (typeof actualizarMesa === 'function') actualizarMesa();
  if (typeof actualizarEspera === 'function') actualizarEspera();
  try { pintarPlatos(); } catch { /* aún no inicia la pantalla */ }
}
document.querySelectorAll('#tipo-bloque .mod-btn').forEach((b) => b.addEventListener('click', () => elegirTipo(b.dataset.mod)));

let platoActual = 1;
let pagoPrevisto = null;           // efectivo | tarjeta | transferencia | null (sin definir)
const platosLlevar = new Set();   // platos marcados "para llevar" dentro de un pedido para comer aquí
const mixtoPosible = () => (ordenDestino ? ordenDestino.modalidad === 'aqui' : modalidad === 'aqui');
const esLlevar = (n) => mixtoPosible() && platosLlevar.has(n);

/* Tipo de pedido por plato: los tres botones se aplican al PLATO seleccionado.
   Todos iguales → el pedido es de ese tipo. Unos «aquí» y otros «para llevar» → el pedido va en «comer aquí»
   (cocina) y esos platos se marcan «para llevar». «Recoger» es de todo el pedido: se bloquea si hay mezcla. */
const baseMod = () => (ordenDestino ? ordenDestino.modalidad : modalidad);
const modDePlato = (n) => (baseMod() === 'aqui' && platosLlevar.has(n) ? 'llevar' : baseMod());
const platosEnUso = () => [...new Set([...carrito.map((l) => l.plato || 1), platoActual])].sort((a, b) => a - b);
const hayMezcla = () => !ordenDestino && modalidad === 'aqui' && platosLlevar.size > 0;
function normalizarTipo() {
  if (ordenDestino) return;
  const con = new Set(carrito.map((l) => l.plato || 1));
  for (const n of [...platosLlevar]) if (!con.has(n) && n !== platoActual) platosLlevar.delete(n);
  if (modalidad === 'aqui' && con.size > 0 && [...con].every((n) => platosLlevar.has(n))) { platosLlevar.clear(); fijarModalidad('llevar'); }
}
function elegirTipo(m) {
  const n = platoActual;
  if (ordenDestino) {   // pedido ya levantado: solo se decide por plato entre «aquí» y «para llevar»
    if (!mixtoPosible() || m === 'recoger') return;
    if (m === 'llevar') platosLlevar.add(n); else platosLlevar.delete(n);
    pintarCarrito();
    return;
  }
  if (m === 'recoger') { if (hayMezcla()) return; platosLlevar.clear(); fijarModalidad('recoger'); pintarCarrito(); return; }
  const platos = platosEnUso();
  if (platos.length === 1 || modalidad === 'recoger') { platosLlevar.clear(); fijarModalidad(m); pintarCarrito(); return; }
  const mods = platos.map((x) => (x === n ? m : modDePlato(x)));
  platosLlevar.clear();
  if (mods.every((x) => x === 'aqui')) fijarModalidad('aqui');
  else if (mods.every((x) => x === 'llevar')) fijarModalidad('llevar');
  else { platos.forEach((x, i) => { if (mods[i] === 'llevar') platosLlevar.add(x); }); fijarModalidad('aqui'); }
  pintarCarrito();
}
function pintarTipo() {
  const botones = [...document.querySelectorAll('#tipo-bloque .mod-btn')];
  $('tipo-bloque').hidden = !!ordenDestino && !mixtoPosible();
  for (const b of botones) {
    b.hidden = b.dataset.mod === 'recoger' && (!!ordenDestino || (platosEnUso().length > 1 && modalidad !== 'recoger'));  // con 2+ platos «Recoger» desaparece
    b.setAttribute('aria-pressed', String(b.dataset.mod === modDePlato(platoActual)));
    b.disabled = b.dataset.mod === 'recoger' && hayMezcla();
    b.title = b.disabled ? 'No se puede recoger si unos platos son para comer aquí y otros para llevar' : '';
  }
  document.querySelector('#tipo-bloque .modalidad').style.gridTemplateColumns = `repeat(${botones.filter((b) => !b.hidden).length || 1}, minmax(0, 1fr))`;
  $('tipo-plato').hidden = platosEnUso().length < 2;
  $('tipo-plato').textContent = `Tipo del plato ${platoActual} (elige el plato en «Plato:» más abajo)`;
}
let platosBase = 0;            // platos que ya tiene el pedido al que se agrega
const maxPlato = () => Math.max(platoActual, platosBase, ...carrito.map((l) => l.plato || 1));

function agregarLinea(producto, extras, cantidad, notas, plato = platoActual) {
  const nueva = { producto, extras, cantidad, notas, plato };
  const igual = carrito.find((l) => clave(l) === clave(nueva));
  if (igual) igual.cantidad = Math.min(50, igual.cantidad + cantidad);
  else carrito.push(nueva);
  pintarCarrito();
}

function pintarCarrito() {
  const caja = $('lineas');
  caja.replaceChildren();

  if (carrito.length === 0) {
    caja.append(el('p', 'vacio', 'Toca un producto del menú o escribe un código rápido.'));
  }
  normalizarTipo();
  pintarPlatos();
  pintarTipo();
  const mezcla = (ordenDestino ? ordenDestino.modalidad === 'aqui' : modalidad === 'aqui') && platosLlevar.size > 0;
  const hayVarios = maxPlato() > 1;
  const ordenado = [...carrito].sort((a, b) => a.plato - b.plato);
  let ultimo = 0;
  for (const l of ordenado) {
    if (hayVarios && l.plato !== ultimo) {
      const piezas = carrito.filter((x) => x.plato === l.plato).reduce((n, x) => n + x.cantidad, 0);
      caja.append(el('h3', 'plato-titulo' + (esLlevar(l.plato) ? ' llevar' : ''), `Plato ${l.plato} · ${piezas} pza` + (esLlevar(l.plato) ? ' · 🥡 PARA LLEVAR' : (mezcla ? ' · 🍽 PARA COMER AQUÍ' : ''))));
    }
    ultimo = l.plato;
    const fila = el('div', 'linea');
    fila.append(el('span', 'linea-nombre', l.producto.nombre), el('span', 'linea-precio', dinero.format(precioLinea(l))));
    const detalle = [...l.extras.map((x) => x.nombre), ...(l.notas ? [`“${l.notas}”`] : [])].join(' · ');
    if (detalle) fila.append(el('span', 'linea-detalle', detalle));

    const ctl = el('div', 'linea-ctl');
    const menos = el('button', 'btn', '−'); menos.type = 'button'; menos.setAttribute('aria-label', 'Menos');
    const num = el('output', '', String(l.cantidad));
    const mas = el('button', 'btn', '＋'); mas.type = 'button'; mas.setAttribute('aria-label', 'Más');
    const quitar = el('button', 'btn peligro quitar', 'Quitar'); quitar.type = 'button';
    menos.addEventListener('click', () => { if (l.cantidad > 1) l.cantidad--; else carrito = carrito.filter((x) => x !== l); pintarCarrito(); });
    mas.addEventListener('click', () => { l.cantidad = Math.min(50, l.cantidad + 1); pintarCarrito(); });
    quitar.addEventListener('click', () => { carrito = carrito.filter((x) => x !== l); pintarCarrito(); });
    ctl.append(menos, num, mas);
    // Editar: solo para platillos con opciones; reabre la hoja con lo elegido para cambiarlo sin quitar y volver a agregar
    if (l.producto.extras && l.producto.extras.length) {
      const editar = el('button', 'btn editar-linea', '✏️'); editar.type = 'button'; editar.title = 'Editar opciones'; editar.setAttribute('aria-label', 'Editar opciones');
      editar.addEventListener('click', () => abrirOpciones(l.producto, l));
      ctl.append(editar);
    }
    ctl.append(quitar);
    fila.append(ctl);
    caja.append(fila);
  }

  const total = dinero.format(totalCarrito());
  const piezas = carrito.reduce((s, l) => s + l.cantidad, 0);
  $('total').textContent = total;
  $('barra-total').textContent = total;
  $('barra-texto').textContent = piezas ? `Ver pedido (${piezas})` : 'Ver pedido';
  actualizarEspera();
  pintarPago();
  guardarCarrito();
}

/* ¿Cómo pagará? Muestra cuánto es según el método (con comisión si es tarjeta) y el cambio si es efectivo */
function pintarPago() {
  document.querySelectorAll('#pp-botones .btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pago === pagoPrevisto)));
  const d = $('pp-detalle');
  const total = totalCarrito();
  if (!pagoPrevisto || total <= 0) { d.hidden = true; d.replaceChildren(); return; }
  d.hidden = false;
  const previo = document.getElementById('pp-recibido') ? document.getElementById('pp-recibido').value : '';
  d.replaceChildren();
  if (pagoPrevisto === 'tarjeta') {
    const c = comisionTarjeta(total);
    d.append(el('p', 'pp-linea', `Pedido ${dinero.format(total)} + comisión de tarjeta ${dinero.format(c)}`), el('p', 'pp-total', `Total con tarjeta: ${dinero.format(total + c)}`));
  } else if (pagoPrevisto === 'transferencia') {
    d.append(el('p', 'pp-total', `Total a transferir: ${dinero.format(total)}`), el('p', 'pp-linea', 'Concepto: el nombre de quien pide · CLABE en la pantalla del cliente'));
  } else {
    d.append(el('p', 'pp-total', `Total en efectivo: ${dinero.format(total)}`));
    const fila = el('label', 'pp-recibido', '¿Con cuánto paga? ');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.inputMode = 'decimal'; inp.min = '0'; inp.step = '1'; inp.id = 'pp-recibido'; inp.placeholder = '0'; inp.value = previo;
    const cambio = el('p', 'pp-cambio');
    const calc = () => { const v = parseFloat(inp.value); cambio.textContent = Number.isFinite(v) && v > 0 ? (v >= total ? `Cambio: ${dinero.format(v - total)}` : `Faltan ${dinero.format(total - v)}`) : ''; };
    inp.addEventListener('input', calc);
    fila.append(inp);
    d.append(fila, cambio);
    calc();
  }
}
document.querySelectorAll('#pp-botones .btn').forEach((b) => b.addEventListener('click', () => {
  pagoPrevisto = pagoPrevisto === b.dataset.pago ? null : b.dataset.pago;   // tocar otra vez lo quita
  pintarPago();
}));

function pintarPlatos() {
  const caja = $('platos');
  caja.replaceChildren(el('span', 'platos-et', 'Plato:'));
  for (let n = 1; n <= maxPlato(); n++) {
    const b = el('button', 'btn plato-chip' + (n === platoActual ? ' activo' : ''), String(n) + (esLlevar(n) ? ' 🥡' : ''));
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

/* El pedido en curso sobrevive a una recarga accidental de la página. */
function guardarCarrito() {
  try {
    sessionStorage.setItem(claveLS('pedido_en_curso'), JSON.stringify({
      cliente: $('cliente').value, notas: $('notas-orden').value,
      plato: platoActual,
      llevar: [...platosLlevar],
      // "Agregando al pedido #…": se recuerda para que, si la página se recarga, no vuelva a pedir el nombre del cliente
      destino: ordenDestino ? { id: ordenDestino.id, turno: ordenDestino.turno, nombre_cliente: ordenDestino.nombre_cliente, modalidad: ordenDestino.modalidad, llevarPlatos: ordenDestino.llevarPlatos, platos: ordenDestino.platos, desdeCocina: venimosDeCocina } : null,
      lineas: carrito.map((l) => ({ id: l.producto.id, extras: l.extras.map((x) => x.id), cantidad: l.cantidad, notas: l.notas, plato: l.plato })),
    }));
  } catch { /* sin almacenamiento: no pasa nada */ }
}
let pendiente = null;
function restaurarCarrito() {
  try { pendiente = JSON.parse(sessionStorage.getItem(claveLS('pedido_en_curso')) || 'null'); } catch { pendiente = null; }
  if (!pendiente) return;
  $('cliente').value = pendiente.cliente || '';
  $('notas-orden').value = pendiente.notas || '';
  // se reconstruye en cargarMenu() con datos frescos
  carrito = (pendiente.lineas || []).map((l) => ({ producto: { id: l.id }, extras: l.extras.map((id) => ({ id })), cantidad: l.cantidad, notas: l.notas || '', plato: l.plato || 1 }));
  platoActual = pendiente.plato || 1;
  platosLlevar.clear(); (pendiente.llevar || []).forEach((n) => platosLlevar.add(n));
}
$('cliente').addEventListener('input', guardarCarrito);
$('notas-orden').addEventListener('input', guardarCarrito);

$('btn-vaciar').addEventListener('click', async () => {
  if (carrito.length === 0 || await confirmar('¿Vaciar el pedido en curso?', { si: 'Vaciar', peligro: true })) vaciarTodo();
});
/* Modo "agregar a un pedido ya levantado" (el cliente pidió algo más) */
let ordenDestino = null;
function fijarDestino(o) {
  ordenDestino = o;
  if (o) (o.llevarPlatos || []).forEach((n) => platosLlevar.add(n));
  platosBase = o ? (o.platos || 1) : 0;
  if (o) platoActual = platosBase;
  else platoActual = 1;
  $('destino').hidden = !o;
  $('datos-pedido').hidden = !!o;
  $('campos-cliente').hidden = !!o;
  if (typeof actualizarMesa === 'function') actualizarMesa();
  if (o) $('destino-texto').textContent = `Agregando al pedido #${o.turno.slice(-3)} · ${o.nombre_cliente}`;
  $('btn-levantar').textContent = o ? 'Agregar al pedido' : 'Levantar pedido';
  $('btn-levantar-pagar').textContent = o ? '💵 Agregar y pagar ahora' : '💵 Levantar y pagar ahora';
  pintarCarrito();
}
$('destino-quitar').addEventListener('click', () => { fijarDestino(null); avisar('Se canceló: vuelves a un pedido nuevo'); });

function vaciarTodo() {
  fijarDestino(null);
  fijarModalidad('aqui');
  $('telefono').value = '';
  $('mesa').value = '';
  cuando.fijar(null);
  cuando.fijar(null);
  platoActual = 1;
  platosLlevar.clear();
  pagoPrevisto = null;
  carrito = [];
  $('cliente').value = '';
  $('notas-orden').value = '';
  $('pedido-error').textContent = '';
  tokenPedido = nuevoToken();
  pintarCarrito();
}

/* Hoja del pedido en celular */
$('barra-carrito').addEventListener('click', () => $('carrito').classList.add('abierto'));
$('btn-cerrar-carrito').addEventListener('click', () => $('carrito').classList.remove('abierto'));

/* ------------------------------------------------------------------ */
/*  Código rápido:  "2Arra 1HChTodo xChil 1CharoChBAsa"                  */
/* ------------------------------------------------------------------ */

$('form-codigo').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const msg = $('codigo-msg');
  msg.textContent = '';
  const texto = $('codigo-rapido').value.trim();
  if (!texto) return;

  const r = interpretarCodigos(texto, menu, { plato: platoActual, maxPlato: maxPlato() });
  if (r.error) { msg.textContent = r.error; return; }
  const agotado = r.lineas.find((l) => l.producto.agotado);
  if (agotado) { msg.textContent = `${agotado.producto.nombre} está agotado hoy.`; return; }
  const sinOpcion = r.lineas.find((l) => faltaOpcion(l.producto, l.extras.map((x) => x.id)));
  if (sinOpcion) { msg.textContent = `${sinOpcion.producto.nombre} necesita una opción obligatoria: tócalo en el menú para elegirla.`; return; }
  const nuevas = r.lineas;
  for (const l of nuevas) agregarLinea(l.producto, l.extras, l.cantidad, '', l.plato);
  platoActual = r.plato;
  $('codigo-rapido').value = '';
  avisar(nuevas.length === 1 ? `${nuevas[0].producto.nombre} agregado` : `${nuevas.length} productos agregados`);
});

/* ------------------------------------------------------------------ */
/*  Levantar el pedido                                                 */
/* ------------------------------------------------------------------ */

async function levantar(pagarAhora = false) {
  if (enviando) return;
  const error = $('pedido-error');
  error.textContent = '';
  const cliente = $('cliente').value.trim();
  if (carrito.length === 0) { error.textContent = 'Agrega al menos un producto.'; return; }
  if (cuando.incompleto()) { error.textContent = 'Completa la hora del pedido agendado (hora, minutos y AM/PM) o quita la agenda.'; return; }
  if (mesaObligatoria()) {
    if (!mesas.length) { error.textContent = 'Esta sucursal no tiene mesas. Pide al administrador que las cree en “Sucursales y mesas”.'; return; }
    if (!$('mesa').value) { error.textContent = 'Elige la mesa del pedido.'; $('mesa').focus(); return; }
  } else if (!cliente && !ordenDestino && !nombreOpcional()) { error.textContent = modalidad === 'aqui' && mesas.length ? 'Elige la mesa o escribe el nombre del cliente.' : 'Escribe el nombre del cliente.'; $('cliente').focus(); return; }

  enviando = true;
  const boton = pagarAhora ? $('btn-levantar-pagar') : $('btn-levantar');
  $('btn-levantar').disabled = true; $('btn-levantar-pagar').disabled = true;
  boton.textContent = 'Enviando…';
  try {
    const r = await enviarJson(API + 'ordenes.php', {
      token: tokenPedido,
      orden_id: ordenDestino ? ordenDestino.id : undefined,
      nombre_cliente: cliente,
      modalidad,
      mesa_id: modalidad === 'aqui' && $('mesa').value ? Number($('mesa').value) : undefined,
      pago_previsto: pagoPrevisto || undefined,
      telefono: modalidad === 'recoger' ? $('telefono').value.trim() : undefined,
      ...cuando.datos(),
      notas: $('notas-orden').value.trim(),
      items: carrito.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad, extras: l.extras.map((x) => x.id), notas: l.notas, plato: l.plato, llevar: esLlevar(l.plato) })),
    });
    $('listo-titulo').textContent = ordenDestino ? 'Productos agregados al pedido' : 'Pedido levantado';
    $('listo-turno').textContent = r.orden.turno;
    $('listo-cliente').textContent = r.orden.nombre_cliente;
    $('listo-total').textContent = dinero.format(r.orden.total);
    const esp = $('listo-espera');
    esp.hidden = r.orden.estimado == null && !r.orden.para;
    esp.textContent = r.orden.estimado != null ? `⏱ Tiempo de espera estimado: ${r.orden.estimado} min` + (r.orden.delante > 0 ? ` · ${r.orden.delante} ${r.orden.delante === 1 ? 'pedido' : 'pedidos'} por delante` : '')
      : r.orden.para ? `📅 Agendado para las ${hora12(r.orden.para)}` : '';
    $('carrito').classList.remove('abierto');
    vaciarTodo();
    if (pagarAhora) {   // directo a Caja con la ventana de cobro de este pedido abierta
      location.href = '../caja/?orden=' + r.orden.id;
      return;
    }
    if (venimosDeCocina) {   // vienen de editar en cocina: regresan solos a la cocina (no levantan pedidos nuevos)
      avisar('Agregado al pedido ✓');
      setTimeout(() => { location.href = '../cocina/'; }, 600);
      return;
    }
    $('listo-volver').hidden = true;
    $('dlg-listo').showModal();
  } catch (err) {
    error.textContent = err.message;
    avisar(err.message, true);   // también como aviso grande, por si el panel del pedido está cerrado
    if (err.estado === 401) await iniciar();
  } finally {
    enviando = false;
    $('btn-levantar').disabled = false; $('btn-levantar-pagar').disabled = false;
    $('btn-levantar').textContent = ordenDestino ? 'Agregar al pedido' : 'Levantar pedido';
    $('btn-levantar-pagar').textContent = ordenDestino ? '💵 Agregar y pagar ahora' : '💵 Levantar y pagar ahora';
  }
}
$('btn-levantar').addEventListener('click', () => levantar(false));
$('btn-levantar-pagar').addEventListener('click', () => levantar(true));
$('listo-nuevo').addEventListener('click', () => { $('dlg-listo').close(); $('codigo-rapido').focus(); });

/* ------------------------------------------------------------------ */
/*  Editar un pedido ya levantado (aunque ya esté listo)               */
/* ------------------------------------------------------------------ */

const edCuando = montarCuando($('ed-cuando'), { abierto: true });
let editandoId = null;
let editandoOrden = null;
const ESTADO_ITEM = { pendiente: 'Pendiente', preparando: 'Preparando', listo: 'Listo' };

async function abrirEditar(id) {
  editandoId = id;
  edCuando.fijar(null);
  $('ed-error').textContent = '';
  if (await refrescarEditar()) { if (!$('dlg-editar').open) $('dlg-editar').showModal(); }
}

async function refrescarEditar() {
  try {
    const r = await pedir(API + 'ordenes.php');
    editandoOrden = r.ordenes.find((o) => o.id === editandoId) || null;
  } catch (err) { $('ed-error').textContent = err.message; return false; }
  if (!editandoOrden || !['nueva', 'preparando', 'lista'].includes(editandoOrden.estado)) {
    if ($('dlg-editar').open) $('dlg-editar').close();
    avisar('Ese pedido ya no se puede editar');
    return false;
  }
  pintarEditar();
  return true;
}

function pintarEditar() {
  const o = editandoOrden;
  $('ed-titulo').textContent = `#${o.turno.slice(-3)} · ${o.nombre_cliente}` + (o.mesa ? ` · ${etiquetaMesa(o)}` : '');
  $('ed-mesa-fila').hidden = !mesas.length;
  const sm = mesas.find((m) => m.nombre === o.mesa && (o.mesa_zona ? (zonasPed.find((z) => z.id === m.zona_id) || {}).nombre === o.mesa_zona : true));
  $('ed-mesa').value = sm ? String(sm.id) : '';
  document.querySelectorAll('#ed-modalidad .mod-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mod === o.modalidad)));
  $('ed-total').textContent = `Total ${dinero.format(o.total)} · ${ETIQUETA_ESTADO[o.estado]}` + (o.para ? ` · 🕒 para las ${hora12(o.para)}` : '');
  const caja = $('ed-platos');
  caja.replaceChildren();
  const platos = [...new Set(o.items.map((i) => i.plato))].sort((a, b) => a - b);
  for (const n of platos) {
    const bloque = el('section', 'ed-plato');
    const llevaN = o.items.some((x) => x.plato === n && x.llevar);
    bloque.append(el('h3', 'plato-titulo' + (llevaN ? ' llevar' : ''), `Plato ${n}` + (llevaN ? ' · 🥡 PARA LLEVAR' : '')));
    for (const i of o.items.filter((x) => x.plato === n)) {
      const fila = el('div', 'ed-item');
      const extras = i.extras.map((x) => x.nombre).join(', ');
      const txt = el('div', 'ed-nombre', i.nombre + (extras ? ' — ' + extras : ''));
      txt.append(el('span', 'estado-chip', ESTADO_ITEM[i.estado]));
      fila.append(txt);
      if (i.notas) fila.append(el('div', 'linea-detalle', `“${i.notas}”`));
      const ctl = el('div', 'linea-ctl');
      const menos = el('button', 'btn', '−'); menos.type = 'button'; menos.disabled = i.cantidad <= 1;
      const num = el('output', '', String(i.cantidad));
      const mas = el('button', 'btn', '＋'); mas.type = 'button'; mas.disabled = i.cantidad >= 50;
      const quitar = el('button', 'btn peligro quitar', 'Quitar'); quitar.type = 'button';
      menos.addEventListener('click', () => accionEditar({ accion: 'cantidad', item_id: i.id, cantidad: i.cantidad - 1 }));
      mas.addEventListener('click', () => accionEditar({ accion: 'cantidad', item_id: i.id, cantidad: i.cantidad + 1 }));
      quitar.addEventListener('click', async () => {
        if (await confirmar(`¿Quitar ${i.cantidad}× ${i.nombre} del pedido?`, { si: 'Quitar', peligro: true })) accionEditar({ accion: 'quitar_item', item_id: i.id });
      });
      ctl.append(menos, num, mas, quitar);
      if (i.estado !== 'listo') {
        const sale = el('button', 'btn salio', '✓ Ya salió');
        sale.type = 'button';
        sale.title = 'Marcar este renglón como ya hecho/entregado';
        sale.addEventListener('click', () => accionEditar({ accion: 'item', item_id: i.id, estado: 'listo' }));
        ctl.append(sale);
      }
      fila.append(ctl);
      bloque.append(fila);
    }
    const agregar = el('button', 'btn', `＋ Agregar al plato ${n}`);
    agregar.type = 'button';
    agregar.addEventListener('click', () => agregarAPlato(n));
    bloque.append(agregar);
    caja.append(bloque);
  }
  pintarAccionesEditar(o);
}

/* Cerrar, cobrar o cancelar el pedido desde el mismo editor */
function pintarAccionesEditar(o) {
  const caja = $('ed-acciones');
  caja.replaceChildren();
  const pago = el('div', 'ed-pago ' + (o.pagado ? 'ok' : 'debe'));
  pago.append(el('span', '', o.pagado ? 'Pagado ✓' : 'Sin pagar'), el('strong', '', dinero.format(o.total)));
  if (!o.pagado) {
    const cb = el('a', 'btn principal', '💵 Cobrar en caja');
    cb.href = '../caja/?orden=' + o.id;
    pago.append(cb);
  }
  caja.append(pago);

  const fila = el('div', 'ed-fila-botones');
  const cerrar = el('button', 'btn verde', '✓ Ya se entregó todo');
  cerrar.type = 'button';
  cerrar.addEventListener('click', async () => {
    if (!(await confirmar(`¿Marcar todo el pedido de ${o.nombre_cliente} como entregado?`, { si: 'Entregado' }))) return;
    try { await enviarJson(API + 'cocina.php', { accion: 'cerrar', orden_id: o.id }); $('dlg-editar').close(); avisar(`Pedido #${o.turno.slice(-3)} entregado` + (o.pagado ? '' : ' · falta cobrar')); }
    catch (err) { $('ed-error').textContent = err.message; }
  });
  const cancelar = el('button', 'btn peligro', 'Cancelar pedido');
  cancelar.type = 'button';
  cancelar.addEventListener('click', async () => {
    if (!(await confirmar(`¿Cancelar el pedido #${o.turno.slice(-3)} de ${o.nombre_cliente}? La cocina recibirá un aviso.` + (o.pagado ? '\n\nYa estaba pagado: Caja lo mostrará para devolver el dinero.' : ''), { si: 'Cancelar pedido', no: 'Volver', peligro: true }))) return;
    try { await enviarJson(API + 'cocina.php', { accion: 'cancelar', orden_id: o.id }); $('dlg-editar').close(); avisar(`Pedido #${o.turno.slice(-3)} cancelado`); }
    catch (err) { $('ed-error').textContent = err.message; }
  });
  fila.append(cerrar, cancelar);
  caja.append(fila);
}

$('ed-mesa').addEventListener('change', () => { if (editandoOrden) accionEditar({ accion: 'mesa', orden_id: editandoOrden.id, mesa_id: Number($('ed-mesa').value) || 0 }); });
document.querySelectorAll('#ed-modalidad .mod-btn').forEach((b) => b.addEventListener('click', () => {
  if (editandoOrden && editandoOrden.modalidad !== b.dataset.mod) accionEditar({ accion: 'modalidad', orden_id: editandoOrden.id, modalidad: b.dataset.mod });
}));

$('ed-cuando-guardar').addEventListener('click', () => {
  if (edCuando.incompleto()) { $('ed-error').textContent = 'Escribe la hora.'; return; }
  accionEditar({ accion: 'programar', orden_id: editandoId, ...edCuando.datos() });
});

async function accionEditar(cuerpo) {
  $('ed-error').textContent = '';
  try { await enviarJson(API + 'cocina.php', cuerpo); } catch (err) { $('ed-error').textContent = err.message; }
  await refrescarEditar();
}

function agregarAPlato(n) {
  const o = editandoOrden;
  $('dlg-editar').close();
  mostrar('vista-pedido');
  fijarDestino({ id: o.id, turno: o.turno, nombre_cliente: o.nombre_cliente, modalidad: o.modalidad, llevarPlatos: o.items.filter((i) => i.llevar).map((i) => i.plato), platos: Math.max(1, ...o.items.map((i) => i.plato || 1)) });
  platoActual = n;
  pintarCarrito();
  $('codigo-rapido').focus();
}
$('ed-agregar-menu').addEventListener('click', () => agregarAPlato(Math.max(1, ...editandoOrden.items.map((i) => i.plato || 1))));
$('ed-nuevo-plato').addEventListener('click', () => agregarAPlato(Math.max(1, ...editandoOrden.items.map((i) => i.plato || 1)) + 1));
$('ed-cerrar').addEventListener('click', () => $('dlg-editar').close());
$('dlg-editar').addEventListener('close', () => { if (!$('vista-seguimiento').hidden) cargarSeguimiento(); });

/* ------------------------------------------------------------------ */
/*  Seguimiento: cómo van los pedidos (para informar al cliente)       */
/* ------------------------------------------------------------------ */

let segDatos = null, segRecibido = 0, segTimer = null, segCargando = false, segFirma = '', segEstados = new Map();

function detenerSeguimiento() { if (segTimer) segTimer.detener(); segTimer = null; }

function abrirSeguimiento() {
  mostrar('vista-seguimiento');
  segDatos = null; segFirma = ''; segEstados = new Map();
  cargarSeguimiento();
  detenerSeguimiento();
  segTimer = suscribirCambios(cargarSeguimiento, { respaldoMs: 3000, url: API + 'eventos' });
}
$('btn-seguimiento').addEventListener('click', abrirSeguimiento);
$('btn-tomar').addEventListener('click', () => mostrar('vista-pedido'));

async function cargarSeguimiento() {
  if (segCargando) return;
  segCargando = true;
  try {
    const r = await pedir(API + 'cocina.php?estacion=0');
    segDatos = r; segRecibido = performance.now();
    // aviso cuando un pedido pasa a "lista"
    for (const o of r.listas) {
      if (segEstados.get(o.id) && segEstados.get(o.id) !== 'lista') avisar(`¡Pedido #${o.turno.slice(-3)} de ${o.cliente} está listo!`);
    }
    segEstados = new Map([...r.ordenes, ...r.listas].map((o) => [o.id, o.estado]));
    const f = JSON.stringify([r.por_cobrar || [], r.ordenes, r.listas, r.programadas || []].map((l) => l.map((o) => ({ ...o, espera: 0, puntaje: 0, restante: 0, estimado: 0, pos: 0 }))));
    if (f !== segFirma) { segFirma = f; pintarSeguimiento(); }
    relojSeguimiento();
  } catch (err) {
    if (err.estado === 401) { detenerSeguimiento(); await iniciar(); }
  } finally { segCargando = false; }
}

function hora12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

const segExpandidos = new Set();   // pedidos con la lista de platillos abierta (sobrevive a las actualizaciones)
function tarjetaSeg(o, lista, programada = false) {
  const c = el('article', 'seg-tarjeta ' + (o.modalidad === 'aqui' ? 'aqui' : 'llevar') + (o.modalidad === 'recoger' ? ' recoger' : '') + (lista ? ' lista' : ''));
  c.dataset.espera = String(o.espera);
  const cab = el('div', 'seg-cab');
  const izq = el('div', 'seg-izq');
  izq.append(el('div', 'seg-cliente', o.cliente + (o.origen === 'qr' ? ' 📱' : '')));
  const datos = el('div', 'seg-datos');
  datos.append(el('span', 'seg-turno', '#' + o.turno.slice(-3)), chipModalidad(o.modalidad), ...(o.mesa ? [el('span', 'chip-mesa', '🪑 ' + etiquetaMesa(o))] : []), el('span', '', 'Levantado ' + hora12(o.hora)), el('strong', '', dinero.format(o.total)), el('span', 'estado-chip' + (o.pagado ? '' : ' sin-pagar'), o.pagado ? 'Pagado ✓' : 'Sin pagar'));
  izq.append(datos);
  const t = el('div', 'seg-espera');
  if (programada) t.append(el('span', 'seg-min seg-prog', hora12(o.para)), el('span', 'seg-lbl', 'agendado'));
  else {
    t.append(el('span', 'seg-min', lista ? '✓' : '—'), el('span', 'seg-lbl', lista ? 'lista' : 'faltan'));
    if (!lista && o.restante != null) { t.dataset.rest = String(o.restante); pintarRestante(t, o.restante, '.seg-min', '.seg-lbl'); }
    if (o.urgente && !lista) c.classList.add('urgente');
  }
  if (!programada && !lista) datos.append(el('span', 'seg-trans', '⏱ 0:00'));
  if (!programada && o.para && !lista) datos.append(el('span', 'chip-para', '🕒 ' + hora12(o.para)));
  cab.append(izq, t);
  c.append(cab);

  const total = o.items.length;
  const listos = o.items.filter((i) => i.estado === 'listo').length;
  const barra = el('div', 'seg-progreso');
  const rel = el('div', 'seg-relleno');
  rel.style.width = `${total ? Math.round((listos / total) * 100) : 0}%`;
  barra.append(rel);
  c.append(barra, el('div', 'seg-cuenta', `${listos} de ${total} renglones listos`));

  const varios = new Set(o.items.map((i) => i.plato)).size > 1 || o.items.some((i) => i.llevar);
  let platoVisto = 0;
  const ul = el('div', 'seg-items');
  for (const i of o.items) {
    if (varios && i.plato !== platoVisto) { platoVisto = i.plato; ul.append(el('h4', 'plato-titulo' + (o.items.some((x) => x.plato === i.plato && x.estado !== 'listo') ? ' con-pendientes' : '') + (i.llevar ? ' llevar' : ''), `Plato ${i.plato}` + (i.llevar ? ' · 🥡 PARA LLEVAR' : ''))); }
    const f = el('div', 'seg-item estado-' + i.estado);
    const extras = i.extras.map((x) => x.nombre).join(', ');
    f.append(el('span', '', `${i.cantidad}× ${i.nombre}${extras ? ' — ' + extras : ''}`), el('span', 'estado-chip', ESTADO_ITEM[i.estado]));
    ul.append(f);
  }
  // Se ve lo que falta; lo que ya está listo se oculta tras "Ver todos"
  const abierto = segExpandidos.has(o.id);
  ul.classList.toggle('ver-listos', abierto);
  const ver = el('button', 'btn seg-ver', '');
  ver.type = 'button';
  const textoVer = () => (ul.classList.contains('ver-listos') ? '▴ Ocultar los listos' : `▾ Ver todos (${listos} listo${listos === 1 ? '' : 's'} oculto${listos === 1 ? '' : 's'})`);
  ver.textContent = textoVer();
  ver.addEventListener('click', () => {
    const abre = !ul.classList.contains('ver-listos');
    ul.classList.toggle('ver-listos', abre);
    if (abre) segExpandidos.add(o.id); else segExpandidos.delete(o.id);
    ver.textContent = textoVer();
  });
  if (listos > 0) c.append(ver);
  c.append(ul);

  const acc = el('div', 'seg-acciones');
  if (lista) {
    const en = el('button', 'btn principal seg-entregar', 'Entregado ✓');
    en.type = 'button';
    en.addEventListener('click', async () => {
      try { await enviarJson(API + 'cocina.php', { accion: 'entregar', orden_id: o.id }); avisar(`Pedido #${o.turno.slice(-3)} entregado`); }
      catch (err) { avisar(err.message, true); }
      cargarSeguimiento();
    });
    acc.append(en);
  }
  if (!o.pagado) {
    const cb = el('a', 'btn seg-cobrar-btn', '💵 Cobrar');
    cb.href = '../caja/?orden=' + o.id;
    acc.append(cb);
  }
  const ed = el('button', 'btn seg-editar', '✎');
  ed.type = 'button';
  ed.title = 'Editar pedido';
  ed.setAttribute('aria-label', 'Editar pedido');
  ed.addEventListener('click', () => abrirEditar(o.id));
  acc.append(ed);
  c.append(acc);
  return c;
}

function pintarSeguimiento() {
  const r = segDatos;
  const pc = r.por_cobrar || [];
  $('seg-cobrar').replaceChildren(...pc.map((o) => {
    const t = el('div', 'seg-cobrar-item');
    t.append(el('span', 'nombre', `#${o.turno.slice(-3)} ${o.cliente}`), el('strong', '', dinero.format(o.total)));
    const cb = el('a', 'btn principal', '💵 Cobrar');
    cb.href = '../caja/?orden=' + o.id;
    const ed = el('button', 'btn', '✎ Agregar / editar');
    ed.type = 'button';
    ed.addEventListener('click', () => reabrirYEditar(o.id, o.cliente));
    t.append(ed, cb);
    return t;
  }));
  $('seg-cobrar-bloque').hidden = pc.length === 0;
  $('seg-cobrar-n').textContent = `(${pc.length})`;
  $('seg-listas').replaceChildren(...r.listas.map((o) => tarjetaSeg(o, true)));
  $('seg-listas-bloque').hidden = r.listas.length === 0;
  $('seg-listas-n').textContent = `(${r.listas.length})`;
  const prog = r.programadas || [];
  $('seg-prog').replaceChildren(...prog.map((o) => tarjetaSeg(o, false, true)));
  $('seg-prog-bloque').hidden = prog.length === 0;
  $('seg-prog-n').textContent = `(${prog.length})`;
  const tab = $('seg-tablero');
  tab.replaceChildren(...r.ordenes.map((o) => tarjetaSeg(o, false)));
  if (r.ordenes.length === 0) tab.append(el('p', 'vacio', 'No hay pedidos en preparación.'));
  $('seg-prep-titulo').hidden = r.listas.length === 0 && prog.length === 0;
  $('seg-resumen').textContent = `${r.ordenes.length} en preparación · ${r.listas.length} listos · ${prog.length} agendados`;
}

function relojSeguimiento() {
  if (!segDatos) return;
  const extra = Math.floor((performance.now() - segRecibido) / 1000);
  for (const c of document.querySelectorAll('.seg-tarjeta')) {
    if (c.querySelector('.seg-prog')) continue;
    const seg = Number(c.dataset.espera) + extra;
    const min = Math.floor(seg / 60);
    const tr = c.querySelector('.seg-trans');
    if (tr) tr.textContent = `⏱ ${min}:${String(seg % 60).padStart(2, '0')}`;
  }
  for (const e of document.querySelectorAll('.seg-espera[data-rest]')) {
    pintarRestante(e, Number(e.dataset.rest) - extra, '.seg-min', '.seg-lbl');
  }
}
setInterval(relojSeguimiento, 1000);

/* ------------------------------------------------------------------ */
/*  Etiquetas de estado                                                */
/* ------------------------------------------------------------------ */

const ETIQUETA_ESTADO = { nueva: 'Levantado', preparando: 'En preparación', lista: 'Lista', entregada: 'Entregada', cancelada: 'Cancelada' };

iniciar();





