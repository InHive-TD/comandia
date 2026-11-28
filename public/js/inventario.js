/* Inventario y proveedores (módulo opcional, solo aparece si la plataforma lo activó para la empresa). Se carga después de admin.js. */
const dlgInventario = $('dlg-inventario');
const inv = { datos: null, sucursal: null, tab: 'existencias', pagina: 'existencias', sucursales: [] };
/* Cada página del grupo «Inventario» del menú muestra sus propias pestañas (si son más de una). */
const INV_PAGINAS = {
  existencias: { titulo: 'Existencias', boton: 'btn-inv-existencias', tabs: ['existencias'], kpi: true },
  insumos: { titulo: 'Insumos', boton: 'btn-inv-insumos', tabs: ['insumos'], kpi: false },
  proveedores: { titulo: 'Proveedores y compras', boton: 'btn-inv-proveedores', tabs: ['compras', 'proveedores'], kpi: false },
  mermas: { titulo: 'Mermas y movimientos', boton: 'btn-inv-mermas', tabs: ['mermas', 'movimientos'], kpi: true },
};
/* Unidades estándar con su grupo: se pueden convertir entre sí dentro del mismo grupo (g↔kg, ml↔L…). Las propias de la empresa van aparte. */
const UNIDAD_GRUPOS = [
  ['Peso', [['mg', 'mg · miligramo'], ['g', 'g · gramo'], ['kg', 'kg · kilogramo'], ['oz', 'oz · onza'], ['lb', 'lb · libra']]],
  ['Volumen', [['ml', 'ml · mililitro'], ['cl', 'cl · centilitro'], ['l', 'L · litro'], ['cdta', 'cdta · cucharadita'], ['cda', 'cda · cucharada'], ['taza', 'taza']]],
  ['Conteo', [['pza', 'pza · pieza'], ['docena', 'docena']]],
];
const UNIDAD_TXT = new Proxy({ l: 'L' }, { get: (o, k) => (k in o ? o[k] : String(k)) });   // lo que no esté en la lista se muestra tal cual (unidades propias)
const num = (n) => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 3 });

async function iniciarInventario() {
  try {
    const e = await pedir(API + 'admin/inventario/estado.php');
    $('grupo-inventario').hidden = !e.activo;
    // Insumos: el gerente también entra (agrega los suyos y deshabilita los generales); las recetas siguen siendo del administrador
    $('btn-inv-recetas').hidden = esGerente || !e.recetas;
  } catch { $('grupo-inventario').hidden = true; }
}

function invError(t) { $('inv-error').textContent = t || ''; }
async function invEnviar(cuerpo, aviso) {
  invError('');
  try {
    const r = await enviarJson(API + 'admin/inventario.php', cuerpo);
    if (aviso) avisar(aviso);
    await cargarInventario();
    return r;
  } catch (err) { invError(err.message); return null; }
}

async function cargarInventario() {
  const q = inv.sucursal ? '?sucursal=' + inv.sucursal : '';
  inv.datos = await pedir(API + 'admin/inventario.php' + q);
  pintarInventario();
}

function campo(etiqueta, nodo) { const l = el('label', '', etiqueta); l.append(nodo); return l; }
function entrada(tipo, valor, extra = {}) { const i = el('input'); i.type = tipo; i.value = valor ?? ''; Object.assign(i, extra); return i; }
function selector(opciones, valor) { const s = el('select'); for (const [v, t] of opciones) s.append(new Option(t, String(v))); s.value = String(valor ?? ''); return s; }
function tabla(cabeceras, filas) {
  const t = el('table', 'tabla-inv'); const th = el('tr');
  for (const c of cabeceras) th.append(el('th', '', c));
  t.append(th);
  for (const f of filas) { const tr = el('tr'); for (const c of f) { const td = el('td'); if (c instanceof Node) td.append(c); else td.textContent = c ?? ''; tr.append(td); } t.append(tr); }
  return t;
}
function boton(texto, fn, clase = 'chico') { const b = el('button', 'btn ' + clase, texto); b.type = 'button'; b.addEventListener('click', fn); return b; }

