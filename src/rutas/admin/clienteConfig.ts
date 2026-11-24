/**
 * Configuración de la pantalla del cliente que se decide por empresa y por sucursal:
 * tipos de pedido (comer aquí / para llevar / recoger), elegir plato por plato y datos de pago por transferencia.
 *
 *   GET  /admin/cliente-config → { puede_general, general: Nivel, sucursales: [{ id, nombre, propio: Nivel, efectivo: Config }] }
 *   POST { accion: 'tipos', ambito: 'general'|'sucursal', sucursal_id?, modalidades: [...], mixto }
 *   POST { accion: 'pago',  ambito, sucursal_id?, clabe, beneficiario, institucion }
 *   POST { accion: 'transferencia', ambito, sucursal_id?, activo }   acepta o no pago por transferencia (si la empresa la apaga, el gerente no puede encenderla)
 *   POST { accion: 'pago_quitar', ambito, sucursal_id? }        borra lo propio (la sucursal vuelve a usar el de la empresa)
 *
 * El dueño cambia la empresa y cualquier sucursal; el gerente solo la suya (si manda otro id se ignora).
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, filas } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { TIPOS_PEDIDO, cargarAjustesCliente, configEfectiva, nivelCliente } from '../../clienteConfig.js';
import { entero, largo, noVacio } from '../../util.js';

export async function rutasClienteConfig(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/cliente-config',
    handler: async (req) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      const estado = async () => {
        const a = await cargarAjustesCliente(nid);
        const sucs = await filas(`SELECT id, slug, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
        return {
          ok: true,
          puede_general: alcance === null,
          general: nivelCliente(a, null),
          sucursales: sucs.map((s) => ({ id: Number(s['id']), slug: s['slug'], nombre: s['nombre'], propio: nivelCliente(a, Number(s['id'])), efectivo: configEfectiva(a, Number(s['id'])) })),
        };
      };

      if (req.method === 'GET') return estado();
      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);

      /** Sufijo de la clave: '' = empresa (solo dueño), '@id' = sucursal. */
      const sufijo = async (): Promise<string> => {
        if (String(d['ambito'] ?? '') === 'general') {
          if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
          return '';
        }
        const sid = alcance ?? entero(d['sucursal_id']);
        const s = await filas('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [sid, nid]);
        if (s.length === 0) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        return `@${sid}`;
      };
      const guardar = (clave: string, valor: string) =>
        ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, clave, valor]);

      switch (String(d['accion'] ?? '')) {
        case 'tipos': {
          const suf = await sufijo();
          const pedidas = Array.isArray(d['modalidades']) ? d['modalidades'] : [];
          const mods = TIPOS_PEDIDO.filter((t) => pedidas.includes(t));
          if (mods.length === 0) throw fallo('Deja al menos un tipo de pedido activo.');
          await guardar(`cliente_modalidades${suf}`, JSON.stringify(mods));
          await guardar(`cliente_mixto${suf}`, noVacio(d['mixto']) ? '1' : '0');
          return estado();
        }
        case 'pago': {
          const suf = await sufijo();
          const clabe = String(d['clabe'] ?? '').replace(/\D+/g, '');
          if (!/^\d{18}$/.test(clabe)) throw fallo('La CLABE interbancaria debe tener 18 dígitos.');
          const beneficiario = String(d['beneficiario'] ?? '').trim();
          const institucion = String(d['institucion'] ?? '').trim();
          if (largo(beneficiario) > 80 || largo(institucion) > 80) throw fallo('El beneficiario y la institución no pueden pasar de 80 caracteres.');
          await guardar(`cliente_pago${suf}`, JSON.stringify({ clabe, beneficiario, institucion }));
          return estado();
        }
        case 'transferencia': {
          const suf = await sufijo();
          const activo = noVacio(d['activo']);
          if (activo && alcance !== null && !(nivelCliente(await cargarAjustesCliente(nid), null).transferencia ?? true)) {
            throw fallo('El dueño desactivó el pago por transferencia en toda la empresa. Pídele que lo active para poder activarlo aquí.', 403);
          }
          await guardar(`cliente_transferencia${suf}`, activo ? '1' : '0');
          return estado();
        }
        case 'pago_quitar': {
          const suf = await sufijo();
          await ejecutar('DELETE FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, `cliente_pago${suf}`]);
          return estado();
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
