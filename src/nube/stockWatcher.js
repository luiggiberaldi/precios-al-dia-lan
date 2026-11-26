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
 * propias RPC), así no se cuentan dos veces.
 *
 * Si el servidor rechaza un ajuste (p. ej. un cajero no puede mover inventario), se
 * registra el error y el siguiente refresco devuelve el stock real del servidor:
 * nada se pierde a ciegas ni queda distinto sin aviso (G10).
 */
import { moveStock } from './stockService';

export const STOCK_QUEUE_KEY = 'pdn_stock_queue_v1';
export const STOCK_BASELINE_KEY = 'pdn_stock_baseline_v1';

const round3 = (n) => Math.round(n * 1000) / 1000;

function newId() {
    return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function createStockWatcher({ client, getSession, store, onStatus = () => {} }) {
    let flushing = null;
    let lastError = null;
    const rejected = [];

    const read = async () => ({
        queue: (await store.getItem(STOCK_QUEUE_KEY)) || [],
        baseline: (await store.getItem(STOCK_BASELINE_KEY)) || {},
    });

    /**
     * Fija el stock conocido (tras leer los niveles del servidor).
     * `only`: ids cuyo stock confirma el servidor (o un ajuste en cola). Los demás quedan
     * fuera: su stock local se sube como ajuste en la próxima escritura.
     */
    async function setBaseline(products, { only = null } = {}) {
        const baseline = {};
        for (const p of Array.isArray(products) ? products : []) {
            if (p?.id === undefined || p.stock === undefined || p.stock === null || p.stock === '') continue;
            if (only && !only.has(String(p.id))) continue;
            baseline[String(p.id)] = Number(p.stock);
        }
        await store.setItem(STOCK_BASELINE_KEY, baseline);
    }

    /** Escritura local de productos SIN skipSyncPush: convierte cambios de stock en ajustes. */
    async function onProductsWrite(products) {
        if (!Array.isArray(products)) return 0;
        const { queue, baseline } = await read();
        let added = 0;
        for (const p of products) {
            if (p?.id === undefined || p.stock === undefined || p.stock === null || p.stock === '') continue;
            const id = String(p.id);
            const now = Number(p.stock);
            if (!Number.isFinite(now)) continue;
            const before = baseline[id] ?? 0;
            const delta = round3(now - before);
            baseline[id] = now;
            if (delta === 0) continue;
            queue.push({ id: newId(), product_id: id, qty: delta, note: 'Cambio de stock desde la caja' });
            added += 1;
        }
        await store.setItem(STOCK_BASELINE_KEY, baseline);
        await store.setItem(STOCK_QUEUE_KEY, queue);
        if (added) flush();
        return added;
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
                    const batch = queue.slice(0, 200);
                    try {
                        await moveStock(client, session, 'AJUSTE', batch);
                    } catch (e) {
                        const msg = e?.message || String(e);
                        if (/dueño o un administrador/.test(msg)) {
                            // Sin permiso: no se reintenta; el refresco devuelve el stock real.
                            rejected.push(...batch.map((m) => ({ ...m, error: msg })));
                            lastError = 'Solo el dueño o un administrador pueden cambiar el stock. Se restauró el del servidor.';
                        } else {
                            lastError = msg;
                            break; // sin red u otro error: la cola queda (G10)
                        }
                    }
                    const sent = new Set(batch.map((m) => m.id));
                    const rest = (await read()).queue.filter((m) => !sent.has(m.id));
                    await store.setItem(STOCK_QUEUE_KEY, rest);
                    if (!rest.length) lastError = lastError && /Solo el dueño/.test(lastError) ? lastError : null;
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
        // Solo se rechaza sin reintento por falta de permiso (ver flush).
        if (nowRejected.length) return { ok: false, message: 'Solo el dueño o un administrador pueden cambiar el stock. El servidor no guardó el ajuste.' };
        const left = (await read()).queue.length;
        if (left) return { ok: false, queued: true, message: lastError ? `El ajuste quedó en cola y se subirá al volver la conexión (${lastError})` : 'El ajuste quedó en cola y se subirá al volver la conexión' };
        return { ok: true };
    }

    /** Productos con ajustes sin subir (el refresco no debe pisarlos). */
    async function pendingProducts() {
        return new Set((await read()).queue.map((m) => m.product_id));
    }

    return { setBaseline, onProductsWrite, flush, flushNow, pendingProducts, getLastError: () => lastError, getRejected: () => [...rejected] };
}
