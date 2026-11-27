/**
 * Vigilante de stock de Precios al Día Nube (F3, «vías olvidadas»).
 *
 * En la nube el stock lo manda el servidor. Pero muchas pantallas heredadas cambian
 * el stock guardando la lista de productos completa (formulario de producto, ajuste
 * rápido, compras, lotes, mercancía de nómina…). Para no perseguir cada una, este
 * vigilante compara cada escritura con el último stock conocido y manda la diferencia
 * al servidor como movimiento AJUSTE (con su id: reintentar no duplica, G7).
 *
 * El cobro y la anulación NO pasan por aquí (escriben con skipSyncPush y van por sus
 * propias RPC), pero SÍ llaman `adjustBaseline(deltas)` atómicamente para que la
 * siguiente escritura de catálogo no vuelva a descontar/restaurar lo mismo (C1).
 *
 * Si el servidor rechaza un ajuste (p. ej. un cajero no puede mover inventario), se
 * registra el error y el siguiente refresco devuelve el stock real del servidor:
 * nada se pierde a ciegas ni queda distinto sin aviso (G10).
 */
import { moveStock } from './stockService';
import { withLock } from '../utils/withLock';

export const STOCK_QUEUE_KEY = 'pdn_stock_queue_v1';
export const STOCK_BASELINE_KEY = 'pdn_stock_baseline_v1';
export const STOCK_REJECTED_KEY = 'pdn_stock_rejected_v1';

const RECENTLY_FLUSHED_TTL_MS = 60_000;
const round3 = (n) => Math.round(n * 1000) / 1000;

