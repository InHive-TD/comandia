# Plantilla de carga masiva de platillos

`plantilla-platillos.xlsx` es la plantilla base (con listas de ejemplo). Se regenera con `npm run plantilla`.
Desde el portal (**Ajustes → Menú → Carga masiva**) se descarga una versión con las categorías, parrillas y extras reales de cada empresa.

## Estructura (hoja "Productos", una fila por platillo)

| Columna | Obligatoria | Qué lleva |
|---|---|---|
| Código | No | Código corto único (A-Z, 0-9, guion). Si ya existe, la fila **actualiza** ese platillo. |
| Nombre | **Sí** | Máx. 100 caracteres. |
| Categoría | **Sí** | De la lista, o una nueva (la crea el dueño). |
| Precio | **Sí** | Número > 0 (25 o 25.50). |
| Descripción | No | De qué es el platillo; la ve el cliente en el menú. Máx. 255. |
| Porción | No | Ej. "3 tacos", "250 g". Máx. 40. |
| Parrilla | No | Estación de cocina (debe existir). |
| Extras | No | Nombres o códigos separados por `;`. |
| Pide opciones | No | Sí/No. Vacío = No. |
| Disponible | No | Sí/No. Vacío = Sí. |
| Foto | No | Nombre del archivo dentro del ZIP (ej. `taco-arrachera.jpg`). Vacío + Código → se busca `<código>.jpg/.png/.webp`. |

## Fotos
Se suben en un ZIP aparte (JPG, PNG o WebP). La foto se liga al platillo por el **nombre de archivo** de la columna *Foto*.
Se reducen y optimizan solas. Máx. 120 MB por ZIP, 600 fotos, 15 MB por foto, 500 platillos por carga.

## Reglas
- Primero se muestra una **vista previa**; no se guarda nada hasta confirmar. Las filas con error se omiten y se reportan.
- Al actualizar (código existente), las celdas opcionales en blanco **conservan** el valor actual.
- El dueño carga en la carta general; el gerente, en los productos propios de su sucursal (no puede crear categorías ni modificar la carta general).
