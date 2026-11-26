// Prueba de carga de Comandia (SOLO staging). Simula N taquerías con ~20 pedidos cada 10 min.
// Uso: node prueba-carga.mjs <base_url> <slug> "10,25,50,75,100,150" <segundos_por_etapa>
import http from 'node:http';
import crypto from 'node:crypto';

const [BASE, SLUG, ETAPAS_TXT = '10,25,50', SEG = '60'] = process.argv.slice(2);
if (!BASE || BASE.includes('comandia.mx') && !BASE.includes('staging')) { console.error('Solo staging.'); process.exit(2); }
const API = `${BASE}/${SLUG}/api`;
const ETAPAS = ETAPAS_TXT.split(',').map(Number);
const DUR = Number(SEG) * 1000;
const PEDIDO_CADA_MS = 30_000; // 20 pedidos / 10 min por taquería
const MARCA = 'ZZCARGA';

const agente = new http.Agent({ keepAlive: true, maxSockets: 400 });
let lat = [], errores = 0, total = 0, rechazos = 0, pedidosOk = 0, sseAbiertos = 0, sseFallos = 0;
const erroresPorTipo = {};
let productos = [];

function req(metodo, ruta, cuerpo, ip) {
  return new Promise((ok) => {
    const t0 = performance.now();
    const datos = cuerpo ? JSON.stringify(cuerpo) : null;
    const r = http.request(API + ruta, { method: metodo, agent: agente, timeout: 15000, headers: {
      'x-forwarded-for': ip || '10.0.0.1', ...(datos ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(datos) } : {}) } }, (res) => {
      const trozos = []; res.on('data', (c) => trozos.push(c));
      res.on('end', () => {
        const ms = performance.now() - t0; total++; lat.push(ms);
        if (res.statusCode >= 500 || res.statusCode === 429) { errores++; erroresPorTipo[res.statusCode] = (erroresPorTipo[res.statusCode] || 0) + 1; }
        ok({ s: res.statusCode, cuerpo: Buffer.concat(trozos).toString() });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => { total++; errores++; lat.push(performance.now() - t0); erroresPorTipo[e.message] = (erroresPorTipo[e.message] || 0) + 1; ok({ s: 0, cuerpo: '' }); });
    if (datos) r.write(datos); r.end();
  });
}
const ipAzar = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function abrirSSE(vivo) {
  const r = http.get(API + '/eventos', { agent: false, headers: { 'x-forwarded-for': ipAzar() } }, (res) => {
    if (res.statusCode !== 200) { sseFallos++; res.resume(); return; }
    sseAbiertos++; res.on('data', () => {}); res.on('close', () => { sseAbiertos--; });
  });
  r.on('error', () => { sseFallos++; });
  vivo.push(r);
}

async function taqueria(vivo, parar) {
  abrirSSE(vivo); abrirSSE(vivo); // cocina + caja
  await dormir(Math.random() * PEDIDO_CADA_MS);
  while (!parar.v) {
    const ip = ipAzar(); const t0 = Date.now();
    await req('GET', '/negocio', null, ip); await req('GET', '/tema', null, ip);
    await req('GET', '/productos', null, ip); await req('GET', '/cliente/espera', null, ip);
    const p = productos[Math.floor(Math.random() * productos.length)];
    const clave = crypto.randomBytes(16).toString('hex');
    const r = await req('POST', '/cliente/pedido', { accion: 'crear', clave, nombre_cliente: `${MARCA}${Math.floor(Math.random() * 1e6)}`, modalidad: 'aqui', items: [{ producto_id: p.id, cantidad: 1 }], web: '' }, ip);
    if (r.s >= 200 && r.s < 300) pedidosOk++; else { rechazos++; if (rechazos <= 3) console.log('  rechazo', r.s, r.cuerpo.slice(0, 160)); }
    for (let i = 0; i < 4 && !parar.v; i++) { await dormir(2500); await req('GET', `/cliente/pedido?clave=${clave}`, null, ip); }
    // pantallas del personal (aprox.): 2 lecturas ligeras cada ~8 s mientras espera el siguiente pedido
    while (!parar.v && Date.now() - t0 < PEDIDO_CADA_MS) { await req('GET', '/cliente/espera', null, ip); await req('GET', '/cliente/espera', null, ip); await dormir(8000); }
  }
}

const pct = (a, q) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;

const p0 = await req('GET', '/productos');
const lista = JSON.parse(p0.cuerpo);
const todos = Array.isArray(lista) ? lista : (lista.productos || []);
productos = todos.filter((p) => !p.pedir_opciones && !p.opciones_obligatorias && !p.grupo_obligatorio && !p.agotado).slice(0, 30);
if (!productos.length) { console.error('Sin productos sencillos'); process.exit(3); }
console.log(`Productos de prueba: ${productos.length}. Etapas: ${ETAPAS.join(', ')} taquerías x ${SEG}s\n`);
console.log('taquerias | req/s | p50 ms | p95 ms | p99 ms | errores % | pedidos ok | rechazos | SSE');

let abortar = false;
for (const n of ETAPAS) {
  lat = []; errores = 0; total = 0; rechazos = 0; pedidosOk = 0; sseFallos = 0;
  const vivo = []; const parar = { v: false };
  const ps = []; for (let i = 0; i < n; i++) { ps.push(taqueria(vivo, parar)); await dormir(40); }
  await dormir(Math.max(0, DUR - n * 40));
  parar.v = true; const t = total;
  const fila = `${String(n).padStart(9)} | ${(t / (DUR / 1000)).toFixed(1).padStart(5)} | ${pct(lat, .5).toFixed(0).padStart(6)} | ${pct(lat, .95).toFixed(0).padStart(6)} | ${pct(lat, .99).toFixed(0).padStart(6)} | ${(100 * errores / Math.max(1, t)).toFixed(2).padStart(9)} | ${String(pedidosOk).padStart(10)} | ${String(rechazos).padStart(8)} | ${sseAbiertos}/${sseFallos} fallos`;
  console.log(fila, JSON.stringify(erroresPorTipo));
  const p95 = pct(lat, .95), tasa = errores / Math.max(1, t);
  vivo.forEach((r) => r.destroy()); await dormir(1500);
  if (p95 > 1000 || tasa > 0.02) { console.log(`>> Límite alcanzado en ${n} taquerías (p95>1s o errores>2%). Se detiene.`); abortar = true; }
  if (abortar) break;
}
agente.destroy(); process.exit(0);
