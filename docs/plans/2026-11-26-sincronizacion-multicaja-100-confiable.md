# Plan Integral de Remediación · Sincronización Multi-Caja 100% Confiable (`Precios al Día LAN / Nube`)

> **Para ejecución agéntica:** Implementar tarea por tarea en orden estricto de Olas (`Ola 1 → Ola 4`). Cada tarea sigue disciplina **TDD**: escribir prueba de reproducción en rojo → verificar fallo → implementar fix mínimo y limpio → verificar en verde → commit atómico. Referencia forense completa: `auditoria-sincronizacion-multicaja.md`.

**Goal:** Llevar la sincronización entre múltiples cajas (modo LAN con PGlite/SSE/Cloud Bridge y modo Nube con Supabase) a **100% de confiabilidad financiera, operativa y de convergencia**, cerrando los **21 hallazgos críticos (P0)**, **14 altos (P1)** y **11 medios (P2)** detectados en la auditoría del 2026-11-26.

**Architecture:** Se mantiene la arquitectura unificada de PostgreSQL real (`supabase/nube/migrations` en Supabase y en `@electric-sql/pglite` para LAN) con libros inmutables en servidor (`stock_movements`, `customer_movements`, más nuevo libro de proveedores), pero se eliminan todas las brechas entre la capa local (IndexedDB/`localStorage`) y el motor de sincronización: serialización cross-tab con `navigator.locks` (`pos_write_lock`), eliminación de la bandera booleana global `runWithoutEco`, baseline atómico de stock, endurecimiento de `push_records_v2`/`process_void`/`push_customer_movements`, timeouts + watchdog SSE en LAN, durabilidad/respaldo atómico en PGlite, y paridad completa de dominios (IVA, ajustes de negocio, proveedores, nómina, compras y Reportes multi-caja).

**Tech Stack:** React 19, Vite 7, IndexedDB (`localforage`), PostgreSQL 16 / `@electric-sql/pglite`, Node HTTP + SSE + UDP (`desktop/server/`), Supabase Realtime & RPC, Vitest 4 + PGlite harness (`tests/nube/sql`), Playwright.

---

## Mapa de Olas y Trazabilidad de Hallazgos

| Ola | Enfoque | Tareas | Hallazgos cubiertos | Criterio de salida (Gate) |
|---|---|---|---|---|
| **Ola 1** | Núcleo de Concurrencia, Stock, Conflictos, Tasas y Ventas | `T01`–`T08` | `C1, C2, C3, C4, C5, C11, C12, C13, C14, C15, A2, A3, A4, A6, A7, A10, A11, A14, M2, M4, MED-01, MED-05, MED-07, BAJ-01` | 0 doble deducción/restauración de stock, 0 resurrecciones zombi, tasa Supervisor funcional en todas las cajas, `verify_invariants()` = 0 errores. |
| **Ola 2** | Cartera de Clientes y Cashea 100% Atómicos | `T09`–`T12` | `C6, C7, C8, C9, A8, A14, MED-11, BAJ-02` | 0 doble gasto de `saldo_favor`, `syncAudit.test.js` (`seq` menor que cursor) pasa de `it.fails` a `it` en verde, Cashea y borrado de clientes blindados. |
| **Ola 3** | Servidor LAN (PGlite), Transporte SSE, Respaldos, Seguridad y Cloud Bridge | `T13`–`T18` | `C19, C20, C21, A5, A9, A12, A13, MED-07, MED-09, MED-10` | Sockets colgados se recuperan en ≤45s, `/lan/backup/restore` funciona con discrepancias abiertas y resincroniza cajas limpiamente, Cloud Bridge sin flood c/4s ni comandos zombi, localhost autenticado. |
| **Ola 4** | Paridad Total de Dominios y Reportes Multi-Caja + Suite Caos | `T19`–`T24` | `C10, C16, C17, C18, A1, A4, A7, A8, MED-04, MED-06` | IVA, negocio, proveedores/facturas, nómina (con PIN Nube/LAN), compras y las 5 pestañas de `ReportsView` 100% convergentes entre Caja A y Caja B + suite de caos en verde. |

---

## OLA 1 · Núcleo de Concurrencia, Stock, Conflictos, Tasas y Ventas

### Task T01: Reemplazar bandera global `runWithoutEco` por `skipSyncPush` por escritura y serializar sync bajo `withLock('pos_write_lock')`
- **Cierra:** `C3` (parcial), `A3`, `A10`, `ALT-01`
- **Files:**
  - Modify: `src/utils/storageService.js:94-143`
  - Modify: `src/nube/useNubeSync.js:55-60, 82-94, 138-145`
  - Modify: `src/nube/recordSync.js:187-205, 260-270, 392-424`
  - Modify: `src/nube/stockMirror.js:28-53`
  - Modify: `src/utils/syncFlags.js:25-83` (convertir a contador de referencias solo para compatibilidad con `useCloudSync` legado)
  - Test: `tests/nube/syncConcurrencyLocks.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/syncConcurrencyLocks.test.js`)**
