/**
 * Pantalla de prueba: le pregunta al backend (PHP) si todo funciona
 * y le pide el menú. Así se ve cómo el navegador "habla" con PHP y MySQL.
 *
 * Las rutas son relativas ("api/...") para que funcionen igual en
 * http://localhost/taqueria-app/ que en tu dominio de Hostinger.
 * (Las funciones el(), pedir() y dinero vienen de js/comun.js)
 */

async function mostrarEstado() {
  const lista = document.getElementById('estado');
  lista.replaceChildren();
  try {
    const e = await pedir('api/estado.php');
    document.getElementById('nombre-negocio').textContent = e.negocio;
    document.title = e.negocio;
    lista.append(
      el('li', '', `PHP ${e.php} funcionando`),
      el('li', '', `MySQL ${e.mysql} conectado`),
      el('li', '', `${e.productos} productos y ${e.ordenes} órdenes en la base de datos`)
    );
  } catch (err) {
    lista.append(el('li', 'error', err.message));
  }
}

async function mostrarMenu() {
  const contenedor = document.getElementById('menu');
  contenedor.replaceChildren();
  try {
    const { menu } = await pedir('api/productos.php');
    if (menu.length === 0) {
      contenedor.append(el('p', '', 'Todavía no hay productos disponibles.'));
      return;
    }
    for (const grupo of menu) {
      contenedor.append(el('h3', 'categoria', grupo.categoria));
      for (const p of grupo.productos.filter((x) => !x.agotado)) {
        const fila = el('div', 'producto');

        if (p.foto) {
          const img = document.createElement('img');
          img.className = 'foto-mini';
          img.src = p.foto;
          img.alt = p.nombre;
          img.loading = 'lazy';
          fila.append(img);
        }

        const centro = el('div', 'producto-datos');
        centro.append(el('div', 'nombre', p.nombre));
        if (p.descripcion) centro.append(el('div', 'desc', p.descripcion));

        fila.append(centro, el('div', 'precio', dinero.format(p.precio)));
        contenedor.append(fila);
      }
    }
  } catch (err) {
    contenedor.append(el('p', 'error', err.message));
  }
}

mostrarEstado();
mostrarMenu();
