/**
 * Sincronizador de registros de Precios al Día Nube (F2).
 *
 * La app heredada sigue guardando arreglos completos en IndexedDB (la «fotocopia
 * local»). Este módulo:
 *   · al escribir localmente: compara registro por registro con lo último que la nube
 *     confirmó y sube SOLO lo que cambió (o lo borrado) con la RPC push_records;
 *   · al bajar: trae solo lo que cambió desde la última vez y lo funde en la copia
 *     local, conservando los campos que maneja un libro (stock, saldos).
 *
 * Barandas: G7 (cada registro con su id; reenviar no duplica), G10 (la cola de
 * pendientes nunca se vacía sola: si falla, queda para el próximo intento),
 * G12 (nunca documentos gigantes; avisos baratos por account_sync_state).
 */

import { withLock } from '../utils/withLock';

export const SYNCED_KEYS = Object.freeze({
    bodega_products_v1: { collection: 'products', kind: 'list', keep: ['stock', 'stockInLotes', 'stockAsOf', 'stockBefore', 'stockAfter'] },
    bodega_customers_v1: { collection: 'customers', kind: 'list', keep: ['deuda', 'favor', 'saldo', 'balance', 'creditBalance', 'casheaDeuda'] },
    bodega_cashea_ledger_v1: { collection: 'cashea', kind: 'list', keep: [] },
    bodega_suppliers_v1: { collection: 'suppliers', kind: 'list', keep: ['deuda'] },
    bodega_supplier_invoices_v1: { collection: 'supplier_invoices', kind: 'list', keep: [] },
    bodega_employees_v1: { collection: 'employees', kind: 'list', keep: [] },
    bodega_payroll_entries_v1: { collection: 'payroll_entries', kind: 'list', keep: [] },
    bodega_merchandise_purchases_v1: { collection: 'purchases', kind: 'list', keep: [] },
    bodega_payment_methods_v1: { collection: 'payment_methods', kind: 'list', keep: [] },
    my_categories_v1: { collection: 'settings', kind: 'value', keep: [] },
    // Tasa única de la cuenta (rateSync.js): la cambian el dueño o un administrador.
    pdn_rate_v1: { collection: 'settings', kind: 'value', keep: [] },
    // T19: configuración del negocio (IVA, stock negativo, datos comercio, políticas) como objeto plano 3-way.
    pdn_business_config_v1: { collection: 'settings', kind: 'object', keep: [] },
    // F5: el turno de caja (ventas, apertura, gastos, aportes, cobros…). Cada caja SUBE lo
    // suyo y no baja lo de otras (pushOnly): el cierre de una caja no toca a otra.
    bodega_sales_v1: { collection: 'cash', kind: 'list', keep: [], pushOnly: true, cash: true },
});

/** Registros de caja más viejos que esto no se suben (quedan en el respaldo, G12). */
export const CASH_MAX_AGE_DAYS = 120;

const SLIM_ITEM_FIELDS = [
    'id', '_originalId', 'name', 'qty', 'priceUsd', 'costUsd', 'costBs',
    'isWeight', 'unit', 'granelUnit', 'packagingType', '_mode', '_unitsPerPackage',
    'isCashAdvance', 'montoEfectivo', 'montoComision', 'comisionPct', 'currency',
];

/** Registro de caja aligerado: sin el detalle pesado del producto pero conservando campos financieros. */
export function slimCashRecord(rec) {
    const out = { ...rec };
    delete out.stockEffects;
    if (Array.isArray(out.items)) {
        out.items = out.items.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const slim = {};
            for (const field of SLIM_ITEM_FIELDS) {
                if (item[field] !== undefined) slim[field] = item[field];
            }
            return slim;
        });
    }
    return out;
}

const KEY_BY_COLLECTION = Object.fromEntries(
    Object.entries(SYNCED_KEYS).map(([key, cfg]) => [`${cfg.collection}:${cfg.kind === 'value' || cfg.kind === 'object' ? key : '*'}`, key]),
);

/** Tamaño máximo que se intenta subir por registro (el servidor corta en 100 KB). */
export const MAX_RECORD_BYTES = 90_000;
export const RECORD_REJECTED_KEY = 'pdn_record_rejected_v1';
const PUSH_BATCH = 200;
const PULL_PAGE = 500;
// updated_at es la hora en que EMPEZÓ la transacción: una subida lenta confirma filas «del
// pasado». Se vuelve a mirar este margen (lo repetido se descarta por versión).
const PULL_OVERLAP_MS = 60_000;

