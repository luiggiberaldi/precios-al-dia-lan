// Política del PIN de roles privilegiados (auditoría de Ajustes, 13-nov-2026 + RBAC).
// Con la pantalla de inicio activa, Dueño, Encargado e Inventario SIEMPRE entran con PIN:
// si no, cualquiera que toque su tarjeta entra con privilegios. Solo el Cajero puede quedar sin PIN.
import { validatePin } from './securityConstants';
import { isPrivilegedRole } from '../security/permissions';

/** PIN de fábrica con el que nacen los usuarios (useAuthStore). No sirve para proteger al dueño. */
export const FACTORY_PIN = '000000';

/** Usuarios con rol privilegiado (Dueño/Admin, Encargado, Inventario) que hoy entran sin pedir PIN. */
export function adminsWithoutPin(usuarios) {
    return (Array.isArray(usuarios) ? usuarios : []).filter(u => isPrivilegedRole(u) && u.requirePin === false);
}

/** ¿Se puede marcar a este usuario como «entra sin PIN»? Solo roles no privilegiados (Cajero) cuando hay login. */
export function canBypassPin(user, requireLogin) {
    return !(isPrivilegedRole(user) && requireLogin);
}

/** Valida el PIN nuevo del Administrador/Dueño/Encargado. Devuelve el texto del error o null si está bien. */
export function validateNewAdminPin(pin, confirm) {
    const p = String(pin ?? '');
    const base = validatePin(p);
    if (base) return base;
    if (p === FACTORY_PIN) return 'Elige un PIN distinto de 000000 (es el de fábrica)';
    if (confirm !== undefined && p !== String(confirm ?? '')) return 'Los PIN no coinciden';
    return null;
}
