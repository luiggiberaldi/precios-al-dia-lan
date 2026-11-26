/**
 * Auditoría de sincronización entre cajas de la MISMA cuenta (noviembre 2026).
 * Contra el SQL real (PGlite). Ver el informe sync-audit.md en las notas de la sesión.
 *
 * Las pruebas `it(...)` reproducen fallos que ya se arreglaron (antes del arreglo fallaban).
 * Las `it.fails(...)` documentan fallos que siguen abiertos (propuestas grandes): pasan
 * mientras el fallo exista y se pondrán en rojo cuando alguien lo arregle — entonces hay
 * que pasarlas a `it(...)`.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync } from '../../src/nube/recordSync.js';
import { createCustomerLedgerSync } from '../../src/nube/customerLedgerSync.js';
import { mergeScreenList } from '../../src/nube/staleListGuard.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

let n = 0;
async function setupAccount(db) {
    n += 1;
    const owner = await createUser(db, { email: `audit${n}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', [`Audit ${n}`, 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 10 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', [`Admin ${n}`, 'administrador', '246801']);
    return { owner, accountId, adminId };
}

async function makeCaja(db, acc, label, { cashIdSuffix = null, canPush, member = { id: acc.adminId, pin: '246801' } } = {}) {
    const user = await createUser(db, { anonymous: true });
    await q(db, acc.owner, 'select * from public.register_device($1, $2)', [user.id, label]);
    const client = new FakeSupabase(db);
    client.user = user;
    const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [member.id, member.pin]);
    const local = new Map();
    let session = s.session_token;
    const store = memoryStore();
    const sync = createRecordSync({
        client,
        getSession: () => session,
        store,
        cashIdSuffix,
        ...(canPush ? { canPush } : {}),
        readLocal: async (k) => structuredClone(local.get(k) ?? null),
        writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
    });
    const write = async (k, v) => { local.set(k, structuredClone(v)); await sync.onLocalWrite(k, v); await sync.flush(); };
    return { sync, local, write, client, user, store, setSession: (v) => { session = v; }, get session() { return session; } };
}

const pushAs = (db, caja, collection, records) =>
    q(db, caja.user, 'select * from public.push_records($1, $2, $3::jsonb)', [caja.session, collection, JSON.stringify(records)]);

afterEach(() => { vi.useRealTimers(); });

describe('Auditoría sync · registros (account_records)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('una caja nueva baja TODO el catálogo aunque un lote entero comparta la misma hora (paginación)', async () => {
        // Importar el respaldo sube lotes de 400 con la MISMA updated_at (now() de la transacción).
        // Antes: la página de 500 cortaba un lote a la mitad y `gt(updated_at)` saltaba el resto
        // (con 800 productos, la caja nueva veía 500).
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const mk = (from, to) => Array.from({ length: to - from }, (_, i) => {
            const id = `p${String(from + i).padStart(4, '0')}`;
            return { id, data: { id, name: `Producto ${from + i}` } };
        });
        await pushAs(db, a, 'products', mk(0, 400));
        await pushAs(db, a, 'products', mk(400, 800));

        const b = await makeCaja(db, acc, 'Caja B');
        await b.sync.pull(['products']);
        expect(b.local.get('bodega_products_v1')).toHaveLength(800);
    }, 60_000);

    it('avisos de Realtime en ráfaga (uno por registro) no abren una descarga por aviso', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        await a.write('bodega_products_v1', [{ id: 'x1', name: 'Uno' }]);
        const b = await makeCaja(db, acc, 'Caja B');
        let queries = 0;
        const from = b.client.from.bind(b.client);
        b.client.from = (t) => { if (t === 'account_records') queries += 1; return from(t); };
        // El disparador de account_sync_state es por FILA: un lote de 200 = 200 avisos.
        await Promise.all(Array.from({ length: 20 }, () => b.sync.pull(['products'])));
        expect(queries).toBeLessThanOrEqual(2); // una descarga + una vuelta extra
        expect(b.local.get('bodega_products_v1').map((p) => p.name)).toEqual(['Uno']);
    }, 60_000);

    it('un cambio local hecho MIENTRAS se baja no se pierde de la cola', async () => {
        const acc = await setupAccount(db);
        const b = await makeCaja(db, acc, 'Caja B');
        b.setSession(null); // sin sesión: la cola no se vacía, así se ve si sobrevive
        let open;
        const gate = new Promise((r) => { open = r; });
        const from = b.client.from.bind(b.client);
        b.client.from = (t) => {
            const query = from(t);
            const run = query.run.bind(query);
            query.run = async () => { await gate; return run(); };
            return query;
        };
        const pulling = b.sync.pull(['products']);
        await new Promise((r) => setTimeout(r, 20)); // el pull ya leyó su estado y espera a la red
        await b.sync.onLocalWrite('bodega_products_v1', [{ id: 'nuevo', name: 'Recién creado' }]);
        open();
        await pulling;
        expect(await b.sync.pendingCount()).toBe(1); // antes: 0 (el pull guardaba su estado viejo encima)
    }, 60_000);

    it('un registro de caja que cumple 120 días NO se borra de la nube', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A', { cashIdSuffix: 'dev-a' });
        const day = 86_400_000;
        const start = Date.parse('2026-06-01T12:00:00Z');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(start);
        const vieja = { id: 'v1', tipo: 'VENTA', totalUsd: 5, timestamp: new Date(start - 119 * day).toISOString() };
        await a.write('bodega_sales_v1', [vieja]);
        vi.setSystemTime(start + 2 * day); // la venta ya tiene 121 días
        await a.write('bodega_sales_v1', [vieja, { id: 'v2', tipo: 'VENTA', totalUsd: 3, timestamp: new Date(start + 2 * day).toISOString() }]);
        vi.useRealTimers();
        const rows = await q(db, a.user, "select id, deleted_at from public.account_records where collection = 'cash' order by id");
        expect(rows.map((r) => [r.id, r.deleted_at])).toEqual([['v1@dev-a', null], ['v2@dev-a', null]]);
    }, 60_000);

    it('pantalla con la lista vieja de clientes: guardar no borra el cliente que creó otra caja', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        await b.write('bodega_customers_v1', [{ id: 'c1', name: 'María', phone: '' }]);
        await a.sync.pull(['customers']);
        const pantallaB = structuredClone(b.local.get('bodega_customers_v1')); // B abre «Clientes»
        await a.write('bodega_customers_v1', [...a.local.get('bodega_customers_v1'), { id: 'c2', name: 'Pedro' }]);
        await b.sync.pull(['customers']); // la copia local de B ya tiene a Pedro; la pantalla no

        // B edita el teléfono de María desde su lista vieja, con el guardado seguro (CustomersView).
        const next = pantallaB.map((c) => (c.id === 'c1' ? { ...c, phone: '0414' } : c));
        await b.write('bodega_customers_v1', mergeScreenList({ base: pantallaB, next, fresh: b.local.get('bodega_customers_v1') }));

        const rows = await q(db, b.user, "select id, deleted_at, data from public.account_records where collection = 'customers' order by id");
        expect(rows.map((r) => [r.id, r.deleted_at, r.data.phone ?? null])).toEqual([['c1', null, '0414'], ['c2', null, null]]);
    }, 60_000);

    it('sin el guardado seguro, la misma lista vieja SÍ borra al cliente de otra caja (por qué hace falta)', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        await b.write('bodega_customers_v1', [{ id: 'c1', name: 'María' }]);
        await a.sync.pull(['customers']);
        const pantallaB = structuredClone(b.local.get('bodega_customers_v1'));
        await a.write('bodega_customers_v1', [...a.local.get('bodega_customers_v1'), { id: 'c2', name: 'Pedro' }]);
        await b.sync.pull(['customers']);
        await b.write('bodega_customers_v1', pantallaB.map((c) => ({ ...c, phone: '0414' })));
        const [pedro] = await q(db, b.user, "select deleted_at from public.account_records where collection = 'customers' and id = 'c2'");
        expect(pedro.deleted_at).not.toBeNull(); // métodos de pago y categorías siguen así
    }, 60_000);

    it('dos cajas editan el MISMO producto casi a la vez: no se pierde ningún cambio (S2: fusión por campo)', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        await a.write('bodega_products_v1', [{ id: 'h', name: 'Harina', priceUsd: 1 }]);
        await b.sync.pull(['products']);
        // A sube el precio; B (que aún no bajó) corrige el nombre.
        await a.write('bodega_products_v1', [{ id: 'h', name: 'Harina', priceUsd: 1.5 }]);
        await b.write('bodega_products_v1', [{ id: 'h', name: 'Harina PAN', priceUsd: 1 }]);
        const [row] = await q(db, a.user, "select data from public.account_records where collection = 'products' and id = 'h'");
        expect(row.data).toEqual({ id: 'h', name: 'Harina PAN', priceUsd: 1.5 });
        // B ya muestra lo fundido sin esperar a bajar; A lo recibe al bajar.
        expect(b.local.get('bodega_products_v1')).toEqual([{ id: 'h', name: 'Harina PAN', priceUsd: 1.5 }]);
        await a.sync.pull(['products']);
        expect(a.local.get('bodega_products_v1')).toEqual([{ id: 'h', name: 'Harina PAN', priceUsd: 1.5 }]);
    }, 60_000);
});

describe('Auditoría sync · libro de clientes', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it.fails('un movimiento que confirma con un seq MENOR que el cursor también baja (hoy: se salta para siempre)', async () => {
        // bigserial asigna el seq al insertar, no al confirmar: dos cajas abonando a clientes
        // distintos a la vez pueden confirmar 11 antes que 10. Si una tercera caja lee entre
        // medio, su cursor queda en 11 y el 10 nunca baja (el saldo sí, el historial no).
        const acc = await setupAccount(db);
        const c = await makeCaja(db, acc, 'Caja C');
        const ledgerLocal = new Map();
        const ledger = createCustomerLedgerSync({
            client: c.client,
            getSession: () => c.session,
            store: memoryStore(),
            readLocal: async (k) => structuredClone(ledgerLocal.get(k) ?? null),
            writeLocal: async (k, v) => { ledgerLocal.set(k, structuredClone(v)); },
        });
        const push = (id) => q(db, c.user, 'select * from public.push_customer_movements($1, $2::jsonb)',
            [c.session, JSON.stringify([{ id, customer_id: 'cli', type: 'VENTA_FIADA', amount_usd: 1 }])]);
        await push('m1');
        await push('m3');
        await ledger.pull(); // cursor = seq de m3
        // Simula el que confirmó tarde: mismo cliente, seq anterior al cursor.
        await push('m2');
        await db.exec(`
            alter table public.customer_movements disable trigger customer_movements_no_change;
            update public.customer_movements set seq = (select seq from public.customer_movements where id = 'm1') where id = 'm2';
            alter table public.customer_movements enable trigger customer_movements_no_change;`);
        await ledger.pull();
        expect(ledgerLocal.get('bodega_customer_ledger_v1').map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3']);
    }, 60_000);
});


// ─── Sin internet: la caja vuelve a quedar igual que la nube (S1, 2026-11-19) ───

/** Corta y devuelve el internet de una caja (las subidas fallan como sin red). */
function withNetworkSwitch(caja) {
    const rpc = caja.client.rpc.bind(caja.client);
    const net = { offline: false };
    caja.client.rpc = async (...a) => (net.offline ? { data: null, error: { message: 'TypeError: Failed to fetch', status: 0 } } : rpc(...a));
    return net;
}

