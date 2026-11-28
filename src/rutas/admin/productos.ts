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
import { cartaOrigen } from '../../carta.js';
import { codigoEnUso, mensajeCodigo } from '../../codigos.js';
import { sucursalesActivas } from '../../negocio.js';
import { listarGruposExtras } from './extras.js';
import { entero, esDuplicado, largo, mayusculas } from '../../util.js';

/** Campos de un producto ya validados, listos para guardar. */
export interface CamposProducto {
  codigo: string | null;
  porcion: string | null;
  estacionId: number | null;
  extras: number[];
  /** Precio propio de algunos extras en este platillo: extra_id → precio (los demás usan el precio general). */
  preciosExtra: Map<number, number>;
  nombre: string;
  descripcion: string | null;
  categoriaId: number;
  precio: string;
  disponible: 0 | 1;
  pedirOpciones: 0 | 1;
  obligatorias: 0 | 1;
  grupoObligatorio: string | null;
  /** Orden propio de los tipos de modificador en este platillo (vacío = el estándar de la pestaña Modificadores). */
  gruposOrden: string[];
}

/** Lee y valida todos los campos del formulario de un producto. Lanza un error legible si algo no cuadra. */
export async function leerCampos(nid: number, alcance: number | null, f: Formulario, idActual = 0, categoriaPorCrear = false): Promise<CamposProducto> {
  const nombre = f.texto('nombre').trim();
  const descripcion = f.texto('descripcion').trim();
  const categoriaId = entero(f.texto('categoria_id'));
  const precio = f.texto('precio').trim().replace(',', '.');

  if (nombre === '' || largo(nombre) > 100) throw fallo('El nombre es obligatorio (máximo 100 caracteres).');
  if (largo(descripcion) > 255) throw fallo('La descripción no puede pasar de 255 caracteres.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(precio) || Number(precio) <= 0) throw fallo('El precio debe ser un número mayor que cero, por ejemplo 25 o 25.50.');

  // `categoriaPorCrear`: la carga masiva valida filas cuya categoría todavía no existe (se crea al confirmar).
  if (!categoriaPorCrear) {
    const cat = await fila('SELECT COUNT(*) AS n FROM categorias WHERE id = ? AND negocio_id = ?', [categoriaId, nid]);
    if (Number(cat?.['n']) === 0) throw fallo('Elige una categoría.');
  }

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
    // Tampoco puede coincidir con el de un modificador ni con el de una sección (los códigos no se repiten en la empresa).
    const choque = await codigoEnUso(nid, codigo, {}, ['modificador', 'sección']);
    if (choque) throw fallo(mensajeCodigo(codigo, choque, alcance));
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
    if (Number(n?.['n']) !== extras.length) throw fallo('Alguno de los modificadores elegidos ya no existe. Recarga la página.');
  }

  // Precios propios por platillo: JSON {"<extra_id>": precio}. Solo cuentan los extras marcados; precio vacío = el general.
  const preciosExtra = new Map<number, number>();
  const crudo = f.texto('precios_extra').trim();
  if (crudo !== '') {
    let obj: unknown;
    try { obj = JSON.parse(crudo); } catch { throw fallo('Los precios por platillo no son válidos.'); }
    if (typeof obj === 'object' && obj !== null) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const id = Number(k);
        if (!extras.includes(id) || v === null || v === '') continue;
        const num = Number(v);
        if (!Number.isFinite(num) || num < 0 || num > 99999) throw fallo('Un precio de modificador no es válido.');
        preciosExtra.set(id, Math.round(num * 100) / 100);
      }
    }
  }

  // Opción obligatoria: hay que tener extras marcados y, si se elige una sección, que alguno sea de ella.
  const obligatorias = f.texto('opciones_obligatorias', '0') === '1' ? 1 : 0;
  let grupoObligatorio: string | null = null;
  if (obligatorias === 1) {
    if (extras.length === 0) throw fallo('Para pedir una opción obligatoria marca al menos un modificador de este platillo (por ejemplo, las carnes del burrito).');
    const g = f.texto('grupo_obligatorio').trim();
    if (g !== '') {
      if (largo(g) > 40) throw fallo('El nombre de la sección no es válido.');
      const marcas = extras.map(() => '?').join(',');
      const enGrupo = await fila(`SELECT COUNT(*) AS n FROM extras WHERE negocio_id = ? AND grupo = ? AND activo = 1 AND id IN (${marcas})`, [nid, g, ...extras]);
      if (Number(enGrupo?.['n']) === 0) throw fallo(`Marca al menos un modificador de la sección “${g}” para este platillo, o elige “Cualquier opción”.`);
      grupoObligatorio = g;
    }
  }

  let gruposOrden: string[] = [];
  try {
    const crudo: unknown = JSON.parse(f.texto('grupos_orden', '[]') || '[]');
    if (Array.isArray(crudo)) gruposOrden = [...new Set(crudo.map((g) => String(g).trim()).filter((g) => g !== '' && g.length <= 80))].slice(0, 40);
  } catch { /* orden inválido: se usa el estándar */ }

  return {
    obligatorias,
    grupoObligatorio,
    gruposOrden,
    codigo: codigo === '' ? null : codigo,
    porcion: porcion === '' ? null : porcion,
    estacionId: estacionId > 0 ? estacionId : null,
    extras,
    preciosExtra,
    nombre,
    descripcion: descripcion === '' ? null : descripcion,
    categoriaId,
    precio,
    disponible: f.texto('disponible', '1') === '1' ? 1 : 0,
    pedirOpciones: f.texto('pedir_opciones', '0') === '1' || obligatorias === 1 ? 1 : 0,   // obligatoria = la hoja de opciones se abre siempre
  };
}

