/**
 * S5 y S6 (auditoría de sync 2026-11-19): leer solo lo cambiado de stock y saldos, aplicar
 * el aviso en vivo sin releer, y un solo aviso por subida. Contra el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createSaleSubmitter, toServerSale, moveStock } from '../../src/nube/stockService.js';
import { fetchChangedRows } from '../../src/nube/changedRows.js';
import { createStockMirror } from '../../src/nube/stockMirror.js';
import { createCustomerLedgerSync } from '../../src/nube/customerLedgerSync.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

/** Cliente que cuenta cuántas filas baja de cada tabla. */
function counting(base) {
    const read = {};
    return {
        read,
        rpc: (...a) => base.rpc(...a),
        from(table) {
            const query = base.from(table);
            const run = query.run.bind(query);
            query.run = async () => {
                const res = await run();
                read[table] = (read[table] || 0) + (res.data || []).length;
                return res;
            };
            return query;
        },
    };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Egress', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const cajas = [];
    for (const label of ['A', 'B']) {
        const user = await createUser(db, { anonymous: true });
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, `Caja ${label}`]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        const base = new FakeSupabase(db);
        base.user = user;
        const client = counting(base);
        cajas.push({ user, row, session: s.session_token, client, base });
    }
    const [{ sede_id: sedeId }] = await q(db, cajas[0].user, 'select sede_id from public.account_devices where auth_user_id = $1', [cajas[0].user.id]);
    return { owner, accountId, cajas, sedeId };
}

function fakeWatcher(pending = []) {
    return { flush: async () => {}, pendingProducts: async () => pending, setBaseline: async () => {} };
}

function mirrorFor(caja, sedeId, local, watcher = fakeWatcher()) {
    return createStockMirror({
        client: caja.client,
        sedeId,
        watcher,
        overlapMs: 0,
        readProducts: async () => structuredClone(local.products),
        writeProducts: async (p) => { local.products = structuredClone(p); },
    });
}

const stockOf = (local) => Object.fromEntries(local.products.map((p) => [p.id, p.stock]));

describe('S5 · lectura por cambios (changedRows)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('no salta filas cuando un lote entero comparte la misma hora (paginación con desempate)', async () => {
        const { cajas, sedeId } = await setup(db);
        const [a] = cajas;
        await moveStock(a.base, a.session, 'INICIAL', ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ product_id: id, qty: 10 })));
        const { rows, newest } = await fetchChangedRows(a.base, 'stock_levels', {
            select: 'product_id, qty, updated_at', key: 'product_id', page: 2, filter: (x) => x.eq('sede_id', sedeId),
        });
        expect(rows.map((r) => r.product_id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
        expect(newest).toBeTruthy();
    }, 60_000);
});

describe('S5 · stock de la caja (stockMirror)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('tras la primera lectura, una venta de otra caja baja SOLO ese producto', async () => {
        const { cajas, sedeId } = await setup(db);
        const [a, b] = cajas;
        await moveStock(a.base, a.session, 'INICIAL', [1, 2, 3, 4, 5].map((n) => ({ product_id: `p${n}`, qty: 10 })));
        const local = { products: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, stock: 0 })) };
        const mirror = mirrorFor(a, sedeId, local);
        await mirror.refresh();
        expect(a.client.read.stock_levels).toBe(5);
        expect(stockOf(local)).toEqual({ p1: 10, p2: 10, p3: 10, p4: 10, p5: 10 });

        const sub = createSaleSubmitter({ client: b.base, getSession: () => b.session, store: memoryStore(), timeoutMs: 5000 });
        const r = await sub.submit(toServerSale({ nubeId: randomUUID(), totalUsd: 1, timestamp: new Date().toISOString(), items: [] }, [{ product_id: 'p2', qty: 3 }]));
        expect(r.ok).toBe(true);
        await mirror.refresh();
        expect(a.client.read.stock_levels).toBe(6); // antes: 10 (releía los 5)
        expect(stockOf(local).p2).toBe(7);
    }, 60_000);

    it('el aviso en vivo se aplica sin leer nada, y uno viejo no hace retroceder', async () => {
        const { cajas, sedeId } = await setup(db);
        const [a] = cajas;
        await moveStock(a.base, a.session, 'INICIAL', [{ product_id: 'p1', qty: 10 }]);
        const local = { products: [{ id: 'p1', stock: 0 }] };
        const mirror = mirrorFor(a, sedeId, local);
        expect(mirror.applyRealtime({ product_id: 'p1', qty: 4, sede_id: sedeId })).toBe(false); // sin la primera lectura: hay que leer
        await mirror.refresh();
        const before = a.client.read.stock_levels;

        const later = new Date(Date.now() + 1000).toISOString();
        expect(mirror.applyRealtime({ product_id: 'p1', qty: 8, sede_id: sedeId, updated_at: later })).toBe(true);
        await mirror.idle();
        expect(stockOf(local).p1).toBe(8);
        mirror.applyRealtime({ product_id: 'p1', qty: 9, sede_id: sedeId, updated_at: new Date(Date.now() - 60_000).toISOString() });
        await mirror.idle();
        expect(stockOf(local).p1).toBe(8);
        expect(mirror.applyRealtime({ product_id: 'p1', qty: 1, sede_id: 'otra-sede', updated_at: later })).toBe(true);
        await mirror.idle();
        expect(stockOf(local).p1).toBe(8);
        expect(a.client.read.stock_levels).toBe(before);
    }, 60_000);

    it('el stock de un producto que todavía no llegó a la caja se aplica cuando llega', async () => {
        const { cajas, sedeId } = await setup(db);
        const [a] = cajas;
        await moveStock(a.base, a.session, 'INICIAL', [{ product_id: 'p1', qty: 5 }, { product_id: 'nuevo', qty: 12 }]);
        const local = { products: [{ id: 'p1', stock: 0 }] };
        const mirror = mirrorFor(a, sedeId, local);
        await mirror.refresh();
        local.products.push({ id: 'nuevo', stock: 0 }); // bajó después el producto
        await mirror.refresh(); // sin cambios en la nube
        expect(stockOf(local)).toEqual({ p1: 5, nuevo: 12 });
    }, 60_000);

    it('un ajuste local que aún no sube no se pisa', async () => {
        const { cajas, sedeId } = await setup(db);
        const [a] = cajas;
        await moveStock(a.base, a.session, 'INICIAL', [{ product_id: 'p1', qty: 5 }, { product_id: 'p2', qty: 5 }]);
        const local = { products: [{ id: 'p1', stock: 99 }, { id: 'p2', stock: 0 }] };
        const mirror = mirrorFor(a, sedeId, local, fakeWatcher(['p1']));
        await mirror.refresh();
        expect(stockOf(local)).toEqual({ p1: 99, p2: 5 });
    }, 60_000);
});

