/* Recetas (inventario nivel completo): insumos por porción de cada platillo y de cada modificador. Se carga después de admin.js. */
const dlgRecetas = $('dlg-recetas');
const dlgRecetaEd = $('dlg-receta-editor');
const rc = { datos: null, tab: 'platillos', q: '', abiertas: new Set(), editando: null };
const RC_FAMILIA = { kg: ['g', 'kg'], g: ['g', 'kg'], l: ['ml', 'l'], ml: ['ml', 'l'], pza: ['pza'] };
const RC_TXT = { kg: 'kg', g: 'g', l: 'L', ml: 'ml', pza: 'pza' };
const rcSin = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function iniciarRecetas() {
  try {
    const e = await pedir(API + 'admin/inventario/estado.php');
    $('btn-recetas').hidden = !(e.activo && e.recetas) || esGerente;
  } catch { $('btn-recetas').hidden = true; }
}
const rcInsumo = (id) => rc.datos.insumos.find((i) => i.id === id);
const rcMoneda = (n) => dinero.format(n);
/** Pasa una cantidad escrita en `u` (g, kg, ml, l, pza) a la unidad propia del insumo. */
function rcAUnidadInsumo(valor, u, unidadInsumo) {
  const base = { g: 1, kg: 1000, ml: 1, l: 1000, pza: 1 };
  if (u === unidadInsumo) return valor;
  return (valor * base[u]) / base[unidadInsumo];
}
/** Cómo mostrar una cantidad guardada: 0.04 kg → 40 g. */
function rcMostrar(cantidad, unidadInsumo) {
  if ((unidadInsumo === 'kg' || unidadInsumo === 'l') && cantidad < 1) return { v: Math.round(cantidad * 1000 * 1000) / 1000, u: unidadInsumo === 'kg' ? 'g' : 'ml' };
  return { v: cantidad, u: unidadInsumo };
}
const rcCosto = (lineas) => lineas.reduce((s, l) => { const i = rcInsumo(l.insumo_id); return s + (i ? l.cantidad * i.costo * (l.modo === 'resta' ? -1 : 1) : 0); }, 0);

async function rcCargar() {
  rc.datos = await pedir(API + 'admin/recetas.php');
}
$('btn-recetas').addEventListener('click', async () => {
  $('rc-error').textContent = '';
  try { await rcCargar(); } catch (err) { avisar(err.message, true); return; }
  rc.q = ''; $('rc-buscar').value = '';
  rcPintar();
  abrirPagina(dlgRecetas, 'btn-recetas');
});
$('rc-cerrar').addEventListener('click', () => dlgRecetas.close());
for (const [id, tab] of [['rc-tab-platillos', 'platillos'], ['rc-tab-extras', 'extras']]) {
  $(id).addEventListener('click', () => { rc.tab = tab; rcPintar(); });
}
$('rc-buscar').addEventListener('input', () => { rc.q = rcSin($('rc-buscar').value.trim()); rcPintar(); });

