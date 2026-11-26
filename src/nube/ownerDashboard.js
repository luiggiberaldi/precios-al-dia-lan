/**
 * Datos y acciones del panel del dueño / Modo Supervisor (F7 + Supervisor Editable).
 *
 * Lee desde el servidor con RLS (solo la cuenta propia) y ejecuta cambios mediante las RPC
 * existentes (`push_records_v2`, `process_stock_movements`, `process_void`,
 * `push_customer_movements`, `resolve_discrepancy`). Compatible con el modo solo lectura
 * de `tests/nube/ownerDashboard.test.jsx`.
 */
import { safeUuid } from '../utils/safeUuid';
import { round2, round4 } from '../utils/dinero';
import { RATE_KEY } from './rateSync';

async function rows(promise, what) {
    const { data, error } = await promise;
    if (error) throw new Error(`No se pudo leer ${what}: ${error.message}`);
    return data ?? [];
}

async function callRpc(client, fn, args, what) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message || `No se pudo ${what}`);
    return data;
}

export async function loadDaySummary(client, day = null) {
    return rows(client.rpc('cash_day_summary', day ? { p_day: day } : {}), 'el resumen del día');
}

export async function loadRecentSales(client, limit = 50) {
    return rows(client.from('sales')
        .select('id, number, total_usd, status, offline, server_at, device_id, sede_id')
        .order('server_at', { ascending: false })
        .limit(limit), 'las ventas');
}

/** Nombres de productos o clientes sin bajar el registro completo. */
export async function loadNames(client, collection) {
    const list = await rows(client.from('account_records')
        .select('id, name:data->>name')
        .eq('collection', collection)
        .is('deleted_at', null), collection === 'products' ? 'los productos' : 'los clientes');
    return Object.fromEntries(list.map((r) => [r.id, r.name || r.id]));
}

export async function loadStock(client) {
    const [levels, names, sedes] = await Promise.all([
        rows(client.from('stock_levels').select('product_id, sede_id, qty').order('product_id'), 'el stock'),
        loadNames(client, 'products'),
        rows(client.from('sedes').select('id, name'), 'las sedes'),
    ]);
    const sedeName = Object.fromEntries(sedes.map((s) => [s.id, s.name]));
    const byProduct = new Map();
    for (const l of levels) {
        if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, { productId: l.product_id, name: names[l.product_id] || l.product_id, total: 0, sedes: {} });
        const p = byProduct.get(l.product_id);
        p.sedes[sedeName[l.sede_id] || l.sede_id] = Number(l.qty);
        p.total += Number(l.qty);
    }
    return { products: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)), sedes: sedes.map((s) => s.name) };
}

export async function loadCustomers(client) {
    const [balances, names] = await Promise.all([
        rows(client.from('customer_balances').select('customer_id, balance_usd'), 'los saldos'),
        loadNames(client, 'customers'),
    ]);
    return balances
        .filter((b) => Number(b.balance_usd) !== 0)
        .map((b) => ({ id: b.customer_id, name: names[b.customer_id] || b.customer_id, balance: Number(b.balance_usd) }))
        .sort((a, b) => a.balance - b.balance);
}

export async function loadDiscrepancies(client) {
    const [list, names] = await Promise.all([
        rows(client.from('stock_discrepancies').select('id, product_id, expected_qty, sold_qty, created_at').is('resolved_at', null).order('created_at'), 'las diferencias'),
        loadNames(client, 'products'),
    ]);
    return list.map((d) => ({ ...d, name: names[d.product_id] || d.product_id }));
}

// ─── Modo Supervisor: lecturas y mutaciones completas ────────────────────────

export async function loadSedes(client) {
    return rows(
        client.from('sedes').select('id, name').is('archived_at', null).order('created_at'),
        'las sedes',
    );
}

