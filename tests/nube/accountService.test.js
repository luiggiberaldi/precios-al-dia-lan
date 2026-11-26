/**
 * F1 · flujo completo del servicio de cuentas contra el SQL real (PGlite):
 * dueño crea cuenta → registra este equipo → agrega cajero → el cajero entra con PIN.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import {
    ensureDeviceSession, getDeviceStatus, ownerSignUp, ownerSignIn, ownerSignOut, getOwnerAccount,
    createAccount, registerDevice, listOwnerDevices, revokeDevice, upsertMember, listMembers,
    loginWithPin, checkMemberSession, logoutMember, toAppRole, toNubeError, NubeError,
} from '../../src/nube/accountService.js';
import { toLegacySession, applyToAuthStore, saveMemberSession, readMemberSession, clearMemberSession } from '../../src/nube/memberSession.js';

describe('F1 · servicio de cuentas (flujo completo)', () => {
    let db;
    let accounts;
    beforeAll(async () => {
        db = await createDb();
        accounts = new Map();
    }, 60_000);

    it('primer arranque: dueño crea cuenta, registra el equipo y el cajero entra con PIN', async () => {
        const device = new FakeSupabase(db, { accounts });
        const deviceUserId = await ensureDeviceSession(device);
        expect(await ensureDeviceSession(device)).toBe(deviceUserId); // reutiliza la sesión
        expect(await getDeviceStatus(device, deviceUserId)).toBeNull();

        const owner = new FakeSupabase(db, { accounts });
        const { needsConfirmation } = await ownerSignUp(owner, 'dueno@bodega.test', 'clave-segura-1');
        expect(needsConfirmation).toBe(false);
        expect(await getOwnerAccount(owner)).toBeNull();
        await createAccount(owner, { businessName: 'Bodega Luz', sedeName: 'Centro', ownerName: 'Luis', ownerPin: '482913' });
        expect((await getOwnerAccount(owner)).name).toBe('Bodega Luz');

        const registered = await registerDevice(owner, { deviceUserId, label: 'Caja principal' });
        const reg = Array.isArray(registered) ? registered[0] : registered;
        expect(reg.id).toMatch(/^PDN-/);
        await upsertMember(owner, { name: 'María', role: 'cajero', pin: '1357' });
        await ownerSignOut(owner);

        const status = await getDeviceStatus(device, deviceUserId);
        expect(status.account.name).toBe('Bodega Luz');
        expect(status.device.caja_letter).toBe('A');
        expect(status.sedes.map((s) => s.name)).toEqual(['Centro']);

        const members = await listMembers(device);
        expect(members.map((m) => m.display_name)).toEqual(['Luis', 'María']);
        const maria = members.find((m) => m.display_name === 'María');

        await expect(loginWithPin(device, maria.id, '999999')).rejects.toMatchObject({ code: 'PIN_INCORRECTO' });
        const session = await loginWithPin(device, maria.id, '1357');
        expect(session).toMatchObject({ name: 'María', role: 'cajero' });
        expect(await checkMemberSession(device, session.token)).toMatchObject({ name: 'María' });
        await logoutMember(device, session.token);
        expect(await checkMemberSession(device, session.token)).toBeNull();
    });

    it('el dueño ve y expulsa equipos; el expulsado deja de estar registrado', async () => {
        const owner = new FakeSupabase(db, { accounts });
        await ownerSignIn(owner, 'dueno@bodega.test', 'clave-segura-1');
        const devices = await listOwnerDevices(owner);
        expect(devices).toHaveLength(1);
        const deviceUserIdRow = await db.query('select auth_user_id from public.account_devices where id = $1', [devices[0].id]);
        await revokeDevice(owner, devices[0].id);
        const device = new FakeSupabase(db, { accounts });
        device.user = { id: deviceUserIdRow.rows[0].auth_user_id, anonymous: true };
        expect(await getDeviceStatus(device, device.user.id)).toBeNull();
    });

    it('errores con mensajes claros', async () => {
        const owner = new FakeSupabase(db, { accounts });
        await expect(ownerSignIn(owner, 'dueno@bodega.test', 'mala')).rejects.toThrow('Correo o contraseña incorrectos.');
        await expect(ownerSignUp(owner, 'dueno@bodega.test', 'clave-segura-1')).rejects.toThrow(/ya tiene una cuenta/);
        await expect(ownerSignUp(owner, 'x@y.test', 'corta')).rejects.toThrow(/8 caracteres/);
        expect(toNubeError({ message: 'Anonymous sign-ins are disabled' }).message).toMatch(/sesiones anónimas/);
        expect(toNubeError(new NubeError('igual')).message).toBe('igual');
    });
});

describe('F1 · puente con la app heredada', () => {
    it('convierte roles y sesiones sin guardar datos sensibles', () => {
        expect(toAppRole('dueno')).toBe('ADMIN');
        expect(toAppRole('administrador')).toBe('ADMIN');
        expect(toAppRole('cajero')).toBe('CAJERO');
        expect(toLegacySession({ memberId: 'm1', name: 'Ana', role: 'cajero', token: 'secreto' }))
            .toEqual({ id: 'm1', nombre: 'Ana', rol: 'CAJERO', nube: true });
    });

    it('guarda, lee y descarta la sesión de PIN; una vencida no cuenta', () => {
        const mem = new Map();
        const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
        const future = new Date(Date.now() + 60_000).toISOString();
        saveMemberSession({ token: 't', memberId: 'm', name: 'Ana', role: 'cajero', expiresAt: future }, storage);
        expect(readMemberSession(storage)?.memberId).toBe('m');
        saveMemberSession({ token: 't', memberId: 'm', expiresAt: new Date(Date.now() - 1).toISOString() }, storage);
        expect(readMemberSession(storage)).toBeNull();
        clearMemberSession(storage);
        expect(readMemberSession(storage)).toBeNull();

        let state = {};
        const store = { setState: (s) => { state = { ...state, ...s }; } };
        applyToAuthStore(store, { memberId: 'm', name: 'Ana', role: 'dueno' }, storage);
        expect(state.usuarioActivo).toEqual({ id: 'm', nombre: 'Ana', rol: 'ADMIN', nube: true });
        expect(JSON.parse(mem.get('abasto-device-session')).rol).toBe('ADMIN');
    });
});
