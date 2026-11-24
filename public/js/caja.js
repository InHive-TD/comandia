/**
 * Caja: ve qué pedidos faltan por cobrar (aunque ya estén entregados),
 * cobra con efectivo / tarjeta / transferencia, registra la propina aparte
 * y muestra el corte del día. Pagar y entregar son cosas independientes.
 */

const API = '../api/';
const $ = (id) => document.getElementById(id);
const METODOS = [['efectivo', '💵 Efectivo'], ['tarjeta', '💳 Tarjeta'], ['transferencia', '📲 Transferencia']];
const NOMBRE_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };
const ESTADO_TXT = { nueva: 'En cola', preparando: 'En preparación', lista: 'Lista', entregada: 'Entregada', cancelada: 'Cancelada' };
const ORDEN_ESTADO = { entregada: 0, lista: 1, preparando: 2, nueva: 3 };

let datos = null;
let pestana = 'cobrar';
let fecha = '';
let temporizador = null;
let cargando = false;
let abrirOrden = Number(new URLSearchParams(location.search).get('orden')) || 0;
let anularPendiente = null;

const redondear = (n) => Math.round(n * 100) / 100;
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function avisar(texto, error = false) {
  const t = $('toast');
  $('toast-texto').textContent = texto;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ------------------------------------------------------------------ */
/*  Pantallas y sesión                                                 */
/* ------------------------------------------------------------------ */
function mostrar(vista) {
  for (const id of ['vista-login', 'vista-aviso', 'vista-caja']) $(id).hidden = id !== vista;
  $('barra-caja').hidden = vista === 'vista-login';
}

function detener() { clearInterval(temporizador); temporizador = null; }

async function iniciar() {
  detener();
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
  $('quien').textContent = document.body.dataset.shell ? '' : usuario.nombre;   // con el menú lateral el nombre va abajo, junto a la foto
  montarSucursal();
  if (!['caja', 'admin'].includes(usuario.rol)) {
    $('aviso-titulo').textContent = 'Esta pantalla es para caja';
    $('aviso-texto').textContent = 'Entra con un usuario de caja o administrador para cobrar.';
    mostrar('vista-aviso');
    return;
  }
  fecha = hoyLocal();
  $('fecha').value = fecha;
  mostrar('vista-caja');
  await cargar();
  if (temporizador) temporizador.detener();
  temporizador = suscribirCambios(() => { if (!$('dlg-cobro').open) cargar(); }, { respaldoMs: 5000, url: API + 'eventos' });
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
  detener();
  try { await pedir(API + 'logout.php', { method: 'POST' }); } catch { /* da igual */ }
  await iniciar();
});

/* ------------------------------------------------------------------ */
/*  Datos                                                              */
/* ------------------------------------------------------------------ */
async function cargar() {
  if (cargando) return;
  cargando = true;
  try {
    datos = await pedir(API + 'caja.php?fecha=' + encodeURIComponent(fecha));
    pintar();
    if (abrirOrden) {
      const o = datos.ordenes.find((x) => x.id === abrirOrden);
      abrirOrden = 0;
      if (o && o.saldo > 0.004) abrirCobro(o);
    }
  } catch (err) {
    if (err.estado === 401) { await iniciar(); return; }
    if (err.estado === 403) { $('aviso-titulo').textContent = 'Sin permiso'; $('aviso-texto').textContent = err.message; mostrar('vista-aviso'); return; }
    avisar(err.message, true);
  } finally {
    cargando = false;
  }
}

$('fecha').addEventListener('change', () => { fecha = $('fecha').value || hoyLocal(); cargar(); });
$('btn-hoy').addEventListener('click', () => { fecha = hoyLocal(); $('fecha').value = fecha; cargar(); });
for (const b of document.querySelectorAll('.pestana')) {
  b.addEventListener('click', () => {
    pestana = b.dataset.tab;
    for (const x of document.querySelectorAll('.pestana')) x.setAttribute('aria-pressed', String(x === b));
    pintar();
  });
}

