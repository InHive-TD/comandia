/**
 * Herramienta de línea de comandos: crea el PRIMER administrador de la plataforma (tú, dueño de Comandia).
 * Entra después en /plataforma/ para dar de alta empresas.
 *
 *   npm run crear-plataforma
 *
 * Seguridad: solo funciona mientras NO exista ningún administrador de plataforma, y solo se puede correr
 * en tu propia computadora o servidor (no es una página web, así que no hace falta clave de instalación).
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { cerrarBd, ejecutar, fila } from '../db.js';
import { esDuplicado } from '../util.js';

/** Lee una línea; con `oculto` no muestra lo que se escribe (contraseñas). */
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
  const hay = Number((await fila('SELECT COUNT(*) AS n FROM plataforma_admins'))?.['n']);
  if (hay > 0) {
    console.log('Ya existe un administrador de plataforma. Esta herramienta ya no hace nada.');
  } else {
    const nombre = (await preguntar('Tu nombre: ')).trim();
    const usuario = (await preguntar('Usuario para entrar (minúsculas, 3 a 40 caracteres): ')).trim().toLowerCase();
    const password = await preguntar('Contraseña (mínimo 10 caracteres): ', true);
    const confirmar = await preguntar('Repite la contraseña: ', true);
    const errores: string[] = [];
    if (nombre === '' || [...nombre].length > 80) errores.push('Escribe tu nombre (máximo 80 caracteres).');
    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) errores.push('El usuario debe tener de 3 a 40 caracteres: letras minúsculas, números, punto, guion o guion bajo.');
    if (password.length < 10) errores.push('La contraseña debe tener al menos 10 caracteres.');
    if (password !== confirmar) errores.push('Las contraseñas no coinciden.');
    if (errores.length > 0) {
      for (const e of errores) console.error('•', e);
      process.exitCode = 1;
    } else {
      try {
        await ejecutar('INSERT INTO plataforma_admins (nombre, usuario, password_hash) VALUES (?, ?, ?)', [nombre, usuario, await bcrypt.hash(password, 10)]);
        console.log(`Listo: ya puedes entrar a /plataforma/ con el usuario ${usuario}.`);
      } catch (e) {
        console.error(esDuplicado(e) ? 'Ese usuario ya existe.' : `No se pudo crear el usuario: ${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }
  }
} catch (e) {
  console.error('No se pudo conectar o la base no tiene las tablas:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cerrarBd();
}
