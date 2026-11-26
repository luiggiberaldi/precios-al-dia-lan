/**
 * A2/A4 · F4 — Libro de clientes en el servidor: E5 (fía en A y abona en B), reintentos,
 * anulación, libro de solo agregar y saldo = suma del libro (A7).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Fiados', 'Sede A', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5, max_sedes = 2 where account_id = $1', [accountId]);
    const [{ create_sede: sedeB }] = await q(db, owner, 'select public.create_sede($1)', ['Sede B']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const cajas = [];
    for (const [label, sede] of [['A', null], ['B', sedeB]]) {
        const user = await createUser(db, { anonymous: true });
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2, $3, $4)', [user.id, `Caja ${label}`, 'caja', sede]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
        cajas.push({ user, row, session: s.session_token });
    }
    return { owner, accountId, cajas };
}

const push = (db, caja, movements) =>
    q(db, caja.user, 'select * from public.push_customer_movements($1, $2::jsonb)', [caja.session, JSON.stringify(movements)]);

const balance = async (db, who, customer) => {
    const rows = await q(db, who, 'select balance_usd from public.customer_balances where customer_id = $1', [customer]);
    return rows.length ? Number(rows[0].balance_usd) : 0;
};

describe('F4 · libro de clientes', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('E5: fía en la caja A y abona en la caja B → saldo correcto y cada línea con su sede', async () => {
        const { cajas: [a, b] } = await setup(db);
        await push(db, a, [{ id: randomUUID(), customer_id: 'maria', type: 'VENTA_FIADA', amount_usd: 20 }]);
        await push(db, b, [{ id: randomUUID(), customer_id: 'maria', type: 'ABONO_DEUDA', amount_usd: 15 }]);
        expect(await balance(db, a.user, 'maria')).toBe(-5);
        const lines = await q(db, a.user, "select type, sede_id, device_id, balance_after from public.customer_movements where customer_id = 'maria' order by seq");
        expect(lines.map((l) => [l.type, Number(l.balance_after)])).toEqual([['VENTA_FIADA', -20], ['ABONO_DEUDA', -5]]);
        expect(lines[0].device_id).toBe(a.row.id);
        expect(lines[1].device_id).toBe(b.row.id);
        expect(lines[0].sede_id).not.toBe(lines[1].sede_id);
    });

    it('vuelto a la billetera y uso del saldo a favor', async () => {
        const { cajas: [a] } = await setup(db);
        await push(db, a, [
            { id: randomUUID(), customer_id: 'pedro', type: 'VUELTO_ACREDITADO', amount_usd: 3.5 },
            { id: randomUUID(), customer_id: 'pedro', type: 'SALDO_FAVOR_USADO', amount_usd: 1.25 },
        ]);
        expect(await balance(db, a.user, 'pedro')).toBe(2.25);
    });

    it('reenviar el mismo movimiento no lo cuenta dos veces (G7)', async () => {
        const { cajas: [a] } = await setup(db);
        const m = { id: `ledger_${randomUUID()}`, customer_id: 'ana', type: 'VENTA_FIADA', amount_usd: 10 };
        await push(db, a, [m]);
        const [again] = await push(db, a, [m]);
        expect(again.already_registered).toBe(true);
        expect(await balance(db, a.user, 'ana')).toBe(-10);
    });

    it('anular = línea inversa con su dirección; el libro no se edita (G6)', async () => {
        const { cajas: [a] } = await setup(db);
        const fiado = randomUUID();
        await push(db, a, [{ id: fiado, customer_id: 'luis', type: 'VENTA_FIADA', amount_usd: 8 }]);
        expect(await expectError(push(db, a, [{ id: randomUUID(), customer_id: 'luis', type: 'ANULACION', amount_usd: 8 }]))).toMatch(/dirección/);
        await push(db, a, [{ id: randomUUID(), customer_id: 'luis', type: 'ANULACION', direction: 'CREDIT', amount_usd: 8, reversal_of: fiado }]);
        expect(await balance(db, a.user, 'luis')).toBe(0);
        expect(await expectError(q(db, 'service', 'update public.customer_movements set amount_usd = 1 where id = $1', [fiado]))).toMatch(/no se edita/);
        expect(await expectError(q(db, a.user, "insert into public.customer_balances (account_id, customer_id) values (gen_random_uuid(), 'x')"))).toMatch(/permission denied/);
    });

    it('100 operaciones mezcladas entre dos cajas: el saldo cuadra con el libro (A7)', async () => {
        const { cajas: [a, b] } = await setup(db);
        let expected = 0;
        for (let i = 0; i < 100; i += 1) {
            const caja = i % 2 ? a : b;
            const fia = i % 3 !== 0;
            const amount = (i % 7) + 1;
            expected += fia ? -amount : amount;
            await push(db, caja, [{ id: randomUUID(), customer_id: 'mix', type: fia ? 'VENTA_FIADA' : 'ABONO_DEUDA', amount_usd: amount }]);
        }
        expect(await balance(db, a.user, 'mix')).toBe(expected);
        const bad = await q(db, 'service', `
            select b.customer_id from public.customer_balances b
            join lateral (select coalesce(sum(case when direction = 'CREDIT' then amount_usd else -amount_usd end), 0) s
                          from public.customer_movements m where m.account_id = b.account_id and m.customer_id = b.customer_id) l on true
            where b.balance_usd <> l.s`);
        expect(bad).toEqual([]);
        const [last] = await q(db, a.user, "select balance_after from public.customer_movements where customer_id = 'mix' order by seq desc limit 1");
        expect(Number(last.balance_after)).toBe(expected);
    });

    it('una cuenta no ve los clientes de otra; sin sesión no se escribe', async () => {
        const one = await setup(db);
        const two = await setup(db);
        await push(db, two.cajas[0], [{ id: randomUUID(), customer_id: 'ajeno', type: 'VENTA_FIADA', amount_usd: 1 }]);
        expect(await balance(db, one.cajas[0].user, 'ajeno')).toBe(0);
        const stranger = await createUser(db, { anonymous: true });
        expect(await expectError(q(db, stranger, 'select * from public.push_customer_movements($1, $2::jsonb)', [one.cajas[0].session, '[]']))).toMatch(/sesión venció/);
    });
});