const PRODUCTS = 'bodega_products_v1';
const view = (list) => (list || []).map(({ id, name, priceUsd }) => ({ id, name, priceUsd })).sort((x, y) => x.id.localeCompare(y.id));
async function cloudProducts(db, accountId) {
    const rows = await q(db, 'service', "select data from public.account_records where account_id = $1 and collection = 'products' and deleted_at is null", [accountId]);
    return view(rows.map((r) => r.data));
}
async function setLocal(caja, list) {
    caja.local.set(PRODUCTS, list);
    await caja.sync.onLocalWrite(PRODUCTS, list);
    await caja.sync.flush();
}
async function settle(...cajas) {
    for (let i = 0; i < 2; i += 1) {
        for (const c of cajas) { await c.sync.flush(); await c.sync.pull(['products']); }
    }
}

describe('Sin internet · cada caja termina igual que la nube (S1)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('cambio sin subir + cambio de otra caja: al reconectar, las dos cajas muestran lo mismo que la nube', async () => {
        // Antes: la nube y A quedaban en «Harina, $2» y B se quedaba en «Harina PAN, $1» para siempre.
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        const net = withNetworkSwitch(b);
        await setLocal(a, [{ id: 'p1', name: 'Harina', priceUsd: 1 }]);
        await b.sync.pull(['products']);

        net.offline = true;
        await setLocal(b, [{ id: 'p1', name: 'Harina', priceUsd: 2 }]);            // B sin internet
        expect(await b.sync.pendingCount()).toBe(1);
        await setLocal(a, [{ id: 'p1', name: 'Harina PAN', priceUsd: 1 }]);        // A sí sube
        await b.sync.pull(['products']);                                            // B solo puede bajar
        // El cambio local sin subir NO se pisa en pantalla.
        expect(view(b.local.get(PRODUCTS))).toEqual([{ id: 'p1', name: 'Harina', priceUsd: 2 }]);

        net.offline = false;
        await settle(a, b);
        const cloud = await cloudProducts(db, acc.accountId);
        // S2: tampoco se pierde el cambio de A (nombre) ni el de B (precio).
        expect(cloud).toEqual([{ id: 'p1', name: 'Harina PAN', priceUsd: 2 }]);
        expect(view(b.local.get(PRODUCTS))).toEqual(cloud);
        expect(view(a.local.get(PRODUCTS))).toEqual(cloud);
        expect(await b.sync.pendingCount()).toBe(0);
    }, 60_000);

    it('sin internet una caja crea un producto mientras otra edita otro: al volver, nadie pierde nada', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        const net = withNetworkSwitch(b);
        await setLocal(a, [{ id: 'p1', name: 'Arroz', priceUsd: 1 }]);
        await b.sync.pull(['products']);

        net.offline = true;
        await setLocal(b, [...b.local.get(PRODUCTS), { id: 'p2', name: 'Café', priceUsd: 5 }]);
        await setLocal(a, [{ id: 'p1', name: 'Arroz', priceUsd: 1.5 }]);
        await b.sync.pull(['products']);
        net.offline = false;
        await settle(a, b);

        const expected = [{ id: 'p1', name: 'Arroz', priceUsd: 1.5 }, { id: 'p2', name: 'Café', priceUsd: 5 }];
        expect(await cloudProducts(db, acc.accountId)).toEqual(expected);
        expect(view(a.local.get(PRODUCTS))).toEqual(expected);
        expect(view(b.local.get(PRODUCTS))).toEqual(expected);
    }, 60_000);

    it('sin internet una caja borra un producto que otra editó: al volver, las cajas coinciden con la nube', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        const net = withNetworkSwitch(b);
        await setLocal(a, [{ id: 'p1', name: 'Leche', priceUsd: 2 }, { id: 'p2', name: 'Pan', priceUsd: 1 }]);
        await b.sync.pull(['products']);

        net.offline = true;
        await setLocal(b, b.local.get(PRODUCTS).filter((p) => p.id !== 'p2'));
        await setLocal(a, [{ id: 'p1', name: 'Leche', priceUsd: 2 }, { id: 'p2', name: 'Pan', priceUsd: 1.2 }]);
        await b.sync.pull(['products']);
        expect(view(b.local.get(PRODUCTS)).map((p) => p.id)).toEqual(['p1']); // su borrado sigue en pantalla
        net.offline = false;
        await settle(a, b);

        const cloud = await cloudProducts(db, acc.accountId);
        expect(view(a.local.get(PRODUCTS))).toEqual(cloud);
        expect(view(b.local.get(PRODUCTS))).toEqual(cloud);
    }, 60_000);

    it('un cambio que la caja no puede subir (sin permiso) sí lo corrige lo que manda la nube', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const cajero = await makeCaja(db, acc, 'Caja C', { canPush: (c) => c === 'customers' || c === 'cash' });
        const net = withNetworkSwitch(cajero);
        await setLocal(a, [{ id: 'p1', name: 'Azúcar', priceUsd: 1 }]);
        await cajero.sync.pull(['products']);

        net.offline = true;
        await setLocal(cajero, [{ id: 'p1', name: 'Azúcar', priceUsd: 9 }]);
        await setLocal(a, [{ id: 'p1', name: 'Azúcar', priceUsd: 1.1 }]);
        await cajero.sync.pull(['products']);
        expect(view(cajero.local.get(PRODUCTS))).toEqual(await cloudProducts(db, acc.accountId));
    }, 60_000);
});

