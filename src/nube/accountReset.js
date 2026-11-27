/**
 * Reinicio de fábrica de la cuenta (supabase/nube/migrations/014_reinicio_de_cuenta.sql).
 *
 * Servidor: `reset_account('REINICIAR')`, solo el dueño con su sesión de correo. Borra los
 * datos del negocio (los archiva), sube `accounts.reset_epoch` y cierra todas las sesiones
 * de PIN: desde ese momento ninguna caja puede subir nada viejo.
 *
 * Cada caja: guarda la última época que vio. Si la del servidor es mayor, vacía su copia
 * local (IndexedDB BodegaApp) y el estado del sincronizador (PreciosAlDiaNube/pdn_sync:
 * versiones, colas, ventas sin subir, stock y cartera) ANTES de volver a entrar con PIN.
 * Si no, una caja desconectada volvería a subir los datos viejos como altas.
 * Lo que estaba sin subir se descarta y se avisa cuánto fue.
 *
 * Se conservan (igual que en el servidor): métodos de pago, tasa del día y el catálogo
 * local de usuarios; también las preferencias del equipo (no viven en `bodega_*`).
 */
import localforage from 'localforage';
import { NubeError, toNubeError, ownerSignIn, ownerSignOut, getOwnerAccount } from './accountService';

export const RESET_CONFIRM = 'REINICIAR';
/** Última época de reinicio que vio este equipo (en pdn_sync). Sin valor = 0. */
export const RESET_EPOCH_KEY = 'pdn_reset_epoch_v1';
/** Aviso para mostrar tras recargar (localStorage). */
export const RESET_NOTICE_KEY = 'pdn-reset-notice';

/** Claves de IndexedDB que el reinicio NO toca. */
export const KEEP_LOCAL_KEYS = Object.freeze(['bodega_payment_methods_v1', 'bodega_users_catalog_v1', 'pdn_rate_v1']);
/** Claves de tasa en localStorage que sobreviven al reinicio cuando keepSettings=true (A6). */
export const KEEP_RATE_STORAGE_KEYS = Object.freeze([
    'bodega_rate_mode',
    'bodega_custom_rate',
    'bodega_use_auto_rate',
    'cop_enabled',
    'auto_cop_enabled',
    'tasa_cop',
    'cop_primary',
]);
/** Datos del negocio que no empiezan por `bodega_`. */
export const EXTRA_DATA_KEYS = Object.freeze(['my_categories_v1', 'last_bulk_price_snapshot', 'abasto_audit_log_v1']);
/**
 * Listas que quedan en `[]` (no se quitan): si faltan, storageService las recupera de la
 * app vieja (TasasAlDiaApp) o de localStorage y resucitarían.
 */
const ALWAYS_EMPTY_LISTS = Object.freeze(['bodega_products_v1', 'bodega_customers_v1', 'bodega_accounts_v2']);
const LEGACY_LOCALSTORAGE_KEYS = Object.freeze(['my_products_v1', 'my_customers_v1', 'my_accounts_v2']);

// Estado del sincronizador que sobrevive: lo que el servidor tampoco borró.
const SYNC_KEEP = Object.freeze(['pdn_sync_payment_methods_v1', 'pdn_last_online_v1']);
const SYNC_SETTINGS = 'pdn_sync_settings_v1';
const KEPT_SETTING_ID = 'pdn_rate_v1';

let defaults = null;
function defaultStores() {
    if (!defaults) {
        defaults = {
            appStore: localforage.createInstance({ name: 'BodegaApp', storeName: 'bodega_app_data' }),
            shadowStore: localforage.createInstance({ name: 'BodegaApp', storeName: 'bodega_shadow_backups' }),
            syncStore: localforage.createInstance({ name: 'PreciosAlDiaNube', storeName: 'pdn_sync' }),
            storage: globalThis.localStorage,
        };
    }
    return defaults;
}

const isDataKey = (key) => !KEEP_LOCAL_KEYS.includes(key) && (key.startsWith('bodega_') || EXTRA_DATA_KEYS.includes(key));
const len = (v) => (Array.isArray(v) ? v.length : 0);

