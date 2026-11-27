/**
 * Administración de modificadores (con queso, sin cebolla, orden doble...).
 *
 * Quién es dueño de qué:
 *   · Lo que crea el administrador de la empresa es GENERAL (sucursal_id NULL): lo ven todas las sucursales.
 *   · Lo que crea el gerente es de SU sucursal (sucursal_id = la suya): solo existe ahí.
 * El gerente puede crear, editar y eliminar lo suyo; de lo general solo puede DESHABILITARLO en su sucursal
 * (sucursal_deshabilitar), nunca editarlo, moverlo ni eliminarlo.
 *
 *   POST (JSON) → { accion, ... }
 *     crear      { nombre, precio, codigo, grupo }       precio 0 = sin costo; código y grupo opcionales
 *     actualizar { id, nombre, precio, activo, codigo, grupo }
 *     eliminar   { id }
 *     asignar    { id, categoria_id, asignar }           pone o quita el extra a TODOS los productos de una categoría
 *     asignar_platillos { id, agregar: [producto_id], quitar: [producto_id] }   pone o quita el extra en platillos concretos
 *     cobro_platillos { id, precio, platillos: [producto_id] }   cobra el modificador SOLO en esos platillos (en los demás es gratis)
 *     predeterminado { id, valor }          (solo el administrador) valor=1: va en TODOS los platillos, también los nuevos
 *     sucursal_deshabilitar { id, deshabilitar }   el gerente apaga o enciende un modificador GENERAL solo en su sucursal
 *     grupo_crear / grupo_editar { nombre, nuevo, codigo } / grupo_eliminar   secciones (Quitar, Con, Sin...)
 *     grupo_mover { nombre, direccion: subir | bajar | inicio | fin }
 *
 * La lista de extras viene dentro de GET /admin/productos.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { cartaOrigen } from '../../carta.js';
import { ejecutar, fila, filas, transaccion } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { codigoEnUso, mensajeCodigo } from '../../codigos.js';
import { entero, largo, mayusculas, noVacio } from '../../util.js';

function leerNombre(d: Record<string, unknown>): string {
  const nombre = String(d['nombre'] ?? '').trim();
  if (nombre === '' || largo(nombre) > 60) throw fallo('El nombre del modificador es obligatorio (máximo 60 caracteres).');
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
async function leerCodigo(nid: number, d: Record<string, unknown>, idActual = 0, alcance: number | null = null, grupoActual = '', campo = 'codigo'): Promise<string | null> {
  const codigo = mayusculas(String(d[campo] ?? '').trim());
  if (codigo === '') return null;
  if (!/^[A-Z0-9-]{1,20}$/.test(codigo)) throw fallo('El código solo puede llevar letras, números y guion (máximo 20 caracteres).');
  // No se repite en toda la empresa: ni con otro modificador, ni con un platillo, ni con una sección.
  const otro = await codigoEnUso(nid, codigo, { extra: idActual, grupo: grupoActual });
  if (otro) throw fallo(mensajeCodigo(codigo, otro, alcance));
  return codigo;
}

/**
 * Secciones de extras. Las que ya existen escritas en algún extra (extras.grupo) se "adoptan" solas en la tabla
 * extra_grupos, para que la lista siempre esté completa y ordenable. Devuelve las secciones en su orden.
 */
export interface GrupoExtra { nombre: string; orden: number; sucursal_id: number | null; codigo: string | null; prefijo: boolean }

