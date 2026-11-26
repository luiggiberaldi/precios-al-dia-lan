/**
 * A2 · F2 — Registros de catálogo, clientes y ajustes (G7, G8, G12, G13).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db, name = 'Negocio') {
    const owner = await createUser(db, { email: `${name}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', [name, 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const device = await createUser(db, { anonymous: true });
    await q(db, owner, 'select * from public.register_device($1, $2)', [device.id, 'Caja']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Ana', 'cajero', '1357']);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Beto', 'administrador', '246801']);
    const [cajero] = await q(db, device, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
    const [admin] = await q(db, device, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    return { owner, accountId, device, cajero: cajero.session_token, admin: admin.session_token };
}

const push = (db, user, session, collection, records) =>
    q(db, user, 'select * from public.push_records($1, $2, $3::jsonb)', [session, collection, JSON.stringify(records)]);

describe('F2 · registros', () => {
    let db;
    let ctx;
    beforeAll(async () => {
        db = await createDb();
        ctx = await setup(db);
    }, 60_000);

    it('el administrador sube productos sin el stock; el servidor los guarda por registro', async () => {
        const rows = await push(db, ctx.device, ctx.admin, 'products', [
            { id: 'p1', data: { id: 'p1', name: 'Harina', priceUsd: 1.2, stock: 99 } },
            { id: 'p2', data: { id: 'p2', name: 'Arroz', priceUsd: 1.5, stockInLotes: 3 } },
        ]);
        expect(rows.map((r) => r.version)).toEqual([1, 1]);
        const saved = await q(db, ctx.device, "select id, data from public.account_records where collection = 'products' order by id");
        expect(saved.map((r) => r.data)).toEqual([
            { id: 'p1', name: 'Harina', priceUsd: 1.2 },
            { id: 'p2', name: 'Arroz', priceUsd: 1.5 },
        ]);
    });

    it('reenviar el mismo registro no lo duplica: sube la versión (G7)', async () => {
        const [r] = await push(db, ctx.device, ctx.admin, 'products', [{ id: 'p1', data: { id: 'p1', name: 'Harina PAN', priceUsd: 1.3 } }]);
        expect(r.version).toBe(2);
        const [{ n }] = await q(db, ctx.device, "select count(*)::int n from public.account_records where collection = 'products'");
        expect(n).toBe(2);
    });

    it('el cajero puede guardar clientes (sin saldo) pero no productos', async () => {
        await push(db, ctx.device, ctx.cajero, 'customers', [{ id: 'c1', data: { id: 'c1', name: 'María', deuda: 12.5, favor: 1 } }]);
        const [c] = await q(db, ctx.device, "select data from public.account_records where collection = 'customers' and id = 'c1'");
        expect(c.data).toEqual({ id: 'c1', name: 'María' });
        expect(await expectError(push(db, ctx.device, ctx.cajero, 'products', [{ id: 'p9', data: { id: 'p9' } }])))
            .toMatch(/dueño o un administrador/);
    });

    it('borrar marca el registro (borrado suave) y avisa en account_sync_state', async () => {
        const [before] = await q(db, ctx.device, "select changed_at from public.account_sync_state where collection = 'products'");
        await push(db, ctx.device, ctx.admin, 'products', [{ id: 'p2', data: { id: 'p2' }, deleted: true }]);
        const [p2] = await q(db, ctx.device, "select deleted_at from public.account_records where collection = 'products' and id = 'p2'");
        expect(p2.deleted_at).not.toBeNull();
        const [after] = await q(db, ctx.device, "select changed_at from public.account_sync_state where collection = 'products'");
        expect(new Date(after.changed_at) >= new Date(before.changed_at)).toBe(true);
    });

    it('el dueño (correo) puede subir sin sesión de PIN, p. ej. al importar', async () => {
        const rows = await push(db, ctx.owner, null, 'settings', [{ id: 'my_categories_v1', data: { value: ['Víveres', 'Bebidas'] } }]);
        expect(rows).toHaveLength(1);
    });

    it('sin sesión válida, con sesión vencida o desde un equipo ajeno no se guarda nada', async () => {
        const stranger = await createUser(db, { anonymous: true });
        expect(await expectError(push(db, stranger, ctx.admin, 'customers', [{ id: 'x', data: {} }]))).toMatch(/sesión venció/);
        expect(await expectError(push(db, ctx.device, '00000000-0000-0000-0000-000000000000', 'customers', [{ id: 'x', data: {} }])))
            .toMatch(/sesión venció/);
        expect(await expectError(q(db, ctx.device, "insert into public.account_records (account_id, collection, id, data) values ($1, 'products', 'z', '{}')", [ctx.accountId])))
            .toMatch(/permission denied/);
    });

    it('rechaza registros enormes (imágenes incrustadas) y colecciones desconocidas (G12)', async () => {
        const huge = 'x'.repeat(300_000);
        expect(await expectError(push(db, ctx.device, ctx.admin, 'products', [{ id: 'big', data: { id: 'big', image: huge } }])))
            .toMatch(/demasiado grande/);
        expect(await expectError(push(db, ctx.device, ctx.admin, 'ventas', [{ id: 'v', data: {} }]))).toMatch(/inválida/);
    });

    it('una cuenta no ve los registros de otra (G13)', async () => {
        const other = await setup(db, 'Otro');
        await push(db, other.device, other.admin, 'products', [{ id: 'secreto', data: { id: 'secreto' } }]);
        const mine = await q(db, ctx.device, 'select id from public.account_records');
        expect(mine.map((r) => r.id)).not.toContain('secreto');
        const theirs = await q(db, other.owner, 'select id from public.account_records');
        expect(theirs.map((r) => r.id)).toEqual(['secreto']);
    });
});
