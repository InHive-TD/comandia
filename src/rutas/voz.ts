/**
 * Pedidos por voz (Tomar pedidos).
 *
 *   GET  /voz/estado → { disponible, usados, limite }  ¿puede esta sucursal usar el micrófono hoy?
 *   POST /voz        → { audio (base64), formato, segundos } → { texto, lineas, dudas, no_encontrados, usados, limite }
 *
 * Flujo: audio → transcripción (OpenRouter) → IA que lo cruza con el menú de la sucursal → el servidor VALIDA cada platillo y
 * extra contra la base de datos (la IA nunca decide por sí sola qué existe). El pedido no se crea aquí: el mesero confirma en
 * pantalla y se agrega al pedido en curso con el flujo normal (que vuelve a validar y calcular precios).
 *
 * Interruptores: voz encendida en toda la plataforma (Integraciones) Y encendida para la empresa (ajuste voz_activa, apagada por
 * defecto). Límite diario de tokens por empresa: ajuste voz_limite_tokens, o el general de la plataforma.
 */
import type { FastifyInstance } from 'fastify';
import { cuerpoJson, exigirMetodo, requerirRol } from '../auth.js';
import { CARTA_AGOTADO, cartaUnir, cartaVisible } from '../carta.js';
import { ejecutar, fila, filas } from '../db.js';
import { ErrorHttp, fallo } from '../errores.js';
import { contexto } from '../ordenes.js';
import { mesasParaElegir } from '../plano.js';
import { modsDeNotas, resolverMods, sugerir, textoMod, type ModVoz } from '../vozEntender.js';
import { LIMITE_VOZ_DEFECTO, MODELO_IA_DEFECTO, MODELO_STT_DEFECTO, leerConfigPlataforma, llaveOpenRouter } from './plataformaIntegraciones.js';

const MAX_SEGUNDOS = 30;
const MAX_AUDIO_BASE64 = 3_000_000;
const FORMATOS = new Set(['webm', 'mp4', 'mp3', 'wav', 'ogg', 'm4a']);

interface Estado { disponible: boolean; motivo: string | null; usados: number; limite: number }

async function estadoVoz(nid: number): Promise<Estado & { cfg: Map<string, string> }> {
  const cfg = await leerConfigPlataforma();
  const propio = async (clave: string): Promise<string | undefined> => {
    const f = await fila('SELECT valor FROM ajustes WHERE negocio_id = ? AND clave = ?', [nid, clave]);
    return f ? String(f['valor']) : undefined;
  };
  const limite = Number((await propio('voz_limite_tokens')) ?? cfg.get('voz_limite_tokens') ?? LIMITE_VOZ_DEFECTO);
  const uso = await fila('SELECT tokens FROM voz_uso WHERE negocio_id = ? AND dia = CURDATE()', [nid]);
  const usados = Number(uso?.['tokens'] ?? 0);
  let motivo: string | null = null;
  if ((cfg.get('voz_activa') ?? '1') !== '1') motivo = 'La voz está apagada.';
  else if ((await propio('voz_activa')) !== '1') motivo = 'La voz no está activada para esta empresa.';
  else if (!cfg.has('openrouter_llave')) motivo = 'Falta configurar la voz en la plataforma.';
  else if (usados >= limite) motivo = 'Se acabó el límite de voz de hoy. Mañana vuelve a funcionar; mientras, toma los pedidos normal.';
  return { disponible: motivo === null, motivo, usados, limite, cfg };
}

interface ProductoVoz { id: number; nombre: string; categoria: string; obligatorias: boolean; extras: Map<number, string>; grupos: Map<number, string | null> }

