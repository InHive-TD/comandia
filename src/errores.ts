/** Un error que se responde al navegador con el mismo formato JSON de siempre: { ok: false, error, mensaje }. */
export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export const fallo = (mensaje: string, estado = 400): ErrorHttp => new ErrorHttp(estado, 'validacion', mensaje);
