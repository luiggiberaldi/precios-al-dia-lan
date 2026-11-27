/**
 * Tasa única por cuenta (Precios al Día Nube).
 *
 * En Bodega la tasa (modo BCV/euro/USDT/manual, tasa manual y peso colombiano) vive en
 * el localStorage de cada equipo. En la nube debe ser UNA para todas las cajas: viaja
 * como un registro de `settings` (`pdn_rate_v1`) por el sincronizador de registros
 * (envuelto en `{ value: snap }`).
 *
 *   · Al cambiarla el dueño o un administrador, se guarda el resumen en storageService y
 *     el sincronizador la sube (el servidor no deja a un cajero cambiar `settings`).
 *   · También incluye `autoRates` (BCV/Euro/USDT descargados por la caja con internet)
 *     para que cajas LAN sin acceso a internet apliquen exactamente las mismas tasas.
 *   · Al bajar el registro, se escribe en las claves de siempre y se avisa con
 *     `app_storage_update`, que RateContext y useRates ya escuchan.
 *   · Antes de la primera bajada no se publica nada: el valor de un equipo que estuvo
 *     apagado no debe pisar la tasa que pusieron en otra caja.
 */
import { stableStringify } from './recordSync';

export const RATE_KEY = 'pdn_rate_v1';
const MONITOR_RATES_KEY = 'monitor_rates_v12';
const MODES = ['bcv', 'euro', 'usdt', 'manual'];

/**
 * Desenvuelve el `data` almacenado en `account_records(collection='settings', id='pdn_rate_v1')`.
 * Retrocompatible: `recordSync` guarda `{ value: snap }`, versiones previas del Supervisor
 * escribían `snap` plano.
 */
export function unwrapRateRecord(data) {
    if (!data || typeof data !== 'object') return {};
    if (data.value && typeof data.value === 'object') return data.value;
    return data;
}

/** Envuelve un snapshot de tasa con el formato canónico `{ value: snap }` que exige recordSync. */
export function wrapRateRecord(snap) {
    return { value: snap && typeof snap === 'object' ? snap : {} };
}

