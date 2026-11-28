# CASO-009 — Buscador automático de fotos en 3 capas para LAN (Offline + Nube + Web)

**Fecha:** 2026-11-28
**Estado:** Verificado

## Qué pidió el dueño

Auditar la búsqueda automática de fotos de inventario en `Listo POS` frente a `Precios al Día LAN` para identificar cuál era mejor y aplicar todas las mejoras en `Precios al Día LAN`.

## Qué se hizo

1. **Recuperación del catálogo completo sin internet (1.143 fotos locales):** en `public/images/catalog/` había 567 fotos `.webp` reales que no figuraban en `catalog.json` y 24 entradas con rutas desactualizadas. Con [scripts/sync-catalog-index.mjs](../../scripts/sync-catalog-index.mjs) quedaron las **1.143 fotos reales indexadas** y listas sin conexión.
2. **Clasificador inteligente en español venezolano ([src/utils/productImageMatcher.js](../../src/utils/productImageMatcher.js)):** limpia tildes y `ñ` sin partir palabras (`Azúcar` → `azucar`, `Doña` → `dona`), une siglas y medidas (`P.A.N.` → `pan`, `1 kg` → `1kg`), corrige errores comunes de tipeo en bodegas y evita falsos positivos en palabras cortas (`pan` ya no coincide con `empanada` ni `pantene`).
3. **Motor unificado de 3 capas ([desktop/server/imageSearchEngine.mjs](../../desktop/server/imageSearchEngine.mjs)):**
   - **Capa 1 (0 ms, sin internet):** busca primero en las 1.143 fotos locales.
   - **Capa 2 (~150 ms, con internet):** consulta el catálogo curado en Supabase si hacen falta más opciones.
   - **Capa 3 (~600 ms, web ligera sin navegadores ocultos):** si es un producto nuevo fuera del catálogo, consulta tiendas y bases abiertas (InstaMarket Venezuela JSON, OpenFoodFacts y Bing ligero) sin levantar ventanas pesadas de Chromium.
4. **Soporte completo en Servidor LAN, Nube y Supervisor ([desktop/server/lanServer.mjs](../../desktop/server/lanServer.mjs), [api/search-image.js](../../api/search-image.js), [api/image-proxy.js](../../api/image-proxy.js), [vite.config.js](../../vite.config.js), [src/services/productImageSearchService.js](../../src/services/productImageSearchService.js), [ProductFormModal.jsx](../../src/components/Products/ProductFormModal.jsx), [RemoteProductFormModal.jsx](../../src/components/Monitor/RemoteProductFormModal.jsx)):**
   - Se agregaron `/api/search-image` y `/api/image-proxy` (con bloqueo de seguridad anti-direcciones privadas) al servidor LAN (`lanServer.mjs`), que antes respondía 404 en el `.exe`.
   - Al elegir cualquier foto (incluso una encontrada en la web o desde el Supervisor remoto), el sistema la descarga, la reduce a formato liviano `.webp` (~20 KB) y la guarda localmente para que jamás dependa de internet ni deje íconos rotos.

## Qué no cambió

- No se tocaron precios, cálculos financieros, stock, cierres de caja ni migraciones SQL.
- El diseño del formulario de producto mantiene el mismo botón **Auto-foto** y la misma galería de selección de 1 toque (añadiendo solo una etiqueta discreta `Web` cuando la sugerencia proviene de internet).

## Pruebas

- `tests/lan/lanProductImageSearch.test.js`: 9/9 pruebas pasando (normalización de tildes/`ñ`, protección de palabras cortas, corrección de tipeos, bloqueo anti-SSRF, búsqueda offline sobre las 1.143 fotos en `lanServer.mjs`, activación del fallback web y caída limpia al catálogo del navegador sin red).
- `tests/imageFallback.test.js`, `tests/productFormPresentations.test.jsx`, `tests/productIvaWiring.test.jsx`: todos en verde.
- `eslint` 0 errores, `typecheck` OK y `vite build --mode lan` exitoso.

## Errores

Sin fichas nuevas en `ERRORES.md` (mejora evolutiva derivada de auditoría comparativa).
