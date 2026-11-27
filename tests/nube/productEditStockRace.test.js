/**
 * T03 · Edición concurrente de producto (stockTouched), CONTEO físico en edición directa,
 * vaciado de stock en fusión/borrado de duplicados y resyncCartItems (_unitsPerPackage + packagingType).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createStockWatcher } from '../../src/nube/stockWatcher.js';
import { fetchStockLevels, moveStock, createSaleSubmitter, toServerSale } from '../../src/nube/stockService.js';
import { persistCatalogLocked } from '../../src/utils/catalogLock.js';
import { resyncCartItems } from '../../src/utils/cartSync.js';
import { prepareProductFormState } from '../../src/hooks/useProductForm.js';
import { applyProductFormEdit } from '../../src/utils/productProcessor.js';

function memoryStore() {
    const m = new Map();
    return {
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['T03', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const user = await createUser(db, { anonymous: true });
    await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, 'Caja A']);
    const [admin] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const client = new FakeSupabase(db);
    client.user = user;
    return { user, client, admin: admin.session_token };
}

describe('T03 · edición concurrente de producto, CONTEO y cartSync', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('C2 abrir edición con stock 10, Caja B vende 3 (stock=7), Admin cambia solo precio sin tocar stock -> preserva stock 7 y watcher encola 0', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'p1', qty: 10 }]);
        const store = memoryStore();
        const watcher = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store });
        await watcher.setBaseline([{ id: 'p1', stock: 10 }]);

        // 1. Admin abre el modal de edición cuando stock=10.
        const snapshotAtOpen = [{ id: 'p1', name: 'Harina', priceUsdt: 1.0, stock: 10, stockInLotes: 0 }];
        const formInit = prepareProductFormState(snapshotAtOpen[0], 50);
        expect(formInit.stockTouched).toBe(false);

        // 2. Mientras el modal está abierto, Caja B vende 3 uds -> storage local y baseline pasan a 7.
        const sales = createSaleSubmitter({ client: ctx.client, getSession: () => ctx.admin, store });
        await sales.submit(toServerSale({ nubeId: randomUUID(), items: [] }, [{ product_id: 'p1', qty: 3 }]));
        const fakeStorageMap = new Map([['bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsdt: 1.0, stock: 7, stockInLotes: 0 }]]]);
        await watcher.setBaseline([{ id: 'p1', stock: 7 }]);

        const fakeStorage = {
            getItem: async (k, def) => (fakeStorageMap.has(k) ? structuredClone(fakeStorageMap.get(k)) : def),
            setItem: async (k, v) => { fakeStorageMap.set(k, structuredClone(v)); },
        };

        // 3. Admin cambia solo el precio a 1.50 (stockTouched=false) y guarda.
        // El producto en el formulario todavía tenía stock: 10 en productData (como ocurre en buildProductPayload),
        // pero applyProductFormEdit con stockTouched=false NO sobreescribe stock/stockInLotes.
        const edited = applyProductFormEdit(
            snapshotAtOpen[0],
            { name: 'Harina', priceUsdt: 1.5, stock: 10, stockInLotes: 0 },
            { stockTouched: false, finalImage: undefined },
        );
        // Al persistir contra el catálogo fresco (donde stock=7), mergeProduct3Way debe preservar stock=7.
        // OJO: en el escenario real `products` de React YA pudo haberse actualizado a 7 por Realtime mientras el modal
        // seguía abierto con `stock='10'` en el form state! Simulemos ese caso exacto: base tiene stock=7,
        // pero productData del form tenía stock=10.
        const currentReactProducts = [{ id: 'p1', name: 'Harina', priceUsdt: 1.0, stock: 7, stockInLotes: 0 }];
        const editedAgainstCurrent = applyProductFormEdit(
            currentReactProducts[0],
            { name: 'Harina', priceUsdt: 1.5, stock: 10, stockInLotes: 0 },
            { stockTouched: false, finalImage: undefined },
        );
        expect(edited.stock).toBe(10);
        expect(editedAgainstCurrent.stock).toBe(7);

        const persisted = await persistCatalogLocked({
            local: [editedAgainstCurrent],
            base: currentReactProducts,
            storage: fakeStorage,
        });
        expect(persisted[0].stock).toBe(7);
        expect(persisted[0].priceUsdt).toBe(1.5);

        const added = await watcher.onProductsWrite(persisted);
        expect(added).toBe(0);
        await watcher.flush();
        expect((await fetchStockLevels(ctx.client)).p1).toBe(7);
    });

    it('C2/A14 resyncCartItems actualiza _unitsPerPackage y packagingType cuando otra caja cambia el empaque', () => {
        const cart = [{
            id: 'p1',
            _originalId: 'p1',
            _mode: 'package',
            _unitsPerPackage: 12,
            unitsPerPackage: 12,
            packagingType: 'bulto',
            name: 'Refresco',
            qty: 2,
            priceUsd: 12,
        }];
        const products = [{
            id: 'p1',
            name: 'Refresco',
            priceUsdt: 24,
            unitsPerPackage: 24,
            packagingType: 'caja',
            sellByUnit: true,
            unitPriceUsd: 1.2,
        }];
        const res = resyncCartItems(cart, products, { effectiveRate: 50 });
        expect(res).not.toBeNull();
        expect(res.cart[0]._unitsPerPackage).toBe(24);
        expect(res.cart[0].packagingType).toBe('caja');
    });

    it('M2 submitStockCount con CONTEO fija el stock objetivo en el servidor (ej. 0 al absorber duplicado o conteo físico directo)', async () => {
        const ctx = await setup(db);
        await moveStock(ctx.client, ctx.admin, 'INICIAL', [{ product_id: 'dup1', qty: 12 }]);
        const store = memoryStore();
        const watcher = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin, store });
        await watcher.setBaseline([{ id: 'dup1', stock: 12 }]);

        // Otra caja vendió 2 unidades (servidor=10), Caja A aún no lo sabía y hace CONTEO a 0 por fusión
        const sales = createSaleSubmitter({ client: ctx.client, getSession: () => ctx.admin, store });
        await sales.submit(toServerSale({ nubeId: randomUUID(), items: [] }, [{ product_id: 'dup1', qty: 2 }]));

        await watcher.submitStockCount('dup1', 0, 'Producto absorbido en fusión');
        await watcher.flush();

        // Con CONTEO el servidor fija exactamente 0 (no -2 como haría un delta -12!)
        expect((await fetchStockLevels(ctx.client)).dup1).toBe(0);
    });
});
