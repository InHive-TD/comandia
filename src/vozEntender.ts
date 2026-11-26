/**
 * Apoyo del pedido por voz: cruza lo que dijo el mesero con el menú SIN confiar solo en la IA.
 *  - resolverMods: «sin queso», «con piña», «extra salsa» → la opción real del platillo (por grupo + nombre, con polaridad).
 *  - sugerir: cuando algo no está en el menú, los platillos más parecidos («jugo boing» → bebidas/jugos parecidos).
 */
export interface ExtraVoz { id: number; nombre: string; grupo: string | null }
export interface ModVoz { tipo: 'sin' | 'con' | 'extra' | 'elegir'; texto: string; extra_id?: number }

const PARO = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'e', 'con', 'sin', 'extra', 'mas', 'ni', 'para', 'al', 'a', 'en', 'por', 'lo', 'le', 'ponle', 'quitale', 'quita', 'quitar', 'nada', 'bien', 'poco', 'pero', 'solo', 'puro', 'pura']);

export const norm = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const raiz = (t: string): string => {
  let r = t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
  if (r.length > 3 && /[aeo]$/.test(r)) r = r.slice(0, -1);
  return r;
};
const tokens = (s: string): string[] => norm(s).split(' ').filter(Boolean);
const claves = (s: string): string[] => tokens(s).filter((t) => !PARO.has(t));

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** ¿Estas dos palabras son la misma (plural, acento, errores de la transcripción)? */
function igual(a: string, b: string): boolean {
  const ra = raiz(a), rb = raiz(b);
  if (ra === rb) return true;
  const largo = Math.min(ra.length, rb.length);
  if (largo >= 4 && (ra.startsWith(rb) || rb.startsWith(ra))) return true;
  const tope = largo >= 8 ? 2 : largo >= 5 ? 1 : 0;
  return tope > 0 && lev(ra, rb) <= tope;
}

const NEGATIVA = /(^| )(sin|quitar|quita|quitale|no|retirar|omitir|excluir)( |$)/;
const esNegativa = (e: ExtraVoz): boolean => NEGATIVA.test(norm(e.nombre)) || (e.grupo ? NEGATIVA.test(norm(e.grupo)) : false);

/** Busca en las opciones del platillo la que corresponde a «sin queso» / «con piña» / «extra salsa». null si no hay una clara. */
function resolverUno(extras: ExtraVoz[], m: ModVoz): ExtraVoz | null {
  const q = claves(m.texto);
  if (q.length === 0) return null;
  let mejor: ExtraVoz | null = null, mejorPts = -Infinity, empate = false;
  for (const e of extras) {
    const nombre = claves(e.nombre), grupo = claves(e.grupo ?? '');
    let pts = 0, enNombre = 0, todas = true;
    for (const t of q) {
      if (nombre.some((n) => igual(t, n))) { pts += 3; enNombre++; }
      else if (grupo.some((g) => igual(t, g))) pts += 1;
      else { todas = false; break; }
    }
    if (!todas || enNombre === 0) continue;
    pts += enNombre / Math.max(1, nombre.length);           // prefiere el nombre más cercano
    const neg = esNegativa(e);
    if (m.tipo === 'sin') pts += neg ? 4 : -2;
    else if (m.tipo === 'extra') pts += (neg ? -4 : 0) + (norm(e.nombre).includes('extra') ? 2 : 0);
    else pts += neg ? -4 : 0;
    if (pts > mejorPts + 1e-9) { mejor = e; mejorPts = pts; empate = false; }
    else if (Math.abs(pts - mejorPts) <= 1e-9) empate = true;
  }
  return mejor && !empate ? mejor : null;
}

/** Cada modificador dicho → opción real del platillo. Lo que no se pueda resolver se devuelve aparte (va a notas). */
export function resolverMods(extras: ExtraVoz[], mods: ModVoz[]): { ids: number[]; sinResolver: ModVoz[] } {
  const ids: number[] = [], sinResolver: ModVoz[] = [];
  for (const m of mods) {
    let e = resolverUno(extras, m);
    if (!e && m.extra_id) {     // la sugerencia de la IA solo vale si coincide la polaridad (no convertir «sin queso» en «con queso»)
      const g = extras.find((x) => x.id === m.extra_id);
      if (g && (m.tipo === 'sin') === esNegativa(g)) e = g;
    }
    if (e) { if (!ids.includes(e.id)) ids.push(e.id); } else sinResolver.push(m);
  }
  return { ids, sinResolver };
}

export const textoMod = (m: ModVoz): string => (m.tipo === 'sin' ? 'sin ' : m.tipo === 'extra' ? 'extra ' : m.tipo === 'con' ? 'con ' : '') + m.texto.trim();

/** Red de seguridad: si la IA dejó «sin cebolla, con piña» escrito en las notas, se convierte en modificadores. */
export function modsDeNotas(notas: string): { mods: ModVoz[]; resto: string } {
  const mods: ModVoz[] = [], resto: string[] = [];
  for (const frag of notas.split(/[,;.\n]| y | ni | pero /i).map((s) => s.trim()).filter(Boolean)) {
    const x = /^(sin|con|extra|más|mas)\s+(?:nada de\s+)?(.{2,60})$/i.exec(frag);
    if (!x) { resto.push(frag); continue; }
    const t = x[1]!.toLowerCase();
    mods.push({ tipo: t === 'sin' ? 'sin' : t === 'con' ? 'con' : 'extra', texto: x[2]!.trim() });
  }
  return { mods, resto: resto.join(' · ') };
}

export interface PlatilloVoz { id: number; nombre: string; categoria: string }

/** Los platillos más parecidos a lo que dijeron (nombre y categoría), de mejor a peor. */
export function sugerir(menu: PlatilloVoz[], dicho: string, max = 4): number[] {
  const q = claves(dicho);
  if (q.length === 0) return [];
  const puntos = menu.map((p) => {
    const nom = claves(p.nombre), cat = claves(p.categoria);
    let pts = 0;
    for (const t of q) {
      if (nom.some((n) => igual(t, n))) pts += 3;
      else if (cat.some((c) => igual(t, c))) pts += 1;
    }
    return { id: p.id, pts };
  }).filter((x) => x.pts > 0);
  puntos.sort((a, b) => b.pts - a.pts);
  return puntos.slice(0, max).map((x) => x.id);
}
