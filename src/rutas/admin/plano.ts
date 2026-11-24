/**
 * Plano visual de mesas por sucursal: zonas (Piso 1, Patio, Comedor…) y la posición de cada mesa dentro de su zona.
 *
 *   GET  /admin/plano?sucursal=ID → { puede_general, general_activo, sucursales, sucursal, activo, activo_propio, zonas, mesas }
 *   POST { accion: 'activar', ambito: 'general'|'sucursal', sucursal_id?, activo }   usar (o no) el plano al elegir mesa
 *        { accion: 'zona_crear', sucursal_id, nombre } · { accion: 'zona_renombrar', id, nombre } · { accion: 'zona_eliminar', id }
 *        { accion: 'guardar', sucursal_id, mesas: [{ id, zona_id|null, x, y, forma, ancho_cm, alto_cm }], zonas?: [{ id, poligono|null, ancho_m }] }
 *
 * El dueño trabaja con cualquier sucursal; el gerente solo con la suya. Quitar una zona NO borra sus mesas: quedan «sin ubicar».
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirGestion } from '../../auth.js';
import { ejecutar, fila, filas, transaccion } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { formaMesa, leerPoligono, planoActivoEn, planoDe } from '../../plano.js';
import { esDuplicado, entero, largo, noVacio } from '../../util.js';

export async function rutasAdminPlano(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/plano',
    handler: async (req, reply) => {
      const yo = await requerirGestion(req);
      const nid = req.negocio.id;
      const alcance = yo.alcance;

      const sucursalPropia = async (pedida: number): Promise<number> => {
        let id = alcance ?? pedida;
        if (!id) id = Number((await fila('SELECT id FROM sucursales WHERE negocio_id = ? AND activa = 1 ORDER BY orden, id LIMIT 1', [nid]))?.['id'] ?? 0);   // sin sucursal pedida: la primera
        const s = await fila('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [id, nid]);
        if (!s) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        return id;
      };

      const estado = async (sid: number) => {
        const sucs = await filas(`SELECT id, nombre FROM sucursales WHERE negocio_id = ? AND activa = 1${alcance !== null ? ` AND id = ${Math.trunc(alcance)}` : ''} ORDER BY orden, id`, [nid]);
        const aj = await filas("SELECT clave, valor FROM ajustes WHERE negocio_id = ? AND clave IN ('plano_mesas', ?)", [nid, `plano_mesas@${sid}`]);
        return {
          ok: true,
          puede_general: alcance === null,
          general_activo: aj.find((f) => f['clave'] === 'plano_mesas')?.['valor'] === '1',
          sucursales: sucs.map((s) => ({ id: Number(s['id']), nombre: s['nombre'] })),
          sucursal: sid,
          activo: await planoActivoEn(nid, sid),
          activo_propio: aj.find((f) => f['clave'] === `plano_mesas@${sid}`) ? aj.find((f) => f['clave'] === `plano_mesas@${sid}`)?.['valor'] === '1' : null,
          ...(await planoDe(nid, sid, false)),
        };
      };

      if (req.method === 'GET') {
        const q = req.query as Record<string, unknown>;
        return estado(await sucursalPropia(entero(q['sucursal'])));
      }

      exigirMetodo(req, 'POST');
      const d = cuerpoJson(req);
      const guardarAjuste = (clave: string, valor: string) =>
        ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, clave, valor]);
      /** Zona de esta empresa (y de la sucursal del gerente). */
      const zonaPropia = async (id: number) => {
        const z = await fila('SELECT id, sucursal_id FROM zonas WHERE id = ? AND negocio_id = ?', [id, nid]);
        if (!z || (alcance !== null && Number(z['sucursal_id']) !== alcance)) throw new ErrorHttp(404, 'validacion', 'Esa zona ya no existe.');
        return { id: Number(z['id']), sucursal: Number(z['sucursal_id']) };
      };
      const nombreZona = (v: unknown): string => {
        const n = String(v ?? '').trim();
        if (n === '' || largo(n) > 40) throw fallo('El nombre de la zona es obligatorio (máximo 40 caracteres).');
        return n;
      };

      switch (String(d['accion'] ?? '')) {
        case 'activar': {
          const activo = noVacio(d['activo']) ? '1' : '0';
          if (String(d['ambito'] ?? '') === 'general') {
            if (alcance !== null) throw new ErrorHttp(403, 'validacion', 'Solo el dueño de la empresa puede cambiar esto para toda la empresa.');
            await guardarAjuste('plano_mesas', activo);
            return estado(await sucursalPropia(entero(d['sucursal_id'])));
          }
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          await guardarAjuste(`plano_mesas@${sid}`, activo);
          return estado(sid);
        }
        case 'zona_crear': {
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          const nombre = nombreZona(d['nombre']);
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM zonas WHERE sucursal_id = ?', [sid]);
          try {
            await ejecutar('INSERT INTO zonas (negocio_id, sucursal_id, nombre, orden) VALUES (?, ?, ?, ?)', [nid, sid, nombre, Number(sig?.['n'])]);
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya existe una zona con ese nombre en esta sucursal.');
            throw e;
          }
          reply.code(201);
          return estado(sid);
        }
        case 'zona_renombrar': {
          const z = await zonaPropia(entero(d['id']));
          try {
            await ejecutar('UPDATE zonas SET nombre = ? WHERE id = ? AND negocio_id = ?', [nombreZona(d['nombre']), z.id, nid]);
          } catch (e) {
            if (esDuplicado(e)) throw new ErrorHttp(409, 'validacion', 'Ya existe una zona con ese nombre en esta sucursal.');
            throw e;
          }
          return estado(z.sucursal);
        }
        case 'zona_eliminar': {
          const z = await zonaPropia(entero(d['id']));
          await transaccion(async (t) => {
            await t.ejecutar('UPDATE mesas SET zona_id = NULL, pos_x = NULL, pos_y = NULL WHERE zona_id = ? AND negocio_id = ?', [z.id, nid]);
            await t.ejecutar('DELETE FROM zonas WHERE id = ? AND negocio_id = ?', [z.id, nid]);
          });
          return estado(z.sucursal);
        }
        case 'guardar': {
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          const lista = Array.isArray(d['mesas']) ? (d['mesas'] as Record<string, unknown>[]) : [];
          if (lista.length > 500) throw fallo('Demasiadas mesas en una sola vez.');
          const zonasOk = new Set((await filas('SELECT id FROM zonas WHERE sucursal_id = ? AND negocio_id = ?', [sid, nid])).map((z) => Number(z['id'])));
          const mesasOk = new Set((await filas('SELECT id FROM mesas WHERE sucursal_id = ? AND negocio_id = ?', [sid, nid])).map((m) => Number(m['id'])));
          await transaccion(async (t) => {
            for (const m of lista) {
              const id = entero(m['id']);
              if (!mesasOk.has(id)) continue;
              const zona = m['zona_id'] === null || m['zona_id'] === undefined ? null : entero(m['zona_id']);
              if (zona === null) {
                await t.ejecutar('UPDATE mesas SET zona_id = NULL, pos_x = NULL, pos_y = NULL WHERE id = ?', [id]);
                continue;
              }
              if (!zonasOk.has(zona)) throw fallo('Una de las zonas ya no existe. Recarga la página.');
              const x = Math.min(100, Math.max(0, Number(m['x']) || 0));
              const y = Math.min(100, Math.max(0, Number(m['y']) || 0));
              const forma = formaMesa(m['forma']);
              const medida = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Math.min(800, Math.max(30, Math.round(Number(v)) || 0)) || null);
              await t.ejecutar('UPDATE mesas SET zona_id = ?, pos_x = ?, pos_y = ?, forma = ?, ancho_cm = ?, alto_cm = ? WHERE id = ?', [zona, x.toFixed(2), y.toFixed(2), forma, medida(m['ancho_cm']), medida(m['alto_cm']), id]);
            }
            // Forma de cada zona (puntos del contorno); sin puntos válidos = rectángulo
            for (const z of Array.isArray(d['zonas']) ? (d['zonas'] as Record<string, unknown>[]) : []) {
              const zid = entero(z['id']);
              if (!zonasOk.has(zid)) continue;
              const poli = leerPoligono(z['poligono']);
              const ancho = Math.min(100, Math.max(2, Number(z['ancho_m']) || 10));
              await t.ejecutar('UPDATE zonas SET poligono = ?, ancho_m = ? WHERE id = ?', [poli ? JSON.stringify(poli) : null, ancho.toFixed(1), zid]);
            }
          });
          return estado(sid);
        }
        case 'ejemplo': {
          // Plano de muestra para probar: «Piso 1» con 10 mesas (4 redondas, 2 largas, 4 cuadradas). Reusa mesas que ya se llamen igual.
          const sid = await sucursalPropia(entero(d['sucursal_id']));
          const diseno: [string, number, number, string][] = [
            ['1', 18, 22, 'redonda'], ['2', 40, 22, 'redonda'], ['3', 62, 22, 'redonda'], ['4', 84, 22, 'redonda'],
            ['5', 28, 52, 'rectangular'], ['6', 72, 52, 'rectangular'],
            ['7', 14, 80, 'cuadrada'], ['8', 38, 80, 'cuadrada'], ['9', 62, 80, 'cuadrada'], ['10', 86, 80, 'cuadrada'],
          ];
          await transaccion(async (t) => {
            const z0 = (await t.filas('SELECT id FROM zonas WHERE sucursal_id = ? AND nombre = ?', [sid, 'Piso 1']))[0];
            let zid: number;
            if (z0) zid = Number(z0['id']);
            else {
              const sig = (await t.filas('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM zonas WHERE sucursal_id = ?', [sid]))[0];
              zid = (await t.ejecutar('INSERT INTO zonas (negocio_id, sucursal_id, nombre, orden) VALUES (?, ?, ?, ?)', [nid, sid, 'Piso 1', Number(sig?.['n'])])).insertId;
            }
            for (const [nombre, x, y, forma] of diseno) {
              const m = (await t.filas('SELECT id FROM mesas WHERE sucursal_id = ? AND nombre = ?', [sid, nombre]))[0];
              if (m) await t.ejecutar('UPDATE mesas SET activa = 1, zona_id = ?, pos_x = ?, pos_y = ?, forma = ? WHERE id = ?', [zid, x, y, forma, Number(m['id'])]);
              else {
                const sig = (await t.filas('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM mesas WHERE sucursal_id = ?', [sid]))[0];
                await t.ejecutar('INSERT INTO mesas (negocio_id, sucursal_id, nombre, orden, zona_id, pos_x, pos_y, forma) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [nid, sid, nombre, Number(sig?.['n']), zid, x, y, forma]);
              }
            }
          });
          await guardarAjuste(`plano_mesas@${sid}`, '1');
          return estado(sid);
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
