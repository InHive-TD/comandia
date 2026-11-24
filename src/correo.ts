/**
 * Correo saliente: invitaciones y restablecer contraseña. Usa el buzón SMTP configurado en el .env (SMTP_*).
 * Si no hay SMTP configurado, `correoListo()` es false y el sistema avisa en vez de fallar en silencio.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { marcaColores } from './marca.js';

export const correoListo = (): boolean => config.smtp.host !== '' && config.smtp.usuario !== '' && config.smtp.password !== '' && config.urlPublica !== '';

let transporte: Transporter | null = null;
function transportador(): Transporter {
  transporte ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.usuario, pass: config.smtp.password },
  });
  return transporte;
}

const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const PUESTOS: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente de sucursal', caja: 'Caja', taquero: 'Cocina', mesero: 'Mesero' };

export interface DatosInvitacion {
  para: string;
  nombre: string;
  rol: string;
  negocio: { id: number; slug: string; nombre: string };
  enlace: string;
  /** invitacion = primera vez · restablecer = el administrador reinició la contraseña */
  tipo: 'invitacion' | 'restablecer';
  horas: number;
}

/** Correo con el diseño de la empresa: logo, colores y botón grande «Crear mi contraseña». */
export async function enviarInvitacion(d: DatosInvitacion): Promise<void> {
  const m = await marcaColores(d.negocio.id);
  const logo = `${config.urlPublica}/${d.negocio.slug}/api/logo`;
  const primera = d.tipo === 'invitacion';
  const titulo = primera ? `Te damos la bienvenida a ${d.negocio.nombre}` : 'Restablece tu contraseña';
  const intro = primera
    ? `Te dieron acceso a <b>${esc(d.negocio.nombre)}</b> en Comandia como <b>${esc(PUESTOS[d.rol] ?? 'Equipo')}</b>. Solo falta confirmar tu correo y crear tu contraseña.`
    : `El administrador de <b>${esc(d.negocio.nombre)}</b> reinició tu acceso. Crea una contraseña nueva para volver a entrar.`;
  const boton = primera ? 'Crear mi contraseña' : 'Crear contraseña nueva';
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#eef2ef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2ef;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${m.texto};">
<tr><td align="center" style="background:${m.encabezado};padding:26px 20px 22px;">
  <img src="${esc(logo)}" alt="${esc(d.negocio.nombre)}" height="72" style="display:block;height:72px;max-width:240px;margin:0 auto 10px;">
  <div style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.2px;">${esc(d.negocio.nombre)}</div>
</td></tr>
<tr><td style="padding:30px 28px 8px;">
  <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${m.texto};">${esc(titulo)}</h1>
  <p style="margin:0 0 6px;font-size:16px;line-height:1.55;">Hola <b>${esc(d.nombre)}</b>,</p>
  <p style="margin:0 0 22px;font-size:16px;line-height:1.55;">${intro}</p>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;"><tr><td align="center" style="background:${m.boton};border-radius:12px;">
    <a href="${esc(d.enlace)}" style="display:inline-block;padding:15px 34px;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;">${boton}</a>
  </td></tr></table>
  <p style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#5b6672;">Este enlace funciona una sola vez y vence en ${d.horas} horas. Al abrirlo confirmas que este correo es tuyo.</p>
  <p style="margin:0 0 22px;font-size:13px;line-height:1.5;color:#5b6672;">Si el botón no abre, copia esta dirección en tu navegador:<br><a href="${esc(d.enlace)}" style="color:${m.boton};word-break:break-all;">${esc(d.enlace)}</a></p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e6ebe8;font-size:12px;line-height:1.5;color:#7b8794;">
  Si no esperabas este correo, ignóralo: nadie podrá entrar sin tu contraseña.<br>Enviado por <b style="color:${m.encabezado};">Comandia</b> · pedidos, cocina y caja.
</td></tr>
</table></td></tr></table></body></html>`;
  const texto = `${titulo}\n\nHola ${d.nombre},\n${intro.replace(/<[^>]+>/g, '')}\n\n${boton}: ${d.enlace}\n\nEl enlace funciona una sola vez y vence en ${d.horas} horas.\nSi no esperabas este correo, ignóralo.`;
  await transportador().sendMail({
    from: config.smtp.de || config.smtp.usuario,
    to: d.para,
    subject: primera ? `Accede a ${d.negocio.nombre}: crea tu contraseña` : `${d.negocio.nombre}: restablece tu contraseña`,
    html,
    text: texto,
  });
}
