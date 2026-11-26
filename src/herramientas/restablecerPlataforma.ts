/**
 * Herramienta de línea de comandos: pone una contraseña nueva a un administrador de plataforma existente.
 * Muestra los usuarios existentes y pide la contraseña oculta (no se ve ni queda en el historial).
 *
 *   docker exec -it <contenedor> node dist/herramientas/restablecerPlataforma.js
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { cerrarBd, ejecutar, filas } from '../db.js';

async function preguntar(texto: string, oculto = false): Promise<string> {
  let silenciar = false;
  const salida = new Writable({
    write(chunk, _enc, cb) {
      if (!silenciar) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: salida, terminal: true });
  process.stdout.write(texto);
  silenciar = oculto;
  const r = await rl.question('');
  silenciar = false;
  if (oculto) process.stdout.write('\n');
  rl.close();
  return r;
}

try {
  const admins = await filas('SELECT usuario, nombre, activo FROM plataforma_admins ORDER BY id');
  if (admins.length === 0) {
    console.log('No hay administradores. Usa primero: crear-plataforma.');
  } else {
    console.log('Administradores de plataforma:');
    for (const a of admins) console.log(`  usuario: ${a['usuario']}  (${a['nombre']})${Number(a['activo']) ? '' : '  [inactivo]'}`);
    const usuario = (await preguntar('Usuario actual a modificar: ')).trim().toLowerCase();
    const nombreNuevo = (await preguntar('Nombre nuevo (Enter para dejarlo igual): ')).trim();
    const usuarioNuevo = (await preguntar('Usuario nuevo (Enter para dejarlo igual): ')).trim().toLowerCase();
    const password = await preguntar('Contraseña nueva (mínimo 10 caracteres): ', true);
    const confirmar = await preguntar('Repite la contraseña: ', true);
    const errores: string[] = [];
    if (usuarioNuevo !== '' && !/^[a-z0-9._-]{3,40}$/.test(usuarioNuevo)) errores.push('El usuario nuevo debe tener de 3 a 40 caracteres: minúsculas, números, punto, guion o guion bajo.');
    if ([...nombreNuevo].length > 80) errores.push('El nombre es muy largo (máximo 80).');
    if (password.length < 10) errores.push('La contraseña debe tener al menos 10 caracteres.');
    if (password !== confirmar) errores.push('Las contraseñas no coinciden.');
    if (errores.length > 0) {
      for (const e of errores) console.error('•', e);
      process.exitCode = 1;
    } else {
      try {
        const r = await ejecutar(
          'UPDATE plataforma_admins SET password_hash = ?, activo = 1, nombre = COALESCE(NULLIF(?, ""), nombre), usuario = COALESCE(NULLIF(?, ""), usuario) WHERE usuario = ?',
          [await bcrypt.hash(password, 10), nombreNuevo, usuarioNuevo, usuario],
        );
        console.log(r.affectedRows > 0 ? `Listo: datos actualizados. Entra con el usuario ${usuarioNuevo || usuario}.` : 'Ese usuario no existe.');
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e).includes('Duplicate') ? 'Ese usuario nuevo ya existe.' : `No se pudo: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }
  }
} catch (e) {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cerrarBd();
}
