/**
 * Modo de operación de caja / gaveta en tiendas multi-caja.
 *
 * - 'separate' (por defecto): cada PC abre, lleva su fondo y cierra su propia gaveta.
 * - 'shared': todas las PCs comparten apertura, fondo para vueltos, ventas y un solo cierre.
 *
 * Se sincroniza entre equipos vía `pdn_business_config_v1` (businessConfigSync.js).
 */
import { notifyBusinessConfigChanged } from '../nube/businessConfigSync';

export const CASH_DRAWER_MODE_KEY = 'cash_drawer_mode';

export const CASH_DRAWER_MODES = Object.freeze({
    SEPARATE: 'separate',
    SHARED: 'shared',
});

export function normalizeCashDrawerMode(raw) {
    return raw === CASH_DRAWER_MODES.SHARED
        ? CASH_DRAWER_MODES.SHARED
        : CASH_DRAWER_MODES.SEPARATE;
}

export function readCashDrawerMode(storage = globalThis.localStorage) {
    if (!storage) return CASH_DRAWER_MODES.SEPARATE;
    try {
        return normalizeCashDrawerMode(storage.getItem(CASH_DRAWER_MODE_KEY));
    } catch {
        return CASH_DRAWER_MODES.SEPARATE;
    }
}

export function isSharedCashDrawerMode(storage = globalThis.localStorage) {
    return readCashDrawerMode(storage) === CASH_DRAWER_MODES.SHARED;
}

export function writeCashDrawerMode(mode, { storage = globalThis.localStorage, notify = true } = {}) {
    const normalized = normalizeCashDrawerMode(mode);
    if (storage) {
        try {
            storage.setItem(CASH_DRAWER_MODE_KEY, normalized);
        } catch {
            // ignorar cuota o modo privado
        }
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('app_storage_update', {
            detail: { key: CASH_DRAWER_MODE_KEY, value: normalized },
        }));
    }
    if (notify) {
        try { notifyBusinessConfigChanged(); } catch { /* sin sync activo */ }
    }
    return normalized;
}
