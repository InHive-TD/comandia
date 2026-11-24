/* Selector visual de mesa, compartido por la pantalla del cliente (QR) y la de Tomar pedidos.
   elegirMesaEnPlano(...) → mesa elegida, null (quitar la mesa) o undefined (cancelado).
   crearCampoMesa(select, botón, alCambiar) → { poner({mesas, zonas, plano}), refrescar() }: el <select> sigue siendo el valor real;
   si el administrador activó el plano, el select se esconde y en su lugar hay un botón que abre el dibujo. */
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
      lienzo.replaceChildren();
      const aqui = mesas.filter((m) => m.zona_id === zona && m.x !== null);
      if (!aqui.length) lienzo.append(el('div', 'plano-vacio', 'No hay mesas dibujadas en esta zona.'));
      for (const m of aqui) {
        const b = el('button', 'plano-mesa ' + m.forma + (String(m.id) === String(elegida) ? ' elegida' : ''), m.nombre);
        b.type = 'button'; b.style.left = m.x + '%'; b.style.top = m.y + '%';
        b.addEventListener('click', () => elegir(m));
        lienzo.append(b);
      }
      sin.replaceChildren();
      const libres = mesas.filter((m) => m.zona_id === null || m.x === null);
      rotSin.hidden = sin.hidden = libres.length === 0;
      for (const m of libres) {
        const b = el('button', 'btn chico', m.nombre); b.type = 'button';
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
      sel.replaceChildren(new Option(vacio, ''), ...datos.mesas.map((m) => new Option(m.nombre, String(m.id))));
      sel.value = datos.mesas.some((m) => String(m.id) === actual) ? actual : '';
      refrescar();
    },
    refrescar,
  };
}
