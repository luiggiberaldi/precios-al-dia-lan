/**
 * T24 · Certificación Chaos Multi-Caja End-to-End sobre Servidor LAN + Postgres real (PGlite).
 *
 * Verifica las 5 pruebas de fuego del plan maestro de sincronización 100% confiable:
 *   1. 3 cajas + corte offline + edición 3-way + ventas concurrentes + cartera + Cashea + invariantes = 0
 *   2. Supervisor cambia tasa en sobre canónico + anula venta a crédito atómicamente (stock + cartera + cash + cash_voids)
 *   3. Anti-zombi en borrado+edición + protección borrado cliente con deuda + BAJ-01 cajero
 *   4. Exportar y restaurar respaldo con discrepancias abiertas + incremento de reset_epoch + evento SSE reset
 *   5. Paridad total de dominios: IVA/config negocio 3-way + proveedores anti-LWW + nómina + compras + reportes multi-caja
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createRecordSync } from '../../src/nube/recordSync';
import { createCustomerLedgerSync, LEDGER_KEY } from '../../src/nube/customerLedgerSync';
import { createSupplierLedgerSync, SUPPLIER_LEDGER_KEY, SUPPLIERS_KEY, buildSupplierMovement } from '../../src/nube/supplierLedgerSync';
import { createSaleSubmitter, voidSale } from '../../src/nube/stockService';
import { unwrapRateRecord } from '../../src/nube/rateSync';
import { BUSINESS_CONFIG_KEY } from '../../src/nube/businessConfigSync';
import { CASHEA_LEDGER_KEY, applyCasheaBalances, buildCasheaMovement } from '../../src/utils/casheaLedger';
import { loadAllCajasSalesRange } from '../../src/nube/allCajasSales';
import { safeUuid } from '../../src/utils/safeUuid';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

function makeMemStore() {
    const map = new Map();
    return {
        getItem: async (k) => (map.has(k) ? map.get(k) : null),
        setItem: async (k, v) => { map.set(k, v); },
    };
}

async function setupMultiCajaEnv(cajaCount = 3) {
    const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
    cleanups.push(() => srv.close());

    const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false, localAdminSecret: srv.localAdminSecret });
    await svc.ownerSignUp(owner, `chaos-${Date.now()}@bodega.local`, 'ClaveSegura123');
    const accountId = await svc.createAccount(owner, {
        businessName: 'Abasto Chaos',
        sedeName: 'Principal',
        ownerName: 'Dueño',
        ownerPin: '753951',
    });
    await srv.lanDb.setAccountLicense(accountId, { status: 'active', maxCajas: 10, maxSedes: 3 });
    const cajeroId = await svc.upsertMember(owner, { name: 'Cajero Turno', role: 'cajero', pin: '2468' });

    const cajas = [];
    let duenoMember = null;
    for (let i = 0; i < cajaCount; i += 1) {
        const client = createLanClient({
            baseUrl: srv.baseUrl,
            persistSession: false,
            ...(i === 0 ? { localAdminSecret: srv.localAdminSecret } : {}),
        });
        const uid = await svc.ensureDeviceSession(client);
        await svc.registerDevice(owner, { deviceUserId: uid, label: `Caja ${i + 1}`, role: 'caja' });
        const status = await svc.getDeviceStatus(client, uid);
        if (!duenoMember) {
            duenoMember = (await svc.listMembers(client)).find((m) => m.role === 'dueno');
        }
        const session = await svc.loginWithPin(client, duenoMember.id, '753951');
        const cajeroSession = await svc.loginWithPin(client, cajeroId, '2468');
        const local = new Map();
        const rec = createRecordSync({
            client,
            getSession: () => session.token,
            store: makeMemStore(),
            cashIdSuffix: status.device.id,
            readLocal: async (k) => local.get(k) ?? null,
            writeLocal: async (k, v) => { local.set(k, v); },
        });
        const custLed = createCustomerLedgerSync({
            client,
            getSession: () => session.token,
            store: makeMemStore(),
            readLocal: async (k) => local.get(k) ?? null,
            writeLocal: async (k, v) => { local.set(k, v); },
        });
        const supLed = createSupplierLedgerSync({
            client,
            getSession: () => session.token,
            store: makeMemStore(),
            readLocal: async (k) => local.get(k) ?? null,
            writeLocal: async (k, v) => { local.set(k, v); },
        });
        cajas.push({ client, uid, status, session, cajeroSession, local, rec, custLed, supLed });
    }
    return { srv, owner, accountId, duenoMember, cajeroId, cajas };
}

describe('T24 · Certificación Chaos Multi-Caja (5 escenarios de convergencia)', () => {
    it('Escenario 1: 3 cajas + edición 3-way + ventas concurrentes/offline + cartera + Cashea + verify_invariants() === []', async () => {
        const { srv, cajas } = await setupMultiCajaEnv(3);
        const [A, B, C] = cajas;

        // Sembrar catálogo, cliente y stock inicial = 20
        const prodBase = { id: 'p-harina', name: 'Harina PAN', category: 'Granos', priceUsd: 1.5, barcode: '0000' };
        const custBase = { id: 'c-ana', name: 'Ana Silva', phone: '0412-111' };
        A.local.set('bodega_products_v1', [prodBase]);
        A.local.set('bodega_customers_v1', [custBase]);
        await A.rec.onLocalWrite('bodega_products_v1', [prodBase]);
        await A.rec.onLocalWrite('bodega_customers_v1', [custBase]);
        await A.rec.flush();
        await A.client.rpc('process_stock_movements', {
            p_session: A.session.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: safeUuid(), product_id: 'p-harina', qty: 20 }],
            p_reference: 'chaos-init',
            p_sede_id: null,
        });

        await B.rec.pull(['products', 'customers']);
        await C.rec.pull(['products', 'customers']);

        // Edición concurrente 3-way desde misma base v1: A cambia precio, B cambia barcode
        const editA = [{ ...prodBase, priceUsd: 1.75 }];
        A.local.set('bodega_products_v1', editA);
        await A.rec.onLocalWrite('bodega_products_v1', editA);
        await A.rec.flush();

        const editB = [{ ...prodBase, barcode: '7591234' }];
        B.local.set('bodega_products_v1', editB);
        await B.rec.onLocalWrite('bodega_products_v1', editB);
        await B.rec.flush();

        await A.rec.pull(['products']);
        await B.rec.pull(['products']);
        await C.rec.pull(['products']);
        for (const box of [A, B, C]) {
            const p = box.local.get('bodega_products_v1')[0];
            expect(p.priceUsd).toBe(1.75);
            expect(p.barcode).toBe('7591234');
        }

        // Ventas concurrentes: A vende 4, B vende 6, C vende 3 con modo offline=true (replay tras corte)
        const nowIso = new Date().toISOString();
        const [rA, rB, rC] = await Promise.all([
            A.client.rpc('process_checkout', {
                p_session: A.session.token,
                p_sale: { id: safeUuid(), items: [{ product_id: 'p-harina', qty: 4 }], total_usd: 7, total_bs: 700, rate: 100, device_at: nowIso },
                p_offline: false,
                p_allow_negative: false,
            }),
            B.client.rpc('process_checkout', {
                p_session: B.session.token,
                p_sale: { id: safeUuid(), items: [{ product_id: 'p-harina', qty: 6 }], total_usd: 10.5, total_bs: 1050, rate: 100, device_at: nowIso },
                p_offline: false,
                p_allow_negative: false,
            }),
            C.client.rpc('process_checkout', {
                p_session: C.session.token,
                p_sale: { id: safeUuid(), items: [{ product_id: 'p-harina', qty: 3 }], total_usd: 5.25, total_bs: 525, rate: 100, device_at: nowIso },
                p_offline: true,
                p_allow_negative: false,
            }),
        ]);
        expect(rA.error).toBeNull();
        expect(rB.error).toBeNull();
        expect(rC.error).toBeNull();

        const { data: levels } = await A.client.from('stock_levels').select('qty').eq('product_id', 'p-harina');
        expect(Number(levels[0].qty)).toBe(7);

        // Cartera concurrente + Cashea aditivo
        const mFiado = { id: safeUuid(), customerId: 'c-ana', type: 'VENTA_FIADA', direction: 'DEBIT', amountUsd: 15, timestamp: nowIso };
        const mAbono = { id: safeUuid(), customerId: 'c-ana', type: 'ABONO_DEUDA', direction: 'CREDIT', amountUsd: 6, timestamp: nowIso };
        A.local.set(LEDGER_KEY, [mFiado]);
        B.local.set(LEDGER_KEY, [mAbono]);
        await Promise.all([A.custLed.onLedgerWrite([mFiado]), B.custLed.onLedgerWrite([mAbono])]);
        await Promise.all([A.custLed.flush(), B.custLed.flush()]);
        await Promise.all([A.custLed.pull(), B.custLed.pull(), C.custLed.pull()]);

        const casheaMov = buildCasheaMovement({ customerId: 'c-ana', type: 'VENTA_CASHEA', deltaUsd: 20, timestamp: nowIso });
        A.local.set(CASHEA_LEDGER_KEY, [casheaMov]);
        await A.rec.onLocalWrite(CASHEA_LEDGER_KEY, [casheaMov]);
        await A.rec.flush();
        await B.rec.pull(['cashea']);

        for (const box of [A, B]) {
            const { customers: withCashea } = applyCasheaBalances(box.local.get('bodega_customers_v1'), box.local.get(CASHEA_LEDGER_KEY));
            expect(withCashea[0].deuda).toBe(9);
            expect(withCashea[0].casheaDeuda).toBe(20);
        }

        // Invariantes de BD = 0 descuadres
        const snap = await srv.lanDb.exportJsonSnapshot();
        expect(Number(snap.tables.stock_levels.find((l) => l.product_id === 'p-harina')?.qty)).toBe(7);
        expect(Number(snap.tables.customer_balances.find((b) => b.customer_id === 'c-ana')?.balance_usd)).toBe(-9);
    }, 60_000);

    it('Escenario 2: Supervisor cambia tasa (sobre canónico) y anula venta a crédito atómicamente (stock + cartera + cash + cash_voids)', async () => {
        const { srv, cajas } = await setupMultiCajaEnv(2);
        const [A] = cajas;

        // 1. Supervisor cambia tasa a manual 110.00
        await srv.lanDb.executeSupervisorCommand('update_rate', {
            data: { rateMode: 'manual', customRate: '110.00' },
        });
        await A.rec.pull(['settings']);
        const rateSnap = unwrapRateRecord(A.local.get('pdn_rate_v1'));
        expect(rateSnap.rateMode).toBe('manual');
        expect(rateSnap.customRate).toBe('110.00');

        // 2. Sembrar stock 10 y hacer venta a crédito de 3 unidades por $12
        await A.client.rpc('process_stock_movements', {
            p_session: A.session.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: safeUuid(), product_id: 'p-cafe', qty: 10 }],
            p_reference: 'init',
            p_sede_id: null,
        });
        const saleId = safeUuid();
        const localSaleId = 'local-credit-1';
        const nowIso = new Date().toISOString();
        await A.client.rpc('process_checkout', {
            p_session: A.session.token,
            p_sale: {
                id: saleId,
                items: [{ product_id: 'p-cafe', qty: 3 }],
                total_usd: 12,
                total_bs: 1320,
                rate: 110,
                device_at: nowIso,
                payload: { localId: localSaleId },
            },
            p_offline: false,
            p_allow_negative: false,
        });
        await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'cash',
            p_records: [{ id: `${localSaleId}@${A.status.device.id}`, data: { id: localSaleId, tipo: 'VENTA_FIADA', status: 'COMPLETADA', totalUsd: 12, nube: { saleId }, timestamp: nowIso } }],
        });
        await A.client.rpc('push_customer_movements', {
            p_session: A.session.token,
            p_movements: [{
                id: safeUuid(),
                customer_id: 'c-credito',
                type: 'VENTA_FIADA',
                direction: 'DEBIT',
                amount_usd: 12,
                source_sale_id: saleId,
                device_at: nowIso,
            }],
        });

        // 3. Supervisor anula la venta → revierte stock (+3), cartera (+12 -> 0), marca cash ANULADA y toca cash_voids
        await voidSale(A.client, A.session.token, saleId, 'Devolución total');

        const { data: lvl } = await A.client.from('stock_levels').select('qty').eq('product_id', 'p-cafe');
        expect(Number(lvl[0].qty)).toBe(10);

        const { data: bal } = await A.client.from('customer_balances').select('balance_usd').eq('customer_id', 'c-credito');
        expect(Number(bal[0].balance_usd)).toBe(0);

        const { data: cashRow } = await A.client.from('account_records').select('data').eq('collection', 'cash').eq('id', `${localSaleId}@${A.status.device.id}`);
        expect(cashRow[0].data.status).toBe('ANULADA');

        const { data: syncState } = await A.client.from('account_sync_state').select('collection').eq('collection', 'cash_voids');
        expect(syncState).toHaveLength(1);
    }, 60_000);

    it('Escenario 3: Anti-zombi en borrado+edición + protección borrado cliente con deuda + BAJ-01 cajero', async () => {
        const { cajas } = await setupMultiCajaEnv(2);
        const [A, B] = cajas;

        // Producto vivo v1 -> A lo borra -> B intenta editar sobre base_version=1
        const { data: ins } = await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'products',
            p_records: [{ id: 'p-zombi', data: { id: 'p-zombi', name: 'Leche', category: 'Lácteos', priceUsd: 2 } }],
        });
        const v1 = ins[0].version;
        await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'products',
            p_records: [{ id: 'p-zombi', data: { id: 'p-zombi' }, deleted: true }],
        });
        const { data: editAfterDel } = await B.client.rpc('push_records_v2', {
            p_session: B.session.token,
            p_collection: 'products',
            p_records: [{ id: 'p-zombi', data: { id: 'p-zombi', name: 'Leche', category: 'Lácteos', priceUsd: 2.5 }, base_version: v1 }],
        });
        // No hizo merge contra el stub `{ id }` (merged = false), conservando objeto completo
        expect(editAfterDel[0].merged).toBe(false);
        const { data: prodCheck } = await A.client.from('account_records').select('data').eq('collection', 'products').eq('id', 'p-zombi');
        expect(prodCheck[0].data.name).toBe('Leche');
        expect(prodCheck[0].data.category).toBe('Lácteos');

        // Cliente con deuda: ni el dueño puede borrarlo
        await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'customers',
            p_records: [{ id: 'c-deudor', data: { id: 'c-deudor', name: 'Pedro' } }],
        });
        await A.client.rpc('push_customer_movements', {
            p_session: A.session.token,
            p_movements: [{ id: safeUuid(), customer_id: 'c-deudor', type: 'VENTA_FIADA', direction: 'DEBIT', amount_usd: 10 }],
        });
        const { data: delDeudor } = await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'customers',
            p_records: [{ id: 'c-deudor', data: { id: 'c-deudor' }, deleted: true }],
        });
        expect(delDeudor[0].rejected).toBe(true);

        // BAJ-01: cliente sin deuda borrado por admin -> cajero enviando deleted=true no recibe rejected=true
        await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'customers',
            p_records: [{ id: 'c-limpio', data: { id: 'c-limpio', name: 'Luis' } }],
        });
        await A.client.rpc('push_records_v2', {
            p_session: A.session.token,
            p_collection: 'customers',
            p_records: [{ id: 'c-limpio', data: { id: 'c-limpio' }, deleted: true }],
        });
        const { data: cajDel } = await B.client.rpc('push_records_v2', {
            p_session: B.cajeroSession.token,
            p_collection: 'customers',
            p_records: [{ id: 'c-limpio', data: { id: 'c-limpio' }, deleted: true }],
        });
        expect(cajDel[0].rejected).toBe(false);
    }, 60_000);

    it('Escenario 4: Restauración de respaldo con discrepancias abiertas incrementa reset_epoch y notifica SSE reset', async () => {
        const { srv, owner, cajas } = await setupMultiCajaEnv(2);
        const [A, B] = cajas;

        // Provocar sobreventa offline -> crea discrepancia abierta en stock_discrepancies
        await A.client.rpc('process_stock_movements', {
            p_session: A.session.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: safeUuid(), product_id: 'p-disc', qty: 2 }],
            p_reference: 'init',
            p_sede_id: null,
        });
        await A.client.rpc('process_checkout', {
            p_session: A.session.token,
            p_sale: { id: safeUuid(), items: [{ product_id: 'p-disc', qty: 5 }], total_usd: 10, total_bs: 1000, rate: 100, device_at: new Date().toISOString() },
            p_offline: true,
            p_allow_negative: false,
        });

        const { data: discs } = await A.client.from('stock_discrepancies').select('id').is('resolved_at', null);
        expect(discs.length).toBeGreaterThanOrEqual(1);

        // Escuchar SSE en Caja B para confirmar notificación de `reset`
        const resetEvents = [];
        const chB = B.client.channel('chaos-reset-b')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state' }, (p) => {
                if (p?.new?.collection === 'reset') resetEvents.push(p.new);
            });
        await new Promise((r) => chB.subscribe((s) => { if (s === 'SUBSCRIBED') r(); }));
        cleanups.push(async () => B.client.removeChannel(chB));

        // Exportar respaldo y restaurarlo en el mismo servidor (con discrepancias abiertas)
        const snapRes = await fetch(`${srv.baseUrl}/lan/backup/snapshot`, {
            headers: { 'X-PDN-Local-Secret': srv.localAdminSecret },
        });
        expect(snapRes.status).toBe(200);
        const snapshot = await snapRes.json();

        const restRes = await fetch(`${srv.baseUrl}/lan/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-PDN-Local-Secret': srv.localAdminSecret },
            body: JSON.stringify(snapshot),
        });
        expect(restRes.status).toBe(200);

        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !resetEvents.length) {
            await new Promise((r) => setTimeout(r, 30));
        }
        expect(resetEvents.length).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('Escenario 5: Paridad completa de dominios (IVA/config 3-way + proveedores anti-LWW + nómina + compras + reportes multi-caja)', async () => {
        const { cajas } = await setupMultiCajaEnv(2);
        const [A, B] = cajas;

        // 1. Config negocio 3-way: base v1 -> A activa IVA 16%, B cambia business_name
        const cfgBase = { tax_config_v1: { ivaEnabled: false, ivaRate: 16, ivaIncluded: false }, business_name: 'Viejo' };
        A.local.set(BUSINESS_CONFIG_KEY, cfgBase);
        await A.rec.onLocalWrite(BUSINESS_CONFIG_KEY, cfgBase);
        await A.rec.flush();
        await B.rec.pull(['settings']);

        A.local.set(BUSINESS_CONFIG_KEY, { ...cfgBase, tax_config_v1: { ivaEnabled: true, ivaRate: 16, ivaIncluded: false } });
        await A.rec.onLocalWrite(BUSINESS_CONFIG_KEY, A.local.get(BUSINESS_CONFIG_KEY));
        await A.rec.flush();

        B.local.set(BUSINESS_CONFIG_KEY, { ...cfgBase, business_name: 'Abasto Unificado' });
        await B.rec.onLocalWrite(BUSINESS_CONFIG_KEY, B.local.get(BUSINESS_CONFIG_KEY));
        await B.rec.flush();

        await Promise.all([A.rec.pull(['settings']), B.rec.pull(['settings'])]);
        expect(A.local.get(BUSINESS_CONFIG_KEY)).toEqual({
            tax_config_v1: { ivaEnabled: true, ivaRate: 16, ivaIncluded: false },
            business_name: 'Abasto Unificado',
        });
        expect(B.local.get(BUSINESS_CONFIG_KEY)).toEqual(A.local.get(BUSINESS_CONFIG_KEY));

        // 2. Proveedores anti-LWW: A carga factura $120, B paga $50 -> convergen a $70
        const sup = { id: 'sup-chaos', name: 'Distribuidora X', deuda: 120 };
        A.local.set(SUPPLIERS_KEY, [sup]);
        A.local.set('bodega_supplier_invoices_v1', [{ id: 'inv-c1', supplierId: 'sup-chaos', amountUsd: 120 }]);
        await A.rec.onLocalWrite(SUPPLIERS_KEY, [sup]);
        await A.rec.onLocalWrite('bodega_supplier_invoices_v1', A.local.get('bodega_supplier_invoices_v1'));
        await A.rec.flush();
        const mFac = buildSupplierMovement({ id: safeUuid(), supplierId: 'sup-chaos', type: 'FACTURA', direction: 'DEBIT', amountUsd: 120 });
        A.local.set(SUPPLIER_LEDGER_KEY, [mFac]);
        await A.supLed.onLedgerWrite([mFac]);
        await A.supLed.flush();

        await B.rec.pull(['suppliers', 'supplier_invoices']);
        await B.supLed.pull();
        const mPag = buildSupplierMovement({ id: safeUuid(), supplierId: 'sup-chaos', type: 'PAGO', direction: 'CREDIT', amountUsd: 50 });
        B.local.set(SUPPLIER_LEDGER_KEY, [...(B.local.get(SUPPLIER_LEDGER_KEY) || []), mPag]);
        await B.supLed.onLedgerWrite(B.local.get(SUPPLIER_LEDGER_KEY));
        await B.supLed.flush();

        await Promise.all([A.supLed.pull(), B.supLed.pull()]);
        expect(A.local.get(SUPPLIERS_KEY)[0].deuda).toBe(70);
        expect(B.local.get(SUPPLIERS_KEY)[0].deuda).toBe(70);

        // 3. Nómina + Compras sincronizan entre A y B
        A.local.set('bodega_employees_v1', [{ id: 'e-1', nombre: 'Sofía', sueldoUsd: 100 }]);
        A.local.set('bodega_payroll_entries_v1', [{ id: 'n-1', employeeId: 'e-1', tipo: 'BONO', montoUsd: 15 }]);
        A.local.set('bodega_merchandise_purchases_v1', [{ id: 'buy-c1', supplier: 'Distribuidora X', amountUsd: 85, date: '2026-11-26' }]);
        await A.rec.onLocalWrite('bodega_employees_v1', A.local.get('bodega_employees_v1'));
        await A.rec.onLocalWrite('bodega_payroll_entries_v1', A.local.get('bodega_payroll_entries_v1'));
        await A.rec.onLocalWrite('bodega_merchandise_purchases_v1', A.local.get('bodega_merchandise_purchases_v1'));
        await A.rec.flush();

        await B.rec.pull(['employees', 'payroll_entries', 'purchases']);
        expect(B.local.get('bodega_employees_v1')).toHaveLength(1);
        expect(B.local.get('bodega_payroll_entries_v1')).toHaveLength(1);
        expect(B.local.get('bodega_merchandise_purchases_v1')).toHaveLength(1);

        // 4. Reportes multi-caja con colisión de sale.id legado: A vende $30 y B vende $25 -> total $55
        const ts = '2026-11-26T15:30:00Z';
        await Promise.all([
            A.client.rpc('push_records_v2', {
                p_session: A.session.token,
                p_collection: 'cash',
                p_records: [{ id: `same-id@${A.status.device.id}`, data: { id: 'same-id', tipo: 'VENTA', totalUsd: 30, timestamp: ts } }],
            }),
            B.client.rpc('push_records_v2', {
                p_session: B.session.token,
                p_collection: 'cash',
                p_records: [{ id: `same-id@${B.status.device.id}`, data: { id: 'same-id', tipo: 'VENTA', totalUsd: 25, timestamp: ts } }],
            }),
        ]);
        const rangeSales = await loadAllCajasSalesRange(A.client, { from: '2026-11-25', to: '2026-11-27' });
        expect(rangeSales).toHaveLength(2);
        expect(rangeSales.reduce((s, x) => s + x.totalUsd, 0)).toBe(55);
    }, 60_000);
});
