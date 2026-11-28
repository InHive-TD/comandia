/**
 * Funciones compartidas por todas las pantallas.
 * Se carga ANTES del script propio de cada pantalla.
 */

const dinero = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** Crea un elemento HTML con texto. Usar textContent evita inyección de código (XSS). */
function el(etiqueta, clase, texto) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

/* Código secreto anti-CSRF: lo entrega api/sesion.php y se envía en cada POST. */
let tokenCsrf = null;
function fijarCsrf(token) {
  tokenCsrf = token;
}

/**
 * Pide datos a un archivo PHP y devuelve el JSON.
 * Lanza un Error con mensaje legible si algo falla.
 */
async function pedir(ruta, opciones = {}) {
  const metodo = (opciones.method || 'GET').toUpperCase();
  const encabezados = { ...(opciones.headers || {}) };
  if (sucursalPublica) encabezados['X-Sucursal'] = String(sucursalPublica);
  if (metodo !== 'GET' && tokenCsrf) {
    encabezados['X-CSRF-Token'] = tokenCsrf;
  }

  let respuesta;
  try {
    respuesta = await fetch(ruta, { ...opciones, method: metodo, headers: encabezados, credentials: 'same-origin' });
  } catch {
    throw new Error('No hay conexión con el servidor. Revisa tu internet.');
  }

  const texto = await respuesta.text();
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    // PHP mostró un aviso/error en vez de JSON: lo enseñamos para poder corregirlo.
    const limpio = texto.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const error = new Error('Respuesta inesperada del servidor: ' + (limpio || '(vacía)'));
    error.estado = respuesta.status;
    throw error;
  }
  if (!respuesta.ok || datos.ok === false) {
    const error = new Error(datos.mensaje || 'Error al comunicarse con el servidor.');
    error.estado = respuesta.status;
    throw error;
  }
  if (datos.negocio && datos.negocio.nombre) aplicarNegocio(datos.negocio.nombre);
  return datos;
}

/* Sucursal del cliente: la fija la dirección del QR (/lavale/centro/); el personal usa la de su sesión */
let sucursalPublica = null;

/* Negocio (empresa) al que pertenece esta pantalla: se aprende de la respuesta del servidor */
let nombreNegocio = '';
function aplicarNegocio(nombre) {
  nombreNegocio = nombre;
  document.title = document.title.replace(/ · [^·]*$/, '') + ' · ' + nombre;
  document.querySelectorAll('.nombre-negocio').forEach((n) => { n.textContent = nombre; });
  document.querySelectorAll('img.logo').forEach((i) => { i.alt = nombre; });
}

/* Slug de la empresa según la dirección (/lavale/admin/, /lavale/): sirve para no mezclar lo guardado en el navegador */
function slugActual() {
  const partes = location.pathname.split('/').filter(Boolean).filter((p) => !/\.html?$/i.test(p));
  if (sucursalDeLaDireccion()) partes.pop();   // /lavale/centro/ → la empresa es "lavale"; "centro" es la sucursal
  // /lavale/admin/usuarios → la empresa es lo que va antes de la pantalla (admin|pedidos|cocina|caja)
  const i = partes.findIndex((p) => ['admin', 'pedidos', 'cocina', 'caja'].includes(p));
  if (i > 0) return partes[i - 1];
  return partes[partes.length - 1] || 'comandia';
}
/* Sucursal que trae la dirección de la pantalla del cliente (/lavale/centro/); '' si no trae (ej. /lavale/ o el personal). */
function sucursalDeLaDireccion() {
  const m = document.querySelector('meta[name="comandia-sucursal"]');
  return m ? m.content : '';
}
/* Lo guardado en el navegador (pedidos, contacto) se separa por empresa Y por sucursal: un pedido de una sucursal no se mezcla con otra. */
const claveLS = (k) => `${slugActual()}${sucursalDeLaDireccion() ? '/' + sucursalDeLaDireccion() : ''}:${k}`;

