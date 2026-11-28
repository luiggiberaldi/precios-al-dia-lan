/**
 * rbacConfig.js — Configuración persistente y sincronizable de RBAC y Carnets (LAN + Nube + Local).
 *
 * Guarda en `localStorage['pda_rbac_config_v1']` (sincronizado automáticamente entre cajas LAN
 * vía `businessConfigSync.js`):
 *   - `rolePermissions`: matriz personalizada por rol (`ENCARGADO`, `INVENTARIO`, `CAJERO`).
 *     El rol `DUENO` siempre conserva todos los permisos para evitar bloqueos accidentales.
 *   - `memberOverrides`: `{ [memberId]: { allow: string[], deny: string[] } }`
 *   - `memberBadges`: `{ [memberId]: { hash: string, createdAt: string } }` (solo hashes PBKDF2)
 *   - `allowQuickAuth`: boolean (permitir autorización puntual con PIN o Carnet sin cerrar sesión)
 *
 * @module security/rbacConfig
 */
import { generateBadgeCode, hashBadgeCode, verifyBadgeCode, isBadgeCode, normalizeBadgeScan } from './badgeToken';
import { notifyBusinessConfigChanged } from '../nube/businessConfigSync';

export const RBAC_CONFIG_KEY = 'pda_rbac_config_v1';
export const RBAC_UPDATED_EVENT = 'pda_rbac_updated';

const EMPTY_CONFIG = Object.freeze({
    rolePermissions: {},
    memberOverrides: {},
    memberBadges: {},
    allowQuickAuth: true,
});

function getStorage(storage) {
    if (storage) return storage;
    try {
        return typeof globalThis !== 'undefined' ? globalThis.localStorage : null;
    } catch {
        return null;
    }
}

export function readRbacConfig(storage) {
    const ls = getStorage(storage);
    if (!ls) return { ...EMPTY_CONFIG };
    try {
        const raw = ls.getItem(RBAC_CONFIG_KEY);
        if (!raw) return { ...EMPTY_CONFIG };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { ...EMPTY_CONFIG };
        return {
            rolePermissions: parsed.rolePermissions && typeof parsed.rolePermissions === 'object' ? parsed.rolePermissions : {},
            memberOverrides: parsed.memberOverrides && typeof parsed.memberOverrides === 'object' ? parsed.memberOverrides : {},
            memberBadges: parsed.memberBadges && typeof parsed.memberBadges === 'object' ? parsed.memberBadges : {},
            allowQuickAuth: parsed.allowQuickAuth !== false,
        };
    } catch {
        return { ...EMPTY_CONFIG };
    }
}

export function saveRbacConfig(config, storage) {
    const ls = getStorage(storage);
    if (!ls) return;
    try {
        ls.setItem(RBAC_CONFIG_KEY, JSON.stringify(config));
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(RBAC_UPDATED_EVENT));
        }
        notifyBusinessConfigChanged();
    } catch (e) {
        console.warn('[rbacConfig] No se pudo guardar la configuración RBAC:', e);
    }
}

/** Personaliza un permiso concreto de un rol (`ENCARGADO`, `INVENTARIO`, `CAJERO`). */
export function setRolePermission(role, permission, allowed, defaultPermissionsSet, storage) {
    if (!role || role === 'DUENO' || !permission) return;
    const cfg = readRbacConfig(storage);
    const currentList = Array.isArray(cfg.rolePermissions[role])
        ? [...cfg.rolePermissions[role]]
        : Array.from(defaultPermissionsSet || []);
    const set = new Set(currentList);
    if (allowed) set.add(permission);
    else set.delete(permission);

    saveRbacConfig({
        ...cfg,
        rolePermissions: {
            ...cfg.rolePermissions,
            [role]: [...set],
        },
    }, storage);
}

/** Restaura la matriz de permisos de todos los roles a los valores recomendados de fábrica. */
export function resetRolePermissions(storage) {
    const cfg = readRbacConfig(storage);
    saveRbacConfig({
        ...cfg,
        rolePermissions: {},
    }, storage);
}

