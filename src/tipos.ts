/**
 * Amplía el tipo de la petición de Fastify con los datos que el servidor le pega durante su recorrido:
 *  - negocio:    la empresa de la ruta /:slug/... (la fija el hook de rutas/empresa en app.ts)
 *  - sucursalId: la sucursal con la que se trabaja (la fijan requerirRol() o fijarSucursalPublica() en auth.ts)
 * Es solo una declaración de tipos: no ejecuta nada.
 */
import type { Negocio } from './negocio.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Empresa de la ruta /:slug/... (la fija el hook de las rutas de empresa). */
    negocio: Negocio;
    /** Sucursal con la que trabaja esta petición (la fija requerirRol o la sucursal pública del QR). */
    sucursalId: number;
  }
}
