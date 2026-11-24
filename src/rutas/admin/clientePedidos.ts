/**
 * Interruptores de "el cliente puede levantar su propio pedido desde el QR" (o solo ver el menú).
 *
 *   GET  /admin/cliente-pedidos → { general, puede_general, sucursales: [{ id, nombre, activo, efectivo, ver_pedido, ver_pagar, ver_menu }] }
 *   POST { accion: 'general',  activo: true|false }                  solo el dueño: interruptor de TODA la empresa
 *   POST { accion: 'sucursal', sucursal_id, activo: true|false }     el dueño (cualquier sucursal) o el gerente (solo la suya)
 *   POST { accion: 'pestanas', sucursal_id, ver_menu, ver_pedido, ver_pagar }  muestra u oculta las pestañas "Menú", "Mi pedido" y "Pagar" del cliente (al menos una debe quedar visible)
 *
 * Reglas: si el dueño lo apaga para toda la empresa, el gerente ya no puede encenderlo en su sucursal.
 * El gerente siempre trabaja sobre su sucursal, aunque mande otro sucursal_id.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { efectivo, estadoPedidosCliente, pestanasCliente, pestanasDe } from '../../pedidosClientes.js';
import { entero, noVacio } from '../../util.js';

const guardar = (nid: number, clave: string, activo: boolean) =>
  ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, clave, activo ? '1' : '0']);

export async function rutasClientePedidos(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/cliente-pedidos',
    handler: async (req) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      /** Estado actual (el gerente solo ve su sucursal). */
      const estado = async () => {
        const e = await estadoPedidosCliente(nid);
        const pest = await pestanasCliente(nid);
        const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
        return {
          ok: true,
          general: e.general,
          puede_general: alcance === null,
          sucursales: sucs.map((s) => ({ id: Number(s['id']), nombre: s['nombre'], activo: e.porSucursal.get(Number(s['id'])) ?? true, efectivo: efectivo(e, Number(s['id'])),
            ver_pedido: pestanasDe(pest, Number(s['id'])).verPedido, ver_pagar: pestanasDe(pest, Number(s['id'])).verPagar, ver_menu: pestanasDe(pest, Number(s['id'])).verMenu,
          })),
        };
      };

      if (req.method === 'GET') return estado();
      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);
      const activo = noVacio(d['activo']);

      switch (String(d['accion'] ?? '')) {
        case 'general':
          if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
          await guardar(nid, 'cliente_pedidos', activo);
          return estado();
        case 'sucursal': {
          const sid = alcance ?? entero(d['sucursal_id']);
          const s = await filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, nid]);
          if (s.length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          if (activo && alcance !== null && !(await estadoPedidosCliente(nid)).general) {
            throw fallo('El dueño desactivó los pedidos de clientes en toda la empresa. Pídele que los active para poder activarlos aquí.', 403);
          }
          await guardar(nid, `cliente_pedidos@${sid}`, activo);
          return estado();
        }
        case 'pestanas': {
          const sid = alcance ?? entero(d['sucursal_id']);
          const s = await filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, nid]);
          if (s.length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
          const vm = d['ver_menu'] === undefined ? true : noVacio(d['ver_menu']);
          if (!vm && !noVacio(d['ver_pedido']) && !noVacio(d['ver_pagar'])) throw fallo('Deja al menos una pestaña visible para el cliente (Menú, Mi pedido o Pagar).');
          await guardar(nid, `cliente_ver_menu@${sid}`, vm);
          await guardar(nid, `cliente_ver_pedido@${sid}`, noVacio(d['ver_pedido']));
          await guardar(nid, `cliente_ver_pagar@${sid}`, noVacio(d['ver_pagar']));
          return estado();
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