- Test 1: Mientras `writeLocal` (desde `recordSync.pull`) escribe `bodega_products_v1` de forma lenta (simulando 50 ms de IndexedDB), una venta concurrente guarda `bodega_sales_v1` → verificar que `notifyNubeLocalWrite('bodega_sales_v1', ...)` **SÍ se invoca** (antes el booleano global `_isSyncingFromCloud` lo silenciaba).
- Test 2: Dos llamadas concurrentes `applyPulled('products')` + escritura local de venta en `bodega_products_v1` bajo `withLock('pos_write_lock')` → verificar que se ejecutan en orden estricto y no se pierde el stock descontado ni el metadato bajado.
- Test 3: `recordSync.inTurn(collection)` usa `withLock(\`pdn_sync_turn_${collection}\`, fn)` para exclusión mutua también cross-tab.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/syncConcurrencyLocks.test.js`
- Expected: FAIL en Test 1 (`notifyNubeLocalWrite` recibió 0 llamadas) y Test 2 (race overwrite).

**Step 3: Implementación mínima**
1. En `src/utils/storageService.js:94-142`:
   - Soportar `options.fromCloud === true` (implica `skipSyncPush: true` Y exime del CircuitBreaker en `T05`).
   - Emitir `app_storage_update` con `detail: { key, source: options?.fromCloud ? 'remote' : 'local' }` (esto además corrige `MED-04` en `ProductContext`).
2. En `src/nube/useNubeSync.js`:
   - `recordSync.writeLocal`: reemplazar `runWithoutEco(...)` por `storageService.setItem(key, value, { skipSyncPush: true, fromCloud: true })`.
   - `stockMirror.writeProducts` y `customerLedgerSync.writeLocal`: pasar `{ skipSyncPush: true, fromCloud: true }` **sin** `runWithoutEco`.
   - Envolver el read-modify-write de `recordSync` (`writeMerged` y `applyPulled` sobre `bodega_products_v1` / `bodega_customers_v1`) y `stockMirror.applyKnown` dentro de `withLock('pos_write_lock', ...)`.
3. En `src/nube/recordSync.js:191-197`:
   - Cambiar `inTurn(collection, fn)` a `withLock(\`pdn_sync_turn_${collection}\`, fn, { fallbackWarning: false })` para proteger múltiples pestañas del mismo navegador (`A10`).
4. En `src/utils/syncFlags.js`:
   - Cambiar `_isSyncingFromCloud` booleano a contador entero `_syncingDepth` (`_syncingDepth += 1` / `Math.max(0, _syncingDepth - 1)`) para que llamadas solapadas heredadas no apaguen el flag prematuramente.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/syncConcurrencyLocks.test.js tests/nube/recordSync.test.js tests/nube/storageServiceNube.test.js`
- Expected: PASS en todos.
- Commit: `fix(sync): reemplazar flag global runWithoutEco por opciones por escritura y serializar bajo pos_write_lock`

---

### Task T02: Eliminar doble deducción / doble restauración de stock y blindar `stockWatcher` + `stockMirror`
- **Cierra:** `C1`, `C3`
- **Files:**
  - Modify: `src/nube/stockWatcher.js:29-144`
  - Modify: `src/nube/localWriteHook.js:1-45`
  - Modify: `src/nube/useNubeSync.js:75-102, 138-153`
  - Modify: `src/utils/checkoutProcessor.js:475-485`
  - Modify: `src/utils/voidSaleProcessor.js:200-212`
  - Modify: `src/nube/stockMirror.js:40-88`
  - Test: `tests/nube/stockWatcher.test.js`, `tests/nube/stockDoubleDeduction.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/stockDoubleDeduction.test.js`)**
- Test 1 (Venta offline + edición de otro producto): Producto X tiene stock 10 (baseline 10). Caja A vende 2 uds offline (`stock: 8` con `skipSyncPush: true`). Luego admin edita el precio de Producto Y (`onProductsWrite`). Al reconectar: `sales.replay()` + `watcher.flush()` → stock final en servidor **debe ser 8 (NO 6)** y `watcher` debe encolar `0` movimientos para X.
- Test 2 (Anulación + edición antes de Realtime): Caja A anula venta de 2 uds (`8 → 10`). Antes de llegar Realtime se edita Producto Y → `watcher` no debe encolar `AJUSTE +2` (stock final **10, NO 12**).
- Test 3 (Producto nuevo recién flusheado + Realtime de otro producto): Caja A crea Producto Z con `stock: 20`; `watcher.flush()` lo sube. Llega Realtime de Producto X antes del Realtime de Z → `applyKnown` no debe borrar Z del baseline; editar Z después no debe duplicar su stock a 40.
- Test 4 (Dos `onProductsWrite` concurrentes): serializados con `withLock('pdn_stock_watcher_lock')`, sin perder ningún delta.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/stockDoubleDeduction.test.js`
- Expected: FAIL en Tests 1, 2 y 3.

**Step 3: Implementación mínima**
1. En `src/nube/stockWatcher.js`:
   - Serializar `setBaseline`, `adjustBaseline`, `onProductsWrite` y `flush` (modificación de estado en `store`) con `withLock('pdn_stock_watcher_lock', ..., { fallbackWarning: false })`.
   - Añadir `adjustBaseline(deltasMap)` (ej. `{ [productId]: -qty }` tras venta o `+qty` tras anulación) que actualiza `baseline[id] = round3((baseline[id] ?? 0) + delta)` atómicamente.
   - Mantener un `recentlyFlushed = new Map()` (`productId → { qty, flushedAt }` TTL 60s) para que `setBaseline(..., { only })` **conserve** en `only` los IDs recién flusheados hasta que lleguen a `known` por Realtime o `refresh()`.
   - En `flush()`: aislar errores de datos definitivos (clases `22`/`23`) a una lista `pdn_stock_rejected_v1` en vez de atascar toda la cola (`M2`).
2. En `src/nube/localWriteHook.js` y `src/nube/useNubeSync.js`:
   - Exponer `adjustNubeStockBaseline(deltas)` conectado a `watcher.adjustBaseline`.
3. En `src/utils/checkoutProcessor.js:479` y `src/utils/voidSaleProcessor.js:206`:
   - Justo tras escribir `bodega_products_v1` con `skipSyncPush: true` (aún dentro de `pos_write_lock`), llamar `await adjustNubeStockBaseline(deltas)` con los deltas reales aplicados en esa venta/anulación.
4. En `src/nube/stockMirror.js`:
   - Exportar `applyKnown` (envuelto en `serial`) para poder re-aplicar niveles conocidos en memoria cuando `recordSync` inserta productos nuevos (usado en `T05`).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/stockDoubleDeduction.test.js tests/nube/stockWatcher.test.js tests/nube/stockConfirmFlush.test.js tests/nube/egressIncremental.test.js`
- Expected: PASS en todos.
- Commit: `fix(stock): sincronizar baseline en ventas/anulaciones y serializar stockWatcher/stockMirror`

---

### Task T03: Blindar edición de productos (`ProductFormModal`, `setDirectStock`, fusión de duplicados, «Borrar Todo» y `cartSync`)
- **Cierra:** `C2`, `A14`, `M2`
- **Files:**
  - Modify: `src/views/ProductsView.jsx:77-101, 127-165, 512-607, 965-975, 1175-1185`
  - Modify: `src/hooks/useProductForm.js` (rastrear `stockTouched: boolean`)
  - Modify: `src/utils/cartSync.js:115-145`
  - Modify: `src/nube/stockWatcher.js` (soportar `submitStockCount(productId, targetQty)` con motivo `'CONTEO'`)
  - Test: `tests/nube/productEditStockRace.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/productEditStockRace.test.js`)**
- Test 1: Admin abre edición de Producto X (`stock: 10`), Caja B vende 3 (`products` en Caja A pasa a `stock: 7`), Admin cambia solo `priceUsd` y guarda → `persistCatalogLocked` preserva `stock: 7` y `stockWatcher` encola `0` ajustes.
- Test 2: `resyncCartItems` cuando Caja B cambia `unitsPerPackage` de 12 a 24 → actualiza también `_unitsPerPackage: 24` y `packagingType`.
- Test 3: `handleMergeDuplicateGroup` en modo Nube/LAN envía ajuste negativo (`-absorbedStock`) para poner en `0` el `stock_levels` del producto absorbido antes de eliminarlo.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/productEditStockRace.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
1. En `useProductForm.js` + `ProductsView.jsx:512-607`:
   - Registrar `stockTouched` (solo `true` cuando el usuario modifica el input de stock). Si estamos editando un producto existente y `!stockTouched`, **omitir `stock` del payload** (o tomar el `stock` fresco de IndexedDB dentro de `persistCatalogLocked`).
2. En `ProductsView.jsx:77-101` (`adjustStock`):
   - Envolver escritura de `bodega_sales_v1` en `withLock('pos_write_lock')` y **solo registrar el ajuste en historial si `flushNubeStockNow()` no fue rechazado**.
3. En `ProductsView.jsx:969` (`setDirectStock`):
   - En modo Nube/LAN, enviar vía RPC `process_stock_movements` con motivo `'CONTEO'` (y llamar `flushNubeStockNow()`), evitando carreras con ventas concurrentes de Caja B.
4. En `ProductsView.jsx:127-165` (`handleMergeDuplicateGroup`) y `1175-1185` («Borrar Todo»):
   - Al fusionar o borrar un producto con `stock > 0`, enviar movimiento `'CONTEO'` a `0` para el producto eliminado para no dejar stock huérfano en `stock_levels`.
   - En «Borrar Todo», usar `storageService.setItem('bodega_products_v1', [])` (con `confirm_bulk_delete_catalog_flag`) en lugar de `storageService.removeItem`, o bloquearlo en Nube/LAN redirigiendo a «Reiniciar cuenta».
5. En `src/utils/cartSync.js:120-136`:
   - Actualizar `_unitsPerPackage: fresh.unitsPerPackage` y `packagingType: fresh.packagingType` al resincronizar ítems de cesta.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/productEditStockRace.test.js`
- Expected: PASS.
- Commit: `fix(products): evitar reversión de stock concurrente desde modal, usar CONTEO en edición directa y corregir cartSync`

---

### Task T04: Migración SQL `019_sync_integridad_multicaja.sql` (Conflictos zombi, borrado con saldo, roles en cartera, `process_void` atómico y rango de `cash`)
- **Cierra:** `C4`, `C8` (parcial), `C9` (parcial), `C11`, `A1`, `A8` (parcial), `BAJ-01`
- **Files:**
  - Create: `supabase/nube/migrations/019_sync_integridad_multicaja.sql`
  - Test: `tests/nube/sql/f6Integridad019.test.js` (Create)

**Step 1: Escribir suite SQL PGlite en rojo (`tests/nube/sql/f6Integridad019.test.js`)**
- Test 1 (`C11` delete+edit): Caja B borra `P1` (`v2`, `deleted_at != null`), Caja A edita solo `priceUsdt` con `base_version: 1` → `push_records_v2` **NO** crea objeto zombi sin `name`; aplica política íntegra (si `r.deleted_at is not null`, NO hace `merge_record_3way` contra `{"id":"P1"}`: o preserva el objeto completo de Caja A al revivirlo o rechaza con `conflict_deleted: true` — **elección recomendada: si `r.deleted_at is not null` y `v_deleted = false`, NO mezclar contra `{"id": id}`; usar `v_data` completo de la edición o respetar el borrado si fue explícito de admin; para 100% integridad sin pérdida silenciosa de campos, omitir `merge_record_3way` cuando `r.deleted_at is not null` para que `v_data` siempre sea un objeto completo válido**).
- Test 2 (`C9` borrado cliente con saldo): Dueño/admin intenta borrar cliente `c1` con `customer_balances.balance_usd = -25.00` → `push_records_v2` devuelve `rejected = true` y republica el cliente sin borrarlo (`deleted_at is null`).
- Test 3 (`BAJ-01` S4): Cajero envía `deleted: true` para un cliente ya borrado por admin → NO incrementa `rejected` falsamente.
- Test 4 (`A8` roles cartera): Cajero intenta `push_customer_movements` con `type = 'AJUSTE_CREDITO'` o `'ANULACION'` → rechazado con `42501`.
- Test 5 (`C8` idempotencia `SALDO_INICIAL_MIGRADO`): Dos cajas envían `SALDO_INICIAL_MIGRADO` para el mismo `customer_id` con distinto UUID → índice único parcial `where type = 'SALDO_INICIAL_MIGRADO'` (o verificación por `(account_id, customer_id, type)` cuando `source_type = 'MIGRATION'`) impide duplicar la deuda.
- Test 6 (`C4` `process_void` atómico): Anular una `VENTA_FIADA` desde Supervisor (`p_session = null`) revierte stock, **inserta reversos en `customer_movements`** (actualizando `customer_balances`) y **marca `status = 'ANULADA'` en `account_records(collection='cash')`** (emitiendo aviso `account_sync_state` para que Caja A baje la anulación).
- Test 7 (`A1` `cash_records_range`): RPC `public.cash_records_range(p_from timestamptz, p_to timestamptz, p_device_id text default null)` devuelve registros `cash` por rango de fechas usando índice sobre `(account_id, collection, updated_at)` sin tope de 20,000 UUIDs.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/sql/f6Integridad019.test.js`
- Expected: FAIL en los 7 tests.

**Step 3: Crear `supabase/nube/migrations/019_sync_integridad_multicaja.sql`**
- Reemplazar `push_records_v2`:
  - Añadir `and r.deleted_at is null` en el bloque S4 (`customers` cajero) y en el `select ... for update` del bloque S2 (`merge_record_3way`).
  - Si `p_collection = 'customers' and v_deleted`: verificar `coalesce((select balance_usd from public.customer_balances where account_id = v_account and customer_id = v_id), 0) <> 0` → si tiene saldo, republicar y devolver `rejected = true` (con aviso específico).
- Reemplazar `push_customer_movements`:
  - Exigir `v_role in ('dueno', 'administrador')` para `type in ('AJUSTE_CREDITO', 'AJUSTE_DEBITO', 'ANULACION', 'SALDO_INICIAL_MIGRADO')`.
  - Si `type = 'SALDO_INICIAL_MIGRADO'` y ya existe otro movimiento `SALDO_INICIAL_MIGRADO` con el mismo `(account_id, customer_id, source_id)` (o para el mismo `customer_id` si `source_id is null`), tratar como idempotente (`already_registered`) sin duplicar saldo.
- Reemplazar `process_void`:
  - Tras revertir `stock_movements`, buscar movimientos en `customer_movements` con `source_sale_id = v_sale.id::text` (y sin reverso existente `reversal_of = m.id`), insertar su contrapartida inversa (`type = 'ANULACION'`, dirección opuesta, `reversal_of = m.id`), actualizar `account_records` donde `collection = 'cash'` y `(id = v_sale.id::text || '@' || v_sale.device_id or data->>'id' = v_sale.id::text)` poniendo `status = 'ANULADA', voidedAt = now(), voidReason = p_reason`, y tocar `account_sync_state(account_id, 'cash_voids')` para notificar a Caja A.
- Crear índice `idx_account_records_cash_updated` y RPC `public.cash_records_range(p_from, p_to, p_device_id)`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/sql/ tests/nube/syncAudit.test.js`
- Expected: PASS en todas las pruebas SQL existentes + nuevas de `019`.
- Commit: `feat(sql): migración 019 de integridad multi-caja (anti-zombi, borrado con saldo, roles cartera, void atómico y cash por rango)`

---

### Task T05: Endurecer `recordSync.js`, `useNubeSync.js` y `realtimeChannel.js`
- **Cierra:** `C13`, `C14`, `A4`, `A11`, `MED-01`, `MED-03`, `MED-07`
- **Files:**
  - Modify: `src/utils/storageService.js:97-122` (eximir `options?.fromCloud === true` del `CircuitBreaker`)
  - Modify: `src/nube/recordSync.js:47, 149-160, 210-258, 274-327, 392-455`
  - Modify: `src/nube/useNubeSync.js:50-95, 155-217`
  - Modify: `src/nube/realtimeChannel.js:20-55`
  - Test: `tests/nube/recordSyncHardening.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/recordSyncHardening.test.js`)**
