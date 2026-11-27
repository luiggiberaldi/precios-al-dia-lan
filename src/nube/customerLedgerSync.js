/**
 * Libro de clientes en la nube para la caja (F4).
 *
 * La app heredada sigue anotando fiados, abonos y vueltos en su libro local
 * (bodega_customer_ledger_v1). Este módulo:
 *   · sube cada movimiento NUEVO del libro local (por id: reenviar no duplica, G7);
 *   · baja los movimientos de las otras cajas para que el historial se vea igual en todas;
 *   · baja el SALDO OFICIAL de cada cliente (lo calcula el servidor) y lo pone en la
 *     copia local — SALVO para clientes con movimientos pendientes en cola local (C6);
 *   · serializa todas las mutaciones con `pdn_ledger_turn` y `withLocalLock(pos_write_lock)`;
 *   · aísla poison-pills clase 22/23 a `pdn_ledger_rejected_v1` sin trabar la cola (C8).
 * La cola de pendientes nunca se vacía sola ante errores pasajeros (G10).
 */
import { mergeLedgerEntries, snapshotCustomerBalance } from '../utils/customerLedger.js';
import { fetchChangedRows, sinceWithOverlap, CHANGES_OVERLAP_MS } from './changedRows.js';
import { withLock } from '../utils/withLock.js';

export const LEDGER_KEY = 'bodega_customer_ledger_v1';
export const CUSTOMERS_KEY = 'bodega_customers_v1';
export const LEDGER_REJECTED_KEY = 'pdn_ledger_rejected_v1';
const STATE_KEY = 'pdn_customer_ledger_v1';
const BATCH = 300;

function isPermanentDataError(error) {
    return /^2[23]/.test(String(error?.code || ''));
}

/** Movimiento local → forma del servidor. */
export function toServerMovement(m) {
    return {
        id: String(m.id),
        customer_id: String(m.customerId),
        type: m.type,
        direction: m.direction,
        amount_usd: Number(m.amountUsd),
        source_type: m.sourceType ?? null,
        source_id: m.sourceId ?? null,
        source_sale_id: m.sourceSaleId ?? null,
        reversal_of: m.reversalOf ?? null,
        reason: m.reason ?? null,
        device_at: m.timestamp ?? null,
    };
}

/** Movimiento del servidor → forma del libro local. */
export function toLocalMovement(r) {
    const amount = Number(r.amount_usd);
    const after = Number(r.balance_after);
    return {
        id: r.id,
        customerId: r.customer_id,
        type: r.type,
        direction: r.direction,
        amountUsd: amount,
        currency: 'USD',
        balanceBeforeUsd: Math.round((after + (r.direction === 'CREDIT' ? -amount : amount)) * 100) / 100,
        balanceAfterUsd: after,
        sourceType: r.source_type ?? 'MANUAL',
        sourceId: r.source_id ?? null,
        sourceSaleId: r.source_sale_id ?? null,
        reason: r.reason ?? r.type,
        timestamp: new Date(r.device_at || r.server_at).toISOString(),
        reversalOf: r.reversal_of ?? null,
        status: 'COMPLETED',
        nubeSeq: Number(r.seq),
    };
}

/** Pone el saldo oficial en cada cliente local (deuda/favor), omitiendo clientes con movimientos pendientes. */
export function applyBalances(customers, balances, { skipIds = new Set() } = {}) {
    if (!Array.isArray(customers)) return { customers, changed: 0 };
    let changed = 0;
    const next = customers.map((c) => {
        const id = String(c?.id ?? '');
        if (!(id in balances) || skipIds.has(id)) return c;
        const favor = Number(c.favor) || 0;
        const deuda = Number(c.deuda) || 0;
        const current = Math.round((favor - deuda) * 100) / 100;
        // MED-11: normalizar si ambos favor y deuda son > 0 aunque el neto coincida.
        const hasBothPositive = favor > 0 && deuda > 0;
        if (current === balances[id] && !hasBothPositive) return c;
        changed += 1;
        return snapshotCustomerBalance(c, balances[id], { incrementVersion: false });
    });
    return { customers: next, changed };
}