function rcPintar() {
  const d = rc.datos;
  const esP = rc.tab === 'platillos';
  for (const [id, activo] of [['rc-tab-platillos', esP], ['rc-tab-extras', !esP]]) { $(id).classList.toggle('principal', activo); $(id).setAttribute('aria-selected', String(activo)); }
  const lista = $('rc-lista'); lista.replaceChildren();
  const items = (esP ? d.platillos : d.extras).filter((x) => !rc.q || rcSin(x.nombre + ' ' + (esP ? x.categoria : x.grupo || '')).includes(rc.q));
  const conReceta = (esP ? d.platillos : d.extras).filter((x) => x.lineas.length).length;
  const total = (esP ? d.platillos : d.extras).length;
  $('rc-resumen').textContent = `${conReceta} de ${total} con receta`;
  if (d.insumos.length === 0) lista.append(el('p', 'ayuda ex-vacio', 'Primero crea tus insumos en Inventario (cada uno con su unidad y costo); después los usas aquí.'));
  const grupos = new Map();
  for (const x of items) { const g = (esP ? x.categoria : x.grupo) || 'Otros'; if (!grupos.has(g)) grupos.set(g, []); grupos.get(g).push(x); }
  const claves = [...grupos.keys()];
  const barra = $('rc-expandir'); barra.replaceChildren();
  const todo = el('button', 'btn chico', 'Expandir todo'); todo.type = 'button'; todo.addEventListener('click', () => { for (const k of claves) rc.abiertas.add(rc.tab + k); rcPintar(); });
  const nada = el('button', 'btn chico', 'Colapsar todo'); nada.type = 'button'; nada.addEventListener('click', () => { for (const k of claves) rc.abiertas.delete(rc.tab + k); rcPintar(); });
  barra.append(todo, nada);
  for (const [g, arr] of grupos) {
    const det = el('details', 'cat-grupo'); det.open = !!rc.q || rc.abiertas.has(rc.tab + g);
    const sum = el('summary', 'cat-resumen');
    const hechas = arr.filter((x) => x.lineas.length).length;
    sum.append(el('span', 'cat-nombre', g), el('span', 'chip', `${hechas}/${arr.length} con receta`));
    det.append(sum);
    for (const x of arr) {
      const f = el('div', 'rc-fila');
      f.append(el('span', 'rc-nombre', x.nombre));
      if (x.lineas.length) {
        const costo = rcCosto(x.lineas);
        f.append(el('span', 'chip', `${x.lineas.length} ingrediente${x.lineas.length === 1 ? '' : 's'}`));
        if (esP) {
          const margen = x.precio > 0 ? Math.round(((x.precio - costo) / x.precio) * 100) : null;
          f.append(el('span', 'chip ex-res todos', `Costo ${rcMoneda(costo)}`));
          if (margen !== null) f.append(el('span', 'chip' + (margen < 30 ? ' sin' : ''), `Margen ${margen}%`));
        } else f.append(el('span', 'chip', (costo >= 0 ? '+' : '−') + rcMoneda(Math.abs(costo))));
      } else f.append(el('span', 'chip sin', 'Sin receta'));
      const b = el('button', 'btn chico', x.lineas.length ? '✎ Editar receta' : '＋ Crear receta'); b.type = 'button';
      b.addEventListener('click', () => rcAbrirEditor(x));
      f.append(b);
      det.append(f);
    }
    det.addEventListener('toggle', () => { if (rc.q) return; if (det.open) rc.abiertas.add(rc.tab + g); else rc.abiertas.delete(rc.tab + g); });
    lista.append(det);
  }
  if (items.length === 0 && d.insumos.length) lista.append(el('p', 'ayuda ex-vacio', 'Nada coincide con la búsqueda.'));
}

