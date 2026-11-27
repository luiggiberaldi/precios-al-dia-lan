# Plan de Implementación: Creación y Edición Intuitiva con Presentaciones de 1, 2 o 3 Niveles

> **Para ejecutar este plan:** implementar tarea por tarea en orden estricto (TDD en la lógica pura primero, luego formulario modular con vista previa, y finalmente consumidores en Caja, Inventario y E2E).

**Goal:** Rediseñar el flujo de creación/edición de artículos (`Nuevo Producto` / `Editar Producto`) con una UX de 2 columnas + vista previa viva y un modelo de **1, 2 o 3 niveles con nombres personalizados** (estilo farmacia simplificado: ej. *Caja → Blíster/Paquete → Unidad/Tableta*), manteniendo 100% compatibilidad hacia atrás con productos existentes, multi-caja y ventas en curso.

**Architecture:** Todo el inventario (`product.stock`) y las alertas (`lowStockAlert`) permanecen **siempre en unidad base** (Nivel 1 indivisible, o `kg`/`L` en granel). Encima se introduce un arreglo ordenado `presentations` de 1 a 3 niveles con cálculo automático de factores en cascada (`factorToBase`), reparto bidireccional de costo según factura, validación de márgenes por nivel vendible y proyección automática a los campos legacy (`packagingType`, `unit`, `unitsPerPackage`, `sellByUnit`, `unitPriceUsd`, `unitPriceCop`, `midPack`, `altBarcodes`) hasta retirar la duplicación entre `ProductFormQuick.jsx` y `ProductFormWizard.jsx`.

**Tech Stack:** React 19, Vite, Tailwind CSS + tokens OKLCH (`src/styles/tokens.css`), Lucide React, Vitest, Testing Library, Playwright.

**Skills / Guías de referencia aplicables:** `ui-ux-pro-max` (accesibilidad WCAG >= 4.5:1, targets `>= 44×44px`, sin emojis como íconos de UI, `gap-2` mínimo, validación inline) y `frontend-design` (coherencia con paleta `#fbfaf7`/`#f5f3ee`/`#01696f`, `Work Sans` + `JetBrains Mono` con `tabular-nums`, jerarquía visual limpia sin ruido de scroll).

---

## Diagnóstico de Problemas Actuales a Resolver