- Test 1 (`C13`): Borrado masivo de 95/100 productos en Caja A → Caja B los baja con `fromCloud: true` sin disparar `CircuitBreaker`; además, si una colección falla en `pull()`, las demás colecciones (`customers`, `settings`) igualmente bajan.
- Test 2 (`C14` `pendingLocal` + cambio de turno): Admin edita `P1` offline (`queue`), Caja B sube `P1 v2`, Caja A baja (`applyPulled` salta `P1`), luego entra Cajero (`canPush('products') === false`) → siguiente `pull()` **SÍ aplica `P1 v2`** porque `state.versions['P1']` NO se adelantó a `v2` mientras estuvo en `pendingLocal`.
- Test 3 (`C14` `canPush` en `queueLocalWrite`): Con sesión de Cajero (`canPush('products') === false`), una escritura accidental en `bodega_products_v1` o `my_categories_v1` **NO entra a `state.queue`** (cero escalamiento diferido al cambiar a turno Admin).
- Test 4 (`C14` boot offline): Si `engine.pull()` inicial falla por red, `pull()` reporta `{ ok: false }` y `useNubeSync` **NO llama `markNubeRateReady()`** ni sube valores de fábrica sobre la nube.
- Test 5 (`A11` UTF-8 bytes + poison pill): Medición real con `new TextEncoder().encode(JSON.stringify(data)).length <= 90_000`; `lastError` de tamaño no se borra por `flush()` exitoso; si un registro falla en servidor con clase `22` (`22023`), se aparta a `pdn_record_rejected_v1` sin trabar los otros 199 registros.
- Test 6 (`MED-07`): Registro borrado en página 1 y recreado en página 2 del mismo `pull()` termina presente (`removed.delete(at)`).
- Test 7 (`A4` + `MED-01`): Tras `engine.pull(['products'])` que inserta un producto nuevo, `stockMirror.applyKnown()` se dispara inmediatamente (sin esperar 5 min); si `keepChannel` falló el primer intento y luego conecta por primera vez tras fallo, dispara `onUp({ reconnected: true })`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/recordSyncHardening.test.js`
- Expected: FAIL en los 7 tests.

**Step 3: Implementación mínima**
- Aplicar cada ajuste exacto en `storageService.js`, `recordSync.js`, `useNubeSync.js` y `realtimeChannel.js`.
- En `recordSync.js:296-324`: cuando un registro en `queue` fue editado de nuevo mientras `batch` estaba en vuelo (`stillQueued.has(rec.id)`), actualizar su `b` al nuevo `ok.version` solo cuando el segundo cambio partió del estado confirmado (`MED-03`).
- Escuchar `cash_voids` en `account_sync_state` (`useNubeSync.js:176-181`) para sincronizar anulaciones hechas desde Supervisor hacia el `bodega_sales_v1` local de Caja A (`C4`).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/recordSyncHardening.test.js tests/nube/recordSync.test.js tests/nube/syncAudit.test.js tests/nube/realtimeChannel.test.js`
- Expected: PASS.
- Commit: `fix(recordSync): blindar CircuitBreaker, pendingLocal, canPush, boot offline, UTF-8 poison-pill y reconexión inicial`

---

### Task T06: Reparar sincronización de Tasas (Supervisor `{ value }`, tasas automáticas BCV/Euro/USDT en LAN y `accountReset`)
- **Cierra:** `C12`, `A6`, `MED-05`
- **Files:**
  - Modify: `src/nube/ownerDashboard.js:181-206, 328-365`
  - Modify: `src/lan/cloudSupervisorClient.js:222-238, 292-310`
  - Modify: `src/nube/rateSync.js:20-105`
  - Modify: `src/hooks/useRates.js:15-40, 155-315`
  - Modify: `src/nube/accountReset.js:27-58, 106-128`
  - Test: `tests/nube/rateSync.test.js`, `tests/nube/supervisorRateEnvelope.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/supervisorRateEnvelope.test.js`)**
- Test 1 (`C12`): Caja A guarda tasa manual `65 Bs` → `loadCurrentRate` en Supervisor lee `rateMode: 'manual', customRate: '65'`. Luego `updateSupervisorRate` cambia a `70 Bs` → escribe `{ value: { rateMode: 'manual', customRate: '70', ... } }` → Caja A y Caja B al ejecutar `recordSync.pull(['settings'])` aplican **`70 Bs`**.
- Test 2 (`A6` tasa automática en LAN): Caja Principal (con internet) publica `autoRates: { bcv, euro, usdt, updatedAt }` dentro de `pdn_rate_v1` → Caja Secundaria sin internet aplica los valores exactos de `bcv`/`euro`/`usdt` en `monitor_rates_v12` en vez de caer al default `36.35`.
- Test 3 (`A6` `accountReset`): `wipeLocalData` conserva `bodega_rate_mode`, `bodega_custom_rate`, `bodega_use_auto_rate` (o limpia `pdn_sync_settings_v1` para re-descargar `pdn_rate_v1`) → tras reinicio, la tasa configurada se mantiene intacta.
- Test 4 (`MED-05`): `applyRateSnapshot` con `customRate: ''` y `tasaCop: ''` limpia `localStorage` para no re-publicar valores viejos en eco.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/supervisorRateEnvelope.test.js`
- Expected: FAIL en los 4 tests.

**Step 3: Implementación mínima**
1. Helper compartido `unwrapRateRecord(data)` / `wrapRateRecord(snap)` en `src/nube/rateSync.js` (lee `data?.value ?? data` para retrocompatibilidad y siempre escribe `{ value: snap }`). Usarlo en `ownerDashboard.js` y `cloudSupervisorClient.js`.
2. Extender `pdn_rate_v1` con `autoRates` (publicado por dueño/admin cuando `useRates` descarga tasas frescas) y aplicarlo en `applyRateSnapshot` hacia `monitor_rates_v12`.
3. En `applyRateSnapshot`: eliminar `bodega_custom_rate` / `tasa_cop` cuando vengan vacíos y suprimir `notifyRateChanged()` durante la aplicación remota.
4. En `accountReset.js:27`: añadir `bodega_rate_mode`, `bodega_custom_rate`, `bodega_use_auto_rate`, `cop_enabled`, `auto_cop_enabled`, `tasa_cop`, `cop_primary` a `KEEP_LOCAL_KEYS` (o resetear `versions['pdn_rate_v1']`).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/supervisorRateEnvelope.test.js tests/nube/rateSync.test.js tests/nube/reinicioCuenta.test.js`
- Expected: PASS.
- Commit: `fix(rates): corregir sobre { value } en Supervisor, sincronizar tasas automáticas BCV/USDT y proteger tasa en reset`

---