function newId() {
    return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function isPermanentDataError(err) {
    const code = String(err?.code || '');
    return /^2[23]/.test(code);
}

export function createStockWatcher({ client, getSession, store, onStatus = () => {} }) {
    let flushing = null;
    let lastError = null;
    const rejected = [];
    // IDs recién subidos al servidor cuyo Realtime aún no ha llegado a `known` (C3).
    // Evita que `setBaseline(..., { only })` los borre y la siguiente edición duplique su stock.
    const recentlyFlushed = new Map(); // productId -> { flushedAt }

    const withStateLock = (fn) => withLock('pdn_stock_watcher_lock', fn, { fallbackWarning: false });

    const read = async () => ({
        queue: (await store.getItem(STOCK_QUEUE_KEY)) || [],
        baseline: (await store.getItem(STOCK_BASELINE_KEY)) || {},
    });

    async function appendRejectedPersisted(items) {
        if (!items.length) return;
        const prev = (await store.getItem(STOCK_REJECTED_KEY)) || [];
        const next = [...prev, ...items].slice(-200);
        await store.setItem(STOCK_REJECTED_KEY, next);
    }

    function pruneRecentlyFlushed(now = Date.now()) {
        for (const [id, entry] of recentlyFlushed.entries()) {
            if (now - entry.flushedAt > RECENTLY_FLUSHED_TTL_MS) recentlyFlushed.delete(id);
        }
    }

    /**
     * Fija el stock conocido (tras leer los niveles del servidor).
     * `only`: ids cuyo stock confirma el servidor (o un ajuste en cola). Los demás quedan
     * fuera: su stock local se sube como ajuste en la próxima escritura — SALVO que hayan
     * sido subidos recientemente (`recentlyFlushed`) y todavía estén esperando Realtime.
     */
    async function setBaseline(products, { only = null } = {}) {
        return withStateLock(async () => {
            const { baseline: prevBaseline } = await read();
            pruneRecentlyFlushed();
            if (only) {
                for (const id of only) recentlyFlushed.delete(String(id));
            }
            const baseline = {};
            for (const p of Array.isArray(products) ? products : []) {
                if (p?.id === undefined || p.stock === undefined || p.stock === null || p.stock === '') continue;
                const id = String(p.id);
                if (only && !only.has(id)) {
                    if (recentlyFlushed.has(id)) {
                        baseline[id] = prevBaseline[id] !== undefined ? prevBaseline[id] : Number(p.stock);
                    }
                    continue;
                }
                baseline[id] = Number(p.stock);
            }
            await store.setItem(STOCK_BASELINE_KEY, baseline);
        });
    }

    /**
     * Ajusta el baseline atómicamente tras una venta (-qty) o anulación (+qty)
     * escrita localmente con `skipSyncPush: true` (C1).
     */
    async function adjustBaseline(deltas) {
        if (!deltas) return;
        const entries = deltas instanceof Map
            ? [...deltas.entries()]
            : (Array.isArray(deltas) ? deltas : Object.entries(deltas));
        if (!entries.length) return;
        await withStateLock(async () => {
            const { baseline } = await read();
            let changed = false;
            for (const [rawId, rawDelta] of entries) {
                if (rawId === undefined || rawId === null) continue;
                const delta = Number(rawDelta);
                if (!Number.isFinite(delta) || delta === 0) continue;
                const id = String(rawId);
                baseline[id] = round3((baseline[id] ?? 0) + delta);
                changed = true;
            }
            if (changed) await store.setItem(STOCK_BASELINE_KEY, baseline);
        });
    }

    /** Escritura local de productos SIN skipSyncPush: convierte cambios de stock en ajustes. */
    async function onProductsWrite(products) {
        if (!Array.isArray(products)) return 0;
        const added = await withStateLock(async () => {
            const { queue, baseline } = await read();
            let count = 0;
            for (const p of products) {
                if (p?.id === undefined || p.stock === undefined || p.stock === null || p.stock === '') continue;
                const id = String(p.id);
                const now = Number(p.stock);
                if (!Number.isFinite(now)) continue;
                const before = baseline[id] ?? 0;
                const delta = round3(now - before);
                baseline[id] = now;
                if (delta === 0) continue;
                queue.push({ id: newId(), product_id: id, qty: delta, reason: 'AJUSTE', note: 'Cambio de stock desde la caja' });
                count += 1;
            }
            await store.setItem(STOCK_BASELINE_KEY, baseline);
            await store.setItem(STOCK_QUEUE_KEY, queue);
            return count;
        });
        if (added) flush();
        return added;
    }

    /**
     * Encola un conteo físico explícito (motivo 'CONTEO') con la cantidad OBJETIVO
     * deseada (`targetQty`). El servidor (`process_stock_movements`) calcula
     * `targetQty - stock_actual` bajo `FOR UPDATE`, evitando carreras con ventas concurrentes.
     */
    async function submitStockCount(productId, targetQty, note = 'Conteo físico desde la caja') {
        if (productId === undefined || productId === null) return 0;
        const id = String(productId);
        const target = round3(Number(targetQty));
        if (!Number.isFinite(target)) return 0;
        await withStateLock(async () => {
            const { queue, baseline } = await read();
            const prev = baseline[id] ?? 0;
            queue.push({ id: newId(), product_id: id, qty: target, prev_qty: prev, reason: 'CONTEO', note });
            baseline[id] = target;
            await store.setItem(STOCK_BASELINE_KEY, baseline);
            await store.setItem(STOCK_QUEUE_KEY, queue);
        });
        flush();
        return 1;
    }

    async function removeFromQueueAndRevert(sentIds, revertedItems = [], flushedItems = []) {
        await withStateLock(async () => {
            const current = await read();
            if (revertedItems.length) {
                const nextBaseline = { ...current.baseline };
                for (const m of revertedItems) {
                    if (m.reason === 'CONTEO' && m.prev_qty !== undefined) {
                        nextBaseline[m.product_id] = m.prev_qty;
                    } else {
                        const prev = nextBaseline[m.product_id] ?? 0;
                        nextBaseline[m.product_id] = round3(prev - Number(m.qty || 0));
                    }
                }
                await store.setItem(STOCK_BASELINE_KEY, nextBaseline);
            }
            if (flushedItems.length) {
                const now = Date.now();
                for (const m of flushedItems) {
                    recentlyFlushed.set(String(m.product_id), { flushedAt: now });
                }
            }
            const rest = current.queue.filter((m) => !sentIds.has(m.id));
            await store.setItem(STOCK_QUEUE_KEY, rest);
            if (!rest.length) lastError = lastError && /Solo el dueño/.test(lastError) ? lastError : null;
        });
    }

    function flush() {
        if (flushing) return flushing;
        flushing = (async () => {
            try {
                for (;;) {
                    const { queue } = await read();
                    if (!queue.length) break;
                    const session = getSession();
                    if (!session) break;
                    // Agrupar prefijo contiguo por reason para respetar orden FIFO
                    const reason = queue[0].reason || 'AJUSTE';
                    const batch = [];
                    for (const item of queue) {
                        if (batch.length >= 200 || (item.reason || 'AJUSTE') !== reason) break;
                        batch.push(item);
                    }
                    try {
                        await moveStock(client, session, reason, batch);
                        await removeFromQueueAndRevert(new Set(batch.map((m) => m.id)), [], batch);
                    } catch (e) {
                        const msg = e?.message || String(e);
                        if (/dueño o un administrador/.test(msg)) {
                            const rejectedBatch = batch.map((m) => ({ ...m, error: msg, at: new Date().toISOString() }));
                            rejected.push(...rejectedBatch);
                            await appendRejectedPersisted(rejectedBatch);
                            lastError = 'Solo el dueño o un administrador pueden cambiar el stock. Se restauró el del servidor.';
                            await removeFromQueueAndRevert(new Set(batch.map((m) => m.id)), batch, []);
                        } else if (isPermanentDataError(e)) {
                            // M2: Aislar el poison-pill registro por registro sin trabar los demás.
                            const sentIds = new Set();
                            const badItems = [];
                            const okItems = [];
                            let hitTransient = false;
                            if (batch.length === 1) {
                                const only = batch[0];
                                sentIds.add(only.id);
                                badItems.push({ ...only, error: msg, code: e?.code, at: new Date().toISOString() });
                            } else {
                                for (const item of batch) {
                                    try {
                                        await moveStock(client, session, reason, [item]);
                                        sentIds.add(item.id);
                                        okItems.push(item);
                                    } catch (singleErr) {
                                        if (isPermanentDataError(singleErr)) {
                                            sentIds.add(item.id);
                                            badItems.push({ ...item, error: singleErr?.message || String(singleErr), code: singleErr?.code, at: new Date().toISOString() });
                                        } else {
                                            lastError = singleErr?.message || String(singleErr);
                                            hitTransient = true;
                                            break;
                                        }
                                    }
                                }
                            }
                            if (badItems.length) {
                                rejected.push(...badItems);
                                await appendRejectedPersisted(badItems);
                                lastError = `Se apartó ${badItems.length} movimiento(s) de stock inválido(s) para no detener la sincronización.`;
                            }
                            if (sentIds.size) {
                                await removeFromQueueAndRevert(sentIds, badItems, okItems);
                            }
                            if (hitTransient) break;
                        } else {
                            lastError = msg;
                            break; // sin red u otro error: la cola queda (G10)
                        }
                    }
                }
            } finally {
                flushing = null;
                onStatus({ lastError, pending: (await read()).queue.length });
            }
        })();
        return flushing;
    }

    /**
     * Sube la cola al momento y dice cómo le fue a ESTE envío (ajuste confirmado en
     * Inventario): { ok } | { ok: false, message } (rechazado) | { ok: false, queued, message }.
     */
    async function flushNow() {
        const before = rejected.length;
        await flush();
        // Si ya había un envío terminando, pudo no ver lo recién encolado: otra vuelta.
        if ((await read()).queue.length) await flush();
        const nowRejected = rejected.slice(before);
        if (nowRejected.length) {
            const isPerm = nowRejected.some((r) => /dueño o un administrador/.test(r.error || ''));
            return {
                ok: false,
                message: isPerm
                    ? 'Solo el dueño o un administrador pueden cambiar el stock. El servidor no guardó el ajuste.'
                    : (nowRejected[0]?.error || 'El servidor rechazó el movimiento de stock.'),
            };
        }
        const left = (await read()).queue.length;
        if (left) return { ok: false, queued: true, message: lastError ? `El ajuste quedó en cola y se subirá al volver la conexión (${lastError})` : 'El ajuste quedó en cola y se subirá al volver la conexión' };
        return { ok: true };
    }

    /** Productos con ajustes sin subir (el refresco no debe pisarlos). */
    async function pendingProducts() {
        return new Set((await read()).queue.map((m) => m.product_id));
    }

    return {
        setBaseline,
        adjustBaseline,
        onProductsWrite,
        submitStockCount,
        flush,
        flushNow,
        pendingProducts,
        getLastError: () => lastError,
        getRejected: () => [...rejected],
    };
}
