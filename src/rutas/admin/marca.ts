/**
 * Apariencia de la empresa (solo el dueño: rol "admin").
 *   GET  /admin/marca                              → { colores, defecto, nombres, logo: bool }
 *   POST { accion: 'colores', colores: { encabezado, acento, boton, fondo, texto } }
 *   POST { accion: 'restablecer' }                 → vuelve a los colores de Comandia
 *   POST multipart { accion: 'logo', logo: <archivo> }
 *   POST { accion: 'quitar_logo' }
 */
import type { FastifyInstance } from 'fastify';
import { exigirMetodo, requerirRol } from '../../auth.js';
import { ejecutar } from '../../db.js';
import { fallo } from '../../errores.js';
import { leerFormulario } from '../../formulario.js';
import { CLAVES_COLOR, MARCA_DEFECTO, MARCA_NOMBRES, borrarLogo, contraste, hexValido, marcaColores, procesarLogo, textoSobre } from '../../marca.js';

const guardar = (nid: number, clave: string, valor: string) =>
  ejecutar('INSERT INTO ajustes (negocio_id, clave, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [nid, clave, valor]);

async function estado(nid: number): Promise<Record<string, unknown>> {
  const { logo, ...colores } = await marcaColores(nid);
  return { ok: true, colores, defecto: MARCA_DEFECTO, nombres: MARCA_NOMBRES, logo: logo !== null };
}

export async function rutasMarca(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/admin/marca',
    handler: async (req) => {
      await requerirRol(req, 'admin');
      const nid = req.negocio.id;
      if (req.method === 'GET') return estado(nid);
      exigirMetodo(req, 'POST');

      // El logo llega como FormData (archivo); lo demás como JSON.
      const esForm = req.isMultipart();
      const form = esForm ? await leerFormulario(req, 'logo') : null;
      const json = esForm ? {} : ((req.body ?? {}) as Record<string, unknown>);
      const accion = esForm ? form!.texto('accion') : String(json['accion'] ?? '');

      switch (accion) {
        case 'colores': {
          const enviados = (json['colores'] ?? {}) as Record<string, unknown>;
          const nuevos = {} as Record<string, string>;
          for (const k of CLAVES_COLOR) {
            const c = hexValido(enviados[k]);
            if (c === null) throw fallo(`Color no válido en «${MARCA_NOMBRES[k]}».`);
            nuevos[k] = c;
          }
          if (contraste(nuevos['texto']!, nuevos['fondo']!) < 4.5) {
            throw fallo('El texto casi no se lee sobre ese fondo. Elige un texto más oscuro con fondo claro, o al revés.');
          }
          for (const [k, c] of Object.entries(nuevos)) await guardar(nid, 'marca_' + k, c);
          const avisos: string[] = [];
          for (const [k, donde] of [['encabezado', 'la barra principal'], ['boton', 'los botones']] as const) {
            if (contraste(nuevos[k]!, textoSobre(nuevos[k]!)) < 4.5) avisos.push(`El texto sobre ${donde} se lee con dificultad; prueba un color más claro o más oscuro.`);
          }
          return { ...(await estado(nid)), avisos };
        }
        case 'restablecer':
          await ejecutar("DELETE FROM ajustes WHERE negocio_id = ? AND clave IN ('marca_encabezado','marca_acento','marca_boton','marca_fondo','marca_texto','marca_llevar')", [nid]);
          return estado(nid);
        case 'logo': {
          if (!form?.foto) throw fallo('Elige una imagen para el logo.');
          const anterior = (await marcaColores(nid)).logo;
          const nombre = await procesarLogo(form.foto, nid);
          await guardar(nid, 'marca_logo', nombre);
          await borrarLogo(anterior, nid);
          return estado(nid);
        }
        case 'quitar_logo': {
          const anterior = (await marcaColores(nid)).logo;
          await ejecutar("DELETE FROM ajustes WHERE negocio_id = ? AND clave = 'marca_logo'", [nid]);
          await borrarLogo(anterior, nid);
          return estado(nid);
        }
        default:
          throw fallo('Acción no reconocida.');
      }
    },
  });
}