/** Época actual del servidor, o null si no se pudo leer (sin internet, columna aún no creada…). */
export async function fetchResetEpoch(client) {
    try {
        const { data, error } = await client.from('accounts').select('reset_epoch').limit(1);
        if (error) return null;
        const epoch = Number(data?.[0]?.reset_epoch);
        return Number.isFinite(epoch) ? epoch : null;
    } catch {
        return null;
    }
}

/** Cuántos cambios de este equipo siguen sin subir (todos se descartarán). */
export async function countPending(syncStore) {
    let n = 0;
    for (const key of await syncStore.keys()) {
        if (SYNC_KEEP.includes(key)) continue;
        const v = await syncStore.getItem(key);
        if (key === SYNC_SETTINGS) n += (v?.queue || []).filter((q) => q?.id !== KEPT_SETTING_ID).length;
        else if (/^pdn_sync_.+_v1$/.test(key)) n += len(v?.queue);
        else if (key === 'pdn_sale_queue_v1' || key === 'pdn_stock_queue_v1') n += len(v);
        else if (key === 'pdn_customer_ledger_v1') n += len(v?.queue);
    }
    return n;
}

/** Vacía la copia local y el estado del sincronizador. Devuelve cuántos cambios se descartaron. */
export async function wipeLocalData(stores = {}, { keepSettings = true } = {}) {
    const { appStore, shadowStore, syncStore, storage } = { ...defaultStores(), ...stores };
    const discarded = await countPending(syncStore);

    for (const key of await appStore.keys()) {
        if (keepSettings && KEEP_LOCAL_KEYS.includes(key)) continue;
        if (!keepSettings && !key.startsWith('bodega_') && !EXTRA_DATA_KEYS.includes(key) && !KEEP_LOCAL_KEYS.includes(key)) continue;
        if (keepSettings && !isDataKey(key)) continue;
        if (ALWAYS_EMPTY_LISTS.includes(key)) continue;
        const value = await appStore.getItem(key);
        if (Array.isArray(value)) await appStore.setItem(key, []);
        else await appStore.removeItem(key);
    }
    for (const key of ALWAYS_EMPTY_LISTS) await appStore.setItem(key, []);
    if (shadowStore) await shadowStore.clear();

    if (!keepSettings) {
        await syncStore.clear();
    } else {
        for (const key of await syncStore.keys()) {
            if (SYNC_KEEP.includes(key)) continue;
            if (key === SYNC_SETTINGS) {
                const s = (await syncStore.getItem(key)) || {};
                const kept = s.versions?.[KEPT_SETTING_ID];
                await syncStore.setItem(key, {
                    versions: kept ? { [KEPT_SETTING_ID]: kept } : {},
                    lastPulled: null,
                    queue: (s.queue || []).filter((q) => q?.id === KEPT_SETTING_ID),
                });
                continue;
            }
            await syncStore.removeItem(key);
        }
    }

    if (storage) {
        for (const key of [...ALWAYS_EMPTY_LISTS, ...EXTRA_DATA_KEYS, ...LEGACY_LOCALSTORAGE_KEYS]) storage.removeItem(key);
        for (let i = storage.length - 1; i >= 0; i -= 1) {
            const key = storage.key(i);
            if (!key) continue;
            if (keepSettings
                ? (key.startsWith('bodega_') && isDataKey(key) && !KEEP_RATE_STORAGE_KEYS.includes(key))
                : (key.startsWith('bodega_') || KEEP_LOCAL_KEYS.includes(key))) {
                storage.removeItem(key);
            }
        }
    }
    return { discarded };
}

/**
 * ¿El dueño reinició la cuenta desde la última vez? Si sí, vacía este equipo y deja el aviso.
 * Sin internet no hace nada: tampoco se puede subir nada (las sesiones de PIN están cerradas).
 * @returns {Promise<{ reset: boolean, epoch: number|null, discarded: number }>}
 */
