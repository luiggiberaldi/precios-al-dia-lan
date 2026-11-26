/**
 * F2 · sincronizador de registros contra el SQL real (PGlite): dos cajas de la misma
 * cuenta (A11 en pequeño), cola que sobrevive a errores (G10) y campos de libro intactos.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import {
    createRecordSync, toRecords, mergeIntoLocal, hashOf, toCloudData, SYNCED_KEYS, MAX_RECORD_BYTES,
    cashRecordId, MAX_RECORD_ID,
} from '../../src/nube/recordSync.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function setupAccount(db) {
    const owner = await createUser(db, { email: 'sync@x.test' });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Sync', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 10 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    return { owner, adminId };
}

async function makeCaja(db, { owner, adminId }, label) {
    const user = await createUser(db, { anonymous: true });
    await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, label]);
    const client = new FakeSupabase(db);
    client.user = user;
    const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const local = new Map();
    let session = s.session_token;
    const sync = createRecordSync({
        client,
        getSession: () => session,
        store: memoryStore(),
        readLocal: async (k) => structuredClone(local.get(k) ?? null),
        writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
    });
    // Simula storageService.setItem: guarda local y avisa al sincronizador.
    const write = async (k, v) => { local.set(k, structuredClone(v)); await sync.onLocalWrite(k, v); await sync.flush(); };
    return { sync, local, write, client, setSession: (v) => { session = v; }, get sessionToken() { return session; } };
}

describe('F2 · utilidades', () => {
    it('hash estable sin importar el orden de las propiedades', () => {
        expect(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
        expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    });

    it('a la nube no viaja el stock ni los saldos, ni imágenes incrustadas enormes', () => {
        const [p] = toRecords('bodega_products_v1', [{ id: 'p1', name: 'X', stock: 5, stockInLotes: 1 }]);
        expect(p).toEqual({ id: 'p1', data: { id: 'p1', name: 'X' } });
        const [c] = toRecords('bodega_customers_v1', [{ id: 'c1', name: 'Ana', deuda: 3, favor: 1 }]);
        expect(c.data).toEqual({ id: 'c1', name: 'Ana' });
        const big = toCloudData(SYNCED_KEYS.bodega_products_v1, { id: 'p', image: `data:image/png;base64,${'A'.repeat(MAX_RECORD_BYTES)}` });
        expect(big).toEqual({ id: 'p' });
        expect(toRecords('my_categories_v1', ['Víveres'])).toEqual([{ id: 'my_categories_v1', data: { value: ['Víveres'] } }]);
        expect(toRecords('bodega_products_v1', [{ name: 'sin id' }])).toEqual([]);
    });

    it('al fundir conserva el stock local y aplica altas, cambios y bajas', () => {
        const local = [{ id: 'p1', name: 'Viejo', stock: 7 }, { id: 'p2', name: 'Borrar', stock: 1 }];
        const merged = mergeIntoLocal('bodega_products_v1', local, [
            { id: 'p1', data: { id: 'p1', name: 'Nuevo', priceUsd: 2 } },
            { id: 'p2', data: { id: 'p2' }, deleted_at: '2026-01-01' },
            { id: 'p3', data: { id: 'p3', name: 'Alta' } },
        ]);
        expect(merged).toEqual([{ id: 'p1', name: 'Nuevo', priceUsd: 2, stock: 7 }, { id: 'p3', name: 'Alta' }]);
    });
});

describe('F2 · dos cajas de la misma cuenta', () => {
    let db;
    let ctx;
    beforeAll(async () => {
        db = await createDb();
        ctx = await setupAccount(db);
    }, 60_000);

    it('lo que edita la caja A aparece en la caja B, sin tocar el stock de B', async () => {
        const a = await makeCaja(db, ctx, 'Caja A');
        const b = await makeCaja(db, ctx, 'Caja B');
        await a.write('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1.2, stock: 50 }, { id: 'p2', name: 'Arroz', priceUsd: 1, stock: 10 }]);
        expect(await a.sync.pendingCount()).toBe(0);

        b.local.set('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1.2, stock: 33 }]);
        expect(await b.sync.pull()).toBe(2);
        expect(b.local.get('bodega_products_v1')).toEqual([
            { id: 'p1', name: 'Harina', priceUsd: 1.2, stock: 33 },
            { id: 'p2', name: 'Arroz', priceUsd: 1 },
        ]);

        // A cambia un precio y borra un producto; B lo ve al volver a bajar.
        await a.write('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1.5, stock: 49 }]);
        expect(await b.sync.pull()).toBe(2);
        expect(b.local.get('bodega_products_v1')).toEqual([{ id: 'p1', name: 'Harina', priceUsd: 1.5, stock: 33 }]);
        // Bajar otra vez no trae nada nuevo ni vuelve a subir lo bajado.
        expect(await b.sync.pull()).toBe(0);
        expect(await b.sync.pendingCount()).toBe(0);
    });

    it('vender (solo cambia el stock) no sube nada a la nube', async () => {
        const a = await makeCaja(db, ctx, 'Caja venta');
        await a.write('bodega_products_v1', [{ id: 'v1', name: 'Café', priceUsd: 3, stock: 10 }]);
        const [{ version: before }] = await q(db, 'service', "select version from public.account_records where id = 'v1'");
        await a.write('bodega_products_v1', [{ id: 'v1', name: 'Café', priceUsd: 3, stock: 9 }]);
        const [{ version: after }] = await q(db, 'service', "select version from public.account_records where id = 'v1'");
        expect(after).toBe(before);
    });

    it('si la nube rechaza (sesión vencida), la cola queda intacta y sube al volver (G10)', async () => {
        const a = await makeCaja(db, ctx, 'Caja sin red');
        a.setSession('00000000-0000-0000-0000-000000000000');
        await a.write('bodega_customers_v1', [{ id: 'c9', name: 'Pedro', deuda: 4 }]);
        expect(await a.sync.pendingCount()).toBe(1);
        expect(a.sync.getLastError()).toMatch(/sesión venció/);

        const [s] = await q(db, a.client.user, 'select * from public.member_login_pin($1,$2)', [ctx.adminId, '246801']);
        a.setSession(s.session_token);
        await a.sync.flush();
        expect(await a.sync.pendingCount()).toBe(0);
        const [row] = await q(db, 'service', "select data from public.account_records where id = 'c9'");
        expect(row.data).toEqual({ id: 'c9', name: 'Pedro' });
    });

    it('las categorías (un valor entero) viajan como un ajuste', async () => {
        const a = await makeCaja(db, ctx, 'Caja cat');
        const b = await makeCaja(db, ctx, 'Caja cat B');
        await a.write('my_categories_v1', ['Víveres', 'Bebidas']);
        await b.sync.pull(['settings']);
        expect(b.local.get('my_categories_v1')).toEqual(['Víveres', 'Bebidas']);
    });
});

describe('F5 · registros de caja (solo se suben)', () => {
    it('id con el equipo, sin lo muy viejo y sin el detalle pesado', () => {
        const now = Date.parse('2026-11-16T12:00:00Z');
        const recs = toRecords('bodega_sales_v1', [
            { id: 'v1', tipo: 'VENTA', totalUsd: 3, timestamp: '2026-11-16T10:00:00Z', stockEffects: [{ a: 1 }], items: [{ id: 'p', name: 'X', qty: 1, priceUsd: 3, image: 'data:...' }] },
            { id: 'viejo', tipo: 'VENTA', totalUsd: 1, timestamp: '2025-01-01T00:00:00Z' },
        ], { cashIdSuffix: 'PDN-A', now });
        expect(recs).toEqual([{ id: 'v1@PDN-A', data: { id: 'v1', tipo: 'VENTA', totalUsd: 3, timestamp: '2026-11-16T10:00:00Z', items: [{ id: 'p', name: 'X', qty: 1, priceUsd: 3 }] } }]);
    });

    it('un id de caja que no cabe en 120 se acorta igual siempre y conserva el @equipo', () => {
        const largo = 'supervisor-4d2a6cfb-f938-48e4-bddf-8190c285f912-line-6f05d2e1-4d15-4d2d-a2ea-efea978d181f';
        const otro = 'supervisor-4d2a6cfb-f938-48e4-bddf-8190c285f912-line-6f05d2e1-4d15-4d2d-a2ea-efea978d1820';
        const dev = 'PDN-F9FBE7B6439910076438416CF0668A26';
        const id = cashRecordId(largo, dev);
        expect(id.length).toBeLessThanOrEqual(MAX_RECORD_ID);
        expect(id.endsWith(`@${dev}`)).toBe(true);
        expect(cashRecordId(largo, dev)).toBe(id);
        expect(cashRecordId(otro, dev)).not.toBe(id);
        expect(cashRecordId('v1', dev)).toBe(`v1@${dev}`);
    });

    it('un registro con id largo (respaldo con ajustes del Supervisor) ya no atasca la cola', async () => {
        const db = await createDb();
        const ctx = await setupAccount(db);
        const a = await makeCaja(db, ctx, 'Caja larga');
        const [{ id: devA }] = await q(db, 'service', "select id from public.account_devices where label = 'Caja larga'");
        const store = memoryStore();
        const largo = 'supervisor-4d2a6cfb-f938-48e4-bddf-8190c285f912-line-6f05d2e1-4d15-4d2d-a2ea-efea978d181f';
        const ts = new Date().toISOString();
        const turno = [
            { id: 'v1', tipo: 'VENTA', totalUsd: 2, timestamp: ts },
            { id: largo, tipo: 'AJUSTE_ENTRADA', timestamp: ts },
            { id: 'v2', tipo: 'VENTA', totalUsd: 4, timestamp: ts },
        ];
        // Lo que dejó la versión anterior: la cola con el id de 126 caracteres que el
        // servidor rechaza (23514) y que tumbaba el lote completo en cada intento.
        await store.setItem('pdn_sync_cash_v1', {
            versions: {}, lastPulled: null,
            queue: turno.map((s) => ({ id: `${s.id}@${devA}`, data: s, h: hashOf(s) })),
        });
        const sync = createRecordSync({
            client: a.client, getSession: () => a.sessionToken, store, cashIdSuffix: devA,
            readLocal: async () => null, writeLocal: async () => {},
        });
        await sync.onLocalWrite('bodega_sales_v1', turno);
        await sync.flush();
        expect(sync.getLastError()).toBeNull();
        expect(await sync.pendingCount()).toBe(0);
        const rows = await q(db, 'service', "select id from public.account_records where collection = 'cash' order by id");
        expect(rows.map((r) => r.id).sort()).toEqual([cashRecordId(largo, devA), `v1@${devA}`, `v2@${devA}`].sort());
    }, 60_000);

    it('la caja A sube su turno y la caja B no lo baja', async () => {
        const db = await createDb();
        const ctx = await setupAccount(db);
        const a = await makeCaja(db, ctx, 'Caja A');
        const b = await makeCaja(db, ctx, 'Caja B');
        // makeCaja no pasa id de equipo: sin él no se suben registros de caja.
        await a.write('bodega_sales_v1', [{ id: 'v1', tipo: 'VENTA', totalUsd: 2, timestamp: new Date().toISOString() }]);
        const [{ n: none }] = await q(db, 'service', "select count(*)::int n from public.account_records where collection = 'cash'");
        expect(none).toBe(0);

        const [{ id: devA }] = await q(db, 'service', "select id from public.account_devices where label = 'Caja A'");
        const syncA = createRecordSync({
            client: a.client, getSession: () => a.sessionToken, store: memoryStore(), cashIdSuffix: devA,
            readLocal: async () => null, writeLocal: async () => {},
        });
        a.local.set('bodega_sales_v1', [{ id: 'v2', tipo: 'VENTA', totalUsd: 5, timestamp: new Date().toISOString() }]);
        await syncA.onLocalWrite('bodega_sales_v1', a.local.get('bodega_sales_v1'));
        await syncA.flush();
        const rows = await q(db, 'service', "select id from public.account_records where collection = 'cash'");
        expect(rows.map((r) => r.id)).toEqual([`v2@${devA}`]);

        b.local.set('bodega_sales_v1', [{ id: 'propia' }]);
        await b.sync.pull();
        expect(b.local.get('bodega_sales_v1')).toEqual([{ id: 'propia' }]);
    }, 60_000);
});

describe('S2 · nube sin la migración 016', () => {
    it('si push_records_v2 no existe, sube con push_records y no lo vuelve a intentar', async () => {
        const calls = [];
        const client = {
            rpc: async (fn, args) => {
                calls.push(fn);
                if (fn === 'push_records_v2') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
                return { data: args.p_records.map((r) => ({ id: r.id, version: 1, updated_at: new Date().toISOString() })), error: null };
            },
        };
        const mem = new Map();
        const sync = createRecordSync({
            client,
            getSession: () => 'sesion',
            store: { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => { mem.set(k, structuredClone(v)); } },
            readLocal: async () => null,
            writeLocal: async () => {},
        });
        await sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'Uno' }]);
        await sync.flush();
        await sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'Dos' }]);
        await sync.flush();
        expect(await sync.pendingCount()).toBe(0);
        expect(sync.getLastError()).toBeNull();
        expect(calls).toEqual(['push_records_v2', 'push_records', 'push_records']);
    });
});
