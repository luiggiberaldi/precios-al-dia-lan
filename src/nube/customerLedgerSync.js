/**
 * Libro de clientes en la nube para la caja (F4).
 *
 * La app heredada sigue anotando fiados, abonos y vueltos en su libro local
 * (bodega_customer_ledger_v1). Este módulo:
 *   · sube cada movimiento NUEVO del libro local (por id: reenviar no duplica, G7);
 *   · baja los movimientos de las otras cajas para que el historial se vea igual en todas;
 *   · baja el SALDO OFICIAL de cada cliente (lo calcula el servidor) y lo pone en la
 *     copia local, así dos cajas nunca muestran saldos distintos (E5).
 * La cola de pendientes nunca se vacía sola (G10).
 */
import { mergeLedgerEntries, snapshotCustomerBalance } from '../utils/customerLedger.js';
import { fetchChangedRows, sinceWithOverlap, CHANGES_OVERLAP_MS } from './changedRows.js';

export const LEDGER_KEY = 'bodega_customer_ledger_v1';
export const CUSTOMERS_KEY = 'bodega_customers_v1';
const STATE_KEY = 'pdn_customer_ledger_v1';
const BATCH = 300;

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

/** Pone el saldo oficial en cada cliente local (deuda/favor). */
export function applyBalances(customers, balances) {
    if (!Array.isArray(customers)) return { customers, changed: 0 };
    let changed = 0;
    const next = customers.map((c) => {
        const id = String(c?.id ?? '');
        if (!(id in balances)) return c;
        const current = Math.round(((Number(c.favor) || 0) - (Number(c.deuda) || 0)) * 100) / 100;
        if (current === balances[id]) return c;
        changed += 1;
        return snapshotCustomerBalance(c, balances[id], { incrementVersion: false });
    });
    return { customers: next, changed };
}

export function createCustomerLedgerSync({ client, getSession, store, readLocal, writeLocal, onStatus = () => {}, overlapMs = CHANGES_OVERLAP_MS }) {
    let flushing = null;
    let lastError = null;
    // S5: saldos conocidos en esta sesión (customer_id → { balance, at }) y hasta dónde se
    // leyó. Se baja solo lo cambiado y se aplica TODO lo conocido: el saldo de un cliente
    // que aún no bajó a esta caja se aplica cuando el cliente aparezca.
    const knownBalances = {};
    let balancesCursor = null;

    const load = async () => ({ confirmed: [], queue: [], lastSeq: 0, ...((await store.getItem(STATE_KEY)) || {}) });
    const save = (s) => store.setItem(STATE_KEY, s);

    async function onLedgerWrite(ledger) {
        if (!Array.isArray(ledger)) return 0;
        const state = await load();
        const known = new Set([...state.confirmed, ...state.queue.map((m) => m.id)]);
        let added = 0;
        for (const m of ledger) {
            if (!m?.id || !m.customerId || known.has(String(m.id)) || m.nubeSeq) continue;
            state.queue.push(toServerMovement(m));
            known.add(String(m.id));
            added += 1;
        }
        await save(state);
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
                    if (error) { lastError = error.message || 'No se pudo subir la cartera'; break; }
                    const ok = new Set((Array.isArray(data) ? data : []).map((r) => r.id));
                    const fresh = await load();
                    fresh.queue = fresh.queue.filter((m) => !ok.has(m.id));
                    fresh.confirmed = [...new Set([...fresh.confirmed, ...ok])].slice(-20000);
                    await save(fresh);
                    lastError = null;
                    if (!ok.size) break;
                }
            } finally {
                flushing = null;
                onStatus({ lastError, pending: (await load()).queue.length });
            }
        })();
        return flushing;
    }

    /** Baja movimientos de otras cajas y el saldo oficial; los escribe en la copia local. */
    async function pull() {
        try {
            const state = await load();
            const rows = [];
            let cursor = state.lastSeq || 0;
            for (;;) {
                const { data, error } = await client.from('customer_movements')
                    .select('id, customer_id, type, direction, amount_usd, balance_after, source_type, source_id, source_sale_id, reversal_of, reason, device_at, server_at, seq')
                    .gt('seq', cursor).order('seq').limit(500);
                if (error) throw new Error(error.message);
                rows.push(...(data || []));
                if (!data || data.length < 500) break;
                cursor = data[data.length - 1].seq;
            }
            if (rows.length) {
                const local = (await readLocal(LEDGER_KEY)) || [];
                const remote = rows.map(toLocalMovement);
                const byId = new Map(local.map((m) => [String(m.id), m]));
                // Lo propio ya está: se completa con el saldo oficial; lo ajeno se agrega.
                for (const r of remote) {
                    const mine = byId.get(r.id);
                    if (mine) byId.set(r.id, { ...mine, balanceAfterUsd: r.balanceAfterUsd, balanceBeforeUsd: r.balanceBeforeUsd, nubeSeq: r.nubeSeq });
                }
                const { ledger } = mergeLedgerEntries([...byId.values()], remote.filter((r) => !local.some((m) => String(m.id) === r.id)));
                await writeLocal(LEDGER_KEY, ledger);
                const fresh = await load();
                fresh.lastSeq = Math.max(fresh.lastSeq || 0, ...rows.map((r) => Number(r.seq)));
                fresh.confirmed = [...new Set([...fresh.confirmed, ...rows.map((r) => r.id)])].slice(-20000);
                fresh.queue = fresh.queue.filter((m) => !rows.some((r) => r.id === m.id));
                await save(fresh);
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
            const balances = Object.fromEntries(Object.entries(knownBalances).map(([id, b]) => [id, b.balance]));
            const customers = (await readLocal(CUSTOMERS_KEY)) || [];
            const { customers: next, changed } = applyBalances(customers, balances);
            if (changed) await writeLocal(CUSTOMERS_KEY, next);
            lastError = null;
            return rows.length;
        } catch (e) {
            lastError = e?.message || String(e);
            return 0;
        } finally {
            onStatus({ lastError, pending: (await load()).queue.length });
        }
    }

    return { onLedgerWrite, flush, pull, pending: async () => (await load()).queue.length, getLastError: () => lastError };
}
