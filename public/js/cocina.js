/**
 * Tablero de cocina: cada tablet elige su parrilla, ve todos los pedidos
 * (primero los suyos, por prioridad), marca renglones con un toque y suena
 * cuando llega un pedido nuevo. Se actualiza solo cada pocos segundos.
 */

const API = '../api/';
const $ = (id) => document.getElementById(id);
const SIGUIENTE = { pendiente: 'preparando', preparando: 'listo', listo: 'preparando' };
const ETIQUETA = { pendiente: 'Pendiente', preparando: 'Preparando', listo: 'Listo' };
const NIVEL_TEXTO = ['', '⚡ ALTA', '⚡⚡ URGENTE'];

let estacionId = null;          // 0 = vista general
let estaciones = [];
let datos = null;               // última respuesta de cocina.php
let recibidoEn = 0;             // performance.now() de esa respuesta
let firma = '';
let vistos = new Set();
let primeraCarga = true;
let cargando = false;
let detallesAbiertos = new Set();
let nombresCompletos = false;
let silenciado = false;
let temporizadorPeticion = null;

/* ------------------------------------------------------------------ */
/*  Almacenamiento ligero (puede fallar en modo privado)               */
/* ------------------------------------------------------------------ */
const guardar = (k, v) => { try { localStorage.setItem(claveLS(k), v); } catch { /* sin almacenamiento */ } };
const leer = (k) => { try { return localStorage.getItem(claveLS(k)); } catch { return null; } };

/* ------------------------------------------------------------------ */
/*  Sonido (se genera en el navegador: no hay archivos de audio)       */
/* ------------------------------------------------------------------ */
let audio = null;

function desbloquearAudio() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  }
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  etiquetaSonido();
}
// Los navegadores exigen un toque del usuario antes de permitir sonido.
document.addEventListener('pointerdown', desbloquearAudio, { once: false });

