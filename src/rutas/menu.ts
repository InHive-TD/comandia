/**
 * Rutas de consulta que usan las pantallas de pedidos (personal) y del cliente (QR):
 *
 *   GET /productos → el menú agrupado por categoría de la SUCURSAL actual.
 *   GET /mesas     → las mesas activas de la sucursal del personal (para elegir mesa al levantar un pedido).
 *
 * El menú de una sucursal = carta general + productos propios de esa sucursal, menos lo que ocultó, con su
 * precio propio si lo cambió. "Agotado" vale solo por el día: al día siguiente todo vuelve a estar disponible
 * (agotado_fecha deja de ser hoy). Los agotados van al final de su categoría, atenuados y sin poder pedirse.
 */
import type { FastifyInstance } from 'fastify';
import { exigirMetodo, fijarSucursalAuto, requerirRol } from '../auth.js';
import { CARTA_AGOTADO, CARTA_PRECIO, cartaUnir, cartaVisible } from '../carta.js';
import { filas } from '../db.js';
import { codigoRapidoEn } from './admin/prioridades.js';

export async function rutasMenu(app: FastifyInstance): Promise<void> {
  app.get('/productos', async (req) => {
    const nid = req.negocio.id;
    // Personal con sesión: su sucursal. Cliente por QR: la sucursal del enlace (?s=) o la primera.
    await fijarSucursalAuto(req);
    const suc = req.sucursalId;

    const prods = await filas(
      `SELECT c.id AS categoria_id, c.nombre AS categoria, p.id, p.nombre, p.descripcion, ${CARTA_PRECIO} AS precio, p.foto, p.codigo,
              p.max_carnes, p.pedir_opciones, p.porcion, ${CARTA_AGOTADO} AS agotado
         FROM productos p
         JOIN categorias c ON c.id = p.categoria_id${cartaUnir(suc)}
        WHERE p.negocio_id = ? AND c.negocio_id = p.negocio_id AND p.disponible = 1${cartaVisible(suc)}
        ORDER BY c.orden, c.id, ${CARTA_AGOTADO}, p.orden, p.nombre`,
      [nid],
    );

    // Extras activos de cada producto: producto_id → [{id, nombre, precio, codigo, grupo}]
    const extras = new Map<number, unknown[]>();
    const filasExtras = await filas(
      `SELECT pe.producto_id, e.id, e.nombre, COALESCE(pe.precio, e.precio) AS precio, e.codigo, e.grupo
         FROM producto_extras pe
         JOIN extras e ON e.id = pe.extra_id
         JOIN productos pr ON pr.id = pe.producto_id
        WHERE e.activo = 1 AND e.negocio_id = ? AND pr.negocio_id = e.negocio_id
        ORDER BY e.orden, e.id`,
      [nid],
    );
    for (const x of filasExtras) {
      const k = Number(x['producto_id']);
      extras.set(k, [...(extras.get(k) ?? []), { id: Number(x['id']), nombre: x['nombre'], precio: Number(x['precio']), codigo: x['codigo'], grupo: x['grupo'] }]);
    }

    // Agrupar por categoría conservando el orden: [{ categoria, productos: [...] }, ...]
    const menu = new Map<number, { categoria: unknown; productos: unknown[] }>();
    for (const f of prods) {
      const cid = Number(f['categoria_id']);
      const grupo: { categoria: unknown; productos: unknown[] } = menu.get(cid) ?? { categoria: f['categoria'], productos: [] };
      grupo.productos.push({
        id: Number(f['id']),
        nombre: f['nombre'],
        descripcion: f['descripcion'],
        precio: Number(f['precio']),
        foto: f['foto'] ? `uploads/${String(f['foto'])}` : null,
        codigo: f['codigo'],
        porcion: f['porcion'],
        pedir_opciones: Boolean(Number(f['pedir_opciones'])),
        max_carnes: f['max_carnes'] === null ? null : Number(f['max_carnes']),
        agotado: Boolean(Number(f['agotado'] ?? 0)),
        extras: extras.get(Number(f['id'])) ?? [],
      });
      menu.set(cid, grupo);
    }
    // Interruptor del dueño: ¿se muestra el código rápido en Tomar pedidos? (por defecto sí)
    return { ok: true, menu: [...menu.values()], codigo_rapido: await codigoRapidoEn(nid, suc) };
  });

  app.get('/mesas', async (req) => {
    exigirMetodo(req, 'GET');
    await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
    const r = await filas('SELECT id, nombre FROM mesas WHERE sucursal_id = ? AND negocio_id = ? AND activa = 1 ORDER BY orden, id', [req.sucursalId, req.negocio.id]);
    return { ok: true, mesas: r.map((m) => ({ id: Number(m['id']), nombre: m['nombre'] })) };
  });
}
