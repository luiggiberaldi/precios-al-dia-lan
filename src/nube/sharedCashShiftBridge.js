/**
 * Puente entre las vistas (SalesView / DashboardView) y las RPCs atómicas de turno
 * compartido (`open_shared_cash_shift`, `close_shared_cash_shift`, `get_active_shared_shift`).
 *
 * Sigue el mismo patrón desacoplado de `checkoutBridge.js`: cuando el modo Nube/LAN no está
 * activo, devuelve `null` y las pantallas operan 100% en local.
 */

let bridge = null;

export function setSharedCashShiftBridge(handlers) {
    bridge = handlers || null;
}

export function hasSharedCashShiftBridge() {
    return Boolean(bridge);
}

export async function openSharedShiftRemote(shiftId, openingRecord) {
    if (!bridge?.openShift) return null;
    return bridge.openShift(shiftId, openingRecord);
}

export async function closeSharedShiftRemote(shiftId, closeRecord) {
    if (!bridge?.closeShift) return null;
    return bridge.closeShift(shiftId, closeRecord);
}

export async function getActiveSharedShiftRemote() {
    if (!bridge?.getActiveShift) return null;
    return bridge.getActiveShift();
}

export async function pullSharedCashNow() {
    if (!bridge?.pullCash) return 0;
    return bridge.pullCash();
}
