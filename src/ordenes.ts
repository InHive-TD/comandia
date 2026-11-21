/**
 * Lógica de pedidos compartida por el personal (ordenes, cocina, caja) y, en la Fase 4, por el cliente del QR.
 * Es el equivalente de `api/lib_ordenes.php` de la versión PHP, con las mismas reglas.
 *
 * Reglas de oro:
 *  - El navegador NUNCA manda precios: aquí se leen de la base de datos y se calculan los totales.
 *    Cada renglón guarda una "foto" del producto (nombre, precio, código, categoría) tal como estaba al venderse.
 *  - Todo se filtra por `negocio_id` (la empresa) y casi todo por `sucursal_id` (la sucursal).
 *  - Los errores "de negocio" se lanzan con `fallo(mensaje, estado)` y se responden como { ok:false, error:'validacion', mensaje }.
 *
 * Contexto (`Cx`): agrupa la forma de consultar (el pool, o una transacción) con la empresa y la sucursal de la petición.
 * Así cada función sirve igual dentro y fuera de una transacción.
 */
import type { FastifyRequest } from 'fastify';
import { type Fila, type Tx, ejecutar, filas, transaccion } from './db.js';
import { ErrorHttp, fallo } from './errores.js';
import { CARTA_AGOTADO, CARTA_PRECIO, cartaUnir, cartaVisible } from './carta.js';
import { entero, esDuplicado, largo, noVacio } from './util.js';

// ------------------------------------------------------------------ contexto

/** Forma de consultar la base (pool o transacción) + empresa y sucursal de la petición. */
export interface Cx {
  ejecutar: Tx['ejecutar'];
  filas: Tx['filas'];
  nid: number;
  sid: number;
}

/** Contexto "normal" (sin transacción) de una petición ya autenticada (req.sucursalId fijada). */
export function contexto(req: FastifyRequest): Cx {
  return { ejecutar, filas, nid: req.negocio.id, sid: req.sucursalId };
}

/** Ejecuta `trabajo` dentro de una transacción: si algo lanza un error, no se guarda nada. */
export function enTransaccion<T>(c: Cx, trabajo: (t: Cx) => Promise<T>): Promise<T> {
  return transaccion((tx) => trabajo({ ...c, ejecutar: tx.ejecutar, filas: tx.filas }));
}

/** Atajos de lectura: primera fila de una consulta, y un solo valor. */
async function una(c: Cx, sql: string, params: unknown[] = []): Promise<Fila | undefined> {
  return (await c.filas(sql, params))[0];
}
const n = (v: unknown): number => Number(v ?? 0);

/** Redondeo a 2 decimales como round() de PHP (mitad hacia arriba). */
export const redondear = (v: number, d = 2): number => {
  const f = 10 ** d;
  return Math.round((v + Number.EPSILON) * f) / f;
};

// ------------------------------------------------------------------ constantes y textos

export const ESTADOS_ACTIVOS = ['nueva', 'preparando', 'lista'];

/** "2026-10-30" + 7 → "2026-10-30-007" (el turno se reinicia cada día y por sucursal). */
export function textoTurno(fecha: string | null, turno: number | null): string | null {
  if (fecha === null || turno === null) return null;
  return `${fecha}-${String(turno).padStart(3, '0')}`;
}

export type Modalidad = 'aqui' | 'llevar' | 'recoger';

/** 'aqui' (comer aquí), 'llevar' (para llevar) o 'recoger' (pasan por él); cualquier otra cosa se toma como 'aqui'. */
export function leerModalidad(v: unknown): Modalidad {
  return v === 'llevar' || v === 'recoger' ? v : 'aqui';
}

// ------------------------------------------------------------------ tiempos estimados y fila de cocina

/**
 * Tiempo de espera estimado (minutos) según el lugar que ocupa el pedido en la fila de cocina.
 *   1.º: 7 a 10 min según su tamaño · 2.º: 12 · 3.º: 15 · 4.º: 20 · y de ahí +5 por cada pedido más.
 * `posicion` cuenta al propio pedido (1 = nadie delante).
 */
export function minutosEstimados(posicion: number, unidades: number): number {
  const pos = Math.max(1, posicion);
  if (pos === 1) return 7 + Math.max(0, Math.min(3, Math.trunc((Math.max(1, unidades) - 1) / 3))); // 1-3 piezas: 7 · 4-6: 8 · 7-9: 9 · 10+: 10
  if (pos === 2) return 12;
  if (pos === 3) return 15;
  return 20 + 5 * (pos - 4);
}

/** Minutos que se suman al estimado de un pedido nuevo por cada pedido de adelante que ya va retrasado. */
export const MIN_POR_RETRASO = 2;

export interface ItemCola {
  id: number;
  modalidad: string;
  prioritario: boolean;
  unidades: number;
  /** Segundos que faltan para este pedido (negativo = ya va tarde). */
  restante: number;
  /** Lugar en la fila (1 = primero). */
  pos: number;
  transCabeza: number;
}

