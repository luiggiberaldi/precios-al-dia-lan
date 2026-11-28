/**
 * usePermissions.js — Hook reactivo de permisos RBAC conectado a useAuthStore.
 *
 * Uso:
 *   const { role, can, canAny, isOwner, isManager } = usePermissions();
 *   if (can(PERMISSIONS.SALES_VOID)) { ... }
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { RBAC_UPDATED_EVENT } from '../security/rbacConfig';
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
    const [rbacRev, setRbacRev] = useState(0);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const bump = () => setRbacRev((v) => v + 1);
        window.addEventListener(RBAC_UPDATED_EVENT, bump);
        window.addEventListener('app_storage_update', bump);
        return () => {
            window.removeEventListener(RBAC_UPDATED_EVENT, bump);
            window.removeEventListener('app_storage_update', bump);
        };
    }, []);

    const role = useMemo(() => {
        if (!requireLogin) return ROLES.DUENO;
        return normalizeRole(usuarioActivo);
    }, [usuarioActivo, requireLogin]);

    const can = useCallback(
        (permission) => {
            void rbacRev;
            return canPerm(usuarioActivo, permission, { requireLogin });
        },
        [usuarioActivo, requireLogin, rbacRev],
    );

    const canAny = useCallback(
        (permissions) => {
            void rbacRev;
            return canAnyPerm(usuarioActivo, permissions, { requireLogin });
        },
        [usuarioActivo, requireLogin, rbacRev],
    );

    const canAll = useCallback(
        (permissions) => {
            void rbacRev;
            return canAllPerm(usuarioActivo, permissions, { requireLogin });
        },
        [usuarioActivo, requireLogin, rbacRev],
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
