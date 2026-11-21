/**
 * Carga masiva de productos (platillos): plantilla de Excel + lectura/validación de la planilla llena + fotos en ZIP.
 *
 * FLUJO
 *  1. El administrador descarga la plantilla (`generarPlantilla`). Ya trae como listas desplegables las categorías,
 *     parrillas y extras que existen en SU empresa.
 *  2. La llena (una fila = un platillo) y arma un ZIP con las fotos. La columna "Foto" lleva el NOMBRE DEL ARCHIVO
 *     de la foto dentro del ZIP (ej. taco-arrachera.jpg). Así cada foto queda ligada a su platillo.
 *  3. Sube la planilla (y el ZIP, si lleva fotos). `analizarCarga` valida todo SIN guardar nada y devuelve una vista
 *     previa (qué se crea, qué se actualiza, qué fila tiene errores).
 *  4. Al confirmar, `aplicarCarga` guarda las filas buenas (las que tienen error se omiten y se reportan).
 *
 * REGLAS
 *  - Si el Código ya existe en la empresa, la fila ACTUALIZA ese platillo; si no, lo crea. Al actualizar, una celda
 *    opcional en blanco CONSERVA el valor actual (así no se borra nada sin querer).
 *  - La categoría que no existe se crea sola (solo el dueño; el gerente no puede crear categorías).
 *  - Toda fila se valida con las MISMAS reglas que el formulario de "Nuevo platillo" (`leerCampos`).
 *  - El dueño crea en la carta general; el gerente, en los productos propios de su sucursal.
 */
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { ejecutar, fila, filas, transaccion } from './db.js';
import { ErrorHttp, fallo } from './errores.js';
import { Formulario } from './formulario.js';
import { borrarFoto, procesarFoto } from './fotos.js';
import { exigirProductoEditable, guardarExtras, leerCampos, type CamposProducto } from './rutas/admin/productos.js';

/* ------------------------------------------------------------------ */
/*  Límites                                                            */
/* ------------------------------------------------------------------ */
export const MAX_FILAS = 500;
export const MAX_PLANILLA = 5 * 1024 * 1024;
export const MAX_ZIP = 120 * 1024 * 1024;
const MAX_FOTO_ZIP = 15 * 1024 * 1024;     // por foto, ya descomprimida
const MAX_FOTOS_ZIP = 600;
const EXT_FOTO = ['jpg', 'jpeg', 'png', 'webp'];

/* ------------------------------------------------------------------ */
/*  Columnas de la plantilla                                           */
/* ------------------------------------------------------------------ */
interface Columna { clave: string; titulo: string; ancho: number; nota: string; obligatoria?: boolean }

/** Orden y significado de las columnas. `clave` es lo que reconoce el lector (sin acentos ni mayúsculas). */
const COLUMNAS: Columna[] = [
  { clave: 'codigo', titulo: 'Código', ancho: 12, nota: 'Opcional. Código corto único (letras, números y guion), p. ej. ARR-01. Sirve para el “código rápido” al levantar pedidos y para ACTUALIZAR un platillo que ya existe: si el código ya existe, esta fila lo modifica en vez de crear otro.' },
  { clave: 'nombre', titulo: 'Nombre', ancho: 30, obligatoria: true, nota: 'Obligatorio. Máximo 100 caracteres.' },
  { clave: 'categoria', titulo: 'Categoría', ancho: 20, obligatoria: true, nota: 'Obligatorio. Elige de la lista o escribe una nueva (el dueño la crea automáticamente).' },
  { clave: 'precio', titulo: 'Precio', ancho: 10, obligatoria: true, nota: 'Obligatorio. Número mayor que cero, p. ej. 25 o 25.50 (sin signo de $).' },
  { clave: 'descripcion', titulo: 'Descripción', ancho: 50, nota: 'Opcional. De qué es el platillo; la ve el cliente en el menú. Máximo 255 caracteres.' },
  { clave: 'porcion', titulo: 'Porción', ancho: 14, nota: 'Opcional. Ej. “3 tacos”, “250 g”. Máximo 40 caracteres.' },
  { clave: 'parrilla', titulo: 'Parrilla', ancho: 16, nota: 'Opcional. Estación de cocina donde se prepara. Elige de la lista.' },
  { clave: 'extras', titulo: 'Extras', ancho: 34, nota: 'Opcional. Extras que se pueden pedir con este platillo, separados por punto y coma. Usa el nombre o el código del extra, tal como están en la hoja “Listas”. Ej.: Queso; Aguacate' },
  { clave: 'pide opciones', titulo: 'Pide opciones', ancho: 14, nota: 'Opcional. Sí = al tocar el platillo siempre se abre la ventana de opciones. Vacío = No.' },
  { clave: 'disponible', titulo: 'Disponible', ancho: 12, nota: 'Opcional. Sí / No. Vacío = Sí (al actualizar, vacío conserva el valor actual).' },
  { clave: 'foto', titulo: 'Foto', ancho: 26, nota: 'Opcional. Nombre del archivo de la foto dentro del ZIP, con extensión (p. ej. taco-arrachera.jpg). Si lo dejas vacío pero el platillo tiene Código, se busca una foto llamada <código>.jpg (o .png / .webp).' },
];