/* ---- Editor de una receta ---- */
function rcFila(l) {
  const esP = rc.tab === 'platillos';
  const f = el('div', 'rc-linea' + (esP ? '' : ' con-modo'));
  let modo = null;
  if (!esP) { modo = el('select'); modo.append(new Option('Suma', 'suma'), new Option('Resta', 'resta')); modo.value = l?.modo || 'suma'; f.append(modo); }
  const ins = el('select');
  ins.append(new Option('Elige un insumo…', ''));
  const porCat = new Map();
  for (const i of rc.datos.insumos) { const c = i.categoria || 'Sin categoría'; if (!porCat.has(c)) porCat.set(c, []); porCat.get(c).push(i); }
  for (const [c, arr] of porCat) { const og = document.createElement('optgroup'); og.label = c; for (const i of arr) og.append(new Option(i.nombre, String(i.id))); ins.append(og); }
  const cant = el('input'); cant.type = 'text'; cant.inputMode = 'decimal'; cant.placeholder = 'Cant.'; cant.setAttribute('aria-label', 'Cantidad');
  const uni = el('select'); uni.setAttribute('aria-label', 'Unidad');
  const quitar = el('button', 'btn chico', '🗑'); quitar.type = 'button'; quitar.title = 'Quitar'; quitar.addEventListener('click', () => { f.remove(); rcTotal(); });
  const poner = (idIns, unidadSel) => {
    const i = rcInsumo(Number(idIns)); uni.replaceChildren();
    for (const u of (i ? RC_FAMILIA[i.unidad] : ['g'])) uni.append(new Option(RC_TXT[u], u));
    if (unidadSel && [...uni.options].some((o) => o.value === unidadSel)) uni.value = unidadSel;
  };
  if (l) { const i = rcInsumo(l.insumo_id); ins.value = String(l.insumo_id); const m = i ? rcMostrar(l.cantidad, i.unidad) : { v: l.cantidad, u: 'g' }; poner(l.insumo_id, m.u); cant.value = String(m.v); } else poner('', null);
  ins.addEventListener('change', () => { poner(ins.value, null); rcTotal(); });
  cant.addEventListener('input', rcTotal); uni.addEventListener('change', rcTotal); if (modo) modo.addEventListener('change', rcTotal);
  if (modo) f.append(ins, cant, uni, quitar); else f.append(ins, cant, uni, quitar);
  f.leer = () => {
    const i = rcInsumo(Number(ins.value)); const v = Number(String(cant.value).replace(',', '.'));
    if (!i && !cant.value.trim()) return null;   // fila vacía: se ignora
    return { insumo_id: Number(ins.value), cantidad: i && Number.isFinite(v) ? rcAUnidadInsumo(v, uni.value, i.unidad) : NaN, modo: modo ? modo.value : 'suma', ok: !!i && Number.isFinite(v) && v > 0 };
  };
  return f;
}
function rcLineasEditor() { return [...$('rc-ed-lineas').children].map((f) => f.leer()).filter(Boolean); }
function rcTotal() {
  const ls = rcLineasEditor().filter((l) => l.ok);
  const costo = rcCosto(ls);
  const esP = rc.tab === 'platillos';
  let t = esP ? `Costo por porción: ${rcMoneda(costo)}` : `Efecto en el costo: ${costo >= 0 ? '+' : '−'}${rcMoneda(Math.abs(costo))}`;
  if (esP && rc.editando.precio > 0) t += ` · Precio ${rcMoneda(rc.editando.precio)} · Margen ${Math.round(((rc.editando.precio - costo) / rc.editando.precio) * 100)}%`;
  $('rc-ed-total').textContent = ls.length ? t : '';
}
function rcAbrirEditor(x) {
  rc.editando = x;
  const esP = rc.tab === 'platillos';
  $('rc-ed-titulo').textContent = (esP ? 'Receta · ' : 'Receta del modificador · ') + (esP ? x.nombre : (x.grupo ? x.grupo + ' ' : '') + x.nombre);
  $('rc-ed-sub').textContent = esP ? 'Insumos que gasta UNA porción. Escribe la cantidad en gramos, ml o piezas.' : '«Suma» agrega insumos (con queso: +20 g de queso). «Resta» quita lo que la receta del platillo llevaba (sin cebolla: −10 g de cebolla).';
  const cop = $('rc-ed-copiar'); cop.replaceChildren(new Option('Elige un ' + (esP ? 'platillo' : 'modificador') + '…', ''));
  for (const o of (esP ? rc.datos.platillos : rc.datos.extras)) if (o.id !== x.id && o.lineas.length) cop.append(new Option(o.nombre, String(o.id)));
  $('rc-ed-copiar-caja').hidden = cop.options.length <= 1;
  const cont = $('rc-ed-lineas'); cont.replaceChildren();
  for (const l of x.lineas) cont.append(rcFila(l));
  if (!x.lineas.length) cont.append(rcFila(null));
  $('rc-ed-error').textContent = '';
  rcTotal();
  dlgRecetaEd.showModal();
}
$('rc-ed-copiar').addEventListener('change', () => {
  const esP = rc.tab === 'platillos';
  const o = (esP ? rc.datos.platillos : rc.datos.extras).find((z) => z.id === Number($('rc-ed-copiar').value));
  if (!o) return;
  const cont = $('rc-ed-lineas'); cont.replaceChildren();
  for (const l of o.lineas) cont.append(rcFila(l));
  $('rc-ed-copiar').value = ''; rcTotal();
});
$('rc-ed-mas').addEventListener('click', () => { $('rc-ed-lineas').append(rcFila(null)); });
$('rc-ed-cancelar').addEventListener('click', () => dlgRecetaEd.close());
$('form-receta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ls = rcLineasEditor();
  if (ls.some((l) => !l.ok)) { $('rc-ed-error').textContent = 'Cada ingrediente necesita un insumo y una cantidad mayor a 0 (o borra la fila).'; return; }
  const esP = rc.tab === 'platillos';
  try {
    await enviarJson(API + 'admin/recetas.php', esP
      ? { accion: 'receta_platillo', producto_id: rc.editando.id, lineas: ls.map((l) => ({ insumo_id: l.insumo_id, cantidad: l.cantidad })) }
      : { accion: 'receta_extra', extra_id: rc.editando.id, lineas: ls.map((l) => ({ insumo_id: l.insumo_id, cantidad: l.cantidad, modo: l.modo })) });
    dlgRecetaEd.close();
    await rcCargar(); rcPintar();
    avisar('Receta guardada');
  } catch (err) { $('rc-ed-error').textContent = err.message; }
});
