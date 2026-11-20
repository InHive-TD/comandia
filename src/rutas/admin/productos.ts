/**
 * Administración de productos (carta). Lo usan el dueño de la empresa y el gerente de sucursal.
 *
 *   GET  → todos los productos (también los agotados/ocultos), con categorías, parrillas y extras.
 *   POST → formulario (multipart, para poder incluir la foto) con el campo "accion":
 *            crear | actualizar | eliminar | disponibilidad | ordenar | ajuste_sucursal
 *
 * ALCANCE (qué puede hacer cada rol):
 *  - Dueño (alcance = null): ve y edita TODA la carta, incluidos los productos propios de cada sucursal.
 *  - Gerente (alcance = id de su sucursal): ve la carta general + sus productos propios. Los productos
 *    propios los edita por completo; los de la carta general solo puede ocultarlos o cambiarles el precio
 *    en su sucursal (acción "ajuste_sucursal"). Lo que crea queda como propio de su sucursal.
 *
 * Un producto con sucursal_id NULL es de la carta general; con un id, es propio de esa sucursal.
 */
import type { FastifyInstance } from 'fastify';
import type { Usuario } from '../../auth.js';
import { exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas, transaccion } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { type Formulario, leerFormulario } from '../../formulario.js';
import { borrarFoto, procesarFoto } from '../../fotos.js';
import { sucursalesActivas } from '../../negocio.js';
import { entero, esDuplicado, largo, mayusculas } from '../../util.js';

/** Campos de un producto ya validados, listos para guardar. */
interface CamposProducto {
  codigo: string | null;
  porcion: string | null;
  estacionId: number | null;
  extras: number[];
  nombre: string;
  descripcion: string | null;
  categoriaId: number;
  precio: string;
  disponible: 0 | 1;
  pedirOpciones: 0 | 1;
}

/** Lee y valida todos los campos del formulario de un producto. Lanza un error legible si algo no cuadra. */
async function leerCampos(nid: number, alcance: number | null, f: Formulario, idActual = 0): Promise<CamposProducto> {
  const nombre = f.texto('nombre').trim();
  const descripcion = f.texto('descripcion').trim();
  const categoriaId = entero(f.texto('categoria_id'));
  const precio = f.texto('precio').trim().replace(',', '.');

  if (nombre === '' || largo(nombre) > 100) throw fallo('El nombre es obligatorio (máximo 100 caracteres).');
  if (largo(descripcion) > 255) throw fallo('La descripción no puede pasar de 255 caracteres.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(precio) || Number(precio) <= 0) throw fallo('El precio debe ser un número mayor que cero, por ejemplo 25 o 25.50.');

  const cat = await fila('SELECT COUNT(*) AS n FROM categorias WHERE id = ? AND negocio_id = ?', [categoriaId, nid]);
  if (Number(cat?.['n']) === 0) throw fallo('Elige una categoría.');

  // Código corto (opcional y único en la empresa). Se guarda en mayúsculas.
  const codigo = mayusculas(f.texto('codigo').trim());
  if (codigo !== '') {
    if (!/^[A-Z0-9-]{1,20}$/.test(codigo)) throw fallo('El código solo puede llevar letras, números y guion (máximo 10 caracteres).');
    const otro = await fila('SELECT nombre, sucursal_id FROM productos WHERE negocio_id = ? AND codigo = ? AND id <> ?', [nid, codigo, idActual]);
    if (otro) {
      // Al gerente no se le revela el nombre de productos de OTRAS sucursales.
      const ajeno = alcance !== null && otro['sucursal_id'] !== null && Number(otro['sucursal_id']) !== alcance;
      throw fallo(ajeno ? `El código ${codigo} ya está en uso. Elige otro.` : `El código ${codigo} ya lo usa “${String(otro['nombre'])}”.`);
    }
  }

  const porcion = f.texto('porcion').trim();
  if (largo(porcion) > 40) throw fallo('La porción no puede pasar de 40 caracteres (ej. “3 tacos”, “250 g”).');

  const estacionId = entero(f.texto('estacion_id'));
  if (estacionId > 0) {
    const e = await fila('SELECT COUNT(*) AS n FROM estaciones WHERE id = ? AND negocio_id = ?', [estacionId, nid]);
    if (Number(e?.['n']) === 0) throw fallo('Esa parrilla ya no existe.');
  }

  // Extras permitidos: lista de ids ("1,4,7"). Todos deben existir en ESTA empresa.
  const extras = [...new Set(f.lista('extras').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number).filter((x) => x > 0))];
  if (extras.length > 0) {
    const marcas = extras.map(() => '?').join(',');
    const n = await fila(`SELECT COUNT(*) AS n FROM extras WHERE negocio_id = ? AND id IN (${marcas})`, [nid, ...extras]);
    if (Number(n?.['n']) !== extras.length) throw fallo('Alguno de los extras elegidos ya no existe. Recarga la página.');
  }

  return {
    codigo: codigo === '' ? null : codigo,
    porcion: porcion === '' ? null : porcion,
    estacionId: estacionId > 0 ? estacionId : null,
    extras,
    nombre,
    descripcion: descripcion === '' ? null : descripcion,
    categoriaId,
    precio,
    disponible: f.texto('disponible', '1') === '1' ? 1 : 0,
    pedirOpciones: f.texto('pedir_opciones', '0') === '1' ? 1 : 0,
  };
}