const INSTRUCCIONES: string[] = [
  'CARGA MASIVA DE PLATILLOS',
  '',
  '1. En la hoja “Productos” escribe un platillo por fila, empezando en la fila 2. Las columnas con * son obligatorias: Nombre, Categoría y Precio.',
  '2. Las fotos van en un archivo ZIP aparte. En la columna “Foto” escribe el nombre exacto del archivo (ej. taco-arrachera.jpg).',
  '   Si dejas “Foto” vacía y el platillo tiene Código, se usa la foto llamada <código>.jpg (o .png / .webp).',
  '3. En el portal: Ajustes → Menú → Carga masiva. Sube la planilla y el ZIP; verás una vista previa con lo que se creará y los errores ANTES de guardar nada.',
  '',
  'REGLAS',
  '• Código: si ya existe en tu empresa, la fila ACTUALIZA ese platillo. En una actualización, las celdas opcionales en blanco conservan el valor actual.',
  '• Categoría, Parrilla y Extras: elige de las listas de la hoja “Listas”. Una categoría nueva la crea el dueño automáticamente; las parrillas y extras deben existir.',
  '• Extras: sepáralos con punto y coma (Queso; Aguacate). Puedes usar su nombre o su código.',
  '• Sí / No: Pide opciones y Disponible aceptan Sí, No (también 1/0, x).',
  '• Fotos: JPG, PNG o WebP. Se reducen y optimizan solas. Recomendado: fotos cuadradas o 4:3, de hasta unos 2 MB cada una.',
  '• Máximo 500 platillos por carga y 120 MB en el ZIP. Si tienes más, divídelos en varias cargas.',
  '• No cambies los títulos de la fila 1 ni el nombre de la hoja “Productos”.',
  '• La hoja “Ejemplo” solo ilustra cómo llenar la planilla; no se importa.',
];

const EJEMPLOS: string[][] = [
  ['ARR-01', 'Taco de arrachera', 'Tacos', '35', 'Tortilla de maíz con arrachera asada, cebolla y cilantro.', '1 taco', 'Parrilla', 'Queso; Aguacate', 'Sí', 'Sí', 'taco-arrachera.jpg'],
  ['', 'Agua de horchata', 'Bebidas', '30', 'Agua fresca de arroz con canela. Vaso de 500 ml.', '500 ml', '', '', 'No', 'Sí', 'horchata.jpg'],
  ['GUAC', 'Guacamole', 'Entradas', '60.50', 'Aguacate, jitomate, cebolla y chile serrano, con totopos.', '', '', '', '', '', ''],
];

