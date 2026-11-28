/**
 * Parrillas (vistas de cocina por puesto). Solo el dueño de la empresa.
 *
 *   GET  /admin/parrillas → { activo, parrillas: [{id, nombre, color, categorias, productos, tipos, usuarios}],
 *                              categorias, productos, usuarios, tipos }
 *   POST { accion: 'guardar', activo, parrillas: [...] }   guarda todo junto: crea, renombra, ordena y elimina parrillas
 *
 * Una parrilla es una fila de `estaciones` (nombre y orden). Sus reglas (qué categorías y platillos prepara, para qué tipos
 * de pedido, qué usuarios la atienden y si en su pantalla ve el pedido completo o solo sus platillos) van como JSON en ajustes.parrillas_reglas, indexado por el id de la parrilla.
 * El interruptor general es ajustes.parrillas_activo ('1' = encendido; por defecto apagado: la cocina se ve como siempre).
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../../auth.js';
import { filas, transaccion } from '../../db.js';
import { fallo } from '../../errores.js';
import { enteros, largo, noVacio } from '../../util.js';

const COLORES = ['verde', 'naranja', 'azul', 'morado', 'rojo', 'gris'];
const TIPOS = ['aqui', 'llevar', 'recoger'];
const MAX_PARRILLAS = 12;

export interface ReglasParrilla { ver: 'completo' | 'mios'; color: string; categorias: string[]; productos: number[]; tipos: string[]; usuarios: number[] }
const VACIAS: ReglasParrilla = { ver: 'completo', color: 'gris', categorias: [], productos: [], tipos: [], usuarios: [] };

function leerReglas(valor: unknown): Record<string, ReglasParrilla> {
  try {
    const o = JSON.parse(String(valor ?? '{}')) as Record<string, Record<string, unknown>>;
    const out: Record<string, ReglasParrilla> = {};
    for (const [id, r] of Object.entries(o)) {
      out[id] = {
        ver: r['ver'] === 'mios' ? 'mios' : 'completo',
        color: COLORES.includes(String(r['color'])) ? String(r['color']) : 'gris',
        categorias: (Array.isArray(r['categorias']) ? r['categorias'] : []).map(String),
        productos: enteros(r['productos']),
        tipos: (Array.isArray(r['tipos']) ? r['tipos'] : []).map(String).filter((t) => TIPOS.includes(t)),
        usuarios: enteros(r['usuarios']),
      };
    }
    return out;
  } catch { return {}; }
}

/** ¿Están encendidas las parrillas en esta empresa? (por defecto no) */
export async function parrillasActivas(nid: number): Promise<boolean> {
  const r = await filas("SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = 'parrillas_activo'", [nid]);
  return r[0]?.['valor'] === '1';
}

/** Parrillas con sus reglas, en su orden. */
export async function parrillasDe(nid: number): Promise<Array<{ id: number; nombre: string } & ReglasParrilla>> {
  const [est, aj] = await Promise.all([
    filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [nid]),
    filas("SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = 'parrillas_reglas'", [nid]),
  ]);
  const reglas = leerReglas(aj[0]?.['valor']);
  return est.map((e) => ({ id: Number(e['id']), nombre: String(e['nombre']), ...(reglas[String(e['id'])] ?? VACIAS) }));
}

async function estado(nid: number) {
  const [activo, parrillas, categorias, productos, usuarios] = await Promise.all([
    parrillasActivas(nid),
    parrillasDe(nid),
    filas('SELECT nombre FROM categorias WHERE negocio_id = ? ORDER BY orden, id', [nid]),
    filas('SELECT p.id, p.nombre, c.nombre AS categoria FROM productos p JOIN categorias c ON c.id = p.categoria_id WHERE p.negocio_id = ? ORDER BY c.orden, c.id, p.nombre', [nid]),
    filas("SELECT id, nombre, usuario, rol FROM usuarios WHERE negocio_id = ? AND activo = 1 AND rol = 'taquero' ORDER BY nombre", [nid]),
  ]);
  return {
    ok: true, activo, parrillas,
    categorias: categorias.map((k) => String(k['nombre'])),
    productos: productos.map((p) => ({ id: Number(p['id']), nombre: String(p['nombre']), categoria: String(p['categoria']) })),
    usuarios: usuarios.map((u) => ({ id: Number(u['id']), nombre: String(u['nombre']), usuario: String(u['usuario']), rol: String(u['rol']) })),
  };
}

