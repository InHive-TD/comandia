/**
 * Recetas (inventario nivel completo; requiere inventario_activo + inventario_recetas y es solo del administrador).
 * Jerarquía: insumo (con su unidad y costo) → receta del platillo / del modificador → descuento al vender.
 *
 *   GET  /admin/recetas  → { insumos, platillos: [{ id, nombre, categoria, precio, lineas }], extras: [{ id, nombre, grupo, lineas }] }
 *   POST { accion: 'receta_platillo', producto_id, lineas: [{ insumo_id, cantidad }] }          (reemplaza la receta completa)
 *   POST { accion: 'receta_extra', extra_id, lineas: [{ insumo_id, cantidad, modo: 'suma' | 'resta' }] }
 *
 * Las cantidades van SIEMPRE en la unidad del insumo (la pantalla convierte g↔kg, ml↔L). Un modificador «suma»
 * insumos (con queso) o «resta» (sin cebolla: lo que la receta del platillo llevaba y ya no se gasta).
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { fila, filas, transaccion } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { entero } from '../../util.js';

interface Linea { insumo: number; cantidad: number; modo: 'suma' | 'resta' }

export async function rutasAdminRecetas(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/recetas',
    handler: async (req) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      if (yo.alcance !== null) throw new ErrorHttp(403, 'sin_permiso', 'Las recetas las edita el administrador de la empresa.');
      const aj = async (clave: string) => String((await fila('SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, clave]))?.['valor'] ?? '');
      if ((await aj('inventario_activo')) !== '1' || (await aj('inventario_recetas')) !== '1') {
        throw new ErrorHttp(403, 'modulo_apagado', 'Las recetas no están activadas para esta empresa.');
      }

      if (req.method === 'GET') {
        const insumos = await filas('SELECT id, nombre, categoria, unidad, costo FROM inv_insumos WHERE negocio_id = ? AND activo = 1 ORDER BY nombre', [nid]);
        const prods = await filas(
          `SELECT p.id, p.nombre, p.precio, c.id AS categoria_id, c.nombre AS categoria
             FROM productos p JOIN categorias c ON c.id = p.categoria_id
            WHERE p.negocio_id = ? ORDER BY c.orden, c.id, p.orden, p.nombre`, [nid]);
        const rp = new Map<number, { insumo_id: number; cantidad: number }[]>();
        for (const r of await filas('SELECT r.producto_id, r.insumo_id, r.cantidad FROM inv_recetas r JOIN productos p ON p.id = r.producto_id WHERE p.negocio_id = ?', [nid])) {
          const k = Number(r['producto_id']);
          rp.set(k, [...(rp.get(k) ?? []), { insumo_id: Number(r['insumo_id']), cantidad: Number(r['cantidad']) }]);
        }
        const exs = await filas('SELECT id, nombre, grupo, sucursal_id FROM extras WHERE negocio_id = ? ORDER BY orden, id', [nid]);
        const re = new Map<number, { insumo_id: number; cantidad: number; modo: string }[]>();
        for (const r of await filas('SELECT r.extra_id, r.insumo_id, r.cantidad, r.modo FROM inv_receta_extras r JOIN extras e ON e.id = r.extra_id WHERE e.negocio_id = ?', [nid])) {
          const k = Number(r['extra_id']);
          re.set(k, [...(re.get(k) ?? []), { insumo_id: Number(r['insumo_id']), cantidad: Number(r['cantidad']), modo: String(r['modo']) }]);
        }
        return {
          ok: true,
          insumos: insumos.map((i) => ({ id: Number(i['id']), nombre: i['nombre'], categoria: i['categoria'] ?? null, unidad: i['unidad'], costo: Number(i['costo']) })),
          platillos: prods.map((p) => ({ id: Number(p['id']), nombre: p['nombre'], precio: Number(p['precio']), categoria_id: Number(p['categoria_id']), categoria: p['categoria'], lineas: rp.get(Number(p['id'])) ?? [] })),
          extras: exs.map((x) => ({ id: Number(x['id']), nombre: x['nombre'], grupo: x['grupo'] ?? null, sucursal_id: x['sucursal_id'] === null ? null : Number(x['sucursal_id']), lineas: re.get(Number(x['id'])) ?? [] })),
        };
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);
      const accion = String(d['accion'] ?? '');
      const leerLineas = async (conModo: boolean): Promise<Linea[]> => {
        const crudas = Array.isArray(d['lineas']) ? (d['lineas'] as Record<string, unknown>[]).slice(0, 80) : [];
        const porInsumo = new Map<number, Linea>();
        for (const l of crudas) {
          const insumo = entero(l['insumo_id']);
          const cantidad = Number(String(l['cantidad'] ?? '').replace(',', '.'));
          if (insumo <= 0 || !Number.isFinite(cantidad) || cantidad <= 0 || cantidad > 9_999_999) throw fallo('Cada ingrediente necesita un insumo y una cantidad mayor a 0.');
          const modo = conModo && String(l['modo']) === 'resta' ? 'resta' : 'suma';
          const previo = porInsumo.get(insumo);
          if (previo && previo.modo === modo) previo.cantidad += cantidad;
          else if (!previo) porInsumo.set(insumo, { insumo, cantidad, modo });
          else throw fallo('Un mismo insumo no puede sumar y restar a la vez en el mismo modificador.');
        }
        for (const id of porInsumo.keys()) {
          if (!(await fila('SELECT id FROM inv_insumos WHERE id = ? AND negocio_id = ? AND activo = 1', [id, nid]))) throw new ErrorHttp(404, 'validacion', 'Uno de los insumos ya no existe.');
        }
        return [...porInsumo.values()].map((l) => ({ ...l, cantidad: Math.round(l.cantidad * 1000) / 1000 }));
      };

      if (accion === 'receta_platillo') {
        const id = entero(d['producto_id']);
        if (!(await fila('SELECT id FROM productos WHERE id = ? AND negocio_id = ?', [id, nid]))) throw new ErrorHttp(404, 'validacion', 'Ese platillo ya no existe.');
        const lineas = await leerLineas(false);
        await transaccion(async (tx) => {
          await tx.ejecutar('DELETE FROM inv_recetas WHERE producto_id = ?', [id]);
          for (const l of lineas) await tx.ejecutar('INSERT INTO inv_recetas (producto_id, insumo_id, cantidad) VALUES (?, ?, ?)', [id, l.insumo, l.cantidad]);
        });
        return { ok: true };
      }
      if (accion === 'receta_extra') {
        const id = entero(d['extra_id']);
        if (!(await fila('SELECT id FROM extras WHERE id = ? AND negocio_id = ?', [id, nid]))) throw new ErrorHttp(404, 'validacion', 'Ese modificador ya no existe.');
        const lineas = await leerLineas(true);
        await transaccion(async (tx) => {
          await tx.ejecutar('DELETE FROM inv_receta_extras WHERE extra_id = ?', [id]);
          for (const l of lineas) await tx.ejecutar('INSERT INTO inv_receta_extras (extra_id, insumo_id, modo, cantidad) VALUES (?, ?, ?, ?)', [id, l.insumo, l.modo, l.cantidad]);
        });
        return { ok: true };
      }
      throw fallo('Acción no válida.');
    },
  });
}