/* ------------------------------------------------------------------ */
/*  Utilidades de texto                                                */
/* ------------------------------------------------------------------ */
/** Para comparar nombres sin importar mayúsculas, acentos ni espacios repetidos. */
export const normalizar = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Convierte el valor de una celda de Excel (texto, número, fecha, fórmula, texto con formato…) en texto simple. */
function textoCelda(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o['richText'])) return (o['richText'] as { text: string }[]).map((r) => r.text).join('').trim();
    if ('result' in o && o['result'] !== undefined) return textoCelda(o['result'] as ExcelJS.CellValue);
    if (typeof o['text'] === 'string') return o['text'].trim();
    if ('error' in o) return '';
  }
  return '';
}

/** "Sí/No" de la planilla → '1' | '0' | null (vacío o no reconocido). */
function siNo(t: string): '1' | '0' | null | 'raro' {
  const n = normalizar(t);
  if (n === '') return null;
  if (['si', 's', '1', 'x', 'true', 'yes', 'y', 'verdadero'].includes(n)) return '1';
  if (['no', 'n', '0', 'false', 'falso'].includes(n)) return '0';
  return 'raro';
}

/* ------------------------------------------------------------------ */
/*  Plantilla                                                          */
/* ------------------------------------------------------------------ */
export interface ListasPlantilla {
  categorias: string[];
  parrillas: string[];
  extras: { nombre: string; codigo: string | null; grupo: string | null }[];
}

