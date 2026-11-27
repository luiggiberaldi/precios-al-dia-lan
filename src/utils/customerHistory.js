/**
 * customerHistory.js — Creación segura de clientes bajo pos_write_lock (C9)
 * e historial unificado multi-caja (ventas locales + ledger sincronizado, A14).
 */
import { withLock } from './withLock.js';
import { mergeScreenList } from '../nube/staleListGuard.js';
import { safeUuid } from './safeUuid.js';

const CUSTOMERS_KEY = 'bodega_customers_v1';

/**
 * Crea y persiste un cliente dentro de `pos_write_lock`, fusionando con el catálogo
 * fresco de IndexedDB (`mergeScreenList`) para no borrar clientes creados en otras cajas (C9).
 */
export async function appendCustomerLocked(draft, { baseCustomers = [], storage } = {}) {
    return withLock('pos_write_lock', async () => {
        const fresh = (await storage.getItem(CUSTOMERS_KEY, [])) || [];
        const freshList = Array.isArray(fresh) ? fresh : [];
        const nextCodeNum = freshList.reduce((mx, c) => {
            const numPart = parseInt(String(c?.code || '').replace('CLI-', ''), 10);
            return Number.isNaN(numPart) ? mx : Math.max(mx, numPart);
        }, 0) + 1;

        const customer = {
            id: draft.id || safeUuid(),
            code: draft.code || `CLI-${String(nextCodeNum).padStart(5, '0')}`,
            name: String(draft.name || '').trim(),
            documentId: String(draft.documentId || '').trim(),
            phone: String(draft.phone || '').trim(),
            deuda: Number(draft.deuda) || 0,
            favor: Number(draft.favor) || 0,
            createdAt: draft.createdAt || new Date().toISOString(),
        };

        const base = Array.isArray(baseCustomers) ? baseCustomers : [];
        const merged = mergeScreenList({
            base,
            next: [...base, customer],
            fresh: freshList,
        });
        const finalList = merged.some((c) => String(c?.id) === String(customer.id))
            ? merged
            : [...merged, customer];

        await storage.setItem(CUSTOMERS_KEY, finalList);
        return { customer, customers: finalList };
    }, { fallbackWarning: false });
}

function mapLedgerTypeToSaleTipo(type) {
    switch (type) {
        case 'ABONO_DEUDA': return 'COBRO_DEUDA';
        case 'VENTA_FIADA': return 'VENTA_FIADA';
        case 'ANULACION': return 'ANULACION';
        case 'SALDO_FAVOR_USADO': return 'USO_SALDO_FAVOR';
        case 'VUELTO_ACREDITADO': return 'VUELTO_ACREDITADO';
        case 'AJUSTE_CREDITO': return 'AJUSTE_CREDITO';
        case 'AJUSTE_DEBITO': return 'AJUSTE_DEBITO';
        default: return type || 'MOVIMIENTO';
    }
}

/**
 * Combina ventas locales del cliente con movimientos sincronizados en `bodega_customer_ledger_v1`
 * para mostrar también fiados, abonos y ajustes hechos en otras cajas (A14).
 */
export function buildUnifiedCustomerHistory(customerId, localSales = [], ledger = [], { limit = 20 } = {}) {
    const cid = String(customerId || '');
    if (!cid) return [];

    const ownSales = (Array.isArray(localSales) ? localSales : [])
        .filter((s) => s && (String(s.customerId || '') === cid || String(s.clienteId || '') === cid));

    const coveredSaleIds = new Set(ownSales.map((s) => String(s.id || '')));

    const remoteEntries = (Array.isArray(ledger) ? ledger : [])
        .filter((m) => m && String(m.customerId || '') === cid && m.status !== 'VOIDED')
        .filter((m) => {
            if (m.sourceSaleId && coveredSaleIds.has(String(m.sourceSaleId))) return false;
            if (m.id && coveredSaleIds.has(String(m.id))) return false;
            return true;
        })
        .map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            customerId: m.customerId,
            tipo: mapLedgerTypeToSaleTipo(m.type),
            totalUsd: Number(m.amountUsd) || 0,
            fiadoUsd: m.type === 'VENTA_FIADA' ? (Number(m.amountUsd) || 0) : 0,
            status: m.type === 'ANULACION' ? 'ANULADA' : 'COMPLETADA',
            fromLedger: true,
            ledgerType: m.type,
            direction: m.direction,
            reason: m.reason || m.type,
            items: [{ name: m.reason || m.type, qty: 1, priceUsd: Number(m.amountUsd) || 0 }],
        }));

    return [...ownSales, ...remoteEntries]
        .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0))
        .slice(0, limit);
}
