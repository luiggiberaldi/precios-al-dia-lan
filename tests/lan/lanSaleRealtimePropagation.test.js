/**
 * Regresión end-to-end: al registrar una venta en Caja A sobre LAN real,
 * Caja B recibe en tiempo real tanto el stock actualizado (`stock_levels`)
 * como el aviso de caja (`account_sync_state` `collection='cash'`) vía SSE,
 * actualizando `pdn_remote_cash_updated` y las lecturas multi-caja sin recargar.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { keepChannel } from '../../src/nube/realtimeChannel';
import { createRecordSync } from '../../src/nube/recordSync';
import { createStockMirror } from '../../src/nube/stockMirror';
import { createStockWatcher } from '../../src/nube/stockWatcher';
import { loadDashboardCajas } from '../../src/nube/allCajasToday';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

function memoryStore() {
    const m = new Map();
    return {
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

async function waitFor(fn, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 40));
    }
    return false;
}

describe('LAN · propagación de ventas en tiempo real entre PCs', () => {
    it('al cobrar en Caja A, Caja B recibe SSE de stock y cash y ve la venta sin recargar', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'rt@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega Tiempo Real',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '142536',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidA = await svc.ensureDeviceSession(cajaA);
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja A', role: 'caja' });
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja' });
        const stA = await svc.getDeviceStatus(cajaA, uidA);
        const stB = await svc.getDeviceStatus(cajaB, uidB);

        const members = await svc.listMembers(cajaA);
        const dueno = members.find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '142536');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '142536');

        // Catálogo + stock inicial = 10 en Caja A
        await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'products',
            p_records: [{ id: 'p-cafe', data: { id: 'p-cafe', name: 'Café 250g', priceUsd: 5 } }],
        });
        await cajaA.rpc('process_stock_movements', {
            p_session: sessA.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'p-cafe', qty: 10 }],
            p_reference: 'init',
        });

        // Motores locales en Caja A y Caja B
        const localA = new Map([['bodega_products_v1', [{ id: 'p-cafe', name: 'Café 250g', priceUsd: 5, stock: 10 }]]]);
        const localB = new Map([['bodega_products_v1', [{ id: 'p-cafe', name: 'Café 250g', priceUsd: 5, stock: 10 }]]]);

        const syncA = createRecordSync({
            client: cajaA,
            getSession: () => sessA.token,
            store: memoryStore(),
            cashIdSuffix: stA.device.id,
            readLocal: async (k) => structuredClone(localA.get(k) ?? null),
            writeLocal: async (k, v) => { localA.set(k, structuredClone(v)); },
        });
        const watcherB = createStockWatcher({ client: cajaB, getSession: () => sessB.token, store: memoryStore() });
        const stockB = createStockMirror({
            client: cajaB,
            sedeId: stB.device.sede_id,
            watcher: watcherB,
            readProducts: async () => structuredClone(localB.get('bodega_products_v1') || []),
            writeProducts: async (p) => { localB.set('bodega_products_v1', structuredClone(p)); },
        });
        await stockB.refresh();

        // Caja B escucha ambos canales SSE (account_sync_state y stock_levels) exactamente como useNubeSync.
        const cashEvents = [];
        let syncSub = false;
        let stockSub = false;
        const chSync = keepChannel(
            cajaB,
            'rt-sync-b',
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state' }, (p) => {
                if (p?.new?.collection === 'cash') cashEvents.push(p.new);
            }),
            { onUp: () => { syncSub = true; } },
        );
        const chStock = keepChannel(
            cajaB,
            'rt-stock-b',
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels', filter: `sede_id=eq.${stB.device.sede_id}` }, (p) => {
                if (!stockB.applyRealtime(p?.new)) stockB.refresh();
            }),
            { onUp: () => { stockSub = true; } },
        );
        cleanups.push(async () => chSync.dispose());
        cleanups.push(async () => chStock.dispose());

        expect(await waitFor(() => syncSub && stockSub)).toBe(true);

        // Caja A cobra una venta de 3 unidades y escribe `bodega_sales_v1`
        const saleUuid = randomUUID();
        const checkout = await cajaA.rpc('process_checkout', {
            p_session: sessA.token,
            p_sale: { id: saleUuid, items: [{ product_id: 'p-cafe', qty: 3 }], total_usd: 15, total_bs: 600, rate: 40 },
            p_offline: false,
            p_allow_negative: false,
        });
        expect(checkout.error).toBeNull();

        const saleRec = {
            id: 'sale-rt-1',
            tipo: 'VENTA',
            status: 'COMPLETADA',
            totalUsd: 15,
            totalBs: 600,
            timestamp: new Date().toISOString(),
            nube: { saleId: saleUuid, number: checkout.data[0].number },
            items: [{ id: 'p-cafe', name: 'Café 250g', qty: 3, priceUsd: 5 }],
        };
        localA.set('bodega_sales_v1', [saleRec]);
        await syncA.onLocalWrite('bodega_sales_v1', [saleRec]);
        await syncA.flush();

        // Caja B DEBE recibir SSE de `cash` y actualización de stock a 7 automáticamente
        expect(await waitFor(() => cashEvents.length >= 1 && localB.get('bodega_products_v1')[0].stock === 7)).toBe(true);

        // Al consultar el dashboard multi-caja de Caja B tras el evento SSE, aparece la venta de Caja A
        const allDashboardSales = await loadDashboardCajas(cajaB);
        expect(allDashboardSales.some((s) => s.id === 'sale-rt-1' && s.totalUsd === 15)).toBe(true);
    }, 60_000);

    it('recordSync.flush() drena una venta encolada mientras otro flush estaba en vuelo (sin esperar 60s)', async () => {
        const local = new Map();
        const pushedBatches = [];
        let releaseFirstPush;
        const firstPushGate = new Promise((r) => { releaseFirstPush = r; });

        const client = {
            from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }),
            rpc: async (_fn, args) => {
                pushedBatches.push({ collection: args.p_collection, ids: args.p_records.map((r) => r.id) });
                if (pushedBatches.length === 1) await firstPushGate;
                return {
                    data: args.p_records.map((r, idx) => ({ id: r.id, version: idx + 1, updated_at: new Date().toISOString(), merged: false, rejected: false })),
                    error: null,
                };
            },
        };

        const sync = createRecordSync({
            client,
            getSession: () => 'sess-1',
            store: memoryStore(),
            cashIdSuffix: 'dev-a',
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
        });

        // 1. Escribir producto para abrir el primer flush() y bloquearlo a mitad de vuelo
        const pProd = sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'Harina' }]);
        await waitFor(() => pushedBatches.length === 1);

        // 2. Mientras el primer flush() espera red, llega una venta nueva en `bodega_sales_v1`
        await sync.onLocalWrite('bodega_sales_v1', [{ id: 's-concurrente', tipo: 'VENTA', totalUsd: 10, timestamp: new Date().toISOString() }]);
        releaseFirstPush();
        await pProd;
        await sync.flush();

        // Debe haberse drenado sin esperar al timer periódico (cola pendiente = 0)
        expect(await sync.pendingCount()).toBe(0);
        expect(pushedBatches.some((b) => b.collection === 'cash' && b.ids.includes('s-concurrente@dev-a'))).toBe(true);
    });
});
