/**
 * Stock y cobro en el servidor para la caja (F3) + cola sin internet (base de F6).
 *
 * · submit(): manda la venta a process_checkout. Con internet el servidor decide:
 *   si no alcanza el stock, la venta se rechaza con su mensaje (E2). Sin internet la
 *   venta queda en una cola guardada en el equipo y se sube después marcada «sin
 *   internet» (nunca se rechaza; si no alcanzaba, el dueño ve la diferencia, E4).
 * · La cola NUNCA se vacía sola: solo sale lo que el servidor confirmó (G10).
 *   Reenviar es seguro: cada venta lleva su id y el servidor responde «ya registrada» (G7).
 */
import { fetchChangedRows } from './changedRows.js';
import { round3 } from '../utils/dinero.js';
import { calculateItemStockDeduction, isGranelProduct } from '../utils/granel.js';
import { isSyntheticCartLine } from '../utils/cartSync.js';
import { safeUuid } from '../utils/safeUuid.js';

export const SALE_QUEUE_KEY = 'pdn_sale_queue_v1';
/** Ventas que el servidor rechazó para siempre: se guardan aparte, nunca se borran solas. */
export const SALE_REJECTED_KEY = 'pdn_sale_rejected_v1';
/** D8: horas que una caja puede vender sin hablar con el servidor. */
export const OFFLINE_LEASE_HOURS = 72;
export const LAST_ONLINE_KEY = 'pdn_last_online_v1';
const NETWORK_RE = /Failed to fetch|NetworkError|fetch failed|Load failed|network|timeout|tardó demasiado|ERR_INTERNET/i;

export function isNetworkError(error) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const msg = `${error?.message || ''} ${error?.details || ''}`;
    return error?.status === 0 || NETWORK_RE.test(msg);
}

/**
 * ¿El servidor rechazó la venta PARA SIEMPRE? Solo los errores de datos de Postgres
 * (clase 22: valor inválido; clase 23: restricción). Red, sesión vencida (42501), servidor
 * caído o cualquier otra cosa se consideran pasajeros: la venta se reintenta.
 */
export function isDefinitiveRejection(error) {
    if (!error || isNetworkError(error)) return false;
    return /^(22|23)/.test(String(error.code || ''));
}

/**
 * Cantidades a descontar por producto (misma fórmula que el cobro de Bodega).
 * La venta libre (`custom_…`) y los avances de efectivo no son inventario: no viajan
 * como movimiento de stock (si no, el servidor los rechaza «sin stock»).
 */
export function saleItemsFromCart(cart) {
    const totals = new Map();
    for (const item of Array.isArray(cart) ? cart : []) {
        if (isSyntheticCartLine(item)) continue;
        const productId = String(item?._originalId || item?.id || '');
        if (!productId) continue;
        const qty = calculateItemStockDeduction(item);
        if (!(qty > 0)) continue;
        const prev = totals.get(productId) || 0;
        totals.set(productId, isGranelProduct(item) ? round3(prev + qty) : prev + qty);
    }
    return [...totals.entries()].map(([product_id, qty]) => ({ product_id, qty }));
}

/** Lo que viaja al servidor por una venta (sin datos pesados). */
export function toServerSale(sale, items) {
    return {
        id: sale.nubeId,
        items,
        total_usd: sale.totalUsd ?? null,
        total_bs: sale.totalBs ?? null,
        rate: sale.rate ?? sale.effectiveRate ?? null,
        device_at: sale.timestamp || new Date().toISOString(),
        payload: {
            localId: sale.id ?? null,
            saleNumber: sale.saleNumber ?? null,
            customerId: sale.customerId ?? null,
            customerName: sale.customerName ?? null,
            payments: sale.payments ?? [],
            fiadoUsd: sale.fiadoUsd ?? 0,
            items: (sale.items || []).map((i) => ({
                id: i._originalId || i.id, name: i.name, qty: i.qty, priceUsd: i.priceUsd, isWeight: i.isWeight ?? undefined,
            })),
        },
    };
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ data: null, error: { message: 'El servidor tardó demasiado (timeout)', status: 0 } }), ms); }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 * @param {object} deps.client  cliente Supabase del equipo
 * @param {() => string|null} deps.getSession
 * @param {{getItem, setItem}} deps.store
 * @param {() => boolean} [deps.allowNegative]  ¿la cuenta permite vender bajo cero? (como Bodega)
 */
