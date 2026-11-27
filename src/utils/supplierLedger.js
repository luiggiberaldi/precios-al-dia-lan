import { allocatePaymentsToInvoices } from './supplierAllocation';
import { getLocalISODate } from './dateHelpers';
import { round2 } from './dinero';

/**
 * Estado de cuenta derivado por proveedor (puro, sin I/O): lo que el supervisor
 * ve en modo lectura. La deuda publicada por la caja (`supplier.deuda`) es la
 * cifra de cabecera; el saldo por factura se deriva repartiendo los pagos
 * (`PAGO_PROVEEDOR` en ventas) en orden FIFO, igual que hace la caja.
 *
 * @param {Array} suppliers  `bodega_suppliers_v1`
 * @param {Array} invoices   `bodega_supplier_invoices_v1`
 * @param {Array} sales      `bodega_sales_v1` (solo se usan los PAGO_PROVEEDOR)
 * @param {Object} [opts]
 * @param {Date}   [opts.today] Referencia de "hoy" para vencimientos (tests).
 * Cada fila lleva además `divergenceUsd`/`divergent`: la comparación entre la
 * deuda publicada y el saldo derivado de facturas (tolerancia de medio
 * centavo; ambas cifras ya vienen redondeadas a centavos).
 *
 * @returns {Array<{supplier, deudaUsd, pendingUsd, divergenceUsd, divergent, overdueCount, invoiceCount, invoiceRows}>}
 */
export function buildSupplierLedger(suppliers, invoices, sales, { today = new Date() } = {}) {
    const allInvoices = Array.isArray(invoices) ? invoices : [];
    const allSales = Array.isArray(sales) ? sales : [];
    const todayKey = getLocalISODate(today);

    return (Array.isArray(suppliers) ? suppliers : [])
        .filter((supplier) => supplier && supplier.id != null)
        .map((supplier) => {
            const supplierInvoices = allInvoices.filter((inv) => inv?.supplierId === supplier.id);
            const supplierPayments = allSales.filter((sale) => (
                sale?.tipo === 'PAGO_PROVEEDOR' && sale?.supplierId === supplier.id
            ));
            const { byInvoice } = allocatePaymentsToInvoices(supplierInvoices, supplierPayments);

            const invoiceRows = [...supplierInvoices]
                .sort((a, b) => {
                    const ta = a?.date || a?.timestamp || '';
                    const tb = b?.date || b?.timestamp || '';
                    if (ta !== tb) return ta < tb ? 1 : -1; // más reciente primero
                    return String(a?.id ?? '') < String(b?.id ?? '') ? -1 : 1;
                })
                .map((inv) => {
                    const alloc = byInvoice.get(inv.id) || {
                        paidUsd: 0,
                        remainingUsd: Math.max(0, Number(inv.amountUsd) || 0),
                        status: 'PENDIENTE',
                    };
                    const overdue = Boolean(inv.dueDate)
                        && String(inv.dueDate) < todayKey
                        && alloc.remainingUsd > 0.005;
                    return {
                        id: inv.id,
                        invoiceNumber: inv.invoiceNumber || '',
                        date: inv.date || inv.timestamp || null,
                        dueDate: inv.dueDate || null,
                        amountUsd: round2(Math.max(0, Number(inv.amountUsd) || 0)),
                        paidUsd: round2(alloc.paidUsd),
                        remainingUsd: round2(alloc.remainingUsd),
                        status: overdue ? 'VENCIDA' : alloc.status,
                        overdue,
                    };
                });

            const pendingUsd = round2(invoiceRows.reduce((sum, row) => sum + row.remainingUsd, 0));
            const deudaUsd = round2(Math.max(0, Number(supplier.deuda) || 0));
            // Divergencia: la deuda publicada puede desviarse del saldo que
            // resulta de las facturas (deuda manual de un alta, ajustes legacy,
            // facturas sin publicar). Se marca para que el supervisor la vea en
            // vez de confiar en una cifra que las facturas no respaldan.
            const divergenceUsd = round2(deudaUsd - pendingUsd);
            return {
                supplier,
                deudaUsd,
                pendingUsd,
                divergenceUsd,
                divergent: Math.abs(divergenceUsd) > 0.005,
                overdueCount: invoiceRows.filter((row) => row.overdue).length,
                invoiceCount: invoiceRows.length,
                invoiceRows,
            };
        })
        .sort((a, b) => (
            b.deudaUsd - a.deudaUsd
            || String(a.supplier?.name ?? '').localeCompare(String(b.supplier?.name ?? ''))
        ));
}

/**
 * Une pagos locales (`bodega_sales_v1` tipo `PAGO_PROVEEDOR`) con pagos remotos
 * sincronizados en el libro append-only (`bodega_supplier_ledger_v1`), evitando
 * duplicados locales y excluyendo pagos anulados por `ANULACION_PAGO`.
 */
export function mergeSupplierPayments(localSales = [], supplierLedger = [], supplierId = null) {
    const locals = (Array.isArray(localSales) ? localSales : []).filter((s) => (
        s && s.tipo === 'PAGO_PROVEEDOR' && (supplierId == null || s.supplierId === supplierId)
    ));
    const ledger = (Array.isArray(supplierLedger) ? supplierLedger : []).filter((m) => (
        m && (supplierId == null || m.supplierId === supplierId)
    ));

    const voidedIds = new Set();
    for (const m of ledger) {
        if (m.type === 'ANULACION_PAGO' && m.sourceId) {
            voidedIds.add(String(m.sourceId));
        }
    }

    const seenIds = new Set();
    const result = [];
    for (const sale of locals) {
        if (sale.id != null) {
            seenIds.add(String(sale.id));
            if (voidedIds.has(String(sale.id)) && sale.status !== 'ANULADA') {
                result.push({ ...sale, status: 'ANULADA' });
                continue;
            }
        }
        result.push(sale);
    }

    for (const m of ledger) {
        if (m.type !== 'PAGO') continue;
        const refId = m.sourceId ? String(m.sourceId) : String(m.id);
        if (seenIds.has(refId) || (m.id != null && seenIds.has(String(m.id)))) continue;
        if (voidedIds.has(refId) || (m.id != null && voidedIds.has(String(m.id)))) continue;
        const amount = Math.abs(Number(m.amountUsd) || 0);
        // Compatibilidad con registros anteriores sin sourceId: evitar duplicar el pago local gemelo.
        if (!m.sourceId) {
            const mTs = Date.parse(m.timestamp);
            const hasLocalTwin = locals.some((l) => (
                l.supplierId === m.supplierId
                && Math.abs(Math.abs(Number(l.totalUsd) || 0) - amount) < 0.005
                && Number.isFinite(mTs)
                && Math.abs((Date.parse(l.timestamp) || 0) - mTs) < 5000
            ));
            if (hasLocalTwin) continue;
        }
        seenIds.add(refId);
        result.push({
            id: refId,
            tipo: 'PAGO_PROVEEDOR',
            supplierId: m.supplierId,
            invoiceId: m.invoiceId ?? null,
            totalUsd: -amount,
            amountUsd: amount,
            timestamp: m.timestamp,
            date: m.timestamp,
            description: m.reason || 'Pago (otra caja)',
            _remoteLedger: true,
        });
    }

    return result;
}
