/**
 * Libro append-only de cuentas por pagar a proveedores (T20 · ALT-15).
 *
 * Evita que dos cajas pagando o cargando facturas al mismo proveedor se pisen la
 * `deuda` vía LWW en `bodega_suppliers_v1`. Cada movimiento tiene UUID estable
 * y se suma atómicamente en el servidor (`push_supplier_movements` -> `supplier_balances`).
 */
import { fetchChangedRows, sinceWithOverlap, CHANGES_OVERLAP_MS } from './changedRows.js';
import { withLock } from '../utils/withLock.js';
import { round2 } from '../utils/dinero.js';
import { safeUuid } from '../utils/safeUuid.js';

export const SUPPLIER_LEDGER_KEY = 'bodega_supplier_ledger_v1';
export const SUPPLIERS_KEY = 'bodega_suppliers_v1';
export const SUPPLIER_LEDGER_REJECTED_KEY = 'pdn_supplier_ledger_rejected_v1';
const STATE_KEY = 'pdn_supplier_ledger_v1';
const BATCH = 300;

function isPermanentDataError(error) {
    return /^2[23]/.test(String(error?.code || ''));
}

export function buildSupplierMovement({
    id = safeUuid(),
    supplierId,
    type,
    direction,
    amountUsd,
    invoiceId = null,
    sourceId = null,
    reason = null,
    timestamp = new Date().toISOString(),
}) {
    return {
        id: String(id),
        supplierId: String(supplierId),
        type,
        direction: direction || (['PAGO', 'AJUSTE_CREDITO'].includes(type) ? 'CREDIT' : 'DEBIT'),
        amountUsd: Math.max(0, round2(Number(amountUsd) || 0)),
        invoiceId: invoiceId ? String(invoiceId) : null,
        sourceId: sourceId ? String(sourceId) : null,
        reason: reason || type,
        timestamp,
    };
}

export function toServerSupplierMovement(m) {
    return {
        id: String(m.id),
        supplier_id: String(m.supplierId),
        type: m.type,
        direction: m.direction,
        amount_usd: Number(m.amountUsd),
        invoice_id: m.invoiceId ?? null,
        source_id: m.sourceId ?? null,
        reason: m.reason ?? null,
        device_at: m.timestamp ?? null,
    };
}

export function toLocalSupplierMovement(r) {
    return {
        id: r.id,
        supplierId: r.supplier_id,
        type: r.type,
        direction: r.direction,
        amountUsd: Number(r.amount_usd),
        debtAfterUsd: Number(r.debt_after),
        invoiceId: r.invoice_id ?? null,
        sourceId: r.source_id ?? null,
        reason: r.reason ?? r.type,
        timestamp: new Date(r.device_at || r.server_at).toISOString(),
        nubeSeq: Number(r.seq),
    };
}

export function applySupplierBalances(suppliers, balances, { skipIds = new Set() } = {}) {
    if (!Array.isArray(suppliers)) return { suppliers, changed: 0 };
    let changed = 0;
    const next = suppliers.map((s) => {
        const id = String(s?.id ?? '');
        if (!(id in balances) || skipIds.has(id)) return s;
        const target = Math.max(0, round2(Number(balances[id]) || 0));
        const current = round2(Number(s.deuda) || 0);
        if (Math.abs(current - target) < 0.005) return s;
        changed += 1;
        return { ...s, deuda: target };
    });
    return { suppliers: next, changed };
}

export function mergeSupplierLedgerEntries(localEntries = [], remoteEntries = []) {
    const byId = new Map();
    for (const e of Array.isArray(localEntries) ? localEntries : []) {
        if (e?.id) byId.set(String(e.id), e);
    }
    for (const r of Array.isArray(remoteEntries) ? remoteEntries : []) {
        if (!r?.id) continue;
        const prev = byId.get(String(r.id));
        byId.set(String(r.id), prev ? { ...prev, ...r } : r);
    }
    return [...byId.values()].sort((a, b) => {
        const aSeq = Number.isFinite(Number(a?.nubeSeq)) ? Number(a.nubeSeq) : null;
        const bSeq = Number.isFinite(Number(b?.nubeSeq)) ? Number(b.nubeSeq) : null;
        if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
        if (aSeq !== null && bSeq === null) return -1;
        if (aSeq === null && bSeq !== null) return 1;
        return (Date.parse(a?.timestamp) || 0) - (Date.parse(b?.timestamp) || 0);
    });
}