/** Envía un objeto como JSON por POST. */
function enviarJson(ruta, objeto) {
  return pedir(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(objeto),
  });
}

/**
 * "Agendar pedido": por defecto el pedido es para ahora. Si abren "Agendar" y eligen un tiempo
 * (15 min, 1 h…) u "Otra hora", el pedido queda agendado y llega a la comanda de cocina poco antes.
 * Devuelve { datos(), fijar(null), incompleto(), onChange }.
 * datos() → {} (ahora), { para_en_min: 30 } o { para_hora: "19:30" }; el servidor calcula la hora real.
 */
/* Tiempo que FALTA para un pedido (segundos): texto y color. Compartido por Cocina y Preparando. */
function infoRestante(seg) {
  if (seg > 300) return { clase: 'rest-ok', min: `${Math.ceil(seg / 60)} min`, lbl: 'faltan' };
  if (seg > 120) return { clase: 'rest-pronto', min: `${Math.ceil(seg / 60)} min`, lbl: 'ya casi' };
  if (seg > 0) return { clase: 'rest-ya', min: `${Math.max(1, Math.ceil(seg / 60))} min`, lbl: '¡entregar!' };
  return { clase: 'rest-tarde', min: `−${Math.max(1, Math.ceil(-seg / 60))} min`, lbl: 'atrasado' };
}
/** Pinta el recuadro de espera (con .min y .lbl dentro) según los segundos que faltan */
function pintarRestante(caja, seg, sMin, sLbl) {
  const r = infoRestante(seg);
  caja.classList.remove('rest-ok', 'rest-pronto', 'rest-ya', 'rest-tarde');
  caja.classList.add(r.clase);
  const a = caja.querySelector(sMin), b = caja.querySelector(sLbl);
  if (a) a.textContent = r.min;
  if (b) b.textContent = r.lbl;
}

function montarCuando(caja, { abierto = false } = {}) {
  const detalles = document.createElement('details');
  detalles.className = 'agendar';
  detalles.open = abierto;
  const resumen = el('summary', '', '📅 Agendar pedido para más tarde');
  const etiqueta = el('div', 'cuando-etiqueta', '¿A qué hora lo necesitan?');
  const fila = el('div', 'cuando-selector');
  const pad = (n) => String(n).padStart(2, '0');
  function lista(clase, rotulo, opciones) {
    const sel = document.createElement('select');
    sel.className = 'cuando-sel ' + clase;
    sel.setAttribute('aria-label', rotulo);
    const vacio = document.createElement('option');
    vacio.value = ''; vacio.textContent = rotulo;
    sel.append(vacio);
    for (const [v, t] of opciones) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
    return sel;
  }
  const selH = lista('cs-hora', 'Hora', Array.from({ length: 12 }, (_, i) => [String(i + 1), String(i + 1)]));
  const selM = lista('cs-min', 'Min', Array.from({ length: 12 }, (_, i) => [pad(i * 5), pad(i * 5)]));
  const selA = lista('cs-ampm', 'AM/PM', [['AM', 'AM'], ['PM', 'PM']]);
  const sep = el('span', 'cuando-sep', ':');
  const quitar = el('button', 'btn cuando-quitar', '✕ Quitar');
  quitar.type = 'button';
  fila.append(selH, sep, selM, selA, quitar);
  const nota = el('p', 'ayuda', '');

  /** "HH:MM" en 24 h si ya eligió los tres campos; '' si falta alguno */
  function valor24() {
    if (!selH.value || selM.value === '' || !selA.value) return '';
    let h = Number(selH.value) % 12;
    if (selA.value === 'PM') h += 12;
    return `${pad(h)}:${selM.value}`;
  }
  function poner(hhmm) {
    if (!hhmm) { selH.value = ''; selM.value = ''; selA.value = ''; return; }
    const [h, m] = hhmm.split(':').map(Number);
    selH.value = String(h % 12 === 0 ? 12 : h % 12);
    selM.value = pad(Math.round(m / 5) * 5 % 60);
    selA.value = h >= 12 ? 'PM' : 'AM';
  }
  /** Próximo cuarto de hora, al menos 30 min adelante: punto de partida sugerido */
  function sugerida() {
    const d = new Date(Date.now() + 30 * 60000);
    const m = Math.min(23 * 60 + 45, Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15);
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  }
  const algo = () => !!(selH.value || selM.value !== '' || selA.value);
  function refrescar() {
    quitar.hidden = !algo();
    const v = valor24();
    nota.textContent = v
      ? `Queda agendado para las ${selH.value}:${selM.value} ${selA.value}: cocina lo ve como “Agendado” y entra a la fila a tiempo, antes si hay muchos pedidos.`
      : (algo() ? 'Falta completar la hora (hora, minutos y AM/PM).' : 'Sin elegir hora, el pedido va a cocina de inmediato.');
    if (api.onChange) api.onChange();
  }
  for (const sel of [selH, selM, selA]) sel.addEventListener('change', refrescar);
  quitar.addEventListener('click', () => { poner(''); refrescar(); });
  detalles.addEventListener('toggle', () => {
    if (detalles.open && !algo() && !abierto) { poner(sugerida()); refrescar(); }
    if (!detalles.open && algo()) { poner(''); refrescar(); }
  });
  const api = {
    onChange: null,
    /** fijar(null) borra la hora; fijar('19:30') la pone */
    fijar(v) {
      poner(typeof v === 'string' ? v : '');
      if (v === null && !abierto) detalles.open = false;
      if (typeof v === 'string' && v) detalles.open = true;
      refrescar();
    },
    datos() { const v = valor24(); return v ? { para_hora: v } : {}; },
    /** true si empezó a elegir la hora pero no la completó */
    incompleto() { return algo() && !valor24(); },
  };
  detalles.append(resumen, etiqueta, fila, nota);
  caja.replaceChildren(detalles);
  refrescar();
  return api;
}

