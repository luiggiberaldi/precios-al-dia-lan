/**
 * F3 · «vías olvidadas»: cambios de stock fuera del cobro se convierten en ajustes del
 * servidor; anular pasa por el servidor. Contra el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createStockWatcher } from '../../src/nube/stockWatcher.js';
import { createSaleSubmitter, toServerSale, fetchStockLevels, moveStock, voidSale } from '../../src/nube/stockService.js';
import { nubeVoidSale, setNubeVoider, setNubeSaleSubmitter } from '../../src/nube/checkoutBridge.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Vigía', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const user = await createUser(db, { anonymous: true });
    await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, 'Caja']);
    const [admin] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const [cajero] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
    const client = new FakeSupabase(db);
    client.user = user;
    return { user, client, admin: admin.session_token, cajero: cajero.session_token };
}

describe('F3 · vigilante de stock', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('el administrador cambia el stock en el formulario → ajuste en el servidor', async () => {
        const ctx = await setup(db);
        let session = ctx.admin;
        const w = createStockWatcher({ client: ctx.client, getSession: () => session, store: memoryStore() });
        await w.setBaseline([{ id: 'p1', stock: 10 }]);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'p1', qty: 10 }]);

        await w.onProductsWrite([{ id: 'p1', stock: 15 }, { id: 'nuevo', stock: 4 }, { id: 'sin', name: 'sin stock' }]);
        await w.flush();
        const levels = await fetchStockLevels(ctx.client);
        expect(levels).toEqual({ p1: 15, nuevo: 4 });
        const moves = await q(db, ctx.user, "select product_id, qty, reason from public.stock_movements where reason = 'AJUSTE' order by product_id");
        expect(moves.map((m) => [m.product_id, Number(m.qty)])).toEqual([['nuevo', 4], ['p1', 5]]);

        // Guardar otra vez lo mismo no genera ajustes.
        expect(await w.onProductsWrite([{ id: 'p1', stock: 15 }, { id: 'nuevo', stock: 4 }])).toBe(0);
        session = null;
    });

    it('un cajero no puede cambiar el stock: se rechaza, se avisa, revierte baseline y no queda en cola', async () => {
        const ctx = await setup(db);
        const store = memoryStore();
        let session = ctx.cajero;
        const w = createStockWatcher({ client: ctx.client, getSession: () => session, store });
        await w.setBaseline([{ id: 'x', stock: 3 }]);
        await w.onProductsWrite([{ id: 'x', stock: 9 }]);
        await w.flush();
        expect(w.getLastError()).toMatch(/Solo el dueño o un administrador/);
        expect(w.getRejected()).toHaveLength(1);
        expect((await w.pendingProducts()).size).toBe(0);
        expect((await fetchStockLevels(ctx.client)).x).toBeUndefined();

        // Si luego entra un administrador y guarda 9, el baseline volvió a 3 y sube +6.
        session = ctx.admin;
        expect(await w.onProductsWrite([{ id: 'x', stock: 9 }])).toBe(1);
        await w.flush();
        expect((await fetchStockLevels(ctx.client)).x).toBe(6);
    });

    it('sin internet los ajustes quedan en cola y suben al volver (G10)', async () => {
        const ctx = await setup(db);
        const state = { offline: true };
        const client = { from: (...a) => ctx.client.from(...a), rpc: async (...a) => (state.offline ? { error: { message: 'Failed to fetch' } } : ctx.client.rpc(...a)) };
        const w = createStockWatcher({ client, getSession: () => ctx.admin, store: memoryStore() });
        await w.setBaseline([]);
        await w.onProductsWrite([{ id: 'o', stock: 6 }]);
        await w.flush();
        expect([...(await w.pendingProducts())]).toEqual(['o']);
        state.offline = false;
        await w.flush();
        expect((await w.pendingProducts()).size).toBe(0);
        expect((await fetchStockLevels(ctx.client)).o).toBe(6);
    });
});

describe('F3 · anular pasa por el servidor', () => {
    it('con nube: anula en el servidor; sin nube o venta vieja: no hace nada', async () => {
        setNubeVoider(null);
        expect(await nubeVoidSale({ nube: { saleId: 'x' } })).toBeNull();

        const db = await createDb();
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'v', qty: 5 }]);
        const submitter = createSaleSubmitter({ client: ctx.client, getSession: () => ctx.admin, store: memoryStore() });
        const sale = toServerSale({ nubeId: randomUUID(), items: [] }, [{ product_id: 'v', qty: 2 }]);
        await submitter.submit(sale);
        setNubeSaleSubmitter(submitter);
        setNubeVoider(async (id, reason) => {
            try { await voidSale(ctx.client, ctx.admin, id, reason); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
        });
        expect(await nubeVoidSale({ id: 'local' })).toBeNull(); // venta sin servidor (anterior a la nube)
        expect(await nubeVoidSale({ nube: { saleId: sale.id } }, 'devolución')).toBeNull();
        expect((await fetchStockLevels(ctx.client)).v).toBe(5);
        const res = await nubeVoidSale({ nube: { saleId: randomUUID() } }, 'x');
        expect(res).toMatchObject({ rejected: true });
        setNubeVoider(null);
        setNubeSaleSubmitter(null);
    }, 60_000);
});
