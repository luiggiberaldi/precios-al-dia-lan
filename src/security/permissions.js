/**
 * permissions.js — Motor central de RBAC (Role-Based Access Control) basado en permisos atómicos.
 *
 * Principio rector:
 *   La UI y los servicios preguntan "¿puede hacer X?" (`can(user, 'sales.void')`)
 *   en lugar de comparar cadenas de rol dispersas (`rol === 'ADMIN'`).
 *
 * Retrocompatibilidad:
 *   - `'ADMIN'` heredado (cajas locales/offline) se normaliza a `ROLES.DUENO`
 *     para que ningún negocio existente pierda acceso al actualizar.
 *   - `'administrador'` de Nube se normaliza a `ROLES.ENCARGADO` (diferenciado de `DUENO`).
 *   - Cuando `requireLogin === false`, `can()` devuelve `true` (modo caja abierta).
 *
 * @module security/permissions
 */

import { readRbacConfig } from './rbacConfig';

export const ROLES = Object.freeze({
    DUENO: 'DUENO',
    ENCARGADO: 'ENCARGADO',
    INVENTARIO: 'INVENTARIO',
    CAJERO: 'CAJERO',
});

export const ALL_ROLES = Object.freeze([
    ROLES.DUENO,
    ROLES.ENCARGADO,
    ROLES.INVENTARIO,
    ROLES.CAJERO,
]);

/** Etiquetas y descripciones cortas para mostrar en la UI de equipo. */
export const ROLE_META = Object.freeze({
    [ROLES.DUENO]: Object.freeze({
        label: 'Dueño',
        shortLabel: 'Dueño',
        nubeRole: 'dueno',
        description: 'Control total: finanzas, nómina, encargados, licencias y ajustes críticos.',
        rank: 40,
    }),
    [ROLES.ENCARGADO]: Object.freeze({
        label: 'Encargado',
        shortLabel: 'Encargado',
        nubeRole: 'administrador',
        description: 'Operación diaria: ventas, anulaciones, caja, inventario, compras y cajeros.',
        rank: 30,
    }),
    [ROLES.INVENTARIO]: Object.freeze({
        label: 'Inventario',
        shortLabel: 'Inventario',
        nubeRole: 'inventario',
        description: 'Catálogo, precios, ajustes de stock, compras y proveedores. Sin acceso a caja.',
        rank: 20,
    }),
    [ROLES.CAJERO]: Object.freeze({
        label: 'Cajero',
        shortLabel: 'Cajero',
        nubeRole: 'cajero',
        description: 'Vender, ver su propio turno, consultar productos y cobrar/fiar a clientes.',
        rank: 10,
    }),
});

/** Catálogo completo de permisos atómicos del sistema. */
export const PERMISSIONS = Object.freeze({
    // Navegación principal (pestañas)
    TAB_DASHBOARD: 'tab.dashboard',
    TAB_SALES: 'tab.sales',
    TAB_PRODUCTS: 'tab.products',
    TAB_CUSTOMERS: 'tab.customers',
    TAB_SUPPLIERS: 'tab.suppliers',
    TAB_PAYROLL: 'tab.payroll',
    TAB_REPORTS: 'tab.reports',
    TAB_SETTINGS: 'tab.settings',

    // Ventas y Caja
    SALES_CREATE: 'sales.create',
    SALES_VOID: 'sales.void',
    SALES_DISCOUNT: 'sales.discount',
    SALES_VIEW_ALL_CAJAS: 'sales.view_all_cajas',
    CASH_MANAGE: 'cash.manage',
    RATES_ADJUST: 'rates.adjust',

    // Inventario y Productos
    PRODUCTS_EDIT: 'products.edit',
    PRODUCTS_DELETE: 'products.delete',
    PRODUCTS_VIEW_COST: 'products.view_cost',
    INVENTORY_ADJUST: 'inventory.adjust',

    // Clientes / Fiado
    CUSTOMERS_CREDIT: 'customers.credit',
    CUSTOMERS_DELETE: 'customers.delete',

    // Finanzas, Nómina y Equipo
    REPORTS_PROFIT: 'reports.profit',
    PAYROLL_MANAGE: 'payroll.manage',
    USERS_MANAGE_STAFF: 'users.manage_staff',
    USERS_MANAGE_ADMINS: 'users.manage_admins',
    SETTINGS_CRITICAL: 'settings.critical',
});