/** Compara dos listas de números (como el operador <=> de PHP sobre arreglos). */
function compararListas(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Fila de cocina en orden de trabajo (reabiertos primero, luego "comer aquí", luego "para llevar", cada grupo por llegada)
 * con el tiempo que FALTA para cada pedido ("restante", en segundos; negativo = ya va tarde).
 * El primero descuenta su estimado con el cronómetro; cada uno de los demás = lo que falta al de adelante + su incremento.
 */
export async function colaActiva(c: Cx): Promise<ItemCola[]> {
  const prep = await minutosPreparacion(c);
  const filasCola = await c.filas(
    `SELECT id, modalidad, prioritario, estimado_min,
            TIMESTAMPDIFF(SECOND, LEAST(COALESCE(activada_en, creado_en), COALESCE(hora_prometida - INTERVAL ${prep} MINUTE, creado_en)), NOW()) AS espera,
            TIMESTAMPDIFF(SECOND, COALESCE(editado_en, creado_en), NOW()) AS desde_edicion,
            UNIX_TIMESTAMP(LEAST(COALESCE(activada_en, creado_en), COALESCE(hora_prometida - INTERVAL ${prep} MINUTE, creado_en))) AS orden_ts,
            UNIX_TIMESTAMP(COALESCE(editado_en, creado_en)) AS prio_ts,
            (SELECT COALESCE(SUM(i.cantidad), 0) FROM orden_items i WHERE i.orden_id = ordenes.id) AS unidades
       FROM ordenes
      WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado IN ('nueva','preparando')
        AND creado_en >= NOW() - INTERVAL 1 DAY
        AND (hora_prometida IS NULL OR activada_en IS NOT NULL)
        AND EXISTS (SELECT 1 FROM orden_items x WHERE x.orden_id = ordenes.id AND x.estado <> 'listo')`,
  );
  const clave = (f: Fila): number[] => {
    const prio = n(f['prioritario']) === 1;
    return [prio ? 0 : 1, prio ? n(f['prio_ts']) : 0, f['modalidad'] === 'aqui' ? 0 : 1, n(f['orden_ts']), n(f['id'])];
  };
  filasCola.sort((a, b) => compararListas(clave(a), clave(b)));

  const cola: ItemCola[] = [];
  let anterior = 0; // segundos que faltan al pedido de adelante
  let transCabeza = 0; // cronómetro del primer pedido de la fila
  filasCola.forEach((f, i) => {
    const unidades = n(f['unidades']);
    const prio = n(f['prioritario']) === 1;
    let restante: number;
    if (i === 0) {
      const total = f['estimado_min'] !== null ? n(f['estimado_min']) : minutosEstimados(1, unidades);
      transCabeza = prio ? n(f['desde_edicion']) : n(f['espera']);
      restante = total * 60 - transCabeza;
    } else {
      // Tabla de tiempos por lugar en la fila (7-10, 12, 15, 20, +5…) menos lo que ya corrió el cronómetro del primero;
      // mientras el de adelante aún no vence, nunca menos de 3 min después de él. Si el de adelante ya venció,
      // este sigue su propia cuenta regresiva (si no, quedaría clavado en "3 min" y nunca pasaría a "por entregar").
      restante =
        f['estimado_min'] !== null && !prio
          ? n(f['estimado_min']) * 60 - n(f['espera'])
          : minutosEstimados(i + 1, unidades) * 60 - (prio ? n(f['desde_edicion']) : n(f['espera']));
      if (anterior > 0 && restante > 300) {
        // el que ya casi vence o venció no se empuja hacia atrás
        restante = Math.max(restante, anterior + 180, minutosEstimados(i + 1, unidades) * 60 - transCabeza);
      }
    }
    cola.push({ id: n(f['id']), modalidad: String(f['modalidad']), prioritario: prio, unidades, restante, pos: i + 1, transCabeza });
    anterior = restante;
  });
  return cola;
}

export interface EstimadoCola {
  delante: number;
  estimado: number;
  retrasados: number;
  detalle?: string[];
}

/** Estimado (min) para un pedido nuevo según lo que le falta a los que van delante (sin activar agendados). */
export async function estimarCola(c: Cx, modalidad: string, unidades: number, detalle = false): Promise<EstimadoCola> {
  const cola = await colaActiva(c);
  let delante = 0;
  let retrasados = 0; // de los que van delante, cuántos ya vencieron su tiempo
  let ultimo: number | null = null;
  const lista: string[] = [];
  const turnos = new Map<number, Fila>();
  if (detalle && cola.length > 0) {
    const ids = cola.map((x) => x.id).join(',');
    const t = await c.filas(
      `SELECT id, turno, estado, hora_prometida IS NOT NULL AS agendado, DATE_FORMAT(hora_prometida, '%H:%i') AS para
         FROM ordenes WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND id IN (${ids})`,
    );
    for (const x of t) turnos.set(n(x['id']), x);
  }
  for (const q of cola) {
    // Van antes que uno nuevo: reabiertos, los de "comer aquí" y (si el nuevo es para llevar) los de llevar.
    if (q.prioritario || q.modalidad === 'aqui' || modalidad !== 'aqui') {
      delante++;
      ultimo = q.restante;
      if (q.restante <= 0) retrasados++;
      if (detalle) {
        const t = turnos.get(q.id);
        const etiqueta = '#' + String(t?.['turno'] ?? q.id).padStart(3, '0');
        lista.push(
          etiqueta +
            (t && n(t['agendado']) === 1
              ? ` (agendado para las ${t['para']}, ya entró a la fila · ${t['estado']})`
              : ` (${t?.['estado'] ?? ''} · faltan ${Math.max(0, Math.ceil(q.restante / 60))} min)`),
        );
      }
    }
  }
  let estimado =
    ultimo === null
      ? minutosEstimados(1, unidades)
      : Math.ceil(Math.max(minutosEstimados(delante + 1, unidades) * 60 - (cola[0]?.transCabeza ?? 0), Math.max(ultimo, 0) + 180) / 60);
  // Con retrasos la cocina va más lenta que la tabla: se parte del tiempo de un pedido solo (ej. 7 min) y cada pedido
  // de adelante que ya venció suma MIN_POR_RETRASO (2 retrasados → 7 + 4 = 11).
  if (retrasados > 0) estimado = Math.max(estimado, minutosEstimados(1, unidades)) + retrasados * MIN_POR_RETRASO;
  const r: EstimadoCola = { delante, estimado, retrasados };
  if (detalle) r.detalle = lista;
  return r;
}

/** Tiempo estimado para un pedido que se levantaría AHORA: lo que falta al pedido de adelante más lo que suma uno más. */
export async function estimarNuevo(c: Cx, modalidad: string, unidades: number, detalle = false): Promise<EstimadoCola> {
  await activarAgendados(c);
  return estimarCola(c, modalidad, unidades, detalle);
}

/**
 * Pedidos agendados: entran a la fila de cocina cuando, según los pedidos que hay en ese momento,
 * un pedido nuevo tardaría ya lo que falta para la hora prometida (nunca después de "hora − min_preparacion").
 * Con cocina vacía entra a "hora − min_preparacion"; si hay muchos pedidos, entra antes.
 * Una vez activado se queda activado. Se llama en cada consulta de cocina / estimado.
 */
export async function activarAgendados(c: Cx): Promise<void> {
  const ag = await c.filas(
    `SELECT o.id, o.modalidad, TIMESTAMPDIFF(SECOND, NOW(), o.hora_prometida) AS faltan,
            (SELECT COALESCE(SUM(i.cantidad), 0) FROM orden_items i WHERE i.orden_id = o.id) AS unidades
       FROM ordenes o
      WHERE o.negocio_id = ${c.nid} AND o.sucursal_id = ${c.sid} AND o.estado = 'nueva' AND o.hora_prometida IS NOT NULL
        AND o.activada_en IS NULL AND o.creado_en >= NOW() - INTERVAL 1 DAY
      ORDER BY o.hora_prometida, o.id`,
  );
  if (ag.length === 0) return;
  const prep = await minutosPreparacion(c);
  const fila = await una(
    c,
    `SELECT COUNT(*) AS n FROM ordenes WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado IN ('nueva','preparando')
        AND creado_en >= NOW() - INTERVAL 1 DAY AND (hora_prometida IS NULL OR activada_en IS NOT NULL)`,
  );
  let enFila = n(fila?.['n']);
  for (const a of ag) {
    const lead = Math.max(prep, minutosEstimados(enFila + 1, n(a['unidades'])));
    if (n(a['faltan']) <= lead * 60) {
      const est = await estimarCola(c, String(a['modalidad']), n(a['unidades']));
      await c.ejecutar(
        `UPDATE ordenes SET activada_en = NOW(), estimado_min = ?, posicion_cola = ?, retrasados_delante = ?
          WHERE id = ? AND negocio_id = ${c.nid} AND activada_en IS NULL`,
        [est.estimado, est.delante + 1, est.retrasados, n(a['id'])],
      );
      enFila++;
    }
  }
}

// ------------------------------------------------------------------ ajustes de cocina

/**
 * Ajuste de cocina: el propio de la sucursal actual (clave@ID) si lo tiene; si no, el general de la empresa.
 * Con `general = true` devuelve solo el general (lo que edita el dueño).
 */
export async function ajusteValor(c: Cx, clave: string, general = false): Promise<string | null> {
  const claves = general ? [clave] : [`${clave}@${c.sid}`, clave];
  const marcas = claves.map(() => '?').join(',');
  const r = await c.filas(`SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN (${marcas})`, [c.nid, ...claves]);
  const porClave = new Map(r.map((f) => [String(f['clave']), f['valor']]));
  for (const k of claves) {
    const v = porClave.get(k);
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

export interface CategoriaLote {
  id: number;
  nombre: string;
  activa: boolean;
}

/**
 * Categorías que cocina ve juntas en el resumen "Preparar en lote" (se eligen en la administración).
 * Sin configurar, son las hamburguesas. Devuelve todas las categorías con su bandera `activa`.
 */
export async function categoriasLote(c: Cx, general = false): Promise<CategoriaLote[]> {
  const v = await ajusteValor(c, 'lote_categorias', general);
  let ids: number[] | null = null;
  if (v !== null) {
    try {
      const j: unknown = JSON.parse(v);
      ids = (Array.isArray(j) ? j : []).map(entero);
    } catch {
      ids = [];
    }
  }
  const cats = await c.filas('SELECT id, nombre FROM categorias WHERE negocio_id = ? ORDER BY orden, id', [c.nid]);
  return cats.map((k) => ({
    id: n(k['id']),
    nombre: String(k['nombre']),
    activa: ids === null ? /hamburgues/i.test(String(k['nombre'])) : ids.includes(n(k['id'])),
  }));
}

/**
 * Platillos sueltos que cocina también ve en "Preparar en lote" (además de las categorías completas).
 * Se guardan como lista de ids en el ajuste lote_productos; sin configurar, no hay ninguno.
 */
export async function productosLote(c: Cx, general = false): Promise<number[]> {
  const v = await ajusteValor(c, 'lote_productos', general);
  if (v === null) return [];
  try {
    const j: unknown = JSON.parse(v);
    return (Array.isArray(j) ? j : []).map(entero).filter((x) => x > 0);
  } catch {
    return [];
  }
}

/** Minutos que la cocina necesita para tener listo un pedido programado (se ve en cocina desde "hora − esto"). */
export async function minutosPreparacion(c: Cx, general = false): Promise<number> {
  const v = await ajusteValor(c, 'min_preparacion', general);
  return v === null ? 15 : Math.max(0, Math.min(120, entero(v)));
}

/** Minutos extra de prioridad por tipo de pedido (configurables en la administración). "recoger" = "llevar". */
export async function bonosModalidad(c: Cx, general = false): Promise<Record<string, number>> {
  const b: Record<string, number> = { aqui: 0, llevar: 5 };
  for (const [k, clave] of [['aqui', 'bono_aqui'], ['llevar', 'bono_llevar']] as const) {
    const v = await ajusteValor(c, clave, general);
    if (v !== null) b[k] = Math.max(0, Math.min(60, entero(v)));
  }
  b['recoger'] = b['llevar'] ?? 5;
  return b;
}

/**
 * "¿Para cuándo lo quiere?" Acepta { para_en_min: 15 } o { para_hora: "19:30" } (hoy).
 * Devuelve la fecha-hora prometida ("YYYY-MM-DD HH:MM:00") o null si es "lo antes posible".
 */
export async function calcularHoraPrometida(c: Cx, datos: Record<string, unknown>): Promise<string | null> {
  let min = entero(datos['para_en_min']);
  const hora = String(datos['para_hora'] ?? '').trim();
  if (hora !== '') {
    if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(hora)) throw fallo('La hora debe verse así: 19:30.');
    const r = await una(c, 'SELECT TIMESTAMPDIFF(MINUTE, NOW(), TIMESTAMP(CURDATE(), ?)) AS m', [`${hora}:00`]);
    min = n(r?.['m']);
    if (min < 0) throw fallo('Esa hora ya pasó. Elige una hora de hoy más adelante o “lo antes posible”.');
  }
  if (min <= 0) return null;
  if (min > 720) throw fallo('Solo se puede programar hasta 12 horas adelante.');
  const r = await una(c, `SELECT DATE_FORMAT(NOW() + INTERVAL ${Math.trunc(min)} MINUTE, '%Y-%m-%d %H:%i:00') AS h`);
  return String(r?.['h']);
}

// ------------------------------------------------------------------ validar y guardar renglones

interface ProductoLinea {
  id: number;
  nombre: string;
  precio: string;
  codigo: string | null;
  categoria: string;
  estacion_id: number | null;
  max_carnes: number | null;
}
interface ExtraLinea {
  id: number;
  nombre: string;
  codigo: string | null;
  precio: string;
  grupo: string | null;
}
export interface Linea {
  p: ProductoLinea;
  plato: number;
  llevar: number;
  cantidad: number;
  notas: string;
  extras: ExtraLinea[];
  suma: number;
}

/**
 * Valida los renglones contra la base de datos: producto existente, visible en la sucursal, no agotado,
 * extras ligados al producto y activos, máximo de carnes, cantidades. Devuelve [líneas, total].
 */
export async function validarLineas(c: Cx, entrada: unknown): Promise<[Linea[], number]> {
  if (!Array.isArray(entrada) || entrada.length === 0) throw fallo('Agrega al menos un producto al pedido.');
  if (entrada.length > 60) throw fallo('Un pedido no puede tener más de 60 renglones.');

  const lineas: Linea[] = [];
  let total = 0;
  for (const r of entrada as unknown[]) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw fallo('Pedido mal formado.');
    const reg = r as Record<string, unknown>;
    const productoId = entero(reg['producto_id']);
    const cantidad = entero(reg['cantidad']);
    if (cantidad < 1 || cantidad > 50) throw fallo('La cantidad de cada producto debe ir de 1 a 50.');
    const plato = reg['plato'] === undefined || reg['plato'] === null ? 1 : entero(reg['plato']);
    if (plato < 1 || plato > 20) throw fallo('El plato debe ir de 1 a 20.');
    const llevar = noVacio(reg['llevar']) ? 1 : 0; // plato para llevar dentro de un pedido para comer aquí
    const notas = String(reg['notas'] ?? '').trim();
    if (largo(notas) > 255) throw fallo('La nota de un producto no puede pasar de 255 caracteres.');

    const p = await una(
      c,
      `SELECT p.id, p.nombre, ${CARTA_PRECIO} AS precio, COALESCE(p.codigo_cocina, p.codigo) AS codigo, p.max_carnes, p.disponible,
              ${CARTA_AGOTADO} AS agotado_hoy, p.estacion_id, c.nombre AS categoria
         FROM productos p JOIN categorias c ON c.id = p.categoria_id${cartaUnir(c.sid)}
        WHERE p.id = ? AND p.negocio_id = ${c.nid} AND c.negocio_id = p.negocio_id${cartaVisible(c.sid)}`,
      [productoId],
    );
    if (!p) throw fallo('Uno de los productos ya no existe. Recarga el menú.');
    if (!n(p['disponible']) || n(p['agotado_hoy']) === 1) throw fallo(`“${p['nombre']}” está agotado.`);

    const extrasElegidos: ExtraLinea[] = [];
    let sumaExtras = 0;
    const vistos = new Set<number>();
    const listaExtras = Array.isArray(reg['extras']) ? reg['extras'] : reg['extras'] === undefined || reg['extras'] === null ? [] : [reg['extras']];
    for (const e of listaExtras) {
      const extraId = entero(e);
      if (extraId < 1 || vistos.has(extraId)) continue;
      vistos.add(extraId);
      const x = await una(
        c,
        `SELECT e.id, e.nombre, e.codigo, COALESCE(pe.precio, e.precio) AS precio, e.activo, e.grupo
           FROM extras e JOIN producto_extras pe ON pe.extra_id = e.id
          WHERE e.id = ? AND pe.producto_id = ? AND e.negocio_id = ${c.nid}
            AND EXISTS (SELECT 1 FROM productos px WHERE px.id = pe.producto_id AND px.negocio_id = e.negocio_id)`,
        [extraId, productoId],
      );
      if (!x) throw fallo(`Ese extra no está disponible para “${p['nombre']}”.`);
      if (!n(x['activo'])) throw fallo(`El extra “${x['nombre']}” ya no está activo.`);
      extrasElegidos.push({ id: n(x['id']), nombre: String(x['nombre']), codigo: (x['codigo'] as string | null) ?? null, precio: String(x['precio']), grupo: (x['grupo'] as string | null) ?? null });
      sumaExtras += Number(x['precio']);
    }

    if (p['max_carnes'] !== null) {
      const nCarnes = extrasElegidos.filter((x) => x.grupo === 'Carne a elegir').length;
      const max = n(p['max_carnes']);
      if (nCarnes > max) throw fallo(`“${p['nombre']}” lleva máximo ${max} carne${max === 1 ? '' : 's'}.`);
    }

    total += redondear((Number(p['precio']) + sumaExtras) * cantidad);
    lineas.push({
      p: {
        id: n(p['id']), nombre: String(p['nombre']), precio: String(p['precio']), codigo: (p['codigo'] as string | null) ?? null,
        categoria: String(p['categoria']), estacion_id: p['estacion_id'] === null ? null : n(p['estacion_id']),
        max_carnes: p['max_carnes'] === null ? null : n(p['max_carnes']),
      },
      plato, llevar, cantidad, notas, extras: extrasElegidos, suma: sumaExtras,
    });
  }
  return [lineas, redondear(total)];
}

/** Guarda los renglones de un pedido (y sus extras). Debe llamarse dentro de una transacción. */
export async function insertarLineas(c: Cx, ordenId: number, lineas: Linea[]): Promise<void> {
  // "Para llevar" por plato solo tiene sentido en pedidos para comer aquí (en los demás todo ya es para llevar)
  const mo = await una(c, 'SELECT modalidad FROM ordenes WHERE id = ? AND negocio_id = ?', [ordenId, c.nid]);
  const esAqui = mo?.['modalidad'] === 'aqui';
  for (const l of lineas) {
    const p = l.p;
    const r = await c.ejecutar(
      `INSERT INTO orden_items (orden_id, producto_id, nombre_producto, precio_unitario, cantidad, notas, codigo, categoria, estacion_id, extras_precio, plato, llevar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ordenId, p.id, p.nombre, p.precio, l.cantidad, l.notas === '' ? null : l.notas, p.codigo, p.categoria, p.estacion_id, l.suma.toFixed(2), l.plato, esAqui && l.llevar ? 1 : 0],
    );
    for (const x of l.extras) {
      await c.ejecutar('INSERT INTO orden_item_extras (item_id, extra_id, nombre, codigo, precio) VALUES (?, ?, ?, ?, ?)', [r.insertId, x.id, x.nombre, x.codigo, x.precio]);
    }
  }
}

export interface Mesa {
  id: number;
  nombre: string;
}

/** Valida la mesa elegida: debe ser una mesa activa de la sucursal actual. Devuelve null si no se eligió ninguna. */
export async function leerMesa(c: Cx, v: unknown): Promise<Mesa | null> {
  const id = entero(v);
  if (id <= 0) return null;
  const m = await una(c, 'SELECT id, nombre FROM mesas WHERE id = ? AND negocio_id = ? AND sucursal_id = ? AND activa = 1', [id, c.nid, c.sid]);
  if (!m) throw fallo('Esa mesa no existe en esta sucursal.', 400);
  return { id: n(m['id']), nombre: String(m['nombre']) };
}

export interface OrdenCreada {
  id: number;
  turno: string | null;
  nombre_cliente: string;
  total: number;
  agregado?: number;
  estimado?: number;
  delante?: number;
}

export interface DatosOrden {
  cliente: string;
  notas: string;
  lineas: Linea[];
  total: number;
  origen: string;
  creadoPor: number | null;
  clave?: string | null;
  telefono?: string | null;
  modalidad?: Modalidad;
  horaPrometida?: string | null;
  mesa?: Mesa | null;
}

/**
 * Crea un pedido nuevo con su turno del día (por sucursal). Si dos pedidos piden el mismo turno a la vez
 * (error 1062 de MySQL), se reintenta con el siguiente.
 */
export async function crearOrden(c: Cx, d: DatosOrden): Promise<OrdenCreada> {
  const modalidad = d.modalidad ?? 'aqui';
  for (let intento = 0; intento < 6; intento++) {
    try {
      return await enTransaccion(c, async (t) => {
        const fecha = String((await una(t, 'SELECT CURDATE() AS f'))?.['f']);
        const turno = n((await una(t, 'SELECT COALESCE(MAX(turno), 0) + 1 AS t FROM ordenes WHERE sucursal_id = ? AND fecha_turno = ?', [t.sid, fecha]))?.['t']);

        let estimado: number | null = null;
        let posicion: number | null = null;
        let retrasados: number | null = null;
        if (!d.horaPrometida) {
          const unidades = d.lineas.reduce((s, l) => s + (l.cantidad || 1), 0);
          const est = await estimarNuevo(t, modalidad, Math.max(1, unidades));
          estimado = est.estimado;
          posicion = est.delante + 1; // lugar en la fila al levantarse (1 = nadie delante)
          retrasados = est.retrasados; // cuántos de los de adelante ya iban retrasados
        }
        const r = await t.ejecutar(
          `INSERT INTO ordenes (negocio_id, sucursal_id, nombre_cliente, origen, estado, total, notas, fecha_turno, turno, creado_por, clave_cliente, telefono,
                                modalidad, hora_prometida, estimado_min, posicion_cola, retrasados_delante, mesa_id, mesa)
           VALUES (?, ?, ?, ?, 'nueva', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [t.nid, t.sid, d.cliente, d.origen, d.total.toFixed(2), d.notas === '' ? null : d.notas, fecha, turno, d.creadoPor, d.clave ?? null, d.telefono ?? null,
           modalidad, d.horaPrometida ?? null, estimado, posicion, retrasados, d.mesa?.id ?? null, d.mesa?.nombre ?? null],
        );
        await insertarLineas(t, r.insertId, d.lineas);
        return { id: r.insertId, turno: textoTurno(fecha, turno), nombre_cliente: d.cliente, total: d.total };
      });
    } catch (e) {
      if (esDuplicado(e)) continue; // otro pedido tomó ese turno: se reintenta con el siguiente
      if (e instanceof ErrorHttp) throw e;
      console.error('[comandia] crear pedido:', e);
      throw fallo('No se pudo guardar el pedido. Inténtalo de nuevo.', 500);
    }
  }
  throw fallo('Hay mucho movimiento. Inténtalo de nuevo.', 503);
}