/* ------------------------------------------------------------------ */
/*  Pintar                                                             */
/* ------------------------------------------------------------------ */
function tile(titulo, valor, clase = '') {
  const t = el('div', 'tile ' + clase);
  t.append(el('small', '', titulo), el('strong', '', valor));
  return t;
}

function pintar() {
  if (!datos) return;
  const r = datos.resumen;
  $('tiles').replaceChildren(
    tile(`Por cobrar (${r.n_por_cobrar})`, dinero.format(r.por_cobrar), r.por_cobrar > 0 ? 'alerta' : ''),
    tile('Ya cobrado', dinero.format(r.cobrado), 'ok'),
    tile('Propinas', dinero.format(r.propinas)),
    tile('Entregadas sin pagar', String(r.entregadas_sin_pagar), r.entregadas_sin_pagar ? 'alerta' : ''),
  );
  $('n-cobrar').textContent = r.n_por_cobrar ? ` (${r.n_por_cobrar})` : '';
  if (pestana === 'cobrar') pintarPorCobrar();
  else if (pestana === 'cobrados') pintarCobrados();
  else pintarCorte();
}

function chipsPedido(o) {
  const c = el('div', 'cobro-chips');
  c.append(el('span', 'estado-chip' + (o.estado === 'entregada' ? ' entregada-chip' : ''), ESTADO_TXT[o.estado] || o.estado));
  c.append(el('span', 'chip-mod ' + infoMod(o.modalidad).clase, infoMod(o.modalidad).chip));
  if (o.mesa) c.append(el('span', 'chip-mesa', '🪑 ' + etiquetaMesa(o)));
  if (o.telefono) c.append(el('span', 'estado-chip', '📞 ' + o.telefono));
  if (o.origen === 'qr') c.append(el('span', 'estado-chip', '📱 QR'));
  return c;
}

function cabeza(o) {
  const cab = el('div', 'cobro-cab');
  cab.append(el('span', 'nombre', o.cliente), el('span', 'num', '#' + o.turno.slice(-3)), el('span', 'ayuda', o.hora));
  return cab;
}

const expandidos = new Set();   // pedidos con el detalle abierto (se conserva al refrescar)

/** Platillos y nota de "pedido modificado" plegados tras un botón, para ocupar menos espacio */
function lista(o) {
  const ul = el('ul', 'cobro-items');
  for (const i of o.items) ul.append(el('li', '', `${i.cantidad}× ${i.nombre}`));
  const detalle = el('div', 'cobro-detalle');
  detalle.append(ul);
  const modificado = !!(o.cambios && o.cambios.length);
  if (modificado) {
    // Nota de "pedido modificado": qué se le cambió (solo para quien cobra)
    const caja = el('div', 'cobro-modificado');
    caja.append(el('strong', '', '✎ Pedido modificado'));
    const cl = el('ul', '');
    for (const c of o.cambios) cl.append(el('li', '', `${c.hora} · ${c.detalle}${c.tras_entrega ? ' · tras entregar' : ''}`));
    caja.append(cl);
    detalle.append(caja);
  }
  const piezas = o.items.reduce((n, i) => n + i.cantidad, 0);
  const resumen = `${piezas} ${piezas === 1 ? 'pieza' : 'piezas'}${modificado ? ' · ✎ modificado' : ''}`;
  detalle.hidden = !expandidos.has(o.id);
  const ver = el('button', 'btn cobro-ver', '');
  ver.type = 'button';
  const texto = () => (detalle.hidden ? `▾ Ver platillos (${resumen})` : '▴ Ocultar platillos');
  ver.textContent = texto();
  ver.addEventListener('click', () => {
    detalle.hidden = !detalle.hidden;
    if (detalle.hidden) expandidos.delete(o.id); else expandidos.add(o.id);
    ver.textContent = texto();
  });
  const todo = el('div', 'cobro-plegable');
  todo.append(ver, detalle);
  return todo;
}

