import { describe, it, expect } from 'vitest';
import {
    ROLES,
    PERMISSIONS,
    normalizeRole,
    toNubeRole,
    getRoleLabel,
    isPrivilegedRole,
    isManagerRole,
    isOwnerRole,
    can,
    canAny,
    canAll,
    defaultTabForUser,
    assignableAppRoles,
    canManageTargetUser,
} from '../src/security/permissions';

describe('RBAC permissions engine', () => {
    describe('normalizeRole & legacy backwards compatibility', () => {
        it('maps legacy ADMIN to DUENO', () => {
            expect(normalizeRole('ADMIN')).toBe(ROLES.DUENO);
            expect(normalizeRole({ rol: 'ADMIN' })).toBe(ROLES.DUENO);
            expect(normalizeRole('dueno')).toBe(ROLES.DUENO);
            expect(normalizeRole('DUENO')).toBe(ROLES.DUENO);
        });

        it('maps Nube administrador to ENCARGADO (separate from DUENO)', () => {
            expect(normalizeRole('administrador')).toBe(ROLES.ENCARGADO);
            expect(normalizeRole('ENCARGADO')).toBe(ROLES.ENCARGADO);
        });

        it('maps inventario and cajero correctly', () => {
            expect(normalizeRole('inventario')).toBe(ROLES.INVENTARIO);
            expect(normalizeRole('INVENTARIO')).toBe(ROLES.INVENTARIO);
            expect(normalizeRole('CAJERO')).toBe(ROLES.CAJERO);
            expect(normalizeRole('cajero')).toBe(ROLES.CAJERO);
        });

        it('returns null for unknown or missing roles', () => {
            expect(normalizeRole(null)).toBeNull();
            expect(normalizeRole(undefined)).toBeNull();
            expect(normalizeRole('unknown')).toBeNull();
        });

        it('converts app roles to Nube SQL roles', () => {
            expect(toNubeRole('DUENO')).toBe('dueno');
            expect(toNubeRole('ADMIN')).toBe('dueno');
            expect(toNubeRole('ENCARGADO')).toBe('administrador');
            expect(toNubeRole('INVENTARIO')).toBe('inventario');
            expect(toNubeRole('CAJERO')).toBe('cajero');
        });
    });

    describe('role permissions matrix', () => {
        it('DUENO has all permissions', () => {
            for (const perm of Object.values(PERMISSIONS)) {
                expect(can({ rol: 'DUENO' }, perm)).toBe(true);
                expect(can({ rol: 'ADMIN' }, perm)).toBe(true);
            }
        });

        it('ENCARGADO can operate store & staff, but not payroll, profit or critical settings', () => {
            const encargado = { rol: 'ENCARGADO' };
            expect(can(encargado, PERMISSIONS.SALES_VOID)).toBe(true);
            expect(can(encargado, PERMISSIONS.CASH_MANAGE)).toBe(true);
            expect(can(encargado, PERMISSIONS.PRODUCTS_EDIT)).toBe(true);
            expect(can(encargado, PERMISSIONS.USERS_MANAGE_STAFF)).toBe(true);
            expect(can(encargado, PERMISSIONS.TAB_REPORTS)).toBe(true);
            expect(can(encargado, PERMISSIONS.TAB_SETTINGS)).toBe(true);

            expect(can(encargado, PERMISSIONS.PAYROLL_MANAGE)).toBe(false);
            expect(can(encargado, PERMISSIONS.TAB_PAYROLL)).toBe(false);
            expect(can(encargado, PERMISSIONS.REPORTS_PROFIT)).toBe(false);
            expect(can(encargado, PERMISSIONS.USERS_MANAGE_ADMINS)).toBe(false);
            expect(can(encargado, PERMISSIONS.SETTINGS_CRITICAL)).toBe(false);
        });

        it('INVENTARIO can manage products, stock and suppliers, but not sales or cash', () => {
            const inv = { rol: 'INVENTARIO' };
            expect(can(inv, PERMISSIONS.TAB_PRODUCTS)).toBe(true);
            expect(can(inv, PERMISSIONS.TAB_SUPPLIERS)).toBe(true);
            expect(can(inv, PERMISSIONS.PRODUCTS_EDIT)).toBe(true);
            expect(can(inv, PERMISSIONS.INVENTORY_ADJUST)).toBe(true);

            expect(can(inv, PERMISSIONS.TAB_SALES)).toBe(false);
            expect(can(inv, PERMISSIONS.TAB_DASHBOARD)).toBe(false);
            expect(can(inv, PERMISSIONS.TAB_REPORTS)).toBe(false);
            expect(can(inv, PERMISSIONS.TAB_SETTINGS)).toBe(false);
            expect(can(inv, PERMISSIONS.SALES_CREATE)).toBe(false);
            expect(can(inv, PERMISSIONS.PRODUCTS_DELETE)).toBe(false);
            expect(can(inv, PERMISSIONS.PRODUCTS_VIEW_COST)).toBe(false);
        });

        it('CAJERO can sell, view own dashboard, read products and credit customers, but not void or edit catalog', () => {
            const cajero = { rol: 'CAJERO' };
            expect(can(cajero, PERMISSIONS.TAB_SALES)).toBe(true);
            expect(can(cajero, PERMISSIONS.TAB_DASHBOARD)).toBe(true);
            expect(can(cajero, PERMISSIONS.TAB_PRODUCTS)).toBe(true);
            expect(can(cajero, PERMISSIONS.TAB_CUSTOMERS)).toBe(true);
            expect(can(cajero, PERMISSIONS.SALES_CREATE)).toBe(true);
            expect(can(cajero, PERMISSIONS.CUSTOMERS_CREDIT)).toBe(true);

            expect(can(cajero, PERMISSIONS.TAB_REPORTS)).toBe(false);
            expect(can(cajero, PERMISSIONS.TAB_SETTINGS)).toBe(false);
            expect(can(cajero, PERMISSIONS.TAB_SUPPLIERS)).toBe(false);
            expect(can(cajero, PERMISSIONS.TAB_PAYROLL)).toBe(false);
            expect(can(cajero, PERMISSIONS.SALES_VOID)).toBe(false);
            expect(can(cajero, PERMISSIONS.PRODUCTS_EDIT)).toBe(false);
            expect(can(cajero, PERMISSIONS.CASH_MANAGE)).toBe(false);
        });

        it('grants all permissions when requireLogin is false', () => {
            expect(can(null, PERMISSIONS.SETTINGS_CRITICAL, { requireLogin: false })).toBe(true);
            expect(can({ rol: 'CAJERO' }, PERMISSIONS.PAYROLL_MANAGE, { requireLogin: false })).toBe(true);
        });

        it('supports per-user allow/deny overrides (Phase 3 ready)', () => {
            const cajeroConDescuento = { rol: 'CAJERO', permisos: { allow: [PERMISSIONS.SALES_DISCOUNT] } };
            expect(can(cajeroConDescuento, PERMISSIONS.SALES_DISCOUNT)).toBe(true);

            const encargadoSinAnular = { rol: 'ENCARGADO', permisos: { deny: [PERMISSIONS.SALES_VOID] } };
            expect(can(encargadoSinAnular, PERMISSIONS.SALES_VOID)).toBe(false);
        });

        it('canAny and canAll work properly', () => {
            expect(canAny({ rol: 'INVENTARIO' }, [PERMISSIONS.TAB_CUSTOMERS, PERMISSIONS.TAB_SUPPLIERS])).toBe(true);
            expect(canAll({ rol: 'INVENTARIO' }, [PERMISSIONS.TAB_PRODUCTS, PERMISSIONS.TAB_SUPPLIERS])).toBe(true);
            expect(canAll({ rol: 'INVENTARIO' }, [PERMISSIONS.TAB_PRODUCTS, PERMISSIONS.TAB_SALES])).toBe(false);
        });
    });

    describe('helpers and hierarchy', () => {
        it('returns appropriate default tab per role', () => {
            expect(defaultTabForUser({ rol: 'CAJERO' })).toBe('ventas');
            expect(defaultTabForUser({ rol: 'INVENTARIO' })).toBe('catalogo');
            expect(defaultTabForUser({ rol: 'ENCARGADO' })).toBe('inicio');
            expect(defaultTabForUser({ rol: 'DUENO' })).toBe('inicio');
            expect(defaultTabForUser({ rol: 'CAJERO' }, { requireLogin: false })).toBe('inicio');
        });

        it('enforces hierarchy for assignableAppRoles and canManageTargetUser', () => {
            expect(assignableAppRoles('DUENO')).toEqual([ROLES.ENCARGADO, ROLES.INVENTARIO, ROLES.CAJERO]);
            expect(assignableAppRoles('ENCARGADO')).toEqual([ROLES.INVENTARIO, ROLES.CAJERO]);
            expect(assignableAppRoles('INVENTARIO')).toEqual([]);
            expect(assignableAppRoles('CAJERO')).toEqual([]);

            expect(canManageTargetUser({ rol: 'ENCARGADO' }, { rol: 'CAJERO' })).toBe(true);
            expect(canManageTargetUser({ rol: 'ENCARGADO' }, { rol: 'INVENTARIO' })).toBe(true);
            expect(canManageTargetUser({ rol: 'ENCARGADO' }, { rol: 'ENCARGADO' })).toBe(false);
            expect(canManageTargetUser({ rol: 'ENCARGADO' }, { rol: 'DUENO' })).toBe(false);
            expect(canManageTargetUser({ rol: 'DUENO' }, { rol: 'ENCARGADO' })).toBe(true);
        });

        it('classifies privileged/manager/owner roles and labels', () => {
            expect(isOwnerRole('ADMIN')).toBe(true);
            expect(isOwnerRole('ENCARGADO')).toBe(false);
            expect(isManagerRole('ENCARGADO')).toBe(true);
            expect(isManagerRole('INVENTARIO')).toBe(false);
            expect(isPrivilegedRole('INVENTARIO')).toBe(true);
            expect(isPrivilegedRole('CAJERO')).toBe(false);
            expect(getRoleLabel('ENCARGADO')).toBe('Encargado');
            expect(getRoleLabel('administrador')).toBe('Encargado');
        });
    });
});