/**
 * Muestra "Tiempo de espera estimado" mientras se arma un pedido (según los pedidos que ya hay en cocina).
 * datosFn() → { modalidad, unidades, agendado, oculto }. Devuelve una función "actualizar()" para llamar
 * cada vez que cambie el pedido (se agrupan los avisos para no saturar al servidor).
 */
function montarEspera(caja, ruta, datosFn, { detalle = false } = {}) {
  let t = null;
  let n = 0;
  return function actualizar() {
    clearTimeout(t);
    t = setTimeout(async () => {
      const d = datosFn();
      if (!d.unidades || d.oculto) { caja.hidden = true; return; }
      if (d.agendado) { caja.hidden = false; caja.textContent = '📅 Pedido agendado: entra a la fila de cocina a tiempo para la hora que pidieron.'; return; }
      const mi = ++n;
      try {
        const r = await pedir(`${ruta}?modalidad=${encodeURIComponent(d.modalidad)}&unidades=${d.unidades}` + (detalle ? '&detalle=1' : ''));
        if (mi !== n) return;
        caja.hidden = false;
        caja.textContent = `⏱ Tiempo de espera estimado: ${r.estimado} min` + (r.delante > 0 ? ` · ${r.delante} ${r.delante === 1 ? 'pedido' : 'pedidos'} por delante` : '');
      } catch { caja.hidden = true; }
    }, 250);
  };
}

/** Banner rojo fijo con el texto centrado (sin animación): "★ PRIORIDAD · REABIERTO". */
function cintaPrioridad(texto = '★ PRIORIDAD · REABIERTO', clase = '') {
  const cinta = document.createElement('div');
  cinta.className = 'cinta-agregado' + (clase ? ' ' + clase : '');
  cinta.setAttribute('aria-label', texto.replace(/^[^\wÁ-ú]+/, ''));
  const pista = document.createElement('div');
  pista.className = 'cinta-pista';
  const t = document.createElement('span');
  t.textContent = texto;
  t.setAttribute('aria-hidden', 'true');
  pista.append(t);
  cinta.append(pista);
  return cinta;
}


