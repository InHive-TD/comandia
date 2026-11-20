/**
 * Administración de extras / variantes (con queso, sin cebolla, orden doble...). Solo el dueño de la empresa.
 *
 *   POST (JSON) → { accion, ... }
 *     crear      { nombre, precio, codigo, grupo }       precio 0 = sin costo; código y grupo opcionales
 *     actualizar { id, nombre, precio, activo, codigo, grupo }
 *     eliminar   { id }
 *     asignar    { id, categoria_id, asignar }           pone o quita el extra a TODOS los productos de una categoría
 *     crear_varios { extras: [{ nombre, precio, grupo }], categorias: [id] }   crea muchos de un golpe (variantes de un ingrediente)
 *                                                              y, si se piden categorías, los pone en todos sus productos
 *     grupo_crear / grupo_renombrar / grupo_eliminar / grupo_mover   secciones de extras (Quitar, Aparte, Solo...)
 *
 * La lista de extras viene dentro de GET /admin/productos.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../../auth.js';
import { ejecutar, fila, filas, transaccion } from '../../db.js';
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

/**
 * Secciones de extras. Las que ya existen escritas en algún extra (extras.grupo) se "adoptan" solas en la tabla
 * extra_grupos, para que la lista siempre esté completa y ordenable. Devuelve las secciones en su orden.
 */
/** Variantes propias del negocio (patrones tipo "Bien cocido {x}") guardadas en ajustes como JSON. */
export interface VariantePropia { texto: string; seccion: string; precio: string }
const CLAVE_VARIANTES = 'variantes_propias';

