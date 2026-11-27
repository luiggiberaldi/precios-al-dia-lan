# CASO-007 — Presentaciones multinivel (1, 2 o 3 niveles) y rediseño de creación/edición de artículos

**Fecha:** 2026-11-27
**Estado:** Verificado
**Plan:** [2026-11-27-plan-presentaciones-multinivel-productos.md](../plans/2026-11-27-plan-presentaciones-multinivel-productos.md)

## Qué pidió el dueño
Mejorar la pantalla de creación y edición de productos para que sea intuitiva, moderna y soporte artículos de **1, 2 o 3 niveles de presentación** con nombres personalizables al estilo farmacia simplificado (por ejemplo: `Caja → Blíster → Tableta` o `Caja → Paquete → Unidad`), sin mostrar campos de bulto cuando el artículo se vende en unidad simple.

## Qué se hizo

| Fase | Qué cambia para el usuario | Archivos principales |
|---|---|---|
| Fase 1 | Núcleo puro de presentaciones (plantillas rápidas, equivalencias encadenadas, reparto de costo por nivel, desglose de stock en unidad base y alertas de coherencia de precios) compatible con artículos existentes y con el Supervisor. Se elimina el truncamiento decimal de `stockInLotes` (`INV-16`). | `src/utils/presentations.js` (nuevo), `src/utils/productProcessor.js`, `src/hooks/useProductForm.js`, `src/services/supervisorProductCommand.js`, `src/utils/duplicateMerge.js`, `tests/presentations.test.js` (nuevo) |
| Fase 2 | Descuento real de stock según la presentación vendida, búsqueda directa por código de barras de cada nivel, sincronización viva de precios en la cesta, valoración de inventario y snapshot por presentación al cobrar. | `src/utils/barcodeAssign.js`, `src/utils/granel.js`, `src/utils/cartSync.js`, `src/utils/inventoryValuation.js`, `src/utils/checkoutProcessor.js`, `tests/multilevelStockAndCart.test.js` (nuevo) |
| Fase 3 | Modal unificado de 2 columnas en PC con **Vista previa en Caja** fija a la derecha y barra fija inferior en móvil. Divulgación progresiva: `Unidad simple` oculta campos de bulto; `Presentaciones` permite 2 o 3 niveles con nombres libres, matriz de costos/precios y stock desglosado. Reutilizado tanto en Vista Rápida, Asistente por Pasos y Monitor/Supervisor. | `src/components/Products/form/*` (6 archivos nuevos), `src/components/Products/ProductFormModal.jsx`, `src/components/Products/ProductFormQuick.jsx`, `src/components/Products/ProductFormWizard.jsx`, `src/views/ProductsView.jsx`, `src/components/Monitor/RemoteProductFormModal.jsx`, `tests/productFormPresentations.test.jsx` (nuevo) |
| Fase 4 | Caja (`Vender`) reconoce códigos de cada nivel, ofrece selector dinámico de 2 o 3 presentaciones con sus nombres reales y protege áreas táctiles (`>= 44px`). Inventario (`ProductCard`) muestra chip de jerarquía, precios por nivel y desglose de stock; Ajuste por Lotes (`StockBatchModal`) permite sumar o restar por cualquier presentación. | `src/utils/searchMatch.js`, `src/views/SalesView.jsx`, `src/components/Sales/SearchBar.jsx`, `src/components/Sales/CategoryBar.jsx`, `src/components/Products/ProductCard.jsx`, `src/components/Products/StockBatchModal.jsx`, `tests/salesAndInventoryMultilevel.test.jsx` (nuevo) |
| Fase 5 | Suite E2E de punta a punta (desktop `1366×768` y móvil `375×812`) y regresión completa. | `tests/e2e/producto-presentaciones.e2e.spec.js` (nuevo) |

## Qué no cambió
- Los artículos ya guardados (`suelto`, `lote` de 2 niveles y `granel`) siguen funcionando sin migración forzada: si no tienen `presentations`, el sistema los interpreta al vuelo desde `unitsPerPackage` y `sellByUnit`.
- El contrato de lotes remotos del Supervisor (`SupervisorInventoryBatchPanel.jsx`) se mantuvo intacto y sigue leyendo el factor proyectado en `unitsPerPackage`.

## Pruebas
- **Vitest (suite completa):** `324/325` suites en verde (`2915/2916` pruebas aprobadas, `20` omitidas de staging/perf); el único fallo en la corrida masiva fue un timeout por contención de CPU en `tests/realtimePublicationGuardrails.test.js`, que al ejecutarse de forma aislada pasó `4/4` en `2.37s`.
- **Playwright E2E (`tests/e2e/producto-presentaciones.e2e.spec.js`):** `3/3` aprobadas (`1.6m`):
  - Flujo A (1 nivel): `Unidad simple` oculta campos de bulto y vende 1:1 (`10 → 9`).
  - Flujo B (3 niveles): crea `Acetaminofén 500mg` (`Caja = 3 Blísters = 30 Tabletas`), costo por Caja `$6.00`, stock desglosado `2 Cajas + 1 Blíster + 4 Tabletas = 74`, vende `1 Caja + 2 Blísters + 1 Tableta` (`51` uds, `$15.80`) bajando a `23`, y anula la venta restaurando exactamente a `74`.
  - Flujo C (móvil `375×812`): sin desborde horizontal (`scrollWidth <= clientWidth + 2`) y botones principales `>= 44px`.
- **ESLint (`src/` + tests nuevos con `--quiet`):** `0` errores *(nota: `eslint .` sobre todo el repo reporta errores preexistentes dentro del bundle compilado `desktop/dist-web/assets/`)*.
- **Typecheck (`npm run typecheck`) y Build (`npm run build`):** `0` errores (`vite build --mode lan` + PWA `generateSW`).

## Errores
Ninguno abierto.