/**
 * Comprueba que el usuario pueda EDITAR este producto. El dueño, cualquiera de su empresa; el gerente, solo
 * los propios de su sucursal (los de la carta general solo se ajustan con "ajuste_sucursal").
 */
async function exigirProductoEditable(nid: number, alcance: number | null, id: number): Promise<void> {
  const p = await fila('SELECT sucursal_id FROM productos WHERE id = ? AND negocio_id = ?', [id, nid]);
  const de = p ? (p['sucursal_id'] === null ? null : Number(p['sucursal_id'])) : undefined;
  // No existe, o es propio de OTRA sucursal: para el gerente "ya no existe".
  if (de === undefined || (alcance !== null && de !== null && de !== alcance)) throw new ErrorHttp(404, 'validacion', 'Ese producto ya no existe.');
  if (alcance !== null && de === null) {
    throw new ErrorHttp(403, 'validacion', 'Ese producto es de la carta general de la empresa. Aquí puedes ocultarlo o cambiar su precio en tu sucursal.');
  }
}

/** Foto actual de un producto (nombre de archivo guardado) o null. */
async function fotoActual(nid: number, id: number): Promise<string | null> {
  const p = await fila('SELECT foto FROM productos WHERE id = ? AND negocio_id = ?', [id, nid]);
  if (!p) throw new ErrorHttp(404, 'validacion', 'Ese producto ya no existe.');
  return (p['foto'] as string | null) ?? null;
}

/** Deja en producto_extras exactamente los extras indicados (dentro de una transacción). */
async function guardarExtras(tx: { ejecutar: (sql: string, p?: unknown[]) => Promise<unknown> }, productoId: number, extras: number[]): Promise<void> {
  await tx.ejecutar('DELETE FROM producto_extras WHERE producto_id = ?', [productoId]);
  for (const extraId of extras) await tx.ejecutar('INSERT INTO producto_extras (producto_id, extra_id) VALUES (?, ?)', [productoId, extraId]);
}