export function createSaleSubmitter({
    client,
    getSession,
    store,
    allowNegative = () => false,
    timeoutMs = 8000,
    onQueueChange = () => {},
    onRejectedChange = () => {},
    onSaleConfirmed = () => {},
    now = () => Date.now(),
    leaseHours = OFFLINE_LEASE_HOURS,
}) {
    let replaying = null;

    const markOnline = () => store.setItem(LAST_ONLINE_KEY, new Date(now()).toISOString());
    /** ¿Sigue vigente el permiso sin internet? (D8: 72 h desde la última vez que habló con el servidor) */
    async function leaseValid() {
        const last = Date.parse((await store.getItem(LAST_ONLINE_KEY)) || '');
        if (!Number.isFinite(last)) return true; // equipo recién registrado: se marca al primer contacto
        return now() - last <= leaseHours * 3_600_000;
    }

    const readQueue = async () => (await store.getItem(SALE_QUEUE_KEY)) || [];
    const writeQueue = async (q) => { await store.setItem(SALE_QUEUE_KEY, q); onQueueChange(q.length); };
    const readRejected = async () => (await store.getItem(SALE_REJECTED_KEY)) || [];
    const writeRejected = async (list) => { await store.setItem(SALE_REJECTED_KEY, list); onRejectedChange(list.length); };

    /** Saca de la cola una venta rechazada para siempre y la guarda aparte (no se pierde). */
    async function setAside(sale, error) {
        const list = await readRejected();
        if (!list.some((r) => r.sale.id === sale.id)) {
            list.push({ sale, error: error?.message || 'El servidor rechazó la venta', code: error?.code ?? null, at: new Date(now()).toISOString() });
            await writeRejected(list);
        }
        await writeQueue((await readQueue()).filter((s) => s.id !== sale.id));
    }

    async function enqueue(serverSale) {
        const q = await readQueue();
        if (!q.some((s) => s.id === serverSale.id)) q.push(serverSale);
        await writeQueue(q);
    }

    async function call(serverSale, offline) {
        const session = getSession();
        // A2: sin sesión estando online NO se trata como error de red (`status: 0`);
        // evita que una sesión vencida salte la validación de stock del servidor.
        if (!session) {
            return {
                data: null,
                error: { message: 'Tu sesión venció. Vuelve a entrar con tu PIN.', code: '42501', status: 401 },
            };
        }
        return withTimeout(client.rpc('process_checkout', {
            p_session: session, p_sale: serverSale, p_offline: offline, p_allow_negative: Boolean(allowNegative()),
        }), timeoutMs);
    }

    /**
     * Devuelve:
     *   { ok: true, number, saleId, shortages }    registrada en el servidor
     *   { ok: true, queued: true }                 sin internet: quedó en la cola
     *   { ok: false, message }                     el servidor la rechazó (p. ej. sin stock)
     */
    async function submit(serverSale) {
        // Si hay ventas viejas en cola y el navegador parece online, drenar primero en orden
        // FIFO para que la venta nueva valide stock en línea (A2).
        if ((await readQueue()).length) {
            const online = typeof navigator === 'undefined' || navigator.onLine !== false;
            if (online) await replay();
        }
        if ((await readQueue()).length) {
            if (!(await leaseValid())) {
                return { ok: false, message: `Llevas más de ${leaseHours} horas sin internet. Conéctate para seguir vendiendo.` };
            }
            await enqueue(serverSale);
            replay();
            return { ok: true, queued: true };
        }
        const { data, error } = await call(serverSale, false);
        if (error) {
            if (isNetworkError(error)) {
                if (!(await leaseValid())) {
                    return { ok: false, message: `Llevas más de ${leaseHours} horas sin internet. Conéctate para seguir vendiendo.` };
                }
                await enqueue(serverSale);
                return { ok: true, queued: true };
            }
            return { ok: false, message: error.message || 'El servidor rechazó la venta' };
        }
        await markOnline();
        const row = Array.isArray(data) ? data[0] : data;
        return { ok: true, number: row?.number ?? null, saleId: row?.sale_id ?? serverSale.id, shortages: row?.shortages ?? [] };
    }

    /**
     * Sube la cola en orden. Ante un error pasajero (red, sesión) se detiene y lo no
     * confirmado queda. Una venta que el servidor rechaza para siempre se aparta a
     * «ventas con problema» y la cola sigue: si no, esa venta bloqueaba la cola y la caja
     * seguía vendiendo como sin internet, sin control de stock (S3).
     */
    function replay() {
        if (replaying) return replaying;
        replaying = (async () => {
            const results = [];
            try {
                for (;;) {
                    const q = await readQueue();
                    if (!q.length) break;
                    const next = q[0];
                    const { data, error } = await call(next, true);
                    if (error && isDefinitiveRejection(error)) {
                        await setAside(next, error);
                        results.push({ id: next.id, error: error.message, rejected: true });
                        continue;
                    }
                    if (error) { results.push({ id: next.id, error: error.message }); break; }
                    await markOnline();
                    const row = Array.isArray(data) ? data[0] : data;
                    results.push({ id: next.id, number: row?.number, already: row?.already_registered, shortages: row?.shortages });
                    const rest = (await readQueue()).filter((s) => s.id !== next.id);
                    await writeQueue(rest);
                    try {
                        await onSaleConfirmed(next.id, row?.number ?? null);
                    } catch { /* nunca abortar replay por actualización de UI */ }
                }
            } finally {
                replaying = null;
            }
            return results;
        })();
        return replaying;
    }

    /** Vuelve a poner en la cola las ventas apartadas (p. ej. tras corregir el problema). */
    async function retryRejected() {
        const list = await readRejected();
        if (!list.length) return 0;
        const q = await readQueue();
        for (const r of list) if (!q.some((s) => s.id === r.sale.id)) q.push(r.sale);
        await writeQueue(q);
        await writeRejected([]);
        replay();
        return list.length;
    }

    /** Descarta una venta rechazada definitivamente (o aún en cola) al anularla localmente (C5). */
    async function discardRejected(saleId) {
        if (!saleId) return false;
        const target = String(saleId);
        const list = await readRejected();
        const nextRejected = list.filter((r) => String(r?.sale?.id) !== target);
        const removedFromRejected = nextRejected.length !== list.length;
        if (removedFromRejected) await writeRejected(nextRejected);

        const q = await readQueue();
        const nextQueue = q.filter((s) => String(s?.id) !== target);
        const removedFromQueue = nextQueue.length !== q.length;
        if (removedFromQueue) await writeQueue(nextQueue);

        return removedFromRejected || removedFromQueue;
    }

    return {
        submit, replay, pending: async () => (await readQueue()).length, readQueue, leaseValid, markOnline,
        rejected: readRejected, retryRejected, discardRejected,
    };
}