const _utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export function utf8ByteLength(value) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (!str) return 0;
    return _utf8Encoder ? _utf8Encoder.encode(str).length : str.length * 2;
}

function isPermanentDataError(error) {
    return /^2[23]/.test(String(error?.code || ''));
}

// ─── Utilidades puras ────────────────────────────────────────────────────────

export function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** FNV-1a de 32 bits: suficiente para saber si un registro cambió. */
export function hashOf(value) {
    const text = stableStringify(value);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= MAX_RECORD_ID;

function omit(obj, keys) {
    const out = { ...obj };
    for (const k of keys) delete out[k];
    return out;
}

function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

/** Lo que viaja a la nube: sin campos de libro, con imágenes LAN relativas y sin base64 enormes. */
export function toCloudData(cfg, item) {
    let data = omit(item, cfg.keep);
    if (typeof data.image === 'string' && /^https?:\/\//i.test(data.image)) {
        try {
            const parsed = new URL(data.image);
            if (parsed.pathname.startsWith('/lan/images/')) {
                data = { ...data, image: `${parsed.pathname}${parsed.search || ''}` };
            }
        } catch {
            /* conservar valor original */
        }
    }
    if (utf8ByteLength(data) > MAX_RECORD_BYTES && typeof data.image === 'string' && data.image.startsWith('data:')) {
        data = omit(data, ['image']);
    }
    return data;
}

/** El servidor solo acepta ids de 1 a 120 caracteres (account_records_id_check). */
export const MAX_RECORD_ID = 120;

/**
 * Id en la nube de un registro de caja: `venta@equipo`. Si no cabe (p. ej. los ajustes del
 * Supervisor de un respaldo, `supervisor-<uuid>-line-<uuid>`), se recorta la parte de la
 * venta y se le pega un resumen de la original para que siga siendo única y siempre igual.
 * El `@equipo` queda al final: el historial de todas las cajas lo lee de ahí.
 */
export function cashRecordId(itemId, cashIdSuffix) {
    const base = String(itemId);
    const tail = cashIdSuffix ? `@${cashIdSuffix}` : '';
    if (base.length + tail.length <= MAX_RECORD_ID) return `${base}${tail}`;
    const digest = `~${hashOf(base)}${hashOf(`${base}|${base.length}`)}`;
    return `${base.slice(0, Math.max(1, MAX_RECORD_ID - tail.length - digest.length))}${digest}${tail}`;
}

/** Registros de un valor local: lista de objetos con id, o un valor entero (ajuste). */
export function toRecords(key, value, { cashIdSuffix = null, now = Date.now() } = {}) {
    const cfg = SYNCED_KEYS[key];
    if (!cfg) return [];
    if (cfg.kind === 'value') return [{ id: key, data: { value: value ?? null } }];
    if (cfg.kind === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        return [{ id: key, data: value }];
    }
    if (!Array.isArray(value)) return [];
    const oldest = now - CASH_MAX_AGE_DAYS * 86_400_000;
    return value
        .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null && String(item.id) !== '')
        .filter((item) => !cfg.cash || !(Date.parse(item.timestamp) < oldest))
        .map((item) => (cfg.cash
            ? { id: cashRecordId(item.id, cashIdSuffix), data: slimCashRecord(item) }
            : { id: String(item.id), data: toCloudData(cfg, item) }));
}

/** Funde lo bajado de la nube en la copia local. Devuelve el valor local nuevo. */
export function mergeIntoLocal(key, localValue, rows) {
    const cfg = SYNCED_KEYS[key];
    if (cfg.kind === 'value') {
        const last = rows[rows.length - 1];
        if (!last) return localValue;
        return last.deleted_at ? localValue : (last.data?.value ?? localValue);
    }
    if (cfg.kind === 'object') {
        const last = rows[rows.length - 1];
        if (!last) return localValue;
        return last.deleted_at ? localValue : (last.data && typeof last.data === 'object' ? last.data : localValue);
    }
    const list = Array.isArray(localValue) ? [...localValue] : [];
    const index = new Map(list.map((item, i) => [String(item?.id), i]));
    const removed = new Set();
    for (const row of rows) {
        const at = index.get(row.id);
        if (row.deleted_at) {
            if (at !== undefined) removed.add(at);
            continue;
        }
        const merged = { ...row.data, ...pick(at !== undefined ? list[at] : null, cfg.keep) };
        if (at !== undefined) {
            removed.delete(at);
            list[at] = merged;
        } else { index.set(row.id, list.length); list.push(merged); }
    }
    return list.filter((_, i) => !removed.has(i));
}