/* Menú ☰ del encabezado en celular (páginas con header.con-menu) */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-menu'), panel = document.querySelector('.con-menu .barra-botones');
  if (!btn || !panel) return;
  const cerrar = () => { panel.classList.remove('abierto'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const abre = !panel.classList.contains('abierto');
    panel.classList.toggle('abierto', abre);
    btn.setAttribute('aria-expanded', String(abre));
  });
  panel.addEventListener('click', cerrar);
  document.addEventListener('click', (ev) => { if (!panel.contains(ev.target) && ev.target !== btn) cerrar(); });
});


/* Celular (≤640 px): el encabezado se esconde al bajar y reaparece al subir un poco (Pedidos, Caja y Cocina).
   Expone la clase body.encab-oculto y la variable --alto-encab (la usan las franjas fijas). */
(() => {
  const encab = document.querySelector('.encabezado.barra');
  if (!encab) return;
  const celu = window.matchMedia('(max-width: 640px)');
  const cls = document.body.classList;
  const enCocina = !!document.getElementById('barra-cocina');
  let ultimo = window.scrollY, ticking = false;
  const medir = () => document.documentElement.style.setProperty('--alto-encab', encab.offsetHeight + 'px');
  medir(); window.addEventListener('resize', medir); window.addEventListener('load', medir);
  const alCambiar = () => {
    ticking = false;
    const y = window.scrollY, dy = y - ultimo;
    if (!celu.matches) { cls.remove('encab-oculto'); ultimo = y; return; }
    const baja = y >= 20 && dy > 8 && y > 90, sube = y < 20 || dy < -4;
    if (enCocina) {   // el tablero ya esconde su barra; aquí solo se muestra/oculta con el scroll
      if (cls.contains('barra-auto') && typeof mostrarBarra === 'function') { if (baja) mostrarBarra(false); else if (sube && y >= 20) mostrarBarra(true); }
    } else if (baja) {
      if (!cls.contains('encab-oculto')) { cls.add('encab-oculto'); document.querySelector('.con-menu .barra-botones')?.classList.remove('abierto'); }
    } else if (sube) cls.remove('encab-oculto');
    if (Math.abs(dy) > 4) ultimo = y;
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(alCambiar); } }, { passive: true });
})();


/* Tipos de pedido: 'aqui' (comer aquí), 'llevar' (para llevar) y 'recoger' (pasan por él; el teléfono es obligatorio al pedir por QR) */
const MODALIDADES = {
  aqui:    { clase: 'aqui',    chip: '🍽 AQUÍ',    largo: '🍽 Comer aquí',  corto: '🍽 Aquí' },
  llevar:  { clase: 'llevar',  chip: '🥡 LLEVAR',  largo: '🥡 Para llevar', corto: '🥡 Para llevar' },
  recoger: { clase: 'recoger', chip: '🛍 RECOGER', largo: '🛍 Recoger',     corto: '🛍 Recoger' },
};
const infoMod = (m) => MODALIDADES[m] || MODALIDADES.aqui;

/** Limita las carnes que se pueden marcar (p.max_carnes) y avisa cuántas caben. */
function limitarCarnes(caja, p, extras) {
  const max = p.max_carnes;
  if (!max) return;
  const cajas = [...caja.querySelectorAll('input[type=checkbox]')].filter((c) => {
    const x = extras.find((e) => String(e.id) === c.value);
    return x && x.grupo === 'Carne a elegir';
  });
  const titulo = [...caja.querySelectorAll('.grupo-titulo')].find((t) => t.textContent.startsWith('Carne a elegir'));
  if (titulo) titulo.textContent = `Carne a elegir (hasta ${max})`;
  const ajustar = () => {
    const n = cajas.filter((c) => c.checked).length;
    for (const c of cajas) c.disabled = !c.checked && n >= max;
  };
  for (const c of cajas) c.addEventListener('change', ajustar);
  ajustar();
}

