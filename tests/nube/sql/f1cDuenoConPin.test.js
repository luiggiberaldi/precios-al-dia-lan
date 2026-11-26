/**
 * A2 · «Equipos y empleados» con el PIN del dueño (migración 010): el dueño, con su
 * sesión de PIN en un equipo, renombra y expulsa equipos. Nadie más puede.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q, expectError } from './harness.js';

const OWNER_PIN = '482913';
const ADMIN_PIN = '246801';

async function setup(db, name) {
    const owner = await createUser(db, { email: `${name}@prueba.test` });
    await q(db, owner, 'select public.create_account($1,$2,$3,$4)', [name, 'Centro', 'Dueño', OWNER_PIN]);
    const device = await createUser(db, { anonymous: true });
    const [caja1] = await q(db, owner, 'select * from public.register_device($1,$2,$3)', [device.id, 'Caja', 'caja']);
    const other = await createUser(db, { anonymous: true });
    const [caja2] = await q(db, owner, 'select * from public.register_device($1,$2,$3)', [other.id, 'Caja 2', 'consulta']);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Ana', 'administrador', ADMIN_PIN]);
    const [{ id: ownerMemberId }] = await q(db, owner, "select id from public.account_members where role = 'dueno'");
    const login = async (memberId, pin) => {
        const [s] = await q(db, device, 'select * from public.member_login_pin($1,$2)', [memberId, pin]);
        return s?.session_token ?? null;
    };
    return { owner, device, other, caja1, caja2, adminId, ownerMemberId, login };
}

describe('Dueño con PIN · equipos', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('el dueño con su PIN renombra un equipo y ve los equipos de su cuenta', async () => {
        const ctx = await setup(db, 'pin1');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        await q(db, ctx.device, 'select * from public.team_rename_device($1,$2,$3)', [token, ctx.caja2.id, 'Mostrador']);
        const rows = await q(db, ctx.device, 'select label from public.account_devices where revoked_at is null order by created_at');
        expect(rows.map((r) => r.label)).toEqual(['Caja', 'Mostrador']);
    });

    it('el dueño con su PIN expulsa otro equipo y se cierran sus sesiones', async () => {
        const ctx = await setup(db, 'pin2');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        await q(db, ctx.device, 'select public.team_revoke_device($1,$2)', [token, ctx.caja2.id]);
        const [d] = await q(db, ctx.owner, 'select revoked_at from public.account_devices where id = $1', [ctx.caja2.id]);
        expect(d.revoked_at).not.toBeNull();
        await expectError(q(db, ctx.device, 'select public.team_revoke_device($1,$2)', [token, ctx.caja2.id]));
    });

    it('un administrador no renombra ni expulsa equipos', async () => {
        const ctx = await setup(db, 'pin3');
        const token = await ctx.login(ctx.adminId, ADMIN_PIN);
        await expectError(q(db, ctx.device, 'select * from public.team_rename_device($1,$2,$3)', [token, ctx.caja2.id, 'X']));
        await expectError(q(db, ctx.device, 'select public.team_revoke_device($1,$2)', [token, ctx.caja2.id]));
    });

    it('sin sesión válida o con equipo de otra cuenta no hace nada', async () => {
        const a = await setup(db, 'pin4a');
        const b = await setup(db, 'pin4b');
        const token = await a.login(a.ownerMemberId, OWNER_PIN);
        await expectError(q(db, a.device, 'select public.team_revoke_device($1,$2)', [token, b.caja2.id]));
        // La sesión de PIN solo vale en el equipo donde se abrió.
        await expectError(q(db, a.other, 'select public.team_revoke_device($1,$2)', [token, a.caja2.id]));
        await expectError(q(db, a.device, 'select public.team_revoke_device($1,$2)', ['00000000-0000-0000-0000-000000000000', a.caja2.id]));
    });
});
