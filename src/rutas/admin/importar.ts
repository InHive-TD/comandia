/**
 * Carga masiva de platillos desde el portal (dueño y gerente).
 *
 *   GET  /admin/productos-plantilla → descarga la plantilla .xlsx (con las listas de la empresa)
 *   POST /admin/productos-importar  → multipart: planilla (.xlsx), fotos (.zip, opcional) y confirmar ("1" guarda, otro valor
 *                                      solo valida y devuelve la vista previa)
 *
 * La lógica (validar filas, ligar fotos, crear/actualizar) está en src/importacion.ts.
 */
import type { FastifyInstance } from 'fastify';
import { exigirMetodo, requerirGestion } from '../../auth.js';
import { fila } from '../../db.js';
import { ErrorHttp, fallo } from '../../errores.js';
import { aplicarCarga, analizarCarga, generarPlantilla, listasDeLaEmpresa, MAX_PLANILLA, MAX_ZIP } from '../../importacion.js';

export async function rutasAdminImportar(app: FastifyInstance): Promise<void> {
  /* Plantilla de Excel */
  app.get('/admin/productos-plantilla', async (req, reply) => {
    await requerirGestion(req);
    const xlsx = await generarPlantilla(await listasDeLaEmpresa(req.negocio.id));
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="plantilla-platillos.xlsx"')
      .header('Cache-Control', 'no-store')
      .send(xlsx);
  });

  /* Vista previa / importación */
  app.post('/admin/productos-importar', async (req) => {
    const yo = await requerirGestion(req);
    exigirMetodo(req, 'POST');
    if (!req.isMultipart()) throw fallo('Sube la planilla de Excel.');

    let planilla: Buffer | null = null, zip: Buffer | null = null, confirmar = false, destino = 0;
    try {
      for await (const parte of req.parts({ limits: { fileSize: MAX_ZIP, files: 2, fields: 6 } })) {
        if (parte.type === 'file') {
          const buf = await parte.toBuffer();
          if (parte.file.truncated) throw fallo(parte.fieldname === 'fotos' ? 'El ZIP pesa más de 120 MB. Divide la carga en varias.' : 'La planilla es demasiado pesada.');
          if (buf.length === 0) continue;
          if (parte.fieldname === 'planilla') planilla = buf;
          else if (parte.fieldname === 'fotos') zip = buf;
        } else if (parte.fieldname === 'confirmar') {
          confirmar = String(parte.value) === '1';
        } else if (parte.fieldname === 'sucursal') {
          destino = Math.trunc(Number(parte.value)) || 0;
        }
      }
    } catch (e) {
      if (e instanceof ErrorHttp) throw e;
      throw new ErrorHttp(413, 'validacion', 'Los archivos son demasiado pesados para enviarlos. Divide la carga en varias.');
    }
    if (!planilla) throw fallo('Elige la planilla de Excel (.xlsx).');
    if (planilla.length > MAX_PLANILLA) throw fallo('La planilla pesa más de 5 MB. ¿Seguro que no incluiste imágenes dentro del Excel? Las fotos van en el ZIP.');

    // El dueño puede cargar los platillos DIRECTO en una sucursal (quedan como propios de ella); el gerente siempre carga en la suya.
    let alcance = yo.alcance;
    if (alcance === null && destino > 0) {
      const ok = await fila('SELECT id FROM sucursales WHERE id = ? AND negocio_id = ?', [destino, req.negocio.id]);
      if (!ok) throw fallo('Esa sucursal no existe.');
      alcance = destino;
    }
    const ctx = { nid: req.negocio.id, alcance };
    const analisis = await analizarCarga(ctx, planilla, zip);
    if (!confirmar) return { ok: true, confirmado: false, ...analisis.resultado };
    return { ok: true, confirmado: true, ...(await aplicarCarga(ctx, analisis)) };
  });
}