export function createSupplierLedgerSync({
    client,
    getSession,
    store,
    readLocal,
    writeLocal,
    withLocalLock = (fn) => fn(),
    canPush = () => true,
    onStatus = () => {},
    overlapMs = CHANGES_OVERLAP_MS,
}) {
    let flushing = null;
    let pulling = null;
    let pullAgain = false;
    let lastError = null;
    const knownBalances = {};
    let balancesCursor = null;

    const inTurn = (fn) => withLock('pdn_supplier_ledger_turn', fn, { fallbackWarning: false });
    const load = async () => ({ confirmed: [], queue: [], lastServerAt: null, ...((await store.getItem(STATE_KEY)) || {}) });
    const save = (s) => store.setItem(STATE_KEY, s);

    async function quarantineMovements(items) {
        if (!items.length) return;
        const prev = (await store.getItem(SUPPLIER_LEDGER_REJECTED_KEY)) || [];
        await store.setItem(SUPPLIER_LEDGER_REJECTED_KEY, [...prev, ...items].slice(-200));
    }

    async function onLedgerWrite(ledger) {
        if (!Array.isArray(ledger) || !canPush()) return 0;
        const added = await inTurn(async () => {
            const s = await load();
            const known = new Set([...s.confirmed, ...s.queue.map((m) => m.id)]);
            let count = 0;
            for (const m of ledger) {
                if (!m || !m.id || !m.supplierId) continue;
                const id = String(m.id);
                if (known.has(id)) continue;
                s.queue.push(toServerSupplierMovement(m));
                known.add(id);
                count += 1;
            }
            if (count) await save(s);
            return count;
        });
        if (added) {
            onStatus({ pending: await pendingCount(), lastError });
            flush();
        }
        return added;
    }

    async function flush() {
        if (flushing) return flushing;
        flushing = (async () => {
            let sent = 0;
            try {
                if (!canPush()) return 0;
                const session = getSession?.();
                if (!session) return 0;
                while (true) {
                    const snapshot = await inTurn(async () => {
                        const s = await load();
                        return s.queue.slice(0, BATCH);
                    });
                    if (!snapshot.length) break;

                    const { error } = await client.rpc('push_supplier_movements', {
                        p_session: session,
                        p_movements: snapshot,
                    });
                    if (error) {
                        if (isPermanentDataError(error)) {
                            const badIds = new Set();
                            const quarantined = [];
                            for (const item of snapshot) {
                                const single = await client.rpc('push_supplier_movements', {
                                    p_session: session,
                                    p_movements: [item],
                                });
                                if (single.error && isPermanentDataError(single.error)) {
                                    badIds.add(item.id);
                                    quarantined.push({ ...item, error: single.error.message, code: single.error.code, rejectedAt: new Date().toISOString() });
                                } else if (!single.error) {
                                    sent += 1;
                                } else {
                                    throw new Error(single.error.message || 'Error subiendo movimiento de proveedor');
                                }
                            }
                            if (quarantined.length) await quarantineMovements(quarantined);
                            const processedIds = new Set(snapshot.map((m) => m.id));
                            await inTurn(async () => {
                                const s = await load();
                                s.queue = s.queue.filter((m) => !processedIds.has(m.id));
                                for (const m of snapshot) {
                                    if (!badIds.has(m.id) && !s.confirmed.includes(m.id)) s.confirmed.push(m.id);
                                }
                                await save(s);
                            });
                            continue;
                        }
                        throw new Error(error.message || 'No se pudieron subir los movimientos de proveedores');
                    }

                    const batchIds = new Set(snapshot.map((m) => m.id));
                    await inTurn(async () => {
                        const s = await load();
                        s.queue = s.queue.filter((m) => !batchIds.has(m.id));
                        for (const id of batchIds) {
                            if (!s.confirmed.includes(id)) s.confirmed.push(id);
                        }
                        if (s.confirmed.length > 5000) s.confirmed = s.confirmed.slice(-5000);
                        await save(s);
                    });
                    sent += snapshot.length;
                }
                lastError = null;
            } catch (e) {
                lastError = e?.message || 'Error al sincronizar proveedores';
            } finally {
                flushing = null;
                onStatus({ pending: await pendingCount(), lastError });
            }
            return sent;
        })();
        return flushing;
    }

    async function applyKnownBalances() {
        const balancesMap = Object.fromEntries(Object.entries(knownBalances).map(([id, v]) => [id, v.debt]));
        if (!Object.keys(balancesMap).length) return 0;
        const s = await inTurn(() => load());
        const skipIds = new Set(s.queue.map((m) => String(m.supplier_id)));
        return withLocalLock(async () => {
            const currentSuppliers = await readLocal(SUPPLIERS_KEY);
            const { suppliers: nextSuppliers, changed } = applySupplierBalances(currentSuppliers, balancesMap, { skipIds });
            if (changed) await writeLocal(SUPPLIERS_KEY, nextSuppliers);
            return changed;
        });
    }

    async function pullOnce() {
        const stateBefore = await inTurn(() => load());
        const movSince = sinceWithOverlap(stateBefore.lastServerAt, overlapMs);
        const { rows: movRows, newest: movMaxAt } = await fetchChangedRows(client, 'supplier_movements', {
            select: 'id, seq, supplier_id, type, direction, amount_usd, debt_after, invoice_id, source_id, reason, device_at, server_at',
            key: 'id',
            since: movSince,
            timeCol: 'server_at',
        });

        const balSince = sinceWithOverlap(balancesCursor, overlapMs);
        const { rows: balRows, newest: balMaxAt } = await fetchChangedRows(client, 'supplier_balances', {
            select: 'supplier_id, debt_usd, updated_at',
            key: 'supplier_id',
            since: balSince,
            timeCol: 'updated_at',
        });
        if (balMaxAt) balancesCursor = balMaxAt;
        for (const row of balRows) {
            knownBalances[String(row.supplier_id)] = { debt: Number(row.debt_usd) || 0, at: row.updated_at };
        }

        const remoteLocalMovs = movRows.map(toLocalSupplierMovement);
        if (remoteLocalMovs.length) {
            await withLocalLock(async () => {
                const cur = await readLocal(SUPPLIER_LEDGER_KEY);
                const merged = mergeSupplierLedgerEntries(Array.isArray(cur) ? cur : [], remoteLocalMovs);
                await writeLocal(SUPPLIER_LEDGER_KEY, merged);
            });
            await inTurn(async () => {
                const s = await load();
                if (movMaxAt && (!s.lastServerAt || movMaxAt > s.lastServerAt)) s.lastServerAt = movMaxAt;
                for (const r of movRows) {
                    if (!s.confirmed.includes(r.id)) s.confirmed.push(r.id);
                }
                if (s.confirmed.length > 5000) s.confirmed = s.confirmed.slice(-5000);
                await save(s);
            });
        }

        await applyKnownBalances();
        lastError = null;
        return { movements: movRows.length, balances: balRows.length };
    }

    async function pull() {
        if (pulling) {
            pullAgain = true;
            return pulling;
        }
        pulling = (async () => {
            try {
                let res = await pullOnce();
                while (pullAgain) {
                    pullAgain = false;
                    res = await pullOnce();
                }
                return res;
            } catch (e) {
                lastError = e?.message || 'Error leyendo libro de proveedores';
                return { movements: 0, balances: 0 };
            } finally {
                pulling = null;
                onStatus({ pending: await pendingCount(), lastError });
            }
        })();
        return pulling;
    }

    async function pendingCount() {
        const s = await load();
        return s.queue.length;
    }

    return {
        onLedgerWrite,
        flush,
        pull,
        applyKnownBalances,
        pendingCount,
        getLastError: () => lastError,
    };
}
