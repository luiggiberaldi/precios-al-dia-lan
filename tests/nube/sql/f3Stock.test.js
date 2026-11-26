/**
 * A2/A4 · F3 — Libro de stock y cobro en el servidor. Escenarios del banco multicaja
 * (sección 7 del plan) contra Postgres real (PGlite).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db, { cajas = 2, sedes = 1 } = {}) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Multicaja', 'Sede A', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 10, max_sedes = 3 where account_id = $1', [accountId]);
    const [{ id: sedeA }] = await q(db, owner, 'select id from public.sedes');
    let sedeB = null;
    if (sedes > 1) [{ create_sede: sedeB }] = await q(db, owner, 'select public.create_sede($1)', ['Sede B']);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const devices = [];
    for (let i = 0; i < cajas; i += 1) {
        const user = await createUser(db, { anonymous: true });
        const sede = sedes > 1 && i === cajas - 1 ? sedeB : sedeA;
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2, $3, $4)', [user.id, `Caja ${i + 1}`, 'caja', sede]);
        const [admin] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        const [cajero] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
        devices.push({ user, row, admin: admin.session_token, cajero: cajero.session_token });
    }
    return { owner, accountId, sedeA, sedeB, devices };
}

const sell = (db, dev, items, { id = randomUUID(), offline = false, allowNegative = false, session = dev.cajero } = {}) =>
    q(db, dev.user, 'select * from public.process_checkout($1, $2::jsonb, $3, $4)',
        [session, JSON.stringify({ id, items, total_usd: 1, device_at: new Date().toISOString() }), offline, allowNegative]).then((r) => r[0]);

const moves = (db, dev, reason, list, session = dev.admin) =>
    q(db, dev.user, 'select * from public.process_stock_movements($1, $2, $3::jsonb)',
        [session, reason, JSON.stringify(list.map((m) => ({ id: randomUUID(), ...m })))]);

const level = async (db, who, product, sede) => {
    const rows = await q(db, who, 'select qty from public.stock_levels where product_id = $1 and ($2::uuid is null or sede_id = $2)', [product, sede ?? null]);
    return rows.length ? Number(rows[0].qty) : 0;
};

describe('F3 · libro de stock y cobro', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('E1: dos cajas venden 10 veces cada una el mismo producto → stock = inicial − 20', async () => {
        const ctx = await setup(db);
        const [a, b] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'harina', qty: 50 }]);
        for (let i = 0; i < 10; i += 1) {
            await sell(db, a, [{ product_id: 'harina', qty: 1 }]);
            await sell(db, b, [{ product_id: 'harina', qty: 1 }]);
        }
        expect(await level(db, a.user, 'harina')).toBe(30);
        const [{ n }] = await q(db, a.user, "select count(*)::int n from public.stock_movements where reason = 'VENTA'");
        expect(n).toBe(20);
    });

    it('numeración por caja: #A-00001, #A-00002… y #B-00001', async () => {
        const ctx = await setup(db);
        const [a, b] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'p', qty: 10 }]);
        expect((await sell(db, a, [{ product_id: 'p', qty: 1 }])).number).toBe('#A-00001');
        expect((await sell(db, a, [{ product_id: 'p', qty: 1 }])).number).toBe('#A-00002');
        expect((await sell(db, b, [{ product_id: 'p', qty: 1 }])).number).toBe('#B-00001');
    });

    it('E2: las dos cajas quieren la última unidad → una vende, la otra recibe «sin stock»', async () => {
        const ctx = await setup(db);
        const [a, b] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'ultima', qty: 1 }]);
        await sell(db, a, [{ product_id: 'ultima', qty: 1 }]);
        expect(await expectError(sell(db, b, [{ product_id: 'ultima', qty: 1 }]))).toMatch(/Sin stock suficiente: ultima \(hay 0.000, pides 1\)/);
        expect(await level(db, a.user, 'ultima')).toBe(0);
    });

    it('E11: reintentar la misma venta 3 veces deja una sola venta', async () => {
        const ctx = await setup(db);
        const [a] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'x', qty: 5 }]);
        const id = randomUUID();
        const first = await sell(db, a, [{ product_id: 'x', qty: 2 }], { id });
        const second = await sell(db, a, [{ product_id: 'x', qty: 2 }], { id });
        const third = await sell(db, a, [{ product_id: 'x', qty: 2 }], { id });
        expect(first.already_registered).toBe(false);
        expect([second.already_registered, third.already_registered]).toEqual([true, true]);
        expect(second.number).toBe(first.number);
        expect(await level(db, a.user, 'x')).toBe(3);
    });

    it('E4: las dos cajas sin internet venden la última unidad → las dos quedan y hay una diferencia pendiente', async () => {
        const ctx = await setup(db);
        const [a, b] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'u', qty: 1 }]);
        await sell(db, a, [{ product_id: 'u', qty: 1 }], { offline: true });
        const late = await sell(db, b, [{ product_id: 'u', qty: 1 }], { offline: true });
        expect(late.shortages).toEqual([{ product_id: 'u', available: 0, requested: 1 }]);
        expect(await level(db, a.user, 'u')).toBe(-1);
        const pending = await q(db, a.user, 'select product_id, expected_qty, sold_qty from public.stock_discrepancies where resolved_at is null');
        expect(pending).toEqual([{ product_id: 'u', expected_qty: '0.000', sold_qty: '1.000' }]);
        const [{ id: discId }] = await q(db, a.user, 'select id from public.stock_discrepancies');
        await q(db, a.user, 'select public.resolve_discrepancy($1, $2, $3)', [a.admin, discId, 'Se contó: había una más']);
        const [{ n }] = await q(db, a.user, 'select count(*)::int n from public.stock_discrepancies where resolved_at is null');
        expect(n).toBe(0);
    });

    it('la cuenta que permite stock negativo vende igual (como Bodega) y deja la diferencia', async () => {
        const ctx = await setup(db);
        const [a] = ctx.devices;
        const r = await sell(db, a, [{ product_id: 'neg', qty: 2 }], { allowNegative: true });
        expect(r.shortages).toHaveLength(1);
        expect(await level(db, a.user, 'neg')).toBe(-2);
    });

    it('E7: anular en la caja B una venta de la caja A devuelve el stock y queda quién anuló', async () => {
        const ctx = await setup(db);
        const [a, b] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'v', qty: 10 }]);
        const sale = await sell(db, a, [{ product_id: 'v', qty: 3 }, { product_id: 'v', qty: 1 }]);
        expect(await level(db, a.user, 'v')).toBe(6);
        expect(await expectError(q(db, b.user, 'select * from public.process_void($1,$2,$3)', [b.cajero, sale.sale_id, 'error']))).toMatch(/dueño o un administrador/);
        const [v] = await q(db, b.user, 'select * from public.process_void($1,$2,$3)', [b.admin, sale.sale_id, 'Cliente devolvió']);
        expect(v.already_voided).toBe(false);
        expect(await level(db, a.user, 'v')).toBe(10);
        const [s] = await q(db, a.user, 'select status, voided_by_device, device_id from public.sales where id = $1', [sale.sale_id]);
        expect(s.status).toBe('anulada');
        expect(s.voided_by_device).toBe(b.row.id);
        expect(s.device_id).toBe(a.row.id);
        const [again] = await q(db, b.user, 'select * from public.process_void($1,$2,$3)', [b.admin, sale.sale_id, 'x']);
        expect(again.already_voided).toBe(true);
        expect(await level(db, a.user, 'v')).toBe(10);
    });

    it('E8: compra de mercancía en la sede A no cambia el stock de la sede B', async () => {
        const ctx = await setup(db, { cajas: 2, sedes: 2 });
        const [a, b] = ctx.devices;
        await moves(db, a, 'COMPRA', [{ product_id: 'arroz', qty: 24 }]);
        expect(await level(db, a.user, 'arroz', ctx.sedeA)).toBe(24);
        expect(await level(db, a.user, 'arroz', ctx.sedeB)).toBe(0);
        await moves(db, b, 'COMPRA', [{ product_id: 'arroz', qty: 6 }]);
        expect(await level(db, b.user, 'arroz', ctx.sedeB)).toBe(6);
        expect(await level(db, a.user, 'arroz', ctx.sedeA)).toBe(24);
    });

    it('CONTEO registra solo la diferencia contra lo que dice el servidor', async () => {
        const ctx = await setup(db);
        const [a] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'c', qty: 10 }]);
        const [r] = await moves(db, a, 'CONTEO', [{ product_id: 'c', qty: 7 }]);
        expect(Number(r.qty)).toBe(-3);
        expect(await level(db, a.user, 'c')).toBe(7);
    });

    it('el libro no se edita ni se borra, ni siquiera con service_role (G6)', async () => {
        const ctx = await setup(db);
        const [a] = ctx.devices;
        await moves(db, a, 'INICIAL', [{ product_id: 'g6', qty: 1 }]);
        expect(await expectError(q(db, 'service', "update public.stock_movements set qty = 99 where product_id = 'g6'"))).toMatch(/no se edita/);
        expect(await expectError(q(db, 'service', "delete from public.stock_movements where product_id = 'g6'"))).toMatch(/no se edita/);
        expect(await expectError(q(db, a.user, "insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason) values (gen_random_uuid(), $1, $2, 'z', 1, 'AJUSTE')", [ctx.accountId, ctx.sedeA])))
            .toMatch(/permission denied/);
    });

    it('A7: el nivel siempre es la suma del libro', async () => {
        const rows = await q(db, 'service', `
            select l.product_id, l.qty, coalesce(sum(m.qty), 0) as ledger
            from public.stock_levels l
            left join public.stock_movements m on m.account_id = l.account_id and m.sede_id = l.sede_id and m.product_id = l.product_id
            group by l.account_id, l.sede_id, l.product_id, l.qty
            having l.qty <> coalesce(sum(m.qty), 0)`);
        expect(rows).toEqual([]);
    });

    it('el cajero vende pero no mueve inventario; una cuenta no ve el stock de otra', async () => {
        const ctx = await setup(db);
        const [a] = ctx.devices;
        expect(await expectError(moves(db, a, 'AJUSTE', [{ product_id: 'k', qty: 5 }], a.cajero))).toMatch(/dueño o un administrador/);
        const other = await setup(db);
        await moves(db, other.devices[0], 'INICIAL', [{ product_id: 'secreto', qty: 9 }]);
        expect(await level(db, a.user, 'secreto')).toBe(0);
    });

    it('el dueño (correo) carga el stock inicial al importar, sin PIN', async () => {
        const ctx = await setup(db);
        const rows = await q(db, ctx.owner, 'select * from public.process_stock_movements(null, $1, $2::jsonb)',
            ['INICIAL', JSON.stringify([{ id: randomUUID(), product_id: 'imp', qty: 40 }])]);
        expect(rows).toHaveLength(1);
        expect(await level(db, ctx.owner, 'imp')).toBe(40);
    });
});
