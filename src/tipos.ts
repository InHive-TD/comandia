import type { Negocio } from './negocio.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Empresa de la ruta /:slug/... (la fija el hook de las rutas de empresa). */
    negocio: Negocio;
    /** Sucursal con la que trabaja esta petición (la fija requerirRol o la sucursal pública del QR). */
    sucursalId: number;
  }
}