export async function checkAccountReset(client, stores = {}) {
    const all = { ...defaultStores(), ...stores };
    const epoch = await fetchResetEpoch(client);
    if (epoch === null) return { reset: false, epoch: null, discarded: 0 };
    const known = Number(await all.syncStore.getItem(RESET_EPOCH_KEY)) || 0;
    if (epoch <= known) {
        if (epoch !== known) await all.syncStore.setItem(RESET_EPOCH_KEY, epoch);
        return { reset: false, epoch, discarded: 0 };
    }
    const { discarded } = await wipeLocalData(all);
    await all.syncStore.setItem(RESET_EPOCH_KEY, epoch);
    all.storage?.setItem(RESET_NOTICE_KEY, JSON.stringify({ epoch, discarded, at: new Date().toISOString() }));
    return { reset: true, epoch, discarded };
}

/** Texto del aviso que queda tras un reinicio (y lo borra). */
export function takeResetNotice(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(RESET_NOTICE_KEY);
        if (!raw) return null;
        storage.removeItem(RESET_NOTICE_KEY);
        const { discarded = 0 } = JSON.parse(raw) || {};
        return discarded > 0
            ? `El dueño reinició la cuenta. Este equipo quedó vacío y se descartaron ${discarded} cambio(s) que no se habían subido.`
            : 'El dueño reinició la cuenta. Este equipo quedó vacío; vuelve a entrar con tu PIN.';
    } catch {
        return null;
    }
}

/** Llama al reinicio en el servidor con la sesión de CORREO del dueño. */
export async function resetAccount(ownerClient) {
    const { data, error } = await ownerClient.rpc('reset_account', { p_confirm: RESET_CONFIRM });
    if (error) throw toNubeError(error, 'No se pudo reiniciar la cuenta');
    return data;
}

/**
 * Lo que hace el botón de Ajustes → Sistema: el dueño entra con correo y clave en una
 * sesión temporal, se comprueba que ese correo sea el dueño de la cuenta de ESTE equipo,
 * se reinicia y se cierra la sesión temporal. Luego este equipo se vacía al momento.
 */
export async function ownerResetAccount({ deviceClient, ownerClient, email, password, stores }) {
    if (!String(email || '').trim() || !password) throw new NubeError('Escribe tu correo y tu contraseña de dueño.');
    try {
        await ownerSignIn(ownerClient, email, password);
        const [mine, theirs] = await Promise.all([getOwnerAccount(ownerClient), getOwnerAccount(deviceClient)]);
        if (!mine || !theirs || mine.id !== theirs.id) {
            throw new NubeError('Ese correo no es el del dueño de esta cuenta.');
        }
        const result = await resetAccount(ownerClient);
        const local = await checkAccountReset(deviceClient, stores);
        return { ...result, local };
    } finally {
        await ownerSignOut(ownerClient);
    }
}

/**
 * C21 (T15): En LAN local el dueño puede haber creado la cuenta solo con PIN (sin
 * conocer la contraseña interna generada en bootstrapLocalOwner). Autentica con
 * `ownerPinSignIn(pin)` en localhost y ejecuta el mismo `reset_account('REINICIAR')`.
 */
export async function ownerPinResetAccount({ deviceClient, ownerClient, pin, stores }) {
    if (!String(pin || '').trim()) throw new NubeError('Escribe tu PIN de dueño.');
    if (!ownerClient?.lan?.ownerPinSignIn) {
        throw new NubeError('El reinicio con PIN solo está disponible en modo LAN local.');
    }
    try {
        await ownerClient.lan.ownerPinSignIn(String(pin).trim());
        const [mine, theirs] = await Promise.all([getOwnerAccount(ownerClient), getOwnerAccount(deviceClient)]);
        if (!mine || !theirs || mine.id !== theirs.id) {
            throw new NubeError('No se pudo verificar la cuenta del dueño.');
        }
        const result = await resetAccount(ownerClient);
        const local = await checkAccountReset(deviceClient, stores);
        return { ...result, local };
    } finally {
        await ownerSignOut(ownerClient);
    }
}