/**
 * Comprueba que el usuario pueda EDITAR este producto. El dueño, cualquiera de su empresa; el gerente, solo
 * los propios de su sucursal (los de la carta general solo se ajustan con "ajuste_sucursal").
 */
export async function exigirProductoEditable(nid: number, alcance: number | null, id: number): Promise<void> {
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
export async function guardarExtras(tx: { ejecutar: (sql: string, p?: unknown[]) => Promise<unknown> }, productoId: number, extras: number[], precios: Map<number, number>, gruposOrden?: string[]): Promise<void> {
  if (gruposOrden !== undefined) {
    await tx.ejecutar('DELETE FROM producto_grupo_orden WHERE producto_id = ?', [productoId]);
    for (const [i, g] of gruposOrden.entries()) await tx.ejecutar('INSERT INTO producto_grupo_orden (producto_id, grupo, orden) VALUES (?, ?, ?)', [productoId, g, i]);
  }
  await tx.ejecutar('DELETE FROM producto_extras WHERE producto_id = ?', [productoId]);
  for (const extraId of extras) await tx.ejecutar('INSERT INTO producto_extras (producto_id, extra_id, precio) VALUES (?, ?, ?)', [productoId, extraId, precios.get(extraId) ?? null]);
}

/** GET: la carta completa que ve cada rol, junto con categorías, parrillas y extras. */
async function listar(nid: number, alcance: number | null): Promise<Record<string, unknown>> {
  // El gerente ve la carta general + sus productos propios, con los ajustes que hizo en su sucursal.
  const unirAjuste = alcance !== null ? ` LEFT JOIN producto_sucursal ps ON ps.producto_id = p.id AND ps.sucursal_id = ${alcance}` : ' LEFT JOIN producto_sucursal ps ON 1 = 0';
  const soloVisibles = alcance !== null ? ` AND ${cartaOrigen(alcance)}` : '';
  const prods = await filas(
    `SELECT p.id, p.categoria_id, c.nombre AS categoria, p.nombre, p.descripcion, p.precio, p.foto, p.disponible, p.codigo, p.porcion,
            p.estacion_id, p.pedir_opciones, p.opciones_obligatorias, p.grupo_obligatorio, p.sucursal_id, sx.nombre AS sucursal, ps.oculto, ps.precio AS precio_sucursal
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN sucursales sx ON sx.id = p.sucursal_id${unirAjuste}
      WHERE p.negocio_id = ? AND c.negocio_id = p.negocio_id${soloVisibles}
      ORDER BY c.orden, c.id, p.orden, p.nombre`,
    [nid],
  );

  // Extras asignados a cada producto: producto_id → [extra_id, ...]
  const asignados = new Map<number, number[]>();
  const precios = new Map<number, Record<number, number>>();   // producto_id → {extra_id: precio propio}
  for (const a of await filas('SELECT pe.producto_id, pe.extra_id, pe.precio FROM producto_extras pe JOIN productos pr ON pr.id = pe.producto_id WHERE pr.negocio_id = ? ORDER BY pe.extra_id', [nid])) {
    const k = Number(a['producto_id']);
    asignados.set(k, [...(asignados.get(k) ?? []), Number(a['extra_id'])]);
    if (a['precio'] !== null) precios.set(k, { ...(precios.get(k) ?? {}), [Number(a['extra_id'])]: Number(a['precio']) });
  }

  const ordenes = new Map<number, string[]>();   // producto_id → tipos de modificador en el orden propio de ese platillo
  for (const a of await filas('SELECT o.producto_id, o.grupo FROM producto_grupo_orden o JOIN productos pr ON pr.id = o.producto_id WHERE pr.negocio_id = ? ORDER BY o.producto_id, o.orden', [nid])) {
    const k = Number(a['producto_id']);
    ordenes.set(k, [...(ordenes.get(k) ?? []), String(a['grupo'])]);
  }

  const defectos = new Map<number, number[]>();   // producto_id → extras que vienen marcados solo en ese platillo
  for (const a of await filas('SELECT d.producto_id, d.extra_id FROM extra_defecto_platillo d JOIN productos pr ON pr.id = d.producto_id WHERE pr.negocio_id = ?', [nid])) {
    const k = Number(a['producto_id']);
    defectos.set(k, [...(defectos.get(k) ?? []), Number(a['extra_id'])]);
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
    opciones_obligatorias: Boolean(Number(f['opciones_obligatorias'])),
    grupo_obligatorio: f['grupo_obligatorio'] ?? null,
    extras: asignados.get(Number(f['id'])) ?? [],
    extras_precios: precios.get(Number(f['id'])) ?? {},
    extras_defecto: defectos.get(Number(f['id'])) ?? [],
    grupos_orden: ordenes.get(Number(f['id'])) ?? [],
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
  ).map((c) => ({ id: Number(c['id']), nombre: c['nombre'], orden: Number(c['orden']), productos: Number(c['productos']), grupos_orden: [] as string[] }));
  for (const o of await filas('SELECT o.categoria_id, o.grupo FROM categoria_grupo_orden o JOIN categorias c ON c.id = o.categoria_id WHERE c.negocio_id = ? ORDER BY o.categoria_id, o.orden', [nid])) {
    categorias.find((c) => c.id === Number(o['categoria_id']))?.grupos_orden.push(String(o['grupo']));
  }

  const estaciones = (await filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((e) => ({ id: Number(e['id']), nombre: e['nombre'] }));
  // Modificadores: el administrador ve todos (marcando de qué sucursal es cada uno); el gerente, los generales y los suyos.
  const quien = alcance === null ? '' : ` AND (x.sucursal_id IS NULL OR x.sucursal_id = ${Number(alcance)})`;
  const apagados = alcance === null ? new Set<number>() : new Set((await filas('SELECT extra_id FROM extra_sucursal_off WHERE sucursal_id = ?', [alcance])).map((o) => Number(o['extra_id'])));
  const extras = (await filas(
    `SELECT x.id, x.nombre, x.precio, x.activo, x.codigo, x.grupo, x.sucursal_id, x.todos, x.defecto, sx.nombre AS sucursal
       FROM extras x LEFT JOIN sucursales sx ON sx.id = x.sucursal_id
      WHERE x.negocio_id = ?${quien} ORDER BY x.orden, x.id`,
    [nid],
  )).map((x) => ({
    id: Number(x['id']), nombre: x['nombre'], precio: Number(x['precio']), activo: Boolean(Number(x['activo'])), codigo: x['codigo'], grupo: x['grupo'],
    sucursal_id: x['sucursal_id'] === null ? null : Number(x['sucursal_id']), sucursal: x['sucursal'] ?? null,
    todos: Boolean(Number(x['todos'])),
    defecto: Boolean(Number(x['defecto'])),
    propio: alcance === null || (x['sucursal_id'] !== null && Number(x['sucursal_id']) === alcance),   // quien pide puede editarlo
    deshabilitado: apagados.has(Number(x['id'])),   // (gerente) apagado en su sucursal
  }));

  // Secciones de extras en el orden que eligió el dueño (incluye las que aún no tienen extras)
  const gruposExtras = await listarGruposExtras(nid, alcance);
  return {
    ok: true, productos, categorias, estaciones, extras,
    grupos_extras: gruposExtras.map((g) => g.nombre),
    grupos_extras_info: gruposExtras.map((g) => ({ nombre: g.nombre, sucursal_id: g.sucursal_id, codigo: g.codigo, prefijo: g.prefijo, descripcion: g.descripcion, propio: alcance === null || g.sucursal_id === alcance })),
  };
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
          // El dueño puede crear el platillo directo en la carta de una sucursal (sucursal_id); sin eso queda en la carta general.
          let destino = alcance;
          if (alcance === null) {
            const pedida = entero(f.texto('sucursal_id'));
            if (pedida > 0) {
              const existe = await fila('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [pedida, nid]);
              if (!existe) throw fallo('Esa sucursal no existe.');
              destino = pedida;
            }
          }
          const c = await leerCampos(nid, alcance, f);
          const foto = await recibirFoto();
          try {
            // El producto nuevo queda al final de su categoría.
            const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM productos WHERE negocio_id = ? AND categoria_id = ?', [nid, c.categoriaId]);
            const nuevoId = await transaccion(async (tx) => {
              const r = await tx.ejecutar(
                `INSERT INTO productos (negocio_id, sucursal_id, categoria_id, nombre, descripcion, precio, foto, disponible, codigo, porcion, estacion_id, pedir_opciones, opciones_obligatorias, grupo_obligatorio, orden)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nid, destino, c.categoriaId, c.nombre, c.descripcion, c.precio, foto, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, c.obligatorias, c.grupoObligatorio, Number(sig?.['n'])],
              );
              await guardarExtras(tx, r.insertId, c.extras, c.preciosExtra, c.gruposOrden);
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
                        codigo = ?, porcion = ?, estacion_id = ?, pedir_opciones = ?, opciones_obligatorias = ?, grupo_obligatorio = ? WHERE id = ? AND negocio_id = ?`,
                [c.categoriaId, c.nombre, c.descripcion, c.precio, foto, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, c.obligatorias, c.grupoObligatorio, id, nid],
              );
              await guardarExtras(tx, id, c.extras, c.preciosExtra, c.gruposOrden);
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
