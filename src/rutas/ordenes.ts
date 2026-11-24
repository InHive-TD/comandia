/**
 * Pedidos del personal (roles taquero, caja, admin, mesero y gerente) y utilidades de operación.
 *
 *   GET  /ordenes → pedidos de HOY de la sucursal (y los que siguen en cocina) con sus renglones.
 *   POST /ordenes → levantar un pedido nuevo, o AGREGAR productos a uno ya levantado (con `orden_id`).
 *        { token, nombre_cliente, notas?, telefono?, modalidad?, mesa_id?, para_en_min?|para_hora?, pago_previsto?,
 *          items: [ { producto_id, cantidad, extras: [id], notas?, plato?, llevar? } ] }
 *   POST /agotar  → marcar un producto agotado HOY solo en esta sucursal (o volver a habilitarlo).
 *   GET  /estado  → prueba de salud (¿Node y MySQL se comunican bien?).
 *
 * El navegador NUNCA manda precios: se leen de la base de datos (carta de la sucursal) y el servidor calcula los totales.
 * `token` evita pedidos duplicados por doble toque: si el mismo token llega otra vez, se devuelve el pedido original.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol, sesionDeNegocio } from '../auth.js';
import { ejecutar, fila, filas } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import {
  type OrdenCreada, agregarAOrden, calcularHoraPrometida, contexto, crearOrden, estimarNuevo, leerMesa, leerModalidad, textoTurno, validarLineas,
} from '../ordenes.js';
import { entero, largo, noVacio } from '../util.js';
import { pedirPorMesaEn } from './admin/prioridades.js';

const ROLES_PERSONAL = ['taquero', 'caja', 'admin', 'mesero', 'gerente'] as const;

/** Pedidos ya enviados en esta sesión (token → pedido), para no duplicar. Se guardan los últimos 20. */
interface Enviado {
  token: string;
  orden: OrdenCreada;
}

