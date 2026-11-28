/**
 * Administración de categorías del menú (Tacos, Bebidas, Postres...). Solo el dueño de la empresa.
 *
 *   POST (JSON) → { accion: 'crear' | 'renombrar' | 'ordenar' | 'grupos_orden' | 'eliminar', ... }
 *
 * La lista de categorías no se pide aquí: viene dentro de GET /admin/productos.
 * Todas las consultas filtran por negocio_id para que una empresa nunca toque datos de otra.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../../auth.js';
import { ejecutar, fila, transaccion } from '../../db.js';
import { fallo } from '../../errores.js';
import { enteros, entero, largo } from '../../util.js';

/** Valida el nombre de una categoría (obligatorio, máximo 60 caracteres). */
function leerNombre(v: unknown): string {
  const nombre = String(v ?? '').trim();
  if (nombre === '' || largo(nombre) > 60) throw fallo('El nombre de la categoría es obligatorio (máximo 60 caracteres).');
  return nombre;
}

export async function rutasCategorias(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/categorias',
    handler: async (req, reply) => {
      exigirMetodo(req, 'POST');
      await requerirRol(req, 'admin'); // el gerente no puede tocar las categorías de toda la empresa
      const nid = req.negocio.id;
      const d = cuerpoJson(req);
      const id = entero(d['id']);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const nombre = leerNombre(d['nombre']);
          // La categoría nueva se agrega al final: orden = el mayor actual + 1.
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM categorias WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT INTO categorias (negocio_id, nombre, orden) VALUES (?, ?, ?)', [nid, nombre, Number(sig?.['n'])]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'renombrar':
          await ejecutar('UPDATE categorias SET nombre = ? WHERE id = ? AND negocio_id = ?', [leerNombre(d['nombre']), id, nid]);
          return { ok: true };

        case 'ordenar': {
          // Llegan los ids en el orden en que deben aparecer; se guarda su posición (1, 2, 3...).
          const ids = enteros(d['ids']);
          if (ids.length === 0) throw fallo('No hay categorías que ordenar.');
          await transaccion(async (tx) => {
            for (const [i, cid] of ids.entries()) {
              await tx.ejecutar('UPDATE categorias SET orden = ? WHERE id = ? AND negocio_id = ?', [i + 1, cid, nid]);
            }
          });
          return { ok: true };
        }
        case 'grupos_orden': {
          // Orden de los tipos de modificador para los platillos de esta categoría (lista vacía = el estándar de Modificadores).
          if (!(await fila('SELECT 1 AS x FROM categorias WHERE id = ? AND negocio_id = ?', [id, nid]))) throw fallo('Esa categoría no existe.');
          const grupos = Array.isArray(d['grupos']) ? [...new Set((d['grupos'] as unknown[]).map((g) => String(g).trim()).filter((g) => g !== '' && g.length <= 80))].slice(0, 40) : [];
          await transaccion(async (tx) => {
            await tx.ejecutar('DELETE FROM categoria_grupo_orden WHERE categoria_id = ?', [id]);
            for (const [i, g] of grupos.entries()) await tx.ejecutar('INSERT INTO categoria_grupo_orden (categoria_id, grupo, orden) VALUES (?, ?, ?)', [id, g, i]);
          });
          return { ok: true };
        }
        case 'eliminar': {
          // No se borra una categoría con productos: se perdería el menú sin querer.
          const n = await fila('SELECT COUNT(*) AS n FROM productos WHERE categoria_id = ? AND negocio_id = ?', [id, nid]);
          if (Number(n?.['n']) > 0) throw fallo('Esa categoría todavía tiene productos. Muévelos o elimínalos primero.');
          await ejecutar('DELETE FROM categoria_grupo_orden WHERE categoria_id = ?', [id]);
          await ejecutar('DELETE FROM categorias WHERE id = ? AND negocio_id = ?', [id, nid]);
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
