import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { contextoNegocio, csrfToken, cuerpoJson, requerirRol, resolverSucursal, sesionDeNegocio, usuarioActual, verificarCsrf } from '../auth.js';
import { ejecutar, fila } from '../db.js';
import { ErrorHttp } from '../errores.js';
import { sucursalesActivas } from '../negocio.js';

/** Hash falso para tardar lo mismo cuando el usuario no existe (no delatar qué usuarios hay). */
const HASH_RELLENO = bcrypt.hashSync('relleno-para-igualar-tiempos', 10);
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function rutasEmpresa(app: FastifyInstance): Promise<void> {
  /** Datos públicos para la pantalla del cliente (QR): nombre y sucursales. */
  app.get('/negocio', async (req) => ({
    ok: true,
    negocio: { nombre: req.negocio.nombre, slug: req.negocio.slug },
    sucursales: (await sucursalesActivas(req.negocio.id)).map((s) => ({ id: s.id, nombre: s.nombre })),
  }));

  /** ¿Hay sesión iniciada? También entrega el código CSRF. */
  app.get('/sesion', async (req) => {
    const ses = await sesionDeNegocio(req);
    const usuario = await usuarioActual(req);
    const suc = usuario ? await resolverSucursal(req, usuario) : 0;
    const lista = await sucursalesActivas(req.negocio.id);
    return {
      ok: true,
      autenticado: usuario !== null,
      usuario: usuario ? { nombre: usuario.nombre, rol: usuario.rol } : null,
      negocio: { nombre: req.negocio.nombre, slug: req.negocio.slug },
      sucursal: suc || null,
      sucursales: usuario && usuario.sucursalId === null ? lista : lista.filter((s) => s.id === suc),
      csrf: csrfToken(ses),
    };
  });

  /**
   * Inicio de sesión. Protecciones: hash bcrypt, mensaje genérico, límite de intentos
   * (5 por usuario y 20 por conexión cada 10 minutos) y nuevo identificador de sesión al entrar.
   */
  app.post('/login', async (req) => {
    const ses = await sesionDeNegocio(req);
    verificarCsrf(req, ses);
    const d = cuerpoJson(req);
    const usuario = String(d['usuario'] ?? '').trim();
    const password = String(d['password'] ?? '');
    if (!usuario || !password || [...usuario].length > 40 || password.length > 200) {
      throw new ErrorHttp(400, 'datos', 'Escribe tu usuario y contraseña.');
    }
    const nid = req.negocio.id;
    const ip = req.ip.slice(0, 45);

    await ejecutar('DELETE FROM intentos_login WHERE creado_en < (NOW() - INTERVAL 1 DAY)');
    const porUsuario = await fila(
      'SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND ip = ? AND usuario = ? AND creado_en > (NOW() - INTERVAL 10 MINUTE)',
      [nid, ip, usuario],
    );
    const porIp = await fila('SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND ip = ? AND creado_en > (NOW() - INTERVAL 10 MINUTE)', [nid, ip]);
    if (Number(porUsuario?.['n']) >= 5 || Number(porIp?.['n']) >= 20) {
      throw new ErrorHttp(429, 'bloqueado', 'Demasiados intentos. Espera 10 minutos e inténtalo de nuevo.');
    }

    const f = await fila('SELECT id, nombre, rol, password_hash FROM usuarios WHERE negocio_id = ? AND usuario = ? AND activo = 1', [nid, usuario]);
    // bcryptjs entiende los hashes "$2y$" que generó PHP, así que los usuarios existentes siguen entrando.
    const correcto = await bcrypt.compare(password, f ? String(f['password_hash']) : HASH_RELLENO);
    if (!f || !correcto) {
      await ejecutar('INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, ?)', [nid, ip, usuario]);
      await esperar(400);
      throw new ErrorHttp(401, 'credenciales', 'Usuario o contraseña incorrectos.');
    }
    await ejecutar('DELETE FROM intentos_login WHERE negocio_id = ? AND ip = ? AND usuario = ?', [nid, ip, usuario]);

    ses.regenerar();
    ses.poner('usuario_id', Number(f['id']));
    ses.poner('negocio_id', nid);
    return { ok: true, usuario: { nombre: String(f['nombre']), rol: String(f['rol']) }, csrf: csrfToken(ses) };
  });

  app.post('/logout', async (req) => {
    const ses = await sesionDeNegocio(req);
    verificarCsrf(req, ses);
    ses.destruir();
    return { ok: true };
  });

  /**
   * Sucursal con la que trabaja el administrador (el personal tiene una sola, fija).
   * GET → { sucursales, actual } · POST { sucursal_id } → el administrador cambia de sucursal.
   */
  app.route({
    method: ['GET', 'POST'],
    url: '/sucursal',
    handler: async (req) => {
      const u = await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
      let actual = u.sucursalActiva;
      if (req.method === 'POST') {
        const id = Number(cuerpoJson(req)['sucursal_id'] ?? 0);
        if (u.sucursalId !== null) throw new ErrorHttp(403, 'sin_permiso', 'Tu usuario trabaja en una sola sucursal.');
        const activas = await sucursalesActivas(req.negocio.id);
        if (!activas.some((s) => s.id === id)) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        (await sesionDeNegocio(req)).poner('sucursal_id', id);
        actual = id;
      }
      const lista = (await sucursalesActivas(req.negocio.id)).map((s) => ({ id: s.id, nombre: s.nombre, direccion: s.direccion }));
      return { ok: true, sucursales: u.sucursalId !== null ? lista.filter((s) => s.id === u.sucursalId) : lista, actual };
    },
  });
}

export { contextoNegocio };