/** Catálogo completo de productos junto con niveles de stock por sede. */
export async function loadSupervisorProducts(client) {
    const [records, levels, sedes] = await Promise.all([
        rows(
            client.from('account_records')
                .select('id, data, version, updated_at')
                .eq('collection', 'products')
                .is('deleted_at', null)
                .order('updated_at', { ascending: false }),
            'el catálogo de productos',
        ),
        rows(client.from('stock_levels').select('product_id, sede_id, qty'), 'el stock'),
        loadSedes(client),
    ]);

    const sedeMap = new Map(sedes.map((s) => [s.id, s.name]));
    const stockByProduct = new Map();
    for (const l of levels) {
        if (!stockByProduct.has(l.product_id)) {
            stockByProduct.set(l.product_id, { total: 0, bySedeId: {}, bySedeName: {} });
        }
        const entry = stockByProduct.get(l.product_id);
        const qty = Number(l.qty) || 0;
        entry.total += qty;
        entry.bySedeId[l.sede_id] = qty;
        entry.bySedeName[sedeMap.get(l.sede_id) || l.sede_id] = qty;
    }

    const products = records.map((rec) => {
        const d = rec.data || {};
        const priceUsd = Number(d.priceUsdt ?? d.priceUsd ?? 0) || 0;
        const costUsd = Number(d.costUsd ?? 0) || 0;
        const stockInfo = stockByProduct.get(rec.id) || { total: 0, bySedeId: {}, bySedeName: {} };
        return {
            id: rec.id,
            name: d.name || rec.id,
            barcode: d.barcode || '',
            priceUsd,
            costUsd,
            unit: d.unit || 'unidad',
            category: d.category || 'otros',
            version: rec.version,
            raw: d,
            totalStock: stockInfo.total,
            stockBySedeId: stockInfo.bySedeId,
            stockBySedeName: stockInfo.bySedeName,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return { products, sedes };
}

/** Lista todos los clientes (con o sin deuda) para poder registrar abonos. */
export async function loadSupervisorCustomers(client) {
    const [records, balances] = await Promise.all([
        rows(
            client.from('account_records')
                .select('id, data, version')
                .eq('collection', 'customers')
                .is('deleted_at', null),
            'los clientes',
        ),
        rows(client.from('customer_balances').select('customer_id, balance_usd'), 'los saldos'),
    ]);

    const balanceMap = new Map(balances.map((b) => [b.customer_id, Number(b.balance_usd) || 0]));
    const items = [];
    const seen = new Set();

    for (const r of records) {
        seen.add(r.id);
        const d = r.data || {};
        items.push({
            id: r.id,
            name: d.name || r.id,
            phone: d.phone || '',
            balance: balanceMap.get(r.id) ?? 0,
        });
    }
    for (const b of balances) {
        if (seen.has(b.customer_id)) continue;
        items.push({
            id: b.customer_id,
            name: b.customer_id,
            phone: '',
            balance: Number(b.balance_usd) || 0,
        });
    }
    return items.sort((a, b) => a.balance - b.balance || a.name.localeCompare(b.name));
}

/** Lee la tasa compartida `pdn_rate_v1` desde settings de la cuenta. */
export async function loadCurrentRate(client) {
    const list = await rows(
        client.from('account_records')
            .select('id, data, version, updated_at')
            .eq('collection', 'settings')
            .eq('id', RATE_KEY)
            .is('deleted_at', null)
            .limit(1),
        'la tasa actual',
    );
    const rec = list[0];
    const d = rec?.data || {};
    return {
        rateMode: ['bcv', 'euro', 'usdt', 'manual'].includes(d.rateMode) ? d.rateMode : 'bcv',
        customRate: d.customRate ?? '',
        copEnabled: Boolean(d.copEnabled),
        autoCopEnabled: Boolean(d.autoCopEnabled),
        tasaCop: d.tasaCop ?? '',
        copPrimary: Boolean(d.copPrimary),
        version: rec?.version ?? null,
        updatedAt: rec?.updated_at ?? null,
        raw: d,
    };
}

/** Crea o edita un producto en `account_records` (sincroniza por SSE a todas las cajas). */
export async function saveSupervisorProduct(client, sessionToken, {
    id = null,
    name,
    priceUsd,
    costUsd = 0,
    barcode = '',
    unit = 'unidad',
    category = 'otros',
    initialStock = 0,
    sedeId = null,
}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Escribe el nombre del producto.');
    const numPrice = round4(Number(priceUsd));
    if (!Number.isFinite(numPrice) || numPrice < 0) throw new Error('Precio USD inválido.');
    const numCost = round2(Number(costUsd) || 0);
    const isNew = !id;
    const productId = id || safeUuid();

    let baseData = {};
    let baseVersion = null;
    if (!isNew) {
        const existing = await rows(
            client.from('account_records')
                .select('id, data, version')
                .eq('collection', 'products')
                .eq('id', productId)
                .limit(1),
            'el producto',
        );
        if (existing[0]) {
            baseData = existing[0].data || {};
            baseVersion = existing[0].version;
        }
    }

    const nextData = {
        ...baseData,
        id: productId,
        name: cleanName,
        barcode: String(barcode || '').trim(),
        priceUsdt: numPrice,
        priceUsd: numPrice,
        costUsd: numCost,
        unit: String(unit || baseData.unit || 'unidad'),
        category: String(category || baseData.category || 'otros'),
        updatedAt: new Date().toISOString(),
    };

    const record = {
        id: productId,
        data: nextData,
        ...(baseVersion != null ? { base_version: baseVersion } : {}),
    };

    await callRpc(client, 'push_records_v2', {
        p_session: sessionToken ?? null,
        p_collection: 'products',
        p_records: [record],
    }, 'guardar el producto');

    const numInitial = Number(initialStock);
    if (isNew && Number.isFinite(numInitial) && numInitial > 0) {
        await adjustSupervisorStock(client, sessionToken, {
            productId,
            reason: 'INICIAL',
            qty: numInitial,
            note: 'Stock inicial (Supervisor)',
            sedeId,
        });
    }

    return { id: productId, data: nextData };
}

/** Desactiva / borra suavemente un producto desde Supervisor. */
export async function deleteSupervisorProduct(client, sessionToken, { id, raw = {}, version = null }) {
    if (!id) throw new Error('Falta el id del producto.');
    await callRpc(client, 'push_records_v2', {
        p_session: sessionToken ?? null,
        p_collection: 'products',
        p_records: [{
            id,
            data: { ...raw, id },
            deleted: true,
            ...(version != null ? { base_version: version } : {}),
        }],
    }, 'eliminar el producto');
}

/** Registra compra, ajuste o conteo de inventario vía libro inmutable (`stock_movements`). */
export async function adjustSupervisorStock(client, sessionToken, {
    productId,
    reason = 'AJUSTE',
    qty,
    note = '',
    sedeId = null,
}) {
    const cleanReason = ['COMPRA', 'AJUSTE', 'CONTEO', 'INICIAL'].includes(reason) ? reason : 'AJUSTE';
    const numQty = round4(Number(qty));
    if (!productId) throw new Error('Selecciona un producto.');
    if (!Number.isFinite(numQty)) throw new Error('Cantidad inválida.');
    if (cleanReason === 'COMPRA' && numQty <= 0) throw new Error('La compra debe ser mayor a 0.');
    if (cleanReason === 'AJUSTE' && numQty === 0) throw new Error('El ajuste no puede ser 0.');

    return callRpc(client, 'process_stock_movements', {
        p_session: sessionToken ?? null,
        p_reason: cleanReason,
        p_movements: [{
            id: safeUuid(),
            product_id: productId,
            qty: numQty,
            note: String(note || '').trim() || `Movimiento desde Supervisor (${cleanReason})`,
        }],
        p_reference: 'supervisor',
        ...(sedeId ? { p_sede_id: sedeId } : {}),
    }, 'ajustar el inventario');
}

/** Cambia la tasa del negocio (`pdn_rate_v1`) en `settings` para todas las cajas. */
export async function updateSupervisorRate(client, sessionToken, {
    rateMode,
    customRate = '',
    copEnabled = false,
    tasaCop = '',
}) {
    if (!['bcv', 'euro', 'usdt', 'manual'].includes(rateMode)) {
        throw new Error('Modo de tasa inválido.');
    }
    if (rateMode === 'manual') {
        const num = Number(customRate);
        if (!Number.isFinite(num) || num <= 0) {
            throw new Error('Ingresa una tasa manual mayor a 0.');
        }
    }

    const current = await loadCurrentRate(client);
    const nextData = {
        ...current.raw,
        rateMode,
        customRate: rateMode === 'manual' ? String(customRate).trim() : String(customRate || current.customRate || ''),
        copEnabled: Boolean(copEnabled),
        tasaCop: copEnabled ? String(tasaCop || current.tasaCop || '').trim() : String(current.tasaCop || ''),
        updatedAt: new Date().toISOString(),
    };

    await callRpc(client, 'push_records_v2', {
        p_session: sessionToken ?? null,
        p_collection: 'settings',
        p_records: [{
            id: RATE_KEY,
            data: nextData,
            ...(current.version != null ? { base_version: current.version } : {}),
        }],
    }, 'actualizar la tasa');

    return nextData;
}

/** Anula una venta completada y devuelve el stock a su sede. */
export async function voidSupervisorSale(client, sessionToken, { saleId, reason = '' }) {
    if (!saleId) throw new Error('Selecciona la venta a anular.');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new Error('Indica el motivo de la anulación.');
    return callRpc(client, 'process_void', {
        p_session: sessionToken ?? null,
        p_sale_id: saleId,
        p_reason: cleanReason,
    }, 'anular la venta');
}

/** Registra un abono de deuda de un cliente en su libro inmutable. */
export async function recordSupervisorCustomerPayment(client, sessionToken, { customerId, amountUsd, note = '' }) {
    if (!customerId) throw new Error('Selecciona el cliente.');
    const cleanAmount = round2(Number(amountUsd));
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
        throw new Error('El monto del abono debe ser mayor a $0.00.');
    }
    return callRpc(client, 'push_customer_movements', {
        p_session: sessionToken ?? null,
        p_movements: [{
            id: safeUuid(),
            customer_id: customerId,
            type: 'ABONO_DEUDA',
            direction: 'CREDIT',
            amount_usd: cleanAmount,
            reason: String(note || '').trim() || 'Abono desde Modo Supervisor',
            device_at: new Date().toISOString(),
        }],
    }, 'registrar el abono');
}

/** Cierra una diferencia de stock pendiente con nota de auditoría. */
export async function resolveSupervisorDiscrepancy(client, sessionToken, { discrepancyId, note = '' }) {
    if (!discrepancyId) throw new Error('Diferencia inválida.');
    const cleanNote = String(note || '').trim() || 'Revisado desde Supervisor';
    return callRpc(client, 'resolve_discrepancy', {
        p_session: sessionToken ?? null,
        p_id: discrepancyId,
        p_note: cleanNote,
    }, 'resolver la diferencia');
}
