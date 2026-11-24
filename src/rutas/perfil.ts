import type { FastifyInstance } from 'fastify';
import { sesionDeNegocio, usuarioActual, verificarCsrf } from '../auth.js';
import { ejecutar, fila } from '../db.js';
import { ErrorHttp } from '../errores.js';
import { borrarFoto, procesarFoto } from '../fotos.js';
import { leerFormulario } from '../formulario.js';

/** Foto de perfil: cualquier usuario con sesión puede cambiar o quitar la suya (y solo la suya). */
export async function rutasPerfil(app: FastifyInstance): Promise<void> {
  app.post('/perfil/foto', async (req) => {
    const u = await usuarioActual(req);
    if (!u) throw new ErrorHttp(401, 'no_autenticado', 'Inicia sesión para continuar.');
    verificarCsrf(req, await sesionDeNegocio(req));
    const nid = req.negocio.id;
    const f = await leerFormulario(req);
    const previa = ((await fila('SELECT foto FROM usuarios WHERE id = ? AND negocio_id = ?', [u.id, nid]))?.['foto'] as string | null) ?? null;

    if (f.texto('accion') === 'quitar') {
      await ejecutar('UPDATE usuarios SET foto = NULL WHERE id = ? AND negocio_id = ?', [u.id, nid]);
      await borrarFoto(previa, nid);
      return { ok: true, foto: null };
    }
    if (!f.foto) throw new ErrorHttp(400, 'validacion', 'Elige una foto.');
    const nueva = await procesarFoto(f.foto, nid, true);
    await ejecutar('UPDATE usuarios SET foto = ? WHERE id = ? AND negocio_id = ?', [nueva, u.id, nid]);
    await borrarFoto(previa, nid);
    return { ok: true, foto: nueva };
  });
}
