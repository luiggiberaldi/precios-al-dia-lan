/**
 * Tasa única por cuenta (Precios al Día Nube).
 *
 * En Bodega la tasa (modo BCV/euro/USDT/manual, tasa manual y peso colombiano) vive en
 * el localStorage de cada equipo. En la nube debe ser UNA para todas las cajas: viaja
 * como un registro de `settings` (`pdn_rate_v1`) por el sincronizador de registros.
 *
 *   · Al cambiarla el dueño o un administrador, se guarda el resumen en storageService y
 *     el sincronizador la sube (el servidor no deja a un cajero cambiar `settings`).
 *   · Al bajar el registro, se escribe en las claves de siempre y se avisa con
 *     `app_storage_update`, que RateContext ya escucha.
 *   · Antes de la primera bajada no se publica nada: el valor de un equipo que estuvo
 *     apagado no debe pisar la tasa que pusieron en otra caja.
 */
import { stableStringify } from './recordSync';

export const RATE_KEY = 'pdn_rate_v1';
const MODES = ['bcv', 'euro', 'usdt', 'manual'];

/** Lo que define la tasa en este equipo (de las claves heredadas). */
export function readRateSnapshot(storage = globalThis.localStorage) {
    const get = (k) => storage?.getItem(k) ?? null;
    const mode = get('bodega_rate_mode');
    const custom = get('bodega_custom_rate');
    return {
        rateMode: MODES.includes(mode) ? mode : (get('bodega_use_auto_rate') === 'false' ? 'manual' : 'bcv'),
        customRate: custom && parseFloat(custom) > 0 ? String(custom) : '',
        copEnabled: get('cop_enabled') === 'true',
        autoCopEnabled: get('auto_cop_enabled') === 'true',
        tasaCop: get('tasa_cop') || '',
        copPrimary: get('cop_primary') === 'true',
    };
}

/** Escribe la tasa de la cuenta en las claves heredadas y avisa a la app. Devuelve las claves cambiadas. */
export function applyRateSnapshot(snap, { storage = globalThis.localStorage, dispatch = defaultDispatch } = {}) {
    if (!snap || typeof snap !== 'object' || !MODES.includes(snap.rateMode)) return [];
    const next = {
        bodega_rate_mode: snap.rateMode,
        bodega_use_auto_rate: String(snap.rateMode !== 'manual'),
        cop_enabled: String(Boolean(snap.copEnabled)),
        auto_cop_enabled: String(Boolean(snap.autoCopEnabled)),
        cop_primary: String(Boolean(snap.copPrimary)),
    };
    if (snap.customRate && parseFloat(snap.customRate) > 0) next.bodega_custom_rate = String(snap.customRate);
    if (snap.tasaCop) next.tasa_cop = String(snap.tasaCop);
    const changed = [];
    for (const [k, v] of Object.entries(next)) {
        if (storage.getItem(k) === v) continue;
        storage.setItem(k, v);
        changed.push(k);
    }
    for (const k of changed) dispatch(k);
    return changed;
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

/** La app (RateContext) avisa que cambió la tasa en este equipo. Sin nube no hace nada. */
export function notifyRateChanged({ delayMs = 300 } = {}) {
    if (!link) return;
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