/* Ventanas emergentes: "Cerrar" (rojo) arriba a la izquierda y la acción principal (Agregar, Guardar, Cobrar…) arriba a la
   derecha, en una barra fija: el contenido se desplaza debajo y no hay que bajar para cerrar o confirmar. */
document.addEventListener('DOMContentLoaded', () => {
  for (const d of document.querySelectorAll('dialog')) {
    if (d.classList.contains('pagina')) continue;   // las secciones del portal son páginas: sin barra ni ✕ (se navega con el menú lateral)
    const acc = d.querySelector('.acciones-dialogo');
    const cerrar = acc && acc.querySelector('button[id$="-cancelar"], button[id$="-cerrar"]');
    if (!cerrar) continue;                       // ventanas de aviso (solo "Entendido", "Nuevo pedido"…) se quedan como están
    const principal = [...acc.children].find((x) => x !== cerrar && x.matches('.principal, [type="submit"]'));
    const padre = acc.closest('.dialogo') || acc.parentElement;
    const barra = document.createElement('div');
    barra.className = 'dlg-barra' + (padre.classList.contains('dialogo') ? ' en-dialogo' : '');
    cerrar.textContent = '✕'; cerrar.setAttribute('aria-label','Cerrar'); cerrar.title = 'Cerrar';
    cerrar.classList.remove('principal', 'grande', 'peligro');
    cerrar.classList.add('dlg-cerrar');
    // Botones auxiliares (clase dlg-extra), como el micrófono de la voz: van primero, antes de la acción principal
    for (const x of acc.querySelectorAll('.dlg-extra')) barra.append(x);
        if (principal) {
      principal.classList.remove('grande');
      principal.classList.add('dlg-ok');
      barra.append(principal);
    }
    barra.append(cerrar);
    padre.prepend(barra);
    if (!acc.children.length) acc.remove();
  }
});

/* Confirmación propia de la app (reemplaza confirm() del navegador). Devuelve una promesa: true = aceptó, false = canceló.
   opciones: { si: 'texto del botón', no: 'texto', peligro: true (botón rojo) } */
function confirmar(mensaje, { si = 'Sí', no = 'Cancelar', peligro = false } = {}) {
  return new Promise((resolver) => {
    const d = document.createElement('dialog');
    d.className = 'dlg-confirmar';
    const p = document.createElement('p');
    p.className = 'confirmar-texto';
    p.textContent = mensaje;
    const fila = document.createElement('div');
    fila.className = 'confirmar-botones';
    const bNo = document.createElement('button');
    bNo.type = 'button'; bNo.className = 'btn'; bNo.textContent = no;
    const bSi = document.createElement('button');
    bSi.type = 'button'; bSi.className = 'btn ' + (peligro ? 'peligro' : 'principal'); bSi.textContent = si;
    fila.append(bNo, bSi);
    d.append(p, fila);
    let respuesta = false;
    bSi.addEventListener('click', () => { respuesta = true; d.close(); });
    bNo.addEventListener('click', () => d.close());
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
    d.addEventListener('close', () => { d.remove(); resolver(respuesta); });
    document.body.append(d);
    d.showModal();
    bNo.focus();
  });
}

/** Mesa de un pedido con su zona (si la tiene): «9 · Patio Centro». */
const etiquetaMesa = (o) => (o.mesa ? o.mesa + (o.mesa_zona ? ' · ' + o.mesa_zona : '') : '');

/** A quién pertenece un pedido: «Mesa 9 · Patio Centro» (si se llama por la mesa) o «Juan · 🪑 9 · Patio Centro». */
function quienDe(o) {
  const nombre = o.cliente || o.nombre_cliente || '';
  if (!o.mesa) return nombre;
  const auto = nombre === o.mesa || nombre.toLowerCase() === ('mesa ' + o.mesa).toLowerCase();
  return auto ? nombre + (o.mesa_zona ? ' · ' + o.mesa_zona : '') : `${nombre} · 🪑 ${etiquetaMesa(o)}`;
}