/** Activa o desactiva la autorización puntual con PIN o Carnet en caja. */
export function setAllowQuickAuth(enabled, storage) {
    const cfg = readRbacConfig(storage);
    saveRbacConfig({
        ...cfg,
        allowQuickAuth: Boolean(enabled),
    }, storage);
}

/** Obtiene los overrides `{ allow, deny }` guardados para un miembro por ID (UUID o número). */
export function getMemberOverrides(memberId, storage) {
    if (memberId === null || memberId === undefined) return null;
    const cfg = readRbacConfig(storage);
    const entry = cfg.memberOverrides[String(memberId)];
    if (!entry || typeof entry !== 'object') return null;
    return {
        allow: Array.isArray(entry.allow) ? entry.allow : [],
        deny: Array.isArray(entry.deny) ? entry.deny : [],
    };
}

/** Guarda una excepción puntual (permitir/denegar) para un miembro específico. */
export function setMemberPermissionOverride(memberId, permission, nextAllowed, baseAllowed, storage) {
    if (memberId === null || memberId === undefined || !permission) return;
    const key = String(memberId);
    const cfg = readRbacConfig(storage);
    const prev = cfg.memberOverrides[key] || { allow: [], deny: [] };
    const allow = new Set(Array.isArray(prev.allow) ? prev.allow : []);
    const deny = new Set(Array.isArray(prev.deny) ? prev.deny : []);
    allow.delete(permission);
    deny.delete(permission);
    if (nextAllowed && !baseAllowed) allow.add(permission);
    if (!nextAllowed && baseAllowed) deny.add(permission);

    const nextOverrides = { ...cfg.memberOverrides };
    if (allow.size === 0 && deny.size === 0) {
        delete nextOverrides[key];
    } else {
        nextOverrides[key] = { allow: [...allow], deny: [...deny] };
    }
    saveRbacConfig({ ...cfg, memberOverrides: nextOverrides }, storage);
}

/** Genera (o regenera) un carnet de barras/QR para cualquier miembro (LAN/Nube o local). */
export async function generateMemberBadge(memberId, storage) {
    if (memberId === null || memberId === undefined) {
        throw new Error('ID de empleado inválido');
    }
    const key = String(memberId);
    const code = generateBadgeCode();
    const hash = await hashBadgeCode(code);
    const createdAt = new Date().toISOString();
    const cfg = readRbacConfig(storage);
    saveRbacConfig({
        ...cfg,
        memberBadges: {
            ...cfg.memberBadges,
            [key]: { hash, createdAt },
        },
    }, storage);
    return { code, hash, createdAt };
}

/** Revoca el carnet de un miembro (queda inválido al instante en todas las cajas). */
export function revokeMemberBadge(memberId, storage) {
    if (memberId === null || memberId === undefined) return;
    const key = String(memberId);
    const cfg = readRbacConfig(storage);
    if (!cfg.memberBadges[key]) return;
    const nextBadges = { ...cfg.memberBadges };
    delete nextBadges[key];
    saveRbacConfig({ ...cfg, memberBadges: nextBadges }, storage);
}

/** ¿Este miembro tiene un carnet activo guardado? */
export function hasMemberBadge(memberId, storage) {
    if (memberId === null || memberId === undefined) return false;
    const cfg = readRbacConfig(storage);
    return Boolean(cfg.memberBadges[String(memberId)]?.hash);
}

/** Busca qué miembro (ID string) corresponde a un carnet escaneado (`PDA-...`). */
export async function findMemberIdByBadge(scannedCode, storage) {
    const normalized = normalizeBadgeScan(scannedCode);
    if (!isBadgeCode(normalized)) return null;
    const cfg = readRbacConfig(storage);
    const entries = Object.entries(cfg.memberBadges || {});
    for (const [memberId, info] of entries) {
        if (!info?.hash) continue;
        if (await verifyBadgeCode(normalized, info.hash)) {
            return memberId;
        }
    }
    return null;
}