1. **Contradicción visual en `Vista Rápida` y `Asistente`:** en [`src/components/Products/ProductFormQuick.jsx`](../../src/components/Products/ProductFormQuick.jsx#L305-L415) y [`src/components/Products/ProductFormWizard.jsx`](../../src/components/Products/ProductFormWizard.jsx#L398-L420), al dejar marcado **Suelto**, aparece igual `UDS. POR BULTO / CAJA (Opcional)` justo encima de `COSTO DE ADQUISICIÓN (UNIDAD)`. Esto induce duda sobre si el costo y precio corresponden a la unidad o a la caja.
2. **Límite rígido a 2 niveles y etiquetas fijas:** [`src/utils/productProcessor.js`](../../src/utils/productProcessor.js#L156-L166) solo modela `suelto` | `lote` (forzando `unit = 'paquete'`) con un único `unitsPerPackage` y `sellByUnit`. No soporta 3 niveles (ej. *Caja → Blíster → Tableta* o *Bulto → Display → Unidad*), y las vistas (`SearchBar.jsx`, `CategoryBar.jsx`, `granel.js`, `ProductCard.jsx`) muestran textos fijos (`"Caja/Bulto"`, `"Bto xN"`, `"Bulto · N uds"`).
3. **Desfase `stockInLotes` vs `stock` (INV-16):** [`src/utils/productProcessor.js`](../../src/utils/productProcessor.js#L253) trunca `stockInLotes` con `parseInt`, mientras `stock` se calcula con `parseFloat` + `Math.round`. Se debe eliminar `stockInLotes` como fuente persistida y derivar el desglose siempre desde `stock`.
4. **Duplicación de UI (~1,946 líneas) y falta de vista previa:** `ProductFormQuick.jsx` (979 líneas) y `ProductFormWizard.jsx` (967 líneas) duplican formularios verticales largos dentro de `max-w-sm md:max-w-3xl`, sin mostrar al comerciante cómo quedará el botón en Caja ni alertar si la caja sale más cara que las unidades sueltas.

---

## Convención del Modelo de Datos (1, 2 o 3 Niveles)

### Esquema canónico en cada `product`

```js
// Nivel 1 (Base) siempre en índice 0; niveles superiores ordenados ascendentemente por factor.
presentations: [
  {
    id: 'unit',              // Nivel 1 (Base): 'unit' | Nivel 2 (Medio): 'mid' | Nivel 3 (Mayor): 'pack'
    level: 1,                // 1 | 2 | 3
    name: 'Tableta',         // Nombre corto editable (ej. 'Unidad', 'Tableta', 'Sobre', 'Pza')
    containsQty: 1,          // Siempre 1 en Nivel 1
    factorToBase: 1,         // Acumulado contra Nivel 1: lvl1=1, lvl2=containsQty2, lvl3=containsQty2*containsQty3
    sellable: true,          // ¿Aparece como opción de venta en Caja?
    priceUsd: 0.25,          // Precio en USD (normalizePriceUsd)
    priceCop: 1000,          // Precio COP si aplica, o null
    priceBsUsdRef: null,     // Referencia dual USD para cobro en Bs si pricingMode === 'dual_usd'
    costUsd: 0.12,           // Costo calculado o fuente para este nivel
    barcode: null,           // Código de barras opcional propio de esta presentación
  },
  {
    id: 'mid',
    level: 2,
    name: 'Blíster',
    containsQty: 10,         // Trae 10 Tabletas
    factorToBase: 10,
    sellable: true,
    priceUsd: 2.20,
    priceCop: 8800,
    priceBsUsdRef: null,
    costUsd: 1.20,
    barcode: '7590000000102',
  },
  {
    id: 'pack',
    level: 3,
    name: 'Caja',
    containsQty: 3,          // Trae 3 Blísters (= 30 Tabletas)
    factorToBase: 30,
    sellable: true,
    priceUsd: 6.00,
    priceCop: 24000,
    priceBsUsdRef: null,
    costUsd: 3.60,
    barcode: '7590000000300',
  },
]
```

Campos auxiliares en `product`:
- `packagingMode`: `'simple' | 'multilevel' | 'granel'` (nuevo selector de intención clara; convive con `packagingType` legacy `'suelto' | 'lote' | 'granel'`).
- `costSourceLevel`: `'unit' | 'mid' | 'pack'` (recuerda en qué presentación compra el proveedor al editar el producto).
- `presentations`: arreglo opcional; si no existe (productos antiguos), `resolveProductPresentations(product)` lo construye en memoria sin mutar el catálogo.

### Regla estricta de compatibilidad hacia atrás (`suelto` con bulto solo inventario)
- Si un producto antiguo tiene `packagingType === 'suelto'` y `unitsPerPackage = 24`:
  - `resolveProductPresentations` construye Nivel 1 (`Unidad`, `factorToBase: 1`, `sellable: true`) y Nivel 2 (`Bulto`, `factorToBase: 24`, **`sellable: false`**).
  - En Caja (`SalesView`) **no** multiplica ni pide elegir presentación (mantiene invariante de [`tests/packageStockDeduction.test.js`](../../tests/packageStockDeduction.test.js#L43-L46)), pero `StockBatchModal` sí permite ingresar por bultos de 24.
- Si tiene `packagingType === 'lote'` y `unitsPerPackage = 24`:
  - `sellByUnit === false` → Nivel 1 (`Unidad`, `sellable: false`) + Nivel 2 (`Bulto`, `factorToBase: 24`, `sellable: true`).
  - `sellByUnit === true` → Nivel 1 (`Unidad`, `sellable: true`, `priceUsd: unitPriceUsd`) + Nivel 2 (`Bulto`, `factorToBase: 24`, `sellable: true`, `priceUsd`).

---

## Fase 1 — Núcleo Puro de Presentaciones (TDD)

### Task 1: Módulo puro `src/utils/presentations.js`

**Files:**
- Create: `src/utils/presentations.js`
- Test: `tests/presentations.test.js`

**Step 1: Escribir las pruebas unitarias que fallan (`tests/presentations.test.js`)**

Cubrir al menos:
1. `buildPresetPresentations`:
   - `'simple'` → 1 nivel (`Unidad`, `factorToBase: 1`, `sellable: true`).
   - `'bulto_unidad'` / `'caja_unidad'` → 2 niveles (`Unidad` + `Bulto`/`Caja`).
   - `'caja_blister_tableta'` / `'caja_paquete_unidad'` → 3 niveles en cascada (`10` × `3` = `factorToBase: 30`).
2. `computeFactorToBase`: recalcula factores cuando cambia `containsQty` de Nivel 2 o Nivel 3 (ignora o acota `< 1` a `1` y fuerza enteros).
3. `reconcileCostCascade`: dado costo `$3.60` en `'pack'` (`factorToBase: 30`), deriva `'mid'` (`$1.20`) y `'unit'` (`$0.12`); y viceversa si `costSourceLevel === 'unit'`.
4. `resolveProductPresentations`:
   - Producto legacy `suelto` con `unitsPerPackage: 24` → Nivel 2 `sellable: false`.
   - Producto legacy `lote` con `sellByUnit: true`, `unitsPerPackage: 12`, `priceUsdt: 10`, `unitPriceUsd: 1` → Nivel 1 (`sellable: true`, `$1`) + Nivel 2 (`sellable: true`, `$10`).
   - Producto legacy `lote` con `sellByUnit: false` → Nivel 1 (`sellable: false`) + Nivel 2 (`sellable: true`).
   - Producto nuevo con `presentations` de 3 niveles → retorna exactamente los 3 niveles validados.
5. `decomposeStockByLevels` y `composeBaseStock`:
   - `decomposeStockByLevels(74, levels)` → `'2 Cajas · 1 Blíster · 4 Tabletas'`.
   - `composeBaseStock({ pack: 2, mid: 1, unit: 4 }, levels)` → `74`.
6. `validatePresentationCoherence`: detecta margen negativo (`priceUsd < costUsd`) o inversión de precio por volumen (`priceUsd(pack) > priceUsd(unit) * factorToBase`) devolviendo advertencias legibles (no bloqueantes, salvo costo/precio inválido).
7. `projectLegacyFieldsFromPresentations`: proyecta `packagingType`, `unit`, `unitsPerPackage`, `sellByUnit`, `unitPriceUsd`, `unitPriceCop`, `priceUsd`, `priceUsdt`, `costUsd`, `midPack` y `altBarcodes` sin perder datos para módulos legacy.

**Step 2: Ejecutar Vitest para confirmar fallo inicial**
Run: `npx vitest run tests/presentations.test.js`
Expected: FAIL (`Cannot find module '../src/utils/presentations.js'`).

**Step 3: Implementar `src/utils/presentations.js`**
- Usar `round2`, `round4`, `round6`, `divR`, `mulR` de `src/utils/dinero.js` y `normalizePriceUsd` de `src/utils/productProcessor.js` (o mover constantes puras compartidas si hay ciclo, evitando circular imports entre `productProcessor.js` y `presentations.js` — preferible colocar `normalizePriceUsd` en `presentations.js` o en un helper sin dependencias circulares y re-exportarla en `productProcessor.js`).
- Exportar `PRESENTATION_PRESETS`, `buildPresetPresentations`, `computeFactorToBase`, `reconcileCostCascade`, `suggestLevelPrice`, `resolveProductPresentations`, `getSellablePresentations`, `getPrimarySellablePresentation`, `findPresentationByBarcode`, `decomposeStockByLevels`, `composeBaseStock`, `validatePresentationCoherence`, `projectLegacyFieldsFromPresentations`.

**Step 4: Ejecutar pruebas y lint**
Run: `npx vitest run tests/presentations.test.js && npx eslint src/utils/presentations.js tests/presentations.test.js`
Expected: PASS con 0 errores.

---

### Task 2: Payload, Formulario Hook y Contrato Multi-Caja (`productProcessor`, `useProductForm`, `supervisorProductCommand`)

**Files:**
- Modify: [`src/utils/productProcessor.js`](../../src/utils/productProcessor.js#L105-L279)
- Modify: [`src/hooks/useProductForm.js`](../../src/hooks/useProductForm.js#L26-L229)
- Modify: [`src/services/supervisorProductCommand.js`](../../src/services/supervisorProductCommand.js#L69-L155)
- Modify: [`src/utils/duplicateMerge.js`](../../src/utils/duplicateMerge.js#L195-L235)
- Test: `tests/productProcessorPresentations.test.js`

**Step 1: Escribir pruebas TDD en `tests/productProcessorPresentations.test.js`**
1. Crear producto con 3 niveles (`Caja = 3 Blísters × 10 Tabletas`), costo ingresado por `Caja = $6.00`, precios `$7.50` / `$2.80` / `$0.30`, stock `2 Cajas + 1 Blíster + 4 Tabletas`:
   - `stock === 74` exacto.
   - `stockInLotes` es `null` (no truncado por `parseInt`).
   - `presentations` guarda los 3 niveles con `factorToBase` `1`, `10`, `30`.
   - `barcode`, `midPack.barcode` y `altBarcodes` proyectan códigos secundarios de Nivel 2/3 sin duplicar el principal.
2. Editar producto cambiando solo nombre/precio con `stockTouched: false`:
   - `applyProductFormEdit` preserva `stock` fresco del catálogo y conserva `presentations`.
3. `buildProductRevision` en `supervisorProductCommand.js` detecta cambios en `presentations`, `packagingMode`, `costSourceLevel` e ignora `stock`.

**Step 2: Ejecutar prueba para confirmar fallo**
Run: `npx vitest run tests/productProcessorPresentations.test.js`
Expected: FAIL.

**Step 3: Implementar cambios mínimos**
- En `useProductForm.js`: añadir al `INITIAL_STATE` y `prepareProductFormState` los campos `packagingMode`, `presentations`, `costSourceLevel` y `stockByLevel` (derivado en memoria con `decomposeStockByLevels`, manteniendo intacta la API legacy para callers existentes mientras dure la transición).
- En `productProcessor.js`: si `formData.presentations` viene en modo `'multilevel'` o `'simple'`, usar `computeFactorToBase` + `projectLegacyFieldsFromPresentations` para poblar el payload; mantener `stockInLotes: null` para erradicar `INV-16`; preservar compatibilidad total con granel (`isGranelProduct`).
- En `supervisorProductCommand.js`: agregar `'packagingMode'`, `'costSourceLevel'`, `'presentations'` y `'altBarcodes'` a `EDITABLE_PRODUCT_FIELDS` y normalizar en `normalizeProductFieldValue` de forma determinista para que `buildProductRevision` sea idéntico entre caja y supervisor.

**Step 4: Verificar con pruebas existentes + nuevas**
Run: `npx vitest run tests/productProcessorPresentations.test.js tests/packagingNormalization.test.js tests/packagingFixMigration.test.js tests/productIvaMode.test.js tests/productCostFactor.test.js`
Expected: PASS.

---

## Fase 2 — Deducción, Cesta, Valorización y Códigos de Barras

### Task 3: Generalizar `calculateItemStockDeduction`, `deriveCartFields`, `barcodeAssign`, `inventoryValuation` y `checkoutProcessor`

**Files:**
- Modify: [`src/utils/barcodeAssign.js`](../../src/utils/barcodeAssign.js#L9-L66)
- Modify: [`src/utils/granel.js`](../../src/utils/granel.js#L545-L560) y [`src/utils/granel.js`](../../src/utils/granel.js#L807-L829)
- Modify: [`src/utils/cartSync.js`](../../src/utils/cartSync.js#L39-L110)
- Modify: [`src/utils/inventoryValuation.js`](../../src/utils/inventoryValuation.js#L20-L55)
- Modify: [`src/utils/checkoutProcessor.js`](../../src/utils/checkoutProcessor.js#L258-L286)
- Test: `tests/multilevelStockAndCart.test.js`

**Step 1: Escribir pruebas TDD en `tests/multilevelStockAndCart.test.js`**
1. `findProductAndPresentationByCode(products, scannedCode)`:
   - Si escanean el código de la `Caja` (`presentations[2].barcode`), devuelve `{ product, presentation: cajaLevel }`.
   - Si escanean el código base compartido (`product.barcode`), devuelve `{ product, presentation: null }` para abrir el selector en Caja (salvo que solo haya 1 nivel vendible).
2. `calculateItemStockDeduction`:
   - Ítem `{ qty: 2, _presentationId: 'mid', _factorToBase: 10 }` → `20`.
   - Ítem `{ qty: 1, _presentationId: 'pack', _factorToBase: 30 }` → `30`.
   - Ítem `{ qty: 4, _presentationId: 'unit', _factorToBase: 1 }` → `4`.
   - Mantiene 100% los casos legacy de `tests/packageStockDeduction.test.js`.
3. `deriveCartFields(product, modeOrLevelId, factor, ctx)`:
   - Calcula `priceUsd`, `priceCop`, `priceBsUsdRef`, `costUsd`, `costBs`, `_presentationName`, `_factorToBase` desde la presentación elegida y actualiza la cesta viva con `resyncCartItems` cuando cambia un precio en el catálogo.
4. `formatPresentationLabel(item)`: muestra `"Caja · 30 tabs"` o `"Blíster · 10 tabs"` según la presentación vendida; devuelve `null` cuando `factorToBase <= 1` para no ensuciar ventas por unidad.
5. `perUnitRetailUsd` y `perUnitCostUsd` en `inventoryValuation.js`: valorizan usando la base real (`Nivel 1`) para que tener 2 Cajas + 1 Blíster + 4 Tabletas no sobrevalore el inventario ×30.

**Step 2: Ejecutar pruebas**
Run: `npx vitest run tests/multilevelStockAndCart.test.js`
Expected: FAIL.

**Step 3: Implementar actualizaciones**
- En `barcodeAssign.js`: agregar `findProductAndPresentationByCode(products, code)` e incluir todos los `p.presentations?.map(l => l.barcode)` dentro de `productCodes(p)` para que `findDuplicateCodeIndex` y `BarcodeDuplicateHint` detecten colisiones entre cualquier presentación.
- En `granel.js`: actualizar `calculateItemStockDeduction` para respetar `_factorToBase` cuando `!isGranelProduct(item)` y actualizar `formatPresentationLabel`.
- En `cartSync.js` y `checkoutProcessor.js`: soportar tanto `mode === 'unit' | 'package'` como `levelId` (`'unit' | 'mid' | 'pack'`), guardando `_presentationId`, `_presentationName`, `_factorToBase` en los ítems persistidos de la venta.

**Step 4: Verificar sin regresiones**
Run: `npx vitest run tests/multilevelStockAndCart.test.js tests/packageStockDeduction.test.js tests/cartResync.test.js tests/duplicateCodes.test.js tests/inventoryValuation.test.js`
Expected: PASS.

---

## Fase 3 — Rediseño UI/UX del Modal Crear / Editar Producto

> **Criterio visual (`/ui-ux-pro-max` + `/frontend-design`):**
> - Mantener la identidad de Precios al Día (`tokens.css`: superficies cálidas `--bg`/`--surface`, acento cian `#01696f`, verde esmeralda solo para estados de ganancia/confirmación, fuente `Work Sans` + `JetBrains Mono` con `tabular-nums` en multiplicadores/precios/códigos).
> - Eliminar emojis de controles (`📋`, `💡` en `ProductFormQuick.jsx`); usar íconos `lucide-react` con `aria-hidden="true"`.
> - Todos los botones, switches, presets y steppers con área táctil `min-h-[44px]` y `gap-2` (`>= 8px`), focus ring visible (`focus-visible:ring-2 focus-visible:ring-brand/50`) y `<label htmlFor>` asociado.

### Task 4: Componentes modulares del formulario (`src/components/Products/form/*`)

**Files:**
- Create: `src/components/Products/form/ProductIdentitySection.jsx`
- Create: `src/components/Products/form/PresentationHierarchyBuilder.jsx`
- Create: `src/components/Products/form/PricingLevelsMatrix.jsx`
- Create: `src/components/Products/form/StockBreakdownInput.jsx`
- Create: `src/components/Products/form/ProductLivePreviewPanel.jsx`
- Test: `tests/productFormPresentations.test.jsx`

**Diseño detallado de cada bloque:**

1. **`ProductIdentitySection.jsx`:**
   - Cabecera horizontal compacta (`flex gap-3`): miniatura `80×80px` clicable (`Subir foto`) con botón compacto `Auto-buscar` integrado debajo/al lado (recupera la altura ocupada arriba en el diseño actual), junto al input `Nombre` + `SimilarNameHint`.
   - Fila 2 (`grid sm:grid-cols-2 gap-3`): `Categoría` (con creación inline `+ Nueva`) + `Código de barras base` (`BarcodeDuplicateHint`).
   - Fila 3: Selector segmentado accesible (`role="radiogroup"`) para `IVA del Producto`: `General` vs `Exento (0%)`.

2. **`PresentationHierarchyBuilder.jsx` ("estilo Farmacia simplificado"):**
   - **Selector de 3 intenciones claras** (sin `Uds. por Bulto` flotando cuando es suelto):
     - **`Unidad simple` (1 nivel):** se vende por unidad. Muestra solo un botón de texto colapsado opcional: `+ ¿También compras por cajas para ajustar stock?` (si se expande, guarda un nivel de compra con `sellable: false` sin tocar precios de Caja).
     - **`Presentaciones (2–3 niveles)`:**
       - Barra de **Plantillas de 1 toque:** `Caja + Ud` · `Paquete + Ud` · `Caja + Paquete + Ud` · `Caja + Blíster + Tableta`.
       - **Constructor en escalera visual** (de mayor arriba a base abajo, unidos por conector `border-l-2`):
         - Cada nivel es una tarjeta compacta (`rounded-2xl p-3 bg-[var(--surface)]`) con:
           - **Nombre editable** (input `min-h-[44px]`, máx ~18 caracteres, placeholder contextual según nivel).
           - **Equivalencia natural:**
             - Nivel Base: badge fijo `"Unidad mínima del inventario"`.
             - Nivel 2: `"Cada [Blíster] trae"` + input entero `min="2"` + label `"[Tabletas]"`.
             - Nivel 3: `"Cada [Caja] trae"` + input entero `min="2"` + label `"[Blísters]"` (o `"[Unidades]"` si solo hay 2 niveles).
           - **Switch accesible (`role="switch"`):** `"Se vende en Caja"` (al menos 1 nivel debe estar activo).
           - **Acordeón opcional de código propio:** botón `"Cód. propio"` (cuando la caja o blíster tienen su propio código de barras diferente al base; incluye `BarcodeDuplicateHint`).
         - Botón `min-h-[44px]` para **`+ Agregar Nivel 3 (ej. Caja / Bulto)`** cuando está en 2 niveles, o quitar Nivel 3 si está en 3.
       - **Chip de Cadena Viva (`font-mono tabular-nums`):**
         `1 Caja = 3 Blísters = 30 Tabletas`
     - **`A granel` (Peso / Volumen):** reutiliza la lógica actual de `kg` / `litro` y modo `kg_lt` / `gr_ml` de `granel.js`.

3. **`PricingLevelsMatrix.jsx`:**
   - **Bloque Costo:**
     - Selector *"¿En qué presentación te cobran la factura?"*: botones `[ Tableta | Blíster | Caja ]` (`costSourceLevel`).
     - Inputs `Costo ($ o COP)` + `Costo (Bs)` + `ProductCostFactorControl` aplicados sobre esa presentación elegida.
     - Nota automática discreta si hay >1 nivel: costo derivado por unidad base (`$0.12 / Tableta`).
   - **Bloque Precios de Venta por Nivel Activo:**
     - Lista únicamente los niveles con `sellable === true` (1, 2 o 3 filas limpias):
       - Cabecera de fila: **Nombre del nivel** (`Caja · 30 tabs`) + costo calculado (`Costo: $3.60`) + badge semántico de **Margen %** (`>= 20%` esmeralda, `0–20%` ámbar, `< 0%` rojo).
       - Inputs `USD / COP` y `Bs` calculado + selector opcional `Dual USD (Ref Bs)` cuando está activo el modo dual.
       - Chips rápidos en niveles superiores (cuando hay base vendible): `Auto ×N`, `-5%`, `-10%` para fijar precio de bulto/blíster en 1 toque sin calculadora.

4. **`StockBreakdownInput.jsx`:**
   - Si es `Unidad simple`: `Stock` + `Alerta mínima` (en unidad base).
   - Si es `Presentaciones (2–3 niveles)`: inputs paralelos por cada nivel configurado (`Cajas`, `Blísters`, `Tabletas`) que suman automáticamente abajo en `JetBrains Mono`:
     **`Total en inventario: 74 Tabletas`**
   - Campo `Alerta stock bajo` siempre expresado en la unidad base con ayuda legible al lado (`= 1.5 Blísters`).

5. **`ProductLivePreviewPanel.jsx` (Columna derecha sticky en desktop):**
   - **Bloque A — "Así se verá en Caja (`Vender`)":** miniatura visual fiel de la tarjeta POS (`CategoryBar` style) mostrando nombre, foto/iniciales, badge de stock y los botones reales con sus nombres (`Caja · $6.00`, `Blís · $2.20`, `Tab · $0.30`).
   - **Bloque B — "Equivalencias y Escaneo":** cadena `1 Caja = 3 Blísters = 30 Tabletas` + resumen de códigos de barras asignados.
   - **Bloque C — "Salud de Precios y Margen":** alertas de `validatePresentationCoherence` (ej. *"Con estos precios, 1 Caja ($9.50) sale más cara que 30 Tabletas sueltas ($9.00)"* o *"Blíster sin precio de venta"*).

**Step 1: Escribir pruebas RTL en `tests/productFormPresentations.test.jsx`**
- Al seleccionar `Unidad simple`, NO existe ningún input `"Uds. por Bulto / Caja"` en el DOM visible.
- Al elegir `Presentaciones` → preset `Caja + Blíster + Tableta` → ingresar `10` y `3` → muestra `"1 Caja = 3 Blísters = 30 Tabletas"` y en la vista previa muestra las 3 presentaciones.
- Cambiar costo en `Caja = 6` recalcula costo de `Blíster = 2.00` y `Tableta = 0.20` en la matriz.
- Ingresar stock `2` Cajas + `1` Blíster + `4` Tabletas produce total `74`.

**Step 2: Implementar los 5 subcomponentes**

**Step 3: Ejecutar pruebas del formulario**
Run: `npx vitest run tests/productFormPresentations.test.jsx`
Expected: PASS.

---

### Task 5: Shell Unificado en `ProductFormModal.jsx` y `RemoteProductFormModal.jsx`

**Files:**
- Modify: [`src/components/Products/ProductFormModal.jsx`](../../src/components/Products/ProductFormModal.jsx#L166-L407)
- Modify: [`src/components/Monitor/RemoteProductFormModal.jsx`](../../src/components/Monitor/RemoteProductFormModal.jsx#L35-L490)
- Modify: [`src/views/ProductsView.jsx`](../../src/views/ProductsView.jsx#L520-L665)
- Archive/Retire: eliminar duplicación obsoleta de `ProductFormQuick.jsx` y `ProductFormWizard.jsx` una vez verificada la paridad (o convertirlos en wrappers mínimos si algún test los importa directo, verificando primero con `git grep ProductFormQuick\|ProductFormWizard`).

**Step 1: Verificar todos los imports de `ProductFormQuick` y `ProductFormWizard`**
Run: `git grep -n "ProductFormQuick\|ProductFormWizard" src/ tests/`

**Step 2: Refactorizar `ProductFormModal.jsx`**
- Cambiar tamaño a `size="max-w-md md:max-w-5xl"`.
- Renderizar grid `lg:grid-cols-12 gap-5`:
  - `lg:col-span-7`: modo `Vista Rápida` muestra los 4 bloques apilados con divisores sutiles; modo `Asistente (Pasos)` renderiza exactamente los **mismos 4 subcomponentes**, uno por paso (`1. Identidad`, `2. Presentaciones`, `3. Costos y Precios`, `4. Stock y Kardex`), sin duplicar lógica ni markup.
  - `lg:col-span-5 hidden lg:block`: `ProductLivePreviewPanel` en `sticky top-2` + botón primario `Guardar Producto` / `Actualizar Producto` accesible sin hacer scroll hasta el final.
  - Móvil (`lg:hidden`): barra inferior sticky con precio principal, total de presentaciones vendibles y botón `Guardar`.
- Validación en `ProductsView.jsx`: verificar colisiones de códigos de barras usando `findOtherProductWithCode` contra **todos** los niveles configurados (incluyendo colisiones internas entre dos niveles del mismo producto).

**Step 3: Actualizar `RemoteProductFormModal.jsx` (Monitor / Supervisor)**
- Reutilizar `PresentationHierarchyBuilder`, `PricingLevelsMatrix` y `StockBreakdownInput` (o los mismos subcomponentes puros) para que el supervisor edite e inspeccione 1, 2 o 3 niveles con la misma claridad que en Caja.

**Step 4: Verificar compilación, tipos, lint y pruebas**
Run: `npx eslint src/components/Products src/components/Monitor/RemoteProductFormModal.jsx src/views/ProductsView.jsx && npm run typecheck && npx vitest run tests/productFormPresentations.test.jsx tests/duplicateHints.test.jsx`
Expected: PASS.

---

## Fase 4 — Consumidores en Caja (`Vender`), Inventario y Stock por Lote

### Task 6: Venta Multinivel en `SalesView.jsx`, `SearchBar.jsx`, `CategoryBar.jsx` y `CartPanel.jsx`

**Files:**
- Modify: [`src/views/SalesView.jsx`](../../src/views/SalesView.jsx#L323-L750)
- Modify: [`src/components/Sales/SearchBar.jsx`](../../src/components/Sales/SearchBar.jsx#L198-L298)
- Modify: [`src/components/Sales/CategoryBar.jsx`](../../src/components/Sales/CategoryBar.jsx#L335-L450)
- Modify: [`src/components/Sales/CartPanel.jsx`](../../src/components/Sales/CartPanel.jsx#L205-L320)
- Test: `tests/salesMultilevelFlow.test.jsx`

**Implementación clave:**
1. **`SalesView.jsx`:**
   - Al escanear código en `onScan` / búsqueda exacta: llamar `findProductAndPresentationByCode(products, normalized)`.
     - Si coincide con el código específico de `Blíster` o `Caja`, invoca `addToCart(product, null, level.id, true)` **directo** sin abrir el popup.
     - Si coincide con el código base (o tocan la tarjeta) y hay `> 1` presentaciones con `sellable: true`, abre `hierarchyPending` con el listado dinámico de presentaciones vendibles.
     - Si solo hay `1` presentación vendible (ej. solo `Caja` o solo `Unidad`), agrega directo esa presentación.
   - `addToCart(product, qtyOverride, forceLevelId, ...)`: resuelve la presentación activa con `resolveProductPresentations(product)`, calcula `cartId = `${product.id}__${level.id}`` (o conserva `${product.id}` / `${product.id}_unit` para compatibilidad), `cartName` (`level.factorToBase > 1 ? product.name : `${product.name} (${level.name})`` o formato consistente), `_presentationId: level.id`, `_presentationName: level.name`, `_factorToBase: level.factorToBase`, y valida el stock consumido total (`calculateItemStockDeduction`).
2. **`SearchBar.jsx` (`hierarchyPending`):**
   - Cambia `grid-cols-2` fijo por `sellables.length === 3 ? 'grid-cols-3' : 'grid-cols-2'`, mostrando nombre personalizado (`Caja`, `Blíster`, `Tableta`), precio en moneda principal (`$` / `COP`) + `Bs`, y equivalencia (`30 tabs`, `10 tabs`, `1 tab`).
3. **`CategoryBar.jsx`:**
   - **1 nivel vendible:** botón único actual.
   - **2 niveles vendibles:** 2 botones directos `min-h-[44px]` con la abreviatura real del nombre del nivel (`Blís x10`, `Tab`) en vez de `"Bto"` fijo.
   - **3 niveles vendibles:** para proteger el mínimo táctil (`>= 44px`) sin aplastar tarjetas, muestra el botón de la presentación base o principal + botón/chip `3 pres. ▾` que abre el selector `hierarchyPending`.
4. **`CartPanel.jsx`:**
   - Muestra el badge de `formatPresentationLabel(item)` (ej. `Blíster · 10 tabs` o `Caja · 30 tabs`) con ícono `Package` de `lucide-react`.

---

### Task 7: Tarjeta de Inventario (`ProductCard.jsx`), Ajuste por Lotes (`StockBatchModal.jsx`) y Panel Supervisor

**Files:**
- Modify: [`src/components/Products/ProductCard.jsx`](../../src/components/Products/ProductCard.jsx#L295-L410)
- Modify: [`src/components/Products/StockBatchModal.jsx`](../../src/components/Products/StockBatchModal.jsx#L40-L350)
- Modify: [`src/components/Monitor/SupervisorInventoryBatchPanel.jsx`](../../src/components/Monitor/SupervisorInventoryBatchPanel.jsx#L60-L150) *(si aplica desglose por nivel)*
- Test: `tests/stockBatchMultilevel.test.js`

**Implementación clave:**
1. **`ProductCard.jsx`:**
   - Leer presentaciones con `resolveProductPresentations(p)` en lugar de `p.unit === 'paquete'`.
   - Mostrar badge resumen de jerarquía (ej. `Caja 30 · Blíster 10` o `Bulto · 24 uds`), precios de los niveles vendibles y equivalencia real bajo el stock (`74 tabs · 2 Cajas + 1 Blíster + 4`).
2. **`StockBatchModal.jsx`:**
   - Reemplazar el toggle binario `'unidades' | 'lotes'` por pills de las presentaciones del producto (incluyendo niveles configurados solo para compras con `sellable: false`!).
   - Al elegir `Blíster (×10)` e ingresar `+3`, calcula `delta = +30` unidades base con vista previa clara `74 → 104 Tabletas (+3 Blísters de 10)`.

---

## Fase 5 — Verificación Integral y Cierre

### Task 8: Suite de Regresión, E2E Playwright y Auditoría Visual

**Files:**
- Create: `tests/e2e/producto-presentaciones.e2e.spec.js`

**Verificación obligatoria antes de dar por completada la implementación:**
1. **Unit & Integration Tests:**
   Run: `npm run test`
   Expected: Todos los tests unitarios previos (`packageStockDeduction`, `cartResync`, `inventoryValuation`, `supervisor*`) + los 4 archivos nuevos (`presentations`, `productProcessorPresentations`, `multilevelStockAndCart`, `productFormPresentations`) en PASS.
2. **Lint, Tipos y Build de Producción:**
   Run: `npm run lint && npm run typecheck && npm run build`
   Expected: 0 errores.
3. **E2E Playwright (desktop `1366×768` y móvil `375×812`):**
   - Flujo A (1 nivel): crear producto `Unidad simple`, verificar que no aparecen campos de bulto y vende 1:1 en Caja.
   - Flujo B (3 niveles estilo farmacia): crear `Acetaminofén 500mg` con `Caja = 3 Blísters × 10 Tabletas`, costo por Caja, 3 precios vendibles, stock `2 Cajas + 1 Blíster + 4 Tabletas = 74`, verificar en Inventario (`ProductCard`), escanear/vender `1 Caja + 2 Blísters + 1 Tableta = 51` en Caja y verificar stock final `23` (`2 Blísters + 3 Tabletas`) y anulación restaurando a `74`.
   - Flujo C (UI/UX & A11y): verificar cero desbordamiento horizontal en `375×812`, altura cómoda sin scroll excesivo en `1366×768`, vista previa viva visible y botones táctiles `>= 44px`.
4. **Docs Check:**
   Run: `npm run docs:check`
   y registrar el caso implementado en `docs/` según `LEY-DOCUMENTACION.md`.

---

## Opciones de Ejecución Sugeridas

Este plan cubre la solución completa recomendada de forma segura y progresiva:
- **Ruta A (Implementación incremental por fases — Recomendada):** Empezamos con **Fase 1 + Fase 2** (núcleo puro + pruebas + compatibilidad legacy) → validamos tests → luego **Fase 3** (rediseño del modal) → **Fase 4** (`Vender` + Inventario + Lotes) → **Fase 5** (E2E).
- **Ruta B (Solo UX primero):** Implementar Fase 3 visual con 2 niveles actuales y luego expandir a 3 niveles (tiene doble trabajo sobre el formulario, por lo que es menos recomendable).
