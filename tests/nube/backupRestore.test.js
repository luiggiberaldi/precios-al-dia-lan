/**
 * Restaurar un respaldo desde un equipo con la nube activa: el stock y los saldos llegan
 * al servidor (si no, las otras cajas ven los productos en 0). Contra el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createBackupRestorer } from '../../src/nube/backupRestore.js';
import { createStockWatcher } from '../../src/nube/stockWatcher.js';
import { fetchStockLevels } from '../../src/nube/stockService.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Restaura', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const user = await createUser(db, { anonymous: true });
    const [device] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, 'Caja']);
    const [admin] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const [cajero] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
    const [{ sede_id: sedeId }] = await q(db, 'service', 'select sede_id from public.account_devices where account_id = $1 limit 1', [accountId]);
    const client = new FakeSupabase(db);
    client.user = user;
    return {
        db, user, client, accountId, sedeId, device,
        admin: { token: admin.session_token, role: 'administrador' },
        cajero: { token: cajero.session_token, role: 'cajero' },
    };
}

const backup = (idb, timestamp = '2026-11-17T10:00:00.000Z') => ({ version: '2.0', timestamp, data: { idb } });

describe('Restaurar respaldo con la nube activa', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('un cajero no puede: se avisa antes de borrar nada y no sube nada', async () => {
        const ctx = await setup(db);
        const r = createBackupRestorer({ client: ctx.client, accountId: ctx.accountId, sedeId: ctx.sedeId, getSession: () => ctx.cajero });
        expect(r.check()).toEqual({ ok: false, message: expect.stringMatching(/dueño o un administrador/) });
        await expect(r.upload(backup({ bodega_products_v1: [{ id: 'p', stock: 5 }] }))).rejects.toThrow(/dueño o un administrador/);
        expect(createBackupRestorer({ client: ctx.client, accountId: ctx.accountId, getSession: () => null }).check().ok).toBe(false);
        const [{ n }] = await q(db, ctx.user, 'select count(*)::int n from public.account_records');
        expect(n).toBe(0);
    }, 60_000);

    it('el administrador: productos sin stock en el registro, stock como CONTEO, caja fuera', async () => {
        const ctx = await setup(db);
        const r = createBackupRestorer({ client: ctx.client, accountId: ctx.accountId, sedeId: ctx.sedeId, getSession: () => ctx.admin });
        expect(r.check().ok).toBe(true);
        const json = backup({
            bodega_products_v1: [{ id: 'p1', name: 'Arroz', stock: 12 }, { id: 'p2', name: 'Café', stock: 0 }, { id: 'p3', name: 'Queso', stock: 0.75 }],
            bodega_customers_v1: [{ id: 'c1', name: 'Debe', deuda: 5, favor: 0 }],
            bodega_sales_v1: [{ id: 's1', timestamp: new Date().toISOString(), items: [] }],
        });
        const steps = [];
        const result = await r.upload(json, { onProgress: (m) => steps.push(m) });
        expect(result).toMatchObject({ stock: 3, saldos: 1 });
        expect(steps.length).toBeGreaterThan(0);

        expect(await fetchStockLevels(ctx.client, ctx.sedeId)).toEqual({ p1: 12, p2: 0, p3: 0.75 });
        const records = await q(db, ctx.user, 'select collection, data from public.account_records order by collection, id');
        expect(records.filter((x) => x.collection === 'cash')).toEqual([]);
        expect(records.filter((x) => x.collection === 'products').every((x) => x.data.stock === undefined)).toBe(true);
        const [bal] = await q(db, ctx.user, 'select balance_usd from public.customer_balances where customer_id = $1', ['c1']);
        expect(Number(bal.balance_usd)).toBe(-5);

        // Reintentar el mismo respaldo no duplica nada.
        await r.upload(json);
        expect(await fetchStockLevels(ctx.client, ctx.sedeId)).toEqual({ p1: 12, p2: 0, p3: 0.75 });
        const [again] = await q(db, ctx.user, 'select balance_usd from public.customer_balances where customer_id = $1', ['c1']);
        expect(Number(again.balance_usd)).toBe(-5);
    }, 60_000);

    it('si el respaldo trae el libro de clientes, los saldos no se cargan dos veces', async () => {
        const ctx = await setup(db);
        const r = createBackupRestorer({ client: ctx.client, accountId: ctx.accountId, sedeId: ctx.sedeId, getSession: () => ctx.admin });
        const result = await r.upload(backup({
            bodega_customers_v1: [{ id: 'c1', deuda: 5 }],
            bodega_customer_ledger_v1: [{ id: 'm1', customerId: 'c1', type: 'FIADO', direction: 'DEBIT', amountUsd: 5 }],
        }));
        expect(result.saldos).toBe(0);
        const rows = await q(db, ctx.user, 'select count(*)::int n from public.customer_movements');
        expect(rows[0].n).toBe(0);
    }, 60_000);
});

describe('Vigilante: el stock conocido es el del servidor', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('un stock local que el servidor no tiene se sube en la próxima escritura', async () => {
        const ctx = await setup(db);
        const w = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin.token, store: memoryStore() });
        // El servidor solo conoce p1; p2 tiene stock local (p. ej. restaurado sin subir).
        await w.setBaseline([{ id: 'p1', stock: 4 }, { id: 'p2', stock: 9 }], { only: new Set(['p1']) });
        expect(await w.onProductsWrite([{ id: 'p1', stock: 4 }, { id: 'p2', stock: 9 }])).toBe(1);
        await w.flush();
        expect(await fetchStockLevels(ctx.client, ctx.sedeId)).toEqual({ p2: 9 });
    }, 60_000);

    it('sin `only` se comporta como antes (todo lo local es conocido)', async () => {
        const ctx = await setup(db);
        const w = createStockWatcher({ client: ctx.client, getSession: () => ctx.admin.token, store: memoryStore() });
        await w.setBaseline([{ id: 'p1', stock: 4 }]);
        expect(await w.onProductsWrite([{ id: 'p1', stock: 4 }])).toBe(0);
    }, 60_000);
});