function pintarInventario() {
  const d = inv.datos; const c = $('inv-contenido'); c.replaceChildren();
  const pg = INV_PAGINAS[inv.pagina];
  $('inv-titulo').textContent = 'Inventario · ' + pg.titulo;
  if (!pg.tabs.includes(inv.tab)) inv.tab = pg.tabs[0];
  $('inv-tabs').hidden = pg.tabs.length < 2;
  for (const b of document.querySelectorAll('#inv-tabs [data-tab]')) { b.hidden = !pg.tabs.includes(b.dataset.tab); b.classList.toggle('activo', b.dataset.tab === inv.tab); }
  $('inv-catalogo-aviso').hidden = d.puede_editar_catalogo || inv.tab !== 'proveedores';
  const r = d.resumen;
  const res = el('div', 'inv-resumen');
  for (const [t, v] of [['Valor del inventario', dinero.format(r.valor_inventario)], ['Insumos por debajo del mínimo', String(r.bajo_minimo)], ['Mermas (30 días)', dinero.format(r.mermas_30d)]]) {
    const k = el('div', 'inv-kpi'); k.append(el('small', '', t), el('strong', '', v)); res.append(k);
  }
  if (pg.kpi) c.append(res);
  // Filtro por categoría de insumo (se comparte entre existencias, insumos, compras y mermas)
  let dv = d;
  if (['existencias', 'insumos', 'compras', 'mermas'].includes(inv.tab) && d.categorias.length) {
    if (inv.cat && !d.categorias.includes(inv.cat) && inv.cat !== '__sin') inv.cat = '';
    const fs = selector([['', 'Todas las categorías'], ...d.categorias.map((k) => [k, k]), ['__sin', 'Sin categoría']], inv.cat || '');
    fs.addEventListener('change', () => { inv.cat = fs.value; pintarInventario(); });
    const fb = el('div', 'inv-filtro'); fb.append(el('small', '', 'Categoría:'), fs); c.append(fb);
    if (inv.cat) dv = { ...d, insumos: d.insumos.filter((i) => (inv.cat === '__sin' ? !i.categoria : i.categoria === inv.cat)) };
  }
  ({ existencias: tabExistencias, insumos: tabInsumos, compras: tabCompras, mermas: tabMermas, proveedores: tabProveedores, movimientos: tabMovimientos })[inv.tab](c, dv);
}

/* Equivalencias dentro de una familia (peso, volumen, conteo). Una unidad propia no convierte con nada. */
const U_FACTOR = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592, ml: 1, cl: 10, l: 1000, cdta: 5, cda: 15, taza: 240, pza: 1, docena: 12 };
const U_FAMILIA = { mg: 'peso', g: 'peso', kg: 'peso', oz: 'peso', lb: 'peso', ml: 'vol', cl: 'vol', l: 'vol', cdta: 'vol', cda: 'vol', taza: 'vol', pza: 'cont', docena: 'cont' };
/** Cuántas `base` vale una unidad `x` (NaN si no se pueden convertir). */
function uConv(x, base) {
  if (x === base) return 1;
  return U_FAMILIA[x] && U_FAMILIA[x] === U_FAMILIA[base] ? U_FACTOR[x] / U_FACTOR[base] : NaN;
}
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** Lista de unidades para un <select>: estándar por grupo + las propias de la empresa (+ opcional «Otra unidad…»). */
function llenarUnidades(sel, d, { otra = false, extra = null } = {}) {
  for (const [g, lista] of UNIDAD_GRUPOS) { const og = document.createElement('optgroup'); og.label = g; for (const [v, t] of lista) og.append(new Option(t, v)); sel.append(og); }
  const propias = [...(d.unidades_propias || [])];
  if (extra && !d.unidades.includes(extra) && !propias.includes(extra)) propias.push(extra);
  if (propias.length) { const og = document.createElement('optgroup'); og.label = 'Mis unidades'; for (const u of propias) og.append(new Option(u, u)); sel.append(og); }
  if (otra) sel.append(new Option('＋ Otra unidad…', '__otra'));
}

/** Contenido en unidades madre de una presentación: «Trae n u» o «Trae n u (pzas) de m u2» (ej. 24 pza de 355 ml). */
function presFactor(r, base) {
  const n = Number(r.n); const m = Number(r.m);
  if (!(n > 0)) return NaN;
  if (m > 0) {
    const cuenta = n * (r.u === 'docena' ? 12 : 1);          // cuántas piezas trae
    const tam = uConv(r.u2, base);                            // cuánto vale cada pieza, en la unidad madre
    if (Number.isFinite(tam)) return cuenta * m * tam;
    if (base === 'pza' || U_FAMILIA[base] === 'cont') return cuenta;   // la unidad madre se cuenta en piezas: el tamaño es solo informativo
    return NaN;
  }
  return n * uConv(r.u, base);
}
const presTexto = (r) => (Number(r.m) > 0 ? `${r.n} ${UNIDAD_TXT[r.u]} de ${r.m} ${UNIDAD_TXT[r.u2]}` : `${r.n} ${UNIDAD_TXT[r.u]}`);

