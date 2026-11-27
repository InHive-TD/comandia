import { rutasManifiesto } from './manifiesto.js';
import { avisarAlGuardar, rutasEventos } from '../eventos.js';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { contextoNegocio, csrfToken, cuerpoJson, requerirRol, resolverSucursal, sesionDeNegocio, usuarioActual, verificarCsrf } from '../auth.js';
import { config } from '../config.js';
import { ejecutar, fila, filas } from '../db.js';
import { ErrorHttp } from '../errores.js';
import { sucursalesActivas } from '../negocio.js';
import { efectivo, estadoPedidosCliente, pestanasCliente, pestanasDe } from '../pedidosClientes.js';
import { rutasAdminProductos } from './admin/productos.js';
import { rutasAdminImportar } from './admin/importar.js';
import { rutasCategorias } from './admin/categorias.js';
import { rutasEstaciones } from './admin/estaciones.js';
import { rutasExtras } from './admin/extras.js';
import { mesasParaElegir } from '../plano.js';
import { rutasAdminMesas } from './admin/mesas.js';
import { rutasAdminInventario } from './admin/inventario.js';
import { rutasSucursales } from './admin/sucursales.js';
import { rutasUsuarios } from './admin/usuarios.js';
import { rutasAcceso } from '../acceso.js';
import { rutasPrioridades } from './admin/prioridades.js';
import { rutasTiempos } from './admin/tiempos.js';
import { rutasCaja } from './caja.js';
import { rutasCocina } from './cocina.js';
import { rutasClientePedidos } from './admin/clientePedidos.js';
import { rutasClienteConfig } from './admin/clienteConfig.js';
import { rutasAdminPlano } from './admin/plano.js';
import { cargarAjustesCliente, configEfectiva } from '../clienteConfig.js';
import { rutasMarca } from './admin/marca.js';
import { rutasReportes } from './admin/reportes.js';
import { rutasCliente } from './cliente.js';
import { rutasTema } from './tema.js';
import { rutasMenu } from './menu.js';
import { rutasPerfil } from './perfil.js';
import { rutasOrdenes } from './ordenes.js';
import { rutasVoz } from './voz.js';

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
  for (const grupo of [rutasPerfil, rutasMenu, rutasCategorias, rutasEstaciones, rutasExtras, rutasAdminProductos, rutasAdminImportar, rutasSucursales, rutasAdminMesas, rutasUsuarios, rutasOrdenes, rutasVoz, rutasCocina, rutasCaja, rutasPrioridades, rutasTiempos, rutasMarca, rutasReportes, rutasCliente, rutasTema, rutasClientePedidos, rutasClienteConfig, rutasAdminPlano, rutasAdminInventario, rutasAcceso]) {
    await app.register(grupo);
  }

  /** Datos públicos para la pantalla del cliente (QR): nombre y sucursales. */
  app.get('/negocio', async (req) => {
    const estado = await estadoPedidosCliente(req.negocio.id);
    const pest = await pestanasCliente(req.negocio.id);
    const ajustesCliente = await cargarAjustesCliente(req.negocio.id);
    const sucs = await sucursalesActivas(req.negocio.id);
    const mesasPor = new Map(await Promise.all(sucs.map(async (s) => [s.id, await mesasParaElegir(req.negocio.id, s.id)] as const)));
    return {
      ok: true,
      negocio: { nombre: req.negocio.nombre, slug: req.negocio.slug },
      // `pedidos`: ¿el cliente puede levantar su pedido desde el QR en esa sucursal, o solo ver el menú?
      // `ver_pedido` / `ver_pagar`: ¿se muestran las pestañas "Mi pedido" y "Pagar"?
      sucursales: sucs.map((s) => ({ id: s.id, slug: s.slug, nombre: s.nombre, pedidos: efectivo(estado, s.id), ver_pedido: pestanasDe(pest, s.id).verPedido, ver_pagar: pestanasDe(pest, s.id).verPagar, ver_menu: pestanasDe(pest, s.id).verMenu, ...(() => { const c = configEfectiva(ajustesCliente, s.id); return { modalidades: c.modalidades, mixto: c.mixto, pago: c.pago, transferencia: c.transferencia, mesa: c.mesa, ...(() => { const m = mesasPor.get(s.id)!; return { mesas: m.mesas, zonas: m.zonas, plano: m.plano }; })() }; })() })),
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
      usuario: usuario ? { nombre: usuario.nombre, rol: usuario.rol, foto: ((await fila('SELECT foto FROM usuarios WHERE id = ? AND negocio_id = ?', [usuario.id, req.negocio.id]))?.['foto'] as string | null) ?? null } : null,
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
    if (!usuario || !password || [...usuario].length > 150 || password.length > 200) {
      throw new ErrorHttp(400, 'datos', 'Escribe tu usuario o correo y tu contraseña.');
    }
    const nid = req.negocio.id;
    const ip = req.ip.slice(0, 45);

    await ejecutar('DELETE FROM intentos_login WHERE creado_en < (NOW() - INTERVAL 1 DAY)');
    const porIp = await fila('SELECT COUNT(*) AS n FROM intentos_login WHERE negocio_id = ? AND ip = ? AND creado_en > (NOW() - INTERVAL 10 MINUTE)', [nid, ip]);
    if (Number(porIp?.['n']) >= 20) {
      throw new ErrorHttp(429, 'bloqueado', 'Demasiados intentos desde esta conexión. Espera 10 minutos e inténtalo de nuevo.');
    }

    const f = await fila('SELECT id, nombre, rol, password_hash, clave_pendiente, bloqueado, nivel_bloqueo, fallos_login, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), bloqueo_hasta)) AS espera FROM usuarios WHERE negocio_id = ? AND (usuario = ? OR correo = ?) AND activo = 1', [nid, usuario, usuario]);
    if (f && Number(f['bloqueado']) === 1) {
      throw new ErrorHttp(423, 'bloqueado', 'Esta cuenta está bloqueada por seguridad. Pide a tu administrador que la desbloquee.');
    }
    if (f && Number(f['espera']) > 0) {
      const min = Math.ceil(Number(f['espera']) / 60);
      throw new ErrorHttp(429, 'bloqueado', `Cuenta bloqueada temporalmente por demasiados intentos. Vuelve a intentar en ${min} minuto${min === 1 ? '' : 's'}.`);
    }
    if (f && Number(f['clave_pendiente']) === 1) {
      throw new ErrorHttp(403, 'clave_pendiente', 'Aún no creas tu contraseña. Abre el correo de invitación o pide al administrador que te lo reenvíe.');
    }
    // bcryptjs entiende los hashes "$2y$" que generó PHP, así que los usuarios existentes siguen entrando.
    const correcto = await bcrypt.compare(password, f ? String(f['password_hash']) : HASH_RELLENO);
    if (!f || !correcto) {
      await ejecutar('INSERT INTO intentos_login (negocio_id, ip, usuario) VALUES (?, ?, ?)', [nid, ip, usuario.slice(0, 40)]);
      await esperar(400);
      if (f) {
        // Escalera de bloqueos: 3 fallos seguidos → 5 min; otros 3 → 1 hora; otros 3 → bloqueo permanente (lo quita un administrador).
        // Un administrador general nunca queda bloqueado para siempre (nadie podría desbloquearlo): se repite la hora.
        const fallos = Number(f['fallos_login']) + 1;
        if (fallos < 3) {
          await ejecutar('UPDATE usuarios SET fallos_login = ? WHERE id = ?', [fallos, Number(f['id'])]);
        } else {
          const nivel = Number(f['nivel_bloqueo']) + 1;
          const permanente = nivel >= 3 && String(f['rol']) !== 'admin';
          const minutos = nivel === 1 ? 5 : 60;
          await ejecutar(
            'UPDATE usuarios SET fallos_login = 0, nivel_bloqueo = ?, bloqueado = ?, bloqueo_hasta = ' + (permanente ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? MINUTE)') + ' WHERE id = ?',
            permanente ? [Math.min(nivel, 3), 1, Number(f['id'])] : [Math.min(nivel, 2), 0, minutos, Number(f['id'])],
          );
          throw new ErrorHttp(permanente ? 423 : 429, 'bloqueado', permanente
            ? 'Demasiados intentos fallidos: la cuenta quedó bloqueada. Pide a tu administrador que la desbloquee.'
            : `Demasiados intentos fallidos. La cuenta queda bloqueada ${minutos === 5 ? '5 minutos' : '1 hora'}.`);
        }
      }
      throw new ErrorHttp(401, 'credenciales', 'Usuario, correo o contraseña incorrectos.');
    }
    await ejecutar('UPDATE usuarios SET fallos_login = 0, nivel_bloqueo = 0, bloqueo_hasta = NULL WHERE id = ?', [Number(f['id'])]);
    await ejecutar('DELETE FROM intentos_login WHERE negocio_id = ? AND ip = ? AND usuario = ?', [nid, ip, usuario.slice(0, 40)]);

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
