/**
 * usePermissions.js — Hook reactivo de permisos RBAC conectado a useAuthStore.
 *
 * Uso:
 *   const { role, can, canAny, isOwner, isManager } = usePermissions();
 *   if (can(PERMISSIONS.SALES_VOID)) { ... }
 */
import { useCallback, useMemo } from 'react';
import { useAuthStore } from './store/useAuthStore';
import {
    ROLES,
    PERMISSIONS,
    normalizeRole,
    can as canPerm,
    canAny as canAnyPerm,
    canAll as canAllPerm,
    isOwnerRole,
    isManagerRole,
    isPrivilegedRole,
} from '../security/permissions';

export { ROLES, PERMISSIONS };

export function usePermissions() {
    const usuarioActivo = useAuthStore((s) => s.usuarioActivo);
    const requireLogin = useAuthStore((s) => s.requireLogin);

    const role = useMemo(() => {
        if (!requireLogin) return ROLES.DUENO;
        return normalizeRole(usuarioActivo);
    }, [usuarioActivo, requireLogin]);

    const can = useCallback(
        (permission) => canPerm(usuarioActivo, permission, { requireLogin }),
        [usuarioActivo, requireLogin],
    );

    const canAny = useCallback(
        (permissions) => canAnyPerm(usuarioActivo, permissions, { requireLogin }),
        [usuarioActivo, requireLogin],
    );

    const canAll = useCallback(
        (permissions) => canAllPerm(usuarioActivo, permissions, { requireLogin }),
        [usuarioActivo, requireLogin],
    );

    return {
        role,
        usuarioActivo,
        requireLogin,
        can,
        canAny,
        canAll,
        isOwner: !requireLogin || isOwnerRole(usuarioActivo),
        isManager: !requireLogin || isManagerRole(usuarioActivo),
        isPrivileged: !requireLogin || isPrivilegedRole(usuarioActivo),
        isCajero: Boolean(requireLogin && role === ROLES.CAJERO),
        isInventario: Boolean(requireLogin && role === ROLES.INVENTARIO),
    };
}

export default usePermissions;