/** Agrega renglones a un pedido que sigue en cocina ("agrégame una gringa"). */
export async function agregarAOrden(c: Cx, ordenId: number, lineas: Linea[], total: number): Promise<OrdenCreada> {
  return enTransaccion(c, async (t) => {
    const o = await una(t, 'SELECT id, fecha_turno, turno, nombre_cliente, estado, total, prioritario FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]);
    if (!o) throw fallo('Ese pedido ya no existe.', 404);
    if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) throw fallo('Ese pedido ya salió de cocina; levanta uno nuevo.', 409);
    const prio = n(o['prioritario']) === 1;
    await insertarLineas(t, ordenId, lineas);
    await registrarAgregados(t, ordenId, lineas, prio);
    for (const l of lineas) {
      const ex = l.extras.map((x) => x.nombre).join(', ');
      await registrarCambio(t, ordenId, `Se agregó ${l.cantidad}× ${l.p.nombre}${ex !== '' ? ` (${ex})` : ''}`, prio || o['estado'] === 'lista');
    }
    const nuevoTotal = redondear(Number(o['total']) + total);
    const nuevoEstado = o['estado'] === 'lista' ? 'preparando' : String(o['estado']);
    await t.ejecutar('UPDATE ordenes SET total = ?, estado = ? WHERE id = ? AND negocio_id = ?', [nuevoTotal.toFixed(2), nuevoEstado, ordenId, t.nid]);
    await actualizarPagado(t, ordenId); // si ya estaba pagado, ahora queda saldo por cobrar
    await marcarEditado(t, ordenId);
    if (o['estado'] === 'lista') await hacerPrioritaria(t, ordenId); // "lista para entregar" y le agregan algo: reabierto con prioridad
    return { id: ordenId, turno: textoTurno(String(o['fecha_turno']), n(o['turno'])), nombre_cliente: String(o['nombre_cliente']), total: nuevoTotal, agregado: total };
  });
}