### Task T07: Blindar `stockService.js`, `voidSaleProcessor.js` y `slimCashRecord` (ganancias `sellByUnit` y avances de efectivo)
- **Cierra:** `C4` (cliente), `C5`, `A2`, `A5`, `M4`
- **Files:**
  - Modify: `src/nube/recordSync.js:32-40` (`slimCashRecord`)
  - Modify: `src/nube/stockService.js:25-39, 80-220`
  - Modify: `src/nube/checkoutBridge.js:50-75`
  - Modify: `src/utils/voidSaleProcessor.js:100-210`
  - Modify: `src/nube/NubeGate.jsx:835-855` (acción descartar/inspeccionar ventas rechazadas)
  - Modify: `src/views/ReportsView.jsx:80-90` y `src/views/DashboardView.jsx:285-295` (mostrar error real al anular)
  - Test: `tests/nube/slimCashAndSalesQueue.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/slimCashAndSalesQueue.test.js`)**
- Test 1 (`C5` `sellByUnit`): Venta por unidad (`id: 'p1_unit'`, `_originalId: 'p1'`, `qty: 10`, `priceUsd: 1.5`, `costUsd: 1.0`, `_mode: 'unit'`, `_unitsPerPackage: 12`) pasada por `slimCashRecord` → `FinancialEngine.calculateAggregateProfit` calcula **`+$5.00`** (no `-$105.00`).
- Test 2 (`C5` avance de efectivo): Venta con avance embebido (`isCashAdvance: true`, `montoEfectivo: 20`, `montoComision: 2`, `currency: 'USD'`) pasada por `slimCashRecord` → ganancia = **`+$2.00`** y `calculatePaymentBreakdown` descuenta `$20` de efectivo esperado.
- Test 3 (`A2` cola + timeout): `withTimeout` aborta con `AbortController`; sesión nula no se trata como error de red para saltar validación de stock online; al confirmar una venta en `replay()`, se limpia `sale.nube.pending = false` y se graba `sale.nube.number` en `bodega_sales_v1`.
- Test 4 (`C5`/`A5` `salesRejected` + `voidSaleProcessor`): Una venta rechazada definitivamente (`pdn_sale_rejected_v1`) puede anularse/descartarse localmente (revirtiendo deuda y marcando `ANULADA` sin bloquearse en `P0002`); y si el cliente ya fue borrado antes de `voidSaleProcessor`, el chequeo de precondiciones ocurre antes o tolera cliente ausente sin dejar divergencia con el servidor.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/slimCashAndSalesQueue.test.js`
- Expected: FAIL en los 4 tests.

**Step 3: Implementación mínima**
1. En `src/nube/recordSync.js:33-40`: conservar en cada ítem de `slimCashRecord`: `id` (manteniendo sufijo `_unit`!), `_originalId`, `name`, `qty`, `priceUsd`, `costUsd`, `costBs`, `isWeight`, `unit`, `granelUnit`, `packagingType`, `_mode`, `_unitsPerPackage`, `isCashAdvance`, `montoEfectivo`, `montoComision`, `comisionPct`, `currency`.
2. En `src/nube/stockService.js`:
   - Si hay cola pendiente y el navegador está online, intentar `await replay()` rápido antes de decidir encolar la venta nueva.
   - Si `getSession()` es `null` estando online, devolver error de sesión vencida (no `status: 0` offline).
   - Recibir callback `onSaleConfirmed(saleId, number)` para actualizar `bodega_sales_v1` bajo `pos_write_lock`.
   - Exponer `discardRejected(saleId)` para limpiar `pdn_sale_rejected_v1` al anular una venta que nunca llegó al servidor.
3. En `src/utils/voidSaleProcessor.js`:
   - Si `sale.nube?.saleId` está en `sales.rejected()` (o servidor devuelve `P0002` para una venta marcada `pending: true`), permitir anulación local + `discardRejected` sin abortar.
   - Si el cliente ya no existe en `bodega_customers_v1`, continuar la anulación local de venta y stock (registrando aviso en log) en vez de lanzar excepción tras haber anulado ya en servidor.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/slimCashAndSalesQueue.test.js tests/nube/stockService.test.js tests/nube/allCajasToday.test.js`
- Expected: PASS.
- Commit: `fix(sales): preservar campos financieros en slimCashRecord, endurecer cola de ventas y atomicidad de anulaciones`

---

### Task T08: Proteger `probeAndUpgrade` post-reset, `DeleteHistoryModal` y cierre de caja bajo `pos_write_lock`
- **Cierra:** `C15`, `A7` (parcial), `ALT-09`
- **Files:**
  - Modify: `src/nube/NubeGate.jsx:218-248`
  - Modify: `src/views/DashboardView.jsx:450-470, 555-565, 900-916`
  - Test: `tests/nube/resetOfflineGuard.test.jsx` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/resetOfflineGuard.test.jsx`)**
- Test 1 (`C15`): Caja B arranca en `offlineMode` con pasaporte offline y cola pendiente; Caja A ejecuta `reset_account` (`reset_epoch: 0 → 1`); Caja B reconecta y corre `probeAndUpgrade()` → **llama `guardReset()` ANTES de `loginWithPin`**, limpia IndexedDB/colas pre-reset y NO sube datos viejos.
- Test 2 (`ALT-09`): `DeleteHistoryModal` en `DashboardView` bloquea vaciar `bodega_sales_v1` cuando `isNubeAccountsEnabled()` es `true`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/resetOfflineGuard.test.jsx`
- Expected: FAIL.

**Step 3: Implementación mínima**
1. En `src/nube/NubeGate.jsx:222-236`: llamar `const resetHandled = await guardReset(client, device.account_id); if (resetHandled) return;` antes de `svc.loginWithPin(...)`.
2. En `src/views/DashboardView.jsx:901-914`: bloquear borrado total del historial cuando `isNubeAccountsEnabled()` está activo (redirigir a Ajustes → Reiniciar cuenta, igual que `useDataImportExport.js:153`).
3. En `src/views/DashboardView.jsx:452-463` (`handleConfirmCashRecon`): envolver el cierre de turno en `withLock('pos_write_lock')` leyendo `bodega_sales_v1` fresco desde `storageService.getItem` antes de marcar `cajaCerrada = true`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/resetOfflineGuard.test.jsx tests/nube/nubeGate.test.jsx`
- Expected: PASS.
- Commit: `fix(reset): verificar reset_epoch al reconectar pasaporte offline y proteger cierre/borrado de historial`

---

## OLA 2 · Cartera de Clientes y Cashea 100% Atómicos

### Task T09: Serializar `customerLedgerSync`, proteger clientes con cola pendiente y añadir cuarentena de poison-pill
- **Cierra:** `C6`, `C8` (cuarentena), `MED-11`
- **Files:**
  - Modify: `src/nube/customerLedgerSync.js:61-191`
  - Test: `tests/nube/customerLedgerSync.test.js`

**Step 1: Añadir tests en rojo a `tests/nube/customerLedgerSync.test.js`**
- Test 1 (`C6` doble gasto `saldo_favor`): Juan tiene `favor = 10`. Caja A offline gasta `10` (`SALDO_FAVOR_USADO` en `state.queue`, local `favor = 0`). `pull()` recibe `customer_balances[Juan] = +10` del servidor → **`applyBalances` excluye a Juan porque está en `state.queue`**; Caja A conserva `favor = 0` hasta que `flush()` confirme.
- Test 2 (`C6` concurrencia): `pull()` tiene guardia single-flight (`pulling`/`pullAgain`), `onLedgerWrite`/`flush`/`pull` serializan con `withLock('pdn_ledger_turn')`, y las escrituras a `LEDGER_KEY`/`CUSTOMERS_KEY` van bajo `withLock('pos_write_lock')`.
- Test 3 (`C8` poison pill): Un movimiento inválido (`22023`/`23xxx`) en posición 0 pasa a `pdn_ledger_rejected_v1` sin bloquear los movimientos válidos detrás de él.
- Test 4 (`MED-11`): Cliente con `favor: 5, deuda: 5` y saldo servidor `0` se normaliza a `favor: 0, deuda: 0`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/customerLedgerSync.test.js`
- Expected: FAIL en los 4 tests nuevos.

**Step 3: Implementación mínima**
- En `customerLedgerSync.js`:
  - `applyBalances(customers, balances, { skipIds = new Set() } = {})`: saltar `skipIds`, y en la comparación verificar también `!(Number(c.favor) > 0 && Number(c.deuda) > 0)`.
  - En `pull()`: construir `pendingCustomerIds = new Set(state.queue.map(m => String(m.customer_id)))` y pasarlo como `skipIds`.
  - En `flush()`: si `push_customer_movements` devuelve error Postgres clase `22`/`23`, reintentar registro por registro para aislar solo el poison-pill en `pdn_ledger_rejected_v1` y subir los demás.
  - Exportar `applyKnownBalances()` para que `useNubeSync` lo invoque tras `recordSync.pull(['customers'])` (`A4`).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/customerLedgerSync.test.js`
- Expected: PASS.
- Commit: `fix(ledger): proteger saldos con cola pendiente, serializar customerLedgerSync y aislar poison-pills`

---

### Task T10: Ordenar ledger por `nubeSeq`, cerrar bug de cursor `seq` saltado y determinismo en `SALDO_INICIAL_MIGRADO`
- **Cierra:** `C7`, `C8` (`SALDO_INICIAL_MIGRADO`)
- **Files:**
  - Modify: `src/utils/customerLedger.js:140-185`
  - Modify: `src/nube/customerLedgerSync.js:132-164`
  - Modify: `src/services/customerWalletService.js:60-85`
  - Modify: `src/utils/customerMigration.js:60-85`
  - Modify: `tests/nube/syncAudit.test.js:186-214` (pasar `it.fails` → `it`!)

**Step 1: Activar el test en rojo**
- En `tests/nube/syncAudit.test.js:186`: cambiar `it.fails(...)` por `it(...)`.
- Añadir test de ordenamiento offline (`Caja A device_at 10:00 seq 2` vs `Caja B device_at 10:30 seq 1`) → `calculateLedgerBalance` devuelve `-30` (el de `seq 2`), NO `-20`.
- Añadir test de `SALDO_INICIAL_MIGRADO` corriendo en Caja A y Caja B → mismo `stableUuid` → servidor registra 1 solo movimiento.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/syncAudit.test.js`
- Expected: FAIL en el test de `seq` menor que cursor y ordenamiento.

