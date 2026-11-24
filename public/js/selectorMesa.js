/* Selector visual de mesa, compartido por la pantalla del cliente (QR) y la de Tomar pedidos.
   elegirMesaEnPlano(...) → mesa elegida, null (quitar la mesa) o undefined (cancelado).
   crearCampoMesa(select, botón, alCambiar) → { poner({mesas, zonas, plano}), refrescar() }: el <select> sigue siendo el valor real;
   si el administrador activó el plano, el select se esconde y en su lugar hay un botón que abre el dibujo. */
/** Medidas reales (cm) de una mesa: las suyas o las estándar de su forma. Cuadrada y redonda: un solo valor (lado o diámetro). */
const MEDIDAS_BASE = { cuadrada: [80, 80], redonda: [80, 80], rectangular: [160, 80] };
function medidasMesa(m) {
  const forma = m.forma === 'larga' ? 'rectangular' : (MEDIDAS_BASE[m.forma] ? m.forma : 'cuadrada');
  const b = MEDIDAS_BASE[forma];
  const w = m.ancho_cm || b[0];
  return [w, forma === 'rectangular' ? (m.alto_cm || b[1]) : w];
}
/** Pone la mesa a escala real: el lienzo (16:10) representa `anchoM` metros de ancho. */
function aplicarTamanoMesa(b, m, anchoM) {
  const [w, h] = medidasMesa(m);
  const ancho = (anchoM || 10) * 100;
  b.style.width = (w / ancho) * 100 + '%';
  b.style.height = (h / ((ancho * 10) / 16)) * 100 + '%';
  b.style.setProperty('--fs', String(Math.min(w, h) / ancho * 100 * 0.38));
}

/** Fondo de una zona con forma irregular: polígono en % del lienzo. */
function fondoZona(poligono) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'plano-fondo');
  const pol = document.createElementNS(ns, 'polygon');
  pol.setAttribute('points', poligono.map((p) => p.join(',')).join(' '));
  pol.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(pol);
  return svg;
}
/** Dibuja el lienzo de una zona: con forma irregular si la tiene. */
function pintarLienzoZona(lienzo, zona) {
  lienzo.replaceChildren();
  const poli = zona && Array.isArray(zona.poligono) ? zona.poligono : null;
  lienzo.classList.toggle('con-forma', !!poli);
  if (poli) lienzo.append(fondoZona(poli));
}

function elegirMesaEnPlano({ zonas, mesas, elegida, permitirQuitar }) {
  return new Promise((resolver) => {
    const d = document.createElement('dialog');
    d.className = 'dlg-plano-sel';
    let zona = (mesas.find((m) => String(m.id) === String(elegida)) || {}).zona_id || (zonas[0] && zonas[0].id) || null;
    let respuesta;
    const cab = el('div', 'plano-sel-cab');
    cab.append(el('strong', '', 'Toca tu mesa'));
    const x = el('button', 'btn', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar'); x.addEventListener('click', () => d.close());
    cab.append(x);
    const tabs = el('div', 'plano-pestanas');
    const lienzo = el('div', 'plano-lienzo');
    const rotSin = el('p', 'ayuda', 'Otras mesas (sin ubicar en el plano):');
    const sin = el('div', 'plano-sin');
    const pie = el('div', 'plano-sel-pie');
    if (permitirQuitar) {
      const q = el('button', 'btn', 'Sin mesa'); q.type = 'button';
      q.addEventListener('click', () => { respuesta = null; d.close(); });
      pie.append(q);
    }
    const elegir = (m) => { respuesta = m; d.close(); };
    function pintar() {
      tabs.replaceChildren();
      tabs.hidden = zonas.length < 2;
      for (const z of zonas) {
        const b = el('button', 'btn', z.nombre); b.type = 'button'; b.setAttribute('aria-pressed', String(z.id === zona));
        b.addEventListener('click', () => { zona = z.id; pintar(); });
        tabs.append(b);
      }
      pintarLienzoZona(lienzo, zonas.find((z) => z.id === zona));
      const aqui = mesas.filter((m) => m.zona_id === zona && m.x !== null);
      if (!aqui.length) lienzo.append(el('div', 'plano-vacio', 'No hay mesas dibujadas en esta zona.'));
      for (const m of aqui) {
        const b = el('button', 'plano-mesa ' + (m.forma === 'larga' ? 'rectangular' : m.forma) + (String(m.id) === String(elegida) ? ' elegida' : ''), m.nombre);
        b.type = 'button'; b.style.left = m.x + '%'; b.style.top = m.y + '%'; aplicarTamanoMesa(b, m, (zonas.find((z) => z.id === zona) || {}).ancho_m);
        b.addEventListener('click', () => elegir(m));
        lienzo.append(b);
      }
      sin.replaceChildren();
      const libres = mesas.filter((m) => m.zona_id === null || m.x === null);
      rotSin.hidden = sin.hidden = libres.length === 0;
      for (const m of libres) {
        const b = el('button', 'btn chico', etiquetaMesaLista(m, zonas)); b.type = 'button';
        b.addEventListener('click', () => elegir(m));
        sin.append(b);
      }
    }
    d.append(cab, tabs, lienzo, rotSin, sin, pie);
    d.addEventListener('close', () => { d.remove(); resolver(respuesta); });
    pintar();
    document.body.append(d);
    d.showModal();
  });
}

/** «9 · Patio» si la mesa tiene zona (hay mesas con el mismo número en zonas distintas). */
function etiquetaMesaLista(m, zonas) {
  const z = m.zona_id !== null && m.zona_id !== undefined ? (zonas || []).find((q) => q.id === m.zona_id) : null;
  return z ? `${m.nombre} · ${z.nombre}` : m.nombre;
}

function crearCampoMesa(sel, btn, alCambiar) {
  let datos = { mesas: [], zonas: [], plano: false };
  function refrescar() {
    sel.style.display = datos.plano ? 'none' : '';
    btn.style.display = datos.plano ? '' : 'none';
    if (!datos.plano) return;
    const m = datos.mesas.find((x) => String(x.id) === sel.value);
    const z = m && datos.zonas.find((q) => q.id === m.zona_id);
    btn.textContent = m ? `🪑 Mesa ${m.nombre}${z ? ' · ' + z.nombre : ''} (cambiar)` : '🪑 Elegir mesa';
  }
  sel.addEventListener('change', () => { refrescar(); alCambiar(); });
  btn.addEventListener('click', async () => {
    const r = await elegirMesaEnPlano({ zonas: datos.zonas, mesas: datos.mesas, elegida: sel.value, permitirQuitar: !!sel.value });
    if (r === undefined) return;
    sel.value = r ? String(r.id) : '';
    refrescar();
    alCambiar();
  });
  return {
    poner(d, vacio = 'Elige la mesa…') {
      datos = { mesas: d.mesas || [], zonas: d.zonas || [], plano: d.plano === true };
      const actual = sel.value;
      sel.replaceChildren(new Option(vacio, ''), ...datos.mesas.map((m) => new Option(etiquetaMesaLista(m, datos.zonas), String(m.id))));
      sel.value = datos.mesas.some((m) => String(m.id) === actual) ? actual : '';
      refrescar();
    },
    refrescar,
  };
}
