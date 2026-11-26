/**
 * D10 · importar el respaldo de Bodega a la nube, con el respaldo de demostración real
 * (public/demo-backup.json) y el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { importBackupToCloud, previewImport } from '../../src/nube/importBackup.js';

const demo = JSON.parse(readFileSync('public/demo-backup.json', 'utf8'));

describe('D10 · importar respaldo de Precios al Día', () => {
    let db;
    let owner;
    beforeAll(async () => {
        db = await createDb();
        const user = await createUser(db, { email: 'imp@x.test' });
        await q(db, user, 'select public.create_account($1,$2,$3,$4)', ['Importada', 'Centro', 'Dueño', '482913']);
        owner = new FakeSupabase(db);
        owner.user = user;
    }, 60_000);

    it('muestra qué se va a importar sin subir nada', () => {
        const preview = previewImport(demo);
        const byCollection = Object.fromEntries(preview.map((p) => [p.collection, p.count]));
        expect(byCollection.products).toBe(demo.data.idb.bodega_products_v1.length);
        expect(byCollection.customers).toBe(demo.data.idb.bodega_customers_v1.length);
        expect(byCollection.settings).toBe(1);
    });

    it('sube productos, clientes, métodos de pago y categorías; sin stock ni saldos', async () => {
        const progress = [];
        const result = await importBackupToCloud(owner, demo, { onProgress: (p) => progress.push(p) });
        expect(result.products).toBe(demo.data.idb.bodega_products_v1.length);
        expect(progress.length).toBeGreaterThan(0);

        const products = await q(db, owner.user, "select data from public.account_records where collection = 'products'");
        expect(products.every((p) => p.data.stock === undefined)).toBe(true);
        const customers = await q(db, owner.user, "select data from public.account_records where collection = 'customers'");
        expect(customers.every((c) => c.data.deuda === undefined && c.data.favor === undefined)).toBe(true);
        const [cats] = await q(db, owner.user, "select data from public.account_records where collection = 'settings' and id = 'my_categories_v1'");
        expect(cats.data.value).toEqual(demo.data.idb.my_categories_v1);
    });

    it('importar dos veces no duplica (G7)', async () => {
        const [{ n: before }] = await q(db, owner.user, 'select count(*)::int n from public.account_records');
        await importBackupToCloud(owner, demo);
        const [{ n: after }] = await q(db, owner.user, 'select count(*)::int n from public.account_records');
        expect(after).toBe(before);
    });

    it('rechaza archivos que no son un respaldo', () => {
        expect(() => previewImport({ hola: 1 })).toThrow(/Formato invalido/i);
        expect(() => previewImport({ data: { otra: 1 } })).toThrow(/no contiene datos/i);
    });
});

describe('D10 · stock del respaldo como CONTEO (F3)', () => {
    it('la nube queda igual al respaldo (también los en 0) y reimportar no duplica', async () => {
        const { importInitialStock, stableUuid } = await import('../../src/nube/importBackup.js');
        const db = await createDb();
        const user = await createUser(db, { email: 'stock@x.test' });
        const [{ create_account: accountId }] = await q(db, user, 'select public.create_account($1,$2,$3,$4)', ['Stock', 'Centro', 'Dueño', '482913']);
        const owner = new FakeSupabase(db);
        owner.user = user;
        const all = demo.data.idb.bodega_products_v1;
        expect(await importInitialStock(owner, demo, { accountId })).toBe(all.length);
        await importInitialStock(owner, demo, { accountId });
        const levels = await q(db, user, 'select product_id, qty from public.stock_levels');
        const byId = Object.fromEntries(levels.map((l) => [l.product_id, Number(l.qty)]));
        for (const p of all) expect(byId[p.id]).toBe(Math.max(0, Number(p.stock) || 0));
        const [{ n }] = await q(db, user, "select count(*)::int n from public.stock_movements where reason = 'CONTEO'");
        expect(n).toBe(all.filter((p) => Number(p.stock) > 0).length);
        expect(await stableUuid('a')).toBe(await stableUuid('a'));
        expect(await stableUuid('a')).not.toBe(await stableUuid('b'));
    }, 60_000);

    it('otro respaldo corrige el stock (sube y baja, hasta 0)', async () => {
        const { importInitialStock } = await import('../../src/nube/importBackup.js');
        const db = await createDb();
        const user = await createUser(db, { email: 'stock2@x.test' });
        const [{ create_account: accountId }] = await q(db, user, 'select public.create_account($1,$2,$3,$4)', ['Stock2', 'Centro', 'Dueño', '482913']);
        const owner = new FakeSupabase(db);
        owner.user = user;
        const backup = (timestamp, products) => ({ version: '2.0', timestamp, data: { idb: { bodega_products_v1: products } } });
        await importInitialStock(owner, backup('2026-11-01', [{ id: 'a', stock: 10 }, { id: 'b', stock: 4 }, { id: 'g', stock: 1.25 }]), { accountId });
        await importInitialStock(owner, backup('2026-11-02', [{ id: 'a', stock: 3 }, { id: 'b', stock: 0 }, { id: 'g', stock: 2.5 }]), { accountId });
        const levels = await q(db, user, 'select product_id, qty from public.stock_levels order by product_id');
        expect(levels.map((l) => [l.product_id, Number(l.qty)])).toEqual([['a', 3], ['b', 0], ['g', 2.5]]);
    }, 60_000);
});

describe('D10 · deudas y saldos a favor del respaldo (F4)', () => {
    it('cargan como SALDO_INICIAL_MIGRADO y reimportar no los duplica', async () => {
        const { importInitialBalances } = await import('../../src/nube/importBackup.js');
        const db = await createDb();
        const user = await createUser(db, { email: 'saldos@x.test' });
        const [{ create_account: accountId }] = await q(db, user, 'select public.create_account($1,$2,$3,$4)', ['Saldos', 'Centro', 'Dueño', '482913']);
        const owner = new FakeSupabase(db);
        owner.user = user;
        const json = { version: '2.0', data: { idb: { bodega_customers_v1: [
            { id: 'c1', name: 'Debe', deuda: 12.5, favor: 0 },
            { id: 'c2', name: 'A favor', deuda: 0, favor: 3 },
            { id: 'c3', name: 'En cero', deuda: 0, favor: 0 },
        ] } } };
        expect(await importInitialBalances(owner, json, { accountId })).toBe(2);
        await importInitialBalances(owner, json, { accountId });
        const rows = await q(db, user, 'select customer_id, balance_usd from public.customer_balances order by customer_id');
        expect(rows.map((r) => [r.customer_id, Number(r.balance_usd)])).toEqual([['c1', -12.5], ['c2', 3]]);
    }, 60_000);
});
