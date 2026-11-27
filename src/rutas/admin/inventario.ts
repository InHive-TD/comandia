/**
 * Inventario (módulo opcional, apagado por defecto; lo enciende la plataforma por empresa: ajuste inventario_activo).
 * Nivel básico: insumos, proveedores, compras con recepción, existencias por sucursal, mermas, conteos físicos y traspasos.
 * (El nivel completo —recetas y descuento automático al vender— usa el ajuste inventario_recetas y llega después.)
 *
 *   GET  /admin/inventario/estado                         → { activo, recetas }
 *   GET  /admin/inventario?sucursal=ID                    → insumos con existencia, proveedores, compras recientes y resumen
 *   GET  /admin/inventario/movimientos?sucursal=ID&insumo=ID  → últimos movimientos (kárdex)
 *   POST { accion: 'insumo_crear' | 'insumo_editar' | 'insumo_archivar', ... }       (solo el dueño)
 *   POST { accion: 'proveedor_crear' | 'proveedor_editar' | 'proveedor_archivar', ... }   (solo el dueño)
 *   POST { accion: 'compra', sucursal_id, proveedor_id?, referencia?, nota?, recibir, items: [{ insumo_id, cantidad, costo }] }
 *   POST { accion: 'compra_recibir' | 'compra_cancelar', id }
 *   POST { accion: 'merma', sucursal_id, insumo_id, cantidad, motivo, nota? }
 *   POST { accion: 'conteo', sucursal_id, conteos: [{ insumo_id, contado }] }
 *   POST { accion: 'traspaso', desde, hacia, insumo_id, cantidad }                   (solo el dueño)
 *
 * El gerente trabaja SIEMPRE sobre su sucursal (aunque mande otra) y solo ve el catálogo; el dueño edita el catálogo.
 * Cada cambio de existencia es un movimiento (kárdex) y se hace en una transacción: nunca queda a medias.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { type Tx, ejecutar, fila, filas, transaccion } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { entero, esDuplicado, largo } from '../../util.js';

const UNIDADES = ['kg', 'g', 'l', 'ml', 'pza'];
const MOTIVOS_MERMA: Record<string, string> = {
  caducado: 'Caducó',
  danado: 'Dañado o se cayó',
  error_cocina: 'Error de cocina',
  cortesia: 'Cortesía',
  robo: 'Faltante o robo',
  otro: 'Otro',
};

async function ajuste(nid: number, clave: string): Promise<string | null> {
  const f = await fila('SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, clave]);
  return f ? String(f['valor']) : null;
}

/** Número positivo con hasta 3 decimales (cantidades) o 4 (costos). */
function numero(v: unknown, etiqueta: string, { min = 0, max = 99_999_999, permitirCero = true } = {}): number {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max || (!permitirCero && n === 0)) throw fallo(`${etiqueta}: escribe un número válido.`);
  return n;
}
const redondo = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

function texto(v: unknown, etiqueta: string, max: number, obligatorio = false): string | null {
  const t = String(v ?? '').trim();
  if (t === '') {
    if (obligatorio) throw fallo(`${etiqueta} es obligatorio.`);
    return null;
  }
  if (largo(t) > max) throw fallo(`${etiqueta} no puede pasar de ${max} caracteres.`);
  return t;
}