export async function listarGruposExtras(nid: number, alcance: number | null = null): Promise<GrupoExtra[]> {
  await ejecutar(
    `INSERT IGNORE INTO extra_grupos (negocio_id, nombre, orden, sucursal_id)
     SELECT ?, e.grupo, (SELECT COALESCE(MAX(orden), 0) FROM extra_grupos WHERE negocio_id = ?) + MIN(e.orden) + 1,
            IF(SUM(e.sucursal_id IS NULL) > 0, NULL, MIN(e.sucursal_id))
       FROM extras e WHERE e.negocio_id = ? AND e.grupo IS NOT NULL AND e.grupo <> '' GROUP BY e.grupo ORDER BY MIN(e.orden)`,
    [nid, nid, nid],
  );
  // El gerente ve primero las secciones generales y después las suyas; las de otras sucursales no existen para él.
  const donde = alcance === null ? '' : ` AND (sucursal_id IS NULL OR sucursal_id = ${Number(alcance)})`;
  const orden = alcance === null ? 'orden, id' : '(sucursal_id IS NOT NULL), orden, id';
  return (await filas(`SELECT nombre, orden, sucursal_id, codigo, prefijo FROM extra_grupos WHERE negocio_id = ?${donde} ORDER BY ${orden}`, [nid])).map((g) => ({
    nombre: String(g['nombre']), orden: Number(g['orden']), sucursal_id: g['sucursal_id'] === null ? null : Number(g['sucursal_id']),
    codigo: (g['codigo'] as string | null) ?? null, prefijo: Boolean(Number(g['prefijo'])),
  }));
}

function leerNombreGrupo(v: unknown): string {
  const n = String(v ?? '').trim();
  if (n === '' || largo(n) > 40) throw fallo('El nombre de la sección es obligatorio (máximo 40 caracteres).');
  return n;
}

const AVISO_NO_TUYO = 'No puedes cambiarlo ni quitarlo porque no fue creado por ti. Lo que sí puedes hacer es deshabilitarlo en tu sucursal.';

/**
 * Trae el extra de ESTA empresa y comprueba que quien pide pueda tocarlo: el administrador, cualquiera; el gerente,
 * solo los de su sucursal (los generales no se tocan y los de otra sucursal ni siquiera existen para él).
 */
async function extraDe(nid: number, id: number, alcance: number | null, { soloVer = false } = {}): Promise<{ id: number; nombre: string; sucursal_id: number | null }> {
  const x = await fila('SELECT id, nombre, sucursal_id FROM extras WHERE id = ? AND negocio_id = ?', [id, nid]);
  const sid = x && x['sucursal_id'] !== null ? Number(x['sucursal_id']) : null;
  if (!x || (alcance !== null && sid !== null && sid !== alcance)) throw new ErrorHttp(404, 'validacion', 'Ese modificador ya no existe.');
  if (alcance !== null && sid === null && !soloVer) throw new ErrorHttp(403, 'sin_permiso', AVISO_NO_TUYO);
  return { id: Number(x['id']), nombre: String(x['nombre']), sucursal_id: sid };
}

/** Un gerente solo puede asignar a platillos de la carta general o de su sucursal. */
const soloSuyos = (alcance: number | null): string => (alcance === null ? '' : ` AND ${cartaOrigen(alcance)}`);