function readAutoRates(storage) {
    try {
        const raw = storage?.getItem(MONITOR_RATES_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const bcv = Number(parsed?.bcv?.price);
        if (!Number.isFinite(bcv) || bcv <= 0) return null;
        const euro = Number(parsed?.euro?.price);
        const usdt = Number(parsed?.usdt?.price);
        const autoCop = Number(parsed?.autoCopRate?.price);
        const updatedAt = parsed?.lastUpdate ? new Date(parsed.lastUpdate).toISOString() : null;
        return {
            bcv,
            ...(Number.isFinite(euro) && euro > 0 ? { euro } : {}),
            ...(Number.isFinite(usdt) && usdt > 0 ? { usdt } : {}),
            ...(Number.isFinite(autoCop) && autoCop > 0 ? { autoCop } : {}),
            ...(updatedAt && updatedAt !== 'Invalid Date' ? { updatedAt } : {}),
        };
    } catch {
        return null;
    }
}

/** Lo que define la tasa en este equipo (de las claves heredadas). */
export function readRateSnapshot(storage = globalThis.localStorage) {
    const get = (k) => storage?.getItem(k) ?? null;
    const mode = get('bodega_rate_mode');
    const custom = get('bodega_custom_rate');
    const autoRates = readAutoRates(storage);
    return {
        rateMode: MODES.includes(mode) ? mode : (get('bodega_use_auto_rate') === 'false' ? 'manual' : 'bcv'),
        customRate: custom && parseFloat(custom) > 0 ? String(custom) : '',
        copEnabled: get('cop_enabled') === 'true',
        autoCopEnabled: get('auto_cop_enabled') === 'true',
        tasaCop: get('tasa_cop') || '',
        copPrimary: get('cop_primary') === 'true',
        ...(autoRates ? { autoRates } : {}),
    };
}

let applyingRemoteDepth = 0;

/** Escribe la tasa de la cuenta en las claves heredadas y avisa a la app. Devuelve las claves cambiadas. */
export function applyRateSnapshot(rawSnap, { storage = globalThis.localStorage, dispatch = defaultDispatch } = {}) {
    const snap = unwrapRateRecord(rawSnap);
    if (!snap || typeof snap !== 'object' || !MODES.includes(snap.rateMode)) return [];

    applyingRemoteDepth += 1;
    if (link?.timer) {
        clearTimeout(link.timer);
        link.timer = null;
    }
    try {
        const next = {
            bodega_rate_mode: snap.rateMode,
            bodega_use_auto_rate: String(snap.rateMode !== 'manual'),
            cop_enabled: String(Boolean(snap.copEnabled)),
            auto_cop_enabled: String(Boolean(snap.autoCopEnabled)),
            cop_primary: String(Boolean(snap.copPrimary)),
        };
        const changed = [];
        for (const [k, v] of Object.entries(next)) {
            if (storage.getItem(k) === v) continue;
            storage.setItem(k, v);
            changed.push(k);
        }

        // MED-05: si customRate o tasaCop llegan vacíos, eliminar residuos previos en localStorage
        // para que no se re-publiquen en eco.
        if (snap.customRate && parseFloat(snap.customRate) > 0) {
            const val = String(snap.customRate);
            if (storage.getItem('bodega_custom_rate') !== val) {
                storage.setItem('bodega_custom_rate', val);
                changed.push('bodega_custom_rate');
            }
        } else if (storage.getItem('bodega_custom_rate') !== null) {
            storage.removeItem('bodega_custom_rate');
            changed.push('bodega_custom_rate');
        }

        if (snap.tasaCop) {
            const val = String(snap.tasaCop);
            if (storage.getItem('tasa_cop') !== val) {
                storage.setItem('tasa_cop', val);
                changed.push('tasa_cop');
            }
        } else if (storage.getItem('tasa_cop') !== null) {
            storage.removeItem('tasa_cop');
            changed.push('tasa_cop');
        }

        // A6: aplicar tasas automáticas (BCV/Euro/USDT) sincronizadas desde la caja con internet.
        const ar = snap.autoRates;
        if (ar && Number(ar.bcv) > 0) {
            let currentRates = {};
            try {
                const raw = storage.getItem(MONITOR_RATES_KEY);
                if (raw) currentRates = JSON.parse(raw) || {};
            } catch {
                currentRates = {};
            }
            const nextRates = {
                ...currentRates,
                bcv: { ...(currentRates.bcv || {}), price: Number(ar.bcv), source: currentRates.bcv?.source || 'Sincronizada (LAN/Nube)', change: currentRates.bcv?.change ?? 0 },
                ...(Number(ar.euro) > 0 ? { euro: { ...(currentRates.euro || {}), price: Number(ar.euro), source: currentRates.euro?.source || 'Sincronizada (LAN/Nube)', change: currentRates.euro?.change ?? 0 } } : {}),
                ...(Number(ar.usdt) > 0 ? { usdt: { ...(currentRates.usdt || {}), price: Number(ar.usdt), source: currentRates.usdt?.source || 'Sincronizada (LAN/Nube)', change: currentRates.usdt?.change ?? 0 } } : {}),
                ...(Number(ar.autoCop) > 0 ? { autoCopRate: { ...(currentRates.autoCopRate || {}), price: Number(ar.autoCop), source: currentRates.autoCopRate?.source || 'Sincronizada (LAN/Nube)' } } : {}),
                lastUpdate: ar.updatedAt || currentRates.lastUpdate || new Date().toISOString(),
            };
            const serialized = JSON.stringify(nextRates);
            if (storage.getItem(MONITOR_RATES_KEY) !== serialized) {
                storage.setItem(MONITOR_RATES_KEY, serialized);
                changed.push(MONITOR_RATES_KEY);
            }
        }

        for (const k of changed) dispatch(k);
        return changed;
    } finally {
        applyingRemoteDepth = Math.max(0, applyingRemoteDepth - 1);
    }
}

function defaultDispatch(key) {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('app_storage_update', { detail: { key, source: 'remote' } }));
}

// ─── Enlace con la app ───────────────────────────────────────────────────────

let link = null;

/**
 * Lo instala useNubeSync mientras hay un empleado dentro.
 * @param {object} deps
 * @param {(key) => Promise<any>} deps.readCloud    valor guardado de RATE_KEY (lo último sincronizado)
 * @param {(value) => Promise<void>} deps.writeCloud guarda RATE_KEY y lo encola para subir
 * @param {() => boolean} deps.canEdit              ¿dueño o administrador?
 */
export function setNubeRateLink(deps) {
    link = deps ? { ...deps, ready: false, timer: null } : null;
}

/**
 * Tras la primera bajada: ya se puede publicar lo que cambie aquí. Si la cuenta aún no
 * tiene tasa, la del primer dueño o administrador que entre pasa a ser la de todos.
 */
export async function markNubeRateReady() {
    if (!link) return false;
    link.ready = true;
    return publishRate({ onlyIfMissing: true });
}

/** La app (RateContext / useRates) avisa que cambió la tasa en este equipo. Sin nube no hace nada. */
export function notifyRateChanged({ delayMs = 300 } = {}) {
    if (!link || applyingRemoteDepth > 0) return;
    clearTimeout(link.timer);
    link.timer = setTimeout(() => { publishRate().catch((e) => console.warn('[nube] no se pudo publicar la tasa', e?.message || e)); }, delayMs);
}

/** Sube la tasa de este equipo si cambió y si quien está dentro puede cambiarla. */
export async function publishRate({ storage = globalThis.localStorage, onlyIfMissing = false } = {}) {
    const l = link;
    if (!l || !l.ready || !l.canEdit()) return false;
    const snap = readRateSnapshot(storage);
    const current = await l.readCloud();
    if (current && (onlyIfMissing || stableStringify(current) === stableStringify(snap))) return false;
    await l.writeCloud(snap);
    return true;
}