function campana() {
  if (silenciado || !audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  [[880, 0], [1175, 0.2], [880, 0.5], [1175, 0.7]].forEach(([f, d]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.6, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
    o.connect(g).connect(audio.destination);
    o.start(t + d);
    o.stop(t + d + 0.2);
  });
  try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch { /* sin vibración */ }
}

/* Sonido de "pedido modificado o cancelado": distinto al de pedido nuevo (más grave, tipo alarma doble). */
function campanaEdicion() {
  if (silenciado || !audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  [[392, 0], [523, 0.14], [392, 0.42], [523, 0.56], [392, 0.84], [523, 0.98]].forEach(([f, d]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'square';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.28, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.12);
    o.connect(g).connect(audio.destination);
    o.start(t + d);
    o.stop(t + d + 0.14);
  });
  try { navigator.vibrate && navigator.vibrate([300, 100, 300, 100, 300]); } catch { /* sin vibración */ }
}

function etiquetaSonido() {
  const b = $('btn-sonido');
  const activo = audio && audio.state === 'running';
  b.textContent = silenciado ? '🔕 Silenciado' : activo ? '🔔 Sonido activo' : '🔇 Toca para activar sonido';
  b.classList.toggle('apagado', silenciado || !activo);
  // Con la barra escondida, un avisito flotante si el sonido no está listo
  const f = $('sonido-flotante');
  if (f) f.hidden = !(document.body.classList.contains('barra-auto') && (silenciado || !activo));
}
const alternarSonido = () => {
  desbloquearAudio();
  if (audio && audio.state === 'running' && !silenciado) {
    // un segundo toque con el sonido activo lo silencia; con "Silenciado" lo reactiva
    silenciado = true;
  } else {
    silenciado = false;
  }
  guardar('cocina_silencio', silenciado ? '1' : '0');
  etiquetaSonido();
  if (!silenciado) setTimeout(campana, 150);       // prueba
};
$('btn-sonido').addEventListener('click', alternarSonido);
$('sonido-flotante').addEventListener('click', alternarSonido);
setInterval(etiquetaSonido, 3000);

/* Que la pantalla no se apague (si el navegador lo permite) */
let bloqueo = null;
async function mantenerPantalla() {
  try { if ('wakeLock' in navigator) bloqueo = await navigator.wakeLock.request('screen'); } catch { /* no disponible */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') mantenerPantalla(); });

/* ------------------------------------------------------------------ */
/*  Pantallas y sesión                                                 */
/* ------------------------------------------------------------------ */
function mostrar(vista) {
  for (const id of ['vista-login', 'vista-aviso', 'vista-tablero']) $(id).hidden = id !== vista;
  $('barra-cocina').hidden = vista === 'vista-login' || vista === 'vista-aviso';
  // En el tablero, la barra superior se esconde para dar espacio; se muestra al tocar un lugar vacío.
  document.body.classList.toggle('barra-auto', vista === 'vista-tablero');
  if (vista !== 'vista-tablero') mostrarBarra(false);
}

/* ---- Barra superior que se esconde (tocar fuera de botones y comandas la muestra) ---- */
let tBarra = null;
function mostrarBarra(si) {
  document.body.classList.toggle('barra-visible', si);
  clearTimeout(tBarra);
  if (si) tBarra = setTimeout(() => mostrarBarra(false), 10000);   // se vuelve a esconder sola
}
document.addEventListener('click', (ev) => {
  if (!document.body.classList.contains('barra-auto')) return;
  if (ev.target.closest('.comanda, .hamb, button, a, input, select, dialog, .toast, .aviso-cancel, .chip-lista, header')) {
    // tocar algo de la barra la mantiene a la vista otros 10 s
    if (ev.target.closest('header') && document.body.classList.contains('barra-visible')) mostrarBarra(true);
    return;
  }
  mostrarBarra(!document.body.classList.contains('barra-visible'));
});

function avisar(texto, conDeshacer = null) {
  const t = $('toast');
  $('toast-texto').textContent = texto;
  t.className = 'toast con-accion';
  $('toast-deshacer').hidden = !conDeshacer;
  $('toast-deshacer').onclick = conDeshacer ? () => { t.hidden = true; conDeshacer(); } : null;
  t.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { t.hidden = true; }, conDeshacer ? 6000 : 3000);
}

async function iniciar() {
  detenerPeticiones();
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

async function entrar(usuario) {
  $('quien').textContent = usuario.nombre;
  montarSucursal();
  silenciado = leer('cocina_silencio') === '1';
  etiquetaSonido();
  mantenerPantalla();
  try {
    const r = await pedir(API + 'cocina.php?estacion=0');
    estaciones = r.estaciones;
  } catch (err) {
    $('aviso-titulo').textContent = 'No se pudo abrir la cocina';
    $('aviso-texto').textContent = err.message;
    mostrar('vista-aviso');
    return;
  }
  elegirParrilla(0);   // una sola parrilla: todos los pedidos en un solo tablero
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
  detenerPeticiones();
  try { await pedir(API + 'logout.php', { method: 'POST' }); } catch { /* da igual */ }
  await iniciar();
});

/* ------------------------------------------------------------------ */
/*  Elegir parrilla                                                    */
/* ------------------------------------------------------------------ */
function elegirParrilla(id) {
  desbloquearAudio();
  estacionId = id;
  guardar('cocina_estacion', String(id));
  datos = null; firma = ''; vistos = new Set(); primeraCarga = true;
  $('titulo-parrilla').textContent = 'Pedidos en cocina';
  $('tablero').replaceChildren();
  mostrar('vista-tablero');
  cargar();
  temporizadorPeticion = setInterval(cargar, 2500);
}

function detenerPeticiones() {
  clearInterval(temporizadorPeticion);
  temporizadorPeticion = null;
}

/* ------------------------------------------------------------------ */
/*  Carga periódica                                                    */
/* ------------------------------------------------------------------ */
async function cargar(forzar = false) {
  if (estacionId === null) return;
  if (cargando) { if (!forzar) return; while (cargando) await new Promise((r) => setTimeout(r, 50)); }
  cargando = true;
  try {
    const r = await pedir(API + `cocina.php?estacion=${estacionId}`);
    datos = r;
    recibidoEn = performance.now();
    detectarNuevos();
    detectarEdiciones();
    const nueva = JSON.stringify([r.ordenes.map(quitarEspera), r.listas.map((o) => o.id), (r.programadas || []).map((o) => o.id)]);
    if (nueva !== firma) { firma = nueva; pintar(); }
    pintarListas();
    pintarProgramadas();
    if ($('dlg-pedido').open) pintarPedido();
    avanzarReloj();
    $('quien').classList.remove('sin-conexion');
  } catch (err) {
    if (err.estado === 401) { await iniciar(); return; }
    $('quien').classList.add('sin-conexion');
  } finally {
    cargando = false;
  }
}
const quitarEspera = (o) => ({ ...o, espera: 0, puntaje: 0, restante: 0, estimado: 0, pos: 0 });

function detectarNuevos() {
  const todos = [...datos.ordenes, ...datos.listas];
  const nuevos = todos.filter((o) => !vistos.has(o.id));
  for (const o of todos) vistos.add(o.id);
  if (primeraCarga) { primeraCarga = false; return; }
  const mios = nuevos.filter((o) => o.estado !== 'lista' && o.items.some((i) => i.mio));
  if (mios.length) {
    campana();
    avisar(mios.length === 1 ? `Pedido nuevo #${mios[0].turno.slice(-3)} · ${mios[0].cliente}` : `${mios.length} pedidos nuevos`);
    for (const o of mios) o.recien = true;
    recientes = new Set([...recientes, ...mios.map((o) => o.id)]);
    setTimeout(() => { for (const o of mios) recientes.delete(o.id); }, 6000);
  }
}
let recientes = new Set();

/* Pedidos modificados / cancelados mientras estaban en cocina */
const revVista = new Map();         // id → última revisión que esta tablet ya conoce
const expandidos = new Set();        // pedidos donde se muestran también los renglones ya listos
const modificados = new Map();      // id → hora de la edición (hasta que el cocinero toque "Entendido")
const cancelAvisos = new Map();     // id → { turno, cliente } (hasta "Entendido")
const canceladasVistas = new Set();
const propios = new Map();          // id → momento en que ESTA tablet lo editó (no suena para uno mismo)
let primeraRevision = true;

function detectarEdiciones() {
  const todos = [...datos.ordenes, ...datos.listas, ...(datos.programadas || [])];
  const editados = [];
  for (const o of todos) {
    const antes = revVista.get(o.id);
    if (antes !== undefined && o.revision > antes) {
      const mio = propios.has(o.id) && Date.now() - propios.get(o.id) < 8000;
      if (!mio && !primeraRevision) { editados.push(o); modificados.set(o.id, o.editado); }
    }
    revVista.set(o.id, o.revision);
  }
  const nuevasCanc = [];
  for (const c of datos.canceladas || []) {
    if (!canceladasVistas.has(c.id)) {
      canceladasVistas.add(c.id);
      if (!primeraRevision && !(propios.has(c.id) && Date.now() - propios.get(c.id) < 8000)) { cancelAvisos.set(c.id, c); nuevasCanc.push(c); }
    }
  }
  primeraRevision = false;
  if (editados.length || nuevasCanc.length) {
    campanaEdicion();
    avisar(nuevasCanc.length
      ? `🚫 Pedido #${nuevasCanc[0].turno.slice(-3)} de ${nuevasCanc[0].cliente} CANCELADO`
      : `✎ Pedido #${editados[0].turno.slice(-3)} de ${editados[0].cliente} MODIFICADO`);
    firma = '';
  }
}

/* ------------------------------------------------------------------ */
/*  Dibujo                                                             */
/* ------------------------------------------------------------------ */
function hora12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
const textoItem = (i) => [i.codigo || i.nombre, ...i.extras.map((x) => x.codigo || x.nombre)].join(' ');
const detalleItem = (i) => i.nombre + (i.extras.length ? ' — ' + i.extras.map((x) => x.nombre).join(', ') : '');

/* Las comandas se acomodan en el hueco más corto (como mosaico): una comanda larga ya no deja un espacio vacío
   debajo de las cortas; la siguiente sube a rellenarlo. Cada comanda ocupa tantas "filas finas" como mide de alto. */
const FILA_FINA = 2, SEPARACION = 8;
const medirComanda = (c) => { c.style.gridRowEnd = 'span ' + Math.ceil((c.getBoundingClientRect().height + SEPARACION) / FILA_FINA); };
const observadorHuecos = new ResizeObserver((lista) => { for (const e of lista) medirComanda(e.target); });
function ajustarHuecos() {
  observadorHuecos.disconnect();
  for (const c of document.querySelectorAll('.carril-cuerpo > .comanda')) { medirComanda(c); observadorHuecos.observe(c); }
}

/* Un cocinero puede enfocarse en un carril: "Comer aquí" o "Para llevar" se expande a todo el ancho y el otro baja. */
let urgPegados = new Set((() => { try { return JSON.parse(leer('cocina_urg_pegados') || '[]'); } catch { return []; } })());
let carrilesAnchos = new Set((leer('cocina_carril_ancho') || '').split(',').filter(Boolean));   // pueden estar los dos
function iconoAncho(expandido) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', expandido ? 'M10 4v6H4M14 20v-6h6M4 10l6-6M20 14l-6 6' : 'M4 10V4h6M20 14v6h-6M4 4l6 6M20 20l-6-6');
  svg.append(p);
  return svg;
}

function pintar() {
  const caja = $('tablero');
  caja.replaceChildren();
  caja.classList.add('carriles');
  for (const [id, c] of cancelAvisos) {
    const b = el('div', 'aviso-cancel');
    b.append(el('strong', '', `🚫 CANCELADO · #${c.turno.slice(-3)} ${c.cliente}`), el('span', '', 'No lo prepares; si ya empezaste, avisa a quien levanta pedidos.'));
    const ok = el('button', 'btn', 'Entendido');
    ok.type = 'button';
    ok.addEventListener('click', () => { cancelAvisos.delete(id); firma = ''; pintar(); });
    b.append(ok);
    caja.append(b);
  }
  // Dos carriles: "para llevar" a la izquierda y "comer aquí" (con prioridad, por orden de llegada) a la derecha.
  // "Por entregar": primero los que ya casi o están atrasados; los reabiertos con prioridad van primero (misma sección).
  // Un pedido que estaba en "por entregar" (urgente o con prioridad) y ya quedó completo se queda ahí
  // hasta que cocina pulse "Listo para entregar" (no regresa a su carril).
  const completoO = (o) => o.items.length > 0 && o.items.every((i) => i.estado === 'listo');
  for (const o of datos.ordenes) if (o.urgente || o.prioritario) urgPegados.add(o.id);
  const sigueUrg = (o) => !o.prioritario && !o.urgente && completoO(o) && urgPegados.has(o.id);
  guardar('cocina_urg_pegados', JSON.stringify([...urgPegados].filter((id) => datos.ordenes.some((o) => o.id === id))));
  const prio = datos.ordenes.filter((o) => o.prioritario);
  const urg = datos.ordenes.filter((o) => o.urgente && !o.prioritario).concat(datos.ordenes.filter(sigueUrg));
  if (urg.length || prio.length) {
    const carril = el('section', 'carril urgentes');
    carril.append(el('h3', 'carril-titulo', `⏰ POR ENTREGAR · menos de 5 min · atrasados · prioridad (${urg.length + prio.length})`));
    const cuerpo = el('div', 'carril-cuerpo');
    for (const o of prio) cuerpo.append(comanda(o, 'urgentes'));
    for (const o of urg) cuerpo.append(comanda(o, 'urgentes'));
    carril.append(cuerpo);
    caja.append(carril);
  }
  const llevar = datos.ordenes.filter((o) => o.modalidad !== 'aqui' && !o.prioritario && !o.urgente && !sigueUrg(o));   // llevar y recoger van juntos
  const aqui = datos.ordenes.filter((o) => o.modalidad === 'aqui' && !o.prioritario && !o.urgente && !sigueUrg(o));
  for (const [clase, titulo, lista, vacio] of [
    ['aqui', '🍽 Comer aquí', aqui, 'Sin pedidos para comer aquí.'],
    ['llevar', '🥡 Para llevar', llevar, 'Sin pedidos para llevar.'],
  ]) {
    const ancho = carrilesAnchos.has(clase);
    const carril = el('section', 'carril ' + clase + (ancho ? ' ancho' : ''));
    const encab = el('h3', 'carril-titulo');
    const boton = el('button', 'carril-ancho');
    boton.type = 'button';
    boton.title = ancho ? 'Contraer (volver a su mitad)' : 'Expandir a todo el ancho';
    boton.setAttribute('aria-label', boton.title);
    boton.setAttribute('aria-pressed', String(ancho));
    boton.append(iconoAncho(ancho));
    boton.addEventListener('click', () => {
      if (ancho) carrilesAnchos.delete(clase); else carrilesAnchos.add(clase);
      guardar('cocina_carril_ancho', [...carrilesAnchos].join(','));
      pintar();
    });
    encab.append(el('span', '', `${titulo} (${lista.length})`), boton);
    carril.append(encab);
    const cuerpo = el('div', 'carril-cuerpo');
    if (lista.length === 0) cuerpo.append(el('p', 'vacio', vacio));
    for (const o of lista) cuerpo.append(comanda(o, clase));
    carril.append(cuerpo);
    caja.append(carril);
  }
  pintarHamburguesas();
  ajustarHuecos();

  const pendientes = datos.ordenes.filter((o) => o.puntaje !== null).length;
  $('resumen-texto').textContent = estacionId === 0
    ? `${datos.ordenes.length} en cocina`
    : `${pendientes} con trabajo para ti · ${datos.ordenes.length} en cocina`;
}

/* Hamburguesas: cuántas y de qué tipo hay por preparar en TODOS los pedidos (casi siempre las hace una sola parrilla) */
let lotePlegado = leer('cocina_lote_plegado') === '1';
function pintarHamburguesas() {
  const caja = $('hamb');
  const lote = new Set((datos.lote || []).map((n) => String(n).toLowerCase()));
  const loteProductos = new Set(datos.lote_productos || []);   // platillos sueltos elegidos en Ajustes
  const grupos = new Map();
  for (const o of datos.ordenes) {
    for (const i of o.items) {
      if (!i.mio || i.estado === 'listo' || !(lote.has(String(i.categoria || '').toLowerCase()) || loteProductos.has(i.producto_id))) continue;
      const k = textoItem(i);
      const g = grupos.get(k) || { cant: 0, detalle: detalleItem(i), lineas: [] };
      g.cant += i.cantidad;
      g.lineas.push({ o, i });
      grupos.set(k, g);
    }
  }
  caja.replaceChildren();
  caja.hidden = grupos.size === 0;
  if (grupos.size === 0) return;
  const total = [...grupos.values()].reduce((a, g) => a + g.cant, 0);
  const tit = el('h3', '', `🍳 Preparar en lote · ${total}`);
  tit.title = 'Los mismos platillos de todos los pedidos, juntos. Toca un pedido para cambiar su estado: se refleja en su comanda.';
  const encab = el('div', 'hamb-encab');
  const bt = el('button', 'hamb-toggle', lotePlegado ? '▸ Ver todos' : '▾ Ocultar');
  bt.type = 'button';
  bt.setAttribute('aria-expanded', String(!lotePlegado));
  bt.addEventListener('click', () => { lotePlegado = !lotePlegado; guardar('cocina_lote_plegado', lotePlegado ? '1' : '0'); pintarHamburguesas(); });
  encab.append(tit, bt);
  caja.append(encab);
  caja.classList.toggle('plegado', lotePlegado);
  if (lotePlegado) return;                       // plegado: solo el título con el total
  caja.append(el('p', 'hamb-ayuda', 'Los mismos platillos de todos los pedidos, juntos. Toca un pedido para cambiar su estado (pendiente → preparando → listo): se refleja en su comanda.'));
  const fila = el('div', 'hamb-fila');
  const orden = [...grupos.entries()].sort((a, b) => b[1].cant - a[1].cant);
  for (const [k, g] of orden) {
    const c = el('div', 'hamb-chip');
    c.title = g.detalle;
    c.append(el('span', 'hamb-cant', g.cant + '×'), el('span', 'hamb-nombre', nombresCompletos ? g.detalle : k));
    const lineas = el('div', 'hamb-lineas');
    for (const { o, i } of g.lineas) {
      const b = el('button', 'hamb-linea estado-' + i.estado);
      b.type = 'button';
      b.append(el('strong', '', `#${o.turno.slice(-3)}${i.cantidad > 1 ? ' ×' + i.cantidad : ''}`), el('span', '', ETIQUETA[i.estado]));
      b.addEventListener('click', () => cambiarItem(o, i, SIGUIENTE[i.estado]));
      lineas.append(b);
    }
    c.append(lineas);
    const pend = g.lineas.filter((x) => x.i.estado === 'pendiente');
    const prep = g.lineas.filter((x) => x.i.estado === 'preparando');
    const acc = el('div', 'hamb-acc');
    if (pend.length) {
      const b = el('button', 'btn', '▶ Preparar todas');
      b.type = 'button';
      b.addEventListener('click', () => cambiarVarios(pend, 'preparando'));
      acc.append(b);
    }
    if (prep.length) {
      const b = el('button', 'btn verde', '✓ Todas listas');
      b.type = 'button';
      b.addEventListener('click', () => cambiarVarios(prep, 'listo'));
      acc.append(b);
    }
    if (acc.childNodes.length) c.append(acc);
    fila.append(c);
  }
  caja.append(fila);
}

/** Cambia varios renglones de golpe (resumen de hamburguesas) */
async function cambiarVarios(lineas, nuevo) {
  const antes = lineas.map(({ i }) => i.estado);
  lineas.forEach(({ i }) => { i.estado = nuevo; });
  firma = ''; pintar(); avanzarReloj();
  try {
    await Promise.all(lineas.map(({ i }, n) => enviarJson(API + 'cocina.php', { accion: 'item', item_id: i.id, estado: nuevo, desde: antes[n] })));
    avisar(`${lineas.length} ${lineas.length === 1 ? 'pedido' : 'pedidos'} → ${ETIQUETA[nuevo].toLowerCase()}`);
  } catch (err) { avisar(err.message); }
  cargar();
}

/** Logos que van bajo los minutos de la comanda. No se repite lo que ya dice el carril donde está:
 *  - en "Comer aquí": nada, salvo 🥡 si algún plato va para llevar;
 *  - en "Para llevar": nada para llevar (ya lo dice el carril), solo 🛍 si es para recoger;
 *  - en "Por entregar" (mezcla de todo): el logo del tipo de pedido y, si aplica, 🥡 de platos para llevar. */
function logosComanda(o, carril) {
  const logos = [];
  const platoLlevar = o.modalidad === 'aqui' && o.items.some((i) => i.llevar);
  if (carril === 'urgentes') logos.push(o.modalidad === 'aqui' ? '🍽' : o.modalidad === 'recoger' ? '🛍' : '🥡');
  else if (carril === 'llevar' && o.modalidad === 'recoger') logos.push('🛍');
  if (platoLlevar) logos.push('🥡');
  return logos.join(' ');
}

function comanda(o, carril = '') {
  const c = el('article', 'comanda' + (o.puntaje === null ? ' sin-trabajo' : '') + (recientes.has(o.id) ? ' recien' : ''));
  c.dataset.id = String(o.id);
  c.classList.add(o.modalidad === 'aqui' ? 'aqui' : 'llevar');
  if (o.modalidad === 'recoger') c.classList.add('recoger');
  if (o.prioritario) { c.classList.add('prioritaria'); c.append(cintaPrioridad()); }
  else if (o.revision > 0 && !o.urgente) { c.append(cintaPrioridad('✎ PEDIDO MODIFICADO', 'cinta-mod')); }
  c.dataset.espera = String(o.espera);

  const cab = el('div', 'com-cab');
  const quien = el('div', 'com-cliente', o.cliente);
  const datosLinea = el('div', 'com-datos');
  datosLinea.append(el('span', 'com-turno', '#' + o.turno.slice(-3)), ...(o.mesa ? [el('span', 'chip-mesa', '🪑 ' + o.mesa)] : []));
  if (o.para) datosLinea.append(el('span', 'chip-para' + (o.faltan !== null && o.faltan < 0 ? ' tarde' : ''), '🕒 Para las ' + hora12(o.para)));
  const izq = el('div', 'com-izq');
  izq.append(quien, datosLinea);
  const espera = el('div', 'com-espera');
  // Solo los minutos (sin "faltan"), y debajo el logo del tipo de pedido cuando aporta algo (ver logosComanda)
  espera.append(el('span', 'com-min', '—'));
  const logos = logosComanda(o, carril);
  if (logos) espera.append(el('span', 'com-logo', logos));
  if (o.restante != null) { espera.dataset.rest = String(o.restante); pintarRestante(espera, o.restante, '.com-min', '.sin-etiqueta'); }
  if (o.urgente) c.classList.add('urgente');
  cab.append(izq, espera);
  cab.title = o.turno;
  c.append(cab);
  if (modificados.has(o.id)) {
    c.classList.add('modificado');
    // Franja de una línea: "✎ Modificado · 7:05 pm". Tocarla la quita (equivale al antiguo botón "Entendido").
    const m = el('button', 'com-modificado');
    m.type = 'button';
    m.title = 'Toca para quitar este aviso';
    m.append(el('strong', '', '✎ Modificado' + (modificados.get(o.id) ? ' · ' + hora12(modificados.get(o.id)) : '')), el('span', 'com-mod-x', '✕'));
    m.addEventListener('click', () => { modificados.delete(o.id); firma = ''; pintar(); avanzarReloj(); });
    c.append(m);
  }
  if (o.notas) c.append(el('div', 'com-notas', o.notas));

  const varios = new Set(o.items.map((i) => i.plato)).size > 1;
  const rotular = varios || o.items.some((i) => i.llevar);   // con platos para llevar siempre se rotula el plato
  if (varios && o.items.some((i) => i.mio && i.estado !== 'listo')) c.append(resumenTotal(o));   // sin pendientes no se muestra "nada, todo listo"

  const nListos = o.items.filter((i) => i.estado === 'listo').length;
  const verTodos = expandidos.has(o.id);
  const completo = o.items.length > 0 && nListos === o.items.length;     // todos los renglones listos: la comanda se pliega
  if (completo) {
    c.classList.add('completo');
    const t = el('button', 'com-toggle', verTodos ? '▾ Ocultar' : `▸ Ver ${o.items.length} ${o.items.length === 1 ? 'platillo listo' : 'platillos listos'}`);
    t.type = 'button';
    t.addEventListener('click', () => { if (verTodos) expandidos.delete(o.id); else expandidos.add(o.id); firma = ''; pintar(); avanzarReloj(); });
    c.append(t);
  } else if (nListos > 0 && nListos < o.items.length) {
    const t = el('button', 'com-toggle', verTodos ? '▾ Ocultar listos' : `▸ Ver ${nListos} ${nListos === 1 ? 'listo' : 'listos'}`);
    t.type = 'button';
    t.addEventListener('click', () => { if (verTodos) expandidos.delete(o.id); else expandidos.add(o.id); firma = ''; pintar(); avanzarReloj(); });
    c.append(t);
  }
  const lista = el('div', 'com-items');
  let platoVisto = 0;
  for (const i of o.items) {
    const oculto = !verTodos && i.estado === 'listo' && nListos < o.items.length;
    if (rotular && i.plato !== platoVisto) {
      platoVisto = i.plato;
      const delPlato = o.items.filter((x) => x.plato === i.plato);
      const listos = delPlato.filter((x) => x.estado === 'listo').length;
      if (verTodos || listos < delPlato.length || nListos === o.items.length) {
        lista.append(el('h4', 'plato-cab' + (listos === delPlato.length ? ' completo' : '') + (i.llevar ? ' llevar' : ''), `Plato ${i.plato} · ${listos}/${delPlato.length} listos` + (i.llevar ? ' · 🥡 LLEVAR' : '')));
      }
    }
    if (!oculto && (!completo || verTodos)) lista.append(filaItem(o, i));
  }
  if (lista.childNodes.length) c.append(lista);

  // Solo "Editar pedido": se quitó la palomita de "todo listo" para no mandar un pedido a entregar por accidente.
  const pie = el('div', 'com-pie com-acciones solo-editar');
  const ed = el('button', 'btn com-editar', '✎ Editar pedido');
  ed.type = 'button';
  ed.addEventListener('click', () => abrirPedido(o.id));
  pie.append(ed);
  if (completo) {                      // el botón solo aparece cuando TODOS los renglones están listos (y se va si el pedido se reabre)
    const mover = el('button', 'btn verde com-mover', '✓ Listo');
    mover.type = 'button';
    mover.title = 'Listo para entregar: pasa este pedido a "listas para entregar"';
    mover.setAttribute('aria-label', 'Listo para entregar');
    mover.addEventListener('click', () => moverAListas(o));
    pie.append(mover);
  }
  c.append(pie);
  return c;
}

/* Pedido grande: cuánto hay que hacer EN TOTAL de cada cosa (solo lo pendiente de esta parrilla) */
function resumenTotal(o) {
  const suma = new Map();
  for (const i of o.items) {
    if (!i.mio || i.estado === 'listo') continue;
    const k = textoItem(i);
    suma.set(k, (suma.get(k) || 0) + i.cantidad);
  }
  const caja = el('div', 'com-total');
  caja.append(el('span', 'com-total-et', 'En total por hacer:'));
  if (suma.size === 0) caja.append(el('strong', '', 'nada, todo listo ✓'));
  for (const [k, n] of suma) caja.append(el('strong', 'com-total-i', `${n}× ${k}`));
  return caja;
}

/** Estado del renglón en un símbolo chico (el color del renglón lo refuerza): ○ pendiente · 🔥 preparando · ✓ listo */
function estadoIcono(estado) {
  const e = el('span', 'est', { pendiente: '○', preparando: '🔥', listo: '✓' }[estado]);
  e.title = ETIQUETA[estado];
  e.setAttribute('aria-label', ETIQUETA[estado]);
  return e;
}

function filaItem(o, i) {
  const fila = el('div', 'fila-item');
  const b = el('button', `it estado-${i.estado}` + (i.mio ? '' : ' otro'));
  b.type = 'button';
  // Con "Nombres completos" el código se cambia por el nombre del platillo (y sus extras), en letra más chica
  const abierto = nombresCompletos || detallesAbiertos.has(i.id);
  b.append(el('span', 'cant', `${i.cantidad}×`), el('span', 'cod' + (abierto ? ' nombre-completo' : ''), abierto ? detalleItem(i) : textoItem(i)), estadoIcono(i.estado));
  if (i.mio && i.nivel > 0 && i.estado !== 'listo') b.append(el('span', 'nivel', NIVEL_TEXTO[i.nivel]));
  if (!i.mio) {
    const e = estaciones.find((x) => x.id === i.estacion_id);
    b.append(el('span', 'parrilla-etiqueta', e ? e.nombre : ''));
  }
  if (i.notas) b.append(el('span', 'nota', `“${i.notas}”`));

  if (i.mio) b.addEventListener('click', () => cambiarItem(o, i, SIGUIENTE[i.estado]));
  else b.disabled = true;

  fila.append(b);
  return fila;
}

$('btn-nombres').addEventListener('click', () => {
  nombresCompletos = !nombresCompletos;
  $('btn-nombres').setAttribute('aria-pressed', String(nombresCompletos));
  if (datos) { pintar(); avanzarReloj(); }
});

/* Pedidos agendados (sección al final, colapsada): se ven ordenados por hora de entrega, con lo que lleva cada uno y
   en cuánto tiempo entran a la fila de cocina. El <details> no se vuelve a crear, así que si lo abres sigue abierto al refrescar. */
function pintarProgramadas() {
  const p = datos.programadas || [];
  $('bloque-prog').hidden = p.length === 0;
  if (p.length === 0) $('bloque-prog').open = false;      // sin agendados la sección se esconde y queda cerrada
  $('cuenta-prog').textContent = `(${p.length})`;
  $('prog').replaceChildren(...p.map((o) => {
    const mios = o.items.some((i) => i.mio);
    const fila = el('button', 'agendado' + (mios ? '' : ' otro'));
    fila.type = 'button';
    fila.append(el('span', 'ag-hora', '🕒 ' + hora12(o.para)));
    const cuerpo = el('span', 'ag-cuerpo');
    cuerpo.append(el('strong', '', `#${o.turno.slice(-3)} · ${o.cliente}`));
    const resumen = o.items.map((i) => `${i.cantidad}× ${textoItem(i)}`).join(', ');
    cuerpo.append(el('span', 'ag-items', resumen));
    fila.append(cuerpo);
    const entra = el('small', 'ag-entra');
    entra.dataset.act = String(o.activa_en);
    fila.append(entra);
    fila.addEventListener('click', () => abrirPedido(o.id));
    return fila;
  }));
  textoEntradaAgendados();
}

/* "Entra a la fila en X min": se recalcula cada segundo con el tiempo transcurrido desde la última respuesta del servidor */
function textoEntradaAgendados() {
  const extra = Math.floor((performance.now() - recibidoEn) / 1000);
  for (const e of document.querySelectorAll('.ag-entra[data-act]')) {
    const min = Math.ceil((Number(e.dataset.act) - extra) / 60);
    e.textContent = min <= 1 ? 'entra a la fila en menos de 1 min' : `entra a la fila en ${min} min`;
  }
}

function pintarListas() {
  const bloque = $('bloque-listas');
  bloque.hidden = datos.listas.length === 0;
  $('cuenta-listas').textContent = `(${datos.listas.length})`;
  $('listas').replaceChildren(...datos.listas.map((o) => {
    const c = el('button', 'chip-lista', `#${o.turno.slice(-3)} · ${o.cliente}`);
    c.type = 'button';
    c.addEventListener('click', () => abrirPedido(o.id));
    return c;
  }));
}

/* Reloj: actualiza el tiempo de espera y el color sin volver a dibujar todo */
function avanzarReloj() {
  if (!datos) return;
  const extra = Math.floor((performance.now() - recibidoEn) / 1000);
  for (const e of document.querySelectorAll('.com-espera[data-rest]')) {
    pintarRestante(e, Number(e.dataset.rest) - extra, '.com-min', '.sin-etiqueta');
  }
}
setInterval(avanzarReloj, 1000);
setInterval(textoEntradaAgendados, 1000);

/* ------------------------------------------------------------------ */
/*  Acciones                                                           */
/* ------------------------------------------------------------------ */
async function cambiarItem(o, i, nuevo, esDeshacer = false) {
  const antes = i.estado;
  i.estado = nuevo;                       // se ve de inmediato; el servidor confirma
  firma = ''; pintar(); avanzarReloj();
  try {
    const r = await enviarJson(API + 'cocina.php', { accion: 'item', item_id: i.id, estado: nuevo, desde: antes });
    if (!r.cambio) avisar('Otra tablet ya lo había cambiado');
    else if (!esDeshacer) avisar(`${textoItem(i)} → ${ETIQUETA[nuevo].toLowerCase()}`, () => cambiarItem(o, i, antes, true));
  } catch (err) {
    avisar(err.message);
  }
  cargar();
}

/** Cocina confirma que el pedido (todo listo) pasa a "listas para entregar"; se puede deshacer desde el aviso. */
async function moverAListas(o) {
  try {
    await enviarJson(API + 'cocina.php', { accion: 'mover_listas', orden_id: o.id });
    avisar(`Pedido #${o.turno.slice(-3)} de ${o.cliente} → listo para entregar`, async () => {
      try { await enviarJson(API + 'cocina.php', { accion: 'regresar_cocina', orden_id: o.id }); } catch (err) { avisar(err.message); }
      firma = ''; cargar();
    });
  } catch (err) {
    avisar(err.message);
  }
  firma = '';
  cargar();
}

async function todoListo(o) {
  try {
    const r = await enviarJson(API + 'cocina.php', { accion: 'todo_listo', orden_id: o.id, estacion_id: estacionId });
    avisar(r.orden_estado === 'lista' ? `Pedido ${o.turno.slice(-3)} listo para entregar` : `Tu parte del pedido ${o.turno.slice(-3)} está lista`);
  } catch (err) {
    avisar(err.message);
  }
  cargar();
}

/* ------------------------------------------------------------------ */
/*  Detalle del pedido: regresar renglones, quitar, reabrir            */
/* ------------------------------------------------------------------ */
let pedidoAbierto = null;

function buscarPedido(id) {
  return datos && [...datos.ordenes, ...datos.listas, ...(datos.programadas || [])].find((o) => o.id === id);
}

function abrirPedido(id) {
  pedidoAbierto = id;
  $('dp-error').textContent = '';
  pintarPedido();
  if (!$('dlg-pedido').open) $('dlg-pedido').showModal();
}

function pintarPedido() {
  const o = buscarPedido(pedidoAbierto);
  if (!o) { if ($('dlg-pedido').open) $('dlg-pedido').close(); return; }
  $('dp-agregar').href = `../pedidos/?agregar=${o.id}`;
  $('dp-titulo').textContent = `#${o.turno.slice(-3)} · ${o.cliente} · ${infoMod(o.modalidad).corto}` + (o.para ? ` · 🕒 ${hora12(o.para)}` : '');
  const caja = $('dp-items');
  caja.replaceChildren();
  const varios = new Set(o.items.map((i) => i.plato)).size > 1 || o.items.some((i) => i.llevar);
  let platoVisto = 0;
  for (const i of o.items) {
    if (varios && i.plato !== platoVisto) { platoVisto = i.plato; caja.append(el('h4', 'plato-cab' + (i.llevar ? ' llevar' : ''), `Plato ${i.plato}` + (i.llevar ? ' · 🥡 LLEVAR' : ''))); }
    const fila = el('div', 'dp-item');
    fila.append(el('div', 'dp-nombre', `${i.cantidad}× ${detalleItem(i)}`));
    if (i.notas) fila.append(el('div', 'dp-nota', `“${i.notas}”`));
    const cant = el('div', 'dp-cant');
    const menos = el('button', 'btn paso', '−'); menos.type = 'button'; menos.disabled = i.cantidad <= 1;
    menos.setAttribute('aria-label', 'Una pieza menos');
    const num = el('output', 'dp-num', String(i.cantidad));
    const mas = el('button', 'btn paso', '＋'); mas.type = 'button'; mas.disabled = i.cantidad >= 50;
    mas.setAttribute('aria-label', 'Una pieza más');
    menos.addEventListener('click', () => cambiarCantidad(i, i.cantidad - 1));
    mas.addEventListener('click', () => cambiarCantidad(i, i.cantidad + 1));
    cant.append(menos, num, mas);
    fila.append(cant);
    const botones = el('div', 'dp-botones');
    for (const est of ['pendiente', 'preparando', 'listo']) {
      const b = el('button', 'btn' + (i.estado === est ? ' principal' : ''), ETIQUETA[est]);
      b.type = 'button';
      b.addEventListener('click', () => { if (i.estado !== est) cambiarDesdeDialogo(o, i, est); });
      botones.append(b);
    }
    const q = el('button', 'btn peligro', 'Quitar');
    q.type = 'button';
    q.addEventListener('click', () => quitarItem(o, i));
    botones.append(q);
    fila.append(botones);
    caja.append(fila);
  }
}

async function cambiarDesdeDialogo(o, i, nuevo) {
  $('dp-error').textContent = '';
  try {
    await enviarJson(API + 'cocina.php', { accion: 'item', item_id: i.id, estado: nuevo });
  } catch (err) { $('dp-error').textContent = err.message; }
  await cargar(true);
  pintarPedido();
}

async function cambiarCantidad(i, cantidad) {
  propios.set(pedidoAbierto, Date.now());
  $('dp-error').textContent = '';
  try { await enviarJson(API + 'cocina.php', { accion: 'cantidad', item_id: i.id, cantidad }); }
  catch (err) { $('dp-error').textContent = err.message; }
  await cargar(true);
  pintarPedido();
}

async function quitarItem(o, i) {
  if (!(await confirmar(`¿Quitar “${i.cantidad}× ${i.nombre}” del pedido #${o.turno.slice(-3)}? El total se recalcula.`, { si: 'Quitar', peligro: true }))) return;
  propios.set(o.id, Date.now());
  $('dp-error').textContent = '';
  try {
    const r = await enviarJson(API + 'cocina.php', { accion: 'quitar_item', item_id: i.id });
    avisar(r.orden_estado === 'cancelada' ? 'Pedido cancelado: ya no quedaban productos' : 'Producto quitado');
  } catch (err) { $('dp-error').textContent = err.message; }
  await cargar(true);
  pintarPedido();
}

$('dp-reabrir').addEventListener('click', async () => {
  $('dp-error').textContent = '';
  try { await enviarJson(API + 'cocina.php', { accion: 'reabrir', orden_id: pedidoAbierto }); avisar('Pedido regresado a cocina'); }
  catch (err) { $('dp-error').textContent = err.message; }
  await cargar(true);
  pintarPedido();
});
$('dp-cerrar').addEventListener('click', () => $('dlg-pedido').close());

iniciar();