**Step 3: Implementación mínima**
1. En `src/nube/customerLedgerSync.js:136-163`:
   - Mantener cursor por `server_at` con solapamiento de 60 s (`sinceWithOverlap(lastServerAt, overlapMs)`) + desempate por `seq` (igual que `changedRows.js`), conservando `lastSeq` solo como respaldo. Un movimiento que confirma tarde (`seq = 10` después de `seq = 11`) entra dentro de la ventana de 60 s de `server_at` y **siempre baja**, deduplicándose por `id`.
2. En `src/utils/customerLedger.js:145-180`:
   - En `mergeLedgerEntries`, ordenar primero los movimientos confirmados por `nubeSeq` ascendente, y luego los pendientes locales (sin `nubeSeq`) por `timestamp` ascendente.
3. En `src/services/customerWalletService.js:66` y `src/utils/customerMigration.js:67`:
   - Generar ID determinista `stableUuid(\`saldo-inicial-migrado:${customer.id}\`)` (en lugar de `crypto.randomUUID()`).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/syncAudit.test.js tests/nube/customerLedgerSync.test.js`
- Expected: PASS (0 `it.fails` pendientes en `syncAudit.test.js`).
- Commit: `fix(ledger): cursor por server_at+overlap para no saltar seq, orden por nubeSeq e id determinista en migración`

---

### Task T11: Reparar Cashea de extremo a extremo e integrarlo al libro de cartera
- **Cierra:** `C9` (Cashea)
- **Files:**
  - Modify: `src/utils/checkoutProcessor.js:179-184, 484-541`
  - Modify: `src/utils/casheaRemittanceProcessor.js:45-75`
  - Modify: `src/utils/voidSaleProcessor.js:177-205`
  - Modify: `src/nube/recordSync.js:18`
  - Modify: `src/views/CustomersView.jsx:79-91`
  - Test: `tests/nube/casheaSync.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/casheaSync.test.js`)**
- Test 1: `VENTA_CASHEA` con `casheaUsd = 40` incrementa `customer.casheaDeuda` a `40` y registra movimiento auditable.
- Test 2: Dos cajas registrando remesas Cashea concurrentes (`-$15` en Caja A, `-$10` en Caja B sobre `$40`) convergen a `$15` sin lost update.
- Test 3: `handleDeleteCustomerRequest` en `CustomersView` bloquea borrado si `casheaDeuda > 0.005`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/casheaSync.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- En `checkoutProcessor.js:484-541`: sumar `casheaUsd` a `customer.casheaDeuda` cuando `casheaUsd > 0`.
- Añadir `casheaDeuda` al libro/colección aditiva de remesas Cashea (o movimientos `VENTA_CASHEA`/`COBRO_CASHEA` en colección dedicada `cashea_movements` dentro de la migración `020` / `recordSync` con `keep: [..., 'casheaDeuda']` reconstruido desde movimientos).
- En `CustomersView.jsx:79-91`: agregar chequeo `(customer.casheaDeuda || 0) > 0.005` igual que `CustomerDetailSheet:648`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/casheaSync.test.js`
- Expected: PASS.
- Commit: `fix(cashea): acumular casheaDeuda en cobro, proteger contra LWW y bloquear borrado con saldo Cashea`

---

### Task T12: Proteger creación de clientes en Ventas/Dashboard y mostrar historial multi-caja en `CustomersView`
- **Cierra:** `C9` (creación sin `mergeScreenList`), `A14` (historial cliente), `BAJ-02`
- **Files:**
  - Modify: `src/hooks/useCheckoutFlow.js:75-96`
  - Modify: `src/views/DashboardView.jsx:310-328`
  - Modify: `src/views/CustomersView.jsx:115-205`
  - Test: `tests/nube/customersCrossCajaUi.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/customersCrossCajaUi.test.js`)**
- Test 1: Caja A tiene lista vieja `[c1]` en React; Caja B crea `c2` y sincroniza a IndexedDB de Caja A; Caja A crea `c3` desde Ventas (`useCheckoutFlow`) → `bodega_customers_v1` queda con `[c1, c2, c3]` (NO borra `c2`).
- Test 2: Historial y estado de cuenta WhatsApp en `CustomersView` incluye fiados/abonos registrados en Caja B leyendo `bodega_customer_ledger_v1`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/customersCrossCajaUi.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- En `useCheckoutFlow.js:84` y `DashboardView.jsx:323`: envolver la creación en `withLock('pos_write_lock')`, leer `fresh` de `storageService.getItem('bodega_customers_v1', [])` y fusionar con `mergeScreenList` (o `[...fresh, newCustomer]` deduplicado por `id`).
- En `CustomersView.jsx`: suscribirse a `app_storage_update` para `bodega_customers_v1` y `bodega_customer_ledger_v1`, y combinar `bodega_customer_ledger_v1` con `bodega_sales_v1` al abrir `toggleHistory` y generar estado de cuenta WhatsApp.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/customersCrossCajaUi.test.js`
- Expected: PASS.
- Commit: `fix(customers): usar pos_write_lock+mergeScreenList al crear clientes y unificar historial desde ledger`

---

## OLA 3 · Servidor LAN (PGlite), Transporte SSE, Respaldos, Seguridad y Cloud Bridge

### Task T13: Timeouts HTTP, Watchdog SSE de 45s y limpieza de sockets/backpressure en `lanClient.js` y `lanServer.mjs`
- **Cierra:** `C20` (sockets colgados), `A12` (backpressure SSE), `MED-10`
- **Files:**
  - Modify: `src/lan/lanClient.js:109-285`
  - Modify: `desktop/server/lanServer.mjs:110-125, 312-331, 531-540`
  - Test: `tests/lan/lanTransportResilience.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/lan/lanTransportResilience.test.js`)**
- Test 1 (`requestJson` timeout): Un fetch que nunca responde aborta en `timeoutMs` (ej. 15 s, configurable en test a 100 ms) devolviendo `{ ok: false, status: 0, error: { message: /timeout|Failed to fetch/i } }` sin colgar mutexes.
- Test 2 (Watchdog SSE): Stream SSE conecta (`connected`), luego deja de enviar `: keepalive` → tras `sseIdleTimeoutMs` (45 s prod / 150 ms test), `lanClient` aborta el reader y emite `'CHANNEL_ERROR'` para que `keepChannel` reconecte y haga `pull()`.
- Test 3 (Backpressure + error): Cliente SSE muerto o con buffer lleno en `lanServer.mjs` es limpiado de `sseClients` sin fuga de memoria; y `broadcastEvents` filtra por `accountId` si el cliente tiene cuenta asociada.
- Test 4 (Token 401): Si `/lan/events` o `/lan/query` responden 401 (sesión inválida tras restore/revocación), `lanClient` dispara evento `lan_auth_invalid` para que `NubeGate` re-valide en lugar de loopear 401 cada 30 s.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/lanTransportResilience.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- En `src/lan/lanClient.js`:
  - Añadir `requestTimeoutMs = 15_000` y `sseIdleTimeoutMs = 45_000`.
  - En `requestJson` y `probeLanServer`: usar `AbortController` + `setTimeout(..., requestTimeoutMs)`.
  - En `ensureStream`: reiniciar un timer de `sseIdleTimeoutMs` en **cada chunk recibido** (incluidos los `: keepalive\n\n`). Al vencer, `controller.abort()` + `notifyAllChannels('CHANNEL_ERROR')`.
  - En `requestJson`: detectar `401` explícito y notificar evento `window.dispatchEvent(new CustomEvent('pdn_lan_session_expired'))`.
- En `desktop/server/lanServer.mjs`:
  - En `/lan/events`: activar `req.socket?.setKeepAlive?.(true, 15_000)`, registrar `res.on('error', cleanup)` y `res.on('close', cleanup)`, y en `broadcastEvents` verificar `client.res.writableEnded || client.res.destroyed` y descartar clientes con buffer excedido (`writableLength > 512 * 1024`).
  - En `/lan/query`: si viene `Authorization: Bearer ...` con token que no existe en `lan_auth.sessions`, devolver HTTP `401` en vez de correr silenciosamente como `anon`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/lanTransportResilience.test.js tests/lan/lanMulticaja.test.js`
- Expected: PASS.
- Commit: `fix(lan): agregar timeouts HTTP, watchdog SSE de 45s, manejo de 401 y control de backpressure`

---