const full = (list) => [...(list || [])].sort((x, y) => x.id.localeCompare(y.id));
async function cloudFull(db, accountId) {
    const rows = await q(db, 'service', "select data from public.account_records where account_id = $1 and collection = 'products' and deleted_at is null", [accountId]);
    return full(rows.map((r) => r.data));
}

describe('Ediciones simultáneas (S2) y clientes que borra un cajero (S4)', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('las dos cajas cambian el MISMO campo: gana la última, sin mezclar campos', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        await setLocal(a, [{ id: 'p1', name: 'Queso', priceUsd: 4, unit: 'kg' }]);
        await b.sync.pull(['products']);
        await setLocal(a, [{ id: 'p1', name: 'Queso', priceUsd: 4.5, unit: 'kg' }]);
        await setLocal(b, [{ id: 'p1', name: 'Queso', priceUsd: 5, unit: 'g' }]);
        await settle(a, b);
        const cloud = await cloudFull(db, acc.accountId);
        expect(cloud).toEqual([{ id: 'p1', name: 'Queso', priceUsd: 5, unit: 'g' }]);
        expect(full(a.local.get(PRODUCTS))).toEqual(cloud);
        expect(full(b.local.get(PRODUCTS))).toEqual(cloud);
    }, 60_000);

    it('un campo que una caja quitó y otro que la otra agregó: se respetan los dos', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        await setLocal(a, [{ id: 'p1', name: 'Jabón', priceUsd: 1, barcode: '123' }]);
        await b.sync.pull(['products']);
        await setLocal(a, [{ id: 'p1', name: 'Jabón', priceUsd: 1, barcode: '123', category: 'Limpieza' }]);
        await setLocal(b, [{ id: 'p1', name: 'Jabón', priceUsd: 1 }]); // B quita el código
        await settle(a, b);
        const cloud = await cloudFull(db, acc.accountId);
        expect(cloud).toEqual([{ id: 'p1', name: 'Jabón', priceUsd: 1, category: 'Limpieza' }]);
        expect(full(a.local.get(PRODUCTS))).toEqual(cloud);
        expect(full(b.local.get(PRODUCTS))).toEqual(cloud);
    }, 60_000);

    it('dos cambios seguidos sin internet sobre la misma base se funden bien', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        const b = await makeCaja(db, acc, 'Caja B');
        const net = withNetworkSwitch(b);
        await setLocal(a, [{ id: 'p1', name: 'Aceite', priceUsd: 3, brand: 'X' }]);
        await b.sync.pull(['products']);
        net.offline = true;
        await setLocal(b, [{ id: 'p1', name: 'Aceite', priceUsd: 3.2, brand: 'X' }]);
        await setLocal(a, [{ id: 'p1', name: 'Aceite 1L', priceUsd: 3, brand: 'X' }]);
        await b.sync.pull(['products']);
        await setLocal(b, [{ id: 'p1', name: 'Aceite', priceUsd: 3.2, brand: 'Y' }]); // segundo cambio de B
        net.offline = false;
        await settle(a, b);
        const cloud = await cloudFull(db, acc.accountId);
        expect(cloud).toEqual([{ id: 'p1', name: 'Aceite 1L', priceUsd: 3.2, brand: 'Y' }]);
        expect(full(a.local.get(PRODUCTS))).toEqual(cloud);
        expect(full(b.local.get(PRODUCTS))).toEqual(cloud);
    }, 60_000);

    it('una caja vieja (sin versión base) sigue ganando entera, como antes', async () => {
        const acc = await setupAccount(db);
        const a = await makeCaja(db, acc, 'Caja A');
        await setLocal(a, [{ id: 'p1', name: 'Sal', priceUsd: 1 }]);
        await setLocal(a, [{ id: 'p1', name: 'Sal', priceUsd: 1.5 }]);
        const [r] = await q(db, a.user, 'select * from public.push_records_v2($1, $2, $3::jsonb)',
            [a.session, 'products', JSON.stringify([{ id: 'p1', data: { id: 'p1', name: 'Sal fina', priceUsd: 1 } }])]);
        expect(r.merged).toBe(false);
        expect(await cloudFull(db, acc.accountId)).toEqual([{ id: 'p1', name: 'Sal fina', priceUsd: 1 }]);
    }, 60_000);

    it('S4: un cajero que borra un cliente no lo borra de la nube y lo recupera en su caja', async () => {
        const acc = await setupAccount(db);
        const [{ upsert_member: cajeroId }] = await q(db, acc.owner, 'select public.upsert_member(null,$1,$2,$3)', ['Luis', 'cajero', '1357']);
        const admin = await makeCaja(db, acc, 'Caja A');
        const cajero = await makeCaja(db, acc, 'Caja C', {
            member: { id: cajeroId, pin: '1357' },
            canPush: (c) => c === 'customers' || c === 'cash',
        });
        const CUSTOMERS = 'bodega_customers_v1';
        await admin.write(CUSTOMERS, [{ id: 'c1', name: 'María' }, { id: 'c2', name: 'Pedro' }]);
        await cajero.sync.pull(['customers']);

        await cajero.write(CUSTOMERS, [{ id: 'c1', name: 'María' }]); // p. ej. una lista vieja
        const rows = await q(db, 'service', "select id, deleted_at from public.account_records where account_id = $1 and collection = 'customers' order by id", [acc.accountId]);
        expect(rows.map((r) => [r.id, r.deleted_at])).toEqual([['c1', null], ['c2', null]]);
        expect(cajero.local.get(CUSTOMERS).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
        expect(cajero.sync.getLastError()).toMatch(/borrar clientes/);
        expect(await cajero.sync.pendingCount()).toBe(0);

        // Editar sí puede, y el administrador sí puede borrar.
        await cajero.write(CUSTOMERS, cajero.local.get(CUSTOMERS).map((c) => (c.id === 'c2' ? { ...c, phone: '0414' } : c)));
        await admin.sync.pull(['customers']);
        expect(admin.local.get(CUSTOMERS).find((c) => c.id === 'c2').phone).toBe('0414');
        await admin.write(CUSTOMERS, admin.local.get(CUSTOMERS).filter((c) => c.id !== 'c2'));
        const [pedro] = await q(db, 'service', "select deleted_at from public.account_records where account_id = $1 and collection = 'customers' and id = 'c2'", [acc.accountId]);
        expect(pedro.deleted_at).not.toBeNull();
    }, 60_000);
});
