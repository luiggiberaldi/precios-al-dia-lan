/**
 * T20 · Sincronización multi-caja de proveedores, facturas (`supplier_invoices`) y libro
 * append-only `supplier_movements` / `supplier_balances` (anti-LWW en `deuda`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createRecordSync } from '../../src/nube/recordSync';
import {
    SUPPLIER_LEDGER_KEY,
    SUPPLIERS_KEY,
    buildSupplierMovement,
    createSupplierLedgerSync,
} from '../../src/nube/supplierLedgerSync';

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

describe('T20 · Proveedores y facturas con libro append-only anti-LWW', () => {
    it('1. Caja A registra factura $100 y Caja B registra pago $40 concurrentes: deuda converge a $60 y strip_ledger_fields protege deuda', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'prov@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Proveedores',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '123456',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidA = await svc.ensureDeviceSession(cajaA);
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja A', role: 'caja' });
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja' });
        const cajeroId = await svc.upsertMember(owner, { name: 'Cajero', role: 'cajero', pin: '1234' });
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '123456');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '123456');
        const sessCajero = await svc.loginWithPin(cajaB, cajeroId, '1234');

        // Cajero NO puede empujar movimientos de proveedores
        const denied = await cajaB.rpc('push_supplier_movements', {
            p_session: sessCajero.token,
            p_movements: [{ id: 'denied-1', supplier_id: 'sup-1', type: 'PAGO', direction: 'CREDIT', amount_usd: 10 }],
        });
        expect(denied.error?.code).toBe('42501');

        const localA = new Map();
        const localB = new Map();
        const recA = createRecordSync({
            client: cajaA,
            getSession: () => sessA.token,
            store: makeMemStore(),
            readLocal: async (k) => localA.get(k) ?? null,
            writeLocal: async (k, v) => { localA.set(k, v); },
        });
        const recB = createRecordSync({
            client: cajaB,
            getSession: () => sessB.token,
            store: makeMemStore(),
            readLocal: async (k) => localB.get(k) ?? null,
            writeLocal: async (k, v) => { localB.set(k, v); },
        });
        const ledA = createSupplierLedgerSync({
            client: cajaA,
            getSession: () => sessA.token,
            store: makeMemStore(),
            readLocal: async (k) => localA.get(k) ?? null,
            writeLocal: async (k, v) => { localA.set(k, v); },
        });
        const ledB = createSupplierLedgerSync({
            client: cajaB,
            getSession: () => sessB.token,
            store: makeMemStore(),
            readLocal: async (k) => localB.get(k) ?? null,
            writeLocal: async (k, v) => { localB.set(k, v); },
        });

        // 1. Caja A crea proveedor + factura $100
        const supplier = { id: 'sup-polar', name: 'Empresas Polar', phone: '0414-000', deuda: 100 };
        localA.set(SUPPLIERS_KEY, [supplier]);
        await recA.onLocalWrite(SUPPLIERS_KEY, [supplier]);
        const invoice = { id: 'inv-1', supplierId: 'sup-polar', invoiceNumber: 'FAC-001', amountUsd: 100 };
        localA.set('bodega_supplier_invoices_v1', [invoice]);
        await recA.onLocalWrite('bodega_supplier_invoices_v1', [invoice]);
        await recA.flush();

        // Verificar que `deuda` fue stripeada en account_records (no viaja como LWW)
        const { data: supRows } = await cajaA.from('account_records').select('data').eq('collection', 'suppliers').eq('id', 'sup-polar');
        expect(supRows[0].data.deuda).toBeUndefined();

        const movFactura = buildSupplierMovement({ id: 'sm-fac-1', supplierId: 'sup-polar', type: 'FACTURA', direction: 'DEBIT', amountUsd: 100, invoiceId: 'inv-1' });
        localA.set(SUPPLIER_LEDGER_KEY, [movFactura]);
        await ledA.onLedgerWrite([movFactura]);
        await ledA.flush();

        // 2. Caja B baja proveedor + factura y registra pago de $40
        await recB.pull(['suppliers', 'supplier_invoices']);
        await ledB.pull();
        expect(localB.get('bodega_supplier_invoices_v1')).toHaveLength(1);
        expect(localB.get(SUPPLIERS_KEY)[0].deuda).toBe(100);

        const movPago = buildSupplierMovement({ id: 'sm-pago-1', supplierId: 'sup-polar', type: 'PAGO', direction: 'CREDIT', amountUsd: 40, invoiceId: 'inv-1' });
        const nextLedB = [...(localB.get(SUPPLIER_LEDGER_KEY) || []), movPago];
        localB.set(SUPPLIER_LEDGER_KEY, nextLedB);
        await ledB.onLedgerWrite(nextLedB);
        await ledB.flush();

        // 3. Ambas cajas hacen pull -> ambas convergen exactamente a deuda = $60
        await ledA.pull();
        await ledB.pull();
        expect(localA.get(SUPPLIERS_KEY)[0].deuda).toBe(60);
        expect(localB.get(SUPPLIERS_KEY)[0].deuda).toBe(60);
        expect(localA.get(SUPPLIER_LEDGER_KEY)).toHaveLength(2);
        expect(localB.get(SUPPLIER_LEDGER_KEY)).toHaveLength(2);
    }, 60_000);
});
