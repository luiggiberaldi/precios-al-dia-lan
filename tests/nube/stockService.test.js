/**
 * F3/F6 · cobro de la caja contra el SQL real (PGlite): E2 con dos cajas, cola sin
 * internet que se sube después (E3, E10 parcial), reintentos (E11) y stock del servidor
 * en la copia local.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import {
    createSaleSubmitter, saleItemsFromCart, toServerSale, fetchStockLevels, applyLevels, moveStock, voidSale, isNetworkError,
    isDefinitiveRejection,
} from '../../src/nube/stockService.js';
import { nubeCommitSale, setNubeSaleSubmitter } from '../../src/nube/checkoutBridge.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

/** Cliente que puede «perder internet». */
function flaky(client) {
    const state = { offline: false };
    return {
        state,
        from: (...a) => client.from(...a),
        rpc: async (...a) => (state.offline ? { data: null, error: { message: 'TypeError: Failed to fetch', status: 0 } } : client.rpc(...a)),
    };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Caja', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const cajas = [];
    for (const label of ['A', 'B']) {
        const user = await createUser(db, { anonymous: true });
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, `Caja ${label}`]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        const base = new FakeSupabase(db);
        base.user = user;
        const client = flaky(base);
        const submitter = createSaleSubmitter({ client, getSession: () => s.session_token, store: memoryStore(), timeoutMs: 5000 });
        cajas.push({ user, row, session: s.session_token, client, submitter, base });
    }
    return { owner, cajas };
}

const serverSale = (items) => toServerSale({ nubeId: randomUUID(), totalUsd: 1, timestamp: new Date().toISOString(), items: [] }, items);

describe('F3 · utilidades del cobro', () => {
    it('cantidades por producto con la fórmula de Bodega (unidades sumadas)', () => {
        const items = saleItemsFromCart([
            { id: 'p1', qty: 2 }, { id: 'p1', qty: 1 }, { id: 'x', _originalId: 'p2', qty: 3 }, { id: 'p3', qty: 0 },
        ]);
        expect(items).toEqual([{ product_id: 'p1', qty: 3 }, { product_id: 'p2', qty: 3 }]);
    });

    it('la venta libre y los avances de efectivo no descuentan ni validan stock', () => {
        const items = saleItemsFromCart([
            { id: 'p1', qty: 2 },
            { id: 'custom_1794918166012', name: 'Venta Libre', qty: 1, stock: 9999 },
            { id: 'x', _originalId: 'custom_1794918166013', qty: 1 },
            { id: 'adv_1', isCashAdvance: true, qty: 1 },
        ]);
        expect(items).toEqual([{ product_id: 'p1', qty: 2 }]);
        expect(saleItemsFromCart([{ id: 'custom_1794918166012', name: 'Venta Libre', qty: 1 }])).toEqual([]);
    });

    it('reconoce errores de red', () => {
        expect(isNetworkError({ message: 'TypeError: Failed to fetch' })).toBe(true);
        expect(isNetworkError({ message: 'Sin stock suficiente: p' })).toBe(false);
    });

    it('el stock del servidor reemplaza el local solo donde hay nivel', () => {
        const { products, changed } = applyLevels([{ id: 'a', stock: 5 }, { id: 'b', stock: 2 }], { a: 3 });
        expect(products).toEqual([{ id: 'a', stock: 3 }, { id: 'b', stock: 2 }]);
        expect(changed).toBe(1);
    });
});