export async function rutasParrillas(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/parrillas',
    handler: async (req) => {
      await requerirRol(req, 'admin');
      const nid = req.negocio.id;
      if (req.method === 'GET') return estado(nid);
      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);
      if (String(d['accion'] ?? '') !== 'guardar') throw fallo('Acción no reconocida.');

      const bruto = Array.isArray(d['parrillas']) ? (d['parrillas'] as Record<string, unknown>[]) : [];
      if (bruto.length > MAX_PARRILLAS) throw fallo(`Máximo ${MAX_PARRILLAS} parrillas.`);
      const categoriasValidas = new Set((await filas('SELECT nombre FROM categorias WHERE negocio_id = ?', [nid])).map((f) => String(f['nombre'])));
      const productosValidos = new Set((await filas('SELECT id FROM productos WHERE negocio_id = ?', [nid])).map((f) => Number(f['id'])));
      const usuariosValidos = new Set((await filas('SELECT id FROM usuarios WHERE negocio_id = ?', [nid])).map((f) => Number(f['id'])));
      const existentes = new Set((await filas('SELECT id FROM estaciones WHERE negocio_id = ?', [nid])).map((f) => Number(f['id'])));
      const nombres = new Set<string>();

      await transaccion(async (tx) => {
        const reglas: Record<string, ReglasParrilla> = {};
        const quedan = new Set<number>();
        let orden = 0;
        for (const x of bruto) {
          orden += 1;
          const nombre = String(x['nombre'] ?? '').trim();
          if (nombre === '' || largo(nombre) > 40) throw fallo(`La parrilla ${orden} necesita un nombre (máximo 40 letras).`);
          if (nombres.has(nombre.toLowerCase())) throw fallo(`Ya hay otra parrilla llamada «${nombre}».`);
          nombres.add(nombre.toLowerCase());
          let id = Number(x['id']);
          if (existentes.has(id)) {
            await tx.ejecutar('UPDATE estaciones SET nombre = ?, orden = ? WHERE id = ? AND negocio_id = ?', [nombre, orden, id, nid]);
          } else {
            id = (await tx.ejecutar('INSERT INTO estaciones (negocio_id, nombre, orden) VALUES (?, ?, ?)', [nid, nombre, orden])).insertId;
          }
          quedan.add(id);
          reglas[String(id)] = {
            ver: x['ver'] === 'mios' ? 'mios' : 'completo',
            color: COLORES.includes(String(x['color'])) ? String(x['color']) : 'gris',
            categorias: [...new Set((Array.isArray(x['categorias']) ? x['categorias'] : []).map(String).filter((k) => categoriasValidas.has(k)))],
            productos: [...new Set(enteros(x['productos']).filter((p) => productosValidos.has(p)))],
            tipos: [...new Set((Array.isArray(x['tipos']) ? x['tipos'] : []).map(String).filter((t) => TIPOS.includes(t)))],
            usuarios: [...new Set(enteros(x['usuarios']).filter((u) => usuariosValidos.has(u)))],
          };
        }
        for (const id of existentes) if (!quedan.has(id)) await tx.ejecutar('DELETE FROM estaciones WHERE id = ? AND negocio_id = ?', [id, nid]);
        const guardar = (clave: string, valor: string) =>
          tx.ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, clave, valor]);
        await guardar('parrillas_reglas', JSON.stringify(reglas));
        await guardar('parrillas_activo', noVacio(d['activo']) ? '1' : '0');
      });
      return estado(nid);
    },
  });
}

/** ¿A qué parrilla va este platillo? La PRIMERA (en su orden) cuyas reglas lo aceptan; null = sin parrilla.
 *  Una parrilla acepta un platillo si coincide su categoría o el platillo está en su lista; sin categorías ni platillos acepta
 *  todo lo que cumpla su tipo de pedido; una parrilla sin ninguna regla no acepta nada. */
export function parrillaDeRenglon(parrillas: Array<{ id: number } & ReglasParrilla>, categoria: unknown, productoId: number | null, modalidad: string): number | null {
  for (const p of parrillas) {
    if (!p.categorias.length && !p.productos.length && !p.tipos.length) continue;
    if (p.tipos.length && !p.tipos.includes(modalidad)) continue;
    if (p.categorias.length || p.productos.length) {
      const porCategoria = p.categorias.includes(String(categoria ?? ''));
      const porPlatillo = productoId !== null && p.productos.includes(productoId);
      if (!porCategoria && !porPlatillo) continue;
    }
    return p.id;
  }
  return null;
}

/** Parrillas que puede tocar un usuario: null = sin restricción (administrador, gerente, parrillas apagadas o sin parrillas asignadas). */
export async function parrillasPermitidas(nid: number, usuarioId: number, rol: string): Promise<number[] | null> {
  if (rol === 'admin' || rol === 'gerente') return null;
  if (!(await parrillasActivas(nid))) return null;
  const mias = (await parrillasDe(nid)).filter((p) => p.usuarios.includes(usuarioId)).map((p) => p.id);
  return mias.length ? mias : null;
}
