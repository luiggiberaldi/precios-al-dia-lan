/**
 * T02 · Doble deducción / doble restauración de stock, recentlyFlushed en stockMirror
 * y serialización de stockWatcher (C1, C3, M2).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createStockWatcher, STOCK_BASELINE_KEY, STOCK_REJECTED_KEY } from '../../src/nube/stockWatcher.js';
import { createStockMirror } from '../../src/nube/stockMirror.js';
import { createSaleSubmitter, toServerSale, fetchStockLevels, moveStock, voidSale } from '../../src/nube/stockService.js';

function memoryStore({ delayMs = 0 } = {}) {
    const m = new Map();
    return {
        raw: m,
        getItem: async (k) => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            return m.has(k) ? structuredClone(m.get(k)) : null;
        },
        setItem: async (k, v) => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            m.set(k, structuredClone(v));
        },
    };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['StockT02', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const user = await createUser(db, { anonymous: true });
    const [dev] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, 'Caja A']);
    const [admin] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const client = new FakeSupabase(db);
    client.user = user;
    return { user, client, admin: admin.session_token, sedeId: dev.sede_id };
}

describe('T02 · baseline atómico, recentlyFlushed y serialización de stockWatcher', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('C1 venta offline + edición de otro producto: stock final en servidor es 8 (NO 6) y watcher encola 0 para X', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [
            { product_id: 'prodX', qty: 10 },
            { product_id: 'prodY', qty: 5 },
        ]);

        const state = { offline: true };
        const toggleClient = {
            from: (...a) => ctx.client.from(...a),
            rpc: async (...a) => (state.offline ? { error: { message: 'Failed to fetch' } } : ctx.client.rpc(...a)),
        };

        const store = memoryStore();
        const watcher = createStockWatcher({ client: toggleClient, getSession: () => ctx.admin, store });
        await watcher.setBaseline([{ id: 'prodX', stock: 10 }, { id: 'prodY', stock: 5 }]);

        const sales = createSaleSubmitter({ client: toggleClient, getSession: () => ctx.admin, store });
        // 1. Caja A vende 2 unidades de prodX estando offline (se encola la venta).
        const sale = toServerSale({ nubeId: randomUUID(), items: [] }, [{ product_id: 'prodX', qty: 2 }]);
        const submitRes = await sales.submit(sale);
        expect(submitRes.queued).toBe(true);

        // 2. checkoutProcessor actualiza el catálogo local (prodX: 8) con skipSyncPush y debe ajustar baseline atómicamente.
        expect(typeof watcher.adjustBaseline).toBe('function');
        await watcher.adjustBaseline({ prodX: -2 });

        // 3. Antes de reconectar, admin edita el precio de prodY (dispara onProductsWrite con prodX=8, prodY=5).
        const added = await watcher.onProductsWrite([
            { id: 'prodX', stock: 8, priceUsd: 2 },
            { id: 'prodY', stock: 5, priceUsd: 9.99 },
        ]);
        expect(added).toBe(0);

        // 4. Vuelve la conexión: se reenvía la venta y el watcher flushea.
        state.offline = false;
        await sales.replay();
        await watcher.flush();

        const levels = await fetchStockLevels(ctx.client);
        expect(levels.prodX).toBe(8);
        expect(levels.prodY).toBe(5);
    });

    it('C1 anulación + edición de otro producto antes de Realtime: stock final es 10 (NO 12)', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [
            { product_id: 'pAnul', qty: 10 },
            { product_id: 'pOtro', qty: 4 },
        ]);
        const store = memoryStore();
        const watcher = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store });
        const sales = createSaleSubmitter({ client: ctx.client, getSession: () => ctx.admin, store });

        // Venta online de 2 unidades (10 -> 8)
        const sale = toServerSale({ nubeId: randomUUID(), items: [] }, [{ product_id: 'pAnul', qty: 2 }]);
        await sales.submit(sale);
        await watcher.setBaseline([{ id: 'pAnul', stock: 8 }, { id: 'pOtro', stock: 4 }]);

        // Anulación online (8 -> 10) + ajuste atómico de baseline en voidSaleProcessor
        await voidSale(ctx.client, ctx.admin, sale.id, 'error de cobro');
        await watcher.adjustBaseline({ pAnul: 2 });

        // Antes de que llegue el evento Realtime de stock_levels, admin edita pOtro.
        const added = await watcher.onProductsWrite([
            { id: 'pAnul', stock: 10 },
            { id: 'pOtro', stock: 4, priceUsd: 3.5 },
        ]);
        expect(added).toBe(0);
        await watcher.flush();

        const levels = await fetchStockLevels(ctx.client);
        expect(levels.pAnul).toBe(10);
    });

    it('C3 producto nuevo recién flusheado + Realtime de otro producto: applyKnown NO borra el baseline del producto nuevo ni duplica su stock (20 -> 40)', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'pOld', qty: 10 }]);

        const localProducts = [{ id: 'pOld', stock: 10 }];
        const store = memoryStore();
        const watcher = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store });
        const mirror = createStockMirror({
            client: ctx.client,
            sedeId: ctx.sedeId,
            watcher,
            readProducts: async () => structuredClone(localProducts),
            writeProducts: async (prods) => {
                localProducts.splice(0, localProducts.length, ...structuredClone(prods));
            },
        });

        // Inicializar mirror con pOld=10
        await mirror.refresh();
        expect(typeof mirror.applyKnown).toBe('function');

        // 1. Caja A crea producto nuevo pZ con stock 20 y lo flushea al servidor.
        localProducts.push({ id: 'pZ', stock: 20 });
        await watcher.onProductsWrite(localProducts);
        await watcher.flush();
        expect((await fetchStockLevels(ctx.client)).pZ).toBe(20);

        // 2. Llega Realtime de pOld (otra caja vendió 1 de pOld) ANTES de que llegue Realtime de pZ.
        mirror.applyRealtime({ product_id: 'pOld', sede_id: ctx.sedeId, qty: 9, updated_at: new Date().toISOString() });
        await mirror.idle();

        // El baseline de pZ DEBE seguir en 20 (no haberse borrado por `only`!).
        const baselineAfterRealtime = await store.getItem(STOCK_BASELINE_KEY);
        expect(baselineAfterRealtime.pZ).toBe(20);

        // 3. Admin edita el nombre/precio de pZ manteniendo stock 20 -> NO debe enviar otro +20 (que lo dejaría en 40).
        const added = await watcher.onProductsWrite(localProducts);
        expect(added).toBe(0);
        await watcher.flush();
        expect((await fetchStockLevels(ctx.client)).pZ).toBe(20);
    });

    it('C3 dos onProductsWrite concurrentes se serializan sin perder ningún delta', async () => {
        const ctx = await setup(db);
        const store = memoryStore({ delayMs: 15 });
        const watcher = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store });
        await watcher.setBaseline([{ id: 'p1', stock: 10 }, { id: 'p2', stock: 10 }]);

        // Dos escrituras concurrentes cambiando productos distintos
        await Promise.all([
            watcher.onProductsWrite([{ id: 'p1', stock: 15 }, { id: 'p2', stock: 10 }]),
            watcher.onProductsWrite([{ id: 'p1', stock: 15 }, { id: 'p2', stock: 13 }]),
        ]);
        await watcher.flush();

        const levels = await fetchStockLevels(ctx.client);
        expect(levels.p1).toBe(5); // +5 sobre 0 inicial en servidor
        expect(levels.p2).toBe(3); // +3 sobre 0 inicial en servidor
    });

    it('M2 poison-pill en cola de stock (error clase 22/23) se aparta a pdn_stock_rejected_v1 sin trabar los demás movimientos', async () => {
        const store = memoryStore();
        const rpcMock = vi.fn(async (_fn, args) => {
            const items = args.p_movements || [];
            if (items.some((i) => i.product_id === 'BAD_ITEM')) {
                return { error: { code: '22023', message: 'invalid product payload' } };
            }
            return { data: items.map((i) => ({ id: i.id })), error: null };
        });
        const watcher = createStockWatcher({
            client: { rpc: rpcMock },
            getSession: () => 'tok',
            store,
        });
        await watcher.setBaseline([{ id: 'BAD_ITEM', stock: 0 }, { id: 'GOOD_ITEM', stock: 0 }]);
        await watcher.onProductsWrite([{ id: 'BAD_ITEM', stock: 5 }, { id: 'GOOD_ITEM', stock: 7 }]);
        await watcher.flush();

        // Cola vacía, el bueno se subió, el malo quedó en cuarentena persistida.
        expect((await watcher.pendingProducts()).size).toBe(0);
        const rejectedPersisted = await store.getItem(STOCK_REJECTED_KEY);
        expect(Array.isArray(rejectedPersisted)).toBe(true);
        expect(rejectedPersisted.some((r) => r.product_id === 'BAD_ITEM')).toBe(true);
        // El bueno sí se envió en su intento aislado
        expect(rpcMock.mock.calls.some((c) => (c[1].p_movements || []).every((i) => i.product_id === 'GOOD_ITEM'))).toBe(true);
    });
});