// ------------------------------------------------------------------ estados del pedido

/** Recalcula el estado del pedido a partir de sus renglones (nueva / preparando; "lista" solo la confirma cocina). */
export async function actualizarEstadoOrden(c: Cx, ordenId: number): Promise<string> {
  const r = await una(
    c,
    `SELECT COUNT(*) AS total, COALESCE(SUM(estado = 'listo'), 0) AS listos, COALESCE(SUM(estado = 'preparando'), 0) AS preparando
       FROM orden_items WHERE orden_id = ?`,
    [ordenId],
  );
  const total = n(r?.['total']);
  const listos = n(r?.['listos']);
  const preparando = n(r?.['preparando']);
  // Con todos los renglones listos el pedido NO pasa solo a "lista para entregar": cocina lo confirma con el botón
  // "Mover a listas para entregar" (acción mover_listas). Si ya estaba en "lista", se queda ahí.
  const actual = await una(c, 'SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ?', [ordenId, c.nid]);
  const estadoActual = String(actual?.['estado'] ?? '');
  const completo = total > 0 && listos === total;
  const nuevo = completo ? (estadoActual === 'lista' ? 'lista' : 'preparando') : listos + preparando > 0 ? 'preparando' : 'nueva';
  await c.ejecutar("UPDATE ordenes SET estado = ? WHERE id = ? AND negocio_id = ? AND estado IN ('nueva','preparando','lista')", [nuevo, ordenId, c.nid]);
  return nuevo;
}

