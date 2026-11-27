# CASO-008 — Modo «Caja compartida / Gaveta única» en Ajustes

**Fecha:** 2026-11-27
**Estado:** Verificado
**Plan:** [2026-11-27-plan-modo-caja-compartida.md](../plans/2026-11-27-plan-modo-caja-compartida.md)

## Qué pidió el dueño
Permitir que locales que operan desde **2 o más PCs con una sola gaveta física** puedan llevar todo junto como una sola caja (una sola apertura, fondo de gaveta compartido para vueltos, ventas/anulaciones compartidas y un solo cierre), manteniendo **«Cajas independientes»** como opción por defecto para quienes trabajan con gavetas separadas.

## Qué se hizo

| Fase | Qué cambia para el usuario | Archivos principales |
|---|---|---|
| Fase 1 | Configuración compartida `cash_drawer_mode` (`'separate'` por defecto \| `'shared'`) sincronizada entre PCs vía `pdn_business_config_v1` y soporte opcional de `shiftId` en el motor de turnos para evitar desajustes por desfases de reloj entre PCs. | `src/utils/cashDrawerMode.js` (nuevo), `src/nube/businessConfigSync.js`, `src/utils/cashShift.js`, `tests/cashDrawerMode.test.js` (nuevo) |
| Fase 2 | Migración `023` con tabla `shared_cash_shifts` (índice único parcial: máximo 1 turno compartido abierto por cuenta), helper `is_shared_cash_drawer`, permiso controlado en `push_records_v2` para anular/cerrar movimientos de otra PC conservando `updated_by_device` original, y RPCs atómicas `open_shared_cash_shift`, `close_shared_cash_shift` y `get_active_shared_shift` habilitadas en el servidor LAN. | `supabase/nube/migrations/023_caja_compartida_turnos.sql` (nuevo), `desktop/server/lanDb.mjs`, `tests/nube/sql/f7CajaCompartida.test.js` (nuevo) |
| Fase 3 | Sincronización bidireccional condicional de `cash` en `recordSync.js` (usa `id` canónico en modo compartido y mantiene `pushOnly` en modo independiente), puente `sharedCashShiftBridge.js` en `useNubeSync.js`, y deduplicación por `id` en `allCajasToday.js` para sumar sin doble conteo conservando el desglose por PC. | `src/nube/recordSync.js`, `src/nube/useNubeSync.js`, `src/nube/sharedCashShiftBridge.js` (nuevo), `src/nube/allCajasToday.js`, `tests/sharedCashSync.test.js` (nuevo) |
| Fase 4 | Selector **«Modo de operación multi-caja»** en Ajustes → Ventas → `Caja & Vuelto` (bloqueado si hay un turno abierto), coordinación de apertura única y sellado de `shiftId` en ventas/aportes, recarga viva ante eventos remotos de caja y cierre único atómico desde Inicio. | `src/components/Settings/tabs/SettingsTabVentas.jsx`, `src/hooks/useCheckoutFlow.js`, `src/hooks/useSalesData.js`, `src/utils/checkoutProcessor.js`, `src/views/DashboardView.jsx`, `tests/settingsSharedCashDrawer.test.jsx` (nuevo) |
| Fase 5 | Prueba de integración multi-caja sobre servidor LAN real (Caja A + Caja B: ajuste, apertura única idempotente, ventas en ambos equipos, arqueo sin doble conteo, anulación cruzada y cierre único atómico). | `tests/lan/lanSharedCashDrawer.test.js` (nuevo) |

## Qué no cambió
- El modo por defecto sigue siendo **«Cajas independientes»** (`separate`): ninguna tienda existente cambia su funcionamiento hasta activar «Caja compartida (Gaveta única)» en Ajustes.
- En modo independiente, `push_records_v2` sigue rechazando que una caja modifique registros de otra (`f5Caja.test.js` 3/3 en verde).

## Pruebas
- **LAN integración real (`tests/lan/lanSharedCashDrawer.test.js`):** `1/1` aprobada (`10.89s`).
- **SQL Postgres real:** `tests/nube/sql/f7CajaCompartida.test.js` (`3/3`), `tests/nube/sql/f5Caja.test.js` (`3/3`), `tests/nube/sql/f1Cuentas.test.js` (`16/16`, incluye idempotencia de todas las migraciones hasta la `023`).
- **Unitarias y UI:** `tests/cashDrawerMode.test.js` (`3/3`), `tests/sharedCashSync.test.js` (`2/2`), `tests/settingsSharedCashDrawer.test.jsx` (`2/2`), `tests/nube/businessConfigSync.test.js` (`3/3`), `tests/nube/allCajasSales.test.js` (`3/3`), `tests/nube/allCajasReportsAndDashboard.test.js` (`3/3`).
- **ESLint (`--quiet` en archivos modificados), `npm run typecheck` y `npm run build`:** `0` errores (`✓ built in 49.86s`, PWA `generateSW`).

## Errores
Ninguno abierto.
