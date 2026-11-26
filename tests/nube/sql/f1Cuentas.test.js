/**
 * A2 · F1 — Cuentas, equipos, empleados y licencia (barandas G4, G7, G8, G13).
 * Corre contra Postgres real (PGlite) con las migraciones de supabase/nube/migrations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, createUser, q, as, expectError } from './harness.js';

const OWNER_PIN = '482913';

async function setupAccount(db, { name = 'Bodega Prueba' } = {}) {
    const owner = await createUser(db, { email: `${name.replace(/\s/g, '')}@prueba.test` });
    const [{ create_account: accountId }] = await q(db, owner,
        'select public.create_account($1, $2, $3, $4)', [name, 'Sede Centro', 'Dueño', OWNER_PIN]);
    return { owner, accountId };
}

async function registerDevice(db, owner, { role = 'caja', label = 'Caja' } = {}) {
    const device = await createUser(db, { anonymous: true });
    const [row] = await q(db, owner, 'select * from public.register_device($1, $2, $3)', [device.id, label, role]);
    return { device, row };
}

describe('F1 · migraciones', () => {
    it('se pueden aplicar dos veces sobre una base vacía (G4)', async () => {
        const db = await createDb({ times: 2 });
        const rows = await q(db, 'service', 'select count(*)::int as n from public.accounts');
        expect(rows[0].n).toBe(0);
    }, 60_000);
});

describe('F1 · cuentas', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('el dueño crea su cuenta con sede, licencia de prueba y su usuario', async () => {
        const { owner, accountId } = await setupAccount(db);
        const [acc] = await q(db, owner, 'select name from public.accounts');
        expect(acc.name).toBe('Bodega Prueba');
        const [lic] = await q(db, owner, 'select status, max_cajas, max_sedes from public.account_licenses');
        expect(lic).toEqual({ status: 'trial', max_cajas: 2, max_sedes: 1 });
        const sedes = await q(db, owner, 'select name from public.sedes');
        expect(sedes.map((s) => s.name)).toEqual(['Sede Centro']);
        const members = await q(db, owner, 'select display_name, role from public.account_members');
        expect(members).toEqual([{ display_name: 'Dueño', role: 'dueno' }]);
        // Reintento: devuelve la misma cuenta, no duplica (G7).
        const [{ create_account: again }] = await q(db, owner,
            'select public.create_account($1, $2, $3, $4)', ['Otra', 'X', 'Dueño', OWNER_PIN]);
        expect(again).toBe(accountId);
    });

    it('una sesión anónima no puede crear cuentas', async () => {
        const anonDevice = await createUser(db, { anonymous: true });
        const msg = await expectError(q(db, anonDevice, 'select public.create_account($1,$2,$3,$4)', ['X', 'Y', 'Z', OWNER_PIN]));
        expect(msg).toMatch(/Solo el dueño/);
    });

    it('el PIN del dueño no puede ser 000000 ni tener menos de 6 dígitos', async () => {
        const u1 = await createUser(db);
        expect(await expectError(q(db, u1, 'select public.create_account($1,$2,$3,$4)', ['N1', 'S', 'D', '000000'])))
            .toMatch(/000000/);
        const u2 = await createUser(db);
        expect(await expectError(q(db, u2, 'select public.create_account($1,$2,$3,$4)', ['N2', 'S', 'D', '1234'])))
            .toMatch(/6 y 32/);
    });

    it('nadie escribe directo en las tablas (G8)', async () => {
        const { owner, accountId } = await setupAccount(db, { name: 'Directo' });
        expect(await expectError(q(db, owner, 'update public.account_licenses set max_cajas = 99 where account_id = $1', [accountId])))
            .toMatch(/permission denied/);
        expect(await expectError(q(db, owner, "insert into public.sedes (account_id, name) values ($1, 'Pirata')", [accountId])))
            .toMatch(/permission denied/);
        expect(await expectError(q(db, owner, 'select pin_hash from public.account_members')))
            .toMatch(/permission denied/);
        // Los ayudantes internos no se pueden llamar desde la app (asesor de Supabase).
        for (const fn of ['nube_my_account_id()', 'nube_owner_account_id()', 'nube_current_device()']) {
            expect(await expectError(q(db, owner, `select public.${fn}`))).toMatch(/permission denied/);
        }
        // La función interna que devuelve la fila completa (con hash) no se puede llamar.
        expect(await expectError(q(db, owner, 'select * from public.nube_session_member(gen_random_uuid())')))
            .toMatch(/permission denied/);
    });

    it('sin sesión no se lee nada', async () => {
        await setupAccount(db, { name: 'Anon Prueba' });
        expect(await expectError(q(db, null, 'select * from public.accounts'))).toMatch(/permission denied/);
    });
});

describe('F1 · equipos y licencia', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('registra cajas con letra A, B… hasta el límite de la licencia; el siguiente es rechazado', async () => {
        const { owner, accountId } = await setupAccount(db);
        await q(db, 'service', 'update public.account_licenses set max_cajas = 3, status = $2 where account_id = $1', [accountId, 'active']);

        const letters = [];
        for (let i = 0; i < 3; i += 1) {
            const { row } = await registerDevice(db, owner, { label: `Caja ${i + 1}` });
            expect(row.id).toMatch(/^PDN-[0-9A-F]{32}$/);
            letters.push(row.caja_letter);
        }
        expect(letters).toEqual(['A', 'B', 'C']);

        const extra = await createUser(db, { anonymous: true });
        expect(await expectError(q(db, owner, 'select * from public.register_device($1, $2)', [extra.id, 'Caja 4'])))
            .toMatch(/permite 3 caja/);

        // El teléfono del dueño (consulta) no cuenta para la licencia.
        const { row: phone } = await registerDevice(db, owner, { role: 'consulta', label: 'Teléfono dueño' });
        expect(phone.caja_letter).toBeNull();
    });

    it('registrar el mismo equipo dos veces devuelve el mismo registro (G7)', async () => {
        const { owner } = await setupAccount(db, { name: 'Reintento' });
        const device = await createUser(db, { anonymous: true });
        const [a] = await q(db, owner, 'select * from public.register_device($1, $2)', [device.id, 'Caja']);
        const [b] = await q(db, owner, 'select * from public.register_device($1, $2)', [device.id, 'Caja']);
        expect(b.id).toBe(a.id);
    });

    it('expulsar libera la letra y el equipo deja de ver la cuenta', async () => {
        const { owner, accountId } = await setupAccount(db, { name: 'Expulsar' });
        await q(db, 'service', 'update public.account_licenses set max_cajas = 2 where account_id = $1', [accountId]);
        const { device, row } = await registerDevice(db, owner);
        expect((await q(db, device, 'select id from public.accounts')).length).toBe(1);

        await q(db, owner, 'select public.revoke_device($1)', [row.id]);
        expect((await q(db, device, 'select id from public.accounts')).length).toBe(0);

        const { row: again } = await registerDevice(db, owner, { label: 'Caja nueva' });
        expect(again.caja_letter).toBe('A');
    });

    it('un equipo o un cajero no pueden registrar equipos', async () => {
        const { owner } = await setupAccount(db, { name: 'Solo dueño' });
        const { device } = await registerDevice(db, owner);
        const other = await createUser(db, { anonymous: true });
        expect(await expectError(q(db, device, 'select * from public.register_device($1, $2)', [other.id, 'X'])))
            .toMatch(/Solo el dueño/);
    });

    it('con la licencia vencida no se registran equipos', async () => {
        const { owner, accountId } = await setupAccount(db, { name: 'Vencida' });
        await q(db, 'service', "update public.account_licenses set expires_at = now() - interval '1 day' where account_id = $1", [accountId]);
        const device = await createUser(db, { anonymous: true });
        expect(await expectError(q(db, owner, 'select * from public.register_device($1, $2)', [device.id, 'Caja'])))
            .toMatch(/no está activa/);
    });
});

describe('F1 · empleados y PIN', () => {
    let db;
    let ctx;
    beforeAll(async () => {
        db = await createDb();
        const { owner, accountId } = await setupAccount(db);
        const { device } = await registerDevice(db, owner);
        const [{ upsert_member: cajeroId }] = await q(db, owner,
            'select public.upsert_member(null, $1, $2, $3)', ['María', 'cajero', '1357']);
        ctx = { owner, accountId, device, cajeroId };
    }, 60_000);

    it('el cajero entra con su PIN en un equipo registrado y obtiene una sesión', async () => {
        const rows = await q(db, ctx.device, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '1357']);
        expect(rows).toHaveLength(1);
        expect(rows[0].role).toBe('cajero');
        const [check] = await q(db, ctx.device, 'select display_name as n from public.current_member($1)', [rows[0].session_token]);
        expect(check.n).toBe('María');
    });

    it('un PIN incorrecto no da sesión; a los 5 intentos bloquea', async () => {
        for (let i = 0; i < 5; i += 1) {
            const rows = await q(db, ctx.device, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '0001']);
            expect(rows).toHaveLength(0);
        }
        expect(await expectError(q(db, ctx.device, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '1357'])))
            .toMatch(/Demasiados intentos/);
        await q(db, 'service', 'update public.account_members set locked_until = null where id = $1', [ctx.cajeroId]);
    });

    it('el PIN no sirve desde un equipo sin registrar ni desde otra cuenta', async () => {
        const stranger = await createUser(db, { anonymous: true });
        expect(await expectError(q(db, stranger, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '1357'])))
            .toMatch(/no está registrado/);

        const other = await setupAccount(db, { name: 'Otra cuenta' });
        const { device: otherDevice } = await registerDevice(db, other.owner);
        expect(await expectError(q(db, otherDevice, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '1357'])))
            .toMatch(/incorrecto/);
    });

    it('la sesión de PIN solo vale en el equipo donde se abrió y muere al expulsarlo', async () => {
        const [s] = await q(db, ctx.device, 'select * from public.member_login_pin($1, $2)', [ctx.cajeroId, '1357']);
        const { device: device2, row: row2 } = await registerDevice(db, ctx.owner, { role: 'consulta', label: 'Tablet' });
        const other = await q(db, device2, 'select member_id as id from public.current_member($1)', [s.session_token]);
        expect(other).toHaveLength(0);
        await q(db, ctx.owner, 'select public.revoke_device($1)', [row2.id]);

        const [{ id: devId }] = await q(db, ctx.owner, 'select id from public.account_devices where auth_user_id = $1', [ctx.device.id]);
        await q(db, ctx.owner, 'select public.revoke_device($1)', [devId]);
        const dead = await as(db, ctx.device, async (tx) =>
            (await tx.query('select member_id as id from public.current_member($1)', [s.session_token])).rows);
        expect(dead).toHaveLength(0);
    });
});

describe('F1 · aislamiento entre cuentas (G13)', () => {
    it('una cuenta no ve nada de otra', async () => {
        const db = await createDb();
        const a = await setupAccount(db, { name: 'Cuenta A' });
        const b = await setupAccount(db, { name: 'Cuenta B' });
        const { device: deviceB } = await registerDevice(db, b.owner);
        for (const table of ['accounts', 'account_licenses', 'sedes', 'account_devices']) {
            const rows = await q(db, a.owner, `select * from public.${table}`);
            expect(rows.every((r) => (r.account_id ?? r.id) === a.accountId)).toBe(true);
            const rowsB = await q(db, deviceB, `select * from public.${table}`);
            expect(rowsB.every((r) => (r.account_id ?? r.id) === b.accountId)).toBe(true);
        }
        const members = await q(db, a.owner, 'select account_id from public.account_members');
        expect(members.every((m) => m.account_id === a.accountId)).toBe(true);
    }, 60_000);
});
