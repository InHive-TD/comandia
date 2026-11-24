/* Tablero de Inicio: varios tableros (pestañas) con KPIs contra el periodo anterior, gráficas interactivas y un explorador.
   Se alimenta de /admin/reportes; el explorador se arma solo con las columnas que existan en la base de datos.
   Depende de comun.js (el, dinero, pedir, API). Todo texto de la base entra con textContent. */
const Tablero = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const DIAS_LARGO = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const NOMBRES = { aqui: 'Comer aquí', llevar: 'Para llevar', recoger: 'Recoger', qr: 'QR del cliente', mostrador: 'Mostrador', pickup: 'Recoger (pickup)', efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', anticipado: 'Antes de tiempo', a_tiempo: 'A tiempo', atrasado: 'Atrasado', nueva: 'Nueva', preparando: 'Preparando', lista: 'Lista', entregada: 'Entregada', cancelada: 'Cancelada' };
  const COLOR = { aqui: 1, llevar: 2, recoger: 3, qr: 3, mostrador: 1, pickup: 2, efectivo: 6, tarjeta: 1, transferencia: 7 };
  const ESTADO_COLOR = { anticipado: 'var(--ok)', a_tiempo: 'var(--ok-2)', atrasado: 'var(--mal)' };
  const nom = (k) => NOMBRES[k] || k;
  const n0 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
  const n1 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });
  const fmt = (v, f) => (f === 'dinero' ? dinero.format(v) : f === 'minutos' ? n1.format(v) + ' min' : f === 'pct' ? n0.format(v) + '%' : Math.abs(v) >= 100 || Number.isInteger(v) ? n0.format(v) : n1.format(v));
  const corto = (v, f) => (f === 'dinero' ? (v >= 1000 ? '$' + n1.format(v / 1000) + ' mil' : '$' + n0.format(v)) : n0.format(v));
  const svg = (tag, attrs = {}, texto) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (texto !== undefined) e.textContent = texto; return e; };
  const fechaCorta = (iso) => { const d = new Date(iso + 'T12:00:00'); return `${DIAS[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`; };
  const horaTxt = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? ' am' : ' pm'}`;

  /* ---------- tooltip único ---------- */
  let tip = null;
  function mostrarTip(ev, titulo, filas) {
    if (!tip) { tip = el('div', 'tb-tip'); tip.setAttribute('role', 'tooltip'); document.body.append(tip); }
    tip.replaceChildren(el('strong', 'tb-tip-t', titulo));
    for (const [k, v] of filas) { const r = el('div', 'tb-tip-f'); r.append(el('span', '', k), el('b', '', v)); tip.append(r); }
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  const ocultarTip = () => { if (tip) tip.style.display = 'none'; };
  function conTip(nodo, titulo, filas, alClic) {
    nodo.addEventListener('pointermove', (ev) => mostrarTip(ev, titulo, filas));
    nodo.addEventListener('pointerleave', ocultarTip);
    nodo.addEventListener('focus', () => { const r = nodo.getBoundingClientRect(); mostrarTip({ clientX: r.left + r.width / 2, clientY: r.top }, titulo, filas); });
    nodo.addEventListener('blur', ocultarTip);
    if (alClic) { nodo.addEventListener('click', alClic); nodo.style.cursor = 'pointer'; nodo.tabIndex = 0; nodo.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alClic(); } }); }
  }

  /* ---------- gráficas ---------- */
  /** Barras verticales (con línea opcional del periodo anterior). datos: [{ k, etiqueta, v, previo?, extra? }] */
  function barras(cont, { datos, formato = 'numero', alto = 220, colorVar = 'var(--s1)', alClic, linea, marcar }) {
    cont.replaceChildren();
    if (!datos.length) { cont.append(el('p', 'tb-vacio', 'Sin datos en este periodo.')); return; }
    const W = Math.max(280, cont.clientWidth || 600), H = alto, mi = 44, md = 8, ms = 8, mb = 26;
    const max = Math.max(1, ...datos.map((d) => d.v), ...(linea ? datos.map((d) => d.previo || 0) : []));
    const tope = nice(max);
    const el_ = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'tb-svg', role: 'img' });
    const area = W - mi - md, paso = area / datos.length, bw = Math.max(3, Math.min(46, paso - 3));
    const y = (v) => H - mb - (v / tope) * (H - mb - ms);
    for (let i = 0; i <= 4; i++) {
      const v = (tope / 4) * i;
      el_.append(svg('line', { x1: mi, x2: W - md, y1: y(v), y2: y(v), class: i === 0 ? 'tb-eje' : 'tb-rejilla' }));
      el_.append(svg('text', { x: mi - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tb-txt' }, corto(v, formato)));
    }
    const cada = Math.ceil(datos.length / Math.max(1, Math.floor(area / 46)));
    datos.forEach((d, i) => {
      const x = mi + paso * i + (paso - bw) / 2, hh = Math.max(d.v > 0 ? 2 : 0, H - mb - y(d.v));
      const g = svg('g', { class: 'tb-barra' + (marcar && marcar(d) ? ' marcada' : '') });
      const r = Math.min(4, bw / 2, hh);
      g.append(svg('path', { d: `M${x},${H - mb} V${H - mb - hh + r} Q${x},${H - mb - hh} ${x + r},${H - mb - hh} H${x + bw - r} Q${x + bw},${H - mb - hh} ${x + bw},${H - mb - hh + r} V${H - mb} Z`, fill: colorVar }));
      g.append(svg('rect', { x: mi + paso * i, y: ms, width: paso, height: H - mb - ms, fill: 'transparent' }));
      const filasTip = [[d.nombreV || 'Valor', fmt(d.v, formato)]];
      if (linea && d.previo !== undefined) filasTip.push(['Periodo anterior', fmt(d.previo, formato)]);
      for (const e of d.extra || []) filasTip.push(e);
      conTip(g, d.etiqueta, filasTip, alClic ? () => alClic(d) : null);
      el_.append(g);
      if (i % cada === 0) el_.append(svg('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'tb-txt' }, d.corta || d.etiqueta));
    });
    if (linea) {
      const pts = datos.map((d, i) => [mi + paso * i + paso / 2, y(d.previo || 0)]);
      el_.append(svg('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'tb-linea-prev' }));
    }
    cont.append(el_);
  }
  function nice(max) { const p = Math.pow(10, Math.floor(Math.log10(max))); const r = max / p; return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p; }

  /** Barras horizontales (HTML, responsivas). filas: [{ clave, etiqueta, v, sub, color }] */
  function hbarras(cont, { filas, formato = 'numero', alClic, activa, vacio = 'Sin datos en este periodo.' }) {
    cont.replaceChildren();
    if (!filas.length) { cont.append(el('p', 'tb-vacio', vacio)); return; }
    const max = Math.max(1, ...filas.map((f) => f.v));
    for (const f of filas) {
      const fila = el('div', 'tb-hb' + (activa && activa === f.clave ? ' activa' : ''));
      const nombre = el('span', 'tb-hb-n', f.etiqueta);
      nombre.title = f.etiqueta;
      const pista = el('span', 'tb-hb-pista');
      const barra = el('i', 'tb-hb-barra'); barra.style.width = Math.max(1.5, (f.v / max) * 100) + '%'; barra.style.background = f.color || 'var(--s1)';
      pista.append(barra);
      fila.append(nombre, pista, el('b', 'tb-hb-v', fmt(f.v, formato)));
      conTip(fila, f.etiqueta, [[f.nombreV || 'Valor', fmt(f.v, formato)], ...(f.extra || [])], alClic ? () => alClic(f) : null);
      cont.append(fila);
    }
  }

  /** Dona con leyenda. partes: [{ clave, etiqueta, v, color }] */
  function dona(cont, { partes, formato = 'numero', centro, alClic }) {
    cont.replaceChildren();
    const tot = partes.reduce((s, p) => s + p.v, 0);
    if (!partes.length || tot <= 0) { cont.append(el('p', 'tb-vacio', 'Sin datos en este periodo.')); return; }
    const caja = el('div', 'tb-dona');
    const S = 150, R = 62, r = 40, c = S / 2;
    const s = svg('svg', { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: 'img', class: 'tb-dona-svg' });
    let a0 = -Math.PI / 2;
    const punto = (a, rad) => [c + rad * Math.cos(a), c + rad * Math.sin(a)];
    for (const p of partes) {
      const ang = (p.v / tot) * Math.PI * 2;
      if (ang <= 0) continue;
      const a1 = a0 + Math.min(ang, Math.PI * 2 - 0.0001), gap = partes.length > 1 ? 0.025 : 0;
      const [x0, y0] = punto(a0 + gap, R), [x1, y1] = punto(a1 - gap, R), [x2, y2] = punto(a1 - gap, r), [x3, y3] = punto(a0 + gap, r);
      const grande = a1 - a0 > Math.PI ? 1 : 0;
      const t = svg('path', { d: `M${x0},${y0} A${R},${R} 0 ${grande} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${grande} 0 ${x3},${y3} Z`, fill: p.color, class: 'tb-trozo' });
      conTip(t, p.etiqueta, [[fmt(p.v, formato), n0.format((p.v / tot) * 100) + '%']], alClic ? () => alClic(p) : null);
      s.append(t); a0 += ang;
    }
    s.append(svg('text', { x: c, y: c - 2, 'text-anchor': 'middle', class: 'tb-dona-n' }, centro ? centro.valor : fmt(tot, formato)));
    s.append(svg('text', { x: c, y: c + 13, 'text-anchor': 'middle', class: 'tb-txt' }, centro ? centro.texto : 'total'));
    const ley = el('ul', 'tb-ley');
    for (const p of partes) {
      const li = el('li', '');
      const sw = el('i', 'tb-sw'); sw.style.background = p.color;
      li.append(sw, el('span', '', p.etiqueta), el('b', '', `${fmt(p.v, formato)} · ${n0.format((p.v / tot) * 100)}%`));
      ley.append(li);
    }
    caja.append(s, ley); cont.append(caja);
  }

  /** Mapa de calor día de la semana × hora. */
  function calor(cont, datos, metrica) {
    cont.replaceChildren();
    if (!datos.length) { cont.append(el('p', 'tb-vacio', 'Sin datos en este periodo.')); return; }
    const horas = [...new Set(datos.map((d) => d.h))].sort((a, b) => a - b);
    const h0 = Math.min(...horas), h1 = Math.max(...horas);
    const mapa = new Map(datos.map((d) => [`${d.d}-${d.h}`, d]));
    const max = Math.max(1, ...datos.map((d) => d[metrica]));
    const tabla = el('div', 'tb-calor');
    tabla.style.gridTemplateColumns = `44px repeat(${h1 - h0 + 1}, minmax(0, 1fr))`;
    tabla.append(el('span', ''));
    for (let h = h0; h <= h1; h++) tabla.append(el('span', 'tb-calor-h', (h - h0) % 2 === 0 ? horaTxt(h).replace(' ', '') : ''));
    for (let d = 0; d < 7; d++) {
      tabla.append(el('span', 'tb-calor-d', DIAS[d]));
      for (let h = h0; h <= h1; h++) {
        const x = mapa.get(`${d}-${h}`);
        const celda = el('span', 'tb-celda');
        const t = x ? x[metrica] / max : 0;
        celda.style.background = x ? `color-mix(in srgb, var(--s1) ${Math.round(12 + t * 88)}%, var(--surf))` : 'var(--vacio)';
        conTip(celda, `${DIAS_LARGO[d][0].toUpperCase() + DIAS_LARGO[d].slice(1)} ${horaTxt(h)}`, x ? [['Pedidos', n0.format(x.pedidos)], ['Vendido', dinero.format(x.vendido)]] : [['Pedidos', '0']]);
        tabla.append(celda);
      }
    }
    cont.append(tabla);
    const esc = el('div', 'tb-escala'); esc.append(el('span', '', 'Menos'), el('i', 'tb-escala-g'), el('span', '', 'Más'));
    cont.append(esc);
  }

  /** Miniatura de tendencia para una tarjeta. */
  function mini(valores) {
    if (valores.length < 2) return null;
    const W = 84, H = 26, max = Math.max(...valores), min = Math.min(...valores), rg = max - min || 1;
    const pts = valores.map((v, i) => `${(i / (valores.length - 1)) * W},${H - 3 - ((v - min) / rg) * (H - 6)}`);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'tb-mini', 'aria-hidden': 'true' });
    s.append(svg('polyline', { points: pts.join(' ') }));
    return s;
  }

  /* ---------- piezas de interfaz ---------- */
  function tarjeta(titulo, ayuda, ...contenido) {
    const c = el('section', 'tb-card');
    const cab = el('header', 'tb-card-cab');
    cab.append(el('h3', '', titulo));
    c.append(cab);
    if (ayuda) c.append(el('p', 'tb-ayuda', ayuda));
    c.append(...contenido);
    c.cabecera = cab;
    return c;
  }
  function interruptor(opciones, actual, alCambiar) {
    const g = el('div', 'tb-seg'); g.setAttribute('role', 'group');
    for (const [k, t] of opciones) {
      const b = el('button', 'tb-seg-b', t); b.type = 'button'; b.setAttribute('aria-pressed', String(k === actual));
      b.addEventListener('click', () => { alCambiar(k); });
      g.append(b);
    }
    return g;
  }
  function tablaHtml(columnas, filas) {
    const t = document.createElement('table'); t.className = 'rep-tabla tb-tabla';
    const cab = document.createElement('tr');
    columnas.forEach((c, i) => { const th = document.createElement('th'); th.textContent = c; if (i) th.className = 'num'; cab.append(th); });
    t.append(cab);
    for (const f of filas) { const tr = document.createElement('tr'); f.forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i) td.className = 'num'; tr.append(td); }); t.append(tr); }
    return t;
  }
  function delta(act, prev, { inverso = false, formato } = {}) {
    const span = el('span', 'tb-delta');
    if (prev === null || prev === undefined || act === null || act === undefined) { span.textContent = ''; return span; }
    if (prev === 0 && act === 0) { span.textContent = '= igual'; span.className += ' neutro'; return span; }
    if (prev === 0) { span.textContent = 'nuevo'; span.className += ' neutro'; return span; }
    const p = ((act - prev) / Math.abs(prev)) * 100;
    if (Math.abs(p) < 0.5) { span.textContent = '= igual'; span.className += ' neutro'; return span; }
    const sube = p > 0, bueno = inverso ? !sube : sube;
    span.className += bueno ? ' bien' : ' mal';
    span.textContent = `${sube ? '▲' : '▼'} ${n0.format(Math.abs(p))}%`;
    span.title = `Periodo anterior: ${fmt(prev, formato || 'numero')}`;
    return span;
  }
  function kpi({ titulo, valor, previo, actual, formato, inverso, serie, nota, color }) {
    const c = el('div', 'tb-kpi');
    c.append(el('span', 'tb-kpi-t', titulo));
    const v = el('strong', 'tb-kpi-v', valor); if (color) v.style.color = color;
    c.append(v);
    const pie = el('div', 'tb-kpi-pie');
    pie.append(delta(actual, previo, { inverso, formato }));
    if (serie) { const m = mini(serie); if (m) pie.append(m); }
    c.append(pie);
    if (nota) c.append(el('span', 'tb-kpi-nota', nota));
    return c;
  }

  /* ---------- el tablero ---------- */
  function montar(raiz, { alCargar } = {}) {
    const estado = { tab: 'resumen', metDia: 'vendido', comparar: true, metCalor: 'pedidos', ordenProd: 'unidades', prodSel: null, dia: null, busca: '', expl: { fuente: 'ordenes', dimension: 'dia', metrica: 'vendido', vista: 'barras', datos: null, cargando: false } };
    let D = null;
    const cabecera = el('div', 'tb-cab'), tabs = el('div', 'tb-tabs'), cuerpo = el('div', 'tb-cuerpo');
    tabs.setAttribute('role', 'tablist');
    raiz.replaceChildren(cabecera, tabs, cuerpo);
    const TABS = [['resumen', '📊 Resumen'], ['ventas', '💰 Ventas'], ['productos', '🌮 Productos'], ['operacion', '⏱ Operación'], ['clientes', '👥 Clientes'], ['explorar', '🔎 Explorar']];

    function pintarTabs() {
      tabs.replaceChildren();
      for (const [k, t] of TABS) {
        const b = el('button', 'tb-tab', t); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(k === estado.tab));
        b.addEventListener('click', () => { estado.tab = k; pintar(); });
        tabs.append(b);
      }
    }
    function pintarCab() {
      cabecera.replaceChildren();
      if (!D) return;
      const rango = D.desde === D.hasta ? fechaCorta(D.desde) : `${fechaCorta(D.desde)} → ${fechaCorta(D.hasta)}`;
      const t = el('p', 'tb-rango');
      t.append(el('strong', '', rango), el('span', '', ` · ${D.dias} ${D.dias === 1 ? 'día' : 'días'} · se compara con ${D.desde_previo === D.hasta_previo ? fechaCorta(D.desde_previo) : fechaCorta(D.desde_previo) + ' → ' + fechaCorta(D.hasta_previo)}`));
      cabecera.append(t);
      if (estado.dia) {
        const b = el('button', 'btn chico', `✕ Quitar el día ${fechaCorta(estado.dia)} y volver al periodo`); b.type = 'button';
        b.addEventListener('click', () => { estado.dia = null; alCargar && alCargar(null); });
        cabecera.append(b);
      }
    }

    /* ----- Resumen ----- */
    function insights() {
      const R = D.resumen, P = D.previo, out = [];
      const add = (icono, texto) => out.push([icono, texto]);
      if (R.pedidos === 0) { add('💤', 'No hay pedidos en este periodo. Prueba con otro rango de fechas o sucursal.'); return out; }
      if (P.vendido > 0) {
        const p = ((R.vendido - P.vendido) / P.vendido) * 100;
        add(p >= 0 ? '📈' : '📉', `Vendiste ${dinero.format(R.vendido)}: ${p >= 0 ? 'un ' + n0.format(p) + '% más' : 'un ' + n0.format(-p) + '% menos'} que en el periodo anterior (${dinero.format(P.vendido)}).`);
      }
      if (D.por_dia.length > 1) {
        const mejor = [...D.por_dia].sort((a, b) => b.vendido - a.vendido)[0], peor = [...D.por_dia].sort((a, b) => a.vendido - b.vendido)[0];
        add('🏆', `Tu mejor día fue ${fechaCorta(mejor.fecha)} con ${dinero.format(mejor.vendido)} (${mejor.pedidos} pedidos). El más flojo: ${fechaCorta(peor.fecha)}, ${dinero.format(peor.vendido)}.`);
      }
      if (D.calor.length) {
        const porHora = new Map(), porDia = new Map();
        for (const c of D.calor) { porHora.set(c.h, (porHora.get(c.h) || 0) + c.pedidos); porDia.set(c.d, (porDia.get(c.d) || 0) + c.pedidos); }
        const hp = [...porHora].sort((a, b) => b[1] - a[1])[0], dp = [...porDia].sort((a, b) => b[1] - a[1])[0];
        add('🔥', `La hora pico es ${horaTxt(hp[0])} (${hp[1]} pedidos) y el día más fuerte es ${DIAS_LARGO[dp[0]]}. Ahí conviene tener más personal y producto listo.`);
      }
      if (D.productos.length) {
        const p = D.productos[0], tot = D.productos.reduce((s, x) => s + x.unidades, 0);
        add('⭐', `Tu platillo estrella es «${p.nombre}»: ${n0.format(p.unidades)} piezas (${n0.format((p.unidades / Math.max(1, tot)) * 100)}% de lo vendido).`);
      }
      if (D.categorias.length > 1) add('🍽', `La categoría que más dinero deja es «${D.categorias[0].clave}» con ${dinero.format(D.categorias[0].importe)}.`);
      const qr = D.por_origen.find((x) => x.clave === 'qr');
      if (qr && R.pedidos > 0) add('📱', `${n0.format((qr.pedidos / R.pedidos) * 100)}% de los pedidos entra por el QR del cliente; el resto lo levanta tu personal.`);
      if (R.pedidos > 0 && D.pedidos_mixtos > 0) add('🥡', `${D.pedidos_mixtos} pedidos mezclaron platos para comer aquí y para llevar.`);
      const tasaCanc = (R.cancelados / Math.max(1, R.pedidos + R.cancelados)) * 100;
      if (R.cancelados > 0) add(tasaCanc >= 5 ? '⚠️' : 'ℹ️', `Se cancelaron ${R.cancelados} pedidos (${n1.format(tasaCanc)}%). ${tasaCanc >= 5 ? 'Es una tasa alta: revisa si hay platillos agotados o esperas muy largas.' : ''}`);
      if (R.vendido - R.cobrado > 1 && D.dias > 0) add('💳', `Todavía falta cobrar ${dinero.format(R.vendido - R.cobrado)} de lo vendido (cobrado en Caja: ${dinero.format(R.cobrado)}).`);
      if (R.propinas > 0 && R.cobrado > 0) add('🙌', `Las propinas fueron ${dinero.format(R.propinas)}, el ${n1.format((R.propinas / R.cobrado) * 100)}% de lo cobrado.`);
      if (R.pct_a_tiempo !== null) add(R.pct_a_tiempo >= 85 ? '✅' : '⏱', `${R.pct_a_tiempo}% de las entregas salió a tiempo; el promedio fue de ${n1.format(R.minutos_entrega)} min.`);
      return out;
    }

    function tabResumen() {
      const R = D.resumen, P = D.previo, serie = (k) => D.por_dia.map((d) => d[k]);
      const grid = el('div', 'tb-kpis');
      grid.append(
        kpi({ titulo: 'Vendido', valor: dinero.format(R.vendido), actual: R.vendido, previo: P.vendido, formato: 'dinero', serie: serie('vendido') }),
        kpi({ titulo: 'Pedidos', valor: n0.format(R.pedidos), actual: R.pedidos, previo: P.pedidos, serie: serie('pedidos') }),
        kpi({ titulo: 'Ticket promedio', valor: dinero.format(R.ticket), actual: R.ticket, previo: P.ticket, formato: 'dinero', nota: `${n1.format(R.piezas_por_pedido)} piezas por pedido` }),
        kpi({ titulo: 'Cobrado en Caja', valor: dinero.format(R.cobrado), actual: R.cobrado, previo: P.cobrado, formato: 'dinero', nota: R.vendido > 0 ? `${n0.format(Math.min(100, (R.cobrado / R.vendido) * 100))}% de lo vendido` : '' }),
        kpi({ titulo: 'Propinas', valor: dinero.format(R.propinas), actual: R.propinas, previo: P.propinas, formato: 'dinero' }),
        kpi({ titulo: 'Cancelados', valor: n0.format(R.cancelados), actual: R.cancelados, previo: P.cancelados, inverso: true }),
        kpi({ titulo: 'Tiempo de entrega', valor: R.minutos_entrega === null ? '—' : n1.format(R.minutos_entrega) + ' min', actual: R.minutos_entrega, previo: P.minutos_entrega, inverso: true, formato: 'minutos', nota: R.entregas ? `${R.entregas} entregas` : 'Sin entregas registradas' }),
        kpi({ titulo: 'Entregas a tiempo', valor: R.pct_a_tiempo === null ? '—' : R.pct_a_tiempo + '%', actual: R.pct_a_tiempo, previo: P.pct_a_tiempo, formato: 'pct' }),
      );
      const frag = document.createDocumentFragment();
      frag.append(grid);

      const ins = tarjeta('💡 Lo que dicen tus números', 'Lectura automática del periodo; se actualiza con los filtros.');
      const ul = el('ul', 'tb-insights');
      for (const [i, t] of insights()) { const li = el('li', ''); li.append(el('span', 'tb-ins-i', i), el('span', '', t)); ul.append(li); }
      ins.append(ul);
      frag.append(ins);

      // Ventas por día
      const cont = el('div', 'tb-graf');
      const fila = el('div', 'tb-controles');
      const mets = [['vendido', 'Vendido'], ['pedidos', 'Pedidos'], ['ticket', 'Ticket promedio']];
      fila.append(interruptor(mets, estado.metDia, (k) => { estado.metDia = k; pintar(); }));
      const cmp = el('label', 'tb-chk'); const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = estado.comparar;
      ck.addEventListener('change', () => { estado.comparar = ck.checked; pintar(); });
      cmp.append(ck, el('span', '', 'Comparar con el periodo anterior'));
      fila.append(cmp);
      const val = (d) => (estado.metDia === 'ticket' ? (d.pedidos ? d.vendido / d.pedidos : 0) : d[estado.metDia]);
      const formato = estado.metDia === 'pedidos' ? 'numero' : 'dinero';
      const previos = D.por_dia_previo;
      const datos = D.por_dia.map((d, i) => ({ k: d.fecha, etiqueta: fechaCorta(d.fecha), corta: D.por_dia.length > 14 ? String(Number(d.fecha.slice(8))) : fechaCorta(d.fecha).split(' ')[1] || d.fecha, v: val(d), nombreV: mets.find((m) => m[0] === estado.metDia)[1], previo: previos[i] ? val(previos[i]) : 0, extra: [['Pedidos', n0.format(d.pedidos)], ['Vendido', dinero.format(d.vendido)], ...(d.cancelados ? [['Cancelados', String(d.cancelados)]] : [])] }));
      const cardDia = tarjeta('Ventas por día', D.dias > 1 ? 'Toca un día para ver solo ese día.' : 'Un solo día seleccionado.', fila, cont);
      frag.append(cardDia);
      requestAnimationFrame(() => barras(cont, { datos, formato, linea: estado.comparar && previos.length > 0, alClic: D.dias > 1 ? (d) => { estado.dia = d.k; alCargar && alCargar(d.k); } : null, marcar: (d) => d.k === estado.dia }));
      if (estado.comparar && previos.length) cardDia.append(el('p', 'tb-leyenda-linea', '▬ Línea gris: el mismo punto del periodo anterior'));

      const dos = el('div', 'tb-dos');
      const modal = el('div'), orig = el('div'), pago = el('div');
      dos.append(tarjeta('Tipo de pedido', 'Dónde se come lo que vendes.', modal), tarjeta('Quién levanta el pedido', 'QR del cliente o mostrador.', orig));
      frag.append(dos);
      dona(modal, { partes: D.por_modalidad.map((x) => ({ clave: x.clave, etiqueta: nom(x.clave), v: x.vendido, color: `var(--s${COLOR[x.clave] || 8})` })), formato: 'dinero' });
      dona(orig, { partes: D.por_origen.map((x) => ({ clave: x.clave, etiqueta: nom(x.clave), v: x.pedidos, color: `var(--s${COLOR[x.clave] || 8})` })), formato: 'numero', centro: { valor: n0.format(R.pedidos), texto: 'pedidos' } });
      const dos2 = el('div', 'tb-dos');
      dos2.append(tarjeta('Formas de pago', 'Lo cobrado en Caja por método.', pago));
      hbarras(pago, { filas: D.por_metodo.map((x) => ({ clave: x.metodo, etiqueta: nom(x.metodo), v: x.monto, color: `var(--s${COLOR[x.metodo] || 8})`, extra: [['Pagos', String(x.pagos)], ['Propinas', dinero.format(x.propinas)], ['Comisión', dinero.format(x.comision)]] })), formato: 'dinero', vacio: 'Aún no hay cobros en este periodo.' });
      if (D.sucursales.length > 1 && !D.sucursal) {
        const s = el('div'); dos2.append(tarjeta('Sucursales', 'Quién vendió más.', s));
        hbarras(s, { filas: D.por_sucursal.map((x) => ({ clave: x.id, etiqueta: x.nombre, v: x.vendido, extra: [['Pedidos', String(x.pedidos)], ['Cobrado', dinero.format(x.cobrado)], ['Cancelados', String(x.cancelados)]] })), formato: 'dinero' });
      }
      frag.append(dos2);
      return frag;
    }

    /* ----- Ventas ----- */
    function tabVentas() {
      const frag = document.createDocumentFragment();
      const c1 = el('div');
      const ctrl = interruptor([['pedidos', 'Pedidos'], ['vendido', 'Vendido']], estado.metCalor, (k) => { estado.metCalor = k; pintar(); });
      frag.append(tarjeta('¿Cuándo se vende más?', 'Cada cuadro es una hora de un día de la semana; mientras más oscuro, más movimiento. Pasa el cursor para ver el detalle.', ctrl, c1));
      calor(c1, D.calor, estado.metCalor);
      const porHora = new Map(), porDia = new Map(), diasConteo = new Map();
      for (const c of D.calor) { const h = porHora.get(c.h) || { pedidos: 0, vendido: 0 }; h.pedidos += c.pedidos; h.vendido += c.vendido; porHora.set(c.h, h); const d = porDia.get(c.d) || { pedidos: 0, vendido: 0 }; d.pedidos += c.pedidos; d.vendido += c.vendido; porDia.set(c.d, d); }
      for (const d of D.por_dia) { const w = (new Date(d.fecha + 'T12:00:00').getDay() + 6) % 7; diasConteo.set(w, (diasConteo.get(w) || 0) + 1); }
      const dos = el('div', 'tb-dos');
      const g1 = el('div', 'tb-graf'), g2 = el('div', 'tb-graf');
      dos.append(tarjeta('Pedidos por hora', 'Suma de todo el periodo.', g1), tarjeta('Ventas por día de la semana', D.dias > 7 ? 'Promedio por día (suma ÷ cuántas veces cayó ese día).' : 'Suma del periodo.', g2));
      frag.append(dos);
      const horas = [...porHora.keys()].sort((a, b) => a - b);
      requestAnimationFrame(() => {
        barras(g1, { datos: horas.map((h) => ({ k: h, etiqueta: horaTxt(h), corta: horaTxt(h).replace(' ', ''), v: porHora.get(h)[estado.metCalor], nombreV: estado.metCalor === 'pedidos' ? 'Pedidos' : 'Vendido', extra: [['Vendido', dinero.format(porHora.get(h).vendido)]] })), formato: estado.metCalor === 'pedidos' ? 'numero' : 'dinero', alto: 200 });
        barras(g2, { datos: [0, 1, 2, 3, 4, 5, 6].filter((d) => porDia.has(d)).map((d) => { const n = D.dias > 7 ? Math.max(1, diasConteo.get(d) || 1) : 1; return { k: d, etiqueta: DIAS_LARGO[d][0].toUpperCase() + DIAS_LARGO[d].slice(1), corta: DIAS[d], v: porDia.get(d).vendido / n, nombreV: D.dias > 7 ? 'Promedio vendido' : 'Vendido', extra: [['Pedidos', n0.format(porDia.get(d).pedidos)]] }; }), formato: 'dinero', alto: 200, colorVar: 'var(--s2)' });
      });
      const dos2 = el('div', 'tb-dos');
      const z = el('div'), m = el('div');
      dos2.append(tarjeta('Ventas por zona', 'Piso, patio, comedor… según la mesa del pedido.', z), tarjeta('Mesas que más venden', 'Las 15 mejores.', m));
      frag.append(dos2);
      hbarras(z, { filas: D.por_zona.map((x) => ({ clave: x.clave, etiqueta: x.clave, v: x.vendido, extra: [['Pedidos', String(x.pedidos)]] })), formato: 'dinero' });
      hbarras(m, { filas: D.por_mesa.map((x) => ({ clave: x.clave, etiqueta: '🪑 ' + x.clave, v: x.vendido, extra: [['Pedidos', String(x.pedidos)]] })), formato: 'dinero', vacio: 'Aún no hay pedidos con mesa en este periodo.' });
      const canc = D.por_dia.filter((d) => d.cancelados > 0);
      if (canc.length) {
        const g = el('div', 'tb-graf'); frag.append(tarjeta('Cancelaciones por día', 'Días con pedidos cancelados.', g));
        requestAnimationFrame(() => barras(g, { datos: canc.map((d) => ({ k: d.fecha, etiqueta: fechaCorta(d.fecha), v: d.cancelados, nombreV: 'Cancelados' })), alto: 160, colorVar: 'var(--mal)' }));
      }
      return frag;
    }

    /* ----- Productos ----- */
    function tabProductos() {
      const frag = document.createDocumentFragment();
      const totU = D.productos.reduce((s, p) => s + p.unidades, 0), totI = D.productos.reduce((s, p) => s + p.importe, 0);
      const ord = [...D.productos].sort((a, b) => b[estado.ordenProd] - a[estado.ordenProd]);
      const top = el('div');
      const ctrl = interruptor([['unidades', 'Piezas'], ['importe', 'Dinero'], ['pedidos', 'En cuántos pedidos']], estado.ordenProd, (k) => { estado.ordenProd = k; pintar(); });
      frag.append(tarjeta('Lo que más se vende', 'Toca un platillo para ver cómo se mueve día a día.', ctrl, top));
      hbarras(top, { filas: ord.slice(0, 10).map((p) => ({ clave: p.nombre, etiqueta: p.nombre, v: p[estado.ordenProd], extra: [['Piezas', n0.format(p.unidades)], ['Importe', dinero.format(p.importe)], ['Categoría', p.categoria]] })), formato: estado.ordenProd === 'importe' ? 'dinero' : 'numero', alClic: (f) => { estado.prodSel = estado.prodSel === f.clave ? null : f.clave; pintar(); }, activa: estado.prodSel });
      if (estado.prodSel) {
        const p = D.productos.find((x) => x.nombre === estado.prodSel);
        if (p) {
          const g = el('div', 'tb-graf');
          const tarj = tarjeta(`Detalle: ${p.nombre}`, `${n0.format(p.unidades)} piezas · ${dinero.format(p.importe)} · ${n0.format((p.unidades / Math.max(1, totU)) * 100)}% de las piezas · ${n0.format((p.importe / Math.max(0.01, totI)) * 100)}% del dinero · en ${p.pedidos} pedidos`, g);
          const dias = new Map(D.producto_dia.filter((x) => x.nombre === p.nombre).map((x) => [x.fecha, x.unidades]));
          if (dias.size) { requestAnimationFrame(() => barras(g, { datos: D.por_dia.map((d) => ({ k: d.fecha, etiqueta: fechaCorta(d.fecha), corta: D.por_dia.length > 14 ? String(Number(d.fecha.slice(8))) : fechaCorta(d.fecha).split(' ')[1], v: dias.get(d.fecha) || 0, nombreV: 'Piezas' })), alto: 170, colorVar: 'var(--s3)' })); }
          else g.append(el('p', 'tb-vacio', 'El detalle diario está disponible para los 12 platillos más vendidos.'));
          frag.append(tarj);
        }
      }
      const dos = el('div', 'tb-dos');
      const cat = el('div'), flojos = el('div');
      dos.append(tarjeta('Categorías', 'Cuánto deja cada categoría.', cat), tarjeta('Los que menos se venden', 'Candidatos a promoción o a salir del menú.', flojos));
      frag.append(dos);
      const paleta = D.categorias.slice(0, 7).map((c, i) => ({ clave: c.clave, etiqueta: c.clave, v: c.importe, color: `var(--s${i + 1})` }));
      const resto = D.categorias.slice(7).reduce((s, c) => s + c.importe, 0);
      if (resto > 0) paleta.push({ clave: 'otras', etiqueta: 'Otras', v: resto, color: 'var(--gris)' });
      dona(cat, { partes: paleta, formato: 'dinero' });
      const peores = [...D.productos].sort((a, b) => a.unidades - b.unidades).slice(0, 6);
      hbarras(flojos, { filas: peores.map((p) => ({ clave: p.nombre, etiqueta: p.nombre, v: p.unidades, color: 'var(--s4)', extra: [['Importe', dinero.format(p.importe)]] })), formato: 'numero', vacio: 'Aún no hay ventas.' });
      const dos2 = el('div', 'tb-dos');
      const ex = el('div'), pa = el('div');
      dos2.append(tarjeta('Modificadores más pedidos', 'Extras y variantes que más eligen.', ex), tarjeta('Se piden juntos', 'Pares de platillos que aparecen en el mismo pedido: ideales para combos.', pa));
      frag.append(dos2);
      hbarras(ex, { filas: D.extras.map((x) => ({ clave: x.clave, etiqueta: x.clave, v: x.veces, color: 'var(--s7)' })), formato: 'numero', vacio: 'Aún no hay modificadores pedidos.' });
      hbarras(pa, { filas: D.pares.map((x) => ({ clave: x.a + x.b, etiqueta: `${x.a} + ${x.b}`, v: x.veces, color: 'var(--s5)' })), formato: 'numero', vacio: 'Necesitas más pedidos para ver combinaciones (mínimo 2 veces juntos).' });
      // tabla completa con búsqueda
      const caja = el('div', 'tb-tabla-caja');
      const buscar = document.createElement('input'); buscar.type = 'search'; buscar.placeholder = 'Buscar platillo o categoría…'; buscar.className = 'tb-buscar'; buscar.value = estado.busca;
      const pintarTabla = () => {
        const q = buscar.value.trim().toLowerCase();
        const filas = ord.filter((p) => !q || p.nombre.toLowerCase().includes(q) || p.categoria.toLowerCase().includes(q));
        caja.replaceChildren(tablaHtml(['Platillo', 'Categoría', 'Piezas', 'Importe', '% dinero'], filas.map((p) => [p.nombre, p.categoria, n0.format(p.unidades), dinero.format(p.importe), n1.format((p.importe / Math.max(0.01, totI)) * 100) + '%'])));
      };
      buscar.addEventListener('input', () => { estado.busca = buscar.value; pintarTabla(); });
      pintarTabla();
      frag.append(tarjeta('Todos los platillos', `${D.productos.length} platillos con ventas en el periodo.`, buscar, caja));
      return frag;
    }

    /* ----- Operación ----- */
    function tabOperacion() {
      const frag = document.createDocumentFragment(), R = D.resumen, P = D.previo, T = D.tiempos;
      const grid = el('div', 'tb-kpis');
      const total = T.resultado.reduce((s, x) => s + x.n, 0);
      grid.append(
        kpi({ titulo: 'Tiempo promedio de entrega', valor: R.minutos_entrega === null ? '—' : n1.format(R.minutos_entrega) + ' min', actual: R.minutos_entrega, previo: P.minutos_entrega, inverso: true, formato: 'minutos' }),
        kpi({ titulo: 'Entregas a tiempo', valor: R.pct_a_tiempo === null ? '—' : R.pct_a_tiempo + '%', actual: R.pct_a_tiempo, previo: P.pct_a_tiempo, formato: 'pct' }),
        kpi({ titulo: 'Entregas registradas', valor: n0.format(total), actual: R.entregas, previo: P.entregas }),
        kpi({ titulo: 'Lugar promedio en la fila', valor: T.posicion_prom === null ? '—' : n1.format(T.posicion_prom), nota: '1 = nadie delante' }),
        kpi({ titulo: 'Reabiertos', valor: n0.format(T.reabiertos), nota: 'Pedidos que volvieron a cocina' }),
        kpi({ titulo: 'Agendados', valor: n0.format(R.agendados), actual: R.agendados, previo: P.agendados }),
        kpi({ titulo: 'Cancelados', valor: n0.format(R.cancelados), actual: R.cancelados, previo: P.cancelados, inverso: true }),
        kpi({ titulo: 'Pedidos mixtos', valor: n0.format(D.pedidos_mixtos), nota: 'Aquí + para llevar' }),
      );
      frag.append(grid);
      if (!total) { frag.append(tarjeta('Tiempos de entrega', 'Cuando cocina marque pedidos como entregados, aquí verás cuánto tardan y si cumplen el tiempo prometido.', el('p', 'tb-vacio', 'Sin entregas registradas en este periodo.'))); return frag; }
      const dos = el('div', 'tb-dos');
      const res = el('div'), his = el('div', 'tb-graf');
      dos.append(tarjeta('¿Cumples el tiempo prometido?', 'Entregas antes, a tiempo o atrasadas.', res), tarjeta('¿Cuánto tardan los pedidos?', 'Cuántos pedidos caen en cada rango de minutos.', his));
      frag.append(dos);
      const orden = ['anticipado', 'a_tiempo', 'atrasado'];
      dona(res, { partes: orden.map((k) => ({ clave: k, etiqueta: nom(k), v: (T.resultado.find((x) => x.clave === k) || { n: 0 }).n, color: ESTADO_COLOR[k] })).filter((p) => p.v > 0), centro: { valor: R.pct_a_tiempo === null ? '—' : R.pct_a_tiempo + '%', texto: 'a tiempo' } });
      requestAnimationFrame(() => barras(his, { datos: T.histograma.map((x) => ({ k: x.b, etiqueta: x.b >= 12 ? '60+ min' : `${x.b * 5}–${x.b * 5 + 5} min`, corta: x.b >= 12 ? '60+' : String(x.b * 5), v: x.n, nombreV: 'Pedidos' })), alto: 200, colorVar: 'var(--s1)' }));
      const dos2 = el('div', 'tb-dos');
      const mo = el('div'), ho = el('div', 'tb-graf');
      dos2.append(tarjeta('Tiempo por tipo de pedido', 'Minutos promedio de levantado a entregado.', mo), tarjeta('Tiempo promedio por hora', 'A qué horas se atora la cocina.', ho));
      frag.append(dos2);
      hbarras(mo, { filas: T.por_modalidad.map((x) => ({ clave: x.clave, etiqueta: nom(x.clave), v: x.min, color: `var(--s${COLOR[x.clave] || 8})`, extra: [['Entregas', String(x.n)]] })), formato: 'minutos' });
      requestAnimationFrame(() => barras(ho, { datos: T.por_hora.map((x) => ({ k: x.h, etiqueta: horaTxt(x.h), corta: horaTxt(x.h).replace(' ', ''), v: x.min, nombreV: 'Minutos', extra: [['Entregas', String(x.n)]] })), formato: 'minutos', alto: 200, colorVar: 'var(--s2)' }));
      return frag;
    }

    /* ----- Clientes ----- */
    function tabClientes() {
      const frag = document.createDocumentFragment(), C = D.clientes, R = D.resumen;
      const grid = el('div', 'tb-kpis');
      grid.append(
        kpi({ titulo: 'Clientes con teléfono', valor: n0.format(C.con_telefono), nota: 'En este periodo' }),
        kpi({ titulo: 'Recurrentes', valor: n0.format(C.recurrentes), nota: C.con_telefono ? `${n0.format((C.recurrentes / C.con_telefono) * 100)}% de los que dejaron teléfono` : '' }),
        kpi({ titulo: 'Nuevos', valor: n0.format(C.nuevos), nota: 'Primera vez que piden' }),
        kpi({ titulo: 'Sin teléfono', valor: n0.format(C.sin_telefono), nota: R.pedidos ? `${n0.format((C.sin_telefono / Math.max(1, R.pedidos)) * 100)}% de los pedidos` : '' }),
        kpi({ titulo: 'Contactos guardados', valor: n0.format(C.contactos), nota: `${n0.format(C.contactos_nuevos)} nuevos en el periodo` }),
        kpi({ titulo: 'Aceptan promociones', valor: n0.format(C.acepta_promos), nota: C.contactos ? `${n0.format((C.acepta_promos / C.contactos) * 100)}% de tus contactos` : '' }),
      );
      frag.append(grid);
      const dos = el('div', 'tb-dos');
      const d1 = el('div');
      dos.append(tarjeta('Nuevos vs. recurrentes', 'Solo clientes que dejaron su teléfono.', d1));
      dona(d1, { partes: [{ clave: 'rec', etiqueta: 'Recurrentes', v: C.recurrentes, color: 'var(--s3)' }, { clave: 'nue', etiqueta: 'Nuevos', v: C.nuevos, color: 'var(--s1)' }].filter((p) => p.v > 0), centro: { valor: n0.format(C.con_telefono), texto: 'clientes' } });
      const tip = tarjeta('Cómo mejorar estos números', 'Ideas rápidas.');
      const ul = el('ul', 'tb-insights');
      const idea = (i, t) => { const li = el('li', ''); li.append(el('span', 'tb-ins-i', i), el('span', '', t)); ul.append(li); };
      if (R.pedidos && C.sin_telefono / Math.max(1, R.pedidos) > 0.5) idea('📞', 'Más de la mitad de los pedidos no deja teléfono. Pídelo al levantar el pedido para poder avisarles y para saber quién regresa.');
      if (C.contactos && C.acepta_promos / C.contactos < 0.5) idea('📣', 'Pocos contactos aceptan promociones. Recuérdales la casilla de promociones al pedir.');
      if (C.con_telefono && C.recurrentes / C.con_telefono >= 0.4) idea('💚', 'Buena fidelidad: más del 40% de tus clientes ya había pedido antes.');
      if (!ul.children.length) idea('✅', 'Sin alertas por ahora. Sigue juntando contactos para ver más.');
      tip.append(ul); dos.append(tip);
      frag.append(dos);
      frag.append(tarjeta('Tus mejores clientes', 'Por dinero gastado en el periodo (teléfono parcial por privacidad).', D.clientes.top.length ? tablaHtml(['Cliente', 'Teléfono', 'Pedidos', 'Gastado', 'Último'], C.top.map((x) => [x.nombre, x.tel, x.pedidos, dinero.format(x.gastado), fechaCorta(x.ultimo)])) : el('p', 'tb-vacio', 'Aún no hay clientes con teléfono en este periodo.')));
      return frag;
    }

    /* ----- Explorar ----- */
    const nombreClave = (dim, k) => {
      if (/dia_semana/.test(dim)) return DIAS_LARGO[Number(k)] ? DIAS_LARGO[Number(k)][0].toUpperCase() + DIAS_LARGO[Number(k)].slice(1) : k;
      if (/^hora$/.test(dim)) return horaTxt(Number(k));
      if (/^dia$|^mes$|^col_.*/.test(dim) && /^\d{4}-\d{2}-\d{2}/.test(k)) return fechaCorta(k.slice(0, 10));
      return nom(k);
    };
    async function cargarExplorar() {
      const e = estado.expl; e.cargando = true;
      const q = new URLSearchParams({ explorar: 1, fuente: e.fuente, dimension: e.dimension, metrica: e.metrica, desde: D.desde, hasta: D.hasta });
      if (D.sucursal) q.set('sucursal', D.sucursal);
      try { e.datos = await pedir(API + 'admin/reportes.php?' + q); e.error = ''; } catch (err) { e.datos = null; e.error = err.message; }
      e.cargando = false;
      if (estado.tab === 'explorar') pintar();
    }
    function tabExplorar() {
      const frag = document.createDocumentFragment(), e = estado.expl, cat = D.explorador[e.fuente];
      if (!cat.dimensiones.some((d) => d.id === e.dimension)) e.dimension = cat.dimensiones[0].id;
      if (!cat.metricas.some((m) => m.id === e.metrica)) e.metrica = cat.metricas[0].id;
      const sel = (rotulo, opciones, valor, alCambiar) => {
        const l = el('label', 'tb-sel'); l.append(el('span', '', rotulo));
        const s = document.createElement('select');
        for (const [v, t, nuevo] of opciones) { const o = document.createElement('option'); o.value = v; o.textContent = t + (nuevo ? '  ✦ nuevo' : ''); s.append(o); }
        s.value = valor; s.addEventListener('change', () => alCambiar(s.value)); l.append(s); return l;
      };
      const barra = el('div', 'tb-expl-barra');
      barra.append(
        sel('Analizar', Object.entries(D.explorador).map(([k, v]) => [k, v.etiqueta]), e.fuente, (v) => { e.fuente = v; e.datos = null; pintar(); }),
        sel('Medir', cat.metricas.map((m) => [m.id, m.etiqueta, m.auto]), e.metrica, (v) => { e.metrica = v; e.datos = null; pintar(); }),
        sel('Agrupar por', cat.dimensiones.map((d) => [d.id, d.etiqueta, d.auto]), e.dimension, (v) => { e.dimension = v; e.datos = null; pintar(); }),
      );
      const vista = interruptor([['barras', 'Barras'], ['dona', 'Dona'], ['tabla', 'Tabla']], e.vista, (k) => { e.vista = k; pintar(); });
      const out = el('div', 'tb-graf');
      const met = cat.metricas.find((m) => m.id === e.metrica), dim = cat.dimensiones.find((d) => d.id === e.dimension);
      frag.append(tarjeta('Arma tu propio reporte', 'Elige qué medir y cómo agruparlo. Las columnas nuevas de la base de datos aparecen aquí solas (marcadas como «nuevo»).', barra, vista, out));
      if (!e.datos && !e.cargando && !e.error) cargarExplorar();
      if (e.cargando) out.append(el('p', 'tb-vacio', 'Calculando…'));
      else if (e.error) out.append(el('p', 'msg-error', e.error));
      else if (e.datos) {
        const f = e.datos.filas.map((x) => ({ ...x, etiqueta: nombreClave(e.dimension, x.clave) }));
        const formato = e.datos.formato;
        if (!f.length) out.append(el('p', 'tb-vacio', 'Sin datos en este periodo.'));
        else if (e.vista === 'tabla') out.append(tablaHtml([dim.etiqueta, met.etiqueta, 'Pedidos'], f.map((x) => [x.etiqueta, fmt(x.valor, formato), x.pedidos])));
        else if (e.vista === 'dona') dona(out, { partes: f.slice(0, 8).map((x, i) => ({ clave: x.clave, etiqueta: x.etiqueta, v: Math.max(0, x.valor), color: `var(--s${i + 1})` })), formato });
        else if (dim.temporal) requestAnimationFrame(() => barras(out, { datos: f.map((x) => ({ k: x.clave, etiqueta: x.etiqueta, corta: x.etiqueta.split(' ')[0], v: x.valor, nombreV: met.etiqueta, extra: [['Pedidos', String(x.pedidos)]] })), formato }));
        else hbarras(out, { filas: f.slice(0, 25).map((x) => ({ clave: x.clave, etiqueta: x.etiqueta, v: Math.max(0, x.valor), extra: [['Pedidos', String(x.pedidos)]] })), formato });
      }
      return frag;
    }

    const VISTAS = { resumen: tabResumen, ventas: tabVentas, productos: tabProductos, operacion: tabOperacion, clientes: tabClientes, explorar: tabExplorar };
    function pintar() {
      pintarTabs(); pintarCab(); ocultarTip();
      cuerpo.replaceChildren();
      if (!D) return;
      cuerpo.append(VISTAS[estado.tab]());
    }
    let tamano = 0;
    new ResizeObserver(() => { const w = raiz.clientWidth; if (D && Math.abs(w - tamano) > 40) { tamano = w; pintar(); } }).observe(raiz);
    return {
      poner(datos) { D = datos; estado.expl.datos = null; estado.expl.error = ''; cuerpo.classList.remove('cargando'); pintar(); },
      cargando() { cuerpo.classList.add('cargando'); },
      marcarDia(d) { estado.dia = d; },
    };
  }
  return { montar };
})();