/** La función no existe en la base (PostgREST: PGRST202; Postgres: 42883). */
function isMissingRpc(error) {
    return error?.code === 'PGRST202' || error?.code === '42883';
}

// ─── Motor ───────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.client      cliente Supabase del equipo
 * @param {() => string|null} deps.getSession   token de la sesión de PIN
 * @param {{getItem, setItem}} deps.store        dónde guardar el estado del sincronizador
 * @param {(key) => Promise<any>} deps.readLocal
 * @param {(key, value) => Promise<void>} deps.writeLocal  escribe SIN volver a subir (sin eco)
 * @param {(collection) => boolean} [deps.canPush]  ¿el empleado actual puede subir esta colección?
 *   (un cajero no sube catálogo ni ajustes). Solo los cambios que SÍ se pueden subir se
 *   protegen al bajar; los demás los corrige lo que manda la nube.
 */
export function createRecordSync({
    client,
    getSession,
    store,
    readLocal,
    writeLocal,
    withLocalLock = (fn) => fn(),
    onStatus = () => {},
    onPulled = () => {},
    cashIdSuffix = null,
    canPush = () => true,
}) {
    let flushing = null;
    let pulling = null;
    const pullAgain = new Set();
    let lastError = null;
    let lastSizeError = null;

    // El estado de cada colección (versiones, cola, cursor) lo tocan onLocalWrite, flush y
    // pull a la vez —incluso entre pestañas del mismo navegador—. Cada leer-modificar-guardar
    // va en turno por colección con `withLock` (navigator.locks con fallback en memoria).
    // La red queda FUERA del turno.
    function inTurn(collection, fn) {
        return withLock(`pdn_sync_turn_${collection}`, fn, { fallbackWarning: false });
    }

    const stateKey = (collection) => `pdn_sync_${collection}_v1`;
    async function loadState(collection) {
        const s = await store.getItem(stateKey(collection));
        return { versions: {}, lastPulled: null, queue: [], ...(s || {}) };
    }
    const saveState = (collection, state) => store.setItem(stateKey(collection), state);

    function report() {
        onStatus({ lastError });
    }

    async function onLocalWrite(key, value) {
        const cfg = SYNCED_KEYS[key];
        if (!cfg) return false;
        if (cfg.cash && !cashIdSuffix) return true; // sin id de equipo no se suben registros de caja
        await inTurn(cfg.collection, () => queueLocalWrite(key, cfg, value));
        report();
        flush();
        return true;
    }

    async function queueLocalWrite(key, cfg, value) {
        // C14: un cajero no encola cambios de colecciones restringidas para evitar
        // escalamiento diferido cuando un administrador inicie turno después.
        if (!canPush(cfg.collection)) return;
        const state = await loadState(cfg.collection);
        const records = toRecords(key, value, { cashIdSuffix });
        // Ids que SIGUEN en la copia local (también los de caja demasiado viejos para
        // subir): solo lo que de verdad desapareció se borra en la nube.
        const present = new Set(cfg.kind === 'list' && Array.isArray(value)
            ? value.filter((item) => item && item.id !== undefined && item.id !== null && String(item.id) !== '')
                .map((item) => (cfg.cash ? cashRecordId(item.id, cashIdSuffix) : String(item.id)))
            : []);
        const seen = new Set();
        // Un id que el servidor nunca aceptará (más de 120 caracteres) tumba el lote entero
        // en cada intento y deja todo lo de atrás sin subir. Los que quedaron en la cola de
        // una versión anterior se sacan aquí (los de caja vuelven a entrar con id corto).
        const queued = new Map(state.queue.filter((r) => validId(r.id)).map((r) => [r.id, r]));
        let localSizeErr = null;
        for (const rec of records) {
            seen.add(rec.id);
            if (!validId(rec.id)) {
                localSizeErr = `El registro ${rec.id.slice(0, 40)}… tiene un id demasiado largo para la nube; no se subió.`;
                lastError = localSizeErr;
                continue;
            }
            const h = hashOf(rec.data);
            if (state.versions[rec.id]?.h === h && !queued.has(rec.id)) continue;
            if (utf8ByteLength(rec.data) > MAX_RECORD_BYTES) {
                localSizeErr = `El registro ${rec.id} es demasiado grande para la nube; no se subió.`;
                lastError = localSizeErr;
                continue;
            }
            // `b`: versión de la nube de la que partió el cambio local (S2). Si ya estaba en
            // la cola, se conserva la de la primera edición: lo bajado entretanto no la mueve.
            const b = queued.get(rec.id)?.b ?? state.versions[rec.id]?.v;
            queued.set(rec.id, { id: rec.id, data: rec.data, h, ...(b !== undefined ? { b } : {}) });
        }
        if (localSizeErr) lastSizeError = localSizeErr;
        if (cfg.kind === 'list') {
            for (const id of Object.keys(state.versions)) {
                if (!seen.has(id) && !present.has(id) && !state.versions[id].deleted) queued.set(id, { id, data: { id }, deleted: true, h: 'deleted' });
            }
        }
        state.queue = [...queued.values()];
        await saveState(cfg.collection, state);
    }

    async function writeMerged(collection, rows) {
        const byKey = new Map();
        for (const r of rows) {
            const key = KEY_BY_COLLECTION[`${collection}:${r.id}`] || KEY_BY_COLLECTION[`${collection}:*`];
            if (!key) continue;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(r);
        }
        for (const [key, list] of byKey) {
            await withLocalLock(async () => {
                await writeLocal(key, mergeIntoLocal(key, await readLocal(key), list));
            });
        }
    }

    let rejectedCount = 0;
    let hasV2 = true;

    async function quarantineRecords(items) {
        if (!items.length) return;
        const prev = (await store.getItem(RECORD_REJECTED_KEY)) || [];
        await store.setItem(RECORD_REJECTED_KEY, [...prev, ...items].slice(-200));
    }

    async function rpcPushBatch(session, collection, records) {
        const args = {
            p_session: session,
            p_collection: collection,
            p_records: records.map(({ id, data: d, deleted, b }) => ({
                id, data: d, deleted: Boolean(deleted), ...(b !== undefined ? { base_version: b } : {}),
            })),
        };
        let { data, error } = await client.rpc(hasV2 ? 'push_records_v2' : 'push_records', args);
        if (error && hasV2 && isMissingRpc(error)) {
            hasV2 = false;
            ({ data, error } = await client.rpc('push_records', args));
        }
        return { data, error };
    }

    async function flushCollection(collection) {
        const session = getSession();
        if (!session) return;
        let state = await loadState(collection);
        while (state.queue.length) {
            const batch = state.queue.slice(0, PUSH_BATCH);
            let { data, error } = await rpcPushBatch(session, collection, batch);
            const quarantined = [];
            let confirmedRows = Array.isArray(data) ? data : [];

            if (error && isPermanentDataError(error)) {
                // A11: Aislar poison-pills de clase 22/23 uno a uno sin trabar el resto del lote.
                confirmedRows = [];
                let transientErr = null;
                if (batch.length === 1) {
                    quarantined.push({ collection, id: batch[0].id, h: batch[0].h, error: error.message, code: error.code, at: new Date().toISOString() });
                } else {
                    for (const item of batch) {
                        const single = await rpcPushBatch(session, collection, [item]);
                        if (!single.error) {
                            if (Array.isArray(single.data)) confirmedRows.push(...single.data);
                        } else if (isPermanentDataError(single.error)) {
                            quarantined.push({ collection, id: item.id, h: item.h, error: single.error.message, code: single.error.code, at: new Date().toISOString() });
                        } else {
                            transientErr = single.error;
                            break;
                        }
                    }
                }
                if (quarantined.length) await quarantineRecords(quarantined);
                if (transientErr && !confirmedRows.length && !quarantined.length) {
                    throw new Error(transientErr.message || 'No se pudo subir a la nube');
                }
                error = null;
            }

            if (error) throw new Error(error.message || 'No se pudo subir a la nube');
            const confirmed = new Map(confirmedRows.map((r) => [r.id, r]));
            const quarantinedSet = new Set(quarantined.map((r) => `${r.id}|${r.h}`));
            state = await inTurn(collection, async () => {
                const s = await loadState(collection); // pudo crecer mientras subía
                const sent = new Set(batch.filter((r) => confirmed.has(r.id)).map((r) => `${r.id}|${r.h}`));
                s.queue = s.queue.filter((r) => !sent.has(`${r.id}|${r.h}`) && !quarantinedSet.has(`${r.id}|${r.h}`));
                const stillQueued = new Set(s.queue.map((r) => r.id));
                const mergedRows = [];
                for (const rec of batch) {
                    const ok = confirmed.get(rec.id);
                    if (!ok) continue;
                    if (ok.rejected) {
                        // S4 / C9: la nube no aceptó el borrado (cajero o cliente con saldo) y
                        // republicó el registro: olvidar la versión para que lo próximo que
                        // baje lo devuelva a la copia local.
                        delete s.versions[rec.id];
                        rejectedCount += 1;
                    } else if (ok.merged && ok.data) {
                        // S2: la nube fundió este cambio con el de otra caja. La copia local
                        // pasa a mostrar lo fundido, salvo que ya haya otro cambio local en cola.
                        s.versions[rec.id] = { v: ok.version, h: hashOf(ok.data) };
                        if (!stillQueued.has(rec.id)) mergedRows.push({ id: rec.id, data: ok.data, version: ok.version, deleted_at: null });
                    } else {
                        s.versions[rec.id] = { v: ok.version, h: rec.h, ...(rec.deleted ? { deleted: true } : {}) };
                    }
                    // MED-03: si el usuario editó este mismo registro mientras el lote viajaba,
                    // actualizar la base `b` de la segunda edición a la versión recién confirmada.
                    if (stillQueued.has(rec.id) && !ok.rejected && ok.version != null) {
                        for (const q of s.queue) {
                            if (q.id === rec.id) q.b = ok.version;
                        }
                    }
                }
                if (mergedRows.length) await writeMerged(collection, mergedRows);
                await saveState(collection, s);
                return s;
            });
            if (!confirmed.size && !quarantined.length) break;
        }
    }

    function flush() {
        if (flushing) return flushing;
        flushing = (async () => {
            try {
                // Cada colección por su lado: si una falla (p. ej. un cajero no puede cambiar
                // ajustes) las demás siguen subiendo; lo que falló queda en su cola (G10).
                let firstError = null;
                rejectedCount = 0;
                const restore = new Set();
                for (const cfg of new Set(Object.values(SYNCED_KEYS).map((c) => c.collection))) {
                    const before = rejectedCount;
                    try {
                        await flushCollection(cfg);
                    } catch (e) {
                        firstError = firstError || e?.message || String(e);
                    }
                    if (rejectedCount > before) restore.add(cfg);
                }
                // Lo rechazado vuelve ya mismo (la nube lo republicó con versión nueva).
                if (restore.size) await pull([...restore]).catch(() => {});
                lastError = firstError || (rejectedCount
                    ? `Solo el dueño o un administrador pueden borrar clientes (o el cliente tiene saldo pendiente): se restauraron ${rejectedCount}.`
                    : lastSizeError);
            } finally {
                flushing = null;
                report();
            }
        })();
        return flushing;
    }

    async function pullCollection(collection) {
        const before = await loadState(collection);
        const since = before.lastPulled ? new Date(Date.parse(before.lastPulled) - PULL_OVERLAP_MS).toISOString() : null;
        const rows = [];
        // Páginas por (updated_at, id). Todo lo que sube una llamada a push_records comparte
        // la MISMA hora (now() de la transacción): cortar solo por hora salta registros
        // cuando un lote de 200-500 cae entre dos páginas. Al llenar una página se termina
        // primero esa hora (por id) y luego se sigue con las siguientes.
        let cursor = since;
        let tieId = null;
        for (;;) {
            let query = client.from('account_records')
                .select('id, data, version, deleted_at, updated_at')
                .eq('collection', collection);
            if (tieId !== null) query = query.eq('updated_at', cursor).gt('id', tieId);
            else if (cursor) query = query.gt('updated_at', cursor);
            const { data, error } = await query.order('updated_at').order('id').limit(PULL_PAGE);
            if (error) throw new Error(error.message || 'No se pudo bajar de la nube');
            const page = data || [];
            rows.push(...page);
            const last = page[page.length - 1];
            if (tieId !== null) {
                tieId = page.length < PULL_PAGE ? null : last.id; // terminada esa hora: seguir con gt
                continue;
            }
            if (page.length < PULL_PAGE) break;
            cursor = last.updated_at;
            tieId = last.id;
        }
        return inTurn(collection, () => applyPulled(collection, rows));
    }

    async function applyPulled(collection, rows) {
        const state = await loadState(collection);
        const fresh = rows.filter((r) => !(state.versions[r.id]?.v >= r.version));
        // Un registro con un cambio local SIN SUBIR (p. ej. hecho sin internet) no se pisa
        // en la copia local: ese cambio sube después y gana, y la caja queda mostrando lo
        // mismo que la nube. Antes la pantalla tomaba lo bajado mientras la cola seguía
        // subiendo lo viejo, y la caja quedaba distinta de la nube para siempre (S1).
        const pendingLocal = canPush(collection) ? new Set(state.queue.map((q) => q.id)) : new Set();
        const toApply = fresh.filter((r) => !pendingLocal.has(r.id));
        if (toApply.length) {
            const byKey = new Map();
            for (const r of toApply) {
                const key = KEY_BY_COLLECTION[`${collection}:${r.id}`] || KEY_BY_COLLECTION[`${collection}:*`];
                if (!key) continue;
                if (!byKey.has(key)) byKey.set(key, []);
                byKey.get(key).push(r);
            }
            for (const [key, list] of byKey) {
                await withLocalLock(async () => {
                    const merged = mergeIntoLocal(key, await readLocal(key), list);
                    await writeLocal(key, merged);
                });
            }
            // C14: SOLO avanzar state.versions para las filas efectivamente aplicadas.
            // Si una fila se saltó por pendingLocal, NO adelantar su versión: si luego
            // cambia el turno a un cajero, el siguiente pull() volverá a bajarla y aplicarla.
            for (const r of toApply) {
                state.versions[r.id] = { v: r.version, h: r.deleted_at ? 'deleted' : hashOf(r.data), ...(r.deleted_at ? { deleted: true } : {}) };
            }
        }
        const skippedAny = toApply.length < fresh.length;
        const newest = rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), state.lastPulled || '');
        if (newest && !skippedAny) state.lastPulled = newest;
        // Lo bajado no debe quedar en la cola como si fuera un cambio local.
        const appliedIds = new Set(toApply.map((r) => r.id));
        state.queue = state.queue.filter((q) => !appliedIds.has(q.id) || q.h !== state.versions[q.id]?.h);
        await saveState(collection, state);
        if (toApply.length) {
            try { await onPulled(collection, toApply); } catch { /* nunca romper pull por un listener */ }
        }
        return toApply.length;
    }

    /**
     * Baja lo nuevo. Las llamadas que llegan mientras otra baja (un aviso de Realtime por
     * CADA registro de un lote) no abren otra descarga: se suman a UNA sola vuelta extra.
     */
    function pull(collections = [...new Set(Object.values(SYNCED_KEYS).filter((c) => !c.pushOnly).map((c) => c.collection))]) {
        const wanted = collections.filter((c) => !Object.values(SYNCED_KEYS).some((x) => x.collection === c && x.pushOnly));
        if (pulling) {
            for (const c of wanted) pullAgain.add(c);
            return pulling;
        }
        pulling = (async () => {
            let total = 0;
            let todo = wanted;
            let firstError = null;
            try {
                while (todo.length) {
                    // C13: aislar cada colección en su propio try/catch para que un fallo en una
                    // no bloquee la sincronización de las demás (clientes, tasas, etc.).
                    for (const c of todo) {
                        try {
                            total += await pullCollection(c);
                        } catch (e) {
                            firstError = firstError || (e?.message || String(e));
                        }
                    }
                    todo = [...pullAgain];
                    pullAgain.clear();
                }
                lastError = firstError || lastSizeError;
            } finally {
                pulling = null;
            }
            report();
            return total;
        })();
        return pulling;
    }

    async function pendingCount() {
        let n = 0;
        for (const c of new Set(Object.values(SYNCED_KEYS).map((x) => x.collection))) n += (await loadState(c)).queue.length;
        return n;
    }

    return { handles: (key) => Boolean(SYNCED_KEYS[key]), onLocalWrite, flush, pull, pendingCount, getLastError: () => lastError };
}
