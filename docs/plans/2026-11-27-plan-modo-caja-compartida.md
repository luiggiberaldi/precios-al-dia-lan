# Plan: Modo "Caja compartida / Gaveta única" en Ajustes

**Fecha:** 2026-11-27  
**Estado:** Propuesto  
**Alcance:** Ajustes de negocio sincronizados (`pdn_business_config_v1`), servidor LAN / Nube (migración `023`), motor de sincronización (`recordSync.js`), turnos/arqueo (`cashShift.js`, `allCajasToday.js`), y pantallas de `Ajustes`, `Vender` e `Inicio`.

---

## 1. Objetivo y Principio Rector

Permitir que locales que operan desde **2 o más PCs con una sola gaveta física** (y un mismo punto de venta / pago móvil) trabajen como **una sola caja unificada**:
- **Una sola apertura** (abrir en PC 1 abre automáticamente PC 2 vía SSE).
- **Fondo en gaveta compartido en vivo** (el efectivo cobrado en PC 1 cuenta para dar vuelto en PC 2).
- **Ventas, aportes, gastos, cobros de fiado y anulaciones compartidas** dentro del mismo turno.
- **Un solo cierre y arqueo** al final de la jornada (cerrar en una PC cierra el turno para todas).
- **Trazabilidad intacta:** cada registro sigue conservando qué equipo (`_deviceId` / `_cajaLabel`) y qué usuario (`cashier`) lo emitió.

**Regla de oro de compatibilidad:**
- El modo por defecto sigue siendo **`Cajas independientes`** (`'separate'`). Ningún local existente cambia su comportamiento hasta que el Dueño/Administrador active **`Caja compartida / Gaveta única`** (`'shared'`) en Ajustes.

---

## 2. Decisiones de Producto y Guardarraíles

| ID | Decisión | Comportamiento recomendado |
|---|---|---|
| **D1** | Cambio de modo | Solo **Dueño / Administrador**. Si hay una caja abierta en ese momento, el selector muestra un aviso y exige **cerrar el turno actual primero** para no mezclar un turno a medias. |
| **D2** | Apertura única idempotente | Si PC 1 y PC 2 intentan abrir caja al mismo segundo, el servidor acepta una sola `APERTURA_CAJA` con `shiftId` canónico y devuelve el turno ya abierto al otro equipo. |
| **D3** | Cierre único multi-PC | Al pulsar **Cerrar Caja** en modo compartido, el modal avisa explícitamente: *"Esto cerrará la caja compartida para todos los equipos conectados"* y muestra el desglose consolidado + columna informativa por PC/cajero. |
| **D4** | Trazabilidad | Todos los registros (`VENTA`, `GASTO_INTERNO`, `APORTE_CAJA`, `ANULACION`, etc.) conservan `_deviceId`, `_cajaLabel` y `cashier`. En `Inicio` y `Reportes` se puede ver el total único y, opcionalmente, el desglose por PC sin sumar doble. |
| **D5** | Corte temporal de red LAN | Si PC 2 pierde red unos segundos, sigue vendiendo asociada al `shiftId` activo. Al reconectar, sus ventas se integran al turno abierto; si el turno ya fue cerrado mientras estaba offline, se registran con marca `lateSyncAfterClose: true` y se muestra un aviso visible al administrador para que no queden ocultas ni alteren un cierre ya firmado. |
| **D6** | Cero doble conteo | En modo compartido, `bodega_sales_v1` ya contiene el turno unificado de todas las PCs; `buildAllCajasSummary` (`allCajasToday.js`) deduplica por `id` de registro y no vuelve a sumar local + remoto. |

---

## 3. Arquitectura por Fases

### Fase 1 — Configuración compartida y modelo puro de turno (`shiftId`)

