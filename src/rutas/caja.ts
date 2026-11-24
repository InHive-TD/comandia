/**
 * Caja (roles caja, admin y gerente): cobrar pedidos, propinas y resumen del día.
 *
 *   GET  /caja?fecha=AAAA-MM-DD (opcional, por defecto hoy)
 *        → pedidos del día con su saldo, sus pagos y un resumen (ventas, propinas, por método).
 *   POST /caja { accion: 'cobrar', orden_id, metodo, monto?, propina? }
 *        /caja { accion: 'anular', pago_id }
 *
 * Cobrar es independiente de entregar: se puede pagar antes de que esté listo o entregar sin haber cobrado todavía.
 * La propina se guarda aparte de la venta. Con tarjeta se suma una comisión al cliente ($3 + 3.7 % del monto).
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../auth.js';
import { fallo } from '../errores.js';
import { actualizarPagado, contexto, enTransaccion, montoPagado, redondear, textoTurno } from '../ordenes.js';

const METODOS = ['efectivo', 'tarjeta', 'transferencia'] as const;
const COMISION_TARJETA_FIJA = 3.0; // pesos
const COMISION_TARJETA_PCT = 3.7; // por ciento del monto

/** Comisión que se le suma al cliente al pagar con tarjeta: $3 + 3.7 % del monto, redondeada al peso. */
const comisionTarjeta = (monto: number): number => Math.round((monto * COMISION_TARJETA_PCT) / 100 + COMISION_TARJETA_FIJA);

/** Lee un importe de dinero: vacío = 0; debe ser número entre 0 y `max`. */
function dineroValido(v: unknown, nombre: string, max: number): number {
  if (v === null || v === undefined || v === '') return 0;
  const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(num)) throw fallo(`El campo "${nombre}" debe ser un número.`);
  const r = redondear(num);
  if (r < 0 || r > max) throw fallo(`El campo "${nombre}" no es válido.`);
  return r;
}

