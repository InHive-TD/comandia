import { rutasManifiesto } from './manifiesto.js';
import { avisarAlGuardar, rutasEventos } from '../eventos.js';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { contextoNegocio, csrfToken, cuerpoJson, requerirRol, resolverSucursal, sesionDeNegocio, usuarioActual, verificarCsrf } from '../auth.js';
import { config } from '../config.js';
import { ejecutar, fila } from '../db.js';
import { ErrorHttp } from '../errores.js';
import { sucursalesActivas } from '../negocio.js';
import { efectivo, estadoPedidosCliente, pestanasCliente, pestanasDe } from '../pedidosClientes.js';
import { rutasAdminProductos } from './admin/productos.js';
import { rutasAdminImportar } from './admin/importar.js';
import { rutasCategorias } from './admin/categorias.js';
import { rutasEstaciones } from './admin/estaciones.js';
import { rutasExtras } from './admin/extras.js';
import { rutasAdminMesas } from './admin/mesas.js';
import { rutasSucursales } from './admin/sucursales.js';
import { rutasUsuarios } from './admin/usuarios.js';
import { rutasPrioridades } from './admin/prioridades.js';
import { rutasTiempos } from './admin/tiempos.js';
import { rutasCaja } from './caja.js';
import { rutasCocina } from './cocina.js';
import { rutasClientePedidos } from './admin/clientePedidos.js';
import { rutasMarca } from './admin/marca.js';
import { rutasReportes } from './admin/reportes.js';
import { rutasCliente } from './cliente.js';
import { rutasTema } from './tema.js';
import { rutasMenu } from './menu.js';
import { rutasOrdenes } from './ordenes.js';

/** Hash falso para tardar lo mismo cuando el usuario no existe (no delatar qué usuarios hay). */
const HASH_RELLENO = bcrypt.hashSync('relleno-para-igualar-tiempos', 10);
/** Minutos sin actividad después de los cuales una sesión abandonada deja de bloquear al usuario. */
const MINUTOS_SESION_ACTIVA = 15;
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function rutasEmpresa(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', avisarAlGuardar);
  await app.register(rutasEventos);
  await app.register(rutasManifiesto);
  // Menú y administración del catálogo (cada archivo documenta sus reglas y permisos)
  for (const grupo of [rutasMenu, rutasCategorias, rutasEstaciones, rutasExtras, rutasAdminProductos, rutasAdminImportar, rutasSucursales, rutasAdminMesas, rutasUsuarios, rutasOrdenes, rutasCocina, rutasCaja, rutasPrioridades, rutasTiempos, rutasMarca, rutasReportes, rutasCliente, rutasTema, rutasClientePedidos]) {
    await app.register(grupo);
  }

  /** Datos públicos para la pantalla del cliente (QR): nombre y sucursales. */
  app.get('/negocio', async (req) => {
    const estado = await estadoPedidosCliente(req.negocio.id);
    const pest = await pestanasCliente(req.negocio.id);
    return {
      ok: true,
      negocio: { nombre: req.negocio.nombre, slug: req.negocio.slug },
      // `pedidos`: ¿el cliente puede levantar su pedido desde el QR en esa sucursal, o solo ver el menú?
      // `ver_pedido` / `ver_pagar`: ¿se muestran las pestañas "Mi pedido" y "Pagar"?
      sucursales: (await sucursalesActivas(req.negocio.id)).map((s) => ({ id: s.id, slug: s.slug, nombre: s.nombre, pedidos: efectivo(estado, s.id), ver_pedido: pestanasDe(pest, s.id).verPedido, ver_pagar: pestanasDe(pest, s.id).verPagar })),
    };
  });

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
      sucursales: usuario && usuario.sucursalesPermitidas === null ? lista : lista.filter((s) => s.id === suc),
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

    // Un usuario solo puede estar en UN dispositivo a la vez. Se considera "abierta" otra sesión del mismo usuario
    // si tuvo actividad en los últimos MINUTOS_SESION_ACTIVA minutos (cada petición renueva su caducidad).
    // Al cerrar sesión se libera al instante; si el otro dispositivo solo se abandonó, se libera solo al pasar ese tiempo.
    const otra = await fila(
      `SELECT COUNT(*) AS n FROM sesiones
        WHERE contexto = ? AND id <> ? AND JSON_EXTRACT(datos, '$.usuario_id') = ?
          AND expira_en > DATE_ADD(NOW(), INTERVAL ? SECOND)`,
      [contextoNegocio(req).cookie, ses.id, Number(f['id']), config.sesionSegundos - MINUTOS_SESION_ACTIVA * 60],
    );
    if (Number(otra?.['n']) > 0) {
      throw new ErrorHttp(409, 'sesion_activa', 'Este usuario ya tiene una sesión abierta en otro dispositivo. Cierra esa sesión o pide al administrador que cree un usuario nuevo para este dispositivo.');
    }

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
   * Sucursal con la que trabaja la persona: el dueño elige entre todas; el personal, entre las suyas (casi siempre una sola).
   * GET → { sucursales, actual } · POST { sucursal_id } → cambia de sucursal (solo entre las permitidas).
   */
  app.route({
    method: ['GET', 'POST'],
    url: '/sucursal',
    handler: async (req) => {
      const u = await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
      let actual = u.sucursalActiva;
      if (req.method === 'POST') {
        const id = Number(cuerpoJson(req)['sucursal_id'] ?? 0);
        if (u.sucursalesPermitidas !== null && u.sucursalesPermitidas.length < 2) throw new ErrorHttp(403, 'sin_permiso', 'Tu usuario trabaja en una sola sucursal.');
        const activas = await sucursalesActivas(req.negocio.id);
        if (!activas.some((s) => s.id === id)) throw new ErrorHttp(404, 'validacion', 'Esa sucursal no existe.');
        if (u.sucursalesPermitidas !== null && !u.sucursalesPermitidas.includes(id)) throw new ErrorHttp(403, 'sin_permiso', 'No trabajas en esa sucursal.');
        (await sesionDeNegocio(req)).poner('sucursal_id', id);
        actual = id;
      }
      const lista = (await sucursalesActivas(req.negocio.id)).map((s) => ({ id: s.id, nombre: s.nombre, direccion: s.direccion }));
      return { ok: true, sucursales: u.sucursalesPermitidas !== null ? lista.filter((s) => (u.sucursalesPermitidas as number[]).includes(s.id)) : lista, actual };
    },
  });
}

export { contextoNegocio };