/* Pedir un texto con ventana propia (reemplaza prompt()). Devuelve el texto o null si cancela. */
function pedirTexto(mensaje, { si = 'Aceptar', no = 'Cancelar', tipo = 'text', minimo = 0, valor = '' } = {}) {
  return new Promise((resolver) => {
    const d = document.createElement('dialog');
    d.className = 'dlg-confirmar';
    const p = document.createElement('p');
    p.className = 'confirmar-texto'; p.textContent = mensaje;
    const campo = document.createElement('input');
    campo.type = tipo; campo.autocomplete = 'new-password'; campo.className = 'confirmar-campo'; campo.value = valor;
    const err = document.createElement('p');
    err.className = 'confirmar-error';
    const fila = document.createElement('div');
    fila.className = 'confirmar-botones';
    const bNo = document.createElement('button'); bNo.type = 'button'; bNo.className = 'btn'; bNo.textContent = no;
    const bSi = document.createElement('button'); bSi.type = 'button'; bSi.className = 'btn principal'; bSi.textContent = si;
    fila.append(bNo, bSi);
    d.append(p, campo, err, fila);
    let respuesta = null;
    const aceptar = () => {
      if (campo.value.length < minimo) { err.textContent = `Mínimo ${minimo} caracteres.`; campo.focus(); return; }
      respuesta = campo.value; d.close();
    };
    bSi.addEventListener('click', aceptar);
    campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); aceptar(); } });
    bNo.addEventListener('click', () => d.close());
    d.addEventListener('close', () => { d.remove(); resolver(respuesta); });
    document.body.append(d);
    d.showModal();
    campo.focus();
  });
}

/* Comisión de la terminal al pagar con tarjeta: $3 + 3.7 % del monto, redondeada al peso (misma regla que Caja) */
const COMISION_FIJA = 3, COMISION_PCT = 3.7;
const comisionTarjeta = (monto) => Math.round(monto * COMISION_PCT / 100 + COMISION_FIJA);

/**
 * Sucursal en el encabezado (cocina, caja y pedidos).
 * El administrador con varias sucursales ve un selector; el personal ve el nombre de la suya.
 * Al cambiar de sucursal se recarga la pantalla para mostrar sus pedidos.
 */
async function montarSucursal() {
  const quien = document.getElementById('quien');
  if (!quien || document.getElementById('sel-sucursal')) return;
  try {
    const r = await pedir(API + 'sucursal.php');
    if (!r.sucursales.length) return;
    if (r.sucursales.length === 1) {
      quien.append(document.createTextNode((document.body.dataset.shell ? '' : ' · ') + 'Sucursal ' + r.sucursales[0].nombre));
      return;
    }
    const sel = document.createElement('select');
    sel.id = 'sel-sucursal';
    sel.className = 'sel-sucursal';
    sel.setAttribute('aria-label', 'Sucursal');
    for (const s of r.sucursales) {
      const o = document.createElement('option');
      o.value = String(s.id); o.textContent = s.nombre;   // solo el nombre; la palabra "Sucursal" va fuera, como texto (no se alarga el selector)
      sel.append(o);
    }
    sel.value = String(r.actual);
    sel.addEventListener('change', async () => {
      try { await enviarJson(API + 'sucursal.php', { sucursal_id: Number(sel.value) }); location.reload(); }
      catch (err) { alert(err.message); }
    });
    const fila = document.createElement('div');
    fila.className = 'fila-sucursal';
    const etq = document.createElement('span');
    etq.textContent = 'Sucursal';
    fila.append(etq, sel);
    // Va en la MISMA línea que el rol ("Administrador · Sucursal [Centro ▾]"), no debajo, para que el encabezado no se ensanche
    quien.classList.add('quien-linea');
    quien.append(fila);
  } catch { /* sin sucursal no se muestra nada */ }
}

/* Mantener presionado un elemento (≈0.7 s) ejecuta `accion`; el toque corto sigue siendo un clic normal.
   Tras el presionado largo se ignora el clic que el navegador dispara al soltar (`ignorarClic`). */