/** GET: la carta completa que ve cada rol, junto con categorías, parrillas y extras. */
async function listar(nid: number, alcance: number | null): Promise<Record<string, unknown>> {
  // El gerente ve la carta general + sus productos propios, con los ajustes que hizo en su sucursal.
  const unirAjuste = alcance !== null ? ` LEFT JOIN producto_sucursal ps ON ps.producto_id = p.id AND ps.sucursal_id = ${alcance}` : ' LEFT JOIN producto_sucursal ps ON 1 = 0';
  const soloVisibles = alcance !== null ? ` AND (p.sucursal_id IS NULL OR p.sucursal_id = ${alcance})` : '';
  const prods = await filas(
    `SELECT p.id, p.categoria_id, c.nombre AS categoria, p.nombre, p.descripcion, p.precio, p.foto, p.disponible, p.codigo, p.porcion,
            p.estacion_id, p.pedir_opciones, p.sucursal_id, sx.nombre AS sucursal, ps.oculto, ps.precio AS precio_sucursal
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN sucursales sx ON sx.id = p.sucursal_id${unirAjuste}
      WHERE p.negocio_id = ? AND c.negocio_id = p.negocio_id${soloVisibles}
      ORDER BY c.orden, c.id, p.orden, p.nombre`,
    [nid],
  );

  // Extras asignados a cada producto: producto_id → [extra_id, ...]
  const asignados = new Map<number, number[]>();
  for (const a of await filas('SELECT pe.producto_id, pe.extra_id FROM producto_extras pe JOIN productos pr ON pr.id = pe.producto_id WHERE pr.negocio_id = ? ORDER BY pe.extra_id', [nid])) {
    const k = Number(a['producto_id']);
    asignados.set(k, [...(asignados.get(k) ?? []), Number(a['extra_id'])]);
  }

  const productos = prods.map((f) => ({
    id: Number(f['id']),
    categoria_id: Number(f['categoria_id']),
    categoria: f['categoria'],
    nombre: f['nombre'],
    descripcion: f['descripcion'],
    precio: Number(f['precio']),
    foto: f['foto'],
    disponible: Boolean(Number(f['disponible'])),
    codigo: f['codigo'],
    porcion: f['porcion'],
    estacion_id: f['estacion_id'] === null ? null : Number(f['estacion_id']),
    pedir_opciones: Boolean(Number(f['pedir_opciones'])),
    extras: asignados.get(Number(f['id'])) ?? [],
    sucursal_id: f['sucursal_id'] === null ? null : Number(f['sucursal_id']),
    sucursal: f['sucursal'], // producto propio de una sucursal (null = carta general)
    propio: alcance !== null && f['sucursal_id'] !== null, // el gerente lo puede editar por completo
    oculto: Boolean(Number(f['oculto'] ?? 0)),
    precio_sucursal: f['precio_sucursal'] === null || f['precio_sucursal'] === undefined ? null : Number(f['precio_sucursal']),
  }));

  const categorias = (
    await filas(
      `SELECT c.id, c.nombre, c.orden, COUNT(p.id) AS productos FROM categorias c
         LEFT JOIN productos p ON p.categoria_id = c.id
        WHERE c.negocio_id = ? GROUP BY c.id, c.nombre, c.orden ORDER BY c.orden, c.id`,
      [nid],
    )
  ).map((c) => ({ id: Number(c['id']), nombre: c['nombre'], orden: Number(c['orden']), productos: Number(c['productos']) }));

  const estaciones = (await filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((e) => ({ id: Number(e['id']), nombre: e['nombre'] }));
  const extras = (await filas('SELECT id, nombre, precio, activo, codigo, grupo FROM extras WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((x) => ({
    id: Number(x['id']), nombre: x['nombre'], precio: Number(x['precio']), activo: Boolean(Number(x['activo'])), codigo: x['codigo'], grupo: x['grupo'],
  }));

  return { ok: true, productos, categorias, estaciones, extras };
}

