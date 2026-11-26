/**
 * F4 · historial de todas las cajas: lo que cada caja sube a `cash` se lee junto, con la
 * letra de la caja, sin duplicar y más reciente primero. Contra el SQL real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { loadAllCajasSales, mergeCajasSales, splitCashId, onlySalesHistory } from '../../src/nube/allCajasSales.js';

async function caja(db, owner, label, memberId, pin) {
    const user = await createUser(db, { anonymous: true });
    const [device] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, label]);
    const [login] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [memberId, pin]);
    const client = new FakeSupabase(db);
    client.user = user;
    return { user, client, device, session: login.session_token };
}

async function pushCash(c, records) {
    const { error } = await c.client.rpc('push_records', { p_session: c.session, p_collection: 'cash', p_records: records });
    if (error) throw new Error(error.message);
}

describe('F4 · ventas de todas las cajas', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('junta las cajas con su letra, sin duplicar, más reciente primero', async () => {
        const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
        const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Cajas', 'Centro', 'Dueño', '482913']);
        await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
        const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
        const a = await caja(db, owner, 'Caja A', cajeroId, '1357');
        const b = await caja(db, owner, 'Caja B', cajeroId, '1357');

        await pushCash(a, [
            { id: `v1@${a.device.id}`, data: { id: 'v1', tipo: 'VENTA', totalUsd: 5, timestamp: '2026-11-17T10:00:00Z', items: [{ id: 'p1', name: 'Arroz', qty: 2 }] } },
            { id: `vieja@${a.device.id}`, data: { id: 'vieja', tipo: 'VENTA', totalUsd: 1, timestamp: '2026-10-01T10:00:00Z' } },
        ]);
        await pushCash(b, [
            { id: `v2@${b.device.id}`, data: { id: 'v2', tipo: 'VENTA', totalUsd: 7, timestamp: '2026-11-17T11:00:00Z' } },
            { id: `x@${b.device.id}`, data: { id: 'x', tipo: 'VENTA', timestamp: '2026-11-17T09:00:00Z' } },
        ]);
        await pushCash(b, [{ id: `x@${b.device.id}`, data: {}, deleted: true }]);

        const sales = await loadAllCajasSales(a.client);
        expect(sales.map((s) => [s.id, s._caja])).toEqual([
            ['v2', b.device.caja_letter], ['v1', a.device.caja_letter], ['vieja', a.device.caja_letter],
        ]);
        expect(sales[1].items).toEqual([{ id: 'p1', name: 'Arroz', qty: 2, priceUsd: 0 }]);
        expect(new Set([a.device.caja_letter, b.device.caja_letter]).size).toBe(2);
        // Las ventas viejas no traen vendedor dentro: se toma del miembro que las subió.
        expect(sales.map((s) => s._vendedor)).toEqual(['Caja', 'Caja', 'Caja']);
    }, 60_000);

    it('una misma venta con y sin caja queda una sola vez, la que dice su caja', () => {
        const merged = mergeCajasSales([
            { id: 's1', data: { id: 's1', timestamp: '2026-11-01T00:00:00Z' } },
            { id: 's1@D1', data: { id: 's1', timestamp: '2026-11-01T00:00:00Z' } },
        ], { D1: 'A' });
        expect(merged).toHaveLength(1);
        expect(merged[0]._caja).toBe('A');
        expect(splitCashId('a@b@DEV')).toEqual({ saleId: 'a@b', deviceId: 'DEV' });
        expect(splitCashId('solo')).toEqual({ saleId: 'solo', deviceId: null });
    });
});

describe('historial de todas las cajas: solo ventas', () => {
    it('quita ajustes de inventario y aperturas/cierres; deja ventas, anuladas, cobros y gastos', () => {
        const list = onlySalesHistory([
            { id: 'v', tipo: 'VENTA' },
            { id: 'x', tipo: 'VENTA', status: 'ANULADA' },
            { id: 'f', tipo: 'VENTA_FIADA' },
            { id: 'c', tipo: 'COBRO_DEUDA' },
            { id: 'g', tipo: 'GASTO_INTERNO' },
            { id: 'ae', tipo: 'AJUSTE_ENTRADA', totalUsd: 0 },
            { id: 'as', tipo: 'AJUSTE_SALIDA', totalUsd: 0 },
            { id: 'ap', tipo: 'APERTURA_CAJA' },
            { id: 'rc', tipo: 'REGISTRO_CIERRE' },
            null,
        ]);
        expect(list.map((s) => s.id)).toEqual(['v', 'x', 'f', 'c', 'g']);
    });
});
