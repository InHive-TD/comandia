/**
 * Administración de extras / variantes (con queso, sin cebolla, orden doble...). Solo el dueño de la empresa.
 *
 *   POST (JSON) → { accion, ... }
 *     crear      { nombre, precio, codigo, grupo }       precio 0 = sin costo; código y grupo opcionales
 *     actualizar { id, nombre, precio, activo, codigo, grupo }
 *     eliminar   { id }
 *     asignar    { id, categoria_id, asignar }           pone o quita el extra a TODOS los productos de una categoría
 *
 * La lista de extras viene dentro de GET /admin/productos.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../../auth.js';
import { ejecutar, fila } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { entero, largo, mayusculas, noVacio } from '../../util.js';

function leerNombre(d: Record<string, unknown>): string {
  const nombre = String(d['nombre'] ?? '').trim();
  if (nombre === '' || largo(nombre) > 60) throw fallo('El nombre del extra es obligatorio (máximo 60 caracteres).');
  return nombre;
}

/** Precio como texto "25" o "25.50" (acepta coma decimal). 0 significa "sin costo". */
function leerPrecio(d: Record<string, unknown>): string {
  let precio = String(d['precio'] ?? '0').trim().replace(',', '.');
  if (precio === '') precio = '0';
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(precio)) throw fallo('El precio debe ser un número, por ejemplo 0 (sin costo) o 10.');
  return precio;
}

/** Grupo opcional para agrupar extras en pantalla (Ensaladas, Salsas...). */
function leerGrupo(d: Record<string, unknown>): string | null {
  const grupo = String(d['grupo'] ?? '').trim();
  if (largo(grupo) > 40) throw fallo('El grupo no puede pasar de 40 caracteres (ej. Ensaladas, Salsas).');
  return grupo === '' ? null : grupo;
}

/**
 * Código corto opcional (ej. XQ = extra queso). No puede repetirse entre extras; sí puede coincidir con el
 * código de un producto ("VOL P" = volcán de pastor).
 */
async function leerCodigo(nid: number, d: Record<string, unknown>, idActual = 0): Promise<string | null> {
  const codigo = mayusculas(String(d['codigo'] ?? '').trim());
  if (codigo === '') return null;
  if (!/^[A-Z0-9-]{1,20}$/.test(codigo)) throw fallo('El código solo puede llevar letras, números y guion (máximo 10 caracteres).');
  const otro = await fila('SELECT nombre FROM extras WHERE negocio_id = ? AND codigo = ? AND id <> ?', [nid, codigo, idActual]);
  if (otro) throw fallo(`El código ${codigo} ya lo usa el extra “${String(otro['nombre'])}”.`);
  return codigo;
}

/** Comprueba que el extra exista en ESTA empresa (404 si no). */
async function extraExiste(nid: number, id: number): Promise<void> {
  const n = await fila('SELECT COUNT(*) AS n FROM extras WHERE id = ? AND negocio_id = ?', [id, nid]);
  if (Number(n?.['n']) === 0) throw new ErrorHttp(404, 'validacion', 'Ese extra ya no existe.');
}

export async function rutasExtras(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/extras',
    handler: async (req, reply) => {
      exigirMetodo(req, 'POST');
      await requerirRol(req, 'admin');
      const nid = req.negocio.id;
      const d = cuerpoJson(req);
      const id = entero(d['id']);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const nombre = leerNombre(d);
          const precio = leerPrecio(d);
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM extras WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT INTO extras (negocio_id, nombre, precio, orden, codigo, grupo) VALUES (?, ?, ?, ?, ?, ?)', [
            nid, nombre, precio, Number(sig?.['n']), await leerCodigo(nid, d), leerGrupo(d),
          ]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'actualizar':
          await extraExiste(nid, id);
          await ejecutar('UPDATE extras SET nombre = ?, precio = ?, activo = ?, codigo = ?, grupo = ? WHERE id = ? AND negocio_id = ?', [
            leerNombre(d), leerPrecio(d), noVacio(d['activo']) ? 1 : 0, await leerCodigo(nid, d, id), leerGrupo(d), id, nid,
          ]);
          return { ok: true };

        case 'eliminar':
          // Las ventas pasadas no se alteran: guardan el texto del extra al momento de venderse.
          await extraExiste(nid, id);
          await ejecutar('DELETE FROM extras WHERE id = ? AND negocio_id = ?', [id, nid]);
          return { ok: true };

        case 'asignar': {
          await extraExiste(nid, id);
          const categoriaId = entero(d['categoria_id']);
          const cat = await fila('SELECT COUNT(*) AS n FROM categorias WHERE id = ? AND negocio_id = ?', [categoriaId, nid]);
          if (Number(cat?.['n']) === 0) throw new ErrorHttp(404, 'validacion', 'Esa categoría ya no existe.');
          if (noVacio(d['asignar'])) {
            // INSERT ... SELECT con NOT EXISTS: no duplica los productos que ya tenían el extra.
            await ejecutar(
              `INSERT INTO producto_extras (producto_id, extra_id)
               SELECT p.id, ? FROM productos p
                WHERE p.negocio_id = ? AND p.categoria_id = ?
                  AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
              [id, nid, categoriaId, id],
            );
          } else {
            await ejecutar(
              `DELETE FROM producto_extras
                WHERE extra_id = ? AND producto_id IN (SELECT id FROM productos WHERE negocio_id = ? AND categoria_id = ?)`,
              [id, nid, categoriaId],
            );
          }
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