/** Editor de presentaciones de compra (caja, costal…) de un insumo; devuelve { nodo, leer(base) }. */
function editorPresentaciones(d, i, baseSel, costoInput) {
  const caja = el('div', 'inv-pres');
  caja.append(el('h4', '', 'Presentaciones de compra'));
  const ayuda = el('small', 'ef-nota', 'Cómo lo compras (caja, costal, paquete…). Con el precio se calcula solo el costo por unidad madre.');
  caja.append(ayuda);
  const filas = el('div', 'inv-pres-filas'); caja.append(filas);
  const base = () => baseSel();
  const nuevaFila = (p) => {
    const dat = (() => { try { return JSON.parse(p?.detalle || ''); } catch { return null; } })() || { n: p ? p.factor : '', u: baseSel(), m: '', u2: 'ml' };
    const nombre = entrada('text', p?.nombre || '', { maxLength: 40, placeholder: 'Ej. Caja, Costal' });
    const n = entrada('number', dat.n, { min: 0, step: 'any', placeholder: 'Trae' });
    const u = el('select'); llenarUnidades(u, d, { extra: dat.u }); u.value = dat.u;
    const m = entrada('number', dat.m || '', { min: 0, step: 'any', placeholder: 'de c/u (opc.)' });
    const u2 = el('select'); llenarUnidades(u2, d, { extra: dat.u2 }); u2.value = dat.u2 || 'ml';
    const precio = entrada('number', p?.precio ?? '', { min: 0, step: '0.01', placeholder: 'Precio $' });
    const res = el('small', 'inv-pres-res');
    const f = el('div', 'inv-pres-fila');
    const usar = boton('Usar como costo', () => { const fa = presFactor({ n: n.value, u: u.value, m: m.value, u2: u2.value }, base()); if (Number.isFinite(fa) && fa > 0 && Number(precio.value) > 0) costoInput.value = String(r6(Number(precio.value) / fa)); });
    const calc = () => {
      const fa = presFactor({ n: n.value, u: u.value, m: m.value, u2: u2.value }, base());
      const pr = Number(precio.value); const piezas = Number(n.value) * (u.value === 'docena' ? 12 : 1);
      const mon = (x) => r6(x).toLocaleString('es-MX', { maximumFractionDigits: 4 });
      const porPieza = Number(m.value) > 0 && pr > 0 && piezas > 0 ? ` · $${mon(pr / piezas)} por ${UNIDAD_TXT[u.value] === 'docena' ? 'pieza' : UNIDAD_TXT[u.value]}` : '';
      const unit = pr > 0 && fa > 0 ? `${porPieza} · $${mon(pr / fa)} por ${UNIDAD_TXT[base()]}` : '';
      res.textContent = Number.isFinite(fa) && fa > 0 ? `= ${num(fa)} ${UNIDAD_TXT[base()]}${unit}` : (n.value ? 'No se puede convertir a la unidad madre' : '');
      usar.hidden = !(Number.isFinite(fa) && fa > 0 && Number(precio.value) > 0);
    };
    for (const x of [nombre, n, u, m, u2, precio]) x.addEventListener('input', calc);
    baseSel.cambios.push(calc);
    f.append(nombre, n, u, el('span', 'inv-de', 'de'), m, u2, precio, boton('✕', () => f.remove()), res, usar);
    f.leer = () => {
      if (!nombre.value.trim() && !n.value) return null;
      const fa = presFactor({ n: n.value, u: u.value, m: m.value, u2: u2.value }, base());
      return { ok: !!nombre.value.trim() && Number.isFinite(fa) && fa > 0, nombre: nombre.value.trim(), factor: fa, detalle: JSON.stringify({ n: Number(n.value), u: u.value, m: Number(m.value) || '', u2: u2.value }), precio: precio.value };
    };
    filas.append(f); calc();
  };
  for (const p of (i?.presentaciones || [])) nuevaFila(p);
  caja.append(boton('＋ Presentación', () => nuevaFila(null)));
  return { nodo: caja, leer: () => [...filas.children].map((f) => f.leer()).filter(Boolean) };
}