export async function rutasAdminProductos(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/productos',
    handler: async (req, reply) => {
      const yo: Usuario = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      if (req.method === 'GET') return listar(nid, alcance);

      exigirMetodo(req, 'POST');
      const f = await leerFormulario(req);
      const id = entero(f.texto('id'));

      /** Procesa la foto subida (si la hay): devuelve el nombre guardado o null. */
      const recibirFoto = async (): Promise<string | null> => (f.foto ? procesarFoto(f.foto, nid) : null);

      switch (f.texto('accion')) {
        case 'crear': {
          const c = await leerCampos(nid, alcance, f);
          const foto = await recibirFoto();
          try {
            // El producto nuevo queda al final de su categoría.
            const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM productos WHERE negocio_id = ? AND categoria_id = ?', [nid, c.categoriaId]);
            const nuevoId = await transaccion(async (tx) => {
              const r = await tx.ejecutar(
                `INSERT INTO productos (negocio_id, sucursal_id, categoria_id, nombre, descripcion, precio, foto, disponible, codigo, porcion, estacion_id, pedir_opciones, orden)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nid, alcance, c.categoriaId, c.nombre, c.descripcion, c.precio, foto, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, Number(sig?.['n'])],
              );
              await guardarExtras(tx, r.insertId, c.extras);
              return r.insertId;
            });
            reply.code(201);
            return { ok: true, id: nuevoId };
          } catch (e) {
            await borrarFoto(foto, nid); // si no se pudo guardar el producto, no deja la foto huérfana
            if (esDuplicado(e)) throw fallo('Ya existe un producto con ese código.', 409);
            throw e;
          }
        }

        case 'actualizar': {
          await exigirProductoEditable(nid, alcance, id);
          const anterior = await fotoActual(nid, id);
          const c = await leerCampos(nid, alcance, f, id);
          const nueva = await recibirFoto();
          // Foto: la nueva si se subió; ninguna si se marcó "quitar foto"; si no, se conserva la anterior.
          const foto = nueva ?? (f.texto('quitar_foto') === '1' ? null : anterior);
          try {
            await transaccion(async (tx) => {
              await tx.ejecutar(
                `UPDATE productos SET categoria_id = ?, nombre = ?, descripcion = ?, precio = ?, foto = ?, disponible = ?,
                        codigo = ?, porcion = ?, estacion_id = ?, pedir_opciones = ? WHERE id = ? AND negocio_id = ?`,
                [c.categoriaId, c.nombre, c.descripcion, c.precio, foto, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, id, nid],
              );
              await guardarExtras(tx, id, c.extras);
            });
          } catch (e) {
            await borrarFoto(nueva, nid);
            if (esDuplicado(e)) throw fallo('Ya existe un producto con ese código.', 409);
            throw e;
          }
          if (foto !== anterior) await borrarFoto(anterior, nid); // ya no se usa la foto vieja
          return { ok: true };
        }

        case 'ordenar': {
          // Nuevo orden de los productos de UNA categoría: ids (ids[]) en el orden en que deben aparecer.
          const ids = [...new Set(f.lista('ids').map(entero))].filter((x) => x > 0);
          if (ids.length === 0) throw fallo('No hay productos que ordenar.');
          await transaccion(async (tx) => {
            for (const [i, pid] of ids.entries()) {
              // El gerente solo puede reordenar sus productos propios.
              await tx.ejecutar(`UPDATE productos SET orden = ? WHERE id = ? AND negocio_id = ?${alcance !== null ? ' AND sucursal_id = ?' : ''}`, [i + 1, pid, nid, ...(alcance !== null ? [alcance] : [])]);
            }
          });
          return { ok: true };
        }

        case 'disponibilidad': {
          await exigirProductoEditable(nid, alcance, id);
          const disponible = f.texto('disponible') === '1' ? 1 : 0;
          await ejecutar('UPDATE productos SET disponible = ? WHERE id = ? AND negocio_id = ?', [disponible, id, nid]);
          return { ok: true, disponible: Boolean(disponible) };
        }

        case 'ajuste_sucursal': {
          // Ocultar un producto de la carta general, o ponerle otro precio, SOLO en una sucursal.
          // El gerente lo aplica a la suya; el dueño debe indicar la sucursal (sucursal_id).
          let suc = alcance;
          if (suc === null) {
            suc = entero(f.texto('sucursal_id'));
            if (!(await sucursalesActivas(nid)).some((s) => s.id === suc)) throw fallo('Elige la sucursal.');
          }
          const p = await fila('SELECT sucursal_id FROM productos WHERE id = ? AND negocio_id = ?', [id, nid]);
          if (!p || p['sucursal_id'] !== null) throw new ErrorHttp(404, 'validacion', 'Ese producto no es de la carta general.');
          const oculto = f.texto('oculto', '0') === '1' ? 1 : 0;
          const precioTxt = f.texto('precio').trim().replace(',', '.');
          let precio: string | null = null; // vacío = usar el precio general
          if (precioTxt !== '') {
            if (!/^\d{1,5}(\.\d{1,2})?$/.test(precioTxt) || Number(precioTxt) <= 0) {
              throw fallo('El precio debe ser un número mayor que cero, por ejemplo 25 o 25.50 (déjalo vacío para usar el precio general).');
            }
            precio = precioTxt;
          }
          await ejecutar(
            `INSERT INTO producto_sucursal (producto_id, sucursal_id, negocio_id, oculto, precio) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE oculto = VALUES(oculto), precio = VALUES(precio)`,
            [id, suc, nid, oculto, precio],
          );
          return { ok: true, oculto: Boolean(oculto), precio_sucursal: precio === null ? null : Number(precio) };
        }

        case 'eliminar': {
          await exigirProductoEditable(nid, alcance, id);
          const foto = await fotoActual(nid, id);
          await ejecutar('DELETE FROM productos WHERE id = ? AND negocio_id = ?', [id, nid]);
          await borrarFoto(foto, nid);
          return { ok: true };
        }

        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