/** Anota que el pedido cambió (la cocina avisa con un sonido distinto). */
export async function marcarEditado(c: Cx, ordenId: number): Promise<void> {
  await c.ejecutar('UPDATE ordenes SET revision = revision + 1, editado_en = NOW() WHERE id = ? AND negocio_id = ?', [ordenId, c.nid]);
}

/** Pedido que ya estaba "lista" (o entregada) y se vuelve a tocar: va al frente de cocina y su reloj empieza de nuevo. */
export async function hacerPrioritaria(c: Cx, ordenId: number): Promise<void> {
  await c.ejecutar('UPDATE ordenes SET prioritario = 1, estimado_min = NULL WHERE id = ? AND negocio_id = ?', [ordenId, c.nid]);
  await marcarEditado(c, ordenId);
}

/**
 * El pedido ya se entregó pero el cliente quiere agregar algo (o corregirlo): se reabre como "lista"
 * con todo lo anterior intacto, y queda PRIORITARIO: lo que se le agregue pasa por delante de todos en cocina.
 */
export async function reabrirEntregada(c: Cx, ordenId: number): Promise<void> {
  await enTransaccion(c, async (t) => {
    const o = await una(t, 'SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]);
    if (!o) throw fallo('Ese pedido ya no existe.', 404);
    if (o['estado'] !== 'entregada') {
      throw fallo(o['estado'] === 'cancelada' ? 'Ese pedido está cancelado.' : 'Ese pedido todavía está en cocina: edítalo directamente.', 409);
    }
    await t.ejecutar("UPDATE orden_items SET estado = 'listo' WHERE orden_id = ?", [ordenId]);
    await t.ejecutar("UPDATE ordenes SET estado = 'lista', prioritario = 1, estimado_min = NULL WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
    await marcarEditado(t, ordenId);
  });
}

/** Cancela un pedido activo. Si ya tenía pagos, Caja lo mostrará como "devolver". */
export async function cancelarOrden(c: Cx, ordenId: number): Promise<void> {
  await enTransaccion(c, async (t) => {
    const o = await una(t, 'SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]);
    if (!o) throw fallo('Ese pedido ya no existe.', 404);
    if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) {
      throw fallo(o['estado'] === 'entregada' ? 'Ese pedido ya se entregó: no se puede cancelar.' : 'Ese pedido ya está cancelado.', 409);
    }
    await t.ejecutar("UPDATE ordenes SET estado = 'cancelada', cancelado_en = NOW(), prioritario = 0 WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
  });
}

// ------------------------------------------------------------------ bitácoras

/**
 * Nota de "pedido modificado": guarda en el pedido QUÉ se cambió (se agregó, subió o bajó cantidad, se quitó un platillo).
 * Se ve en Caja al cobrar; queda aunque el pedido ya se haya entregado. `despues` = ya estaba lista/entregada (reabierto).
 */
export async function registrarCambio(c: Cx, ordenId: number, detalle: string, despues = false): Promise<void> {
  try {
    await c.ejecutar('INSERT INTO orden_cambios (orden_id, detalle, despues_de_entrega) VALUES (?, ?, ?)', [ordenId, [...detalle].slice(0, 250).join(''), despues ? 1 : 0]);
  } catch (e) {
    console.error('[comandia] nota de modificación:', e); // nunca impide editar el pedido
  }
}

/**
 * Bitácora: anota lo que se le agregó a un pedido ya levantado. `despues_de_entrega` = 1 cuando el pedido ya se
 * había entregado y se reabrió. Al entregarse, esas filas quedan ligadas a la entrega (registrarEntrega).
 */
export async function registrarAgregados(c: Cx, ordenId: number, lineas: Linea[], despuesDeEntrega: boolean): Promise<void> {
  try {
    for (const l of lineas) {
      const extras = l.extras.map((x) => x.nombre).join(', ');
      await c.ejecutar(
        `INSERT INTO pedido_agregados (orden_id, producto_id, nombre_producto, codigo, cantidad, extras, plato, despues_de_entrega) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ordenId, l.p.id, l.p.nombre, l.p.codigo ?? null, l.cantidad, extras === '' ? null : extras, l.plato ?? null, despuesDeEntrega ? 1 : 0],
      );
    }
  } catch (e) {
    console.error('[comandia] bitácora de agregados:', e); // nunca impide agregar al pedido
  }
}

/** Segundos de margen para llamar "a tiempo" a una entrega (antes de eso = anticipado, después = atrasado). */
export const TOLERANCIA_ENTREGA_SEG = 60;

/**
 * Bitácora de tiempos: anota en `tiempos_pedido` cuánto tardó un pedido desde que se levantó (o entró a la fila, si era
 * agendado, o se reabrió) hasta que se entregó, su lugar en la fila, lo prometido y si salió anticipado, a tiempo o atrasado.
 * Un pedido reabierto y vuelto a entregar agrega otra fila (entrega_n = 2, 3…). Se llama dentro de la transacción de entrega.
 */
export async function registrarEntrega(c: Cx, ordenId: number): Promise<void> {
  try {
    const o = await una(
      c,
      `SELECT o.fecha_turno, o.turno, o.modalidad, o.origen, o.prioritario, o.estimado_min, o.posicion_cola, o.retrasados_delante,
              o.hora_prometida IS NOT NULL AS agendado,
              COALESCE(o.hora_prometida, '') AS hora_prometida,
              (SELECT COALESCE(SUM(i.cantidad), 0) FROM orden_items i WHERE i.orden_id = o.id) AS unidades,
              (SELECT COUNT(*) FROM tiempos_pedido t WHERE t.orden_id = o.id) AS previas,
              CASE WHEN o.prioritario = 1 THEN COALESCE(o.editado_en, o.creado_en)
                   WHEN o.hora_prometida IS NOT NULL THEN COALESCE(o.activada_en, o.creado_en)
                   ELSE o.creado_en END AS inicio
         FROM ordenes o WHERE o.id = ? AND o.negocio_id = ?`,
      [ordenId, c.nid],
    );
    if (!o) return;
    const unidades = Math.max(1, n(o['unidades']));
    const reabierto = n(o['prioritario']) === 1;
    const agendado = n(o['agendado']) === 1;
    // Lo prometido: pedido normal = estimado al levantarlo; agendado = su hora; reabierto = el 1.º de la fila (como lo ve cocina)
    const estimadoMin = reabierto || o['estimado_min'] === null ? minutosEstimados(1, unidades) : n(o['estimado_min']);
    const prometido = agendado && !reabierto ? String(o['hora_prometida']) : null;
    const entregaN = n(o['previas']) + 1;
    const inicio = String(o['inicio']);
    await c.ejecutar(
      `INSERT INTO tiempos_pedido (negocio_id, sucursal_id, orden_id, entrega_n, fecha, turno, modalidad, origen, unidades, agendado, reabierto,
              posicion_cola, retrasados_delante, estimado_min, inicio_en, prometido_en, entregado_en, duracion_seg, diferencia_seg, resultado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, DATE_ADD(?, INTERVAL ${estimadoMin} MINUTE)), NOW(),
               TIMESTAMPDIFF(SECOND, ?, NOW()), TIMESTAMPDIFF(SECOND, COALESCE(?, DATE_ADD(?, INTERVAL ${estimadoMin} MINUTE)), NOW()), 'a_tiempo')`,
      [
        c.nid, c.sid, ordenId, entregaN, o['fecha_turno'], n(o['turno']), o['modalidad'], o['origen'], unidades,
        agendado ? 1 : 0, reabierto ? 1 : 0,
        reabierto ? 1 : (o['posicion_cola'] ?? null), reabierto ? null : (o['retrasados_delante'] ?? null), estimadoMin,
        inicio, prometido, inicio,
        inicio, prometido, inicio,
      ],
    );
    // Lo que se le agregó al pedido desde la entrega anterior (o desde que se levantó)
    const lista = await c.filas('SELECT nombre_producto, codigo, cantidad, extras, despues_de_entrega FROM pedido_agregados WHERE orden_id = ? AND entrega_n IS NULL ORDER BY id', [ordenId]);
    if (lista.length > 0) {
      const json = JSON.stringify(
        lista.map((a) => ({ producto: a['nombre_producto'], codigo: a['codigo'], cantidad: n(a['cantidad']), extras: a['extras'], despues_de_entrega: n(a['despues_de_entrega']) === 1 })),
      );
      await c.ejecutar('UPDATE tiempos_pedido SET agregados = ?, n_agregados = ? WHERE orden_id = ? AND entrega_n = ?', [json, lista.length, ordenId, entregaN]);
      await c.ejecutar('UPDATE pedido_agregados SET entrega_n = ? WHERE orden_id = ? AND entrega_n IS NULL', [entregaN, ordenId]);
    }
    const tol = TOLERANCIA_ENTREGA_SEG;
    await c.ejecutar(
      `UPDATE tiempos_pedido SET resultado = CASE WHEN diferencia_seg < -${tol} THEN 'anticipado' WHEN diferencia_seg > ${tol} THEN 'atrasado' ELSE 'a_tiempo' END
        WHERE orden_id = ? AND entrega_n = ?`,
      [ordenId, entregaN],
    );
  } catch (e) {
    // La bitácora nunca debe impedir entregar un pedido.
    console.error('[comandia] bitácora de tiempos:', e);
  }
}

/** "Ya se entregó todo": marca todos los renglones como listos y el pedido como entregado. */
export async function cerrarOrden(c: Cx, ordenId: number): Promise<void> {
  await enTransaccion(c, async (t) => {
    const o = await una(t, 'SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]);
    if (!o) throw fallo('Ese pedido ya no existe.', 404);
    if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
    await t.ejecutar("UPDATE orden_items SET estado = 'listo' WHERE orden_id = ? AND estado <> 'listo'", [ordenId]);
    await registrarEntrega(t, ordenId); // antes de limpiar "prioritario": ahí sabe si era un pedido reabierto
    await t.ejecutar("UPDATE ordenes SET estado = 'entregada', prioritario = 0 WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
  });
}

// ------------------------------------------------------------------ totales y pagos

/** Recalcula el total del pedido a partir de sus renglones. */
export async function recalcularTotal(c: Cx, ordenId: number): Promise<number> {
  const r = await una(c, 'SELECT COALESCE(SUM(cantidad * (precio_unitario + extras_precio)), 0) AS t FROM orden_items WHERE orden_id = ?', [ordenId]);
  const total = Number(r?.['t'] ?? 0);
  await c.ejecutar('UPDATE ordenes SET total = ? WHERE id = ? AND negocio_id = ?', [total.toFixed(2), ordenId, c.nid]);
  await actualizarPagado(c, ordenId);
  return total;
}

/** Lo que ya se pagó de la cuenta (sin propina y sin pagos anulados). */
export async function montoPagado(c: Cx, ordenId: number): Promise<number> {
  const r = await una(c, 'SELECT COALESCE(SUM(monto), 0) AS m FROM pagos WHERE orden_id = ? AND negocio_id = ? AND anulado = 0', [ordenId, c.nid]);
  return redondear(Number(r?.['m'] ?? 0));
}

/**
 * "Pagado" = lo pagado cubre el total (y hay algo que cubrir). Se recalcula cada vez que cambia el total o un pago:
 * si agregan platillos a un pedido ya pagado, vuelve a "sin pagar".
 */
export async function actualizarPagado(c: Cx, ordenId: number): Promise<boolean> {
  const o = await una(c, 'SELECT total FROM ordenes WHERE id = ? AND negocio_id = ?', [ordenId, c.nid]);
  if (!o) return false;
  const total = Number(o['total']);
  const pagado = total > 0 && (await montoPagado(c, ordenId)) + 0.004 >= total;
  await c.ejecutar('UPDATE ordenes SET pagado = ? WHERE id = ? AND negocio_id = ?', [pagado ? 1 : 0, ordenId, c.nid]);
  return pagado;
}

// ------------------------------------------------------------------ editar renglones

/** Bloquea un renglón y su pedido. Con `ordenId` se exige que el renglón sea de ese pedido. Solo dentro de una transacción. */
async function bloquearItem(c: Cx, itemId: number, ordenId: number | null): Promise<Fila> {
  const it = await una(
    c,
    `SELECT i.*, o.estado AS orden_estado FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE i.id = ? AND o.negocio_id = ? FOR UPDATE`,
    [itemId, c.nid],
  );
  if (!it || (ordenId !== null && n(it['orden_id']) !== ordenId)) throw fallo('Ese renglón ya no existe.', 404);
  if (!ESTADOS_ACTIVOS.includes(String(it['orden_estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
  return it;
}

/**
 * Cambia las piezas de un renglón. Si SUBE y ya estaba preparándose/listo, lo agregado va como renglón nuevo pendiente.
 * Con `esCliente`, bajar piezas solo se permite si el renglón sigue pendiente.
 */
export async function cambiarCantidad(c: Cx, itemId: number, cantidad: number, ordenId: number | null = null, esCliente = false): Promise<{ orden_estado: string; total: number }> {
  if (cantidad < 1 || cantidad > 50) throw fallo('La cantidad debe ir de 1 a 50 (para quitarlo usa “Quitar”).');
  return enTransaccion(c, async (t) => {
    const it = await bloquearItem(t, itemId, ordenId);
    const id = n(it['orden_id']);
    const actual = n(it['cantidad']);
    const ee = await una(t, 'SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ?', [id, t.nid]);
    const estabaLista = ee?.['estado'] === 'lista';

    if (esCliente && cantidad < actual && it['estado'] !== 'pendiente') throw fallo('Esa parte ya se está preparando o ya se entregó. Pide el cambio en caja.', 409);
    if (cantidad > actual && it['estado'] !== 'pendiente') {
      const r = await t.ejecutar(
        `INSERT INTO orden_items (orden_id, producto_id, nombre_producto, precio_unitario, cantidad, notas, codigo, categoria, estacion_id, extras_precio, plato, llevar)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, it['producto_id'] ?? null, it['nombre_producto'], it['precio_unitario'], cantidad - actual, it['notas'] ?? null, it['codigo'] ?? null, it['categoria'] ?? null,
         it['estacion_id'] ?? null, it['extras_precio'], it['plato'], n(it['llevar'])],
      );
      await t.ejecutar('INSERT INTO orden_item_extras (item_id, extra_id, nombre, codigo, precio) SELECT ?, extra_id, nombre, codigo, precio FROM orden_item_extras WHERE item_id = ?', [r.insertId, itemId]);
    } else {
      await t.ejecutar('UPDATE orden_items SET cantidad = ? WHERE id = ?', [cantidad, itemId]);
    }
    const total = await recalcularTotal(t, id);
    const estado = await actualizarEstadoOrden(t, id);
    await marcarEditado(t, id);
    await registrarCambio(t, id, `${it['nombre_producto']}: ${actual} → ${cantidad}${cantidad > actual ? ` (se sumó ${cantidad - actual})` : ` (se restó ${actual - cantidad})`}`, estabaLista);
    if (cantidad > actual && estabaLista) await hacerPrioritaria(t, id); // "lista para entregar" al que se le suma algo: reabierto con prioridad
    return { orden_estado: estado, total };
  });
}