function formInsumo(i) {
  const d = inv.datos;
  const nombre = entrada('text', i?.nombre, { maxLength: 80, placeholder: 'Ej. Tortilla de maíz' });
  // Categoría: las de la empresa + «Nueva categoría…»
  const catSel = el('select');
  catSel.append(new Option('Sin categoría', ''));
  for (const c of d.categorias) catSel.append(new Option(c, c));
  if (d.puede_editar_catalogo) catSel.append(new Option('＋ Nueva categoría…', '__nueva'));
  catSel.value = i?.categoria || '';
  const catNueva = entrada('text', '', { maxLength: 40, placeholder: 'Ej. Carnes, Abarrotes, Lácteos' }); catNueva.hidden = true;
  catSel.addEventListener('change', () => { catNueva.hidden = catSel.value !== '__nueva'; if (!catNueva.hidden) catNueva.focus(); });
  const cat = el('div', 'inv-unidad'); cat.append(catSel, catNueva);
  Object.defineProperty(cat, 'value', { get: () => (catSel.value === '__nueva' ? catNueva.value.trim() : catSel.value) });
  // Unidad madre: en ella se guarda todo (existencias, costo, recetas). Al cambiarla dentro de la misma familia se convierte lo escrito.
  const uniSel = el('select'); llenarUnidades(uniSel, d, { otra: true, extra: i?.unidad });
  uniSel.value = i?.unidad || 'g';
  const uniNueva = entrada('text', '', { maxLength: 20, placeholder: 'Ej. caja, bolsa, manojo, lata' }); uniNueva.hidden = true;
  const costo = entrada('number', i?.costo ?? 0, { min: 0, step: 'any' });
  const min = entrada('number', i?.minimo ?? 0, { min: 0, step: 'any' });
  const valorUni = () => (uniSel.value === '__otra' ? uniNueva.value.trim() : uniSel.value);
  let uniPrevia = uniSel.value;
  const baseSel = () => valorUni() || 'pza'; baseSel.cambios = [];
  uniSel.addEventListener('change', () => {
    uniNueva.hidden = uniSel.value !== '__otra'; if (!uniNueva.hidden) uniNueva.focus();
    const k = uConv(uniPrevia, uniSel.value);   // cuántas unidades nuevas vale una vieja
    if (Number.isFinite(k) && k !== 1) {
      if (Number(costo.value) > 0) costo.value = String(r6(Number(costo.value) / k));
      if (Number(min.value) > 0) min.value = String(r6(Number(min.value) * k));
    }
    if (uniSel.value !== '__otra') uniPrevia = uniSel.value;
    for (const fn of baseSel.cambios) fn();
  });
  uniNueva.addEventListener('input', () => { for (const fn of baseSel.cambios) fn(); });
  const uni = el('div', 'inv-unidad'); uni.append(uniSel, uniNueva);
  const prov = selector([['', 'Sin proveedor'], ...d.proveedores.map((p) => [p.id, p.nombre])], i?.proveedor_id ?? '');
  const etqUni = el('label', ''); etqUni.append(document.createTextNode('Unidad madre '), tipInv('Es la unidad en la que se guarda todo: existencias, costo y recetas (por ejemplo gramos para la carne, ml para líquidos, pza para piezas). Cambiarla convierte lo ya guardado si son del mismo tipo (kg ↔ g).'), uni);
  const etqCosto = el('label', ''); const costoTxt = document.createTextNode('Costo por unidad madre '); etqCosto.append(costoTxt, tipInv('Lo que cuesta UNA unidad madre (un gramo, un ml, una pieza). Puedes calcularlo con una presentación de compra más abajo.'), costo);
  const f = el('div', 'inv-form');
  f.append(campo('Nombre', nombre), campo('Categoría', cat), etqUni, etqCosto, campo('Mínimo (avisa al llegar a esta cantidad)', min), campo('Proveedor habitual', prov));
  const pres = editorPresentaciones(d, i, baseSel, costo);
  pres.nodo.style.gridColumn = '1 / -1'; f.append(pres.nodo);
  const fila = el('div', 'acciones-dialogo');
  fila.append(boton(i ? 'Guardar' : 'Agregar insumo', async () => {
    invError('');
    const lp = pres.leer();
    if (lp.some((x) => !x.ok)) { invError('Cada presentación necesita nombre y un contenido que se pueda convertir a la unidad madre (o bórrala).'); return; }
    try {
      const r = await enviarJson(API + 'admin/inventario.php', { accion: i ? 'insumo_editar' : 'insumo_crear', id: i?.id, nombre: nombre.value, categoria: cat.value, unidad: valorUni(), costo: costo.value, minimo: min.value, proveedor_id: prov.value });
      const idIns = i ? i.id : r.id;
      if (lp.length || (i?.presentaciones || []).length) await enviarJson(API + 'admin/inventario.php', { accion: 'presentaciones_guardar', insumo_id: idIns, presentaciones: lp.map((x) => ({ nombre: x.nombre, factor: x.factor, detalle: x.detalle, precio: x.precio })) });
      avisar(i ? 'Insumo actualizado' : 'Insumo agregado');
      await cargarInventario();
    } catch (err) { invError(err.message); }
  }, 'btn primario'));
  if (i) fila.append(boton('Archivar', async () => { if (await confirmar('¿Archivar ' + i.nombre + '? Conserva su historial.')) invEnviar({ accion: 'insumo_archivar', id: i.id }, 'Insumo archivado'); }));
  f.append(fila);
  return f;
}
/** Signo de información con texto al pasar el cursor (mismo estilo que en el resto del panel). */
function tipInv(texto) { const t = el('span', 'tip', 'i'); t.dataset.tip = texto; t.tabIndex = 0; return t; }