describe('F3 · cobro de la caja contra el servidor', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('E2 desde las cajas: la segunda recibe el mensaje «sin stock» y no se registra', async () => {
        const { cajas: [a, b] } = await setup(db);
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'ultima', qty: 1 }]);
        const ok = await a.submitter.submit(serverSale([{ product_id: 'ultima', qty: 1 }]));
        expect(ok).toMatchObject({ ok: true, number: '#A-00001' });
        const no = await b.submitter.submit(serverSale([{ product_id: 'ultima', qty: 1 }]));
        expect(no.ok).toBe(false);
        expect(no.message).toMatch(/Sin stock suficiente/);
        expect(await b.submitter.pending()).toBe(0);
    });

    it('E3: sin internet la caja vende 5, al reconectar suben las 5 sin duplicar', async () => {
        const { cajas: [, b] } = await setup(db);
        await moveStock(b.client, b.session, 'INICIAL', [{ product_id: 'cafe', qty: 20 }]);
        b.client.state.offline = true;
        for (let i = 0; i < 5; i += 1) {
            const r = await b.submitter.submit(serverSale([{ product_id: 'cafe', qty: 1 }]));
            expect(r).toEqual({ ok: true, queued: true });
        }
        expect(await b.submitter.pending()).toBe(5);
        // Reconectar con error a mitad: la cola sigue intacta (G10).
        const failed = await b.submitter.replay();
        expect(failed[0].error).toMatch(/Failed to fetch/);
        expect(await b.submitter.pending()).toBe(5);

        b.client.state.offline = false;
        const results = await b.submitter.replay();
        expect(results.map((r) => r.number)).toEqual(['#B-00001', '#B-00002', '#B-00003', '#B-00004', '#B-00005']);
        expect(await b.submitter.pending()).toBe(0);
        expect((await fetchStockLevels(b.base)).cafe).toBe(15);
        // Reenviar lo ya subido no duplica (E11).
        const [{ n }] = await q(db, b.user, 'select count(*)::int n from public.sales');
        expect(n).toBe(5);
    });

    it('con ventas en cola, al volver internet drena primero en orden FIFO y valida la nueva en línea', async () => {
        const { cajas: [a] } = await setup(db);
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'o', qty: 5 }]);
        a.client.state.offline = true;
        await a.submitter.submit(serverSale([{ product_id: 'o', qty: 1 }]));
        a.client.state.offline = false;
        const r = await a.submitter.submit(serverSale([{ product_id: 'o', qty: 1 }]));
        expect(r.ok).toBe(true);
        expect(r.queued).toBeFalsy();
        const sales = await q(db, a.user, 'select number from public.sales order by number');
        expect(sales.map((s) => s.number)).toEqual(['#A-00001', '#A-00002']);
    });

    it('anular desde la caja devuelve el stock del servidor', async () => {
        const { cajas: [a] } = await setup(db);
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'z', qty: 4 }]);
        const sale = serverSale([{ product_id: 'z', qty: 3 }]);
        await a.submitter.submit(sale);
        expect((await fetchStockLevels(a.base)).z).toBe(1);
        await voidSale(a.client, a.session, sale.id, 'devolución');
        expect((await fetchStockLevels(a.base)).z).toBe(4);
    });

    it('checkoutBridge: sin nube no hace nada; con nube guarda número o «pendiente» en la venta', async () => {
        setNubeSaleSubmitter(null);
        expect(await nubeCommitSale({ sale: {}, cart: [{ id: 'p', qty: 1 }] })).toBeNull();

        const { cajas: [a] } = await setup(db);
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'p', qty: 2 }]);
        setNubeSaleSubmitter(a.submitter);
        const ok = await nubeCommitSale({ sale: { totalUsd: 1, items: [] }, cart: [{ id: 'p', qty: 1 }] });
        expect(ok.nube).toMatchObject({ number: '#A-00001', pending: false });
        const rejected = await nubeCommitSale({ sale: { totalUsd: 1, items: [] }, cart: [{ id: 'p', qty: 5 }] });
        expect(rejected).toMatchObject({ rejected: true });
        a.client.state.offline = true;
        const queued = await nubeCommitSale({ sale: { totalUsd: 1, items: [] }, cart: [{ id: 'p', qty: 1 }] });
        expect(queued.nube).toMatchObject({ pending: true, number: null });
        setNubeSaleSubmitter(null);
    });
});

describe('F6 · permiso sin internet (D8: 72 horas)', () => {
    it('vende sin internet hasta 72 h desde el último contacto; después pide conectarse', async () => {
        const db = await createDb();
        const { cajas: [a] } = await setup(db);
        let clock = Date.parse('2026-11-16T08:00:00Z');
        const submitter = createSaleSubmitter({ client: a.client, getSession: () => a.session, store: memoryStore(), now: () => clock });
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'p', qty: 10 }]);
        expect((await submitter.submit(serverSale([{ product_id: 'p', qty: 1 }]))).number).toBe('#A-00001');

        a.client.state.offline = true;
        clock += 71 * 3_600_000;
        expect(await submitter.submit(serverSale([{ product_id: 'p', qty: 1 }]))).toEqual({ ok: true, queued: true });
        clock += 2 * 3_600_000; // 73 h sin contacto
        const blocked = await submitter.submit(serverSale([{ product_id: 'p', qty: 1 }]));
        expect(blocked.ok).toBe(false);
        expect(blocked.message).toMatch(/más de 72 horas sin internet/);
        expect(await submitter.pending()).toBe(1); // lo vendido antes sigue en la cola (G10)

        a.client.state.offline = false;
        await submitter.replay();
        expect(await submitter.pending()).toBe(0);
        expect(await submitter.leaseValid()).toBe(true); // subir la cola renueva el permiso
    }, 60_000);
});