export function createCustomerLedgerSync({
    client,
    getSession,
    store,
    readLocal,
    writeLocal,
    withLocalLock = (fn) => fn(),
    onStatus = () => {},
    overlapMs = CHANGES_OVERLAP_MS,
}) {
    let flushing = null;
    let pulling = null;
    let pullAgain = false;
    let lastError = null;
    // S5: saldos conocidos en esta sesión (customer_id → { balance, at }) y hasta dónde se
    // leyó. Se baja solo lo cambiado y se aplica TODO lo conocido: el saldo de un cliente
    // que aún no bajó a esta caja se aplica cuando el cliente aparezca.
    const knownBalances = {};
    let balancesCursor = null;

    const inTurn = (fn) => withLock('pdn_ledger_turn', fn, { fallbackWarning: false });
    const load = async () => ({ confirmed: [], queue: [], lastSeq: 0, lastServerAt: null, ...((await store.getItem(STATE_KEY)) || {}) });
    const save = (s) => store.setItem(STATE_KEY, s);

    async function quarantineMovements(items) {
        if (!items.length) return;
        const prev = (await store.getItem(LEDGER_REJECTED_KEY)) || [];
        await store.setItem(LEDGER_REJECTED_KEY, [...prev, ...items].slice(-200));
    }

    async function onLedgerWrite(ledger) {
        if (!Array.isArray(ledger)) return 0;
        const added = await inTurn(async () => {
            const state = await load();
            const known = new Set([...state.confirmed, ...state.queue.map((m) => m.id)]);
            let count = 0;
            for (const m of ledger) {
                if (!m?.id || !m.customerId || known.has(String(m.id)) || m.nubeSeq) continue;
                state.queue.push(toServerMovement(m));
                known.add(String(m.id));
                count += 1;
            }
            if (count > 0) await save(state);
            return count;
        });
        if (added) flush();
        return added;
    }

    function flush() {
        if (flushing) return flushing;
        flushing = (async () => {
            try {
                for (;;) {
                    const state = await load();
                    if (!state.queue.length) break;
                    const session = getSession();
                    if (!session) break;
                    const batch = state.queue.slice(0, BATCH);
                    const { data, error } = await client.rpc('push_customer_movements', { p_session: session, p_movements: batch });

                    const okIds = new Set();
                    const quarantined = [];
                    let transientError = null;

                    if (!error) {
                        for (const r of Array.isArray(data) ? data : []) okIds.add(r.id);
                    } else if (isPermanentDataError(error)) {
                        // C8: Aislar poison-pills uno a uno sin trabar los movimientos válidos detrás.
                        if (batch.length === 1) {
                            quarantined.push({ ...batch[0], error: error.message, code: error.code, at: new Date().toISOString() });
                        } else {
                            for (const item of batch) {
                                const single = await client.rpc('push_customer_movements', { p_session: session, p_movements: [item] });
                                if (!single.error) {
                                    for (const r of Array.isArray(single.data) ? single.data : []) okIds.add(r.id);
                                } else if (isPermanentDataError(single.error)) {
                                    quarantined.push({ ...item, error: single.error.message, code: single.error.code, at: new Date().toISOString() });
                                } else {
                                    transientError = single.error;
                                    break;
                                }
                            }
                        }
                        if (quarantined.length) await quarantineMovements(quarantined);
                    } else {
                        lastError = error.message || 'No se pudo subir la cartera';
                        break;
                    }

                    const quarantinedIds = new Set(quarantined.map((m) => m.id));
                    if (okIds.size || quarantinedIds.size) {
                        await inTurn(async () => {
                            const fresh = await load();
                            fresh.queue = fresh.queue.filter((m) => !okIds.has(m.id) && !quarantinedIds.has(m.id));
                            fresh.confirmed = [...new Set([...fresh.confirmed, ...okIds])].slice(-20000);
                            await save(fresh);
                        });
                    }
                    if (transientError) {
                        lastError = transientError.message || 'No se pudo subir la cartera';
                        break;
                    }
                    lastError = quarantined.length
                        ? `Se apartó ${quarantined.length} movimiento(s) de cartera inválido(s) para no trabar la cola.`
                        : null;
                    if (!okIds.size && !quarantinedIds.size) break;
                }
            } finally {
                flushing = null;
                onStatus({ lastError, pending: (await load()).queue.length });
            }
        })();
        return flushing;
    }

    /** Re-aplica los saldos oficiales conocidos en memoria omitiendo clientes con cola local pendiente (A4, C6). */
    async function applyKnownBalances() {
        const balances = Object.fromEntries(Object.entries(knownBalances).map(([id, b]) => [id, b.balance]));
        if (!Object.keys(balances).length) return 0;
        return inTurn(async () => {
            const state = await load();
            const skipIds = new Set(state.queue.map((m) => String(m.customer_id)));
            return withLocalLock(async () => {
                const customers = (await readLocal(CUSTOMERS_KEY)) || [];
                const { customers: next, changed } = applyBalances(customers, balances, { skipIds });
                if (changed) await writeLocal(CUSTOMERS_KEY, next);
                return changed;
            });
        });
    }

    async function pullOnce() {
        const state = await load();
        // C7: cursor por server_at con solapamiento de 60s (en vez de gt('seq', lastSeq))
        // para que un movimiento cuyo seq se asignó antes pero confirmó tarde nunca se salte.
        const { rows, newest: newestMovAt } = await fetchChangedRows(client, 'customer_movements', {
            select: 'id, customer_id, type, direction, amount_usd, balance_after, source_type, source_id, source_sale_id, reversal_of, reason, device_at, server_at, seq',
            key: 'id',
            timeCol: 'server_at',
            since: sinceWithOverlap(state.lastServerAt, overlapMs),
            page: 500,
        });
        if (rows.length) {
            await inTurn(async () => {
                await withLocalLock(async () => {
                    const local = (await readLocal(LEDGER_KEY)) || [];
                    const remote = rows.map(toLocalMovement);
                    const byId = new Map(local.map((m) => [String(m.id), m]));
                    let mutated = false;
                    // Lo propio ya está: se completa con el saldo oficial y nubeSeq; lo ajeno se agrega.
                    for (const r of remote) {
                        const mine = byId.get(r.id);
                        if (mine) {
                            if (mine.balanceAfterUsd !== r.balanceAfterUsd || mine.balanceBeforeUsd !== r.balanceBeforeUsd || mine.nubeSeq !== r.nubeSeq) {
                                byId.set(r.id, { ...mine, balanceAfterUsd: r.balanceAfterUsd, balanceBeforeUsd: r.balanceBeforeUsd, nubeSeq: r.nubeSeq });
                                mutated = true;
                            }
                        } else {
                            mutated = true;
                        }
                    }
                    if (mutated) {
                        const { ledger } = mergeLedgerEntries([...byId.values()], remote.filter((r) => !byId.has(r.id)));
                        await writeLocal(LEDGER_KEY, ledger);
                    }
                });
                const fresh = await load();
                fresh.lastSeq = Math.max(fresh.lastSeq || 0, ...rows.map((r) => Number(r.seq)));
                if (newestMovAt && (!fresh.lastServerAt || newestMovAt > fresh.lastServerAt)) {
                    fresh.lastServerAt = newestMovAt;
                }
                fresh.confirmed = [...new Set([...fresh.confirmed, ...rows.map((r) => r.id)])].slice(-20000);
                fresh.queue = fresh.queue.filter((m) => !rows.some((r) => r.id === m.id));
                await save(fresh);
            });
        }

        const { rows: bal, newest } = await fetchChangedRows(client, 'customer_balances', {
            select: 'customer_id, balance_usd, updated_at',
            key: 'customer_id',
            since: sinceWithOverlap(balancesCursor, overlapMs),
        });
        for (const b of bal) {
            const cur = knownBalances[b.customer_id];
            if (cur && cur.at && b.updated_at && Date.parse(b.updated_at) < Date.parse(cur.at)) continue;
            knownBalances[b.customer_id] = { balance: Number(b.balance_usd), at: b.updated_at };
        }
        if (newest && (!balancesCursor || newest > balancesCursor)) balancesCursor = newest;
        await applyKnownBalances();
        lastError = null;
        return rows.length;
    }

    /** Baja movimientos de otras cajas y el saldo oficial; single-flight para evitar carreras. */
    function pull() {
        if (pulling) {
            pullAgain = true;
            return pulling;
        }
        pulling = (async () => {
            let total = 0;
            try {
                do {
                    pullAgain = false;
                    total += await pullOnce();
                } while (pullAgain);
                return total;
            } catch (e) {
                lastError = e?.message || String(e);
                pullAgain = false;
                return total;
            } finally {
                pulling = null;
                onStatus({ lastError, pending: (await load()).queue.length });
            }
        })();
        return pulling;
    }

    return {
        onLedgerWrite,
        flush,
        pull,
        applyKnownBalances,
        pending: async () => (await load()).queue.length,
        getLastError: () => lastError,
    };
}