### Task T14: Durabilidad PGlite (`CHECKPOINT` + backup atómico) y Reparación Integral de `/lan/backup/restore` + `useDataImportExport`
- **Cierra:** `C19`, `C20` (PGlite durabilidad), `A9`
- **Files:**
  - Modify: `desktop/server/lanDb.mjs:215-260, 806-942`
  - Modify: `desktop/server/lanServer.mjs:428-439, 568-584`
  - Modify: `desktop/main.js:80-110` (intervalo de backup atómico de 30 min si hubo mutaciones)
  - Modify: `src/hooks/useDataImportExport.js:110-140`
  - Modify: `src/nube/importBackup.js:41-145`
  - Modify: `src/config/backupKeys.js:22-64`
  - Test: `tests/lan/lanRestoreAndLicense.test.js`, `tests/nube/backupRestore.test.js`

**Step 1: Escribir tests en rojo**
- En `tests/lan/lanRestoreAndLicense.test.js`:
  - Test 1 (`C19` discrepancia abierta): Crear venta offline que genera fila en `stock_discrepancies`, exportar snapshot y restaurar con `/lan/backup/restore` → **debe tener éxito (`ok: true`)** (no abortar por `'diferencias_abiertas'`).
  - Test 2 (`C19` notificación + `reset_epoch`): Al restaurar snapshot en servidor LAN, `accounts.reset_epoch` se incrementa (`+1`), se emite evento SSE `account_sync_state(collection='reset')` a cajas conectadas y luego se cierran sus streams antiguos; las imágenes de `pdn-lan-images/` se incluyen y restauran.
  - Test 3 (`A9` JSON app restore): `clearAppKeysForRestore` limpia también `PreciosAlDiaNube/pdn_sync`; `importInitialBalances` usa `${stamp}` para permitir restaurar un segundo respaldo posterior; `backupKeys.js` incluye `pdn_rate_v1` y `bodega_rate_mode`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/lanRestoreAndLicense.test.js tests/nube/backupRestore.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
1. En `desktop/server/lanDb.mjs`:
   - Contabilizar mutaciones (`dirtyMutations += 1`) y ejecutar `await db.exec('CHECKPOINT;')` tras cada 10 mutaciones o cada 30 s en idle (reduce drásticamente la ventana de pérdida en corte eléctrico con PGlite `-F`).
   - En `restoreJsonSnapshot`:
     - Filtrar `invariants.filter(r => r.check_name !== 'diferencias_abiertas')` y mostrar `r.check_name` (no `.issue`).
     - Incrementar `update public.accounts set reset_epoch = reset_epoch + 1;` y actualizar `account_sync_state` con `collection = 'reset'`.
     - Incluir `images` (base64 de `pdn-lan-images/`, opt-in/límite seguro) y preservar `lan_auth.meta` de `lan_id`.
2. En `desktop/server/lanServer.mjs`:
   - En `/lan/backup/restore`: emitir evento `reset` por SSE, esperar flush (100 ms), cerrar `sseClients` obsoletos y llamar `cloudBridge.scheduleSnapshotPush()`.
   - En `saveDiskBackupNow`: escribir primero a `${filePath}.tmp` y renombrar atómicamente con `fs.renameSync`; correr cada 30 min solo si `lanDb.hasPendingBackupChanges()`.
3. En `src/hooks/useDataImportExport.js`, `src/nube/importBackup.js` y `src/config/backupKeys.js`:
   - Limpiar el store `PreciosAlDiaNube/pdn_sync` al restaurar.
   - Incluir `stamp` en `stableUuid` de `importInitialBalances` y calcular delta contra el saldo actual del servidor (para que restaurar saldos en `0` o reducidos también cuadre).
   - Validar `validId` y `MAX_RECORD_BYTES` antes de subir lotes en `importBackupToCloud`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/lanRestoreAndLicense.test.js tests/nube/backupRestore.test.js tests/nube/importBackup.test.js`
- Expected: PASS.
- Commit: `fix(backup): endurecer durabilidad PGlite, reparar /lan/backup/restore con reset_epoch y limpiar colas al restaurar`

---

### Task T15: Seguridad LAN (CORS restringido, auth en endpoints localhost, path traversal) y `reset_account` con PIN en LAN local
- **Cierra:** `C21`, `MED-09` (staticDir)
- **Files:**
  - Modify: `desktop/server/lanServer.mjs:74-84, 137-148, 211-265, 416-485`
  - Modify: `desktop/main.js` + `desktop/preload.js` (exponer secreto efímero `lanAdminSecret` solo a la ventana Electron Principal para operaciones localhost de emergencia)
  - Modify: `src/nube/NubeAccountReset.jsx:60-115`
  - Test: `tests/lan/lanSecurityAndReset.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/lan/lanSecurityAndReset.test.js`)**
- Test 1 (`C21` CORS): Una petición con `Origin: https://sitio-malicioso.com` NO recibe `Access-Control-Allow-Origin: https://sitio-malicioso.com`.
- Test 2 (`C21` localhost auth): Un `POST /lan/auth/local-reset-pin` o `GET /lan/backup/snapshot` desde `127.0.0.1` sin sesión de dueño ni header `X-PDN-Local-Secret` devuelve `401/403`.
- Test 3 (`MED-09` path traversal): `GET /../dist-web2/secret.txt` cuando `staticDir` es `dist-web` devuelve `403/404`.
- Test 4 (`C21` reset LAN local): Dueño en LAN local puede confirmar `reset_account` ingresando su PIN de dueño (`ownerPinSignIn`) sin necesitar contraseña aleatoria desconocida.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/lanSecurityAndReset.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
1. En `lanServer.mjs`:
   - Validar `Origin` contra lista permitida: `localhost`, `127.0.0.1`, redes privadas RFC1918 (`10.*`, `172.16-31.*`, `192.168.*`), `app://`, `file://`. Rechazar cualquier origen externo.
   - Exigir sesión de dueño autenticada (`session && !session.user.anonymous`) en `/lan/backup/snapshot`, `/lan/backup/restore`, `/lan/bridge/*` y `/lan/pairing/code`; para `/lan/auth/local-reset-pin`, exigir `X-PDN-Local-Secret` generado por Electron main process (o confirmación explícita desde IPC de escritorio).
   - En `staticDir`: corregir validación a `target === resolvedRoot || target.startsWith(resolvedRoot + path.sep)`.
2. En `NubeAccountReset.jsx`: detectar `isLanMode()` y permitir autenticación de dueño mediante PIN (`client.lan.ownerPinSignIn(pin)`) para ejecutar `reset_account`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/lanSecurityAndReset.test.js tests/lan/lanStaticServe.test.js tests/nube/reinicioCuentaUi.test.jsx`
- Expected: PASS.
- Commit: `fix(security): restringir CORS LAN, exigir auth en rutas administrativas y habilitar reset por PIN en LAN`

---

### Task T16: Reparar Pasaporte Offline LAN, completar eventos SSE y cache-busting de imágenes LAN
- **Cierra:** `A5`, `A12` (eventos SSE LAN), `A13`
- **Files:**
  - Modify: `desktop/server/lanDb.mjs:125-142, 531-580, 694-725`
  - Modify: `desktop/server/lanServer.mjs:354-363`
  - Modify: `src/nube/NubeGate.jsx:155-165, 265-305`
  - Modify: `src/utils/imageUpload.js:54-65, 110-125`
  - Test: `tests/lan/offlinePassport.test.js`, `tests/lan/lanMulticaja.test.js`

**Step 1: Escribir tests en rojo**
- Test 1 (`A5`): Cajero sin PIN (`pin_hash IS NULL, pin_length IS NULL`) y cajero con PIN de 6 dígitos (`pin_length = 6`) reciben `pin_length` exacto en `buildOfflinePassport()` y loguean offline exitosamente.
- Test 2 (`A12`): `revoke_device` / `team_revoke_device` y `upsert_member` / `resolve_discrepancy` emiten eventos SSE inmediatamente; la caja revocada se bloquea al instante en vez de esperar 5 min.
- Test 3 (`A13`): `POST /lan/images` devuelve `/lan/images/<id>.<ext>?v=<timestamp>` (y elimina extensiones viejas del mismo `safeId`); `migrateProductImagesToStorage` también migra fotos `data:` a `/lan/images/` en modo LAN.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/offlinePassport.test.js tests/lan/lanMulticaja.test.js`
- Expected: FAIL en los nuevos casos.