/** Lee de la base las listas de la empresa para la plantilla. */
export async function listasDeLaEmpresa(nid: number): Promise<ListasPlantilla> {
  return {
    categorias: (await filas('SELECT nombre FROM categorias WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((c) => String(c['nombre'])),
    parrillas: (await filas('SELECT nombre FROM estaciones WHERE negocio_id = ? ORDER BY orden, id', [nid])).map((c) => String(c['nombre'])),
    extras: (await filas('SELECT nombre, codigo, grupo FROM extras WHERE negocio_id = ? AND activo = 1 ORDER BY orden, id', [nid])).map((x) => ({
      nombre: String(x['nombre']), codigo: (x['codigo'] as string | null) ?? null, grupo: (x['grupo'] as string | null) ?? null,
    })),
  };
}

/** Genera el .xlsx de la plantilla (hojas: Instrucciones, Productos, Ejemplo, Listas). */
export async function generarPlantilla(listas: ListasPlantilla): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Comandia';
  const colorEncabezado = 'FF7A1F2B';

  /* --- Instrucciones --- */
  const hi = libro.addWorksheet('Instrucciones', { views: [{ showGridLines: false }] });
  hi.getColumn(1).width = 120;
  INSTRUCCIONES.forEach((t, i) => {
    const c = hi.getCell(i + 1, 1);
    c.value = t;
    c.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) c.font = { bold: true, size: 16, color: { argb: colorEncabezado } };
    else if (t === 'REGLAS') c.font = { bold: true, size: 12 };
  });

  /* --- Hojas con encabezado de columnas --- */
  const encabezado = (h: ExcelJS.Worksheet): void => {
    COLUMNAS.forEach((col, i) => {
      h.getColumn(i + 1).width = col.ancho;
      const c = h.getCell(1, i + 1);
      c.value = col.obligatoria ? `${col.titulo} *` : col.titulo;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col.obligatoria ? colorEncabezado : 'FF8A6D5B' } };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.note = col.nota;
    });
    h.getRow(1).height = 26;
    h.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const hp = libro.addWorksheet('Productos');
  encabezado(hp);
  const he = libro.addWorksheet('Ejemplo');
  encabezado(he);
  EJEMPLOS.forEach((f, r) => f.forEach((v, c) => { he.getCell(r + 2, c + 1).value = v === '' ? null : v; }));
  for (const fila_ of [2, 3, 4]) he.getRow(fila_).font = { italic: true, color: { argb: 'FF6F5F52' } };
  // La columna de precio e identificadores como texto/número simple
  hp.getColumn(4).numFmt = '0.00';
  he.getColumn(4).numFmt = '0.00';

  /* --- Listas (las que alimentan los desplegables) --- */
  const hl = libro.addWorksheet('Listas');
  const titulosListas = ['Categorías', 'Parrillas', 'Extras (nombre)', 'Extras (código)', 'Extras (sección)', 'Sí / No'];
  titulosListas.forEach((t, i) => {
    const c = hl.getCell(1, i + 1);
    c.value = t; c.font = { bold: true };
    hl.getColumn(i + 1).width = 22;
  });
  listas.categorias.forEach((v, i) => { hl.getCell(i + 2, 1).value = v; });
  listas.parrillas.forEach((v, i) => { hl.getCell(i + 2, 2).value = v; });
  listas.extras.forEach((x, i) => { hl.getCell(i + 2, 3).value = x.nombre; hl.getCell(i + 2, 4).value = x.codigo; hl.getCell(i + 2, 5).value = x.grupo; });
  hl.getCell(2, 6).value = 'Sí'; hl.getCell(3, 6).value = 'No';

  /* --- Desplegables en "Productos" (filas 2 a MAX_FILAS+1). No bloquean escribir un valor distinto: solo avisan. --- */
  const ultima = MAX_FILAS + 1;
  const lista = (rango: string): ExcelJS.DataValidation => ({ type: 'list', allowBlank: true, formulae: [rango], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Valor nuevo', error: 'Ese valor no está en la lista de la hoja “Listas”. ¿Seguro que quieres usarlo?' });
  const sino: ExcelJS.DataValidation = { type: 'list', allowBlank: true, formulae: ['"Sí,No"'], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Sí o No', error: 'Escribe Sí o No.' };
  const finCat = Math.max(2, listas.categorias.length + 1), finPar = Math.max(2, listas.parrillas.length + 1);
  for (let r = 2; r <= ultima; r++) {
    hp.getCell(r, 3).dataValidation = lista(`Listas!$A$2:$A$${finCat}`);
    hp.getCell(r, 7).dataValidation = lista(`Listas!$B$2:$B$${finPar}`);
    hp.getCell(r, 9).dataValidation = sino;
    hp.getCell(r, 10).dataValidation = sino;
  }

  libro.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];
  return Buffer.from(await libro.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ */
/*  Análisis de la planilla                                            */
/* ------------------------------------------------------------------ */
export interface FilaCarga {
  /** Número de fila en el Excel (para que el usuario la encuentre). */
  fila: number;
  accion: 'crear' | 'actualizar' | 'error';
  nombre: string;
  categoria: string;
  precio: string;
  codigo: string;
  /** 'nueva' (se sube la del ZIP), 'conserva' (se queda la actual), 'ninguna' (sin foto) o 'falta' (la pidió pero no está en el ZIP). */
  foto: 'nueva' | 'conserva' | 'ninguna' | 'falta';
  errores: string[];
  avisos: string[];
}
interface FilaPreparada extends FilaCarga {
  campos?: CamposProducto;
  categoriaId?: number;
  idExistente?: number;
  fotoActual?: string | null;
  bytesFoto?: Uint8Array;
}
export interface ResultadoCarga {
  filas: FilaCarga[];
  nuevos: number;
  actualizados: number;
  con_error: number;
  categorias_nuevas: string[];
  fotos_sin_usar: string[];
}
interface Contexto { nid: number; alcance: number | null }
export interface AnalisisCarga { resultado: ResultadoCarga; preparadas: FilaPreparada[] }

/** Descomprime el ZIP de fotos con límites (cuántas, cuánto pesa cada una). Devuelve nombre-en-minúsculas → bytes. */
function leerZip(zip: Buffer | null): Map<string, Uint8Array> {
  const mapa = new Map<string, Uint8Array>();
  if (!zip) return mapa;
  let contenido: Record<string, Uint8Array>;
  try {
    let n = 0;
    contenido = unzipSync(new Uint8Array(zip), {
      filter: (f) => {
        const base = f.name.split('/').pop() ?? '';
        if (f.name.endsWith('/') || base.startsWith('.') || f.name.startsWith('__MACOSX/')) return false;
        if (!EXT_FOTO.includes((base.split('.').pop() ?? '').toLowerCase())) return false;
        if (f.originalSize > MAX_FOTO_ZIP) throw fallo(`La foto “${base}” pesa más de 15 MB. Redúcela y vuelve a armar el ZIP.`);
        if (++n > MAX_FOTOS_ZIP) throw fallo(`El ZIP trae más de ${MAX_FOTOS_ZIP} fotos. Divide la carga en varias.`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ErrorHttp) throw e;
    throw fallo('No se pudo abrir el ZIP de fotos. Verifica que sea un .zip válido (no .rar ni .7z).');
  }
  for (const [ruta, bytes] of Object.entries(contenido)) {
    const base = (ruta.split('/').pop() ?? ruta).toLowerCase();
    if (!mapa.has(base)) mapa.set(base, bytes);
  }
  return mapa;
}

/** Valida la planilla y el ZIP sin guardar nada. */
export async function analizarCarga(ctx: Contexto, planilla: Buffer, zip: Buffer | null): Promise<AnalisisCarga> {
  const { nid, alcance } = ctx;
  const esDueno = alcance === null;

  /* --- Abrir el Excel --- */
  const libro = new ExcelJS.Workbook();
  try {
    await libro.xlsx.load(planilla as unknown as ExcelJS.Buffer);
  } catch {
    throw fallo('No se pudo leer la planilla. Usa un archivo .xlsx (Excel), idealmente la plantilla descargada del portal.');
  }
  const hoja = libro.worksheets.find((h) => normalizar(h.name) === 'productos') ?? libro.worksheets.find((h) => normalizar(h.name) !== 'instrucciones' && normalizar(h.name) !== 'listas' && normalizar(h.name) !== 'ejemplo');
  if (!hoja) throw fallo('No encontré la hoja “Productos” en la planilla.');

  /* --- Encabezados: cada título → número de columna --- */
  const col = new Map<string, number>();
  hoja.getRow(1).eachCell((c, n) => {
    const t = normalizar(textoCelda(c.value).replace(/\*/g, ''));
    const clave = t === 'estacion' ? 'parrilla' : t === 'pedir opciones' ? 'pide opciones' : t;
    if (COLUMNAS.some((k) => k.clave === clave)) col.set(clave, n);
  });
  for (const c of COLUMNAS.filter((k) => k.obligatoria)) {
    if (!col.has(c.clave)) throw fallo(`Falta la columna “${c.titulo}” en la fila 1 de la hoja “${hoja.name}”. Descarga la plantilla otra vez.`);
  }
  const valor = (r: ExcelJS.Row, clave: string): string => {
    const n = col.get(clave);
    return n ? textoCelda(r.getCell(n).value) : '';
  };

  /* --- Catálogos de la empresa (para traducir nombres a ids) --- */
  const cats = new Map<string, number>();
  for (const c of await filas('SELECT id, nombre FROM categorias WHERE negocio_id = ?', [nid])) cats.set(normalizar(String(c['nombre'])), Number(c['id']));
  const parrillas = new Map<string, number>();
  for (const e of await filas('SELECT id, nombre FROM estaciones WHERE negocio_id = ?', [nid])) parrillas.set(normalizar(String(e['nombre'])), Number(e['id']));
  const extrasPorClave = new Map<string, number>();
  for (const x of await filas('SELECT id, nombre, codigo FROM extras WHERE negocio_id = ? ORDER BY orden, id DESC', [nid])) {
    extrasPorClave.set(normalizar(String(x['nombre'])), Number(x['id']));
    if (x['codigo']) extrasPorClave.set(normalizar(String(x['codigo'])), Number(x['id']));
  }
  const fotos = leerZip(zip);
  const fotosUsadas = new Set<string>();

  const preparadas: FilaPreparada[] = [];
  const categoriasNuevas = new Map<string, string>();   // normalizado → como la escribieron
  const codigosVistos = new Set<string>();
  let leidas = 0;

  for (let n = 2; n <= hoja.rowCount; n++) {
    const r = hoja.getRow(n);
    const crudo = COLUMNAS.map((c) => valor(r, c.clave));
    if (crudo.every((t) => t === '')) continue;              // fila vacía
    if (++leidas > MAX_FILAS) throw fallo(`La planilla tiene más de ${MAX_FILAS} platillos. Divide la carga en varias.`);

    const p: FilaPreparada = {
      fila: n, accion: 'crear', nombre: valor(r, 'nombre'), categoria: valor(r, 'categoria'),
      precio: valor(r, 'precio').replace(/[$\s]/g, ''), codigo: valor(r, 'codigo').toLocaleUpperCase('es-MX'),
      foto: 'ninguna', errores: [], avisos: [],
    };
    preparadas.push(p);

    try {
      /* ¿El código ya existe? → se actualiza ese platillo */
      let previo: Record<string, unknown> | undefined;
      let extrasPrevios: number[] = [];
      let preciosPrevios: Record<number, number> = {};
      if (p.codigo !== '') {
        if (codigosVistos.has(p.codigo)) throw fallo(`El código ${p.codigo} se repite en la planilla.`);
        codigosVistos.add(p.codigo);
        previo = await fila('SELECT id, nombre, categoria_id, descripcion, precio, foto, disponible, porcion, estacion_id, pedir_opciones FROM productos WHERE negocio_id = ? AND codigo = ?', [nid, p.codigo]);
        if (previo) {
          p.accion = 'actualizar';
          p.idExistente = Number(previo['id']);
          p.fotoActual = (previo['foto'] as string | null) ?? null;
          await exigirProductoEditable(nid, alcance, p.idExistente);
          for (const e of await filas('SELECT extra_id, precio FROM producto_extras WHERE producto_id = ?', [p.idExistente])) {
            extrasPrevios.push(Number(e['extra_id']));
            if (e['precio'] !== null) preciosPrevios[Number(e['extra_id'])] = Number(e['precio']);
          }
        }
      }
      const actualiza = !!previo;
      const prev = (k: string): string => (previo && previo[k] !== null && previo[k] !== undefined ? String(previo[k]) : '');

      /* Categoría: existente, nueva (solo el dueño) o error */
      let categoriaPorCrear = false;
      const idCat = cats.get(normalizar(p.categoria));
      if (p.categoria === '') throw fallo('Falta la categoría.');
      if (idCat) p.categoriaId = idCat;
      else if (esDueno) { categoriaPorCrear = true; if (!categoriasNuevas.has(normalizar(p.categoria))) categoriasNuevas.set(normalizar(p.categoria), p.categoria); p.avisos.push(`La categoría “${p.categoria}” se creará.`); }
      else throw fallo(`La categoría “${p.categoria}” no existe. Pídele al dueño que la cree.`);

      /* Parrilla */
      const tParrilla = valor(r, 'parrilla');
      let parrillaId = actualiza ? prev('estacion_id') : '';
      if (tParrilla !== '') {
        const id = parrillas.get(normalizar(tParrilla));
        if (!id) throw fallo(`La parrilla “${tParrilla}” no existe.`);
        parrillaId = String(id);
      }

      /* Extras (nombre o código, separados por ; o ,) */
      const tExtras = valor(r, 'extras');
      let extras = extrasPrevios;
      if (tExtras !== '') {
        extras = [];
        for (const pieza of tExtras.split(/[;,]/).map((x) => x.trim()).filter(Boolean)) {
          const id = extrasPorClave.get(normalizar(pieza));
          if (!id) throw fallo(`El extra “${pieza}” no existe (revisa la hoja “Listas”).`);
          if (!extras.includes(id)) extras.push(id);
        }
      }

      /* Sí/No */
      const sPide = siNo(valor(r, 'pide opciones')), sDisp = siNo(valor(r, 'disponible'));
      if (sPide === 'raro') throw fallo('“Pide opciones” debe ser Sí o No.');
      if (sDisp === 'raro') throw fallo('“Disponible” debe ser Sí o No.');

      /* Mismas reglas que el formulario de “Nuevo platillo” */
      const celda = (clave: string, anterior: string): string => { const t = valor(r, clave); return t !== '' ? t : anterior; };
      const f = new Formulario(new Map<string, string[]>([
        ['nombre', [p.nombre]],
        ['categoria_id', [String(p.categoriaId ?? 0)]],
        ['precio', [p.precio]],
        ['descripcion', [celda('descripcion', prev('descripcion'))]],
        ['codigo', [p.codigo]],
        ['porcion', [celda('porcion', prev('porcion'))]],
        ['estacion_id', [parrillaId]],
        ['extras', [extras.join(',')]],
        ['precios_extra', [JSON.stringify(preciosPrevios)]],
        ['disponible', [sDisp ?? (actualiza ? prev('disponible') : '1')]],
        ['pedir_opciones', [sPide ?? (actualiza ? prev('pedir_opciones') : '0')]],
      ]), null);
      p.campos = await leerCampos(nid, alcance, f, p.idExistente ?? 0, categoriaPorCrear);

      /* Foto: la de la columna "Foto" o, si falta, <código>.jpg/.png/.webp */
      const tFoto = valor(r, 'foto');
      let clave = '';
      if (tFoto !== '') {
        clave = (tFoto.split(/[\\/]/).pop() ?? tFoto).toLowerCase();
        if (!fotos.has(clave)) {
          p.foto = 'falta';
          p.avisos.push(zip ? `No encontré la foto “${tFoto}” en el ZIP.` : `Pide la foto “${tFoto}” pero no subiste el ZIP de fotos.`);
          clave = '';
        }
      } else if (p.codigo !== '') {
        clave = EXT_FOTO.map((e) => `${p.codigo.toLowerCase()}.${e}`).find((c) => fotos.has(c)) ?? '';
      }
      if (clave !== '') {
        const bytes = fotos.get(clave);
        try {
          const m = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
          if (!m.width || !m.height) throw new Error('sin tamaño');
          p.bytesFoto = bytes; p.foto = 'nueva'; fotosUsadas.add(clave);
        } catch {
          p.foto = 'falta';
          p.avisos.push(`La foto “${clave}” no es una imagen válida.`);
        }
      }
      if (p.foto === 'ninguna' && actualiza && p.fotoActual) p.foto = 'conserva';
    } catch (e) {
      if (e instanceof ErrorHttp) { p.accion = 'error'; p.errores.push(e.message); }
      else throw e;
    }
    // Campos solo para uso interno; en pantalla se muestra el valor ya normalizado
    if (p.campos) { p.nombre = p.campos.nombre; p.precio = p.campos.precio; }
  }

  if (preparadas.length === 0) throw fallo('La planilla no tiene platillos. Llena la hoja “Productos” desde la fila 2.');

  const resultado: ResultadoCarga = {
    filas: preparadas.map(({ fila: fi, accion, nombre, categoria, precio, codigo, foto, errores, avisos }) => ({ fila: fi, accion, nombre, categoria, precio, codigo, foto, errores, avisos })),
    nuevos: preparadas.filter((p) => p.accion === 'crear').length,
    actualizados: preparadas.filter((p) => p.accion === 'actualizar').length,
    con_error: preparadas.filter((p) => p.accion === 'error').length,
    categorias_nuevas: [...categoriasNuevas.values()],
    fotos_sin_usar: [...fotos.keys()].filter((k) => !fotosUsadas.has(k)),
  };
  return { resultado, preparadas };
}

/* ------------------------------------------------------------------ */
/*  Aplicar                                                            */
/* ------------------------------------------------------------------ */
/** Guarda las filas válidas. Las que fallen al guardar se reportan como error; las demás sí quedan. */
export async function aplicarCarga(ctx: Contexto, analisis: AnalisisCarga): Promise<ResultadoCarga> {
  const { nid, alcance } = ctx;
  const { preparadas, resultado } = analisis;

  /* Categorías nuevas (solo el dueño; el análisis ya rechazó al gerente) */
  const idsCat = new Map<string, number>();
  for (const c of await filas('SELECT id, nombre FROM categorias WHERE negocio_id = ?', [nid])) idsCat.set(normalizar(String(c['nombre'])), Number(c['id']));
  for (const nombre of resultado.categorias_nuevas) {
    if (idsCat.has(normalizar(nombre))) continue;
    const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM categorias WHERE negocio_id = ?', [nid]);
    const r = await ejecutar('INSERT INTO categorias (negocio_id, nombre, orden) VALUES (?, ?, ?)', [nid, nombre.slice(0, 60), Number(sig?.['n'])]);
    idsCat.set(normalizar(nombre), r.insertId);
  }

  let nuevos = 0, actualizados = 0;
  for (const p of preparadas) {
    if (p.accion === 'error' || !p.campos) continue;
    const c = p.campos;
    const categoriaId = p.categoriaId ?? idsCat.get(normalizar(p.categoria));
    let fotoNueva: string | null = null;
    try {
      if (!categoriaId) throw fallo('No se pudo crear la categoría.');
      if (p.bytesFoto) {
        try { fotoNueva = await procesarFoto(Buffer.from(p.bytesFoto), nid); }
        catch (e) { p.avisos.push(e instanceof ErrorHttp ? e.message : 'No se pudo guardar la foto.'); p.foto = 'falta'; }
      }
      if (p.accion === 'actualizar' && p.idExistente) {
        const id = p.idExistente;
        await transaccion(async (tx) => {
          await tx.ejecutar(
            `UPDATE productos SET categoria_id = ?, nombre = ?, descripcion = ?, precio = ?, foto = ?, disponible = ?,
                    codigo = ?, porcion = ?, estacion_id = ?, pedir_opciones = ? WHERE id = ? AND negocio_id = ?`,
            [categoriaId, c.nombre, c.descripcion, c.precio, fotoNueva ?? p.fotoActual ?? null, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, id, nid],
          );
          await guardarExtras(tx, id, c.extras, c.preciosExtra);
        });
        if (fotoNueva && p.fotoActual) await borrarFoto(p.fotoActual, nid);   // ya no se usa la foto vieja
        actualizados++;
      } else {
        await transaccion(async (tx) => {
          const sig = await fila('SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM productos WHERE negocio_id = ? AND categoria_id = ?', [nid, categoriaId]);
          const r = await tx.ejecutar(
            `INSERT INTO productos (negocio_id, sucursal_id, categoria_id, nombre, descripcion, precio, foto, disponible, codigo, porcion, estacion_id, pedir_opciones, orden)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [nid, alcance, categoriaId, c.nombre, c.descripcion, c.precio, fotoNueva, c.disponible, c.codigo, c.porcion, c.estacionId, c.pedirOpciones, Number(sig?.['n'])],
          );
          await guardarExtras(tx, r.insertId, c.extras, c.preciosExtra);
        });
        nuevos++;
      }
    } catch (e) {
      await borrarFoto(fotoNueva, nid);   // si la fila no se pudo guardar, no deja la foto huérfana
      p.accion = 'error';
      p.errores.push(e instanceof ErrorHttp ? e.message : 'No se pudo guardar esta fila.');
      if (!(e instanceof ErrorHttp)) console.error('Carga masiva: error al guardar la fila', p.fila, e);
    }
  }

  return {
    ...resultado,
    filas: preparadas.map(({ fila: fi, accion, nombre, categoria, precio, codigo, foto, errores, avisos }) => ({ fila: fi, accion, nombre, categoria, precio, codigo, foto, errores, avisos })),
    nuevos, actualizados,
    con_error: preparadas.filter((p) => p.accion === 'error').length,
  };
}