/** Suma (o resta) a la existencia y deja el movimiento en el kárdex. Dentro de una transacción. */
async function mover(tx: Tx, o: { nid: number; sid: number; insumo: number; tipo: string; cantidad: number; costo: number; motivo?: string | null; nota?: string | null; ref?: number | null; usuario: number }): Promise<void> {
  await tx.ejecutar(
    `INSERT INTO inv_existencias (insumo_id, sucursal_id, negocio_id, cantidad) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
    [o.insumo, o.sid, o.nid, o.cantidad],
  );
  await tx.ejecutar(
    'INSERT INTO inv_movimientos (negocio_id, sucursal_id, insumo_id, tipo, cantidad, costo, motivo, nota, ref_id, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [o.nid, o.sid, o.insumo, o.tipo, o.cantidad, o.costo, o.motivo ?? null, o.nota ?? null, o.ref ?? null, o.usuario],
  );
}

async function existenciaActual(tx: Tx, insumo: number, sid: number): Promise<number> {
  const r = await tx.filas('SELECT cantidad FROM inv_existencias WHERE insumo_id = ? AND sucursal_id = ? FOR UPDATE', [insumo, sid]);
  return r[0] ? Number(r[0]['cantidad']) : 0;
}

export async function rutasAdminInventario(app: FastifyInstance): Promise<void> {
  /** Sesión de gestión + módulo encendido. Devuelve el usuario, la empresa y una función para validar sucursales. */
  const entrada = async (req: FastifyRequest, exigirActivo = true) => {
    const yo = await requerirGestion(req);
    const nid = req.negocio.id;
    const activo = (await ajuste(nid, 'inventario_activo')) === '1';
    const recetas = activo && (await ajuste(nid, 'inventario_recetas')) === '1';
    if (exigirActivo && !activo) throw new ErrorHttp(403, 'modulo_apagado', 'El inventario no está activado para esta empresa.');
    /** Sucursal de trabajo: la pedida (dueño) o la propia (gerente); debe existir en esta empresa. */
    const sucursal = async (pedida: unknown): Promise<number> => {
      const id = yo.alcance ?? entero(pedida);
      const s = await fila('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [id, nid]);
      if (!s) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
      return id;
    };
    const soloDueno = (): void => {
      if (yo.alcance !== null) throw new ErrorHttp(403, 'sin_permiso', 'Solo el administrador de la empresa puede cambiar el catálogo de inventario.');
    };
    return { yo, nid, activo, recetas, sucursal, soloDueno };
  };

  app.get('/admin/inventario/estado', async (req) => {
    const { activo, recetas } = await entrada(req, false);
    return { ok: true, activo, recetas };
  });

  app.get('/admin/inventario/movimientos', async (req) => {
    const { nid, sucursal } = await entrada(req);
    const q = req.query as Record<string, unknown>;
    const sid = await sucursal(q['sucursal']);
    const insumo = entero(q['insumo']);
    const r = await filas(
      `SELECT m.id, m.tipo, m.cantidad, m.costo, m.motivo, m.nota, m.creado_en, i.nombre AS insumo, i.unidad, u.nombre AS usuario
         FROM inv_movimientos m
         JOIN inv_insumos i ON i.id = m.insumo_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.negocio_id = ? AND m.sucursal_id = ?${insumo > 0 ? ' AND m.insumo_id = ?' : ''}
        ORDER BY m.id DESC LIMIT 100`,
      insumo > 0 ? [nid, sid, insumo] : [nid, sid],
    );
    return {
      ok: true,
      movimientos: r.map((m) => ({ id: Number(m['id']), tipo: m['tipo'], cantidad: Number(m['cantidad']), costo: Number(m['costo']), motivo: m['motivo'], motivo_texto: MOTIVOS_MERMA[String(m['motivo'])] ?? null, nota: m['nota'], fecha: m['creado_en'], insumo: m['insumo'], unidad: m['unidad'], usuario: m['usuario'] ?? null })),
    };
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/admin/inventario',
    handler: async (req, reply) => {
      const { yo, nid, activo, recetas, sucursal, soloDueno } = await entrada(req, req.method === 'POST');

      if (req.method === 'GET') {
        if (!activo) return { ok: true, activo: false, recetas: false };
        const sid = await sucursal((req.query as Record<string, unknown>)['sucursal']);
        const insumos = await filas(
          `SELECT i.id, i.nombre, i.categoria, i.unidad, i.costo, i.minimo, i.proveedor_id, i.activo, COALESCE(e.cantidad, 0) AS existencia
             FROM inv_insumos i LEFT JOIN inv_existencias e ON e.insumo_id = i.id AND e.sucursal_id = ?
            WHERE i.negocio_id = ? AND i.activo = 1 ORDER BY i.categoria IS NULL, i.categoria, i.nombre`,
          [sid, nid],
        );
        const proveedores = await filas('SELECT id, nombre, contacto, telefono, correo, dias_entrega, minimo_compra, notas FROM inv_proveedores WHERE negocio_id = ? AND activo = 1 ORDER BY nombre', [nid]);
        const compras = await filas(
          `SELECT c.id, c.estado, c.referencia, c.nota, c.total, c.creado_en, c.recibida_en, p.nombre AS proveedor
             FROM inv_compras c LEFT JOIN inv_proveedores p ON p.id = c.proveedor_id
            WHERE c.negocio_id = ? AND c.sucursal_id = ? ORDER BY c.id DESC LIMIT 30`,
          [nid, sid],
        );
        const mermas = await filas(
          `SELECT COALESCE(motivo, 'otro') AS motivo, SUM(-cantidad * costo) AS valor, COUNT(*) AS n
             FROM inv_movimientos WHERE negocio_id = ? AND sucursal_id = ? AND tipo = 'merma' AND creado_en >= (NOW() - INTERVAL 30 DAY)
            GROUP BY motivo ORDER BY valor DESC`,
          [nid, sid],
        );
        const lista = insumos.map((i) => {
          const existencia = Number(i['existencia']);
          const minimo = Number(i['minimo']);
          return { id: Number(i['id']), nombre: i['nombre'], categoria: i['categoria'] ?? null, unidad: i['unidad'], costo: Number(i['costo']), minimo, proveedor_id: i['proveedor_id'] === null ? null : Number(i['proveedor_id']), existencia, bajo: minimo > 0 && existencia <= minimo };
        });
        return {
          ok: true,
          activo: true,
          recetas,
          puede_editar_catalogo: yo.alcance === null,
          motivos_merma: Object.entries(MOTIVOS_MERMA).map(([id, nombre]) => ({ id, nombre })),
          unidades: UNIDADES,
          insumos: lista,
          proveedores: proveedores.map((p) => ({ id: Number(p['id']), nombre: p['nombre'], contacto: p['contacto'], telefono: p['telefono'], correo: p['correo'], dias_entrega: Number(p['dias_entrega']), minimo_compra: Number(p['minimo_compra']), notas: p['notas'] })),
          compras: compras.map((c) => ({ id: Number(c['id']), estado: c['estado'], referencia: c['referencia'], nota: c['nota'], total: Number(c['total']), fecha: c['creado_en'], recibida: c['recibida_en'], proveedor: c['proveedor'] ?? null })),
          resumen: {
            valor_inventario: redondo(lista.reduce((a, i) => a + Math.max(i.existencia, 0) * i.costo, 0), 2),
            bajo_minimo: lista.filter((i) => i.bajo).length,
            mermas_30d: redondo(mermas.reduce((a, m) => a + Number(m['valor'] ?? 0), 0), 2),
            mermas_por_motivo: mermas.map((m) => ({ motivo: m['motivo'], nombre: MOTIVOS_MERMA[String(m['motivo'])] ?? String(m['motivo']), valor: redondo(Number(m['valor'] ?? 0), 2), veces: Number(m['n']) })),
          },
        };
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);
      const accion = String(d['accion'] ?? '');

      /** El insumo debe ser de esta empresa. */
      const insumoPropio = async (id: number) => {
        const i = await fila('SELECT id, nombre, unidad, costo FROM inv_insumos WHERE id = ? AND negocio_id = ? AND activo = 1', [id, nid]);
        if (!i) throw new ErrorHttp(404, 'validacion', 'Ese insumo no existe.');
        return i;
      };
      const proveedorOpcional = async (v: unknown): Promise<number | null> => {
        const id = entero(v);
        if (id <= 0) return null;
        const p = await fila('SELECT id FROM inv_proveedores WHERE id = ? AND negocio_id = ? AND activo = 1', [id, nid]);
        if (!p) throw new ErrorHttp(404, 'validacion', 'Ese proveedor no existe.');
        return id;
      };

      switch (accion) {
        /* ---------------- Catálogo de insumos ---------------- */
        case 'insumo_crear':
        case 'insumo_editar': {
          soloDueno();
          const nombre = texto(d['nombre'], 'El nombre', 80, true) as string;
          const unidad = String(d['unidad'] ?? 'pza');
          if (!UNIDADES.includes(unidad)) throw fallo('Elige una unidad válida.');
          const costo = redondo(numero(d['costo'] ?? 0, 'El costo'), 4);
          const minimo = redondo(numero(d['minimo'] ?? 0, 'El mínimo'), 3);
          const categoria = texto(d['categoria'], 'La categoría', 40);
          const prov = await proveedorOpcional(d['proveedor_id']);
          try {
            if (accion === 'insumo_crear') {
              const r = await ejecutar('INSERT INTO inv_insumos (negocio_id, nombre, categoria, unidad, costo, minimo, proveedor_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [nid, nombre, categoria, unidad, costo, minimo, prov]);
              reply.code(201);
              return { ok: true, id: r.insertId };
            }
            const id = entero(d['id']);
            await insumoPropio(id);
            await ejecutar('UPDATE inv_insumos SET nombre = ?, categoria = ?, unidad = ?, costo = ?, minimo = ?, proveedor_id = ? WHERE id = ? AND negocio_id = ?', [nombre, categoria, unidad, costo, minimo, prov, id, nid]);
            return { ok: true };
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya tienes un insumo con ese nombre.');
            throw e;
          }
        }
        case 'insumo_archivar': {
          soloDueno();
          // Se archiva (no se borra) para no perder el historial de movimientos.
          await ejecutar('UPDATE inv_insumos SET activo = 0, nombre = CONCAT(nombre, \' (archivado \', id, \')\') WHERE id = ? AND negocio_id = ?', [entero(d['id']), nid]);
          return { ok: true };
        }

        /* ---------------- Proveedores ---------------- */
        case 'proveedor_crear':
        case 'proveedor_editar': {
          soloDueno();
          const nombre = texto(d['nombre'], 'El nombre', 80, true) as string;
          const campos = [nombre, texto(d['contacto'], 'El contacto', 80), texto(d['telefono'], 'El teléfono', 30), texto(d['correo'], 'El correo', 150), Math.min(Math.max(entero(d['dias_entrega']), 0), 60), redondo(numero(d['minimo_compra'] ?? 0, 'El mínimo de compra'), 2), texto(d['notas'], 'Las notas', 255)];
          try {
            if (accion === 'proveedor_crear') {
              const r = await ejecutar('INSERT INTO inv_proveedores (negocio_id, nombre, contacto, telefono, correo, dias_entrega, minimo_compra, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [nid, ...campos]);
              reply.code(201);
              return { ok: true, id: r.insertId };
            }
            await ejecutar('UPDATE inv_proveedores SET nombre = ?, contacto = ?, telefono = ?, correo = ?, dias_entrega = ?, minimo_compra = ?, notas = ? WHERE id = ? AND negocio_id = ?', [...campos, entero(d['id']), nid]);
            return { ok: true };
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya tienes un proveedor con ese nombre.');
            throw e;
          }
        }
        case 'proveedor_archivar': {
          soloDueno();
          await ejecutar("UPDATE inv_proveedores SET activo = 0, nombre = CONCAT(nombre, ' (archivado ', id, ')') WHERE id = ? AND negocio_id = ?", [entero(d['id']), nid]);
          await ejecutar('UPDATE inv_insumos SET proveedor_id = NULL WHERE proveedor_id = ? AND negocio_id = ?', [entero(d['id']), nid]);
          return { ok: true };
        }

        /* ---------------- Compras ---------------- */
        case 'compra': {
          const sid = await sucursal(d['sucursal_id']);
          const prov = await proveedorOpcional(d['proveedor_id']);
          const items = Array.isArray(d['items']) ? (d['items'] as Record<string, unknown>[]) : [];
          if (items.length === 0 || items.length > 200) throw fallo('Agrega al menos un insumo a la compra.');
          const lineas: { insumo: number; cantidad: number; costo: number }[] = [];
          for (const it of items) {
            const id = entero(it['insumo_id']);
            await insumoPropio(id);
            lineas.push({ insumo: id, cantidad: redondo(numero(it['cantidad'], 'La cantidad', { permitirCero: false }), 3), costo: redondo(numero(it['costo'] ?? 0, 'El costo'), 4) });
          }
          const total = redondo(lineas.reduce((a, l) => a + l.cantidad * l.costo, 0), 2);
          const recibir = d['recibir'] !== false && d['recibir'] !== 0 && d['recibir'] !== '0';
          const id = await transaccion(async (tx) => {
            const c = await tx.ejecutar('INSERT INTO inv_compras (negocio_id, sucursal_id, proveedor_id, estado, referencia, nota, total, usuario_id, recibida_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [nid, sid, prov, recibir ? 'recibida' : 'pedida', texto(d['referencia'], 'La referencia', 60), texto(d['nota'], 'La nota', 255), total, yo.id, recibir ? new Date() : null]);
            for (const l of lineas) {
              await tx.ejecutar('INSERT INTO inv_compra_items (compra_id, insumo_id, cantidad, costo) VALUES (?, ?, ?, ?)', [c.insertId, l.insumo, l.cantidad, l.costo]);
              if (recibir) {
                await mover(tx, { nid, sid, insumo: l.insumo, tipo: 'compra', cantidad: l.cantidad, costo: l.costo, ref: c.insertId, usuario: yo.id });
                if (l.costo > 0) await tx.ejecutar('UPDATE inv_insumos SET costo = ? WHERE id = ? AND negocio_id = ?', [l.costo, l.insumo, nid]);   // el costo actual es el de la última compra
              }
            }
            return c.insertId;
          });
          reply.code(201);
          return { ok: true, id };
        }
        case 'compra_recibir':
        case 'compra_cancelar': {
          const id = entero(d['id']);
          const c = await fila('SELECT id, sucursal_id, estado FROM inv_compras WHERE id = ? AND negocio_id = ?', [id, nid]);
          if (!c || (yo.alcance !== null && Number(c['sucursal_id']) !== yo.alcance)) throw new ErrorHttp(404, 'validacion', 'Esa compra no existe.');
          if (String(c['estado']) !== 'pedida') throw new ErrorHttp(409, 'validacion', 'Esa compra ya no está pendiente.');
          if (accion === 'compra_cancelar') {
            await ejecutar("UPDATE inv_compras SET estado = 'cancelada' WHERE id = ?", [id]);
            return { ok: true };
          }
          await transaccion(async (tx) => {
            const lineas = await tx.filas('SELECT insumo_id, cantidad, costo FROM inv_compra_items WHERE compra_id = ?', [id]);
            for (const l of lineas) {
              await mover(tx, { nid, sid: Number(c['sucursal_id']), insumo: Number(l['insumo_id']), tipo: 'compra', cantidad: Number(l['cantidad']), costo: Number(l['costo']), ref: id, usuario: yo.id });
              if (Number(l['costo']) > 0) await tx.ejecutar('UPDATE inv_insumos SET costo = ? WHERE id = ? AND negocio_id = ?', [Number(l['costo']), Number(l['insumo_id']), nid]);
            }
            await tx.ejecutar("UPDATE inv_compras SET estado = 'recibida', recibida_en = NOW() WHERE id = ?", [id]);
          });
          return { ok: true };
        }

        /* ---------------- Mermas ---------------- */
        case 'merma': {
          const sid = await sucursal(d['sucursal_id']);
          const insumo = await insumoPropio(entero(d['insumo_id']));
          const cantidad = redondo(numero(d['cantidad'], 'La cantidad', { permitirCero: false }), 3);
          const motivo = String(d['motivo'] ?? '');
          if (!Object.hasOwn(MOTIVOS_MERMA, motivo)) throw fallo('Elige el motivo de la merma.');
          await transaccion(async (tx) => {
            const hay = await existenciaActual(tx, Number(insumo['id']), sid);
            if (cantidad > hay) throw fallo(`Solo hay ${redondo(hay, 3)} ${insumo['unidad']} de ${insumo['nombre']}. Haz un conteo si la existencia no es la correcta.`);
            await mover(tx, { nid, sid, insumo: Number(insumo['id']), tipo: 'merma', cantidad: -cantidad, costo: Number(insumo['costo']), motivo, nota: texto(d['nota'], 'La nota', 255), usuario: yo.id });
          });
          reply.code(201);
          return { ok: true };
        }

        /* ---------------- Conteo físico ---------------- */
        case 'conteo': {
          const sid = await sucursal(d['sucursal_id']);
          const conteos = Array.isArray(d['conteos']) ? (d['conteos'] as Record<string, unknown>[]) : [];
          if (conteos.length === 0 || conteos.length > 500) throw fallo('No hay nada que contar.');
          const diferencias = await transaccion(async (tx) => {
            const salida: { insumo: string; unidad: string; antes: number; contado: number; diferencia: number; valor: number }[] = [];
            for (const c of conteos) {
              const insumo = await tx.filas('SELECT id, nombre, unidad, costo FROM inv_insumos WHERE id = ? AND negocio_id = ? AND activo = 1', [entero(c['insumo_id']), nid]);
              if (!insumo[0]) continue;
              const contado = redondo(numero(c['contado'], 'Lo contado'), 3);
              const antes = await existenciaActual(tx, Number(insumo[0]['id']), sid);
              const dif = redondo(contado - antes, 3);
              if (dif === 0) continue;
              await mover(tx, { nid, sid, insumo: Number(insumo[0]['id']), tipo: 'conteo', cantidad: dif, costo: Number(insumo[0]['costo']), nota: `Contado ${contado}, el sistema tenía ${antes}`, usuario: yo.id });
              salida.push({ insumo: String(insumo[0]['nombre']), unidad: String(insumo[0]['unidad']), antes, contado, diferencia: dif, valor: redondo(dif * Number(insumo[0]['costo']), 2) });
            }
            return salida;
          });
          return { ok: true, diferencias, valor_total: redondo(diferencias.reduce((a, x) => a + x.valor, 0), 2) };
        }

        /* ---------------- Traspaso entre sucursales ---------------- */
        case 'traspaso': {
          soloDueno();
          const desde = await sucursal(d['desde']);
          const hacia = await sucursal(d['hacia']);
          if (desde === hacia) throw fallo('Elige dos sucursales distintas.');
          const insumo = await insumoPropio(entero(d['insumo_id']));
          const cantidad = redondo(numero(d['cantidad'], 'La cantidad', { permitirCero: false }), 3);
          await transaccion(async (tx) => {
            const hay = await existenciaActual(tx, Number(insumo['id']), desde);
            if (cantidad > hay) throw fallo(`En la sucursal de origen solo hay ${redondo(hay, 3)} ${insumo['unidad']}.`);
            const costo = Number(insumo['costo']);
            await mover(tx, { nid, sid: desde, insumo: Number(insumo['id']), tipo: 'traspaso_sale', cantidad: -cantidad, costo, nota: `A la sucursal ${hacia}`, usuario: yo.id });
            await mover(tx, { nid, sid: hacia, insumo: Number(insumo['id']), tipo: 'traspaso_entra', cantidad, costo, nota: `De la sucursal ${desde}`, usuario: yo.id });
          });
          return { ok: true };
        }

        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
