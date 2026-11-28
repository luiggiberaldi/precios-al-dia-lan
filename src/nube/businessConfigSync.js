/**
 * Configuración compartida del negocio (T19 · ALT-12 / ALT-13).
 *
 * Sincroniza IVA (`tax_config_v1`), `allow_negative_stock`, datos del comercio
 * (`business_name`, `business_rif`, `business_phone`, `business_address`, `business_instagram`,
 * `business_logo`), políticas de Cashea, avances de efectivo, redondeo y valoración de
 * mercancía de nómina como un objeto JSONB plano en `settings/pdn_business_config_v1`.
 *
 * Al guardarse como objeto plano (no envuelto en `{ value }`), el merge 3-way de
 * `push_records_v2` fusiona campo a campo: si Caja A activa el IVA y Caja B cambia el
 * nombre del negocio al mismo tiempo, ambos cambios se preservan.
 */
import { stableStringify } from './recordSync';

export const BUSINESS_CONFIG_KEY = 'pdn_business_config_v1';
const MAX_SYNC_LOGO_CHARS = 85_000;

export const SYNCED_BUSINESS_LS_KEYS = Object.freeze([
    'tax_config_v1',
    'allow_negative_stock',
    'business_name',
    'business_rif',
    'business_phone',
    'business_address',
    'business_instagram',
    'business_logo',
    'cashea_enabled',
    'cashea_min_amount',
    'allow_cash_advance',
    'cash_advance_default_pct',
    'checkout_smallest_usd_bill',
    'checkout_bs_round_step',
    'checkout_bs_round_mode',
    'payroll_goods_valuation',
    'receipt_currency_mode',
    'label_currency_mode',
    'granel_unit_mode',
    'admin_auto_lock_minutes',
    'cash_drawer_mode',
    'pda_rbac_config_v1',
]);

export function readBusinessConfigSnapshot(storage = globalThis.localStorage) {
    if (!storage) return {};
    const out = {};
    for (const key of SYNCED_BUSINESS_LS_KEYS) {
        let raw = null;
        try { raw = storage.getItem(key); } catch { raw = null; }
        if (raw === null || raw === undefined) continue;
        if (key === 'business_logo') {
            if (typeof raw === 'string' && raw.length <= MAX_SYNC_LOGO_CHARS) out[key] = raw;
            continue;
        }
        if (key === 'tax_config_v1') {
            try {
                out[key] = JSON.parse(raw);
            } catch {
                // Ignorar JSON corrupto
            }
            continue;
        }
        out[key] = raw;
    }
    return out;
}

let applyingRemoteDepth = 0;
let link = null;

function defaultDispatch(key) {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('app_storage_update', { detail: { key, source: 'remote' } }));
        if (key === 'business_logo') {
            window.dispatchEvent(new Event('brand-logo-changed'));
        }
        if (key === 'granel_unit_mode') {
            window.dispatchEvent(new CustomEvent('granel_unit_mode_changed', {
                detail: globalThis.localStorage?.getItem('granel_unit_mode') || undefined,
            }));
        }
    }
}

export function applyBusinessConfigSnapshot(snap, { storage = globalThis.localStorage, dispatch = defaultDispatch } = {}) {
    if (!snap || typeof snap !== 'object' || !storage) return [];
    applyingRemoteDepth += 1;
    if (link?.timer) {
        clearTimeout(link.timer);
        link.timer = null;
    }
    try {
        const changed = [];
        for (const key of SYNCED_BUSINESS_LS_KEYS) {
            if (!(key in snap)) continue;
            const val = snap[key];
            if (val === null || val === undefined || val === '') {
                if (key === 'business_logo' && storage.getItem(key) !== null) {
                    storage.removeItem(key);
                    changed.push(key);
                } else if (key !== 'business_logo' && val === '' && storage.getItem(key) !== '') {
                    storage.setItem(key, '');
                    changed.push(key);
                }
                continue;
            }
            const serialized = key === 'tax_config_v1' && typeof val === 'object'
                ? JSON.stringify(val)
                : String(val);
            if (storage.getItem(key) === serialized) continue;
            try {
                storage.setItem(key, serialized);
                changed.push(key);
            } catch {
                /* cuota localStorage llena */
            }
        }
        for (const k of changed) dispatch(k);
        return changed;
    } finally {
        applyingRemoteDepth = Math.max(0, applyingRemoteDepth - 1);
    }
}

export function setNubeBusinessConfigLink(deps) {
    if (link?.timer) clearTimeout(link.timer);
    link = deps ? { ...deps, ready: false, timer: null } : null;
}

export async function markNubeBusinessConfigReady(storage = globalThis.localStorage) {
    const current = link;
    if (!current || current.ready) return;
    current.ready = true;
    const cloud = await current.readCloud?.();
    if (cloud && typeof cloud === 'object' && Object.keys(cloud).length > 0) {
        applyBusinessConfigSnapshot(cloud, { storage });
        return;
    }
    if (!current.canEdit?.()) return;
    const local = readBusinessConfigSnapshot(storage);
    if (Object.keys(local).length > 0) {
        await current.writeCloud?.(local);
    }
}

export function notifyBusinessConfigChanged(storage = globalThis.localStorage) {
    if (applyingRemoteDepth > 0 || !link || !link.ready || !link.canEdit?.()) return;
    const current = link;
    clearTimeout(current.timer);
    current.timer = setTimeout(async () => {
        if (link !== current || !current.ready || !current.canEdit?.()) return;
        const local = readBusinessConfigSnapshot(storage);
        const cloud = await current.readCloud?.();
        const merged = { ...(cloud && typeof cloud === 'object' ? cloud : {}), ...local };
        if (stableStringify(merged) === stableStringify(cloud)) return;
        await current.writeCloud?.(merged);
    }, 150);
}