function pintarPorCobrar() {
  const caja = $('panel');
  const devolver = datos.ordenes.filter((o) => o.devolver > 0.004);
  const cobrar = datos.ordenes
    .filter((o) => o.estado !== 'cancelada' && o.total > 0 && o.saldo > 0.004)
    .sort((a, b) => (ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]) || (a.id - b.id));
  caja.replaceChildren();

  for (const o of devolver) {
    const t = el('article', 'cobro-tarjeta devolver');
    t.append(cabeza(o), chipsPedido(o));
    t.append(el('p', 'cobro-aviso', o.estado === 'cancelada'
      ? `Pedido cancelado con pago: devolver ${dinero.format(o.devolver)}`
      : `Se pagó de más: devolver ${dinero.format(o.devolver)}`));
    for (const p of o.pagos.filter((x) => !x.anulado)) t.append(filaPago(p));
    caja.append(t);
  }

  if (cobrar.length === 0 && devolver.length === 0) {
    caja.append(el('p', 'vacio ancho-total', 'No hay pedidos por cobrar. 🎉'));
    return;
  }
  for (const o of cobrar) {
    const urgente = o.estado === 'entregada';
    const t = el('article', 'cobro-tarjeta' + (urgente ? ' urgente' : ''));
    t.append(cabeza(o), chipsPedido(o));
    if (urgente) t.append(el('p', 'cobro-aviso', 'Ya se entregó y NO ha pagado'));
    t.append(lista(o));
    const m = el('div', 'cobro-monto');
    m.append(el('span', '', o.pagado > 0 ? `Falta (de ${dinero.format(o.total)})` : 'Total'), el('strong', '', dinero.format(o.saldo)));
    t.append(m);
    for (const p of o.pagos.filter((x) => !x.anulado)) t.append(filaPago(p));
    const b = el('button', 'btn principal', '💵 Cobrar');
    b.type = 'button';
    b.addEventListener('click', () => abrirCobro(o));
    t.append(b);
    if (o.estado === 'entregada') t.append(enlaceReabrir(o));
    caja.append(t);
  }
}

/** Ya se entregó y el cliente quiere agregar algo: se reabre desde Tomar pedidos (con prioridad en cocina) */
function enlaceReabrir(o) {
  const a = el('a', 'btn', '✎ Agregar o editar pedido');
  a.href = '../pedidos/?reabrir=' + o.id;
  return a;
}

function filaPago(p) {
  const f = el('div', 'pago-fila' + (p.anulado ? ' anulado' : ''));
  f.append(el('span', '', `${p.hora} · ${NOMBRE_METODO[p.metodo]} ${dinero.format(p.monto)}` + (p.propina > 0 ? ` + propina ${dinero.format(p.propina)}` : '') + (p.comision > 0 ? ` + comisión ${dinero.format(p.comision)}` : '') + (p.cobro ? ` · ${p.cobro}` : '')));
  if (!p.anulado) {
    const b = el('button', 'btn peligro', anularPendiente === p.id ? '¿Seguro? Anular' : 'Anular');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (anularPendiente !== p.id) {
        anularPendiente = p.id;
        pintar();
        clearTimeout(filaPago.t);
        filaPago.t = setTimeout(() => { anularPendiente = null; pintar(); }, 4000);
        return;
      }
      anularPendiente = null;
      b.disabled = true;
      try {
        await enviarJson(API + 'caja.php', { accion: 'anular', pago_id: p.id });
        avisar('Pago anulado.');
      } catch (err) { avisar(err.message, true); }
      await cargar();
    });
    f.append(b);
  }
  return f;
}

function pintarCobrados() {
  const caja = $('panel');
  caja.replaceChildren();
  const pagados = datos.ordenes.filter((o) => o.pagos.some((p) => !p.anulado));
  if (pagados.length === 0) { caja.append(el('p', 'vacio ancho-total', 'Todavía no hay cobros este día.')); return; }
  for (const o of pagados) {
    const completo = o.saldo <= 0.004 && o.estado !== 'cancelada';
    const t = el('article', 'cobro-tarjeta' + (completo ? ' pagada' : ''));
    t.append(cabeza(o), chipsPedido(o), lista(o));
    const m = el('div', 'cobro-monto');
    m.append(el('span', '', completo ? 'Pagado ✓' : `Pagado ${dinero.format(o.pagado)} de ${dinero.format(o.total)}`), el('strong', '', dinero.format(o.pagado)));
    t.append(m);
    if (o.propina > 0) t.append(el('p', '', `Propina: ${dinero.format(o.propina)}`));
    if (!completo && o.saldo > 0.004) {
      const b = el('button', 'btn principal', `💵 Cobrar lo que falta (${dinero.format(o.saldo)})`);
      b.type = 'button';
      b.addEventListener('click', () => abrirCobro(o));
      t.append(b);
    }
    if (o.estado === 'entregada') t.append(enlaceReabrir(o));
    for (const p of o.pagos) t.append(filaPago(p));
    caja.append(t);
  }
}