const ALL_PERMISSION_VALUES = Object.freeze(Object.values(PERMISSIONS));

/** Mapa oficial de permisos por rol normalizado. */
export const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.DUENO]: Object.freeze(new Set(ALL_PERMISSION_VALUES)),

    [ROLES.ENCARGADO]: Object.freeze(new Set([
        PERMISSIONS.TAB_DASHBOARD,
        PERMISSIONS.TAB_SALES,
        PERMISSIONS.TAB_PRODUCTS,
        PERMISSIONS.TAB_CUSTOMERS,
        PERMISSIONS.TAB_SUPPLIERS,
        PERMISSIONS.TAB_REPORTS,
        PERMISSIONS.TAB_SETTINGS,
        PERMISSIONS.SALES_CREATE,
        PERMISSIONS.SALES_VOID,
        PERMISSIONS.SALES_DISCOUNT,
        PERMISSIONS.SALES_VIEW_ALL_CAJAS,
        PERMISSIONS.CASH_MANAGE,
        PERMISSIONS.RATES_ADJUST,
        PERMISSIONS.PRODUCTS_EDIT,
        PERMISSIONS.PRODUCTS_DELETE,
        PERMISSIONS.PRODUCTS_VIEW_COST,
        PERMISSIONS.INVENTORY_ADJUST,
        PERMISSIONS.CUSTOMERS_CREDIT,
        PERMISSIONS.CUSTOMERS_DELETE,
        PERMISSIONS.USERS_MANAGE_STAFF,
    ])),

    [ROLES.INVENTARIO]: Object.freeze(new Set([
        PERMISSIONS.TAB_PRODUCTS,
        PERMISSIONS.TAB_SUPPLIERS,
        PERMISSIONS.PRODUCTS_EDIT,
        PERMISSIONS.INVENTORY_ADJUST,
    ])),

    [ROLES.CAJERO]: Object.freeze(new Set([
        PERMISSIONS.TAB_DASHBOARD,
        PERMISSIONS.TAB_SALES,
        PERMISSIONS.TAB_PRODUCTS,
        PERMISSIONS.TAB_CUSTOMERS,
        PERMISSIONS.SALES_CREATE,
        PERMISSIONS.CUSTOMERS_CREDIT,
    ])),
});

/** Mapeo de pestaña de navegación principal → permiso(s) que habilitan abrirla. */
export const TAB_PERMISSIONS = Object.freeze({
    inicio: [PERMISSIONS.TAB_DASHBOARD],
    ventas: [PERMISSIONS.TAB_SALES],
    catalogo: [PERMISSIONS.TAB_PRODUCTS],
    // Gestión agrupa Clientes, Proveedores y Nómina: basta poder ver al menos una sub-pestaña.
    clientes: [PERMISSIONS.TAB_CUSTOMERS, PERMISSIONS.TAB_SUPPLIERS, PERMISSIONS.TAB_PAYROLL],
    reportes: [PERMISSIONS.TAB_REPORTS],
    ajustes: [PERMISSIONS.TAB_SETTINGS],
});

const ROLE_ALIASES = Object.freeze({
    dueno: ROLES.DUENO,
    dueño: ROLES.DUENO,
    owner: ROLES.DUENO,
    admin: ROLES.DUENO, // Retrocompatibilidad: ADMIN local heredado = control total.
    encargado: ROLES.ENCARGADO,
    administrador: ROLES.ENCARGADO,
    inventario: ROLES.INVENTARIO,
    almacen: ROLES.INVENTARIO,
    almacén: ROLES.INVENTARIO,
    cajero: ROLES.CAJERO,
});

/**
 * Normaliza cualquier representación de rol (local, heredado o Nube) a un rol RBAC estándar.
 * Devuelve `null` si el valor no corresponde a un rol conocido.
 *
 * @param {string|object|null|undefined} roleOrUser
 * @returns {'DUENO'|'ENCARGADO'|'INVENTARIO'|'CAJERO'|null}
 */