function tabExistencias(c, d) {
  const filas = d.insumos.map((i) => [
    i.nombre, i.categoria || '—',
    el('span', i.bajo ? 'inv-bajo' : '', num(i.existencia) + ' ' + UNIDAD_TXT[i.unidad]),
    i.minimo ? num(i.minimo) : '—', dinero.format(i.costo), dinero.format(Math.max(i.existencia, 0) * i.costo),
  ]);
  c.append(filas.length ? tabla(['Insumo', 'Categoría', 'Existencia', 'Mínimo', 'Costo', 'Valor'], filas) : el('p', 'ayuda', d.puede_editar_catalogo ? 'Aún no hay insumos. Créalos en Inventario → Insumos.' : 'Aún no hay insumos. El administrador los crea en Inventario → Insumos.'));
  // Conteo físico
  const det = el('details', 'inv-nuevo'); det.append(el('summary', '', 'Conteo físico (corrige la existencia)'));
  det.append(el('p', 'ayuda', 'Escribe lo que realmente hay. Solo se registran los que cambian; la diferencia queda en el historial.'));
  const entradas = d.insumos.map((i) => ({ i, inp: entrada('number', '', { min: 0, step: '0.001', placeholder: num(i.existencia) }) }));
  det.append(tabla(['Insumo', 'En sistema', 'Contado'], entradas.map(({ i, inp }) => [i.nombre, num(i.existencia) + ' ' + UNIDAD_TXT[i.unidad], inp])));
  det.append(boton('Aplicar conteo', async () => {
    const conteos = entradas.filter((e) => e.inp.value !== '').map((e) => ({ insumo_id: e.i.id, contado: e.inp.value }));
    if (!conteos.length) { invError('Escribe al menos una cantidad contada.'); return; }
    const r = await invEnviar({ accion: 'conteo', sucursal_id: inv.sucursal, conteos });
    if (r) avisar(r.diferencias.length ? r.diferencias.length + ' ajuste(s), diferencia de ' + dinero.format(r.valor_total) : 'Todo coincide, sin cambios');
  }, 'btn primario'));
  c.append(det);
}

/** Catálogo de ingredientes: unidad, costo, mínimo y proveedor (solo el administrador). */
function tabInsumos(c, d) {
  const dueno = d.puede_editar_catalogo;
  const cat = d.catalogo || d.insumos;
  const abrir = (i) => { const w = $('inv-editor'); w.replaceChildren(el('h3', '', 'Editar ' + i.nombre), formInsumo(i)); w.hidden = false; w.scrollIntoView({ behavior: 'smooth' }); };
  const vis = inv.cat ? cat.filter((i) => (inv.cat === '__sin' ? !i.categoria : i.categoria === inv.cat)) : cat;
  const filas = vis.map((i) => {
    const acc = el('span', 'inv-acc');
    if (i.propio) acc.append(boton('Editar', () => abrir(i)));
    // Deshabilitar solo afecta a la sucursal que se está viendo; los generales nunca se borran desde una sucursal.
    if (i.sucursal_id === null || i.sucursal_id === Number(inv.sucursal)) acc.append(boton(i.deshabilitado ? 'Habilitar' : 'Deshabilitar', () => invEnviar({ accion: 'insumo_toggle', id: i.id, sucursal_id: inv.sucursal, habilitado: i.deshabilitado }, i.deshabilitado ? 'Insumo habilitado' : 'Insumo deshabilitado')));
    const u = UNIDAD_TXT[i.unidad];
    const est = i.estandar && i.estandar !== i.unidad ? el('small', 'inv-est', ' ≈ ' + num(i.factor_estandar) + ' ' + UNIDAD_TXT[i.estandar]) : '';
    const nom = el('span', i.deshabilitado ? 'inv-off' : ''); nom.append(i.nombre, i.deshabilitado ? ' (deshabilitado)' : '');
    const unid = el('span'); unid.append(u, est);
    const origen = i.sucursal_id === null ? 'General' : (i.sucursal || 'Sucursal');
    return [nom, i.categoria || '—', unid, dinero.format(i.costo), i.minimo ? num(i.minimo) + ' ' + u : '—',
      (d.proveedores.find((p) => p.id === i.proveedor_id) || {}).nombre || '—', origen, acc];
  });
  c.append(filas.length ? tabla(['Insumo', 'Categoría', 'Unidad madre', 'Costo', 'Mínimo', 'Proveedor', 'Origen', ''], filas) : el('p', 'ayuda', 'Aún no hay insumos. Agrega el primero.'));
  const w = el('div', 'inv-editor'); w.id = 'inv-editor'; w.hidden = true; c.append(w);
  if (dueno) c.append(panelCategorias(inv.datos));
  const n = el('details', 'inv-nuevo'); n.open = !filas.length; n.append(el('summary', '', '+ Nuevo insumo'), formInsumo(null)); c.append(n);
}

