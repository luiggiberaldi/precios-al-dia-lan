/**
 * casheaLedger.js — Libro aditivo de movimientos Cashea (C9 · T11).
 *
 * `casheaDeuda` es una cuenta por cobrar a Cashea (contraparte distinta al saldo
 * del cliente). Para evitar lost updates por LWW cuando dos cajas registran ventas
 * o remesas Cashea al mismo tiempo, cada impacto se guarda como registro individual
 * inmutable en `bodega_cashea_ledger_v1` (sincronizado por `recordSync` en colección
 * `cashea`), y `casheaDeuda` queda protegido en `keep` de `bodega_customers_v1`.
 */
import { round2 } from './dinero.js';
import { safeUuid } from './safeUuid.js';

export const CASHEA_LEDGER_KEY = 'bodega_cashea_ledger_v1';

export function buildCasheaMovement({
    id,
    customerId,
    type,
    deltaUsd,
    sourceSaleId = null,
    reason = '',
    timestamp = new Date().toISOString(),
}) {
    const delta = round2(Number(deltaUsd) || 0);
    return {
        id: id || `cashea_${safeUuid()}`,
        customerId: String(customerId),
        type: String(type || 'AJUSTE_CASHEA'),
        deltaUsd: delta,
        sourceSaleId: sourceSaleId ? String(sourceSaleId) : null,
        reason: String(reason || type || ''),
        timestamp,
    };
}

/**
 * Recalcula `casheaDeuda` de cada cliente que tenga movimientos en el libro Cashea.
 * Clientes sin movimientos en el libro conservan su valor previo intacto.
 */
export function applyCasheaBalances(customers, ledger) {
    if (!Array.isArray(customers) || !Array.isArray(ledger) || ledger.length === 0) {
        return { customers: Array.isArray(customers) ? customers : [], changed: 0 };
    }
    const totals = new Map();
    for (const m of ledger) {
        if (!m?.customerId) continue;
        const cid = String(m.customerId);
        const prev = totals.get(cid) || 0;
        totals.set(cid, round2(prev + (Number(m.deltaUsd) || 0)));
    }
    let changed = 0;
    const next = customers.map((c) => {
        const cid = String(c?.id ?? '');
        if (!totals.has(cid)) return c;
        const computed = Math.max(0, round2(totals.get(cid)));
        const current = round2(Number(c.casheaDeuda) || 0);
        if (current === computed) return c;
        changed += 1;
        return { ...c, casheaDeuda: computed };
    });
    return { customers: next, changed };
}

/**
 * Agrega un movimiento Cashea al libro local de forma idempotente por `id`.
 * Debe llamarse dentro de `withLock('pos_write_lock')`.
 */
export async function appendCasheaMovementWithinLock({
    storage,
    id,
    customerId,
    type,
    deltaUsd,
    sourceSaleId = null,
    reason = '',
}) {
    const delta = round2(Number(deltaUsd) || 0);
    if (!customerId || delta === 0) return null;
    const current = (await storage.getItem(CASHEA_LEDGER_KEY, [])) || [];
    const list = Array.isArray(current) ? [...current] : [];
    const mov = buildCasheaMovement({ id, customerId, type, deltaUsd: delta, sourceSaleId, reason });
    if (list.some((m) => String(m?.id) === mov.id)) {
        return list;
    }
    list.push(mov);
    await storage.setItem(CASHEA_LEDGER_KEY, list);
    return list;
}
