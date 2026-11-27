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
const UNIDAD_TXT = { kg: 'kg', g: 'g', l: 'L', ml: 'ml', pza: 'pza' };
const num = (n) => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 3 });

async function iniciarInventario() {
  try {
    const e = await pedir(API + 'admin/inventario/estado.php');
    $('grupo-inventario').hidden = !e.activo;
    $('btn-inv-insumos').hidden = esGerente;                       // el catálogo y las recetas los edita el administrador
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
  $('inv-catalogo-aviso').hidden = d.puede_editar_catalogo;
  const r = d.resumen;
  const res = el('div', 'inv-resumen');
  for (const [t, v] of [['Valor del inventario', dinero.format(r.valor_inventario)], ['Insumos por debajo del mínimo', String(r.bajo_minimo)], ['Mermas (30 días)', dinero.format(r.mermas_30d)]]) {
    const k = el('div', 'inv-kpi'); k.append(el('small', '', t), el('strong', '', v)); res.append(k);
  }
  if (pg.kpi) c.append(res);
  ({ existencias: tabExistencias, insumos: tabInsumos, compras: tabCompras, mermas: tabMermas, proveedores: tabProveedores, movimientos: tabMovimientos })[inv.tab](c, d);
}

function formInsumo(i) {
  const d = inv.datos;
  const nombre = entrada('text', i?.nombre, { maxLength: 80, placeholder: 'Ej. Tortilla de maíz' });
  const cat = entrada('text', i?.categoria, { maxLength: 40, placeholder: 'Ej. Abarrotes, Carnes…' });
  const uni = selector(d.unidades.map((u) => [u, UNIDAD_TXT[u]]), i?.unidad || 'pza');
  const costo = entrada('number', i?.costo ?? 0, { min: 0, step: '0.01' });
  const min = entrada('number', i?.minimo ?? 0, { min: 0, step: '0.001' });
  const prov = selector([['', 'Sin proveedor'], ...d.proveedores.map((p) => [p.id, p.nombre])], i?.proveedor_id ?? '');
  const f = el('div', 'inv-form');
  f.append(campo('Nombre', nombre), campo('Categoría', cat), campo('Unidad', uni), campo('Costo por unidad', costo), campo('Mínimo (avisa al llegar a esta cantidad)', min), campo('Proveedor habitual', prov));
  const fila = el('div', 'acciones-dialogo');
  fila.append(boton(i ? 'Guardar' : 'Agregar insumo', () => invEnviar({ accion: i ? 'insumo_editar' : 'insumo_crear', id: i?.id, nombre: nombre.value, categoria: cat.value, unidad: uni.value, costo: costo.value, minimo: min.value, proveedor_id: prov.value }, i ? 'Insumo actualizado' : 'Insumo agregado'), 'btn primario'));
  if (i) fila.append(boton('Archivar', async () => { if (await confirmar('¿Archivar ' + i.nombre + '? Conserva su historial.')) invEnviar({ accion: 'insumo_archivar', id: i.id }, 'Insumo archivado'); }));
  f.append(fila);
  return f;
}

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
  const filas = d.insumos.map((i) => [
    i.nombre, i.categoria || '—', UNIDAD_TXT[i.unidad], dinero.format(i.costo), i.minimo ? num(i.minimo) + ' ' + UNIDAD_TXT[i.unidad] : '—',
    (d.proveedores.find((p) => p.id === i.proveedor_id) || {}).nombre || '—',
    d.puede_editar_catalogo ? boton('Editar', () => { const w = $('inv-editor'); w.replaceChildren(el('h3', '', 'Editar ' + i.nombre), formInsumo(i)); w.hidden = false; w.scrollIntoView({ behavior: 'smooth' }); }) : '',
  ]);
  c.append(filas.length ? tabla(['Insumo', 'Categoría', 'Unidad', 'Costo', 'Mínimo', 'Proveedor', ''], filas) : el('p', 'ayuda', 'Aún no hay insumos. Agrega el primero.'));
  const w = el('div', 'inv-editor'); w.id = 'inv-editor'; w.hidden = true; c.append(w);
  if (d.puede_editar_catalogo) { const n = el('details', 'inv-nuevo'); n.open = !filas.length; n.append(el('summary', '', '+ Nuevo insumo'), formInsumo(null)); c.append(n); }
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
    const sel = () => d.insumos.find((x) => String(x.id) === ins.value);
    ins.addEventListener('change', () => { if (sel()) cos.value = sel().costo || ''; });
    if (sel()) cos.value = sel().costo || '';
    const f = el('div', 'inv-linea'); f.append(ins, cant, cos, boton('✕', () => f.remove())); f._v = () => ({ insumo_id: ins.value, cantidad: cant.value, costo: cos.value });
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