/** Niveles de stock del servidor para la sede del equipo: { product_id: qty }. */
export async function fetchStockLevels(client, sedeId) {
    const levels = {};
    let from = 0;
    const page = 1000;
    for (;;) {
        let query = client.from('stock_levels').select('product_id, qty');
        if (sedeId) query = query.eq('sede_id', sedeId);
        const { data, error } = await (query.range ? query.order('product_id').range(from, from + page - 1) : query.order('product_id'));
        if (error) throw new Error(error.message || 'No se pudo leer el stock');
        for (const row of data || []) levels[row.product_id] = Number(row.qty);
        if (!data || data.length < page || !query.range) break;
        from += page;
    }
    return levels;
}

/**
 * Solo los niveles que cambiaron desde `since` (S5): { levels: { product_id: { qty, at } },
 * newest }. `since` null = todos (la primera lectura de la sesión).
 */
export async function fetchStockChanges(client, sedeId, since = null) {
    const { rows, newest } = await fetchChangedRows(client, 'stock_levels', {
        select: 'product_id, qty, updated_at',
        key: 'product_id',
        since,
        filter: (q) => (sedeId ? q.eq('sede_id', sedeId) : q),
    });
    const levels = {};
    for (const r of rows) levels[r.product_id] = { qty: Number(r.qty), at: r.updated_at };
    return { levels, newest };
}

/**
 * Funde niveles nuevos en lo ya conocido sin retroceder: un nivel con hora más vieja que
 * el que ya se tiene (p. ej. una lectura que empezó antes de un aviso en vivo) se ignora.
 * Devuelve cuántos cambiaron.
 */
export function mergeKnownLevels(known, incoming) {
    let changed = 0;
    for (const [id, lv] of Object.entries(incoming)) {
        const cur = known[id];
        if (cur && cur.at && lv.at && Date.parse(lv.at) < Date.parse(cur.at)) continue;
        if (!cur || cur.qty !== lv.qty || cur.at !== lv.at) changed += 1;
        known[id] = lv;
    }
    return changed;
}

/** Escribe el stock del servidor en la copia local de productos (solo los que tienen nivel). */
export function applyLevels(products, levels) {
    if (!Array.isArray(products)) return { products, changed: 0 };
    let changed = 0;
    const next = products.map((p) => {
        const id = String(p?.id ?? '');
        if (!(id in levels)) return p;
        const qty = levels[id];
        if (Number(p.stock) === qty) return p;
        changed += 1;
        return { ...p, stock: qty };
    });
    return { products: next, changed };
}

/** Compras, ajustes, conteos o stock inicial (dueño o administrador). */
export async function moveStock(client, session, reason, movements, { reference = null } = {}) {
    const list = movements.map((m) => ({ id: m.id || safeUuid(), product_id: String(m.product_id), qty: m.qty, note: m.note ?? null }));
    const { data, error } = await client.rpc('process_stock_movements', {
        p_session: session, p_reason: reason, p_movements: list, p_reference: reference,
    });
    if (error) {
        const err = new Error(error.message || 'No se pudo mover el inventario');
        if (error.code !== undefined) err.code = error.code;
        if (error.status !== undefined) err.status = error.status;
        if (error.details !== undefined) err.details = error.details;
        throw err;
    }
    return data;
}

export async function voidSale(client, session, saleId, reason) {
    const { data, error } = await client.rpc('process_void', { p_session: session, p_sale_id: saleId, p_reason: reason ?? null });
    if (error) {
        const err = new Error(error.message || 'No se pudo anular la venta');
        if (error.code !== undefined) err.code = error.code;
        if (error.status !== undefined) err.status = error.status;
        if (error.details !== undefined) err.details = error.details;
        throw err;
    }
    return Array.isArray(data) ? data[0] : data;
}