**Step 3: Implementación mínima**
1. En `lanDb.mjs:700`: seleccionar `pin_length` real de `account_members` (`case when pin_hash is null or pin_hash = '' then null else coalesce(pin_length, case when role = 'cajero' then 4 else 6 end) end as pin_length`).
2. En `NubeGate.jsx`: refrescar `fetchOfflinePassport()` cada 30 min y al recibir evento SSE de `account_members`.
3. En `lanDb.mjs:125-141, 531-580`: añadir `resolve_discrepancy` y `create_sede` a `MUTATING_RPCS`; emitir eventos SSE también para cambios recientes en `account_devices`, `account_members` y `stock_discrepancies`; suscribir `NubeGate` a `account_devices` para revocación inmediata.
4. En `lanServer.mjs:354-363` y `src/utils/imageUpload.js`: agregar `?v=${Date.now()}`, limpiar extensiones previas en disco y habilitar migración offline en LAN.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/offlinePassport.test.js tests/lan/lanMulticaja.test.js`
- Expected: PASS.
- Commit: `fix(lan): corregir pin_length en pasaporte offline, completar SSE de equipo/dispositivos y cache-busting de imágenes`

---

### Task T17: Endurecer Cloud Bridge (anti-deadlock, anti-flood 4s, reclaim de comandos zombi, idempotencia Supervisor)
- **Cierra:** `C20` (Cloud Bridge), `A12` (doble envío Cloud Supervisor), `A6` (puente seguridad/PIN)
- **Files:**
  - Create: `supabase/lan/002_puente_supervisor_hardening.sql`
  - Modify: `desktop/server/cloudBridge.mjs:20-42, 120-265`
  - Modify: `desktop/server/lanDb.mjs:1040-1070` (`save_product` + `initialStock` atómico)
  - Modify: `src/lan/cloudSupervisorClient.js:45-150`
  - Modify: `src/nube/NubeOwnerDashboard.jsx:155-205`
  - Test: `tests/lan/lanCloudBridgeRelay.test.js`, `tests/lan/lanCloudBridgeSql.test.js`

**Step 1: Escribir tests en rojo**
- Test 1 (Anti-flood): Si pasan 3 ciclos de `syncOnce()` sin comandos ni mutaciones locales, `lan_bridge_push_snapshot` se invoca **0 veces** (solo sube cuando `snapshotDirty === true` o tras heartbeat de 60 s).
- Test 2 (Anti-deadlock): Si `callSupabaseRpc` se cuelga >15 s, aborta con timeout y libera `runningCycle`.
- Test 3 (Comandos zombi + ack fallido): En SQL `002`, `lan_bridge_claim_commands` reclama comandos en `'processing'` con `updated_at < now() - interval '60 seconds'`; en `cloudBridge.mjs`, si falla solo `lan_bridge_ack_command(..., 'applied')`, NO lo sobrescribe con `'failed'` (reintenta el ack en el próximo ciclo).
- Test 4 (`setupBridge` error): Si `lan_bridge_register` falla, `config.enabled` permanece `false`.
- Test 5 (`NubeOwnerDashboard`): Refresca al reconectar SSE (`onUp({ reconnected: true })`), muestra estado de comandos pendientes/fallidos y deshabilita botón durante envío para impedir doble abono/ajuste.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/lanCloudBridgeRelay.test.js tests/lan/lanCloudBridgeSql.test.js`
- Expected: FAIL en los nuevos casos.

**Step 3: Implementación mínima**
- Implementar `002_puente_supervisor_hardening.sql` (reclaim de `'processing'` >60s, backoff en `lan_supervisor_login` sin oracle de código, revocar sesiones al cambiar PIN).
- Actualizar `cloudBridge.mjs` con `AbortSignal.timeout(15_000)`, flag `snapshotDirty`, cola `pendingAcks`, y `scheduleSnapshotPush` delegando en `syncOnce` (sin pisar `runningCycle`).
- En `lanDb.mjs`: ejecutar `save_product` + `initialStock` y recopilar eventos en una sola operación coherente; sincronizar cambio de PIN del dueño hacia `cloudBridge` si está activo.
- En `NubeOwnerDashboard.jsx`: recargar al reconectar SSE y bloquear doble envío con clave idempotente estable por formulario.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/lanCloudBridgeRelay.test.js tests/lan/lanCloudBridgeSql.test.js tests/lan/lanSupervisorActions.test.jsx`
- Expected: PASS.
- Commit: `fix(bridge): eliminar flood cada 4s, agregar timeout/reclaim de comandos zombi y evitar doble envío en Supervisor`

---

### Task T18: Estabilidad del servidor Electron LAN (arranque single-flight, `scrypt` async y redescubrimiento UDP ante cambio de IP DHCP)
- **Cierra:** `MED-07`, `MED-09`
- **Files:**
  - Modify: `desktop/main.js:64-145`
  - Modify: `desktop/server/lanDb.mjs:181-196` (`crypto.scrypt` async)
  - Modify: `src/lan/lanConfig.js:50-99`
  - Modify: `src/lan/lanClient.js:140-175`
  - Test: `tests/lan/lanDhcpRecovery.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/lan/lanDhcpRecovery.test.js`)**
- Test 1: Dos llamadas simultáneas a `startMasterServer()` comparten una sola promesa en vuelo (`startingPromise`) y nunca lanzan dos instancias PGlite.
- Test 2: Si `lanClient` recibe 3 fallos de red consecutivos en Electron y hay `discoverLanServers()` disponible, busca automáticamente el servidor por el mismo `lanId` y actualiza la URL LAN si cambió la IP DHCP.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/lan/lanDhcpRecovery.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- En `desktop/main.js`: `let startingServerPromise = null;` + usar `boundPort` real en `buildFirewallScript`.
- En `desktop/server/lanDb.mjs`: reemplazar `crypto.scryptSync` por `util.promisify(crypto.scrypt)` ejecutado **antes** de entrar a `enqueue()` para no bloquear el event loop ni la cola PGlite.
- En `src/lan/lanClient.js` + `lanConfig.js`: guardar `lanId` del servidor vinculado; ante fallos repetidos de red en app desktop, invocar redescubrimiento UDP y re-apuntar si coincide `lanId`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/lan/lanDhcpRecovery.test.js`
- Expected: PASS.
- Commit: `fix(desktop): serializar arranque master, scrypt async y redescubrimiento UDP ante cambio de IP`

---

## OLA 4 · Paridad Total de Dominios, Reportes Multi-Caja y Certificación Caos

### Task T19: Sincronizar Configuración Comercial y Fiscal compartida (`IVA`, negocio, stock negativo, Cashea, redondeo) + refresco en vivo de métodos de pago y categorías
- **Cierra:** `C18`, `A14` (caché métodos), `MED-04`, `MED-06`, `BAJ-02`
- **Files:**
  - Create: `src/nube/businessConfigSync.js`
  - Modify: `src/nube/recordSync.js:16-28` (agregar `pdn_business_config_v1` en `collection: 'settings'` con merge por campo directo, no envuelto opaco)
  - Modify: `src/nube/useNubeSync.js`
  - Modify: `src/config/taxConfig.js`, `src/config/paymentMethods.js:130-220`, `src/views/SettingsView.jsx`
  - Modify: `src/context/ProductContext.jsx:200-280`
  - Test: `tests/nube/businessConfigSync.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/businessConfigSync.test.js`)**
- Test 1 (`C18`): Admin en Caja A habilita IVA 16% (`tax_config_v1`), cambia `allow_negative_stock = true` y edita `business_name`/`business_rif` → Caja B recibe el cambio en tiempo real y cobra con 16% IVA e imprime el nuevo RIF.
- Test 2 (`paymentMethods`): Crear método de pago custom en Caja A refresca `_customMethodsCache` en Caja B vía `app_storage_update` sin recargar la página, y guardar métodos usa `mergeScreenList` + `pos_write_lock`.
- Test 3 (`MED-04`): `ProductContext` no ignora eventos `app_storage_update` con `detail.source === 'remote'` durante su debounce de 1 s.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/businessConfigSync.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- Crear `src/nube/businessConfigSync.js` sincronizando `tax_config_v1`, `allow_negative_stock`, `business_name`, `business_rif`, `business_phone`, `business_address`, `business_instagram`, `business_logo` (o ruta `/lan/images/brand-logo.*`), `cashea_enabled`, `cashea_min_amount`, `allow_cash_advance`, `cash_advance_default_pct`, `checkout_bs_round_mode`, `checkout_bs_round_step`, `checkout_smallest_usd_bill`, `payroll_goods_valuation` como objeto plano de campos en `account_records(collection='settings', id='pdn_business_config_v1')` para aprovechar `merge_record_3way` por campo (`MED-06`).
- Suscribir `paymentMethods.js` a `app_storage_update` para invalidar `_customMethodsCache`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/businessConfigSync.test.js`
- Expected: PASS.
- Commit: `feat(sync): sincronizar configuración fiscal (IVA), datos del negocio y refresco en vivo de métodos de pago`

---

### Task T20: Migración SQL `020_proveedores_nomina_compras.sql` + Sincronización completa de Proveedores, Facturas y Libro de Deuda de Proveedor
- **Cierra:** `C16`
- **Files:**
  - Create: `supabase/nube/migrations/020_proveedores_nomina_compras.sql`
  - Create: `src/nube/supplierLedgerSync.js`
  - Modify: `src/nube/recordSync.js:16-28` (`bodega_suppliers_v1` agrega `keep: ['deuda']`; agregar `bodega_supplier_invoices_v1`, `bodega_employees_v1`, `bodega_payroll_entries_v1`, `bodega_merchandise_purchases_v1` en `SYNCED_KEYS`)
  - Modify: `src/hooks/useSupplierManagement.js:35-315`
  - Modify: `src/nube/useNubeSync.js`
  - Test: `tests/nube/suppliersSync.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/suppliersSync.test.js`)**
- Test 1: Factura #001 ($500) creada en Caja A aparece en Caja B con el mismo saldo pendiente ($500).
- Test 2: Caja A carga Factura #002 (+$150) mientras Caja B paga -$200 a Polar → `supplier_balances` converge exactamente a **`$450`** en ambas cajas sin lost update.
- Test 3: `useSupplierManagement` ejecuta todas sus escrituras de `bodega_sales_v1`/`bodega_suppliers_v1`/`bodega_supplier_invoices_v1` bajo `withLock('pos_write_lock')` con lectura fresca y `mergeScreenList`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/suppliersSync.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
1. Migración `020_proveedores_nomina_compras.sql`:
   - Permitir colecciones `'supplier_invoices'`, `'employees'`, `'payroll_entries'`, `'purchases'` en `account_records` y `push_records_v2` (solo dueño/administrador).
   - Crear tablas `supplier_movements` + `supplier_balances` + RPC `push_supplier_movements` (misma arquitectura inmutable que `customer_movements`, protegida para dueño/admin) y añadir `supplier_balances` a `collectChangedEvents` en `lanDb.mjs` y Realtime.
   - En `strip_ledger_fields`: quitar `deuda` de `collection = 'suppliers'`.
2. Conectar `supplierLedgerSync.js` en `useNubeSync.js` y actualizar `useSupplierManagement.js` para usar `pos_write_lock` + movimientos de proveedor.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/suppliersSync.test.js tests/nube/sql/`
- Expected: PASS.
- Commit: `feat(suppliers): sincronizar facturas y libro aditivo de deuda de proveedores entre cajas`