/** Categorías de insumos (carnes, abarrotes…): se usan al filtrar existencias, compras, mermas y proveedores. */
function panelCategorias(d) {
  const det = el('details', 'inv-nuevo'); det.open = !d.categorias.length;
  det.append(el('summary', '', 'Categorías de insumos'));
  const lista = el('div', 'inv-cats');
  for (const k of d.categorias) {
    const ch = el('span', 'inv-cat');
    ch.append(el('span', '', k),
      boton('✎', async () => { const n = prompt('Nuevo nombre de la categoría', k); if (n && n.trim() && n.trim() !== k) invEnviar({ accion: 'categoria_renombrar', actual: k, nombre: n.trim() }, 'Categoría renombrada'); }),
      boton('✕', async () => { if (await confirmar('¿Eliminar la categoría ' + k + '? Sus insumos quedan sin categoría.')) invEnviar({ accion: 'categoria_eliminar', nombre: k }, 'Categoría eliminada'); }));
    lista.append(ch);
  }
  const nueva = entrada('text', '', { maxLength: 40, placeholder: 'Nueva categoría (Ej. Carnes)' });
  const fila = el('div', 'inv-cat-nueva'); fila.append(nueva, boton('＋ Agregar', () => { if (nueva.value.trim()) invEnviar({ accion: 'categoria_crear', nombre: nueva.value.trim() }, 'Categoría agregada'); }, 'btn primario'));
  det.append(lista, fila);
  return det;
}

function tabCompras(c, d) {
  const n = el('details', 'inv-nuevo'); n.open = !d.compras.length; n.append(el('summary', '', '+ Registrar compra'));
  const prov = selector([['', 'Sin proveedor'], ...d.proveedores.map((p) => [p.id, p.nombre])], '');
  const ref = entrada('text', '', { maxLength: 60, placeholder: 'Folio o nota del proveedor' });
  const rec = entrada('checkbox', ''); rec.checked = true;
  const lineas = el('div', 'inv-lineas');
  const agregarLinea = () => {
    const ins = selector(d.insumos.map((i) => [i.id, i.nombre + ' (' + UNIDAD_TXT[i.unidad] + ')']), d.insumos[0]?.id);
    const cant = entrada('number', '', { min: 0, step: '0.001', placeholder: 'Cantidad' });
    const cos = entrada('number', '', { min: 0, step: '0.01', placeholder: 'Costo unitario' });
    const pres = el('select');
    const sel = () => d.insumos.find((x) => String(x.id) === ins.value);
    // Opciones de compra: la unidad madre, otras unidades de su familia y las presentaciones (caja, costal…). Todo se convierte a unidad madre al guardar.
    const opciones = () => {
      const i = sel(); pres.replaceChildren(); if (!i) return [];
      const o = [{ v: 'u:' + i.unidad, t: UNIDAD_TXT[i.unidad], k: 1, costoK: 1 }];
      for (const u of Object.keys(U_FACTOR)) { const k = uConv(u, i.unidad); if (u !== i.unidad && Number.isFinite(k)) o.push({ v: 'u:' + u, t: UNIDAD_TXT[u], k, costoK: k }); }
      for (const pr of i.presentaciones || []) o.push({ v: 'p:' + pr.id, t: pr.nombre + ' (' + presTexto(JSON.parse(pr.detalle || 'null') || { n: pr.factor, u: i.unidad }) + ')', k: pr.factor, costoK: pr.factor, precio: pr.precio });
      for (const x of o) pres.append(new Option(x.t, x.v));
      return o;
    };
    let ops = opciones();
    const cur = () => ops.find((x) => x.v === pres.value) || ops[0];
    const poner = () => { const i = sel(); const o = cur(); if (!i || !o) return; cos.value = o.precio > 0 ? o.precio : (i.costo ? r6(i.costo * o.costoK) : ''); cos.placeholder = 'Costo por ' + o.t.split(' (')[0]; };
    ins.addEventListener('change', () => { ops = opciones(); poner(); });
    pres.addEventListener('change', poner);
    poner();
    const f = el('div', 'inv-linea'); f.append(ins, cant, pres, cos, boton('✕', () => f.remove()));
    f._v = () => { const o = cur(); const k = o ? o.k : 1; return { insumo_id: ins.value, cantidad: cant.value === '' ? '' : r6(Number(cant.value) * k), costo: cos.value === '' ? '' : r6(Number(cos.value) / k) }; };
    lineas.append(f);
  };
  if (d.insumos.length) agregarLinea(); else n.append(el('p', 'ayuda', 'Primero agrega insumos en Existencias.'));
  n.append(campo('Proveedor', prov), campo('Referencia', ref), lineas, boton('+ Otra línea', agregarLinea), el('label', 'casilla-int', ''));
  n.lastChild.append(rec, document.createTextNode(' Ya llegó (sumar al inventario ahora)'));
  n.append(boton('Guardar compra', () => {
    const items = [...lineas.children].map((f) => f._v()).filter((x) => x.cantidad !== '');
    if (!items.length) { invError('Agrega cantidades a la compra.'); return; }
    invEnviar({ accion: 'compra', sucursal_id: inv.sucursal, proveedor_id: prov.value, referencia: ref.value, recibir: rec.checked, items }, 'Compra registrada');
  }, 'btn primario'));
  c.append(n);
  const ETQ = { pedida: 'Pendiente', recibida: 'Recibida', cancelada: 'Cancelada' };
  c.append(tabla(['Fecha', 'Proveedor', 'Referencia', 'Total', 'Estado', ''], d.compras.map((x) => [
    new Date(x.fecha).toLocaleDateString('es-MX'), x.proveedor || '—', x.referencia || '—', dinero.format(x.total), ETQ[x.estado],
    x.estado === 'pedida' ? (() => { const s = el('span'); s.append(boton('Recibir', () => invEnviar({ accion: 'compra_recibir', id: x.id }, 'Compra recibida')), boton('Cancelar', () => invEnviar({ accion: 'compra_cancelar', id: x.id }, 'Compra cancelada'))); return s; })() : '',
  ])));
}