describe('S5 · saldos de clientes incrementales', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('baja solo los saldos cambiados y aplica el de un cliente que llega después', async () => {
        const { cajas } = await setup(db);
        const [a, b] = cajas;
        const push = (caja, movements) => q(db, caja.user, 'select * from public.push_customer_movements($1, $2::jsonb)', [caja.session, JSON.stringify(movements)]);
        await push(b, [
            { id: randomUUID(), customer_id: 'c1', type: 'VENTA_FIADA', amount_usd: 5 },
            { id: randomUUID(), customer_id: 'c2', type: 'VENTA_FIADA', amount_usd: 7 },
        ]);
        const local = new Map([['bodega_customers_v1', [{ id: 'c1', name: 'Ana' }]]]);
        const ledger = createCustomerLedgerSync({
            client: a.client,
            getSession: () => a.session,
            store: memoryStore(),
            overlapMs: 0,
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
        });
        await ledger.pull();
        expect(a.client.read.customer_balances).toBe(2);
        expect(local.get('bodega_customers_v1')[0].deuda).toBe(5);

        await push(b, [{ id: randomUUID(), customer_id: 'c1', type: 'VENTA_FIADA', amount_usd: 1 }]);
        local.set('bodega_customers_v1', [...local.get('bodega_customers_v1'), { id: 'c2', name: 'Beto' }]);
        await ledger.pull();
        expect(a.client.read.customer_balances).toBe(3); // antes: 4 (releía los 2)
        const byId = Object.fromEntries(local.get('bodega_customers_v1').map((c) => [c.id, c.deuda]));
        expect(byId).toEqual({ c1: 6, c2: 7 });
    }, 60_000);
});

describe('S6 · un aviso por subida y ninguno por registros de caja', () => {
    let db;
    beforeAll(async () => {
        db = await createDb();
        // Un registro por cada escritura en account_sync_state = un mensaje en vivo.
        await db.exec(`
            create table public.test_touch_log (account_id uuid, collection text);
            grant all on public.test_touch_log to service_role;
            create function public.test_touch_count() returns trigger language plpgsql as $$
            begin insert into public.test_touch_log values (new.account_id, new.collection); return null; end $$;
            create trigger test_touch after insert or update on public.account_sync_state
                for each row execute function public.test_touch_count();`);
    }, 60_000);

    const touches = async (accountId, collection) => {
        const [r] = await q(db, 'service', 'select count(*)::int as n from public.test_touch_log where account_id = $1 and collection = $2', [accountId, collection]);
        return r.n;
    };

    it('subir 50 productos de una vez escribe UN solo aviso (antes: 50)', async () => {
        const { accountId, cajas } = await setup(db);
        const [a] = cajas;
        const records = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, data: { id: `p${i}`, name: `P${i}` } }));
        await q(db, a.user, 'select * from public.push_records($1, $2, $3::jsonb)', [a.session, 'products', JSON.stringify(records)]);
        expect(await touches(accountId, 'products')).toBe(1);
        await q(db, a.user, 'select * from public.push_records($1, $2, $3::jsonb)', [a.session, 'products', JSON.stringify(records.slice(0, 3))]);
        expect(await touches(accountId, 'products')).toBe(2); // otra subida, otro aviso
    }, 60_000);

    it('los registros de caja no avisan a las demás cajas', async () => {
        const { accountId, cajas } = await setup(db);
        const [a] = cajas;
        await q(db, a.user, 'select * from public.push_records($1, $2, $3::jsonb)',
            [a.session, 'cash', JSON.stringify([{ id: 'v1@a', data: { id: 'v1', tipo: 'VENTA', totalUsd: 1 } }])]);
        expect(await touches(accountId, 'cash')).toBe(0);
        const [rec] = await q(db, 'service', "select count(*)::int as n from public.account_records where account_id = $1 and collection = 'cash'", [accountId]);
        expect(rec.n).toBe(1);
    }, 60_000);
});
