/**
 * Inventario → «Confirmar» del − / +: el cambio llega al servidor AL MOMENTO como UN
 * movimiento AJUSTE con la diferencia; si el servidor lo rechaza se avisa.
 * Contra el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createStockWatcher } from '../../src/nube/stockWatcher.js';
import { fetchStockLevels, moveStock } from '../../src/nube/stockService.js';
import { setNubeLocalWriteHandler, setNubeStockFlusher, notifyNubeLocalWrite, flushNubeStockNow } from '../../src/nube/localWriteHook.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Confirma', 'Centro', 'Dueño', '482913']);
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

/** Instala la nube como lo hace useNubeSync (solo el stock). */
function installNube(watcher) {
    setNubeLocalWriteHandler(async (key, value) => { if (key === 'bodega_products_v1') await watcher.onProductsWrite(value); });
    setNubeStockFlusher(() => watcher.flushNow());
}

describe('Nube · ajuste de stock confirmado', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);
    afterEach(() => { setNubeLocalWriteHandler(null); setNubeStockFlusher(null); });

    it('sin la nube no hace nada (Bodega igual)', async () => {
        expect(await flushNubeStockNow()).toBeNull();
    });

    it('confirmar 14 → 19: UN AJUSTE de +5 en el servidor, enviado al momento', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'p1', qty: 14 }]);
        // Otra caja vende 2 mientras esta caja aún ve 14: la diferencia no pisa esa venta.
        await moveStock(ctx.client, ctx.admin, 'AJUSTE', [{ id: randomUUID(), product_id: 'p1', qty: -2 }]);
        const w = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store: memoryStore() });
        await w.setBaseline([{ id: 'p1', stock: 14 }]);
        installNube(w);

        notifyNubeLocalWrite('bodega_products_v1', [{ id: 'p1', stock: 19 }]);
        const res = await flushNubeStockNow();

        expect(res).toEqual({ ok: true });
        expect((await w.pendingProducts()).size).toBe(0);
        const moves = await q(db, ctx.user, "select qty from public.stock_movements where reason = 'AJUSTE' and product_id = 'p1' and qty > 0");
        expect(moves.map((m) => Number(m.qty))).toEqual([5]);
        expect((await fetchStockLevels(ctx.client)).p1).toBe(17);
    });

    it('espera a que la escritura avisada se encole antes de subir', async () => {
        const calls = [];
        let release;
        setNubeLocalWriteHandler(() => new Promise((r) => { release = () => { calls.push('encolado'); r(); }; }));
        setNubeStockFlusher(async () => { calls.push('subido'); return { ok: true }; });
        notifyNubeLocalWrite('bodega_products_v1', []);
        const p = flushNubeStockNow();
        await new Promise((r) => setTimeout(r, 5));
        expect(calls).toEqual([]);
        release();
        expect(await p).toEqual({ ok: true });
        expect(calls).toEqual(['encolado', 'subido']);
    });

    it('un cajero: el servidor lo rechaza y se devuelve el error', async () => {
        const ctx = await setup(db);
        const w = createStockWatcher({ client: ctx.client, getSession: () => ctx.cajero, store: memoryStore() });
        await w.setBaseline([{ id: 'x', stock: 3 }]);
        installNube(w);
        notifyNubeLocalWrite('bodega_products_v1', [{ id: 'x', stock: 8 }]);
        const res = await flushNubeStockNow();
        expect(res.ok).toBe(false);
        expect(res.queued).toBeFalsy();
        expect(res.message).toMatch(/Solo el dueño o un administrador/);
        expect((await fetchStockLevels(ctx.client)).x).toBeUndefined();
    });

    it('sin internet: queda en cola y se avisa', async () => {
        const ctx = await setup(db);
        const client = { from: (...a) => ctx.client.from(...a), rpc: async () => ({ error: { message: 'Failed to fetch' } }) };
        const w = createStockWatcher({ client, getSession: () => ctx.admin, store: memoryStore() });
        await w.setBaseline([{ id: 'o', stock: 1 }]);
        installNube(w);
        notifyNubeLocalWrite('bodega_products_v1', [{ id: 'o', stock: 4 }]);
        const res = await flushNubeStockNow();
        expect(res).toMatchObject({ ok: false, queued: true });
        expect([...(await w.pendingProducts())]).toEqual(['o']);
    });
});