function tabMermas(c, d) {
  const ins = selector(d.insumos.map((i) => [i.id, i.nombre + ' — hay ' + num(i.existencia) + ' ' + UNIDAD_TXT[i.unidad]]), d.insumos[0]?.id);
  const cant = entrada('number', '', { min: 0, step: '0.001' });
  const mot = selector(d.motivos_merma.map((m) => [m.id, m.nombre]), 'caducado');
  const nota = entrada('text', '', { maxLength: 255, placeholder: 'Opcional' });
  const f = el('div', 'inv-form');
  f.append(campo('Insumo', ins), campo('Cantidad perdida', cant), campo('Motivo', mot), campo('Nota', nota), boton('Registrar merma', () => invEnviar({ accion: 'merma', sucursal_id: inv.sucursal, insumo_id: ins.value, cantidad: cant.value, motivo: mot.value, nota: nota.value }, 'Merma registrada'), 'btn primario'));
  c.append(f);
  c.append(el('h3', '', 'Mermas de los últimos 30 días'));
  c.append(d.resumen.mermas_por_motivo.length ? tabla(['Motivo', 'Veces', 'Valor'], d.resumen.mermas_por_motivo.map((m) => [m.nombre, String(m.veces), dinero.format(m.valor)])) : el('p', 'ayuda', 'Sin mermas registradas.'));
  if (d.puede_editar_catalogo && inv.sucursales.length > 1) {
    const t = el('details', 'inv-nuevo'); t.append(el('summary', '', 'Traspasar a otra sucursal'));
    const ti = selector(d.insumos.map((i) => [i.id, i.nombre]), d.insumos[0]?.id);
    const hacia = selector(inv.sucursales.filter((s) => String(s.id) !== String(inv.sucursal)).map((s) => [s.id, s.nombre]), '');
    const tc = entrada('number', '', { min: 0, step: '0.001' });
    t.append(campo('Insumo', ti), campo('Cantidad', tc), campo('Hacia', hacia), boton('Traspasar', () => invEnviar({ accion: 'traspaso', desde: inv.sucursal, hacia: hacia.value, insumo_id: ti.value, cantidad: tc.value }, 'Traspaso hecho'), 'btn primario'));
    c.append(t);
  }
}

