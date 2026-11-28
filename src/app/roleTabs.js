// Portero de pantallas (auditoría del Cajero 2026-11-13, ERR-118 + RBAC).
// Una sola regla para todas las entradas: barra, paleta de comandos (Ctrl+K / Esc),
// avisos, enlaces y cualquier `setActiveTab` futuro.
import { canAny, defaultTabForUser, TAB_PERMISSIONS } from '../security/permissions';

/** Pantallas que solo ven roles administrativos (compatibilidad con tests/callers legacy). */
export const ADMIN_ONLY_TABS = new Set(['reportes', 'ajustes']);

/**
 * ¿Puede este usuario/rol abrir la pantalla?
 * Acepta tanto un booleano legacy `isCajero` como un objeto `usuarioActivo` (RBAC).
 */
export function canOpenTab(tab, userOrIsCajero, options = {}) {
    if (typeof userOrIsCajero === 'boolean') {
        return !(userOrIsCajero && ADMIN_ONLY_TABS.has(tab));
    }
    const perms = TAB_PERMISSIONS[tab];
    if (!perms) return true;
    return canAny(userOrIsCajero, perms, options);
}

/** Pantalla a la que se va de verdad: si el rol no la tiene, cae a su pantalla inicial. */
export function safeTab(tab, userOrIsCajero, options = {}) {
    if (canOpenTab(tab, userOrIsCajero, options)) return tab;
    if (typeof userOrIsCajero === 'boolean') return 'ventas';
    return defaultTabForUser(userOrIsCajero, options);
}

/** Devuelve el Set de pestañas ocultas para el usuario (para CommandPalette). */
export function hiddenTabsForUser(user, options = {}) {
    const hidden = new Set();
    for (const tab of Object.keys(TAB_PERMISSIONS)) {
        if (!canOpenTab(tab, user, options)) hidden.add(tab);
    }
    return hidden.size > 0 ? hidden : null;
}