export function normalizeRole(roleOrUser) {
    const raw = typeof roleOrUser === 'object' && roleOrUser !== null
        ? (roleOrUser.rol ?? roleOrUser.role)
        : roleOrUser;
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return ROLE_ALIASES[key] ?? null;
}

/**
 * Convierte un rol de la app (o heredado) al nombre de rol usado en Supabase Nube.
 * @param {string|object|null|undefined} roleOrUser
 * @returns {'dueno'|'administrador'|'inventario'|'cajero'}
 */
export function toNubeRole(roleOrUser) {
    const role = normalizeRole(roleOrUser);
    return ROLE_META[role]?.nubeRole || 'cajero';
}

/** Etiqueta legible en español para cualquier rol (local, heredado o Nube). */
export function getRoleLabel(roleOrUser) {
    const role = normalizeRole(roleOrUser);
    return ROLE_META[role]?.label || 'Empleado';
}

/** Descripción corta del rol para UI de equipo. */
export function getRoleDescription(roleOrUser) {
    const role = normalizeRole(roleOrUser);
    return ROLE_META[role]?.description || '';
}

/**
 * ¿El rol tiene privilegios administrativos/sensibles?
 * (Requiere PIN obligatorio con login activo y política estricta).
 */
export function isPrivilegedRole(roleOrUser) {
    const role = normalizeRole(roleOrUser);
    return role === ROLES.DUENO || role === ROLES.ENCARGADO || role === ROLES.INVENTARIO;
}

/** ¿Es un rol de dueño o encargado (gestión operativa)? */
export function isManagerRole(roleOrUser) {
    const role = normalizeRole(roleOrUser);
    return role === ROLES.DUENO || role === ROLES.ENCARGADO;
}

/** ¿Es exactamente el rol de Dueño (o ADMIN local heredado)? */
export function isOwnerRole(roleOrUser) {
    return normalizeRole(roleOrUser) === ROLES.DUENO;
}

/**
 * Evalúa si un usuario (o rol) tiene un permiso específico.
 *
 * Soporta desde el inicio overrides opcionales en `user.permisos`:
 *   `{ allow?: string[], deny?: string[] }` (preparado para Fase 3).
 *
 * @param {object|string|null|undefined} userOrRole
 * @param {string} permission
 * @param {{ requireLogin?: boolean }} [options]
 * @returns {boolean}
 */
export function can(userOrRole, permission, { requireLogin = true } = {}) {
    if (!requireLogin) return true;
    if (!permission) return false;

    const role = normalizeRole(userOrRole);
    if (!role) return false;
    if (role === ROLES.DUENO) return true;

    const cfg = readRbacConfig();
    const userId = typeof userOrRole === 'object' && userOrRole !== null ? (userOrRole.id ?? userOrRole.memberId) : null;
    const storedOverrides = userId !== null && userId !== undefined ? cfg.memberOverrides?.[String(userId)] : null;
    const inlineOverrides = typeof userOrRole === 'object' && userOrRole !== null ? userOrRole.permisos : null;

    // 1) Overrides inline o persistidos en rbacConfig (deny tiene precedencia)
    for (const ov of [inlineOverrides, storedOverrides]) {
        if (ov && Array.isArray(ov.deny) && ov.deny.includes(permission)) return false;
    }
    for (const ov of [inlineOverrides, storedOverrides]) {
        if (ov && Array.isArray(ov.allow) && ov.allow.includes(permission)) return true;
    }

    // 2) Matriz personalizada por rol (si el dueño la editó en Ajustes → Usuarios)
    const customRolePerms = cfg.rolePermissions?.[role];
    if (Array.isArray(customRolePerms)) {
        return customRolePerms.includes(permission);
    }

    // 3) Matriz recomendada por defecto
    const base = ROLE_PERMISSIONS[role];
    return Boolean(base && base.has(permission));
}