export async function listarVariantesPropias(nid: number): Promise<VariantePropia[]> {
  const r = await fila('SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, CLAVE_VARIANTES]);
  try {
    const v: unknown = JSON.parse(String(r?.['valor'] ?? '[]'));
    return Array.isArray(v) ? (v as VariantePropia[]) : [];
  } catch { return []; }
}

export async function listarGruposExtras(nid: number): Promise<{ nombre: string; orden: number }[]> {
  await ejecutar(
    `INSERT IGNORE INTO extra_grupos (negocio_id, nombre, orden)
     SELECT ?, e.grupo, (SELECT COALESCE(MAX(orden), 0) FROM extra_grupos WHERE negocio_id = ?) + MIN(e.orden) + 1
       FROM extras e WHERE e.negocio_id = ? AND e.grupo IS NOT NULL AND e.grupo <> '' GROUP BY e.grupo ORDER BY MIN(e.orden)`,
    [nid, nid, nid],
  );
  return (await filas('SELECT nombre, orden FROM extra_grupos WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((g) => ({ nombre: String(g['nombre']), orden: Number(g['orden']) }));
}

function leerNombreGrupo(v: unknown): string {
  const n = String(v ?? '').trim();
  if (n === '' || largo(n) > 40) throw fallo('El nombre de la sección es obligatorio (máximo 40 caracteres).');
  return n;
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
        case 'variantes_guardar': {
          // Reemplaza la lista de variantes propias del negocio. Cada texto lleva {x} donde va el ingrediente.
          const lista = Array.isArray(d['lista']) ? (d['lista'] as Record<string, unknown>[]) : [];
          if (lista.length > 30) throw fallo('Máximo 30 variantes propias.');
          const limpias: VariantePropia[] = [];
          for (const v of lista) {
            let texto = String(v['texto'] ?? '').trim();
            if (texto === '') continue;
            if (largo(texto) > 50) throw fallo('El texto de una variante no puede pasar de 50 caracteres.');
            if (!texto.includes('{x}')) texto += ' {x}';
            const seccion = String(v['seccion'] ?? '').trim().slice(0, 40);
            const precio = String(v['precio'] ?? '').trim().replace(',', '.');
            if (precio !== '' && !(Number(precio) >= 0 && Number(precio) < 100000)) throw fallo('Un costo de variante no es válido.');
            if (!limpias.some((x) => x.texto.toLowerCase() === texto.toLowerCase())) limpias.push({ texto, seccion, precio });
          }
          await ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, CLAVE_VARIANTES, JSON.stringify(limpias)]);
          return { ok: true };
        }
        case 'asignar_todos': {
          // Pone (o quita) el extra en TODOS los platillos de la empresa de golpe, sin duplicar los que ya lo tenían.
          // Después el dueño puede quitarlo o cambiarle el precio platillo por platillo desde el editor del producto.
          await extraExiste(nid, id);
          if (noVacio(d['asignar'])) {
            await ejecutar(
              `INSERT INTO producto_extras (producto_id, extra_id)
               SELECT p.id, ? FROM productos p
                WHERE p.negocio_id = ?
                  AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
              [id, nid, id],
            );
          } else {
            await ejecutar('DELETE FROM producto_extras WHERE extra_id = ? AND producto_id IN (SELECT id FROM productos WHERE negocio_id = ?)', [id, nid]);
          }
          return { ok: true };
        }
        case 'precio_general': {
          // Borra los precios propios por platillo: todos vuelven a cobrar el precio general del extra.
          await extraExiste(nid, id);
          await ejecutar('UPDATE producto_extras SET precio = NULL WHERE extra_id = ? AND producto_id IN (SELECT id FROM productos WHERE negocio_id = ?)', [id, nid]);
          return { ok: true };
        }
        case 'crear_varios': {
          // Variantes de uno o más ingredientes (Sin X, X aparte, Solo X...). Los que ya existen con ese nombre se omiten.
          const lista = Array.isArray(d['extras']) ? (d['extras'] as Record<string, unknown>[]) : [];
          if (lista.length === 0 || lista.length > 100) throw fallo('Elige al menos un extra para crear (máximo 100 a la vez).');
          const categoriasIds = [...new Set((Array.isArray(d['categorias']) ? d['categorias'] : []).map(entero))].filter((c) => c > 0);
          for (const c of categoriasIds) {
            const ok = await fila('SELECT COUNT(*) AS n FROM categorias WHERE id = ? AND negocio_id = ?', [c, nid]);
            if (Number(ok?.['n']) === 0) throw new ErrorHttp(404, 'validacion', 'Una de las categorías ya no existe.');
          }
          const validados = lista.map((x) => ({ nombre: leerNombre(x), precio: leerPrecio(x), grupo: leerGrupo(x) }));
          const creados: string[] = [];
          const omitidos: string[] = [];
          await transaccion(async (tx) => {
            for (const x of validados) {
              const existe = (await tx.filas('SELECT id FROM extras WHERE negocio_id = ? AND LOWER(nombre) = LOWER(?) AND COALESCE(grupo, \'\') = COALESCE(?, \'\')', [nid, x.nombre, x.grupo]))[0];
              if (existe) { omitidos.push(x.nombre); continue; }
              const sig = (await tx.filas('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM extras WHERE negocio_id = ?', [nid]))[0];
              const r = await tx.ejecutar('INSERT INTO extras (negocio_id, nombre, precio, orden, grupo) VALUES (?, ?, ?, ?, ?)', [nid, x.nombre, x.precio, Number(sig?.['n']), x.grupo]);
              creados.push(x.nombre);
              for (const c of categoriasIds) {
                await tx.ejecutar('INSERT INTO producto_extras (producto_id, extra_id) SELECT p.id, ? FROM productos p WHERE p.negocio_id = ? AND p.categoria_id = ?', [r.insertId, nid, c]);
              }
            }
          });
          await listarGruposExtras(nid);   // las secciones nuevas quedan registradas
          reply.code(201);
          return { ok: true, creados, omitidos };
        }

        case 'grupo_crear': {
          const nombre = leerNombreGrupo(d['nombre']);
          await listarGruposExtras(nid);
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM extra_grupos WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT IGNORE INTO extra_grupos (negocio_id, nombre, orden) VALUES (?, ?, ?)', [nid, nombre, Number(sig?.['n'])]);
          if (r.affectedRows === 0) throw new ErrorHttp(409, 'validacion', `Ya existe una sección llamada “${nombre}”.`);
          reply.code(201);
          return { ok: true };
        }
        case 'grupo_renombrar': {
          const actual = leerNombreGrupo(d['nombre']);
          const nuevo = leerNombreGrupo(d['nuevo']);
          await listarGruposExtras(nid);
          const hay = await fila('SELECT COUNT(*) AS n FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, actual]);
          if (Number(hay?.['n']) === 0) throw new ErrorHttp(404, 'validacion', 'Esa sección ya no existe.');
          if (nuevo.toLowerCase() !== actual.toLowerCase()) {
            const otra = await fila('SELECT COUNT(*) AS n FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nuevo]);
            if (Number(otra?.['n']) > 0) throw new ErrorHttp(409, 'validacion', `Ya existe una sección llamada “${nuevo}”.`);
          }
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extra_grupos SET nombre = ? WHERE negocio_id = ? AND nombre = ?', [nuevo, nid, actual]);
            await tx.ejecutar('UPDATE extras SET grupo = ? WHERE negocio_id = ? AND grupo = ?', [nuevo, nid, actual]);
          });
          return { ok: true };
        }
        case 'grupo_eliminar': {
          // Solo se borra la sección: sus extras NO se eliminan, pasan a "Otros" (sin sección).
          const nombre = leerNombreGrupo(d['nombre']);
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extras SET grupo = NULL WHERE negocio_id = ? AND grupo = ?', [nid, nombre]);
            await tx.ejecutar('DELETE FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nombre]);
          });
          return { ok: true };
        }
        case 'grupo_mover': {
          const nombre = leerNombreGrupo(d['nombre']);
          const sube = String(d['direccion'] ?? '') === 'subir';
          const grupos = await listarGruposExtras(nid);
          const i = grupos.findIndex((g) => g.nombre === nombre);
          const j = sube ? i - 1 : i + 1;
          if (i < 0 || j < 0 || j >= grupos.length) return { ok: true };
          // Se reasignan los números de orden en secuencia para no depender de valores repetidos.
          const nuevoOrden = grupos.map((g) => g.nombre);
          [nuevoOrden[i], nuevoOrden[j]] = [nuevoOrden[j] as string, nuevoOrden[i] as string];
          await transaccion(async (tx) => {
            for (const [k, n] of nuevoOrden.entries()) await tx.ejecutar('UPDATE extra_grupos SET orden = ? WHERE negocio_id = ? AND nombre = ?', [k + 1, nid, n]);
          });
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