**Archivos:**
- Create: `src/utils/cashDrawerMode.js`
- Modify: [`src/nube/businessConfigSync.js`](../../src/nube/businessConfigSync.js#L18-L40)
- Modify: [`src/utils/cashShift.js`](../../src/utils/cashShift.js#L1-L68)
- Test: `tests/cashDrawerMode.test.js`

**Implementación clave:**
1. **`src/utils/cashDrawerMode.js`:**
   - Constantes `CASH_DRAWER_MODE_KEY = 'cash_drawer_mode'`, `CASH_DRAWER_MODES = { SEPARATE: 'separate', SHARED: 'shared' }`.
   - Helpers puros: `readCashDrawerMode(storage)`, `isSharedCashDrawerMode(storage)`, `writeCashDrawerMode(mode, storage)` (dispara `app_storage_update` + `notifyBusinessConfigChanged()`).
2. **`src/nube/businessConfigSync.js`:**
   - Agregar `'cash_drawer_mode'` a `SYNCED_BUSINESS_LS_KEYS` para que viaje por `pdn_business_config_v1` (merge 3-way campo a campo) y se replique en vivo a todas las PCs.
3. **`src/utils/cashShift.js`:**
   - Soportar `shiftId` opcional en `findOpenCashShift(records)` e `isRecordInOpenCashShift(record, opening)`:
     - Si `opening.shiftId` y `record.shiftId` existen, la pertenencia al turno se decide por `record.shiftId === opening.shiftId` (inmune a relojes desfasados entre PC 1 y PC 2).
     - Si no existe `shiftId` (registros legacy o modo independiente), mantiene exactamente la comparación actual por `timestamp >= openingTime`.

**Verificación Fase 1:**
- `npx vitest run tests/cashDrawerMode.test.js tests/cashShift.test.js tests/nube/businessConfigSync.test.js` → PASS.

---

### Fase 2 — Migración SQL `023` y coordinación atómica de turno en servidor LAN

**Archivos:**
- Create: `supabase/nube/migrations/023_caja_compartida_turnos.sql`
- Modify: [`desktop/server/lanDb.mjs`](../../desktop/server/lanDb.mjs#L130-L150) (whitelisting de nuevas RPCs y emisión SSE)
- Test: `tests/nube/sql/f7CajaCompartida.test.js`

**Implementación clave:**
1. **Tabla `public.shared_cash_shifts` (idempotente, con RLS por `account_id`):**
   - Columnas: `id` (`shift_id`), `account_id`, `status` (`'open' | 'closed'`), `opened_at`, `opened_by_device_id`, `opened_by_name`, `opening_record_id`, `closed_at`, `closed_by_device_id`, `closed_by_name`, `close_record_id`, `updated_at`.
   - Índice único parcial: `create unique index ... on shared_cash_shifts (account_id) where status = 'open'` → garantiza a nivel de base de datos que **nunca** puedan existir dos turnos compartidos abiertos simultáneamente.
2. **RPCs atómicas:**
   - `open_shared_cash_shift(p_session, p_shift_id, p_opening_record)`: si ya existe turno abierto para la cuenta, devuelve `{ already_open: true, shift, opening_record }` sin duplicar; si no existe, inserta en `shared_cash_shifts` + registra `APERTURA_CAJA` en `records` (`collection = 'cash'`) y dispara `touch_sync_state('cash')` (SSE inmediato a todas las PCs).
   - `close_shared_cash_shift(p_session, p_shift_id, p_close_record)`: bajo bloqueo de fila `for update`, marca el turno `closed`, actualiza `cajaCerrada = true` en los registros del `shift_id` en `collection = 'cash'`, inserta `REGISTRO_CIERRE` y dispara `touch_sync_state('cash')`. Si otra PC ya cerró ese `shift_id`, responde `{ already_closed: true, shift }` idempotentemente.
   - `get_active_shared_shift(p_session)`: devuelve el turno abierto actual (si existe) para sincronización rápida al arrancar o reconectar una PC.
3. **`desktop/server/lanDb.mjs`:**
   - Registrar las 3 RPCs en la lista permitida del servidor LAN y emitir evento SSE de colección `cash` cuando cambie el turno.

**Verificación Fase 2:**
- `npx vitest run tests/nube/sql/f7CajaCompartida.test.js` (apertura concurrente de 2 cajas → 1 solo turno; cierre concurrente → 1 solo cierre; aislamiento entre cuentas) → PASS.

---

### Fase 3 — Sincronización bidireccional condicional en `recordSync.js` y deduplicación en Inicio/Reportes

**Archivos:**
- Modify: [`src/nube/recordSync.js`](../../src/nube/recordSync.js#L35-L60) (y flujo `pullCollection` / `mergeIntoLocal` para `cash`)
- Modify: [`src/nube/useNubeSync.js`](../../src/nube/useNubeSync.js) (reaccionar al cambio de `cash_drawer_mode` disparando un pull fresco de `cash`)
- Modify: [`src/nube/allCajasToday.js`](../../src/nube/allCajasToday.js#L86-L160)
- Test: `tests/sharedCashSync.test.js`

**Implementación clave:**
1. **`recordSync.js`:**
   - `pushOnly` para `bodega_sales_v1` pasa a ser dinámico según `isSharedCashDrawerMode()`:
     - En `'separate'`: comportamiento 100% actual (`pushOnly: true`, cada caja sube lo suyo y no baja lo de otras).
     - En `'shared'`: habilita **pull incremental** de `collection = 'cash'` (acotado al turno activo / últimos días recientes para no inflar IndexedDB) y fusiona por `id` en `bodega_sales_v1` sin sobrescribir cambios locales pendientes en cola.
   - Conservar en `slimCashRecord` los campos `shiftId`, `_deviceId`, `_cajaLabel`, `cajaCerrada`, `cierreId`, `lateSyncAfterClose` y `status` (para que anulaciones desde PC 2 se propaguen en vivo a PC 1).
2. **`allCajasToday.js` (`buildAllCajasSummary`):**
   - Deduplicar por `String(r.id)` antes de calcular totales cuando `cash_drawer_mode === 'shared'`.
   - Exponer flag `isSharedDrawer: true` en el resumen para que la UI muestre **1 turno compartido** con desglose informativo *"Aporte por PC (Caja 1 / Caja 2)"* sin mostrar dos cajas separadas por cerrar.

**Verificación Fase 3:**
- `npx vitest run tests/sharedCashSync.test.js tests/allCajasSales.test.js tests/nube/allCajasReportsAndDashboard.test.js` → PASS.

---

### Fase 4 — Interfaz en Ajustes, Ventas (`Vender`) e Inicio (`Cierre de Caja`)

**Archivos:**
- Modify: [`src/components/Settings/tabs/SettingsTabVentas.jsx`](../../src/components/Settings/tabs/SettingsTabVentas.jsx#L30-L45) (sub-pestaña `Caja & Vuelto`)
- Modify: [`src/views/SalesView.jsx`](../../src/views/SalesView.jsx) (apertura compartida, fondo de gaveta compartido, asignación de `shiftId` y aviso visual sutil `"Caja compartida"`)
- Modify: [`src/views/DashboardView.jsx`](../../src/views/DashboardView.jsx#L380-L540) (cierre único multi-PC llamando `close_shared_cash_shift`, bloqueo de cierre duplicado, y vista de arqueo único con desglose por PC)
- Modify: [`src/components/Dashboard/CierreCajaModal.jsx`](../../src/components/Dashboard/CierreCajaModal.jsx) *(o modal de cierre equivalente)* para mostrar la advertencia de cierre compartido y el desglose informativo por equipo/cajero.

**Implementación clave:**
1. **`SettingsTabVentas.jsx` (`Caja & Vuelto`):**
   - Tarjeta **"Modo de operación multi-caja"** (solo visible/editable para Dueño/Admin):
     - Radio cards accesibles (`min-h-[44px]`):
       - **Cajas independientes *(Por defecto)*:** cada PC abre, controla su efectivo y cierra su propia gaveta.
       - **Caja compartida (Gaveta única):** todas las PCs comparten apertura, fondo para vueltos, ventas y un solo cierre diario.
     - Validación UX: si hay un turno abierto en el momento, deshabilita el cambio con mensaje claro *"Cierra la caja actual antes de cambiar el modo de gaveta"*.
2. **`SalesView.jsx`:**
   - Al abrir caja en modo compartido, llama `open_shared_cash_shift` (con fallback local si no está en red LAN/Nube).
   - Al registrar cualquier venta, aporte, gasto, avance o cobro de fiado, estampa `shiftId: activeOpening.shiftId`, `_deviceId` y `_cajaLabel`.
   - Badge discreto en cabecera: `Gaveta compartida` cuando el modo está activo.
   - Al llegar un evento SSE de cierre desde otra PC, `SalesView` refresca `bodega_sales_v1` y muestra automáticamente `CajaCerradaOverlay` sin recargar la app.
3. **`DashboardView.jsx`:**
   - En modo compartido, el botón **Cerrar Caja** invoca `close_shared_cash_shift`, genera un solo `REGISTRO_CIERRE` (con resumen unificado + desglose por equipo) y cierra todos los movimientos del `shiftId` en una transacción atómica.

**Verificación Fase 4:**
- Pruebas RTL de `SettingsTabVentas` (bloqueo con turno abierto + cambio de modo) y `DashboardView` (arqueo único sin doble conteo).

---

### Fase 5 — Integración Multi-Caja LAN Real, E2E y Cierre Documental

**Archivos:**
- Create: `tests/lan/lanSharedCashDrawer.test.js` (servidor LAN real + Caja A + Caja B)
- Create: `tests/e2e/caja-compartida.e2e.spec.js`
- Create: `docs/casos/CASO-008-modo-caja-compartida.md`
- Modify: `docs/casos/INDICE.md` y `bitacora.md`

**Escenarios obligatorios en `tests/lan/lanSharedCashDrawer.test.js`:**
1. **Activación del modo:** Dueño activa `Caja compartida` en Caja A → Caja B recibe el ajuste por SSE.
2. **Apertura única:** Caja A abre turno con `$50` + `Bs 2000` → Caja B queda abierta automáticamente con el mismo `shiftId` sin pedir apertura.
3. **Fondo de gaveta y anulación cruzada:** Caja A cobra `$20` en efectivo → Caja B ve `$70` disponibles en gaveta; Caja B cobra `$15` y anula una venta de Caja A → ambas ven el mismo efectivo esperado exacto y el stock repuesto.
4. **Cierre único concurrente:** Caja A cierra turno → Caja B pasa a `Caja Cerrada` por SSE con `0` movimientos abiertos restantes; si Caja B intenta cerrar el mismo `shiftId`, recibe `already_closed` sin duplicar `REGISTRO_CIERRE`.
5. **Reconexión offline:** Caja B vende `$10` desconectada mientras Caja A cierra → al reconectar, la venta no se pierde y queda marcada con `lateSyncAfterClose: true` con aviso visible.
6. **Regresión modo independiente:** Con `cash_drawer_mode = 'separate'`, todas las pruebas existentes (`lanFlujosCompletos`, `lanChaosConvergence`, `checkout-movil.e2e`) siguen pasando sin cambios.

**Verificación final:**
- `npm run test:lan`, `npm run test`, `npx playwright test tests/e2e/caja-compartida.e2e.spec.js`, `npx playwright test tests/e2e/checkout-movil.e2e.spec.js`, `npm run typecheck`, `npm run build`, `npm run docs:check`.
