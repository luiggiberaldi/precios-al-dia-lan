/**
 * Auditoría de Ajustes → «Zona de Peligro» con la nube activa, contra el SQL real (PGlite).
 *
 * Reproduce lo que hacen hoy los dos botones en una caja con sesión de administrador:
 *   · «Borrar historial de ventas» = storageService.setItem('bodega_sales_v1', []) → el
 *     enganche de la nube sube BAJAS de los registros de caja de ESTA caja.
 *   · «Empezar desde cero» = resetPOSDataToEmpty(): escribe `[]` directo en IndexedDB (sin
 *     avisar a la nube) y luego publica por el sincronizador viejo de Bodega (apagado en
 *     nube). Al volver a abrir la app, el arranque de useNubeSync toma esos `[]` como
 *     cambios locales y borra el catálogo y los clientes de TODA la cuenta.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync, SYNCED_KEYS } from '../../src/nube/recordSync.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function setupAccount(db) {
    const owner = await createUser(db, { email: `zp-${Math.random()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Peligro', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 10 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    return { owner, adminId };
}

async function makeCaja(db, { owner, adminId }, label) {
    const user = await createUser(db, { anonymous: true });
    const [dev] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, label]);
    const [{ id: deviceId }] = await q(db, 'service', 'select id from public.account_devices where auth_user_id = $1', [user.id]);
    const client = new FakeSupabase(db);
    client.user = user;
    const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const local = new Map();
    const store = memoryStore();
    const engine = () => createRecordSync({
        client, getSession: () => s.session_token, store, cashIdSuffix: deviceId,
        readLocal: async (k) => structuredClone(local.get(k) ?? null),
        writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
    });
    let sync = engine();
    // storageService.setItem con la nube activa: guarda y avisa al sincronizador.
    const write = async (k, v) => { local.set(k, structuredClone(v)); await sync.onLocalWrite(k, v); await sync.flush(); };
    // Arranque de useNubeSync tras recargar: pull + «lo que se guardó sin el enganche».
    const restart = async () => {
        sync = engine();
        await sync.pull();
        for (const key of Object.keys(SYNCED_KEYS)) {
            const value = local.get(key) ?? null;
            if (value !== null) await sync.onLocalWrite(key, value);
        }
        await sync.flush();
    };
    return { local, write, restart, get sync() { return sync; }, deviceId, dev };
}

const live = (db, collection) => q(db, 'service',
    'select id from public.account_records where collection = $1 and deleted_at is null order by id', [collection]);

describe('Zona de Peligro con la nube activa', () => {
    let db;
    let ctx;
    let a;
    let b;
    const ts = new Date().toISOString();

    beforeAll(async () => {
        db = await createDb();
        ctx = await setupAccount(db);
        a = await makeCaja(db, ctx, 'Caja A');
        b = await makeCaja(db, ctx, 'Caja B');
        await a.write('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1, stock: 5 }, { id: 'p2', name: 'Arroz', priceUsd: 2, stock: 3 }]);
        await a.write('bodega_customers_v1', [{ id: 'c1', name: 'Ana', deuda: 4 }]);
        await a.write('bodega_sales_v1', [
            { id: 'apA', tipo: 'APERTURA_CAJA', openingUsd: 10, timestamp: ts, cajaCerrada: false },
            { id: 'v1', tipo: 'VENTA', totalUsd: 3, timestamp: ts },
        ]);
        await b.write('bodega_sales_v1', [{ id: 'v9', tipo: 'VENTA', totalUsd: 7, timestamp: ts }]);
        await b.sync.pull();
    }, 60_000);

    it('«Borrar historial»: borra en el servidor el turno de ESTA caja (no solo lo local); B y el catálogo siguen', async () => {
        await a.write('bodega_sales_v1', []);
        expect(await a.sync.pendingCount()).toBe(0); // nada queda en cola
        const cash = (await live(db, 'cash')).map((r) => r.id);
        expect(cash).toEqual([`v9@${b.deviceId}`]); // lo de A desapareció del consolidado del dueño
        expect((await live(db, 'products')).length).toBe(2);
        expect((await live(db, 'customers')).length).toBe(1);
        // B no baja registros de caja: su historial no cambia.
        expect(b.local.get('bodega_sales_v1')).toHaveLength(1);
    });

    // Por esto resetPOSDataToEmpty queda bloqueado en nube (tests/cloudSyncEmptySnapshot.test.js).
    it('`[]` locales como los de «Empezar desde cero» + recargar: borran catálogo y clientes de TODA la cuenta', async () => {
        // resetPOSDataToEmpty: `[]` directo en IndexedDB, sin enganche (la publicación
        // vieja de Bodega falla en nube con «La sincronización no está activa»).
        for (const key of ['bodega_sales_v1', 'bodega_products_v1', 'bodega_customers_v1', 'bodega_suppliers_v1']) a.local.set(key, []);
        await a.restart();
        expect(await live(db, 'products')).toEqual([]);
        expect(await live(db, 'customers')).toEqual([]);
        await b.sync.pull();
        expect(b.local.get('bodega_products_v1')).toEqual([]);
        expect(b.local.get('bodega_customers_v1')).toEqual([]);
    });
});