/** Catálogo agrupado en español para el editor 100% configurable de RBAC en Ajustes. */
export const PERMISSION_GROUPS = Object.freeze([
    {
        id: 'tabs',
        title: 'Pantallas visibles',
        items: [
            { key: PERMISSIONS.TAB_DASHBOARD, label: 'Inicio / Resumen', description: 'Ver pantalla de inicio y resumen del turno.' },
            { key: PERMISSIONS.TAB_SALES, label: 'Vender (Caja)', description: 'Acceder al punto de venta para cobrar.' },
            { key: PERMISSIONS.TAB_PRODUCTS, label: 'Inventario / Productos', description: 'Ver el catálogo de productos.' },
            { key: PERMISSIONS.TAB_CUSTOMERS, label: 'Gestión: Clientes', description: 'Ver y gestionar clientes y fiados.' },
            { key: PERMISSIONS.TAB_SUPPLIERS, label: 'Gestión: Proveedores', description: 'Ver proveedores y facturas de compra.' },
            { key: PERMISSIONS.TAB_PAYROLL, label: 'Gestión: Nómina', description: 'Ver y gestionar pagos de empleados.' },
            { key: PERMISSIONS.TAB_REPORTS, label: 'Reportes', description: 'Acceder a reportes e historial general.' },
            { key: PERMISSIONS.TAB_SETTINGS, label: 'Ajustes', description: 'Acceder a la pantalla de configuración.' },
        ],
    },
    {
        id: 'sales',
        title: 'Ventas y Caja',
        items: [
            { key: PERMISSIONS.SALES_CREATE, label: 'Cobrar ventas', description: 'Registrar ventas en caja.' },
            { key: PERMISSIONS.SALES_VOID, label: 'Anular ventas', description: 'Anular tickets sin pedir PIN o carnet.' },
            { key: PERMISSIONS.SALES_DISCOUNT, label: 'Aplicar descuentos', description: 'Dar rebajas al cobrar.' },
            { key: PERMISSIONS.SALES_VIEW_ALL_CAJAS, label: 'Ver ventas de todas las cajas', description: 'Consultar historial consolidado.' },
            { key: PERMISSIONS.CASH_MANAGE, label: 'Abrir / cerrar caja y aportes', description: 'Apertura, arqueo, gastos internos y cierre.' },
            { key: PERMISSIONS.RATES_ADJUST, label: 'Ajustar tasa manual', description: 'Cambiar la tasa de cambio en caja.' },
        ],
    },
    {
        id: 'inventory',
        title: 'Inventario y Catálogo',
        items: [
            { key: PERMISSIONS.PRODUCTS_EDIT, label: 'Crear / editar productos y precios', description: 'Modificar catálogo y precios de venta.' },
            { key: PERMISSIONS.PRODUCTS_DELETE, label: 'Eliminar productos', description: 'Borrar productos del catálogo.' },
            { key: PERMISSIONS.PRODUCTS_VIEW_COST, label: 'Ver costos y valoración', description: 'Ver precios de costo y márgenes.' },
            { key: PERMISSIONS.INVENTORY_ADJUST, label: 'Ajustar stock y compras', description: 'Entradas, salidas y compras por lote.' },
        ],
    },
    {
        id: 'admin',
        title: 'Clientes, Equipo y Finanzas',
        items: [
            { key: PERMISSIONS.CUSTOMERS_CREDIT, label: 'Vender fiado / cobrar abonos', description: 'Registrar créditos y abonos de clientes.' },
            { key: PERMISSIONS.CUSTOMERS_DELETE, label: 'Eliminar / fusionar clientes', description: 'Borrar clientes o reiniciar saldos.' },
            { key: PERMISSIONS.REPORTS_PROFIT, label: 'Ver utilidades y ganancias', description: 'Ver márgenes y ganancia neta en reportes.' },
            { key: PERMISSIONS.PAYROLL_MANAGE, label: 'Gestionar nómina', description: 'Crear/editar pagos y vales de personal.' },
            { key: PERMISSIONS.USERS_MANAGE_STAFF, label: 'Gestionar cajeros e inventario', description: 'Crear o editar personal operativo.' },
            { key: PERMISSIONS.USERS_MANAGE_ADMINS, label: 'Gestionar encargados', description: 'Crear o editar encargados.' },
            { key: PERMISSIONS.SETTINGS_CRITICAL, label: 'Ajustes críticos', description: 'Respaldos, licencia y reinicio de cuenta.' },
        ],
    },
]);