describe('F6 · una venta rechazada no bloquea la cola (S3, 2026-11-19)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('clasifica: datos inválidos = rechazo definitivo; red, sesión o servidor caído = pasajero', () => {
        expect(isDefinitiveRejection({ code: '22023', message: 'Producto o cantidad inválidos en la venta' })).toBe(true);
        expect(isDefinitiveRejection({ code: '23505', message: 'duplicate key' })).toBe(true);
        expect(isDefinitiveRejection({ code: '42501', message: 'Tu sesión venció. Vuelve a entrar con tu PIN.' })).toBe(false);
        expect(isDefinitiveRejection({ message: 'TypeError: Failed to fetch', status: 0 })).toBe(false);
        expect(isDefinitiveRejection({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
        expect(isDefinitiveRejection(null)).toBe(false);
    });

    it('sin internet: 3 ventas, la del medio es inválida → suben las otras 2, la mala se aparta y la caja vuelve a vender en línea', async () => {
        // Antes: la venta mala tapaba la cola para siempre y toda venta nueva se encolaba sin mirar el stock.
        const { cajas: [a] } = await setup(db);
        await moveStock(a.client, a.session, 'INICIAL', [{ product_id: 'arroz', qty: 10 }]);
        a.client.state.offline = true;
        await a.submitter.submit(serverSale([{ product_id: 'arroz', qty: 1 }]));
        await a.submitter.submit(serverSale([{ product_id: 'arroz', qty: -1 }])); // corrupta
        await a.submitter.submit(serverSale([{ product_id: 'arroz', qty: 2 }]));
        expect(await a.submitter.pending()).toBe(3);
        await a.submitter.replay(); // la subida que se lanzó sin internet termina (falla y no saca nada)
        expect(await a.submitter.pending()).toBe(3);

        a.client.state.offline = false;
        const results = await a.submitter.replay();
        expect(results.filter((r) => r.number).map((r) => r.number)).toEqual(['#A-00001', '#A-00002']);
        expect(results.filter((r) => r.rejected)).toHaveLength(1);
        expect(await a.submitter.pending()).toBe(0);
        const rejected = await a.submitter.rejected();
        expect(rejected).toHaveLength(1);
        expect(rejected[0].error).toMatch(/inválid/i);
        expect((await fetchStockLevels(a.base)).arroz).toBe(7);

        // Con la cola libre, la siguiente venta va al servidor (control de stock en línea).
        const next = await a.submitter.submit(serverSale([{ product_id: 'arroz', qty: 1 }]));
        expect(next.queued).toBeUndefined();
        expect(next.number).toBe('#A-00003');
    });

    it('sesión vencida al reconectar: la venta NO se aparta, queda en la cola para reintentar', async () => {
        const { cajas: [a] } = await setup(db);
        let session = randomUUID(); // sesión que el servidor no reconoce
        const submitter = createSaleSubmitter({ client: a.client, getSession: () => session, store: memoryStore(), timeoutMs: 5000 });
        a.client.state.offline = true;
        await submitter.submit(serverSale([{ product_id: 'cafe', qty: 1 }]));
        await submitter.replay();
        a.client.state.offline = false;
        const results = await submitter.replay();
        expect(results[0].error).toMatch(/sesión/i);
        expect(await submitter.pending()).toBe(1);
        expect(await submitter.rejected()).toHaveLength(0);
        session = a.session; // vuelve a entrar con su PIN
        await submitter.replay();
        expect(await submitter.pending()).toBe(0);
    });

    it('reintentar las ventas apartadas las vuelve a poner en la cola sin perderlas', async () => {
        const { cajas: [a] } = await setup(db);
        a.client.state.offline = true;
        const bad = serverSale([{ product_id: 'x', qty: 0 }]);
        await a.submitter.submit(bad);
        await a.submitter.replay();
        a.client.state.offline = false;
        await a.submitter.replay();
        expect((await a.submitter.rejected()).map((r) => r.sale.id)).toEqual([bad.id]);
        await a.submitter.retryRejected();
        await a.submitter.replay();
        // Sigue siendo inválida: vuelve a apartarse, nunca se pierde.
        expect((await a.submitter.rejected()).map((r) => r.sale.id)).toEqual([bad.id]);
        expect(await a.submitter.pending()).toBe(0);
    });
});
