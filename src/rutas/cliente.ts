/**
 * Pantalla del cliente que entra por el QR (sin cuenta ni contraseña).
 *
 *   GET  /cliente/pedido?clave=…        → estado del pedido en tiempo real
 *   GET  /cliente/pedido?claves=a,b,c   → varios pedidos (máx. 10) de este celular
 *   GET  /cliente/pedido?buscar=…       → consulta de SOLO LECTURA por número de pedido de hoy o por nombre
 *   POST /cliente/pedido { accion: 'crear', clave, nombre_cliente, telefono?, acepta_promos?, notas?, modalidad?, para_en_min?|para_hora?, items }
 *                        { accion: 'agregar', clave, items } · { accion: 'cantidad', clave, item_id, cantidad }
 *                        { accion: 'quitar', clave, item_id } · { accion: 'cancelar', clave }   (solo si nada se ha empezado)
 *   GET  /cliente/espera?modalidad=&unidades=   → minutos estimados si se pidiera AHORA
 *   GET  /cliente/concepto?numero=123           → nombre con el que se levantó el pedido de hoy (para el concepto de la transferencia)
 *
 * La "clave" (32 caracteres hexadecimales) la genera el navegador del cliente y funciona como contraseña del pedido:
 * quien la tiene puede verlo y editarlo. Regla de edición: lo que ya se está preparando o ya se entregó NO se puede
 * bajar ni quitar desde aquí (evita pedir de más y luego "arrepentirse"); solo cocina o caja.
 * Límites por dirección IP para evitar abuso (se guardan solo con un hash, nunca la IP).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cuerpoJson, exigirMetodo, fijarSucursalAuto, fijarSucursalPublica } from '../auth.js';
import { ejecutar, filas as consultar, type Fila } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import {
  type Cx, ESTADOS_ACTIVOS, activarAgendados, agregarAOrden, calcularHoraPrometida, cambiarCantidad, colaActiva, contexto, crearOrden, enTransaccion,
  estimarNuevo, leerModalidad, minutosEstimados, quitarRenglon, textoTurno, validarLineas,
} from '../ordenes.js';
import { clientePuedePedir } from '../pedidosClientes.js';
import { entero, largo } from '../util.js';

const MAX_PEDIDOS_POR_RATO = 6; // por dirección IP
const MINUTOS_RATO = 10;
const MAX_ACTIVOS_POR_IP = 4;

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const esClave = (c: unknown): c is string => typeof c === 'string' && /^[a-f0-9]{32}$/.test(c);

function claveValida(c: unknown): string {
  if (!esClave(c)) throw fallo('Clave de pedido no válida.', 400);
  return c;
}

const COLUMNAS_ORDEN = `id, sucursal_id, fecha_turno, turno, nombre_cliente, estado, total, pagado, notas, origen, modalidad, prioritario, editado_en,
  DATE_FORMAT(creado_en, '%H:%i') AS hora, creado_en, DATE_FORMAT(hora_prometida, '%H:%i') AS para, activada_en`;

async function buscarOrden(c: Cx, clave: string): Promise<Fila | null> {
  return (await c.filas(`SELECT ${COLUMNAS_ORDEN} FROM ordenes WHERE clave_cliente = ? AND negocio_id = ?`, [clave, c.nid]))[0] ?? null;
}

/** Estado completo del pedido para pintarlo en el celular del cliente. */
async function vistaOrden(base: Cx, o: Fila): Promise<Record<string, unknown>> {
  const c: Cx = { ...base, sid: Number(o['sucursal_id']) }; // la fila de cocina que le toca es la de SU sucursal
  const items = await c.filas('SELECT id, nombre_producto, cantidad, notas, plato, llevar, estado FROM orden_items WHERE orden_id = ? ORDER BY plato, id', [o['id']]);
  const extras = new Map<number, string[]>();
  if (items.length > 0) {
    const ids = items.map((i) => Number(i['id']));
    for (const x of await c.filas(`SELECT item_id, nombre FROM orden_item_extras WHERE item_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids)) {
      const k = Number(x['item_id']);
      extras.set(k, [...(extras.get(k) ?? []), String(x['nombre'])]);
    }
  }

  // ¿Cuántos pedidos van antes que el mío? Reabiertos primero; "comer aquí" antes que "para llevar"; cada grupo por llegada.
  await activarAgendados(c);
  const enFila = ['nueva', 'preparando'].includes(String(o['estado']));
  let delante = 0;
  if (enFila) {
    const mio = Number(o['prioritario'] ?? 0);
    const marca = o['editado_en'] ?? o['creado_en'];
    const r = await c.filas(
      `SELECT COUNT(*) AS n FROM ordenes
        WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado IN ('nueva','preparando') AND id <> ?
          AND creado_en >= NOW() - INTERVAL 1 DAY
          AND (hora_prometida IS NULL OR activada_en IS NOT NULL)
          AND (
            (? = 0 AND prioritario = 1)
            OR (? = 1 AND prioritario = 1 AND COALESCE(editado_en, creado_en) < ?)
            OR (? = 0 AND prioritario = 0 AND ((modalidad = 'aqui' AND ? <> 'aqui') OR ((modalidad = 'aqui') = (? = 'aqui') AND (creado_en < ? OR (creado_en = ? AND id < ?)))))
          )`,
      [o['id'], mio, mio, marca, mio, o['modalidad'], o['modalidad'], o['creado_en'], o['creado_en'], o['id']],
    );
    delante = Number(r[0]?.['n']);
  }
  const unidades = items.reduce((s, i) => s + Number(i['cantidad']), 0);
  let estimado: number | null = null;
  if (enFila) {
    estimado = minutosEstimados(delante + 1, unidades);
    const q = (await colaActiva(c)).find((x) => x.id === Number(o['id']));
    if (q) estimado = Math.max(1, Math.ceil(q.restante / 60)); // lo que falta, descontando el cronómetro
  }

  return {
    id: Number(o['id']),
    turno: textoTurno(String(o['fecha_turno']), Number(o['turno'])),
    numero: String(o['turno']).padStart(3, '0'),
    cliente: o['nombre_cliente'], modalidad: o['modalidad'], para: o['para'],
    programado: o['para'] !== null && o['estado'] === 'nueva' && o['activada_en'] === null,
    estado: o['estado'], total: Number(o['total']), pagado: Boolean(Number(o['pagado'])), hora: o['hora'], delante, estimado,
    editable: ESTADOS_ACTIVOS.includes(String(o['estado'])),
    items: items.map((i) => ({
      id: Number(i['id']), nombre: i['nombre_producto'], cantidad: Number(i['cantidad']), notas: i['notas'], plato: Number(i['plato']), llevar: Boolean(Number(i['llevar'])),
      estado: i['estado'], extras: extras.get(Number(i['id'])) ?? [],
      bloqueado: i['estado'] !== 'pendiente', // solo lo pendiente se puede bajar o quitar desde el celular del cliente
    })),
  };
}

/** Rechaza la petición si en esta sucursal el cliente solo puede ver el menú (el dueño o el gerente lo desactivaron). */
async function exigirPedidosActivos(c: Cx): Promise<void> {
  if (!(await clientePuedePedir(c.nid, c.sid))) {
    throw new ErrorHttp(403, 'pedidos_desactivados', 'Por ahora los pedidos se toman en el mostrador. ¡Puedes ver el menú y pedir en caja!');
  }
}

/** Cuenta intentos recientes de un tipo (usa la tabla intentos_login con un "usuario" que sirve de etiqueta). */
async function intentos(c: Cx, etiqueta: string, ip: string): Promise<number> {
  const r = await c.filas("SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND usuario = ? AND ip = ? AND creado_en > (NOW() - INTERVAL 10 MINUTE)", [c.nid, etiqueta, ip]);
  return Number(r[0]?.['n']);
}
const limite = (): ErrorHttp => new ErrorHttp(429, 'limite', 'Demasiadas consultas. Espera unos minutos e inténtalo de nuevo.');

export async function rutasCliente(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ /cliente/pedido
  app.route({
    method: ['GET', 'POST'],
    url: '/cliente/pedido',
    handler: async (req: FastifyRequest, reply) => {
      const q = req.query as Record<string, unknown>;
      const nid = req.negocio.id;
      // Hasta que se fije una sucursal, el contexto usa 0; cada paso la fija cuando la necesita.
      const base: Cx = { ejecutar, filas: consultar, nid, sid: 0 };

      // ---------------------------------------------------------- GET
      if (req.method === 'GET' && q['claves'] !== undefined) {
        // Varios pedidos a la vez (el cliente puede tener más de uno en curso). Las claves que no existen se omiten.
        const lista = [...new Set(String(q['claves']).split(',').filter(esClave))].slice(0, 10);
        const salida: unknown[] = [];
        for (const clave of lista) {
          const o = await buscarOrden(base, clave);
          if (o) salida.push({ clave, ...(await vistaOrden(base, o)) });
        }
        return { ok: true, ordenes: salida };
      }

      if (req.method === 'GET' && q['buscar'] !== undefined) {
        // Consulta de solo lectura por número de pedido de HOY o por nombre (para quien pidió en mostrador o en otro celular).
        // Nunca devuelve la clave: desde aquí no se puede editar ni cancelar nada.
        const ipb = sha(`${req.ip}|buscar`).slice(0, 40);
        await fijarSucursalPublica(req);
        const c = contexto(req);
        if ((await intentos(c, 'buscar', ipb)) >= 20) throw limite();
        // Un solo campo: si son solo dígitos es el número de pedido; si no, el nombre con el que se levantó.
        const texto = String(q['buscar']).trim();
        if (texto === '' || largo(texto) > 80) throw fallo('Escribe tu número de pedido o el nombre con el que lo pediste.');
        const filas = /^\d{1,4}$/.test(texto)
          ? await c.filas(`SELECT ${COLUMNAS_ORDEN} FROM ordenes WHERE negocio_id = ? AND sucursal_id = ? AND fecha_turno = CURDATE() AND turno = ? AND estado <> 'cancelada' LIMIT 1`, [nid, c.sid, Number(texto)])
          : await c.filas(`SELECT ${COLUMNAS_ORDEN} FROM ordenes WHERE negocio_id = ? AND sucursal_id = ? AND fecha_turno = CURDATE() AND nombre_cliente = ? AND estado <> 'cancelada' ORDER BY turno DESC LIMIT 5`, [nid, c.sid, texto]);
        if (filas.length === 0) {
          await ejecutar("INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, 'buscar')", [nid, ipb]); // solo los fallos cuentan
          throw new ErrorHttp(404, 'no_encontrado', 'No encontramos ese pedido hoy. Revisa el número o el nombre tal como los dimos al pedir.');
        }
        const salida: unknown[] = [];
        for (const o of filas) {
          const v = (await vistaOrden(c, o)) as { items: { bloqueado: boolean }[]; editable: boolean };
          v.editable = false;
          for (const it of v.items) it.bloqueado = true;
          salida.push({ clave: '', soloLectura: true, ...v });
        }
        return { ok: true, ordenes: salida };
      }

      if (req.method === 'GET') {
        const clave = claveValida(q['clave']);
        const o = await buscarOrden(base, clave);
        if (!o) throw new ErrorHttp(404, 'no_existe', 'No encontramos ese pedido.');
        return { ok: true, orden: await vistaOrden(base, o) };
      }

      // ---------------------------------------------------------- POST
      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const accion = String(datos['accion'] ?? '');
      const clave = claveValida(datos['clave']);

      if (accion === 'crear') {
        // Idempotente: si el celular reenvía el mismo pedido (mala señal), se devuelve el que ya existe.
        const existente = await buscarOrden(base, clave);
        if (existente) return { ok: true, repetido: true, orden: await vistaOrden(base, existente) };
        if (String(datos['web'] ?? '').trim() !== '') throw fallo('No se pudo enviar el pedido.', 400); // campo trampa para robots
        const nombre = String(datos['nombre_cliente'] ?? '').trim();
        if (nombre === '' || largo(nombre) > 80) throw fallo('Escribe tu nombre (máximo 80 caracteres) para entregarte tu pedido.');
        const notas = String(datos['notas'] ?? '').trim();
        if (largo(notas) > 255) throw fallo('Las notas no pueden pasar de 255 caracteres.');

        // Teléfono (opcional; obligatorio si el pedido es para recoger): 10 dígitos de México.
        // Las promociones solo con consentimiento expreso.
        let telefono: string | null = null;
        let digitos = String(datos['telefono'] ?? '').replace(/\D+/g, '');
        if (digitos !== '') {
          if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
          if (!/^\d{10}$/.test(digitos)) throw fallo('El teléfono debe tener 10 dígitos (ej. 322 123 4567).');
          telefono = digitos;
        }
        const modalidad = leerModalidad(datos['modalidad']);
        if (telefono === null && modalidad === 'recoger') throw fallo('Para recoger tu pedido escribe tu teléfono de 10 dígitos (te avisamos cuando esté listo).');
        const aceptaPromos = telefono !== null && datos['acepta_promos'] === true;

        // Límites por dirección IP (por empresa)
        await fijarSucursalPublica(req);
        const c = contexto(req);
        await exigirPedidosActivos(c);
        const ip = sha(`${req.ip}|taqueria|${nid}`);
        await ejecutar('DELETE FROM intentos_pedido WHERE creado_en < NOW() - INTERVAL 1 DAY');
        const rato = await c.filas(`SELECT COUNT(*) AS n FROM intentos_pedido WHERE negocio_id = ? AND ip_hash = ? AND creado_en > NOW() - INTERVAL ${MINUTOS_RATO} MINUTE`, [nid, ip]);
        if (Number(rato[0]?.['n']) >= MAX_PEDIDOS_POR_RATO) throw fallo('Has enviado muchos pedidos seguidos. Acércate a caja o espera unos minutos.', 429);
        const hora = await c.filas('SELECT COUNT(*) AS n FROM intentos_pedido WHERE negocio_id = ? AND ip_hash = ? AND creado_en > NOW() - INTERVAL 60 MINUTE', [nid, ip]);
        if (Number(hora[0]?.['n']) >= MAX_ACTIVOS_POR_IP * 2) throw fallo('Ya tienes varios pedidos recientes. Acércate a caja si necesitas algo más.', 429);

        const horaPrometida = await calcularHoraPrometida(c, datos);
        const [lineas, total] = await validarLineas(c, datos['items']);
        await crearOrden(c, { cliente: nombre, notas, lineas, total, origen: 'qr', creadoPor: null, clave, telefono, modalidad, horaPrometida });
        await ejecutar('INSERT INTO intentos_pedido (negocio_id, sucursal_id, ip_hash) VALUES (?, ?, ?)', [nid, c.sid, ip]);
        if (telefono !== null) {
          // Un contacto por teléfono. El consentimiento solo se activa (nunca se quita) desde aquí.
          await ejecutar(
            `INSERT INTO contactos (negocio_id, telefono, nombre, acepta_promos, consentido_en)
             VALUES (?, ?, ?, ?, IF(?, NOW(), NULL))
             ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), pedidos = pedidos + 1, ultimo_pedido_en = NOW(),
                 consentido_en = IF(acepta_promos = 0 AND VALUES(acepta_promos) = 1, NOW(), consentido_en),
                 acepta_promos = GREATEST(acepta_promos, VALUES(acepta_promos))`,
            [nid, telefono, nombre, aceptaPromos ? 1 : 0, aceptaPromos ? 1 : 0],
          );
        }
        const o = await buscarOrden(c, clave);
        reply.code(201);
        return { ok: true, orden: await vistaOrden(c, o!) };
      }

      // Todo lo demás exige un pedido existente
      const o = await buscarOrden(base, clave);
      if (!o) throw new ErrorHttp(404, 'no_existe', 'No encontramos ese pedido.');
      const ordenId = Number(o['id']);
      const c: Cx = { ...base, sid: Number(o['sucursal_id']) }; // precios y carta de la sucursal donde está el pedido

      switch (accion) {
        case 'agregar': {
          await exigirPedidosActivos(c);
          const [lineas, total] = await validarLineas(c, datos['items']);
          await agregarAOrden(c, ordenId, lineas, total);
          break;
        }
        case 'cantidad':
          await cambiarCantidad(c, entero(datos['item_id']), entero(datos['cantidad']), ordenId, true);
          break;
        case 'quitar':
          await quitarRenglon(c, entero(datos['item_id']), ordenId, true);
          break;
        case 'cancelar':
          await enTransaccion(c, async (t) => {
            const e = (await t.filas('SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!ESTADOS_ACTIVOS.includes(String(e?.['estado']))) throw fallo('Ese pedido ya no se puede cancelar.', 409);
            const n = (await t.filas("SELECT COUNT(*) AS n FROM orden_items WHERE orden_id = ? AND estado <> 'pendiente'", [ordenId]))[0];
            if (Number(n?.['n']) > 0) throw fallo('Tu pedido ya se empezó a preparar. Para cancelarlo acércate a caja.', 409);
            await t.ejecutar("UPDATE ordenes SET estado = 'cancelada', cancelado_en = NOW() WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
          });
          break;
        default:
          throw fallo('Acción no reconocida.');
      }
      const actual = await buscarOrden(c, clave);
      return { ok: true, orden: await vistaOrden(c, actual!) };
    },
  });

  // ------------------------------------------------------------------ /cliente/espera
  /** Tiempo estimado si se pidiera AHORA (no revela datos de otros pedidos, solo cuántos hay; con detalle=1 lista los turnos, para el personal). */
  app.get('/cliente/espera', async (req) => {
    await fijarSucursalAuto(req);
    const q = req.query as Record<string, unknown>;
    const unidades = Math.max(1, Math.min(60, entero(q['unidades']) || 1));
    return { ok: true, ...(await estimarNuevo(contexto(req), leerModalidad(q['modalidad']), unidades, q['detalle'] === '1')) };
  });

  // ------------------------------------------------------------------ /cliente/concepto
  /**
   * Concepto para la transferencia: dado el número de pedido de HOY devuelve el nombre con el que se levantó
   * (nada de platillos, teléfono ni totales). Límite: 30 consultas por conexión cada 10 minutos.
   */
  app.get('/cliente/concepto', async (req) => {
    await fijarSucursalPublica(req);
    const c = contexto(req);
    const ip = sha(`${req.ip}|concepto`).slice(0, 40);
    if ((await intentos(c, 'concepto', ip)) >= 30) throw limite();
    await ejecutar("INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, 'concepto')", [c.nid, ip]);
    const numero = String((req.query as Record<string, unknown>)['numero'] ?? '').replace(/\D/g, '');
    if (numero === '' || numero.length > 4) throw fallo('Escribe el número de tu pedido.');
    const f = (await c.filas("SELECT nombre_cliente FROM ordenes WHERE negocio_id = ? AND sucursal_id = ? AND fecha_turno = CURDATE() AND turno = ? AND estado <> 'cancelada' LIMIT 1", [c.nid, c.sid, Number(numero)]))[0];
    if (!f) throw new ErrorHttp(404, 'no_encontrado', 'No encontramos ese número de pedido hoy. Revisa el número que te dimos.');
    return { ok: true, concepto: String(f['nombre_cliente']) };
  });
}