/** El menú de la sucursal (solo lo que se puede pedir hoy), igual que lo ve Tomar pedidos. */
async function menuParaVoz(nid: number, suc: number): Promise<Map<number, ProductoVoz>> {
  const prods = await filas(
    `SELECT p.id, p.nombre, c.nombre AS categoria, p.opciones_obligatorias
       FROM productos p JOIN categorias c ON c.id = p.categoria_id${cartaUnir(suc)}
      WHERE p.negocio_id = ? AND c.negocio_id = p.negocio_id AND p.disponible = 1 AND COALESCE(${CARTA_AGOTADO}, 0) = 0${cartaVisible(suc)}
      ORDER BY c.orden, p.orden, p.nombre`,
    [nid],
  );
  const mapa = new Map<number, ProductoVoz>();
  for (const f of prods) mapa.set(Number(f['id']), { id: Number(f['id']), nombre: String(f['nombre']), categoria: String(f['categoria']), obligatorias: Boolean(Number(f['opciones_obligatorias'])), extras: new Map(), grupos: new Map() });
  const ex = await filas(
    `SELECT pe.producto_id, e.id, e.nombre, e.grupo FROM producto_extras pe JOIN extras e ON e.id = pe.extra_id
      WHERE e.activo = 1 AND e.negocio_id = ? ORDER BY e.orden, e.id`,
    [nid],
  );
  for (const x of ex) {
    const pr = mapa.get(Number(x['producto_id']));
    if (!pr) continue;
    pr.extras.set(Number(x['id']), String(x['nombre']));
    pr.grupos.set(Number(x['id']), x['grupo'] ? String(x['grupo']) : null);
  }
  return mapa;
}

async function openRouter(llave: string, ruta: string, cuerpo: unknown): Promise<Record<string, any>> {
  let r: Response;
  try {
    r = await fetch('https://openrouter.ai/api/v1/' + ruta, {
      method: 'POST',
      headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json', 'X-Title': 'Comandia' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new ErrorHttp(504, 'voz', 'La voz tardó demasiado. Inténtalo otra vez.');
    throw new ErrorHttp(502, 'voz', 'No se pudo conectar con el servicio de voz.');
  }
  if (r.status === 401 || r.status === 403) throw new ErrorHttp(502, 'voz', 'El servicio de voz rechazó la llave. Avisa al administrador de la plataforma.');
  if (r.status === 402) throw new ErrorHttp(502, 'voz', 'El servicio de voz se quedó sin saldo. Avisa al administrador de la plataforma.');
  if (!r.ok) {
    console.warn('OpenRouter', ruta, r.status, (await r.text().catch(() => '')).slice(0, 300));
    throw new ErrorHttp(502, 'voz', 'El servicio de voz no respondió bien. Inténtalo otra vez.');
  }
  return (await r.json()) as Record<string, any>;
}

function leerJson(texto: string): Record<string, any> | null {
  const limpio = texto.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const v = JSON.parse(limpio) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
  } catch {
    const a = limpio.indexOf('{'), b = limpio.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(limpio.slice(a, b + 1)) as Record<string, any>; } catch { return null; } }
    return null;
  }
}

const entero = (v: unknown): number => { const x = Math.trunc(Number(v)); return Number.isFinite(x) ? x : 0; };