/** Quita un renglón (si no queda ninguno, el pedido se cancela). */
export async function quitarRenglon(c: Cx, itemId: number, ordenId: number | null = null, esCliente = false): Promise<{ orden_estado: string; total: number }> {
  return enTransaccion(c, async (t) => {
    const it = await bloquearItem(t, itemId, ordenId);
    const id = n(it['orden_id']);
    if (esCliente && it['estado'] !== 'pendiente') throw fallo('Esa parte ya se está preparando o ya se entregó. Pide el cambio en caja.', 409);
    await t.ejecutar('DELETE FROM orden_items WHERE id = ?', [itemId]);
    await registrarCambio(t, id, `Se quitó ${n(it['cantidad'])}× ${it['nombre_producto']}`);
    const quedan = n((await una(t, 'SELECT COUNT(*) AS n FROM orden_items WHERE orden_id = ?', [id]))?.['n']);
    const total = await recalcularTotal(t, id);
    let estado: string;
    if (quedan < 1) {
      await t.ejecutar("UPDATE ordenes SET estado = 'cancelada', cancelado_en = NOW() WHERE id = ? AND negocio_id = ?", [id, t.nid]);
      estado = 'cancelada';
    } else {
      estado = await actualizarEstadoOrden(t, id);
      await marcarEditado(t, id);
    }
    return { orden_estado: estado, total };
  });
}
