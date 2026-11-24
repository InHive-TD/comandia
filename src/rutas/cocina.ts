/**
 * Tablero de cocina (roles taquero, caja, admin, mesero y gerente).
 *
 *   GET  /cocina?estacion=ID  → pedidos activos ya ordenados por prioridad para esa parrilla (estacion=0: vista general).
 *   POST /cocina { accion, ... } → acciones sobre renglones y pedidos:
 *        item (estado de un renglón) · todo_listo · mover_listas · regresar_cocina · cantidad · quitar_item · mesa ·
 *        modalidad · programar · reabrir_entregada · cancelar · cerrar · entregar · reabrir
 *
 * Prioridad: cada renglón recibe un "puntaje" = minutos que lleva esperando + un bono según el nivel configurado
 * para ese producto en esa parrilla (Normal 0 · Alta +10 · Urgente +20) + el bono de la modalidad del pedido.
 * Así lo urgente pasa adelante, pero nada se queda esperando para siempre.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../auth.js';
import { fallo } from '../errores.js';
import {
  ESTADOS_ACTIVOS, actualizarEstadoOrden, activarAgendados, bonosModalidad, calcularHoraPrometida, cambiarCantidad, cancelarOrden, categoriasLote, cerrarOrden, productosLote,
  colaActiva, contexto, enTransaccion, hacerPrioritaria, leerMesa, leerModalidad, minutosPreparacion, quitarRenglon, reabrirEntregada, registrarEntrega, textoTurno,
} from '../ordenes.js';
import { entero } from '../util.js';
import { carrilesEn, cocinaHorizontalEn } from './admin/prioridades.js';

const BONO_MINUTOS = [0, 10, 20]; // por nivel de prioridad
const ESTADOS_ITEM = ['pendiente', 'preparando', 'listo'];

interface ItemCocina {
  id: number;
  cantidad: number;
  nombre: unknown;
  codigo: unknown;
  notas: unknown;
  estado: string;
  plato: number;
  llevar: boolean;
  categoria: unknown;
  producto_id: number | null;
  estacion_id: number | null;
  nivel: number;
  extras: { nombre: unknown; codigo: unknown }[];
  mio?: boolean;
}

export async function rutasCocina(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/cocina',
    handler: async (req) => {
      await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
      const c = contexto(req);

      // ------------------------------------------------------------ GET
      if (req.method === 'GET') {
        const q = req.query as Record<string, unknown>;
        const estacionId = entero(q['estacion']);

        const estaciones = (await c.filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [c.nid])).map((e) => ({ id: Number(e['id']), nombre: e['nombre'] }));

        await activarAgendados(c);
        const prep = await minutosPreparacion(c);
        // La espera de un pedido programado cuenta desde que la cocina debía empezarlo (hora − tiempo de preparación):
        // si lo piden para dentro de 5 min y la cocina necesita 15, ya va "10 min atrasado" y sube en la fila.
        const ordenes = await c.filas(
          `SELECT id, fecha_turno, turno, nombre_cliente, estado, notas, total, pagado, origen, modalidad, mesa, revision, prioritario,
                  UNIX_TIMESTAMP(COALESCE(editado_en, creado_en)) AS prio_ts,
                  DATE_FORMAT(editado_en, '%H:%i') AS editado,
                  TIMESTAMPDIFF(SECOND, LEAST(COALESCE(activada_en, creado_en), COALESCE(hora_prometida - INTERVAL ${prep} MINUTE, creado_en)), NOW()) AS espera,
                  DATE_FORMAT(creado_en, '%H:%i') AS hora,
                  UNIX_TIMESTAMP(LEAST(COALESCE(activada_en, creado_en), COALESCE(hora_prometida - INTERVAL ${prep} MINUTE, creado_en))) AS orden_ts,
                  DATE_FORMAT(hora_prometida, '%H:%i') AS para,
                  TIMESTAMPDIFF(SECOND, NOW(), hora_prometida) AS faltan,
                  TIMESTAMPDIFF(SECOND, NOW(), hora_prometida - INTERVAL ${prep} MINUTE) AS activa_en,
                  activada_en
             FROM ordenes
            WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado IN ('nueva','preparando','lista')
              AND creado_en >= NOW() - INTERVAL 1 DAY
            ORDER BY creado_en
            LIMIT 120`,
        );

        const itemsPorOrden = new Map<number, ItemCocina[]>();
        if (ordenes.length > 0) {
          const ids = ordenes.map((o) => Number(o['id']));
          const items = await c.filas(
            `SELECT i.id, i.orden_id, i.cantidad, i.nombre_producto, i.codigo, i.notas, i.estado, i.estacion_id, i.plato, i.llevar, i.categoria, i.producto_id,
                    COALESCE(pr.nivel, 0) AS nivel
               FROM orden_items i
               LEFT JOIN prioridades pr ON pr.producto_id = i.producto_id AND pr.estacion_id = ?
              WHERE i.orden_id IN (${ids.map(() => '?').join(',')})
              ORDER BY i.plato, i.id`,
            [estacionId, ...ids],
          );
          const extrasPorItem = new Map<number, { nombre: unknown; codigo: unknown }[]>();
          if (items.length > 0) {
            const iids = items.map((i) => Number(i['id']));
            const xs = await c.filas(`SELECT item_id, nombre, codigo FROM orden_item_extras WHERE item_id IN (${iids.map(() => '?').join(',')}) ORDER BY id`, iids);
            for (const x of xs) {
              const k = Number(x['item_id']);
              extrasPorItem.set(k, [...(extrasPorItem.get(k) ?? []), { nombre: x['nombre'], codigo: x['codigo'] }]);
            }
          }
          for (const i of items) {
            const k = Number(i['orden_id']);
            const it: ItemCocina = {
              id: Number(i['id']), cantidad: Number(i['cantidad']), nombre: i['nombre_producto'], codigo: i['codigo'], notas: i['notas'], estado: String(i['estado']),
              plato: Number(i['plato']), llevar: Boolean(Number(i['llevar'])), categoria: i['categoria'], producto_id: i['producto_id'] === null ? null : Number(i['producto_id']),
              estacion_id: i['estacion_id'] === null ? null : Number(i['estacion_id']), nivel: Math.min(2, Number(i['nivel'])), extras: extrasPorItem.get(Number(i['id'])) ?? [],
            };
            itemsPorOrden.set(k, [...(itemsPorOrden.get(k) ?? []), it]);
          }
        }

        const bonoModalidad = await bonosModalidad(c);
        type FilaCocina = Record<string, unknown> & { id: number; prioritario: boolean; modalidad: string; prio_ts: number; orden_ts: number; faltan: number | null; items: ItemCocina[] };
        const activas: FilaCocina[] = [];
        const listas: FilaCocina[] = [];
        const programadas: FilaCocina[] = [];
        for (const o of ordenes) {
          const espera = Math.max(0, Number(o['espera']));
          const items = itemsPorOrden.get(Number(o['id'])) ?? [];

          // ¿Qué renglones son de ESTA parrilla? (los que no tienen parrilla, de cualquiera)
          let puntaje: number | null = null;
          for (const it of items) {
            it.mio = estacionId === 0 || it.estacion_id === null || it.estacion_id === estacionId;
            if (it.mio && it.estado !== 'listo') {
              const p = espera / 60 + (BONO_MINUTOS[it.nivel] ?? 0) + (bonoModalidad[String(o['modalidad'])] ?? 0);
              puntaje = puntaje === null ? p : Math.max(puntaje, p);
            }
          }

          const fila: FilaCocina = {
            id: Number(o['id']),
            turno: `${o['fecha_turno']}-${String(o['turno']).padStart(3, '0')}`,
            cliente: o['nombre_cliente'], estado: o['estado'], notas: o['notas'], hora: o['hora'], origen: o['origen'], modalidad: String(o['modalidad']), mesa: o['mesa'],
            total: Number(o['total']), pagado: Boolean(Number(o['pagado'])), revision: Number(o['revision']), editado: o['editado'], para: o['para'],
            faltan: o['faltan'] === null ? null : Number(o['faltan']), orden_ts: Number(o['orden_ts']), prioritario: Number(o['prioritario']) === 1, prio_ts: Number(o['prio_ts']),
            espera, puntaje: puntaje === null ? null : Math.round(puntaje * 10) / 10, items,
          };
          if (o['estado'] === 'lista') {
            listas.push(fila);
          } else if (o['estado'] === 'nueva' && o['para'] !== null && o['activada_en'] === null) {
            fila['activa_en'] = Math.max(60, Number(o['activa_en'])); // a más tardar entra a la fila en este tiempo
            programadas.push(fila);
          } else {
            activas.push(fila);
          }
        }

        // Orden de trabajo: 1) reabiertos primero; 2) "Comer aquí" por orden de llegada (el cliente está sentado esperando);
        // 3) "Para llevar" después, también por orden de llegada.
        activas.sort((a, b) => {
          if (a.prioritario !== b.prioritario) return a.prioritario ? -1 : 1;
          if (a.prioritario) return a.prio_ts - b.prio_ts || a.id - b.id;
          if ((a.modalidad === 'aqui') !== (b.modalidad === 'aqui')) return a.modalidad === 'aqui' ? -1 : 1;
          return a.orden_ts - b.orden_ts || a.id - b.id;
        });

        // Tiempo que FALTA para cada pedido: el primero descuenta su estimado con el cronómetro; los demás, lo que falta al de adelante + su incremento.
        const cola = new Map((await colaActiva(c)).map((x) => [x.id, x]));
        for (const a of activas) {
          const q1 = cola.get(a.id);
          a['pos'] = q1?.pos ?? 0;
          a['restante'] = q1?.restante ?? null;
          a['estimado'] = q1 ? Math.max(0, Math.ceil(q1.restante / 60)) : null;
          a['urgente'] = q1 !== undefined && q1.restante <= 300; // faltan 5 min o menos / atrasado: sube arriba
        }
        // Lo urgente va hasta arriba (el más atrasado primero); el resto conserva el orden de trabajo.
        activas.sort((x, y) => {
          if (x['urgente'] !== y['urgente']) return x['urgente'] ? -1 : 1;
          return x['urgente'] ? Number(x['restante']) - Number(y['restante']) : 0;
        });

        // Cancelados hace poco (la cocina avisa para que no sigan preparándolos) y entregados sin pagar (para cobrar).
        const canceladas = (
          await c.filas(
            `SELECT id, fecha_turno, turno, nombre_cliente FROM ordenes
              WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado = 'cancelada' AND cancelado_en >= NOW() - INTERVAL 20 MINUTE ORDER BY cancelado_en DESC LIMIT 20`,
          )
        ).map((x) => ({ id: Number(x['id']), turno: textoTurno(String(x['fecha_turno']), x['turno'] === null ? null : Number(x['turno'])), cliente: x['nombre_cliente'] }));
        const porCobrar = (
          await c.filas(
            `SELECT id, fecha_turno, turno, nombre_cliente, total FROM ordenes
              WHERE negocio_id = ${c.nid} AND sucursal_id = ${c.sid} AND estado = 'entregada' AND pagado = 0 AND total > 0 AND fecha_turno = CURDATE() ORDER BY turno LIMIT 50`,
          )
        ).map((x) => ({ id: Number(x['id']), turno: textoTurno(String(x['fecha_turno']), x['turno'] === null ? null : Number(x['turno'])), cliente: x['nombre_cliente'], total: Number(x['total']) }));

        return {
          ok: true, estaciones, estacion: estacionId, canceladas, por_cobrar: porCobrar,
          ordenes: activas, listas: listas.reverse(),
          programadas: programadas.sort((a, b) => Number(a.faltan) - Number(b.faltan)),
          min_preparacion: prep,
          lote: (await categoriasLote(c)).filter((k) => k.activa).map((k) => k.nombre),
          lote_productos: await productosLote(c),   // platillos sueltos que también van al lote
          bonos: BONO_MINUTOS, bonos_modalidad: bonoModalidad,
          horizontal: await cocinaHorizontalEn(c.nid, c.sid),   // comandas en una fila con scroll lateral
          carriles: await carrilesEn(c.nid, c.sid),            // carriles configurables (por defecto: Comer aquí / Para llevar)
        };
      }

      // ------------------------------------------------------------ POST
      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);
      const accion = String(datos['accion'] ?? '');

      switch (accion) {
        case 'item': {
          const itemId = entero(datos['item_id']);
          const estado = String(datos['estado'] ?? '');
          const desde = datos['desde'] === undefined || datos['desde'] === null ? null : String(datos['desde']);
          if (!ESTADOS_ITEM.includes(estado) || (desde !== null && !ESTADOS_ITEM.includes(desde))) throw fallo('Estado no válido.');
          return enTransaccion(c, async (t) => {
            const f = (await t.filas('SELECT i.orden_id, o.estado AS orden_estado FROM orden_items i JOIN ordenes o ON o.id = i.orden_id WHERE i.id = ? AND o.negocio_id = ? FOR UPDATE', [itemId, t.nid]))[0];
            if (!f) throw fallo('Ese renglón ya no existe.', 404);
            if (!ESTADOS_ACTIVOS.includes(String(f['orden_estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
            // Si la otra tablet ya lo cambió (desde ≠ estado actual), no se pisa: se avisa.
            const r = await t.ejecutar(`UPDATE orden_items SET estado = ? WHERE id = ?${desde !== null ? ' AND estado = ?' : ''}`, desde !== null ? [estado, itemId, desde] : [estado, itemId]);
            const ordenEstado = await actualizarEstadoOrden(t, Number(f['orden_id']));
            return { ok: true, cambio: r.changedRows > 0, orden_estado: ordenEstado };
          });
        }

        case 'todo_listo': {
          const ordenId = entero(datos['orden_id']);
          const estacionId = entero(datos['estacion_id']);
          return enTransaccion(c, async (t) => {
            const o = (await t.filas('SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!o) throw fallo('Ese pedido ya no existe.', 404);
            if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
            const r = await t.ejecutar(
              `UPDATE orden_items SET estado = 'listo' WHERE orden_id = ? AND estado <> 'listo' AND (? = 0 OR estacion_id = ? OR estacion_id IS NULL)`,
              [ordenId, estacionId, estacionId],
            );
            const ordenEstado = await actualizarEstadoOrden(t, ordenId);
            return { ok: true, marcados: r.changedRows, orden_estado: ordenEstado };
          });
        }

        case 'mover_listas': {
          // Cocina confirma que el pedido (todo listo) pasa a "listas para entregar".
          const ordenId = entero(datos['orden_id']);
          return enTransaccion(c, async (t) => {
            const o = (await t.filas('SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!o) throw fallo('Ese pedido ya no existe.', 404);
            if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
            const faltan = (await t.filas("SELECT COUNT(*) AS n FROM orden_items WHERE orden_id = ? AND estado <> 'listo'", [ordenId]))[0];
            if (Number(faltan?.['n']) > 0) throw fallo('Todavía faltan renglones por marcar como listos.', 409);
            await t.ejecutar("UPDATE ordenes SET estado = 'lista' WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
            return { ok: true, orden_estado: 'lista' };
          });
        }

        case 'regresar_cocina':
          // Deshacer "Mover a listas para entregar": vuelve a cocina (con todos los renglones listos).
          await c.ejecutar("UPDATE ordenes SET estado = 'preparando' WHERE id = ? AND negocio_id = ? AND estado = 'lista'", [entero(datos['orden_id']), c.nid]);
          return { ok: true, orden_estado: 'preparando' };

        case 'cantidad':
          // Si SUBE y el renglón ya estaba preparándose/listo, lo agregado va como renglón nuevo pendiente.
          return { ok: true, ...(await cambiarCantidad(c, entero(datos['item_id']), entero(datos['cantidad']))) };

        case 'quitar_item':
          // Caso extraordinario: se acabó un producto y se quita del pedido.
          return { ok: true, ...(await quitarRenglon(c, entero(datos['item_id']))) };

        case 'mesa': {
          // Cambia (o quita) la mesa de un pedido que sigue en curso.
          const mesa = await leerMesa(c, datos['mesa_id']);
          await c.ejecutar(
            "UPDATE ordenes SET mesa_id = ?, mesa = ? WHERE id = ? AND negocio_id = ? AND sucursal_id = ? AND estado IN ('nueva','preparando','lista','entregada')",
            [mesa?.id ?? null, mesa?.nombre ?? null, entero(datos['orden_id']), c.nid, c.sid],
          );
          return { ok: true, mesa: mesa?.nombre ?? null };
        }

        case 'modalidad': {
          const mod = leerModalidad(datos['modalidad']);
          await c.ejecutar("UPDATE ordenes SET modalidad = ? WHERE id = ? AND negocio_id = ? AND estado IN ('nueva','preparando','lista')", [mod, entero(datos['orden_id']), c.nid]);
          return { ok: true, modalidad: mod };
        }

        case 'programar': {
          // Cambia (o quita) la hora a la que el cliente quiere su pedido.
          const hora = await calcularHoraPrometida(c, datos);
          await c.ejecutar("UPDATE ordenes SET hora_prometida = ?, activada_en = NULL WHERE id = ? AND negocio_id = ? AND estado IN ('nueva','preparando','lista')", [hora, entero(datos['orden_id']), c.nid]);
          return { ok: true, hora_prometida: hora };
        }

        case 'reabrir_entregada':
          // Ya se entregó y el cliente quiere agregar algo: se reabre con prioridad sobre todos.
          await reabrirEntregada(c, entero(datos['orden_id']));
          return { ok: true, orden_estado: 'lista' };

        case 'cancelar':
          await cancelarOrden(c, entero(datos['orden_id']));
          return { ok: true, orden_estado: 'cancelada' };

        case 'cerrar':
          // La cocina olvidó marcar: se da por entregado todo el pedido.
          await cerrarOrden(c, entero(datos['orden_id']));
          return { ok: true, orden_estado: 'entregada' };

        case 'entregar': {
          // El pedido ya se le dio al cliente (solo si está "lista" en cocina).
          const ordenId = entero(datos['orden_id']);
          await enTransaccion(c, async (t) => {
            const o = (await t.filas('SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!o) throw fallo('Ese pedido ya no existe.', 404);
            if (o['estado'] !== 'lista') throw fallo('El pedido todavía no está listo en cocina.', 409);
            await registrarEntrega(t, ordenId);
            await t.ejecutar("UPDATE ordenes SET estado = 'entregada', prioritario = 0 WHERE id = ? AND negocio_id = ?", [ordenId, t.nid]);
          });
          return { ok: true, orden_estado: 'entregada' };
        }

        case 'reabrir': {
          // Regresa TODO el pedido a "pendiente" (ej. el cliente quiere cambiar algo).
          const ordenId = entero(datos['orden_id']);
          return enTransaccion(c, async (t) => {
            const o = (await t.filas('SELECT estado FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!o) throw fallo('Ese pedido ya no existe.', 404);
            if (!ESTADOS_ACTIVOS.includes(String(o['estado']))) throw fallo('Ese pedido ya no está en cocina.', 409);
            await t.ejecutar("UPDATE orden_items SET estado = 'pendiente' WHERE orden_id = ?", [ordenId]);
            if (o['estado'] === 'lista') await hacerPrioritaria(t, ordenId); // estaba lista para entregar y la regresan a cocina: prioridad
            const ordenEstado = await actualizarEstadoOrden(t, ordenId);
            return { ok: true, orden_estado: ordenEstado };
          });
        }

        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
