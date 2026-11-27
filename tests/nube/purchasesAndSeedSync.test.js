/**
 * T22 · Sincronización de compras de mercancía (`purchases`) y siembra determinista
 * de stock inicial (`seedMissingStock`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createRecordSync } from '../../src/nube/recordSync';
import { seedMissingStock } from '../../src/nube/stockSeed';

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

describe('T22 · Compras de mercancía multi-caja y stockSeed determinista', () => {
    it('1. Compras de mercancía sincronizan entre Caja A y Caja B, y seedMissingStock siembra solo productos sin nivel previo de forma idempotente', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'compras@bodega.local', 'ClaveSegura123');
        const accId = await svc.createAccount(owner, {
            businessName: 'Abasto Compras',
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
        const stA = await svc.getDeviceStatus(cajaA, uidA);
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '123456');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '123456');

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

        // 1. Caja A registra compra de mercancía
        const purchase = { id: 'buy-1', supplier: 'Distribuidora Sur', amountUsd: 240.5, date: '2026-11-26', note: 'Lote semanal' };
        localA.set('bodega_merchandise_purchases_v1', [purchase]);
        await recA.onLocalWrite('bodega_merchandise_purchases_v1', [purchase]);
        await recA.flush();

        // Caja B la recibe
        await recB.pull(['purchases']);
        expect(localB.get('bodega_merchandise_purchases_v1')).toHaveLength(1);
        expect(localB.get('bodega_merchandise_purchases_v1')[0].amountUsd).toBe(240.5);

        // 2. seedMissingStock siembra productos sin fila en stock_levels; ejecutarlo 2 veces no duplica stock
        const localProds = [
            { id: 'p-seed-1', name: 'Harina', stock: 12 },
            { id: 'p-seed-2', name: 'Arroz', stock: 5 },
        ];
        const n1 = await seedMissingStock(cajaA, {
            session: sessA.token,
            role: 'dueno',
            accountId: accId,
            sedeId: stA.device.sede_id,
            products: localProds,
            levels: {},
        });
        expect(n1).toBe(2);

        // Reintento incluso pasando levels vacío (simulando 2da caja) NO duplica (UUID determinista)
        await seedMissingStock(cajaB, {
            session: sessB.token,
            role: 'dueno',
            accountId: accId,
            sedeId: stA.device.sede_id,
            products: localProds,
            levels: {},
        });

        const { data: levels } = await cajaA.from('stock_levels').select('product_id, qty');
        const map = Object.fromEntries(levels.map((r) => [r.product_id, Number(r.qty)]));
        expect(map['p-seed-1']).toBe(12);
        expect(map['p-seed-2']).toBe(5);
    }, 60_000);
});
