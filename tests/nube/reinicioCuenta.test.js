/**
 * Reinicio de fábrica de la cuenta (014_reinicio_de_cuenta.sql + src/nube/accountReset.js)
 * contra el SQL real (PGlite), con dos cajas que sincronizan por registro.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync, SYNCED_KEYS } from '../../src/nube/recordSync.js';
import { checkAccountReset, resetAccount, ownerResetAccount, takeResetNotice, wipeLocalData, RESET_EPOCH_KEY } from '../../src/nube/accountReset.js';

function memoryStore() {
    const m = new Map();
    return {
        m,
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
        removeItem: async (k) => { m.delete(k); },
        keys: async () => [...m.keys()],
        clear: async () => { m.clear(); },
    };
}

function memoryLocalStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        key: (i) => [...m.keys()][i] ?? null,
        get length() { return m.size; },
    };
}

const PIN_ADMIN = '246801';
const PIN_CAJERO = '1357';
const PIN_DUENO = '482913';

async function setupAccount(db) {
    const email = `reinicio-${Math.random()}@x.test`;
    const owner = await createUser(db, { email });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Bodega Reinicio', 'Centro', 'Dueño', PIN_DUENO]);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 10 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', PIN_ADMIN]);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', PIN_CAJERO]);
    const [{ id: ownerMemberId }] = await q(db, 'service', "select id from public.account_members where account_id = $1 and role = 'dueno'", [accountId]);
    return { owner, email, accountId, adminId, cajeroId, ownerMemberId };
}

async function makeCaja(db, ctx, label) {
    const user = await createUser(db, { anonymous: true });
    await q(db, ctx.owner, 'select * from public.register_device($1, $2)', [user.id, label]);
    const [{ id: deviceId }] = await q(db, 'service', 'select id from public.account_devices where auth_user_id = $1', [user.id]);
    const client = new FakeSupabase(db);
    client.user = user;
    const caja = {
        user, client, deviceId,
        appStore: memoryStore(), // IndexedDB BodegaApp
        shadowStore: memoryStore(),
        syncStore: memoryStore(), // PreciosAlDiaNube/pdn_sync
        storage: memoryLocalStorage(),
        session: null,
        offline: false,
    };
    caja.login = async (memberId, pin) => {
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [memberId, pin]);
        caja.session = s.session_token;
        return s.session_token;
    };
    // Sin internet: la RPC no llega.
    const net = {
        rpc: (fn, args) => (caja.offline ? Promise.resolve({ data: null, error: { message: 'Failed to fetch' } }) : client.rpc(fn, args)),
        from: (t) => client.from(t),
    };
    const engine = () => createRecordSync({
        client: net, getSession: () => caja.session, store: caja.syncStore, cashIdSuffix: deviceId,
        readLocal: (k) => caja.appStore.getItem(k),
        writeLocal: (k, v) => caja.appStore.setItem(k, v),
    });
    caja.sync = engine();
    caja.write = async (k, v) => { await caja.appStore.setItem(k, v); await caja.sync.onLocalWrite(k, v); await caja.sync.flush(); };
    // Arranque de useNubeSync tras entrar con PIN: pull + «lo guardado sin el enganche» + flush.
    caja.restart = async () => {
        caja.sync = engine();
        await caja.sync.pull();
        for (const key of Object.keys(SYNCED_KEYS)) {
            const value = await caja.appStore.getItem(key);
            if (value !== null) await caja.sync.onLocalWrite(key, value);
        }
        await caja.sync.flush();
    };
    caja.stores = () => ({ appStore: caja.appStore, shadowStore: caja.shadowStore, syncStore: caja.syncStore, storage: caja.storage });
    return caja;
}

const live = (db, accountId, collection) => q(db, 'service',
    'select id from public.account_records where account_id = $1 and collection = $2 and deleted_at is null order by id', [accountId, collection]);
const count = async (db, table, accountId) => Number((await q(db, 'service', `select count(*)::int n from public.${table} where account_id = $1`, [accountId]))[0].n);

describe('Reinicio de fábrica de la cuenta', () => {
    let db;
    let ctx;
    let a;
    let b;
    let ownerClient;
    let result;
    const ts = new Date().toISOString();
    const RATE = { rate: 400, at: ts };

    beforeAll(async () => {
        db = await createDb();
        ctx = await setupAccount(db);
        a = await makeCaja(db, ctx, 'Caja A');
        b = await makeCaja(db, ctx, 'Caja B');
        await a.login(ctx.adminId, PIN_ADMIN);
        await b.login(ctx.adminId, PIN_ADMIN);

        await a.write('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1, stock: 5 }, { id: 'p2', name: 'Arroz', priceUsd: 2, stock: 3 }]);
        await a.write('bodega_customers_v1', [{ id: 'c1', name: 'Ana', deuda: 4 }]);
        await a.write('bodega_suppliers_v1', [{ id: 's1', name: 'Polar' }]);
        await a.write('bodega_payment_methods_v1', [{ id: 'efectivo', label: 'Efectivo' }]);
        await a.write('my_categories_v1', ['Víveres']);
        await a.write('pdn_rate_v1', RATE);
        await a.write('bodega_sales_v1', [{ id: 'v1', tipo: 'VENTA', totalUsd: 3, timestamp: ts }]);
        await a.appStore.setItem('bodega_customer_ledger_v1', [{ id: 'm1' }]);
        await a.shadowStore.setItem('bodega_products_v1', [{ id: 'p1' }]);
        a.storage.setItem('bodega_pending_cart_v1', '[1]');
        a.storage.setItem('printer_width', '58');

        // Stock en el servidor, una venta y una deuda.
        await q(db, a.user, 'select * from public.process_stock_movements($1, $2, $3)',
            [a.session, 'INICIAL', JSON.stringify([{ id: randomUUID(), product_id: 'p1', qty: 5 }, { id: randomUUID(), product_id: 'p2', qty: 3 }])]);
        await q(db, a.user, 'select * from public.process_checkout($1, $2)',
            [a.session, JSON.stringify({ id: randomUUID(), items: [{ product_id: 'p1', qty: 2 }], total_usd: 2 })]);
        await q(db, a.user, 'select * from public.push_customer_movements($1, $2)',
            [a.session, JSON.stringify([{ id: 'cm1', customer_id: 'c1', type: 'VENTA_FIADA', amount_usd: 4 }])]);

        await b.sync.pull();
        await b.write('bodega_sales_v1', [{ id: 'v9', tipo: 'VENTA', totalUsd: 7, timestamp: ts }]);

        // B se queda sin internet con cambios en cola (un producto nuevo y una venta).
        b.offline = true;
        const bProducts = await b.appStore.getItem('bodega_products_v1');
        await b.write('bodega_products_v1', [...bProducts, { id: 'p3', name: 'Aceite', priceUsd: 4 }]);
        await b.syncStore.setItem('pdn_sale_queue_v1', [{ sale: { id: randomUUID() } }]);
        expect(await b.sync.pendingCount()).toBeGreaterThan(0);

        ownerClient = new FakeSupabase(db);
        ownerClient.user = ctx.owner;
    }, 60_000);

    it('nadie más que el dueño con su correo puede reiniciar', async () => {
        // Administrador, cajero y dueño con PIN corren en la sesión anónima de la caja.
        expect(await expectError(resetAccount(a.client))).toMatch(/Solo el dueño/);
        const caj = await makeCaja(db, ctx, 'Caja C');
        await caj.login(ctx.cajeroId, PIN_CAJERO);
        expect(await expectError(resetAccount(caj.client))).toMatch(/Solo el dueño/);
        await caj.login(ctx.ownerMemberId, PIN_DUENO);
        expect(await expectError(resetAccount(caj.client))).toMatch(/Solo el dueño/);
        // Otro dueño (otra cuenta) no reinicia ésta.
        const other = await createUser(db, { email: `otro-${Math.random()}@x.test` });
        const otherClient = new FakeSupabase(db);
        otherClient.user = other;
        expect(await expectError(resetAccount(otherClient))).toMatch(/Solo el dueño/);
        // Sin la confirmación no borra nada.
        const { error } = await ownerClient.rpc('reset_account', { p_confirm: 'si' });
        expect(error?.message).toMatch(/confirmación/);
        expect((await live(db, ctx.accountId, 'products')).length).toBe(2);
    });

    it('el dueño reinicia: el servidor queda vacío salvo métodos de pago y tasa, y todo queda archivado', async () => {
        result = await resetAccount(ownerClient);
        expect(result.epoch).toBe(1);
        expect(result.counts.sales).toBe(1);
        expect(result.counts.customer_movements).toBe(1);

        for (const c of ['products', 'customers', 'suppliers', 'cash']) expect(await live(db, ctx.accountId, c)).toEqual([]);
        expect((await live(db, ctx.accountId, 'settings')).map((r) => r.id)).toEqual(['pdn_rate_v1']);
        expect((await live(db, ctx.accountId, 'payment_methods')).map((r) => r.id)).toEqual(['efectivo']);
        for (const t of ['sales', 'stock_movements', 'stock_levels', 'customer_movements', 'customer_balances', 'stock_discrepancies']) {
            expect(await count(db, t, ctx.accountId)).toBe(0);
        }
        const archived = await q(db, 'service',
            'select table_name, count(*)::int n from nube_private.account_reset_archive where reset_id = $1 group by 1 order by 1', [result.reset_id]);
        expect(Object.fromEntries(archived.map((r) => [r.table_name, r.n]))).toMatchObject({ sales: 1, stock_movements: 3, customer_movements: 1 });
        // El revisor de cuadres no encuentra nada roto en la cuenta.
        const bad = await q(db, 'service', 'select * from nube_private.verify_invariants() where account_id = $1', [ctx.accountId]);
        expect(bad).toEqual([]);
        // Los libros siguen sin dejarse borrar fuera del reinicio.
        await q(db, a.user, 'select * from public.process_stock_movements($1, $2, $3)', [await a.login(ctx.adminId, PIN_ADMIN), 'INICIAL',
            JSON.stringify([{ id: randomUUID(), product_id: 'x', qty: 1 }])]);
        expect(await expectError(q(db, 'service', 'delete from public.stock_movements where account_id = $1', [ctx.accountId]))).toMatch(/no se edita ni se borra/);
        a.session = null;
    });

    it('la cuenta, la licencia, las sedes, los equipos y los empleados con su PIN siguen', async () => {
        expect(await count(db, 'account_licenses', ctx.accountId)).toBe(1);
        expect(await count(db, 'sedes', ctx.accountId)).toBe(1);
        const devices = await q(db, 'service', 'select revoked_at from public.account_devices where account_id = $1', [ctx.accountId]);
        expect(devices.length).toBe(3);
        expect(devices.every((d) => d.revoked_at === null)).toBe(true);
        const members = await q(db, 'service', 'select role from public.account_members where account_id = $1 order by role', [ctx.accountId]);
        expect(members.map((m) => m.role)).toEqual(['administrador', 'cajero', 'dueno']);
    });

    it('las sesiones de PIN quedaron cerradas: la cola vieja de B no puede subir', async () => {
        b.offline = false;
        await b.sync.flush();
        expect(b.sync.getLastError()).toMatch(/sesión venció/);
        expect(await live(db, ctx.accountId, 'products')).toEqual([]);
    });

    it('cada caja detecta el reinicio y queda vacía; B descarta lo que no había subido', async () => {
        const ra = await checkAccountReset(a.client, a.stores());
        expect(ra.reset).toBe(true);
        const rb = await checkAccountReset(b.client, b.stores());
        expect(rb).toMatchObject({ reset: true, epoch: 1 });
        expect(rb.discarded).toBeGreaterThanOrEqual(2); // el producto en cola y la venta sin subir

        for (const caja of [a, b]) {
            expect(await caja.appStore.getItem('bodega_products_v1')).toEqual([]);
            expect(await caja.appStore.getItem('bodega_customers_v1')).toEqual([]);
            expect(await caja.appStore.getItem('bodega_sales_v1')).toEqual([]);
            expect(await caja.appStore.getItem('bodega_suppliers_v1')).toEqual([]);
            expect(await caja.syncStore.getItem('pdn_sale_queue_v1')).toBeNull();
            expect(await caja.syncStore.getItem('pdn_sync_products_v1')).toBeNull();
            expect(await caja.syncStore.getItem(RESET_EPOCH_KEY)).toBe(1);
        }
        expect(await a.appStore.getItem('bodega_customer_ledger_v1')).toEqual([]);
        expect(await a.appStore.getItem('my_categories_v1')).toEqual([]);
        expect(await a.shadowStore.keys()).toEqual([]);
        expect(a.storage.getItem('bodega_pending_cart_v1')).toBeNull();
        // Se conserva lo que el servidor también conserva y las preferencias del equipo.
        expect(await a.appStore.getItem('pdn_rate_v1')).toEqual(RATE);
        expect(await a.appStore.getItem('bodega_payment_methods_v1')).toEqual([{ id: 'efectivo', label: 'Efectivo' }]);
        expect(a.storage.getItem('printer_width')).toBe('58');
        expect(takeResetNotice(b.storage)).toMatch(/descartaron \d+ cambio/);
        // Una segunda revisión ya no vuelve a vaciar.
        expect((await checkAccountReset(a.client, a.stores())).reset).toBe(false);
    });

    it('tras volver a entrar con PIN, ninguna caja resucita datos viejos y el stock y los saldos están en 0', async () => {
        await a.login(ctx.adminId, PIN_ADMIN);
        await b.login(ctx.adminId, PIN_ADMIN);
        await a.restart();
        await b.restart();
        expect(await live(db, ctx.accountId, 'products')).toEqual([]);
        expect(await live(db, ctx.accountId, 'customers')).toEqual([]);
        expect(await live(db, ctx.accountId, 'cash')).toEqual([]);
        expect((await live(db, ctx.accountId, 'payment_methods')).map((r) => r.id)).toEqual(['efectivo']);
        // B vuelve a tener la tasa y los métodos de pago (los bajó de nuevo o los conservó).
        expect(await b.appStore.getItem('pdn_rate_v1')).toEqual(RATE);
        expect(b.sync.getLastError()).toBeNull();

        const levels = await q(db, a.user, 'select product_id, qty from public.stock_levels where qty <> 0');
        expect(levels.map((l) => l.product_id)).toEqual(['x']); // solo lo cargado después del reinicio
        expect(await q(db, a.user, 'select * from public.customer_balances')).toEqual([]);

        // La numeración de ventas vuelve a empezar.
        const [sale] = await q(db, a.user, 'select * from public.process_checkout($1, $2, false, true)',
            [a.session, JSON.stringify({ id: randomUUID(), items: [{ product_id: 'x', qty: 1 }], total_usd: 1 })]);
        expect(sale.number).toBe('#A-00001');
    });

    it('desde la pantalla: correo y clave del dueño de ESTA cuenta; la caja se vacía al momento', async () => {
        const other = await setupAccount(db);
        const logins = new Map([[ctx.email, { id: ctx.owner.id, password: 'clave-buena' }], [other.email, { id: other.owner.id, password: 'otra-clave' }]]);
        const fresh = () => new FakeSupabase(db, { accounts: logins });
        await a.write('bodega_products_v1', [{ id: 'n1', name: 'Nuevo', priceUsd: 1 }]);

        expect(await expectError(ownerResetAccount({ deviceClient: a.client, ownerClient: fresh(), email: ctx.email, password: 'mala', stores: a.stores() })))
            .toMatch(/incorrectos/);
        // El dueño de otro negocio no reinicia esta caja (ni el suyo por error).
        expect(await expectError(ownerResetAccount({ deviceClient: a.client, ownerClient: fresh(), email: other.email, password: 'otra-clave', stores: a.stores() })))
            .toMatch(/no es el del dueño de esta cuenta/);
        expect((await live(db, ctx.accountId, 'products')).length).toBe(1);

        const owner = fresh();
        const res = await ownerResetAccount({ deviceClient: a.client, ownerClient: owner, email: ctx.email, password: 'clave-buena', stores: a.stores() });
        expect(res.epoch).toBe(2);
        expect(res.local.reset).toBe(true);
        expect(owner.user).toBeNull(); // la sesión temporal del dueño se cerró
        expect(await a.appStore.getItem('bodega_products_v1')).toEqual([]);
        expect(await live(db, ctx.accountId, 'products')).toEqual([]);
        expect((await checkAccountReset(b.client, b.stores())).reset).toBe(true);
    });

    it('wipeLocalData con keepSettings=false limpia incluso tasa, métodos de pago y syncStore al cambiar de cuenta', async () => {
        const stores = a.stores();
        await stores.appStore.setItem('bodega_products_v1', [{ id: 'p1' }]);
        await stores.appStore.setItem('bodega_payment_methods_v1', [{ id: 'pm1' }]);
        await stores.appStore.setItem('pdn_rate_v1', { rate: 60 });
        await stores.syncStore.setItem('pdn_sync_payment_methods_v1', { versions: { pm1: { v: 1 } }, queue: [] });
        await stores.syncStore.setItem('pdn_sync_settings_v1', { versions: { pdn_rate_v1: { v: 1 } }, queue: [] });
        stores.storage.setItem('pdn_rate_v1', '{"rate":60}');

        await wipeLocalData(stores, { keepSettings: false });

        expect(await stores.appStore.getItem('bodega_products_v1')).toEqual([]);
        expect(await stores.appStore.getItem('bodega_payment_methods_v1')).toEqual([]);
        expect(await stores.appStore.getItem('pdn_rate_v1')).toBeNull();
        expect(await stores.syncStore.keys()).toEqual([]);
        expect(stores.storage.getItem('pdn_rate_v1')).toBeNull();
    });
});