function formProveedor(p) {
  const nombre = entrada('text', p?.nombre, { maxLength: 80 }); const con = entrada('text', p?.contacto, { maxLength: 80 });
  const tel = entrada('tel', p?.telefono, { maxLength: 30 }); const cor = entrada('email', p?.correo, { maxLength: 150 });
  const dias = entrada('number', p?.dias_entrega ?? 0, { min: 0, max: 60 }); const mc = entrada('number', p?.minimo_compra ?? 0, { min: 0, step: '0.01' });
  const notas = entrada('text', p?.notas, { maxLength: 255 });
  const f = el('div', 'inv-form');
  f.append(campo('Nombre', nombre), campo('Contacto', con), campo('Teléfono', tel), campo('Correo', cor), campo('Días de entrega', dias), campo('Compra mínima ($)', mc), campo('Notas', notas));
  const fila = el('div', 'acciones-dialogo');
  fila.append(boton(p ? 'Guardar' : 'Agregar proveedor', () => invEnviar({ accion: p ? 'proveedor_editar' : 'proveedor_crear', id: p?.id, nombre: nombre.value, contacto: con.value, telefono: tel.value, correo: cor.value, dias_entrega: dias.value, minimo_compra: mc.value, notas: notas.value }, 'Proveedor guardado'), 'btn primario'));
  if (p) fila.append(boton('Archivar', async () => { if (await confirmar('¿Archivar a ' + p.nombre + '?')) invEnviar({ accion: 'proveedor_archivar', id: p.id }, 'Proveedor archivado'); }));
  f.append(fila);
  return f;
}
function tabProveedores(c, d) {
  c.append(d.proveedores.length ? tabla(['Proveedor', 'Contacto', 'Teléfono', 'Entrega', 'Mínimo', ''], d.proveedores.map((p) => [p.nombre, p.contacto || '—', p.telefono || '—', p.dias_entrega ? p.dias_entrega + ' día(s)' : '—', p.minimo_compra ? dinero.format(p.minimo_compra) : '—',
    d.puede_editar_catalogo ? boton('Editar', () => { const w = $('inv-editor'); w.replaceChildren(el('h3', '', 'Editar ' + p.nombre), formProveedor(p)); w.hidden = false; w.scrollIntoView({ behavior: 'smooth' }); }) : ''])) : el('p', 'ayuda', 'Aún no hay proveedores.'));
  const w = el('div', 'inv-editor'); w.id = 'inv-editor'; w.hidden = true; c.append(w);
  if (d.puede_editar_catalogo) { const n = el('details', 'inv-nuevo'); n.append(el('summary', '', '+ Nuevo proveedor'), formProveedor(null)); c.append(n); }
}

async function tabMovimientos(c) {
  const r = await pedir(API + 'admin/inventario/movimientos.php?sucursal=' + inv.sucursal);
  const T = { compra: 'Compra', merma: 'Merma', conteo: 'Conteo', ajuste: 'Ajuste', traspaso_entra: 'Traspaso (entra)', traspaso_sale: 'Traspaso (sale)', consumo: 'Consumo' };
  c.append(r.movimientos.length ? tabla(['Fecha', 'Insumo', 'Tipo', 'Cantidad', 'Detalle', 'Quién'], r.movimientos.map((m) => [new Date(m.fecha).toLocaleString('es-MX'), m.insumo, T[m.tipo] || m.tipo, (m.cantidad > 0 ? '+' : '') + num(m.cantidad) + ' ' + UNIDAD_TXT[m.unidad], m.motivo_texto || m.nota || '', m.usuario || ''])) : el('p', 'ayuda', 'Sin movimientos todavía.'));
}

async function abrirInventario(pagina = 'existencias') {
  inv.pagina = pagina;
  inv.tab = INV_PAGINAS[pagina].tabs[0];
  abrirPagina(dlgInventario, INV_PAGINAS[pagina].boton);
  invError('');
  try {
    if (!inv.sucursales.length) inv.sucursales = (await pedir(API + 'admin/sucursales.php')).sucursales.filter((s) => s.activa);
    const sel = $('inv-sucursal'); sel.replaceChildren();
    for (const s of inv.sucursales) sel.append(new Option(s.nombre, String(s.id)));
    if (!inv.sucursal || !inv.sucursales.some((s) => String(s.id) === String(inv.sucursal))) inv.sucursal = inv.sucursales[0]?.id;
    sel.value = String(inv.sucursal);
    $('inv-suc-fila').hidden = inv.sucursales.length < 2;
    await cargarInventario();
  } catch (err) { invError(err.message); }
}
for (const [k, p] of Object.entries(INV_PAGINAS)) $(p.boton).addEventListener('click', () => abrirInventario(k));
$('inv-cerrar').addEventListener('click', () => dlgInventario.close());
$('inv-sucursal').addEventListener('change', (e) => { inv.sucursal = e.target.value; cargarInventario().catch((x) => invError(x.message)); });
$('inv-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; inv.tab = b.dataset.tab; if (inv.datos) pintarInventario(); });