export async function rutasVoz(app: FastifyInstance): Promise<void> {
  app.get('/voz/estado', async (req) => {
    exigirMetodo(req, 'GET');
    await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
    const e = await estadoVoz(req.negocio.id);
    return { ok: true, disponible: e.disponible, motivo: e.motivo, usados: e.usados, limite: e.limite };
  });

  app.post('/voz', async (req) => {
    await requerirRol(req, 'taquero', 'caja', 'admin', 'mesero', 'gerente');
    const c = contexto(req);
    const d = cuerpoJson(req);

    const e = await estadoVoz(c.nid);
    if (!e.disponible) throw fallo(e.motivo ?? 'La voz no está disponible.');
    const llave = await llaveOpenRouter();
    if (!llave) throw fallo('Falta configurar la voz en la plataforma.');

    // Con «texto» (el mesero corrigió lo que se escuchó) no hay audio ni transcripción: solo se vuelve a entender el pedido
    const textoCorregido = typeof d['texto'] === 'string' ? d['texto'].trim().slice(0, 600) : '';
    const audio = String(d['audio'] ?? '');
    const formato = String(d['formato'] ?? 'webm').toLowerCase();
    const segundos = textoCorregido ? 0 : Math.min(MAX_SEGUNDOS, Math.max(1, entero(d['segundos'])));
    if (!textoCorregido) {
      if (audio.length < 200) throw fallo('No se escuchó nada. Habla un poco más y vuelve a intentar.');
      if (audio.length > MAX_AUDIO_BASE64) throw fallo(`El audio es muy largo. Máximo ${MAX_SEGUNDOS} segundos.`);
      if (!FORMATOS.has(formato) || !/^[A-Za-z0-9+/=]+$/.test(audio)) throw fallo('Formato de audio no válido.');
    }

    const menu = await menuParaVoz(c.nid, c.sid);
    if (menu.size === 0) throw fallo('No hay platillos disponibles en el menú.');

    const modeloStt = e.cfg.get('voz_modelo_stt') ?? MODELO_STT_DEFECTO;
    const modeloIa = e.cfg.get('voz_modelo_ia') ?? MODELO_IA_DEFECTO;
    let tokens = 0, costo = 0;

    // 1) Voz a texto
    let texto = textoCorregido;
    if (!textoCorregido) {
      // Pista breve para la transcripción: contexto + nombres de platillos (una lista larga la confunde y mete platillos que nadie dijo)
      let pista = 'Mesero tomando un pedido en un restaurante de México. Platillos: ';
      for (const p of menu.values()) { if (pista.length + p.nombre.length + 2 > 420) break; pista += p.nombre + ', '; }
      const t = await openRouter(llave, 'audio/transcriptions', { model: modeloStt, input_audio: { data: audio, format: formato }, language: 'es', prompt: pista.replace(/, $/, '.') });
      texto = String(t['text'] ?? '').trim();
      tokens += Number(t['usage']?.['total_tokens'] ?? 0);
      costo += Number(t['usage']?.['cost'] ?? 0);
    }

    // 2) Entender el pedido contra el menú de la sucursal
    // Mesas de la sucursal (para que «mesa 5» se convierta en la mesa real)
    const lm = await mesasParaElegir(c.nid, c.sid);
    const zonaDe = new Map((lm.zonas ?? []).map((z: { id: number; nombre: string }) => [z.id, z.nombre] as const));
    const mesasOk = new Map<number, string>((lm.mesas ?? []).map((m: { id: number; nombre: string; zona_id?: number | null }) => [m.id, `Mesa ${m.nombre}${m.zona_id && zonaDe.get(m.zona_id) ? ' (' + zonaDe.get(m.zona_id) + ')' : ''}`] as const));

    // Pedido que ya hay armado (el mesero sigue dictando sobre él): se valida y se le aplican los cambios dichos
    interface LineaV { producto_id: number; nombre: string; cantidad: number; extras: { id: number; nombre: string | undefined; grupo: string | null }[]; notas: string; sin_resolver: string[]; plato: number; llevar: boolean; falta_opcion: boolean }
    const actual: LineaV[] = [];
    for (const a of (Array.isArray(d['actual']) ? d['actual'] : []).slice(0, 60)) {
      const pid = entero(a?.['producto_id']);
      const p = menu.get(pid);
      const ids = (Array.isArray(a?.['extras']) ? a['extras'] : []).map(entero).filter((id: number) => p?.extras.has(id));
      actual.push({
        producto_id: pid, nombre: p?.nombre ?? String(a?.['nombre'] ?? '').slice(0, 120), cantidad: Math.min(50, Math.max(1, entero(a?.['cantidad']) || 1)),
        extras: ids.map((id: number) => ({ id, nombre: p?.extras.get(id), grupo: p?.grupos.get(id) ?? null })),
        notas: String(a?.['notas'] ?? '').slice(0, 255), sin_resolver: [], plato: Math.min(20, Math.max(1, entero(a?.['plato']) || 1)), llevar: a?.['llevar'] === true,
        falta_opcion: !!p && p.obligatorias && ids.length === 0,
      });
    }
    const actualTexto = actual.map((l, i) => `${i + 1}|plato ${l.plato}|${l.cantidad} x ${l.nombre}${l.extras.length ? '|con: ' + l.extras.map((x) => (x.grupo ? x.grupo + ': ' : '') + x.nombre).join(', ') : ''}${l.notas ? '|nota: ' + l.notas : ''}${l.llevar ? '|para llevar' : ''}`).join('\n');

    let respuesta: Record<string, any> = {};
    if (texto !== '') {
      const catalogo = [...menu.values()].map((p) => `${p.id}|${p.categoria}|${p.nombre}${p.obligatorias ? '|requiere opción' : ''}${p.extras.size ? '|opciones: ' + [...p.extras].map(([id, n]) => `${id}=${p.grupos.get(id) ? p.grupos.get(id) + ': ' : ''}${n}`).join(', ') : ''}`).join('\n');
      const sistema = [
        'Eres el asistente de toma de pedidos de un restaurante. Recibes lo que dijo el mesero y el menú disponible (id|categoría|nombre|opciones).',
        'Responde SOLO un JSON con esta forma exacta: {"lineas":[{"producto_id":0,"cantidad":1,"mods":[{"tipo":"sin","texto":"queso","extra_id":0}],"notas":"","plato":1,"llevar":false}],"dudas":[{"texto":"lo que dijo","cantidad":1,"opciones":[0],"plato":1,"llevar":false}],"no_encontrados":[{"texto":"lo que dijo","cantidad":1,"plato":1,"llevar":false}],"cambios":[{"ref":1,"accion":"quitar","cantidad":1,"mods":[]}],"mesa_id":null,"nombre":null,"modalidad":null,"notas_pedido":null}.',
        'Eres tolerante con la transcripción: puede traer errores, marcas mal escritas, plurales, diminutivos o muletillas («este», «eh», «agrégame», «ponme», «me das», «añade», «también»). Entiende la intención y empata con el menú por significado, no solo por letras (ej. «taco de alambre» = «Alambre» si es lo más parecido, «coca» = «Coca-Cola»). Cada cosa que pide el mesero es un renglón, aunque la diga al final o después de «y también…».',
        'Datos del pedido (solo si el mesero los dice; si no, null): "mesa_id" = id de la lista MESAS; "nombre" = nombre del cliente («a nombre de Juan», «es para María»); "modalidad" = "aqui" (comer aquí), "llevar" (para llevar) o "recoger" (pasa a recoger); "notas_pedido" = indicaciones de TODO el pedido (ej. «todo sin picante», «cuenta separada»).',
        'Platos: cada plato o persona es un número (plato 1, plato 2…). Si dicen «para la niña…», «otro plato con…» o «el segundo es…», usa el siguiente número. "llevar": true solo en los renglones de los platos que dicen que son para llevar; si TODO el pedido es para llevar usa modalidad "llevar".',
        'MODIFICADORES: todo «sin X», «con X», «extra X», «más X», «con doble X», «quítale X», «ponle X», «aparte» o elección dicha para un platillo va en "mods" de ESE renglón, UNO por cada cosa: {"tipo":"sin"|"con"|"extra"|"elegir","texto":"lo dicho tal cual, solo el ingrediente (ej. queso)","extra_id":id de la opción del menú si estás seguro o 0}. «sin cebolla ni cilantro» son DOS mods «sin». «con todo» = un mod «con» texto «todo». «de pastor» / «de harina» cuando el platillo ofrece esa opción es "elegir". Si el mesero dice un modificador justo después de un platillo, es de ese platillo; si dice «el segundo sin…», es del segundo.',
        '"notas" es SOLO para indicaciones que no son una opción del menú (ej. «bien cocido», «cortado en cuatro», «para regalo»). Nunca pongas «sin X» o «con X» en "notas" si X puede ser una opción: va en "mods" (el sistema lo empata con las opciones reales del platillo).',
        'Reglas de menú: usa SOLO ids del menú. Si lo dicho puede ser varios platillos del menú, ponlo en "dudas" con hasta 4 ids posibles (no adivines entre opciones realmente distintas). Si no existe nada parecido a lo que pidió (ej. una bebida o marca que no está en el menú), ponlo en "no_encontrados" con su cantidad: nunca lo omitas ni lo cambies por otra cosa. Cantidades en número (dos = 2, un par = 2, media docena = 6).',
        'PEDIDO ACTUAL: si viene una sección PEDIDO ACTUAL (renglones numerados con ref), lo que dice el mesero se aplica SOBRE ese pedido, que ya existe y NO se repite. "lineas" lleva SOLO los platillos NUEVOS. Los cambios a renglones existentes van en "cambios" con su "ref": {"ref":n,"accion":"quitar"} («quita el pastor», «ya no quiero el refresco»); {"ref":n,"accion":"cantidad","cantidad":k} («que sean tres», «agrégame otro» = el nuevo total); {"ref":n,"accion":"mods","mods":[…]} («al alambre ponle sin queso»); {"ref":n,"accion":"quitar_mods","mods":[…]} («ya no lleves la piña», «sin el sin queso»). «Cámbiame X por Y» = quitar X + una línea nueva Y. Si piden «otro igual» o «uno más de lo mismo», usa la acción "cantidad" con el total nuevo. Si no hay PEDIDO ACTUAL, "cambios" va vacío.',
        'Ejemplos: «dos tacos de alambre sin queso y con piña, uno para llevar» → un renglón Alambre cantidad 2 con mods [{sin,queso},{con,piña}] (si uno va para llevar y otro no, sepáralos en dos renglones con plato distinto). «un jugo boing» sin ese producto → no_encontrados [{texto:"jugo boing",cantidad:1}].',
      ].join('\n');
      const ia = await openRouter(llave, 'chat/completions', {
        model: modeloIa,
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: `MENÚ:\n${catalogo}\n\nMESAS:\n${[...mesasOk].map(([id, n]) => `${id}=${n}`).join('\n') || '(ninguna)'}\n\nPEDIDO ACTUAL:\n${actualTexto || '(vacío)'}\n\nMESERO DIJO: ${texto}` }],
      });
      tokens += Number(ia['usage']?.['total_tokens'] ?? 0);
      costo += Number(ia['usage']?.['cost'] ?? 0);
      respuesta = leerJson(String(ia['choices']?.[0]?.['message']?.['content'] ?? '')) ?? {};
    }

    // 3) Validar TODO contra el menú real
    const lista = [...menu.values()].map((p) => ({ id: p.id, nombre: p.nombre, categoria: p.categoria }));
    const modsDe = (v: unknown): ModVoz[] => (Array.isArray(v) ? v : []).map((m: any) => ({
      tipo: (['sin', 'con', 'extra', 'elegir'].includes(String(m?.['tipo'])) ? String(m['tipo']) : 'con') as ModVoz['tipo'],
      texto: String(m?.['texto'] ?? '').trim().slice(0, 60),
      extra_id: entero(m?.['extra_id']) || undefined,
    })).filter((m) => m.texto !== '').slice(0, 12);
    /** Resuelve los modificadores de un platillo: opciones reales + lo que no se pudo (va a notas). */
    const aplicarMods = (p: ProductoVoz, mods: ModVoz[], notasIA: string) => {
      const dn = modsDeNotas(notasIA);
      const extrasP = [...p.extras].map(([id, nombre]) => ({ id, nombre, grupo: p.grupos.get(id) ?? null }));
      const r = resolverMods(extrasP, [...mods, ...dn.mods]);
      const notas = [dn.resto, ...r.sinResolver.map(textoMod)].filter(Boolean).join(' · ').slice(0, 255);
      return { ids: r.ids.slice(0, 12), notas, sinResolver: r.sinResolver.map(textoMod) };
    };

    const lineas: unknown[] = [];
    for (const l of Array.isArray(respuesta['lineas']) ? respuesta['lineas'] : []) {
      const p = menu.get(entero(l?.['producto_id']));
      if (!p) continue;
      const cantidad = Math.min(50, Math.max(1, entero(l?.['cantidad']) || 1));
      const ap = aplicarMods(p, modsDe(l?.['mods']), String(l?.['notas'] ?? ''));
      // compatibilidad: si la IA mandó ids de opciones directamente, se suman solo si son del platillo
      const idsIA = (Array.isArray(l?.['extras']) ? l['extras'] : []).map(entero).filter((id: number) => p.extras.has(id));
      const extras = [...new Set([...ap.ids, ...idsIA])].slice(0, 12);
      lineas.push({
        producto_id: p.id, nombre: p.nombre, cantidad, extras: extras.map((id) => ({ id, nombre: p.extras.get(id), grupo: p.grupos.get(id) ?? null })),
        notas: ap.notas, sin_resolver: ap.sinResolver, plato: Math.min(20, Math.max(1, entero(l?.['plato']) || 1)), llevar: l?.['llevar'] === true,
        falta_opcion: p.obligatorias && extras.length === 0,
      });
    }
    // Cambios sobre el pedido que ya había (quitar, cambiar cantidad, agregar o quitar modificadores). Lo que no se menciona NO se toca.
    const resumen: string[] = [];
    const quitados = new Set<number>();
    for (const c of Array.isArray(respuesta['cambios']) ? respuesta['cambios'] : []) {
      const i = entero(c?.['ref']) - 1;
      const l = actual[i];
      if (!l || quitados.has(i)) continue;
      const accion = String(c?.['accion'] ?? '');
      const p = menu.get(l.producto_id);
      const extrasP = p ? [...p.extras].map(([id, nombre]) => ({ id, nombre, grupo: p.grupos.get(id) ?? null })) : [];
      if (accion === 'quitar') { quitados.add(i); resumen.push(`quité ${l.nombre}`); }
      else if (accion === 'cantidad') {
        const k = Math.min(50, Math.max(1, entero(c?.['cantidad']) || 0));
        if (k > 0 && k !== l.cantidad) { l.cantidad = k; resumen.push(`${l.nombre} ahora ×${k}`); }
      } else if (accion === 'mods' && p) {
        const ap = aplicarMods(p, modsDe(c?.['mods']), '');
        for (const id of ap.ids) if (!l.extras.some((x) => x.id === id)) { l.extras.push({ id, nombre: p.extras.get(id), grupo: p.grupos.get(id) ?? null }); resumen.push(`${l.nombre}: ${p.extras.get(id)}`); }
        if (ap.notas) l.notas = [l.notas, ap.notas].filter(Boolean).join(' · ').slice(0, 255);
        l.sin_resolver.push(...ap.sinResolver);
      } else if (accion === 'quitar_mods' && p) {
        const puestas = extrasP.filter((x) => l.extras.some((e) => e.id === x.id));
        const r = resolverMods(puestas, modsDe(c?.['mods']).map((m) => ({ ...m, tipo: 'elegir' as const, extra_id: undefined })));
        l.extras = l.extras.filter((e) => !r.ids.includes(e.id));
        for (const id of r.ids) resumen.push(`${l.nombre}: quité ${p.extras.get(id)}`);
      }
      l.falta_opcion = !!p && p.obligatorias && l.extras.length === 0;
    }
    const finales = [...actual.filter((_, i) => !quitados.has(i)), ...(lineas as LineaV[])];
    for (const l of lineas as LineaV[]) resumen.push(`agregué ${l.cantidad > 1 ? l.cantidad + ' ' : ''}${l.nombre}`);
    lineas.length = 0;
    lineas.push(...finales);

    // Pendientes: la IA dudó entre varios, o no encontró nada. El mesero elige aquí mismo (sugerencias + todo el menú).
    const dudas: unknown[] = [];
    const pendiente = (q: any, textoPor: string, sinCoincidencia: boolean) => {
      const texto = String(q?.['texto'] ?? textoPor).slice(0, 120);
      let ids = [...new Set((Array.isArray(q?.['opciones']) ? q['opciones'] : []).map(entero))].filter((id) => menu.has(id)).slice(0, 4) as number[];
      if (ids.length === 0) ids = sugerir(lista, texto, 4);
      dudas.push({
        texto, cantidad: Math.min(50, Math.max(1, entero(q?.['cantidad']) || 1)), plato: Math.min(20, Math.max(1, entero(q?.['plato']) || 1)), llevar: q?.['llevar'] === true,
        sin_coincidencia: sinCoincidencia && ids.length === 0 ? true : sinCoincidencia,
        opciones: ids.map((id) => ({ id, nombre: menu.get(id)!.nombre })),
      });
    };
    for (const q of Array.isArray(respuesta['dudas']) ? respuesta['dudas'] : []) pendiente(q, '', false);
    for (const q of Array.isArray(respuesta['no_encontrados']) ? respuesta['no_encontrados'] : []) {
      const o = typeof q === 'string' ? { texto: q } : q;
      if (String(o?.['texto'] ?? '').trim() === '') continue;
      pendiente(o, '', true);
    }
    const noEncontrados: string[] = [];

    const mesaId = entero(respuesta['mesa_id']);
    const modalidadPedida = ['aqui', 'llevar', 'recoger'].includes(String(respuesta['modalidad'])) ? String(respuesta['modalidad']) : null;
    const nombre = typeof respuesta['nombre'] === 'string' ? respuesta['nombre'].trim().slice(0, 80) : '';
    const notasPedido = typeof respuesta['notas_pedido'] === 'string' ? respuesta['notas_pedido'].trim().slice(0, 255) : '';
    const pedido = { mesa_id: mesasOk.has(mesaId) ? mesaId : null, mesa: mesasOk.get(mesaId) ?? null, nombre: nombre || null, modalidad: modalidadPedida, notas: notasPedido || null };

    // 4) Contar el consumo del día (aunque no haya salido nada útil: igual se gastó)
    await ejecutar(
      `INSERT INTO voz_uso (negocio_id, dia, tokens, audio_seg, peticiones, costo) VALUES (?, CURDATE(), ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE tokens = tokens + VALUES(tokens), audio_seg = audio_seg + VALUES(audio_seg), peticiones = peticiones + 1, costo = costo + VALUES(costo)`,
      [c.nid, Math.max(0, Math.round(tokens)), segundos, costo],
    );
    const usados = e.usados + Math.max(0, Math.round(tokens));
    return { ok: true, texto, lineas, resumen: actual.length ? resumen : [], dudas, no_encontrados: noEncontrados, pedido, usados, limite: e.limite, aviso: usados >= e.limite * 0.8 };
  });
}