/** Devuelve `true` si el usuario tiene AL MENOS UNO de los permisos listados. */
export function canAny(userOrRole, permissions, options) {
    if (!Array.isArray(permissions) || permissions.length === 0) return false;
    return permissions.some((p) => can(userOrRole, p, options));
}

/** Devuelve `true` si el usuario tiene TODOS los permisos listados. */
export function canAll(userOrRole, permissions, options) {
    if (!Array.isArray(permissions) || permissions.length === 0) return false;
    return permissions.every((p) => can(userOrRole, p, options));
}

/**
 * Pestaña inicial recomendada al iniciar sesión según el rol.
 * - CAJERO → 'ventas'
 * - INVENTARIO → 'catalogo'
 * - DUENO / ENCARGADO → 'inicio'
 */
export function defaultTabForUser(userOrRole, { requireLogin = true } = {}) {
    if (!requireLogin) return 'inicio';
    const role = normalizeRole(userOrRole);
    if (role === ROLES.CAJERO) return 'ventas';
    if (role === ROLES.INVENTARIO) return 'catalogo';
    return 'inicio';
}

/**
 * Roles que `actorRole` puede crear/asignar a otros miembros.
 * - DUENO → ENCARGADO, INVENTARIO, CAJERO (y en modo local puede crear otro DUENO si es necesario)
 * - ENCARGADO → INVENTARIO, CAJERO
 * - Otros → []
 */
export function assignableAppRoles(actorRole, { allowOwnerCreation = false } = {}) {
    const role = normalizeRole(actorRole);
    if (role === ROLES.DUENO) {
        return allowOwnerCreation
            ? [ROLES.DUENO, ROLES.ENCARGADO, ROLES.INVENTARIO, ROLES.CAJERO]
            : [ROLES.ENCARGADO, ROLES.INVENTARIO, ROLES.CAJERO];
    }
    if (role === ROLES.ENCARGADO) {
        return [ROLES.INVENTARIO, ROLES.CAJERO];
    }
    return [];
}

/**
 * Interruptores simples de permisos extra (Fase 3) configurables por empleado.
 * Lista deliberadamente corta (5 opciones) para no abrumar al dueño del negocio.
 */
export const OVERRIDABLE_PERMISSIONS = Object.freeze([
    Object.freeze({
        key: PERMISSIONS.SALES_DISCOUNT,
        label: 'Aplicar descuentos',
        description: 'Puede dar rebajas al momento de cobrar.',
    }),
    Object.freeze({
        key: PERMISSIONS.CUSTOMERS_CREDIT,
        label: 'Vender fiado / abonos',
        description: 'Puede registrar ventas a crédito y cobrar abonos.',
    }),
    Object.freeze({
        key: PERMISSIONS.PRODUCTS_VIEW_COST,
        label: 'Ver costos y valoración',
        description: 'Puede ver precios de costo y valoración del inventario.',
    }),
    Object.freeze({
        key: PERMISSIONS.SALES_VOID,
        label: 'Anular ventas',
        description: 'Puede anular tickets sin pedir PIN de encargado.',
    }),
    Object.freeze({
        key: PERMISSIONS.CASH_MANAGE,
        label: 'Abrir / cerrar caja',
        description: 'Puede hacer apertura, arqueo, aportes y cierre de caja.',
    }),
]);

/** ¿Puede `actor` editar/eliminar al usuario `target`? */
export function canManageTargetUser(actor, target, { requireLogin = true } = {}) {
    if (!requireLogin) return true;
    if (!actor || !target) return false;
    const actorRole = normalizeRole(actor);
    const targetRole = normalizeRole(target);
    if (!actorRole || !targetRole) return false;
    if (actorRole === ROLES.DUENO) return true;
    if (actorRole === ROLES.ENCARGADO) {
        return targetRole === ROLES.CAJERO || targetRole === ROLES.INVENTARIO;
    }
    return false;
}