/** ¿Es una fecha real "AAAA-MM-DD"? */
function fechaValida(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

interface Pago {
  id: number;
  monto: number;
  propina: number;
  comision: number;
  metodo: string;
  anulado: boolean;
  hora: string;
  cobro: unknown;
}

export async function rutasCaja(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/caja',
    handler: async (req) => {
      const usuario = await requerirRol(req, 'caja', 'admin', 'gerente');
      const c = contexto(req);

      // ------------------------------------------------------------ GET
      if (req.method === 'GET') {
        let fecha = String((req.query as Record<string, unknown>)['fecha'] ?? '');
        if (fecha === '') fecha = String((await c.filas('SELECT CURDATE() AS f'))[0]?.['f']);
        else if (!fechaValida(fecha)) throw fallo('La fecha no es válida.');

        const ordenes = await c.filas(
          `SELECT id, fecha_turno, turno, nombre_cliente, estado, total, modalidad, mesa, mesa_zona, origen, creado_en, telefono, pago_previsto
             FROM ordenes WHERE negocio_id = ? AND sucursal_id = ? AND fecha_turno = ? ORDER BY turno DESC LIMIT 500`,
          [c.nid, c.sid, fecha],
        );

        const pagosPorOrden = new Map<number, Pago[]>();
        const itemsPorOrden = new Map<number, { cantidad: number; nombre: unknown }[]>();
        const cambiosPorOrden = new Map<number, { detalle: unknown; hora: unknown; tras_entrega: boolean }[]>();
        if (ordenes.length > 0) {
          const ids = ordenes.map((o) => Number(o['id']));
          const marcas = ids.map(() => '?').join(',');
          const pagos = await c.filas(
            `SELECT p.id, p.orden_id, p.monto, p.propina, p.comision, p.metodo, p.anulado, DATE_FORMAT(p.creado_en, '%H:%i') AS hora, u.nombre AS cobro
               FROM pagos p LEFT JOIN usuarios u ON u.id = p.creado_por
              WHERE p.negocio_id = ? AND p.orden_id IN (${marcas}) ORDER BY p.id`,
            [c.nid, ...ids],
          );
          for (const p of pagos) {
            const k = Number(p['orden_id']);
            pagosPorOrden.set(k, [
              ...(pagosPorOrden.get(k) ?? []),
              { id: Number(p['id']), monto: Number(p['monto']), propina: Number(p['propina']), comision: Number(p['comision']), metodo: String(p['metodo']), anulado: Boolean(Number(p['anulado'])), hora: String(p['hora']), cobro: p['cobro'] },
            ]);
          }
          for (const i of await c.filas(`SELECT orden_id, cantidad, nombre_producto FROM orden_items WHERE orden_id IN (${marcas}) ORDER BY plato, id`, ids)) {
            const k = Number(i['orden_id']);
            itemsPorOrden.set(k, [...(itemsPorOrden.get(k) ?? []), { cantidad: Number(i['cantidad']), nombre: i['nombre_producto'] }]);
          }
          for (const x of await c.filas(`SELECT orden_id, detalle, despues_de_entrega, DATE_FORMAT(creado_en, '%H:%i') AS hora FROM orden_cambios WHERE orden_id IN (${marcas}) ORDER BY id`, ids)) {
            const k = Number(x['orden_id']);
            cambiosPorOrden.set(k, [...(cambiosPorOrden.get(k) ?? []), { detalle: x['detalle'], hora: x['hora'], tras_entrega: Boolean(Number(x['despues_de_entrega'])) }]);
          }
        }

        const porMetodo: Record<string, { monto: number; propina: number; comision: number; n: number }> = {};
        for (const m of METODOS) porMetodo[m] = { monto: 0, propina: 0, comision: 0, n: 0 };
        const resumen = { cobrado: 0, propinas: 0, por_cobrar: 0, n_por_cobrar: 0, entregadas_sin_pagar: 0, por_metodo: porMetodo };

        const salida = ordenes.map((o) => {
          const id = Number(o['id']);
          const pagos = pagosPorOrden.get(id) ?? [];
          const vigentes = pagos.filter((p) => !p.anulado);
          const pagadoMonto = redondear(vigentes.reduce((s, p) => s + p.monto, 0));
          const propina = redondear(vigentes.reduce((s, p) => s + p.propina, 0));
          const total = Number(o['total']);
          const cancelada = o['estado'] === 'cancelada';
          const saldo = cancelada ? 0 : redondear(total - pagadoMonto); // negativo = pagó de más
          const devolver = cancelada ? pagadoMonto : Math.max(0, -saldo);

          for (const p of vigentes) {
            resumen.cobrado += p.monto;
            resumen.propinas += p.propina;
            const pm = porMetodo[p.metodo];
            if (pm) {
              pm.monto += p.monto;
              pm.propina += p.propina;
              pm.comision += p.comision;
              pm.n++;
            }
          }
          if (!cancelada && saldo > 0.004 && total > 0) {
            resumen.por_cobrar += saldo;
            resumen.n_por_cobrar++;
            if (o['estado'] === 'entregada') resumen.entregadas_sin_pagar++;
          }
          return {
            id, turno: textoTurno(String(o['fecha_turno']), o['turno'] === null ? null : Number(o['turno'])), cliente: o['nombre_cliente'], estado: o['estado'],
            modalidad: o['modalidad'], mesa: o['mesa'], mesa_zona: o['mesa_zona'], pago_previsto: o['pago_previsto'], telefono: o['modalidad'] === 'recoger' ? o['telefono'] : null, origen: o['origen'],
            hora: String(o['creado_en']).slice(11, 16), total, pagado: pagadoMonto, propina, saldo, devolver: redondear(devolver),
            items: itemsPorOrden.get(id) ?? [], cambios: cambiosPorOrden.get(id) ?? [], // nota de "pedido modificado" (qué se cambió)
            pagos,
          };
        });
        resumen.cobrado = redondear(resumen.cobrado);
        resumen.propinas = redondear(resumen.propinas);
        resumen.por_cobrar = redondear(resumen.por_cobrar);
        return { ok: true, fecha, ordenes: salida, resumen };
      }

      // ------------------------------------------------------------ POST
      exigirMetodo(req, 'POST');
      const datos = cuerpoJson(req);

      switch (String(datos['accion'] ?? '')) {
        case 'cobrar': {
          const ordenId = Number(datos['orden_id'] ?? 0) || 0;
          const metodo = String(datos['metodo'] ?? '');
          if (!(METODOS as readonly string[]).includes(metodo)) throw fallo('Elige cómo pagó: efectivo, tarjeta o transferencia.');
          const propina = dineroValido(datos['propina'] ?? 0, 'propina', 100000);

          return enTransaccion(c, async (t) => {
            const o = (await t.filas('SELECT estado, total, sucursal_id FROM ordenes WHERE id = ? AND negocio_id = ? FOR UPDATE', [ordenId, t.nid]))[0];
            if (!o) throw fallo('Ese pedido ya no existe.', 404);
            if (o['estado'] === 'cancelada') throw fallo('Ese pedido está cancelado: no se puede cobrar.', 409);
            const saldo = redondear(Number(o['total']) - (await montoPagado(t, ordenId)));
            if (saldo <= 0.004) throw fallo('Ese pedido ya está pagado. Recarga la pantalla.', 409);
            // Sin "monto" se cobra todo lo que falta; con "monto" se cobra una parte (cuenta dividida).
            const monto = datos['monto'] !== undefined && datos['monto'] !== null && datos['monto'] !== '' ? dineroValido(datos['monto'], 'monto', 100000) : saldo;
            if (monto <= 0 || monto > saldo + 0.004) {
              throw fallo(`El monto debe ser mayor a cero y no pasar de lo que falta por pagar (${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).`);
            }
            const comision = metodo === 'tarjeta' ? comisionTarjeta(monto) : 0;
            await t.ejecutar(
              'INSERT INTO pagos (negocio_id, sucursal_id, orden_id, monto, propina, comision, metodo, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [t.nid, Number(o['sucursal_id']), ordenId, monto.toFixed(2), propina.toFixed(2), comision.toFixed(2), metodo, usuario.id],
            );
            const pagado = await actualizarPagado(t, ordenId);
            return { ok: true, pagado, saldo: redondear(saldo - monto), comision };
          });
        }

        case 'anular': {
          const pagoId = Number(datos['pago_id'] ?? 0) || 0;
          return enTransaccion(c, async (t) => {
            const p = (await t.filas('SELECT orden_id, anulado FROM pagos WHERE id = ? AND negocio_id = ? FOR UPDATE', [pagoId, t.nid]))[0];
            if (!p) throw fallo('Ese pago ya no existe.', 404);
            if (Number(p['anulado']) === 0) await t.ejecutar('UPDATE pagos SET anulado = 1, anulado_en = NOW() WHERE id = ? AND negocio_id = ?', [pagoId, t.nid]);
            await actualizarPagado(t, Number(p['orden_id']));
            return { ok: true };
          });
        }

        default:
          throw fallo('Acción desconocida.');
      }
    },
  });
}