let ignorarClic = false;
function mantenerPresionado(nodo, accion, ms = 700) {
  let t = null;
  const cancelar = () => { clearTimeout(t); t = null; };
  nodo.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    cancelar();
    t = setTimeout(() => { t = null; ignorarClic = true; setTimeout(() => { ignorarClic = false; }, 400); accion(); }, ms);
  });
  for (const e of ['pointerup', 'pointerleave', 'pointercancel']) nodo.addEventListener(e, cancelar);
  nodo.addEventListener('contextmenu', (ev) => ev.preventDefault());
}


/**
 * Regla de diseño: el texto de ayuda entre paréntesis en un formulario se muestra como un signo de información (ⓘ)
 * y el texto aparece al pasar el cursor o tocarlo. "(opcional)" y "(recomendado)" se quedan a la vista.
 * Se aplica solo dentro de formularios y ventanas, y también a lo que se pinta después.
 */
function convertirParentesis(raiz) {
  for (const sm of (raiz.querySelectorAll ? raiz.querySelectorAll('dialog small, .formulario small') : [])) {
    if (sm.dataset.tipListo || sm.children.length) continue;
    const t = sm.textContent.trim();
    const m = /^\(([^()]{6,})\)$/.exec(t);
    if (!m || /^(opcional|recomendado)$/i.test(m[1].trim())) continue;
    sm.dataset.tipListo = '1';
    const tip = document.createElement('span');
    tip.className = 'tip'; tip.tabIndex = 0; tip.textContent = 'i';
    tip.dataset.tip = m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1);
    sm.replaceWith(tip);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  convertirParentesis(document);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) convertirParentesis(n); }).observe(document.body, { childList: true, subtree: true });
});

/** Nombre con que se lee un modificador junto a su tipo: «Con» + «queso» = «Con queso». */
function nombreExtra(x) {
  const n = String((x && x.nombre) || '');
  const g = x && x.grupo ? String(x.grupo) : '';
  return g && !n.toLowerCase().startsWith(g.toLowerCase()) ? `${g} ${n}` : n;
}

/* Modificadores que «vienen marcados» (por ejemplo «Con todo»): se quitan solos al elegir otra opción de otro tipo. */
const extrasPorDefecto = (p) => p.extras.filter((x) => x.defecto);
function marcarDefectos(caja, p) {
  const defs = new Set(extrasPorDefecto(p).map((x) => String(x.id)));
  for (const c of caja.querySelectorAll('input[type=checkbox]')) if (defs.has(c.value)) c.checked = true;
}
function prepararDefectos(caja, p, marcar) {
  const defs = new Set(extrasPorDefecto(p).map((x) => String(x.id)));
  if (!defs.size) { caja.onchange = null; return; }
  const cajas = [...caja.querySelectorAll('input[type=checkbox]')];
  if (marcar) marcarDefectos(caja, p);
  caja.onchange = (ev) => {
    const c = ev.target;
    if (!c || defs.has(c.value)) return;
    const hayOtras = cajas.some((k) => !defs.has(k.value) && k.checked);
    for (const k of cajas) if (defs.has(k.value)) k.checked = !hayOtras;
  };
  const nota = el('p', 'nota-defecto', 'Lo marcado de fábrica se quita solo si eliges otra opción de cualquier otro tipo.');
  nota.style.cssText = 'font-size:.72rem;color:#777;margin:.4rem 0 0;line-height:1.25';
  caja.append(nota);
}

/* Foto del platillo en grande: clic en la foto del detalle; ✕ o clic en cualquier parte para minimizarla. */
document.addEventListener('DOMContentLoaded', () => {
  const dlg = document.getElementById('dlg-foto-grande'), foto = document.getElementById('dt-foto');
  if (!dlg || !foto) return;
  foto.addEventListener('click', () => { if (!foto.getAttribute('src')) return; document.getElementById('fg-img').src = foto.src; dlg.showModal(); });
  dlg.addEventListener('click', () => dlg.close());
});
