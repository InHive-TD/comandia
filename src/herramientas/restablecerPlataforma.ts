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
    const usuario = (await preguntar('Usuario a restablecer: ')).trim().toLowerCase();
    const password = await preguntar('Contraseña nueva (mínimo 10 caracteres): ', true);
    const confirmar = await preguntar('Repite la contraseña: ', true);
    if (password.length < 10) console.error('• La contraseña debe tener al menos 10 caracteres.');
    else if (password !== confirmar) console.error('• Las contraseñas no coinciden.');
    else {
      const r = await ejecutar('UPDATE plataforma_admins SET password_hash = ?, activo = 1 WHERE usuario = ?', [await bcrypt.hash(password, 10), usuario]);
      console.log(r.affectedRows > 0 ? 'Listo: contraseña actualizada.' : 'Ese usuario no existe.');
    }
  }
} catch (e) {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cerrarBd();
}
