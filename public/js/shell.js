/**
 * Estructura de aplicación (barra lateral + barra superior) para Cocina, Caja y Tomar pedidos.
 * Reutiliza los botones que ya existen en el encabezado (se MUEVEN, no se copian), así que sus funciones
 * siguen igual. También agrega el interruptor "contraer / expandir menú" (escritorio) al panel del administrador.
 * Se carga después de comun.js y antes del script propio de cada pantalla.
 */
(() => {
  const CLAVE = 'comandia_menu_compacto';
  const leerPref = () => { try { return localStorage.getItem(CLAVE); } catch { return null; } };
  const guardarPref = (v) => { try { localStorage.setItem(CLAVE, v ? '1' : '0'); } catch { /* sin almacenamiento: no se recuerda */ } };
  const celular = window.matchMedia('(max-width: 900px)');
  // Primera vez: en pantallas medianas (tablet horizontal) arranca contraído para dar espacio al contenido
  const fijarCompacto = (v) => {
    document.body.classList.toggle('menu-compacto', v);
    const b = document.getElementById('menu-compactar');
    if (b) { b.setAttribute('aria-pressed', String(v)); b.title = v ? 'Expandir menú' : 'Contraer menú'; b.setAttribute('aria-label', b.title); b.textContent = b.title; }
  };
  const pref = leerPref();
  const iniciarCompacto = pref === null ? window.innerWidth < 1200 : pref === '1';

  function crearInterruptor() {
    const b = document.createElement('button');
    b.id = 'menu-compactar'; b.type = 'button'; b.className = 'btn nav-ico i-contraer menu-pie-toggle';
    b.addEventListener('click', () => {
      const v = !document.body.classList.contains('menu-compacto');
      fijarCompacto(v); guardarPref(v);
    });
    return b;
  }
  const poner = (nodo, clase) => { if (clase) nodo.classList.add(...clase.split(' ')); return nodo; };
  const ponerTitulos = (raiz) => { for (const n of raiz.querySelectorAll('.nav-ico')) if (!n.title) n.title = n.textContent.trim(); };

  /* ---- Panel del administrador: solo el interruptor ---- */
  const menuAdmin = document.getElementById('menu-principal');
  if (menuAdmin) {
    const pieAdmin = menuAdmin.querySelector('.menu-usuario');
    if (pieAdmin) pieAdmin.before(crearInterruptor());
    document.body.classList.add('shell-admin');
    ponerTitulos(menuAdmin);
    fijarCompacto(iniciarCompacto);
    return;
  }

  /* ---- Cocina, Caja y Tomar pedidos ---- */
  const pagina = document.body.dataset.shell;
  const main = document.querySelector('main.contenedor');
  const encab = document.querySelector('header.encabezado');
  if (!pagina || !main || !encab) return;
  const titulos = { cocina: 'Cocina', caja: 'Caja', pedidos: 'Tomar pedidos' };
  const nodo = (tag, clase, texto) => { const n = document.createElement(tag); if (clase) n.className = clase; if (texto !== undefined) n.textContent = texto; return n; };

  const barraBotones = encab.querySelector('.barra-botones');
  const hijos = barraBotones ? [...barraBotones.children] : [];
  const salir = hijos.find((n) => n.id === 'btn-salir');
  const acciones = hijos.filter((n) => n.id === 'btn-sonido' || n.id === 'btn-nombres');
  const enlaces = hijos.filter((n) => n !== salir && !acciones.includes(n));
  const quien = document.getElementById('quien');

  const iconoDe = (n) => {
    const h = n.getAttribute('href') || '';
    if (n.id === 'btn-seguimiento' || h.includes('vista=curso')) return 'i-preparando';
    if (n.id === 'btn-caja' || h.includes('/caja')) return 'i-caja';
    return 'i-pedidos';
  };

  const velo = nodo('div', 'menu-velo'); velo.id = 'menu-velo';
  const rejilla = nodo('div', 'panel-lateral');
  const nav = nodo('nav', 'menu-lateral'); nav.id = 'menu-principal'; nav.setAttribute('aria-label', 'Menú');
  const caja = nodo('div', 'menu-caja');
  const marca = nodo('div', 'menu-marca');
  marca.innerHTML = '<a class="marca-logo" href="../" aria-label="Comandia"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M18 80A42 42 0 0 1 102 80Z" fill="#FF7A30"/><rect x="8" y="84" width="104" height="12" rx="6" fill="#F3F7F4"/><circle cx="60" cy="30" r="8" fill="#F3F7F4"/></svg><span>coman<b>dia</b></span></a>' + '<span id="menu-negocio" class="menu-negocio"></span>';
  const lista = nodo('div', 'menu-lista');

  // Elemento de la pantalla actual (Cocina no tiene botones de navegación propios)
  if (pagina === 'cocina') {
    const a = nodo('a', 'btn nav-ico i-cocina activo', 'Cocina'); a.href = './'; a.setAttribute('aria-current', 'page');
    lista.append(a);
  }
  for (const n of enlaces) {
    n.className = 'btn nav-ico ' + iconoDe(n) + (n.classList.contains('activo') ? ' activo' : '');
    n.textContent = n.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim();   // sin el emoji de antes: el icono ahora es de línea
    lista.append(n);
  }
  const enlaceAdmin = nodo('a', 'btn nav-ico i-admin', 'Administración'); enlaceAdmin.href = '../admin/'; enlaceAdmin.hidden = true;
  lista.prepend(enlaceAdmin);

  // Usuario abajo: foto, puesto, nombre y salir
  const usuarioCaja = nodo('div', 'menu-usuario');
  const avatar = nodo('button', 'avatar avatar-btn'); avatar.type = 'button'; avatar.id = 'usuario-ini'; avatar.title = 'Cambiar mi foto'; avatar.setAttribute('aria-label', 'Cambiar mi foto');
  const datos = nodo('span', 'usuario-datos');
  const puesto = nodo('strong'); puesto.id = 'usuario-nombre';
  const persona = nodo('span'); persona.id = 'usuario-rol';
  datos.append(puesto, persona);
  usuarioCaja.append(avatar, datos);
  if (salir) {
    salir.className = 'btn-salir-menu'; salir.textContent = ''; salir.title = 'Salir'; salir.setAttribute('aria-label', 'Salir');
    usuarioCaja.append(salir);
  }
  caja.append(marca, lista, crearInterruptor(), usuarioCaja);
  nav.append(caja);

  // Barra superior: título de la pantalla, sucursal y las acciones propias (sonido, ver por nombre…)
  const derecha = nodo('div', 'panel-derecha');
  const movil = nodo('div', 'barra-movil');
  const hamb = nodo('button', 'btn-menu'); hamb.id = 'btn-menu-shell'; hamb.type = 'button'; hamb.setAttribute('aria-label', 'Abrir menú'); hamb.setAttribute('aria-expanded', 'false');
  const marcaMovil = nodo('div', 'marca-logo'); marcaMovil.innerHTML = '<a class="marca-logo" href="../" aria-label="Comandia"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M18 80A42 42 0 0 1 102 80Z" fill="#FF7A30"/><rect x="8" y="84" width="104" height="12" rx="6" fill="#F3F7F4"/><circle cx="60" cy="30" r="8" fill="#F3F7F4"/></svg><span>coman<b>dia</b></span></a>'.replace(/^<a /, '<span ').replace(/<\/a>$/, '</span>');
  const avatarMovil = nodo('button', 'avatar chico avatar-btn'); avatarMovil.type = 'button'; avatarMovil.id = 'usuario-ini-movil'; avatarMovil.setAttribute('aria-label', 'Mi perfil');
  movil.append(hamb, marcaMovil, avatarMovil);
  const barra = nodo('div', 'barra-panel');
  const titulo = nodo('h2', '', titulos[pagina] || ''); titulo.id = 'titulo-seccion';
  const acc = nodo('div', 'barra-acciones');
  for (const n of acciones) { n.classList.remove('claro'); n.classList.add('accion-barra'); acc.append(n); }
  // Botón para volver a mostrar el menú cuando se oculta por completo (Cocina)
  const mostrar = nodo('button', 'btn-compactar'); mostrar.id = 'menu-mostrar'; mostrar.type = 'button'; mostrar.title = 'Mostrar menú'; mostrar.setAttribute('aria-label', 'Mostrar menú');
  mostrar.addEventListener('click', () => document.body.classList.remove('menu-oculto'));
  barra.append(mostrar, titulo);
  if (quien) { quien.classList.add('chip-sucursal', 'quien-barra'); barra.append(quien); }
  barra.append(acc);
  derecha.append(movil, barra, main);
  rejilla.append(nav, derecha);

  // Lo que ya no se usa del encabezado queda guardado (oculto): los scripts de cada pantalla aún lo consultan
  const guardado = nodo('div'); guardado.hidden = true;
  guardado.append(...encab.childNodes);
  encab.replaceWith(guardado);
  document.body.prepend(velo, rejilla);
  document.body.classList.add('en-panel', 'shell-pagina');
  fijarCompacto(iniciarCompacto);

  // ---- Menú deslizable (celular y tablet vertical) ----
  const abrirMenu = (v) => { document.body.classList.toggle('menu-abierto', v); hamb.setAttribute('aria-expanded', String(v)); hamb.setAttribute('aria-label', v ? 'Cerrar menú' : 'Abrir menú'); };
  hamb.addEventListener('click', () => abrirMenu(!document.body.classList.contains('menu-abierto')));
  velo.addEventListener('click', () => abrirMenu(false));
  avatarMovil.addEventListener('click', () => abrirMenu(true));
  nav.addEventListener('click', (ev) => { if (ev.target.closest('.nav-ico')) abrirMenu(false); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') abrirMenu(false); });
  celular.addEventListener('change', () => abrirMenu(false));

  // Cocina: al tocar cualquier otra parte de la pantalla el menú se oculta por completo (más espacio para las comandas)
  if (pagina === 'cocina') {
    document.addEventListener('click', (ev) => {
      if (celular.matches || document.body.classList.contains('menu-oculto')) return;
      if (ev.target.closest('.menu-lateral, .barra-panel, dialog, #toast, #sonido-flotante')) return;
      document.body.classList.add('menu-oculto');
    });
  }

  // En Tomar pedidos el título sigue a la pestaña activa (Tomar pedido / Preparando)
  if (pagina === 'pedidos') {
    const t = document.getElementById('btn-tomar'), s = document.getElementById('btn-seguimiento');
    const sincronizar = () => { titulo.textContent = s && s.classList.contains('activo') ? 'Preparando' : 'Tomar pedidos'; };
    const ob = new MutationObserver(sincronizar);
    for (const b of [t, s]) if (b) ob.observe(b, { attributes: true, attributeFilter: ['class'] });
    sincronizar();
  }

  /* ---- Usuario: puesto, nombre y foto ---- */
  const PUESTOS = { admin: 'Administrador', gerente: 'Gerente de sucursal', caja: 'Caja', taquero: 'Cocina', mesero: 'Mesero' };
  const perfil = { nombre: '', puesto: '', foto: null, iniciales: '?' };
  const RUTA_FOTOS_PERFIL = '../uploads/';
  function pintarAvatares() {
    for (const id of ['usuario-ini', 'usuario-ini-movil', 'perfil-avatar']) {
      const a = document.getElementById(id);
      if (!a) continue;
      if (perfil.foto) { a.style.backgroundImage = `url("${RUTA_FOTOS_PERFIL + encodeURIComponent(perfil.foto)}")`; a.textContent = ''; a.classList.add('con-foto'); }
      else { a.style.backgroundImage = ''; a.textContent = perfil.iniciales; a.classList.remove('con-foto'); }
    }
    const q = document.getElementById('perfil-quitar'); if (q) q.hidden = !perfil.foto;
  }
  function pintarPerfil(u) {
    const partes = String(u.nombre || '').trim().split(/\s+/).filter(Boolean);
    perfil.iniciales = ((partes[0] || '?')[0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
    perfil.nombre = String(u.nombre || '').trim();
    perfil.puesto = PUESTOS[u.rol] || 'Equipo';
    perfil.foto = u.foto || null;
    puesto.textContent = perfil.puesto;
    persona.textContent = perfil.nombre;
    persona.hidden = perfil.nombre.toLowerCase() === perfil.puesto.toLowerCase();
    const r = document.getElementById('perfil-rol'), n = document.getElementById('perfil-nombre');
    if (r) r.textContent = perfil.puesto;
    if (n) n.textContent = perfil.nombre;
    enlaceAdmin.hidden = !(u.rol === 'admin' || u.rol === 'gerente');
    pintarAvatares();
  }
  let cargando = false;
  async function cargarSesion() {
    if (cargando) return;
    cargando = true;
    try {
      const s = await pedir(API + 'sesion.php');
      if (s.autenticado && s.usuario) {
        pintarPerfil(s.usuario);
        if (s.negocio) document.getElementById('menu-negocio').textContent = s.negocio.nombre;
      }
    } catch { /* el menú funciona igual sin estos datos */ }
    cargando = false;
  }
  // Se actualiza al cargar y cada vez que se inicia sesión (cuando desaparece el formulario de entrada)
  const login = document.getElementById('vista-login');
  if (login) new MutationObserver(() => { if (login.hidden) cargarSesion(); }).observe(login, { attributes: true, attributeFilter: ['hidden'] });
  cargarSesion();

  /* ---- Ventana "Mi perfil": cambiar o quitar la propia foto ---- */
  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-perfil';
  dlg.innerHTML = '<div class="formulario dialogo perfil-caja"><div id="perfil-avatar" class="avatar grande"></div><h2 id="perfil-rol"></h2><p id="perfil-nombre" class="ayuda"></p>'
    + '<input id="perfil-archivo" type="file" accept="image/jpeg,image/png,image/webp" hidden><p id="perfil-error" class="msg-error" role="alert"></p>'
    + '<div class="perfil-botones"><button id="perfil-cambiar" class="btn principal" type="button">📷 Cambiar foto</button><button id="perfil-quitar" class="btn" type="button" hidden>Quitar foto</button></div>'
    + '<div class="acciones-dialogo"><button id="perfil-cerrar" class="btn" type="button">Cerrar</button></div></div>';
  document.body.append(dlg);
  const g = (id) => document.getElementById(id);
  g('perfil-cerrar').addEventListener('click', () => dlg.close());
  const abrirPerfil = () => { g('perfil-error').textContent = ''; abrirMenu(false); pintarPerfil({ nombre: perfil.nombre, rol: Object.keys(PUESTOS).find((k) => PUESTOS[k] === perfil.puesto), foto: perfil.foto }); dlg.showModal(); };
  avatar.addEventListener('click', abrirPerfil);
  g('perfil-cambiar').addEventListener('click', () => g('perfil-archivo').click());
  async function enviarPerfil(datosForm) {
    g('perfil-error').textContent = '';
    try {
      const r = await pedir(API + 'perfil/foto.php', { method: 'POST', body: datosForm });
      perfil.foto = r.foto; pintarAvatares();
      if (typeof avisar === 'function') avisar(r.foto ? 'Foto actualizada' : 'Foto quitada');
    } catch (err) { g('perfil-error').textContent = err.message; }
  }
  g('perfil-archivo').addEventListener('change', async () => {
    const archivo = g('perfil-archivo').files[0];
    g('perfil-archivo').value = '';
    if (!archivo) return;
    const d = new FormData(); d.append('accion', 'subir'); d.append('foto', archivo);
    g('perfil-cambiar').disabled = true; await enviarPerfil(d); g('perfil-cambiar').disabled = false;
  });
  g('perfil-quitar').addEventListener('click', () => { const d = new FormData(); d.append('accion', 'quitar'); enviarPerfil(d); });
})();