/** Una sección existente debe ser general o de la sucursal de quien pide (la de otra sucursal "no existe"). */
async function grupoUsable(nid: number, alcance: number | null, nombre: string | null): Promise<void> {
  if (nombre === null || alcance === null) return;
  const g = await fila('SELECT sucursal_id FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nombre]);
  if (g && g['sucursal_id'] !== null && Number(g['sucursal_id']) !== alcance) throw fallo('Esa sección no existe en tu sucursal. Elige otra o crea una nueva.');
}

/** Secciones que quien pide puede mover/renombrar/quitar: todas para el administrador; solo las suyas para el gerente. */
async function grupoPropio(nid: number, alcance: number | null, nombre: string): Promise<void> {
  const g = await fila('SELECT sucursal_id FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nombre]);
  if (!g) throw new ErrorHttp(404, 'validacion', 'Esa sección ya no existe.');
  if (alcance === null) return;
  if (g['sucursal_id'] === null) throw new ErrorHttp(403, 'sin_permiso', 'No puedes cambiar ni quitar esta sección porque no fue creada por ti.');
  if (Number(g['sucursal_id']) !== alcance) throw new ErrorHttp(404, 'validacion', 'Esa sección ya no existe.');
}

export async function rutasExtras(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/extras',
    handler: async (req, reply) => {
      exigirMetodo(req, 'POST');
      const yo = await requerirGestion(req);
      const alcance = yo.alcance;   // null = administrador de la empresa; id = gerente de esa sucursal
      const nid = req.negocio.id;
      const d = cuerpoJson(req);
      const id = entero(d['id']);

      switch (String(d['accion'] ?? '')) {
        case 'crear': {
          const nombre = leerNombre(d);
          const precio = leerPrecio(d);
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM extras WHERE negocio_id = ?', [nid]);
          const grupo = leerGrupo(d);
          await grupoUsable(nid, alcance, grupo);
          const r = await ejecutar('INSERT INTO extras (negocio_id, sucursal_id, nombre, precio, orden, codigo, grupo) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            nid, alcance, nombre, precio, Number(sig?.['n']), await leerCodigo(nid, d, 0, alcance), grupo,
          ]);
          reply.code(201);
          return { ok: true, id: r.insertId };
        }
        case 'actualizar': {
          await extraDe(nid, id, alcance);
          const grupo = leerGrupo(d);
          await grupoUsable(nid, alcance, grupo);
          await ejecutar('UPDATE extras SET nombre = ?, precio = ?, activo = ?, codigo = ?, grupo = ? WHERE id = ? AND negocio_id = ?', [
            leerNombre(d), leerPrecio(d), noVacio(d['activo']) ? 1 : 0, await leerCodigo(nid, d, id, alcance), grupo, id, nid,
          ]);
          return { ok: true };
        }
        case 'eliminar':
          // Las ventas pasadas no se alteran: guardan el texto del extra al momento de venderse.
          await extraDe(nid, id, alcance);
          await ejecutar('DELETE FROM extras WHERE id = ? AND negocio_id = ?', [id, nid]);
          return { ok: true };

        case 'predeterminado': {
          // Solo el administrador: el modificador general va en todos los platillos (los de hoy y, al crearlos, los nuevos).
          if (alcance !== null) throw new ErrorHttp(403, 'sin_permiso', 'Solo el administrador de la empresa puede poner un modificador en todos los platillos.');
          const x = await extraDe(nid, id, null);
          if (x.sucursal_id !== null) throw fallo('Solo los modificadores generales pueden ir en todos los platillos.');
          const poner = noVacio(d['valor']);
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extras SET todos = ? WHERE id = ? AND negocio_id = ?', [poner ? 1 : 0, id, nid]);
            if (poner) {
              await tx.ejecutar(
                `INSERT INTO producto_extras (producto_id, extra_id)
                 SELECT p.id, ? FROM productos p WHERE p.negocio_id = ? AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
                [id, nid, id],
              );
            }
          });
          return { ok: true };
        }
        case 'sucursal_deshabilitar': {
          // El gerente apaga (o vuelve a encender) un modificador GENERAL solo en su sucursal; no lo toca para las demás.
          if (alcance === null) throw fallo('Esta acción es de los gerentes. El administrador usa “Activo” en el modificador.');
          const x = await extraDe(nid, id, alcance, { soloVer: true });
          if (x.sucursal_id !== null) throw fallo('Tus propios modificadores se editan o se desactivan con “Activo”.');
          if (noVacio(d['deshabilitar'])) await ejecutar('INSERT IGNORE INTO extra_sucursal_off (extra_id, sucursal_id) VALUES (?, ?)', [id, alcance]);
          else await ejecutar('DELETE FROM extra_sucursal_off WHERE extra_id = ? AND sucursal_id = ?', [id, alcance]);
          return { ok: true };
        }

        case 'asignar': {
          await extraDe(nid, id, alcance);
          const categoriaId = entero(d['categoria_id']);
          const cat = await fila('SELECT COUNT(*) AS n FROM categorias WHERE id = ? AND negocio_id = ?', [categoriaId, nid]);
          if (Number(cat?.['n']) === 0) throw new ErrorHttp(404, 'validacion', 'Esa categoría ya no existe.');
          if (noVacio(d['asignar'])) {
            // INSERT ... SELECT con NOT EXISTS: no duplica los productos que ya tenían el extra.
            await ejecutar(
              `INSERT INTO producto_extras (producto_id, extra_id)
               SELECT p.id, ? FROM productos p
                WHERE p.negocio_id = ? AND p.categoria_id = ?${soloSuyos(alcance)}
                  AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
              [id, nid, categoriaId, id],
            );
          } else {
            await ejecutar(
              `DELETE FROM producto_extras
                WHERE extra_id = ? AND producto_id IN (SELECT p.id FROM productos p WHERE p.negocio_id = ? AND p.categoria_id = ?${soloSuyos(alcance)})`,
              [id, nid, categoriaId],
            );
          }
          return { ok: true };
        }
        case 'asignar_platillos': {
          // Elegir platillo por platillo: solo toca los ids pedidos (no pierde el precio propio de los que se quedan).
          await extraDe(nid, id, alcance);
          const ids = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.map((n) => entero(n)).filter((n) => n > 0))].slice(0, 2000) : []);
          const agregar = ids(d['agregar']);
          const quitar = ids(d['quitar']);
          if (agregar.length > 0) {
            await ejecutar(
              `INSERT INTO producto_extras (producto_id, extra_id)
               SELECT p.id, ? FROM productos p
                WHERE p.negocio_id = ? AND p.id IN (${agregar.map(() => '?').join(',')})${soloSuyos(alcance)}
                  AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
              [id, nid, ...agregar, id],
            );
          }
          if (quitar.length > 0) {
            await ejecutar(
              `DELETE FROM producto_extras WHERE extra_id = ? AND producto_id IN (SELECT p.id FROM productos p WHERE p.negocio_id = ? AND p.id IN (${quitar.map(() => '?').join(',')})${soloSuyos(alcance)})`,
              [id, nid, ...quitar],
            );
          }
          return { ok: true };
        }
        case 'asignar_todos': {
          // Pone (o quita) el extra en TODOS los platillos de la empresa de golpe, sin duplicar los que ya lo tenían.
          // Después el dueño puede quitarlo o cambiarle el precio platillo por platillo desde el editor del producto.
          await extraDe(nid, id, alcance);
          if (noVacio(d['asignar'])) {
            await ejecutar(
              `INSERT INTO producto_extras (producto_id, extra_id)
               SELECT p.id, ? FROM productos p
                WHERE p.negocio_id = ?${soloSuyos(alcance)}
                  AND NOT EXISTS (SELECT 1 FROM producto_extras pe WHERE pe.producto_id = p.id AND pe.extra_id = ?)`,
              [id, nid, id],
            );
          } else {
            await ejecutar(`DELETE FROM producto_extras WHERE extra_id = ? AND producto_id IN (SELECT p.id FROM productos p WHERE p.negocio_id = ?${soloSuyos(alcance)})`, [id, nid]);
          }
          return { ok: true };
        }
        case 'cobro_platillos': {
          // "Se cobra solo en algunos": el precio general queda en 0 (gratis) y el precio se pone solo en los platillos elegidos.
          // precio vacío o 0 con lista vacía = se cobra igual en todos (precio general, sin precios propios).
          await extraDe(nid, id, alcance);
          const precio = leerPrecio(d);
          const ids = Array.isArray(d['platillos']) ? [...new Set((d['platillos'] as unknown[]).map((n) => entero(n)).filter((n) => n > 0))].slice(0, 2000) : [];
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extras SET precio = 0 WHERE id = ? AND negocio_id = ?', [id, nid]);
            await tx.ejecutar(`UPDATE producto_extras SET precio = NULL WHERE extra_id = ? AND producto_id IN (SELECT p.id FROM productos p WHERE p.negocio_id = ?${soloSuyos(alcance)})`, [id, nid]);
            if (ids.length > 0) {
              await tx.ejecutar(
                `UPDATE producto_extras SET precio = ? WHERE extra_id = ? AND producto_id IN (SELECT p.id FROM productos p WHERE p.negocio_id = ? AND p.id IN (${ids.map(() => '?').join(',')})${soloSuyos(alcance)})`,
                [precio, id, nid, ...ids],
              );
            }
          });
          return { ok: true };
        }
        case 'precio_general': {
          // Borra los precios propios por platillo: todos vuelven a cobrar el precio general del extra.
          await extraDe(nid, id, alcance);
          await ejecutar('UPDATE producto_extras SET precio = NULL WHERE extra_id = ? AND producto_id IN (SELECT id FROM productos WHERE negocio_id = ?)', [id, nid]);
          return { ok: true };
        }
        case 'grupo_crear': {
          const nombre = leerNombreGrupo(d['nombre']);
          await listarGruposExtras(nid);
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM extra_grupos WHERE negocio_id = ?', [nid]);
          const r = await ejecutar('INSERT IGNORE INTO extra_grupos (negocio_id, nombre, orden, sucursal_id) VALUES (?, ?, ?, ?)', [nid, nombre, Number(sig?.['n']), alcance]);
          if (r.affectedRows === 0) throw new ErrorHttp(409, 'validacion', `Ya existe una sección llamada “${nombre}”. Usa otro nombre.`);
          reply.code(201);
          return { ok: true };
        }
        case 'grupo_editar':
        case 'grupo_renombrar': {
          // Nombre y código (opcional, único en la empresa). Los modificadores siempre se leen junto a su sección.
          const actual = leerNombreGrupo(d['nombre']);
          const nuevo = leerNombreGrupo(d['nuevo'] ?? d['nombre']);
          await listarGruposExtras(nid);
          await grupoPropio(nid, alcance, actual);
          if (nuevo.toLowerCase() !== actual.toLowerCase()) {
            const otra = await fila('SELECT COUNT(*) AS n FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nuevo]);
            if (Number(otra?.['n']) > 0) throw new ErrorHttp(409, 'validacion', `Ya existe una sección llamada “${nuevo}”. Usa otro nombre.`);
          }
          const editando = String(d['accion']) === 'grupo_editar';
          const codigo = editando ? await leerCodigo(nid, d, 0, alcance, actual) : undefined;
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extra_grupos SET nombre = ? WHERE negocio_id = ? AND nombre = ?', [nuevo, nid, actual]);
            await tx.ejecutar('UPDATE extras SET grupo = ? WHERE negocio_id = ? AND grupo = ?', [nuevo, nid, actual]);
            if (editando) await tx.ejecutar('UPDATE extra_grupos SET codigo = ? WHERE negocio_id = ? AND nombre = ?', [codigo ?? null, nid, nuevo]);
          });
          return { ok: true };
        }
        case 'grupo_eliminar': {
          // Solo se borra la sección: sus extras NO se eliminan, pasan a "Otros" (sin sección).
          const nombre = leerNombreGrupo(d['nombre']);
          await listarGruposExtras(nid);
          await grupoPropio(nid, alcance, nombre);
          await transaccion(async (tx) => {
            await tx.ejecutar('UPDATE extras SET grupo = NULL WHERE negocio_id = ? AND grupo = ?', [nid, nombre]);
            await tx.ejecutar('DELETE FROM extra_grupos WHERE negocio_id = ? AND nombre = ?', [nid, nombre]);
          });
          return { ok: true };
        }
        case 'grupo_mover': {
          // subir / bajar (un lugar) · inicio / fin (hasta arriba o hasta abajo). El gerente solo mueve las suyas, entre ellas.
          const nombre = leerNombreGrupo(d['nombre']);
          const dir = String(d['direccion'] ?? '');
          if (!['subir', 'bajar', 'inicio', 'fin'].includes(dir)) throw fallo('Dirección no válida.');
          const todos = await listarGruposExtras(nid, alcance);
          await grupoPropio(nid, alcance, nombre);
          const ambito = alcance === null ? todos : todos.filter((g) => g.sucursal_id === alcance);
          const i = ambito.findIndex((g) => g.nombre === nombre);
          if (i < 0) return { ok: true };
          const orden = ambito.map((g) => g.nombre);
          const [x] = orden.splice(i, 1) as [string];
          const j = dir === 'subir' ? Math.max(0, i - 1) : dir === 'bajar' ? Math.min(orden.length, i + 1) : dir === 'inicio' ? 0 : orden.length;
          orden.splice(j, 0, x);
          if (orden.every((n, k) => n === ambito[k]?.nombre)) return { ok: true };
          // Se reutilizan los mismos "lugares" (números de orden) del ámbito, estrictamente crecientes, para no pisar las de otros.
          const lugares: number[] = [];
          for (const g of ambito) lugares.push(Math.max(g.orden, (lugares[lugares.length - 1] ?? Number.NEGATIVE_INFINITY) + 1));
          await transaccion(async (tx) => {
            for (const [k, n] of orden.entries()) await tx.ejecutar('UPDATE extra_grupos SET orden = ? WHERE negocio_id = ? AND nombre = ?', [lugares[k], nid, n]);
          });
          return { ok: true };
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