---

### Task T21: Sincronización de Nómina entre cajas + Reparar validación de PIN en `PayrollPanel.jsx`
- **Cierra:** `C17`
- **Files:**
  - Modify: `src/components/Payroll/PayrollPanel.jsx:30-60`
  - Modify: `src/services/payrollService.js:100-145, 385-480`
  - Modify: `src/nube/importBackup.js:40-58`
  - Test: `tests/nube/payrollSyncAndPin.test.jsx` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/payrollSyncAndPin.test.jsx`)**
- Test 1 (`C17` PIN): En modo Nube/LAN, `PayrollPanel` rechaza el PIN de fábrica legado `000000` y valida contra el PIN real del dueño/administrador en `account_members` (o pasaporte offline).
- Test 2 (`C17` Sync): Empleado y adelanto/pago creados en Caja A sincronizan a Caja B (`employees`, `payroll_entries`); Caja B ve el saldo descontado y no puede pagar dos veces el mismo periodo.
- Test 3 (`M2` stock nómina): `registerGoods` llama `flushNubeStockNow()` y revierte si falla permisos.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/payrollSyncAndPin.test.jsx`
- Expected: FAIL.

**Step 3: Implementación mínima**
- En `PayrollPanel.jsx`: cuando `isNubeAccountsEnabled()` esté activo, validar el PIN mediante RPC `member_login_pin` (o `verifyOfflinePin` si está en pasaporte offline) para un miembro con rol `dueno`/`administrador`, en vez de `useAuthStore.verifyAdminPin`.
- Conectar `bodega_employees_v1` y `bodega_payroll_entries_v1` en `SYNCED_KEYS` (ya habilitadas en migración `020`) + `importBackup.js` + listener `app_storage_update` en `PayrollPanel.jsx`.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/payrollSyncAndPin.test.jsx tests/payrollUi.test.js`
- Expected: PASS.
- Commit: `fix(payroll): sincronizar nómina entre cajas y validar PIN real de Nube/LAN`

---

### Task T22: Sincronización de Compras de Mercancía y activación segura de `stockSeed.js`
- **Cierra:** `A4` (`stockSeed.js`), `A8` (compras)
- **Files:**
  - Modify: `src/hooks/useMerchandisePurchases.js:1-65`
  - Modify: `src/nube/useNubeSync.js:155-175`
  - Modify: `src/nube/stockSeed.js:1-55`
  - Test: `tests/nube/purchasesAndSeedSync.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/purchasesAndSeedSync.test.js`)**
- Test 1: Compra registrada en Caja A aparece en Caja B (escuchando `app_storage_update`) y se incluye en `importBackup.js`.
- Test 2: Al conectar por primera vez una caja con catálogo local preexistente (servidor con 0 `stock_levels`), `seedMissingStock` sube el stock inicial con motivo `'INICIAL'` y UUID determinista para que Caja B no vea stock `0`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/purchasesAndSeedSync.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- Conectar `bodega_merchandise_purchases_v1` (colección `'purchases'` de `020`) y listener `app_storage_update` en `useMerchandisePurchases.js`.
- Invocar `seedMissingStock` en `useNubeSync.js` cuando `canPush('products')` es `true`, tras el primer `pull()` exitoso y solo si el servidor no tiene niveles previos para esos productos (con ID determinista `stableUuid(\`${accountId}:${sedeId}:seed:${p.id}\`)` para evitar duplicados si dos cajas arrancan juntas).

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/purchasesAndSeedSync.test.js`
- Expected: PASS.
- Commit: `feat(sync): sincronizar compras de mercancía y activar stockSeed determinista`

---

### Task T23: `ReportsView.jsx` y `DashboardView.jsx` 100% Multi-Caja (RPC por rango, turnos cerrados hoy y cierres consolidados)
- **Cierra:** `C10`, `A1`, `A7`
- **Files:**
  - Modify: `src/nube/allCajasSales.js:1-125` (usar RPC `cash_records_range` por fechas + clave compuesta `${deviceId}:${sale.id}`)
  - Modify: `src/nube/allCajasToday.js:45-205` (incluir ventas de hoy de cajas que ya cerraron turno + consolidar `weekData` y `topProducts` + zona horaria consistente `America/Caracas`)
  - Modify: `src/views/DashboardView.jsx:184-205, 700-890`
  - Modify: `src/views/ReportsView.jsx:90-260` (selector «Todas las cajas / Esta caja» para dueño/admin en las 5 pestañas + PDFs, incluyendo cierres de todas las cajas)
  - Test: `tests/nube/allCajasReportsAndDashboard.test.js` (Create)

**Step 1: Escribir tests en rojo (`tests/nube/allCajasReportsAndDashboard.test.js`)**
- Test 1 (`A1`): Con >20,000 registros históricos en `cash`, `loadAllCajasSales({ from, to })` usa `cash_records_range` y devuelve el 100% de las ventas de hoy sin truncar por UUID.
- Test 2 (`A7`): Caja B vende `$500` a las 10:00 AM y cierra turno a las 2:00 PM → a las 3:00 PM el Inicio del Dueño sigue mostrando esos `$500` en «Ventas de hoy» y en «Por caja · hoy» (indicando estado «Turno cerrado»), y `SalesChart`/`topProducts` incluyen a Caja B.
- Test 3 (`C10`): En `ReportsView`, dueño/admin ve ventas, gastos, pagos a proveedores, compras y cierres de Caja A + Caja B consolidados, con opción de filtrar por caja individual.
- Test 4 (`A6` colisión IDs): Dos registros con mismo `id` (`apertura_1700000000000`) de Caja A y Caja B no colisionan en `mergeCajasSales`.

**Step 2: Ejecutar y confirmar fallo**
- Run: `npx vitest run tests/nube/allCajasReportsAndDashboard.test.js`
- Expected: FAIL.

**Step 3: Implementación mínima**
- Migrar `loadAllCajasSales` a `client.rpc('cash_records_range', { p_from, p_to, p_device_id })` con fallback paginado por `updated_at` si la RPC no existe aún.
- Corregir deduplicación en `mergeCajasSales` a `${deviceId || 'local'}:${sale.id}` y conservar `REGISTRO_CIERRE` cuando se solicite historial de cierres.
- Actualizar `allCajasToday.js`, `DashboardView.jsx` y `ReportsView.jsx` para soportar consolidado real de todas las cajas con filtro opcional por caja.

**Step 4: Verificar y commitear**
- Run: `npx vitest run tests/nube/allCajasReportsAndDashboard.test.js tests/nube/allCajasToday.test.js tests/nube/allCajasSales.test.js`
- Expected: PASS.
- Commit: `feat(reports): reportes y dashboard 100% multi-caja con consulta por rango de fechas y turnos cerrados`

---

### Task T24: Suite Maestra de Certificación Multi-Caja («Chaos & Convergence Suite») + Verificación Integral
- **Cierra:** Validación end-to-end de **todos** los escenarios de producción (2–3 cajas reales contra `createLanServer` HTTP + SSE + PGlite y contra `FakeSupabase`)
- **Files:**
  - Create: `tests/lan/lanChaosConvergence.test.js`

**Escenarios obligatorios en `tests/lan/lanChaosConvergence.test.js`:**
1. **Corte de red + edición cruzada + ventas simultáneas (3 cajas):** Caja A vende offline + edita otro producto; Caja B vende mismo producto + cambia precio; Caja C abona deuda de cliente + crea cliente nuevo → al reconectar, las 3 cajas y el servidor convergen bit a bit en productos, stock, clientes, saldos y `nube_private.verify_invariants() === []`.
2. **Supervisor LAN + Cloud Bridge:** Cambio de tasa desde Supervisor se refleja en Caja A y Caja B; anulación de venta fiada desde Supervisor revierte stock + deuda + marca `ANULADA` en Caja A.
3. **Borrado + edición concurrente + cambio de turno cajero↔admin:** 0 registros zombi, 0 escalamiento de cola de cajero, 0 congelamiento por `CircuitBreaker`.
4. **Restore de respaldo con discrepancias abiertas:** `/lan/backup/restore` tiene éxito, notifica `reset` por SSE, las cajas secundarias limpian cursores y convergen al estado restaurado sin resucitar datos.
5. **Dominios completos:** IVA (`tax_config_v1`), factura + pago concurrente de proveedor, empleado + adelanto de nómina y compra de mercancía convergen entre Caja A y Caja B, y `ReportsView` muestra el consolidado exacto.

**Verificación final obligatoria antes de declarar 100% listo:**
```bash
npx vitest run tests/nube/ tests/lan/
npm run typecheck
npm run build
```
Expected:
- **0 fallos** en `tests/nube/` y `tests/lan/` (incluyendo `0` `it.fails` en `syncAudit.test.js`).
- **0 errores** en `npm run typecheck`.
- **`npm run build`** exitoso.
