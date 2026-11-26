/**
 * A2 · F5 — Registros de caja por equipo y consolidado del día (E6: cerrar A no cierra B).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Cierres', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const cajas = [];
    for (const label of ['A', 'B']) {
        const user = await createUser(db, { anonymous: true });
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, `Caja ${label}`]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
        cajas.push({ user, row, session: s.session_token });
    }
    return { owner, cajas };
}

const now = () => new Date().toISOString();
const push = (db, caja, records) =>
    q(db, caja.user, "select * from public.push_records($1, 'cash', $2::jsonb)", [caja.session, JSON.stringify(records)]);

describe('F5 · caja y cierres', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('E6: cada caja sube su turno; cerrar A no cierra B; el consolidado suma bien', async () => {
        const { owner, cajas: [a, b] } = await setup(db);
        await push(db, a, [
            { id: 'apA', data: { id: 'apA', tipo: 'APERTURA_CAJA', openingUsd: 20, timestamp: now(), cajaCerrada: false } },
            { id: 'v1', data: { id: 'v1', tipo: 'VENTA', totalUsd: 10, timestamp: now() } },
            { id: 'v2', data: { id: 'v2', tipo: 'VENTA_FIADA', totalUsd: 5, timestamp: now() } },
            { id: 'v3', data: { id: 'v3', tipo: 'VENTA', totalUsd: 99, status: 'ANULADA', timestamp: now() } },
            { id: 'g1', data: { id: 'g1', tipo: 'GASTO_INTERNO', totalUsd: -3, timestamp: now() } },
        ]);
        await push(db, b, [
            { id: 'apB', data: { id: 'apB', tipo: 'APERTURA_CAJA', openingUsd: 10, timestamp: now(), cajaCerrada: false } },
            { id: 'v4', data: { id: 'v4', tipo: 'VENTA', totalUsd: 7, timestamp: now() } },
            { id: 'c1', data: { id: 'c1', tipo: 'COBRO_DEUDA', totalUsd: 4, timestamp: now() } },
        ]);
        // Cierre de A: marca sus registros como cerrados (como hace Bodega).
        await push(db, a, [{ id: 'apA', data: { id: 'apA', tipo: 'APERTURA_CAJA', openingUsd: 20, timestamp: now(), cajaCerrada: true } }]);

        const rows = await q(db, owner, 'select caja_letter, ventas, ventas_usd, cobros_usd, egresos_usd, caja_abierta from public.cash_day_summary()');
        expect(rows.map((r) => ({ ...r, ventas_usd: Number(r.ventas_usd), cobros_usd: Number(r.cobros_usd), egresos_usd: Number(r.egresos_usd) })))
            .toEqual([
                { caja_letter: 'A', ventas: 2, ventas_usd: 15, cobros_usd: 0, egresos_usd: 3, caja_abierta: false },
                { caja_letter: 'B', ventas: 1, ventas_usd: 7, cobros_usd: 4, egresos_usd: 0, caja_abierta: true },
            ]);
    });

    it('una caja no puede reescribir los registros de caja de otra', async () => {
        const { cajas: [a, b] } = await setup(db);
        await push(db, a, [{ id: 'mio', data: { id: 'mio', tipo: 'VENTA', totalUsd: 1, timestamp: now() } }]);
        expect(await expectError(push(db, b, [{ id: 'mio', data: { id: 'mio', tipo: 'VENTA', totalUsd: 1000, timestamp: now() } }])))
            .toMatch(/de otra caja/);
    });

    it('el dueño sin caja no sube registros de caja; un día sin movimientos da ceros', async () => {
        const { owner } = await setup(db);
        expect(await expectError(q(db, owner, "select * from public.push_records(null, 'cash', $1::jsonb)", [JSON.stringify([{ id: 'x', data: {} }])])))
            .toMatch(/caja registrada/);
        const rows = await q(db, owner, "select ventas, caja_abierta from public.cash_day_summary('2020-01-01')");
        expect(rows.every((r) => r.ventas === 0)).toBe(true);
    });
});