function pintarCorte() {
  const caja = $('panel');
  caja.replaceChildren();
  const r = datos.resumen;

  const c1 = el('section', 'corte ancho-total');
  c1.append(el('h3', '', 'Corte del día ' + datos.fecha));
  const tabla = el('table');
  const cab = el('thead');
  const fc = el('tr');
  for (const [txt, n] of [['Método', 0], ['Cobros', 1], ['Ventas', 1], ['Propinas', 1], ['Comisión tarjeta', 1], ['Total en caja', 1]]) fc.append(Object.assign(el('th', n ? 'n' : '', txt)));
  cab.append(fc);
  const cuerpo = el('tbody');
  let nTot = 0;
  const totalComision = Object.values(r.por_metodo).reduce((a, x) => a + x.comision, 0);
  for (const m of Object.keys(NOMBRE_METODO)) {
    const x = r.por_metodo[m];
    nTot += x.n;
    const f = el('tr');
    f.append(el('td', '', NOMBRE_METODO[m]), el('td', 'n', String(x.n)), el('td', 'n', dinero.format(x.monto)), el('td', 'n', dinero.format(x.propina)), el('td', 'n', dinero.format(x.comision)), el('td', 'n', dinero.format(x.monto + x.propina + x.comision)));
    cuerpo.append(f);
  }
  const pie = el('tfoot');
  const fp = el('tr');
  fp.append(el('td', '', 'Total'), el('td', 'n', String(nTot)), el('td', 'n', dinero.format(r.cobrado)), el('td', 'n', dinero.format(r.propinas)), el('td', 'n', dinero.format(totalComision)), el('td', 'n', dinero.format(r.cobrado + r.propinas + totalComision)));
  pie.append(fp);
  tabla.append(cab, cuerpo, pie);
  c1.append(tabla, el('p', 'ayuda', 'Las propinas y la comisión de tarjeta no cuentan como venta. "Total en caja" es lo que recibiste (ventas + propinas). Efectivo en caja = lo de la fila de efectivo.'));
  if (r.por_cobrar > 0) c1.append(el('p', 'cobro-aviso', `Aún por cobrar: ${dinero.format(r.por_cobrar)} (${r.n_por_cobrar} pedidos).`));
  caja.append(c1);

  const conPropina = datos.ordenes.filter((o) => o.propina > 0);
  const c2 = el('section', 'corte ancho-total');
  c2.append(el('h3', '', `Propinas por pedido (${conPropina.length})`));
  if (conPropina.length === 0) c2.append(el('p', 'vacio', 'No hubo propinas este día.'));
  else {
    const t2 = el('table');
    const cuerpo2 = el('tbody');
    for (const o of conPropina) {
      const f = el('tr');
      const metodos = [...new Set(o.pagos.filter((p) => !p.anulado && p.propina > 0).map((p) => NOMBRE_METODO[p.metodo]))].join(', ');
      f.append(el('td', '', `#${o.turno.slice(-3)} ${o.cliente}`), el('td', '', metodos), el('td', 'n', dinero.format(o.propina)));
      cuerpo2.append(f);
    }
    t2.append(cuerpo2);
    c2.append(t2);
  }
  caja.append(c2);
}

/* ------------------------------------------------------------------ */
/*  Diálogo de cobro                                                   */
/* ------------------------------------------------------------------ */
/** Comisión de tarjeta que se suma al cliente: $3 + 3.7 % del monto, redondeada al peso (el servidor calcula lo mismo). */
let cobro = null;   // { orden, metodo, enviando }