export async function rutasOrdenes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ /ordenes
  app.route({
    method: ['GET', 'POST'],
    url: '/ordenes',
    handler: async (req, reply) => {
      const usuario = await requerirRol(req, ...ROLES_PERSONAL);
      const c = contexto(req);

      if (req.method === 'GET') {
        const ordenes = await filas(
          `SELECT id, fecha_turno, turno, nombre_cliente, estado, pagado, total, notas, creado_en, modalidad, pago_previsto, mesa,
                  DATE_FORMAT(hora_prometida, '%H:%i') AS para
             FROM ordenes
            WHERE negocio_id = ? AND sucursal_id = ? AND (fecha_turno = CURDATE() OR estado IN ('nueva','preparando','lista'))
            ORDER BY fecha_turno DESC, turno DESC
            LIMIT 200`,
          [c.nid, c.sid],
        );
        const porOrden = new Map<number, unknown[]>();
        if (ordenes.length > 0) {
          const ids = ordenes.map((o) => Number(o['id']));
          const marcas = ids.map(() => '?').join(',');
          const items = await filas(
            `SELECT id, orden_id, nombre_producto, codigo, cantidad, notas, plato, llevar, estado
               FROM orden_items WHERE orden_id IN (${marcas}) ORDER BY plato, id`,
            ids,
          );
          const extrasPorItem = new Map<number, { nombre: unknown; codigo: unknown }[]>();
          if (items.length > 0) {
            const iids = items.map((i) => Number(i['id']));
            const xs = await filas(`SELECT item_id, nombre, codigo FROM orden_item_extras WHERE item_id IN (${iids.map(() => '?').join(',')}) ORDER BY id`, iids);
            for (const x of xs) {
              const k = Number(x['item_id']);
              extrasPorItem.set(k, [...(extrasPorItem.get(k) ?? []), { nombre: x['nombre'], codigo: x['codigo'] }]);
            }
          }
          for (const i of items) {
            const k = Number(i['orden_id']);
            porOrden.set(k, [
              ...(porOrden.get(k) ?? []),
              {
                id: Number(i['id']), estado: i['estado'], nombre: i['nombre_producto'], codigo: i['codigo'], cantidad: Number(i['cantidad']),
                notas: i['notas'], plato: Number(i['plato']), llevar: Boolean(Number(i['llevar'])), extras: extrasPorItem.get(Number(i['id'])) ?? [],
              },
            ]);
          }
        }
        return {
          ok: true,
          ordenes: ordenes.map((o) => ({
            id: Number(o['id']),
            turno: textoTurno(String(o['fecha_turno']), o['turno'] === null ? null : Number(o['turno'])),
            nombre_cliente: o['nombre_cliente'], estado: o['estado'], pagado: Boolean(Number(o['pagado'])), total: Number(o['total']),
            notas: o['notas'], modalidad: o['modalidad'], mesa: o['mesa'], pago_previsto: o['pago_previsto'], para: o['para'], creado_en: o['creado_en'],
            items: porOrden.get(Number(o['id'])) ?? [],
          })),
        };
      }

      // ---------------------------------------------------------------- POST: levantar o agregar
      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const ses = await sesionDeNegocio(req);

      const token = String(datos['token'] ?? '');
      if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) throw fallo('Falta el identificador del pedido. Recarga la página.');

      // Si el mismo pedido se manda dos veces (doble toque, mala señal), se devuelve el original.
      const previos = ses.obtener<Enviado[]>('pedidos_enviados') ?? [];
      const repetido = previos.find((p) => p.token === token);
      if (repetido) return { ok: true, repetido: true, orden: repetido.orden };

      // Con "orden_id" los productos se AGREGAN a un pedido ya levantado (el cliente pidió algo más).
      const agregarA = entero(datos['orden_id']);

      let nombreCliente = String(datos['nombre_cliente'] ?? '').trim();
      // Modo "pedir por mesa": en pedidos "aquí" la mesa es obligatoria y el nombre es opcional
      const modalidadPedida = leerModalidad(datos['modalidad']);
      const porMesa = agregarA === 0 && modalidadPedida === 'aqui' && (await pedirPorMesaEn(c.nid, c.sid));
      if (largo(nombreCliente) > 80) throw fallo('El nombre del cliente no puede pasar de 80 caracteres.');
      if (agregarA === 0 && nombreCliente === '' && !porMesa && !(modalidadPedida === 'aqui' && entero(datos['mesa_id']))) throw fallo('Escribe el nombre del cliente (máximo 80 caracteres).');
      if (porMesa && !entero(datos['mesa_id'])) throw fallo('Elige la mesa del pedido.');
      const notasOrden = String(datos['notas'] ?? '').trim();
      if (largo(notasOrden) > 255) throw fallo('Las notas del pedido no pueden pasar de 255 caracteres.');

      // Teléfono opcional (útil en "recoger"): 10 dígitos de México
      let telefono: string | null = null;
      let digitos = String(datos['telefono'] ?? '').replace(/\D+/g, '');
      if (agregarA === 0 && digitos !== '') {
        if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
        if (!/^\d{10}$/.test(digitos)) throw fallo('El teléfono debe tener 10 dígitos (o déjalo vacío).');
        telefono = digitos;
      }

      const [lineas, total] = await validarLineas(c, datos['items']);
      const modalidad = leerModalidad(datos['modalidad']);
      const unidades = lineas.reduce((s, l) => s + (l.cantidad || 1), 0);
      const horaPrometida = agregarA === 0 ? await calcularHoraPrometida(c, datos) : null;
      const agendado = horaPrometida !== null;
      const espera = agregarA > 0 ? null : await estimarNuevo(c, modalidad, unidades);
      const mesa = agregarA > 0 || modalidad !== 'aqui' ? null : await leerMesa(c, datos['mesa_id']);
      if (nombreCliente === '' && (porMesa || mesa)) nombreCliente = mesa ? (/mesa/i.test(mesa.nombre) ? mesa.nombre : `Mesa ${mesa.nombre}`) : 'Mesa';
      const orden =
        agregarA > 0
          ? await agregarAOrden(c, agregarA, lineas, total)
          : await crearOrden(c, { cliente: nombreCliente, notas: notasOrden, lineas, total, origen: 'mostrador', creadoPor: usuario.id, telefono, modalidad, horaPrometida, mesa });

      // ¿Con qué piensa pagar? (opcional; solo informativo, el cobro real se hace en Caja)
      const pagoPrevisto = String(datos['pago_previsto'] ?? '');
      if (agregarA === 0 && ['efectivo', 'tarjeta', 'transferencia'].includes(pagoPrevisto)) {
        await ejecutar('UPDATE ordenes SET pago_previsto = ? WHERE id = ? AND negocio_id = ?', [pagoPrevisto, orden.id, c.nid]);
      }
      if (espera && !agendado) {
        orden.estimado = espera.estimado;
        orden.delante = espera.delante;
      }
      ses.poner('pedidos_enviados', [...previos, { token, orden }].slice(-20));
      reply.code(201);
      return { ok: true, orden };
    },
  });

  // ------------------------------------------------------------------ /agotar
  /**
   * "Agotado" vale por HOY y SOLO en la sucursal que lo marca (otra sucursal puede seguir vendiéndolo).
   * Cualquier persona del personal con sesión puede hacerlo. Al día siguiente todo vuelve a estar habilitado.
   */
  app.post('/agotar', async (req) => {
    await requerirRol(req, ...ROLES_PERSONAL);
    const c = contexto(req);
    const d = cuerpoJson(req);
    const id = entero(d['producto_id']);
    const disponible = noVacio(d['disponible']);

    // Si es un producto propio de otra sucursal, o no existe, se responde "ya no existe".
    const p = await fila('SELECT nombre, sucursal_id FROM productos WHERE id = ? AND negocio_id = ?', [id, c.nid]);
    if (!p || (p['sucursal_id'] !== null && Number(p['sucursal_id']) !== c.sid)) throw new ErrorHttp(404, 'validacion', 'Ese producto ya no existe.');
    await ejecutar(
      `INSERT INTO producto_sucursal (producto_id, sucursal_id, negocio_id, agotado_fecha) VALUES (?, ?, ?, ${disponible ? 'NULL' : 'CURDATE()'})
       ON DUPLICATE KEY UPDATE agotado_fecha = VALUES(agotado_fecha)`,
      [id, c.sid, c.nid],
    );
    return { ok: true, producto_id: id, nombre: p['nombre'], disponible };
  });

  // ------------------------------------------------------------------ /estado
  app.get('/estado', async (req) => {
    const nid = req.negocio.id;
    const prods = await fila('SELECT COUNT(*) AS n FROM productos WHERE negocio_id = ?', [nid]);
    const ords = await fila('SELECT COUNT(*) AS n FROM ordenes WHERE negocio_id = ?', [nid]);
    const v = await fila('SELECT VERSION() AS v');
    return { ok: true, negocio: req.negocio.nombre, node: process.version, mysql: v?.['v'], productos: Number(prods?.['n']), ordenes: Number(ords?.['n']) };
  });
}
