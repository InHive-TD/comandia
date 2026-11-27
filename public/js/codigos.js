/*
 * Código rápido: convierte lo que escribe quien levanta pedidos ("2Arra 1HChTodo xChil 1CharoChBAsa") en
 * renglones del pedido. Reglas del menú (acordadas con las dueñas):
 *  - Cada pedido = [cantidad] + código del producto + extras pegados (carnes, "x" = sin, "solo", "Apar" = aparte).
 *  - Los espacios separan, pero "x mayo", "solo Jito" y "Chil Apar" se leen como una sola cosa.
 *  - Se lee siempre el código MÁS LARGO que exista (SQ = taco de salchichón con queso; QS = quesadilla de salchichón).
 *  - Hamburguesa sencilla + carne = especial; doble + carne = doble especial.
 *  - Charola + asada/arrachera cambia a la charola de asada/arrachera (si lleva las dos, se cobra arrachera).
 *  - Torta + Q = torta con queso; taco de harina + Q = quesadilla; QAma + QAsa juntos = ambos quesos (+$4).
 */
(function (raiz) {
  'use strict';

  const ESPECIAL = { HCH: 'HChEsp', HGR: 'HGrEsp', HCHDOBL: 'HChDoblEsp', HGRDOBL: 'HGrDoblEsp' };
  const FAMILIAS = {
    CHAROCH: 'ch', CHAROCHASA: 'ch', CHAROCHARRA: 'ch',
    CHAROGR: 'gr', CHAROGRASA: 'gr', CHAROGRARRA: 'gr',
  };
  const CODIGOS_FAMILIA = {
    ch: { base: 'CharoCh', asa: 'CharoChAsa', arra: 'CharoChArra' },
    gr: { base: 'CharoGr', asa: 'CharoGrAsa', arra: 'CharoGrArra' },
  };
  const GRUPO_CARNE = 'Carne a elegir';

  function normalizar(texto) {
    let t = String(texto).toUpperCase().replace(/[,+]/g, ' ').replace(/\//g, ' / ');
    t = t.replace(/APARTE|APART/g, 'APAR')
      .replace(/ARR(?!A)|ARR(?=ASA)/g, 'ARRA').replace(/CHILE/g, 'CHIL').replace(/MAYONESA/g, 'MAYO').replace(/JITOMATE/g, 'JITO')
      .replace(/CEBOLLA/g, 'CEB').replace(/LECHUGA/g, 'LECH').replace(/MOSTAZA/g, 'MOST')
      .replace(/ADEREZOS?/g, 'ADER').replace(/VERDURA/g, 'VERD').replace(/CATSUP|KETCHUP/g, 'CAT')
      .replace(/\bSIN\b/g, 'X')
      .replace(/(H(?:CH|GR))\s+DOBL/g, '$1DOBL');
    const piezas = t.split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < piezas.length; i++) {
      const p = piezas[i];
      if ((p === 'X' || p === 'SOLO') && piezas[i + 1] && piezas[i + 1] !== '/' && !/^\d/.test(piezas[i + 1])) {
        out.push(p + piezas[++i]);
      } else if (p === 'APAR' && out.length && out[out.length - 1] !== '/') {
        out[out.length - 1] += 'APAR';
      } else out.push(p);
    }
    return out;
  }

  /** menu = [{categoria, productos:[{codigo, nombre, extras:[{id, codigo, grupo}], max_carnes, agotado}]}] */
  function interpretarCodigos(texto, menu, opciones) {
    const op = opciones || {};
    const productos = [];
    for (const c of menu) for (const p of c.productos) productos.push(p);
    const porCodigo = new Map();
    const extraPorCodigo = new Map();
    for (const p of productos) {
      if (p.codigo) porCodigo.set(p.codigo.toUpperCase(), p);
      for (const x of p.extras) if (x.codigo) extraPorCodigo.set(x.codigo.toUpperCase(), x);
    }
    const listaCodigos = [...porCodigo.keys()].sort((a, b) => b.length - a.length);

    const cacheVocab = new Map();
    function vocabDe(prod) {
      if (cacheVocab.has(prod)) return cacheVocab.get(prod);
      const K = prod.codigo.toUpperCase();
      const lista = [...prod.extras];
      const sumar = (cod) => { const q = porCodigo.get(String(cod).toUpperCase()); if (q) lista.push(...q.extras); };
      if (ESPECIAL[K]) sumar(ESPECIAL[K]);
      if (FAMILIAS[K]) { const f = CODIGOS_FAMILIA[FAMILIAS[K]]; sumar(f.base); sumar(f.asa); sumar(f.arra); }
      const vistos = new Set();
      const v = [];
      for (const x of lista) {
        if (!x.codigo || vistos.has(x.id)) continue;
        vistos.add(x.id);
        v.push({ code: x.codigo.toUpperCase(), extra: x, key: 'e' + x.id });
        if (x.grupo_codigo) v.push({ code: String(x.grupo_codigo).toUpperCase() + x.codigo.toUpperCase(), extra: x, key: 'e' + x.id });   // tipo + modificador: SCEB
      }
      if (K === 'TOR' || K === 'HAR') v.push({ code: 'Q', pseudo: 'Q', key: 'q' });
      if (lista.some((x) => (x.codigo || '').toUpperCase() === 'QASA')) v.push({ code: 'QAMA', pseudo: 'QAMA', key: 'qama' });
      v.sort((a, b) => b.code.length - a.code.length);
      cacheVocab.set(prod, v);
      return v;
    }

    function segmentar(s, vocab) {
      const usados = new Set();
      function rec(i, acc) {
        if (i === s.length) return acc;
        for (const v of vocab) {
          if (usados.has(v.key) || !s.startsWith(v.code, i)) continue;
          usados.add(v.key);
          const r = rec(i + v.code.length, acc.concat(v));
          if (r) return r;
          usados.delete(v.key);
        }
        return null;
      }
      return rec(0, []);
    }

    /** Un trozo de texto que empieza un pedido: [cantidad] producto extras... */
    function leerPedido(seg) {
      let s = seg;
      let cantidad = null;
      const m = /^(\d{1,2})(?=\D)/.exec(s);
      if (m) { cantidad = Number(m[1]); s = s.slice(m[0].length); }
      const har = porCodigo.get('HAR');
      const mh = har && /^(.+)HAR(Q?)$/.exec(s);
      if (mh) {                                                  // carne primero: 1PHar, 2BSHar (con Q = quesadilla)
        const ent = segmentar(mh[1], vocabDe(har));
        if (ent && ent.length) return { producto: har, pend: mh[2] ? ent.concat({ pseudo: 'Q' }) : ent, cantidad };
      }
      let masCercano = null;
      for (const cod of listaCodigos) {
        if (!s.startsWith(cod)) continue;
        const prod = porCodigo.get(cod);
        const resto = s.slice(cod.length);
        const ent = resto === '' ? [] : segmentar(resto, vocabDe(prod));
        if (ent) return { producto: prod, pend: ent, cantidad };
        if (!masCercano) masCercano = { prod, resto };
      }
      if (masCercano) return { error: `“${seg}”: ${masCercano.prod.nombre} no lleva “${masCercano.resto}”.` };
      return { error: `No existe el código “${seg}”.` };
    }

    function terminar(l) {
      const base = l.producto;
      const K = base.codigo.toUpperCase();
      let prod = base;
      let extras = l.pend.filter((e) => e.extra).map((e) => e.extra);
      const conQ = l.pend.some((e) => e.pseudo === 'Q');
      const conQAma = l.pend.some((e) => e.pseudo === 'QAMA');
      const carnes = extras.filter((x) => x.grupo === GRUPO_CARNE);

      if (ESPECIAL[K] && carnes.length) prod = porCodigo.get(ESPECIAL[K].toUpperCase()) || base;
      if (FAMILIAS[K]) {
        const f = CODIGOS_FAMILIA[FAMILIAS[K]];
        const propia = K.endsWith('ARRA') ? 'ARRA' : K.endsWith('ASA') ? 'ASA' : null;
        const carnesCod = new Set(carnes.map((x) => x.codigo.toUpperCase()));
        if (propia) carnesCod.add(propia);
        const destino = carnesCod.has('ARRA') ? f.arra : carnesCod.has('ASA') ? f.asa : f.base;
        const propiaDestino = destino === f.arra ? 'ARRA' : destino === f.asa ? 'ASA' : null;
        prod = porCodigo.get(destino.toUpperCase()) || base;
        const nuevas = [];
        for (const c of carnesCod) if (c !== propiaDestino && extraPorCodigo.get(c)) nuevas.push(extraPorCodigo.get(c));
        extras = nuevas.concat(extras.filter((x) => x.grupo !== GRUPO_CARNE));
      }
      if (conQ) {
        if (K === 'TOR') prod = porCodigo.get('TORQ') || base;
        else if (K === 'HAR') prod = porCodigo.get('Q') || base;
      }
      if (conQAma) {
        const asadero = extras.find((x) => (x.codigo || '').toUpperCase() === 'QASA');
        const ambos = extraPorCodigo.get('QAMAQASA');
        if (asadero && ambos) extras = extras.filter((x) => x !== asadero).concat(ambos);
      }
      const ids = new Set(prod.extras.map((x) => x.id));
      for (const x of extras) {
        if (!ids.has(x.id)) return { error: `${prod.nombre} no lleva “${x.nombre}”.` };
      }
      const nCarnes = extras.filter((x) => x.grupo === GRUPO_CARNE).length;
      if (prod.max_carnes != null && nCarnes > prod.max_carnes) {
        const propia = FAMILIAS[prod.codigo.toUpperCase()] && /ASA$|ARRA$/i.test(prod.codigo);
        return { error: propia ? `${prod.nombre}: además de su carne solo caben ${prod.max_carnes} más.`
          : `${prod.nombre} lleva máximo ${prod.max_carnes} carne${prod.max_carnes === 1 ? '' : 's'}.` };
      }
      return { producto: prod, extras, cantidad: l.cantidad, plato: l.plato };
    }

    // Código del tipo ("S") suelto + modificador ("CEB") se leen juntos: "S CEB" = "SCEB"
    const codsTipo = new Set();
    for (const p of productos) for (const x of p.extras) if (x.grupo_codigo) codsTipo.add(String(x.grupo_codigo).toUpperCase());
    const piezas0 = normalizar(op.texto !== undefined ? op.texto : texto);
    const piezas = [];
    for (let i = 0; i < piezas0.length; i++) {
      const sig = piezas0[i + 1];
      if (codsTipo.has(piezas0[i]) && !porCodigo.has(piezas0[i]) && sig && sig !== '/' && !/^\d/.test(sig)) piezas.push(piezas0[i] + piezas0[++i]);
      else piezas.push(piezas0[i]);
    }
    const lineas = [];
    let cur = null;
    let cantidad = 1;
    let plato = op.plato || 1;
    for (const seg of piezas) {
      if (seg === '/') { plato = Math.max(plato, op.maxPlato || 1) + 1; cur = null; continue; }
      const num = /^(\d{1,2})X?$/.exec(seg) || /^X(\d{1,2})$/.exec(seg);
      if (num) { cantidad = Math.max(1, Number(num[1])); continue; }
      if (cur) {
        const ent = segmentar(seg, vocabDe(cur.producto));
        if (ent) { cur.pend.push(...ent); continue; }
      }
      const r = leerPedido(seg);
      if (r.error) return { error: r.error };
      cur = { producto: r.producto, pend: r.pend, cantidad: r.cantidad || cantidad, plato };
      lineas.push(cur);
      cantidad = 1;
    }
    if (lineas.length === 0) return { error: 'Escribe un código de producto (ej. 2Arra).' };
    const salida = [];
    for (const l of lineas) {
      const r = terminar(l);
      if (r.error) return { error: r.error };
      salida.push(r);
    }
    return { lineas: salida, plato };
  }

  raiz.interpretarCodigos = interpretarCodigos;
  if (typeof module !== 'undefined') module.exports = { interpretarCodigos };
})(typeof window !== 'undefined' ? window : globalThis);