function montoActual() {
  const v = parseFloat($('cb-monto').value);
  const saldo = cobro.orden.saldo;
  return Number.isFinite(v) && v > 0 ? Math.min(redondear(v), saldo) : saldo;
}
function propinaActual() {
  const v = parseFloat($('cb-propina').value);
  return Number.isFinite(v) && v > 0 ? redondear(v) : 0;
}

function abrirCobro(o) {
  cobro = { orden: o, metodo: ['efectivo', 'tarjeta', 'transferencia'].includes(o.pago_previsto) ? o.pago_previsto : 'efectivo', enviando: false };
  $('cb-titulo').textContent = `${o.cliente} · #${o.turno.slice(-3)}`;
  $('cb-sub').textContent = (o.pagado > 0 ? `Ya pagó ${dinero.format(o.pagado)} de ${dinero.format(o.total)}.` : ESTADO_TXT[o.estado]) + (o.pago_previsto ? ` · Dijo que pagaría con ${NOMBRE_METODO[o.pago_previsto] || o.pago_previsto}.` : '');
  $('cb-saldo').textContent = dinero.format(o.saldo);
  $('cb-monto').value = '';
  $('cb-monto').max = String(o.saldo);
  $('cb-parte').open = false;
  $('cb-propina').value = '';
  $('cb-recibido').value = '';
  $('cb-error').textContent = '';
  $('cb-confirmar').disabled = false;
  pintarOpciones();
  recalcular();
  $('dlg-cobro').showModal();
}

function pintarOpciones() {
  const m = $('cb-metodos');
  m.replaceChildren();
  for (const [v, txt] of METODOS) {
    const b = el('button', 'btn', txt);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(cobro.metodo === v));
    b.addEventListener('click', () => { cobro.metodo = v; pintarOpciones(); recalcular(); });
    m.append(b);
  }
  $('cb-efectivo').hidden = cobro.metodo !== 'efectivo';
}

function recalcular() {
  const comision = cobro.metodo === 'tarjeta' ? comisionTarjeta(montoActual()) : 0;
  $('cb-comision').hidden = cobro.metodo !== 'tarjeta';
  $('cb-comision-monto').textContent = '+' + dinero.format(comision);
  const total = montoActual() + propinaActual() + comision;
  $('cb-total').textContent = dinero.format(total);
  $('cb-confirmar').textContent = `Cobrar ${dinero.format(total)}`;
  const rec = parseFloat($('cb-recibido').value);
  const cambio = $('cb-cambio');
  if (cobro.metodo === 'efectivo' && Number.isFinite(rec) && rec > 0) {
    const dif = redondear(rec - total);
    cambio.className = 'cb-cambio' + (dif < 0 ? ' falta' : '');
    cambio.textContent = dif < 0 ? `Faltan ${dinero.format(-dif)}` : `Cambio: ${dinero.format(dif)}`;
  } else {
    cambio.textContent = '';
  }
}

$('cb-monto').addEventListener('input', () => { pintarOpciones(); recalcular(); });
$('cb-propina').addEventListener('input', recalcular);
$('cb-recibido').addEventListener('input', recalcular);
$('cb-cancelar').addEventListener('click', () => $('dlg-cobro').close());

$('form-cobro').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!cobro || cobro.enviando) return;
  cobro.enviando = true;
  $('cb-confirmar').disabled = true;
  $('cb-error').textContent = '';
  try {
    const carga = { accion: 'cobrar', orden_id: cobro.orden.id, metodo: cobro.metodo, propina: propinaActual() };
    if ($('cb-monto').value !== '') carga.monto = montoActual();
    const r = await enviarJson(API + 'caja.php', carga);
    $('dlg-cobro').close();
    avisar(r.pagado ? 'Pedido pagado ✓' : `Pago registrado. Faltan ${dinero.format(r.saldo)}.`);
    await cargar();
  } catch (err) {
    $('cb-error').textContent = err.message;
    $('cb-confirmar').disabled = false;
    cobro.enviando = false;
    if (err.estado === 409) cargar();
  }
});

iniciar();
