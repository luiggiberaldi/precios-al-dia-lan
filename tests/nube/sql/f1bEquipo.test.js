/**
 * A2 · F1b — Equipo desde la caja (migración 009): el dueño o un administrador gestionan
 * empleados con su sesión de PIN, cada uno cambia su PIN y el dueño repone el suyo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q, expectError } from './harness.js';

const OWNER_PIN = '482913';
const ADMIN_PIN = '246801';
const CAJERO_PIN = '1357';

async function setup(db, name) {
    const owner = await createUser(db, { email: `${name}@prueba.test` });
    await q(db, owner, 'select public.create_account($1,$2,$3,$4)', [name, 'Centro', 'Dueño', OWNER_PIN]);
    const device = await createUser(db, { anonymous: true });
    await q(db, owner, 'select * from public.register_device($1,$2,$3)', [device.id, 'Caja', 'caja']);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Ana', 'administrador', ADMIN_PIN]);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Luis', 'cajero', CAJERO_PIN]);
    const [{ id: ownerMemberId }] = await q(db, owner, "select id from public.account_members where role = 'dueno'");
    const login = async (memberId, pin) => {
        const [s] = await q(db, device, 'select * from public.member_login_pin($1,$2)', [memberId, pin]);
        return s?.session_token ?? null;
    };
    return { owner, device, adminId, cajeroId, ownerMemberId, login };
}

const upsert = (db, device, args) => q(db, device,
    'select public.team_upsert_member($1,$2,$3,$4,$5,$6) as id', [args.session, args.id ?? null, args.name, args.role, args.pin ?? null, args.active ?? true]);

describe('F1b · equipo desde la caja', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('el dueño, con su PIN en la caja, crea un cajero que luego entra', async () => {
        const ctx = await setup(db, 'equipo1');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        const [{ id }] = await upsert(db, ctx.device, { session: token, name: '  Pedro ', role: 'cajero', pin: '7771' });
        const [m] = await q(db, ctx.device, 'select display_name, role, active from public.account_members where id = $1', [id]);
        expect(m).toEqual({ display_name: 'Pedro', role: 'cajero', active: true });
        expect(await ctx.login(id, '7771')).toBeTruthy();
    });

    it('cambiar el PIN de un empleado cierra sus sesiones y solo vale el nuevo', async () => {
        const ctx = await setup(db, 'equipo2');
        const ownerToken = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        const luisToken = await ctx.login(ctx.cajeroId, CAJERO_PIN);
        await upsert(db, ctx.device, { session: ownerToken, id: ctx.cajeroId, name: 'Luis', role: 'cajero', pin: '9081' });
        const alive = await q(db, ctx.device, 'select * from public.current_member($1)', [luisToken]);
        expect(alive).toEqual([]);
        expect(await ctx.login(ctx.cajeroId, CAJERO_PIN)).toBeNull();
        expect(await ctx.login(ctx.cajeroId, '9081')).toBeTruthy();
    });

    it('desactivar impide entrar y reactivar devuelve el acceso con el PIN de antes', async () => {
        const ctx = await setup(db, 'equipo3');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        await upsert(db, ctx.device, { session: token, id: ctx.cajeroId, name: 'Luis', role: 'cajero', active: false });
        expect(await expectError(q(db, ctx.device, 'select * from public.member_login_pin($1,$2)', [ctx.cajeroId, CAJERO_PIN])))
            .toMatch(/Usuario o PIN incorrecto/);
        await upsert(db, ctx.device, { session: token, id: ctx.cajeroId, name: 'Luis', role: 'cajero', active: true });
        expect(await ctx.login(ctx.cajeroId, CAJERO_PIN)).toBeTruthy();
    });

    it('el administrador gestiona cajeros pero no administradores ni al dueño', async () => {
        const ctx = await setup(db, 'equipo4');
        const token = await ctx.login(ctx.adminId, ADMIN_PIN);
        const [{ id }] = await upsert(db, ctx.device, { session: token, name: 'Rosa', role: 'cajero', pin: '5566' });
        expect(id).toBeTruthy();
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'Otro', role: 'administrador', pin: '556678' })))
            .toMatch(/Solo el dueño crea o edita administradores/);
        expect(await expectError(upsert(db, ctx.device, { session: token, id: ctx.cajeroId, name: 'Luis', role: 'administrador' })))
            .toMatch(/Solo el dueño/);
        expect(await expectError(upsert(db, ctx.device, { session: token, id: ctx.ownerMemberId, name: 'Dueño', role: 'cajero' })))
            .toMatch(/Empleado no encontrado/);
        expect(await expectError(upsert(db, ctx.device, { session: token, id: ctx.adminId, name: 'Ana', role: 'cajero' })))
            .toMatch(/Solo el dueño|Cambiar mi PIN/);
    });

    it('un cajero no gestiona empleados y una sesión vencida o ajena no sirve', async () => {
        const ctx = await setup(db, 'equipo5');
        const token = await ctx.login(ctx.cajeroId, CAJERO_PIN);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'X', role: 'cajero', pin: '1112' })))
            .toMatch(/Solo el dueño o un administrador/);
        expect(await expectError(upsert(db, ctx.device, { session: '00000000-0000-0000-0000-000000000000', name: 'X', role: 'cajero', pin: '1112' })))
            .toMatch(/sesión venció/);
        // Token de otra caja (otro usuario anónimo): no vale.
        const other = await setup(db, 'equipo5b');
        const ownerToken = await other.login(other.ownerMemberId, OWNER_PIN);
        expect(await expectError(upsert(db, ctx.device, { session: ownerToken, name: 'X', role: 'cajero', pin: '1112' })))
            .toMatch(/sesión venció/);
    });

    it('nombres repetidos y PIN inválidos dan errores claros', async () => {
        const ctx = await setup(db, 'equipo6');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'luis', role: 'cajero', pin: '1239' })))
            .toMatch(/Ya hay alguien llamado «luis»/);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'Nuevo', role: 'cajero', pin: '123' })))
            .toMatch(/4 dígitos/);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'Nuevo', role: 'administrador', pin: '1234' })))
            .toMatch(/6 y 32/);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'Nuevo', role: 'administrador', pin: '000000' })))
            .toMatch(/000000/);
        expect(await expectError(upsert(db, ctx.device, { session: token, name: 'Nuevo', role: 'cajero' })))
            .toMatch(/necesita un PIN/);
    });

    it('cada uno cambia su propio PIN con el actual (también el dueño)', async () => {
        const ctx = await setup(db, 'equipo7');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        expect(await expectError(q(db, ctx.device, 'select public.member_change_own_pin($1,$2,$3)', [token, '999999', '612345'])))
            .toMatch(/PIN actual no es correcto/);
        expect(await expectError(q(db, ctx.device, 'select public.member_change_own_pin($1,$2,$3)', [token, OWNER_PIN, OWNER_PIN])))
            .toMatch(/distinto del actual/);
        await q(db, ctx.device, 'select public.member_change_own_pin($1,$2,$3)', [token, OWNER_PIN, '612345']);
        expect(await ctx.login(ctx.ownerMemberId, OWNER_PIN)).toBeNull();
        expect(await ctx.login(ctx.ownerMemberId, '612345')).toBeTruthy();
        const cajeroToken = await ctx.login(ctx.cajeroId, CAJERO_PIN);
        await q(db, ctx.device, 'select public.member_change_own_pin($1,$2,$3)', [cajeroToken, CAJERO_PIN, '7008']);
        expect(await ctx.login(ctx.cajeroId, '7008')).toBeTruthy();
    });

    it('el dueño repone su PIN con su correo; nadie más puede', async () => {
        const ctx = await setup(db, 'equipo8');
        await q(db, ctx.owner, 'select public.owner_set_own_pin($1)', ['314159']);
        expect(await ctx.login(ctx.ownerMemberId, '314159')).toBeTruthy();
        expect(await expectError(q(db, ctx.device, 'select public.owner_set_own_pin($1)', ['271828'])))
            .toMatch(/Solo el dueño/);
        expect(await expectError(q(db, null, 'select public.owner_set_own_pin($1)', ['271828'])))
            .toMatch(/permission denied/);
        expect(await expectError(q(db, ctx.owner, 'select nube_private.check_member_name(null, null, $1)', ['x'])))
            .toMatch(/permission denied/);
    });
    it('migración 012: cajero con PIN de 4 o sin PIN; administrador siempre con 6 o más', async () => {
        const ctx = await setup(db, 'equipo-sin-pin');
        const token = await ctx.login(ctx.ownerMemberId, OWNER_PIN);
        const sinPin = (args) => q(db, ctx.device,
            'select public.team_upsert_member($1,$2,$3,$4,$5,$6,$7) as id',
            [token, args.id ?? null, args.name, args.role, args.pin ?? null, true, args.sinPin ?? false]);

        // Cajero sin PIN: entra sin escribir nada y la caja sabe que no pide PIN.
        const [{ id }] = await sinPin({ name: 'Mostrador', role: 'cajero', sinPin: true });
        const [m] = await q(db, ctx.device, 'select pin_length from public.account_members where id = $1', [id]);
        expect(m.pin_length).toBeNull();
        expect(await ctx.login(id, null)).toBeTruthy();
        expect(await ctx.login(id, '9999')).toBeTruthy();

        // El PIN de 4 queda registrado como tal; el de 6 ya no vale para cajero.
        const [{ id: id4 }] = await sinPin({ name: 'Rita', role: 'cajero', pin: '4321' });
        const [m4] = await q(db, ctx.device, 'select pin_length from public.account_members where id = $1', [id4]);
        expect(m4.pin_length).toBe(4);
        expect(await expectError(sinPin({ name: 'Otro', role: 'cajero', pin: '123456' }))).toMatch(/4 dígitos/);

        // Administrador: ni sin PIN ni ascenso sin PIN largo.
        expect(await expectError(sinPin({ name: 'Jefe', role: 'administrador', sinPin: true }))).toMatch(/Solo el cajero/);
        expect(await expectError(sinPin({ id, name: 'Mostrador', role: 'administrador' }))).toMatch(/6 números o más/);

        // Ponerle PIN de nuevo: ya no entra sin él.
        await sinPin({ id, name: 'Mostrador', role: 'cajero', pin: '2580' });
        expect(await ctx.login(id, null)).toBeNull();
        expect(await ctx.login(id, '2580')).toBeTruthy();
    });
});
