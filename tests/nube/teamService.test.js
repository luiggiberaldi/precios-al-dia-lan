/**
 * F1b · equipo desde la caja: reglas puras (teamRules), servicio contra el SQL real
 * (PGlite) y la recuperación de la clave del dueño.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createDb } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import {
    ensureDeviceSession, ownerSignUp, createAccount, registerDevice, upsertMember, loginWithPin,
    listTeam, teamUpsertMember, changeOwnPin, ownerSetOwnPin, toNubeError,
    requestPasswordReset, parseRecoveryHash, completePasswordReset, resendConfirmation, isEmailNotConfirmed,
} from '../../src/nube/accountService.js';
import {
    validatePin, validateMemberName, memberPinLength, pinHint, canManageTeam, canEditMember, assignableRoles,
    describeDeviceLocation, onlyPinDigits, passwordStrength, isEmail, roleLabel,
} from '../../src/nube/teamRules.js';

describe('teamRules', () => {
    it('valida el PIN con mensajes en español', () => {
        expect(validatePin('', '')).toMatch(/Escribe el PIN/);
        expect(validatePin('12a456')).toMatch(/solo lleva números/);
        expect(validatePin('12345', undefined, 'administrador')).toMatch(/al menos 6/);
        expect(validatePin('1'.repeat(33), undefined, 'administrador')).toMatch(/32/);
        expect(validatePin('000000', '000000', 'administrador')).toMatch(/000000/);
        expect(validatePin('123456', '123457', 'administrador')).toMatch(/no coinciden/);
        expect(validatePin('123456', '123456', 'administrador')).toBeNull();
        expect(validatePin('123456', undefined, 'dueno')).toBeNull(); // sin confirmación
        // Cajero: 4 dígitos exactos (migración 012).
        expect(validatePin('1234', '1234', 'cajero')).toBeNull();
        expect(validatePin('0000', '0000', 'cajero')).toBeNull();
        expect(validatePin('123456', '123456', 'cajero')).toMatch(/4 números/);
        expect(validatePin('123', undefined, 'cajero')).toMatch(/4 números/);
        expect(validatePin('1234', '1235', 'cajero')).toMatch(/no coinciden/);
        expect(onlyPinDigits('12 3-4a56')).toBe('123456');
    });

    it('valida el nombre', () => {
        expect(validateMemberName('  ')).toMatch(/Escribe el nombre/);
        expect(validateMemberName('x'.repeat(41))).toMatch(/40/);
        expect(validateMemberName('María')).toBeNull();
    });

    it('permisos: el dueño maneja todo, el encargado maneja cajeros e inventario, cajero e inventario nada', () => {
        expect(canManageTeam('dueno')).toBe(true);
        expect(canManageTeam('administrador')).toBe(true);
        expect(canManageTeam('inventario')).toBe(false);
        expect(canManageTeam('cajero')).toBe(false);
        expect(assignableRoles('dueno')).toEqual(['cajero', 'inventario', 'administrador']);
        expect(assignableRoles('administrador')).toEqual(['cajero', 'inventario']);
        expect(assignableRoles('inventario')).toEqual([]);
        const admin = { memberId: 'a', role: 'administrador' };
        expect(canEditMember(admin, { id: 'c', role: 'cajero' })).toBe(true);
        expect(canEditMember(admin, { id: 'i', role: 'inventario' })).toBe(true);
        expect(canEditMember(admin, { id: 'b', role: 'administrador' })).toBe(false);
        expect(canEditMember(admin, { id: 'a', role: 'administrador' })).toBe(false);
        expect(canEditMember({ memberId: 'd', role: 'dueno' }, { id: 'o', role: 'dueno' })).toBe(false);
        expect(canEditMember({ memberId: 'd', role: 'dueno' }, { id: 'b', role: 'administrador' })).toBe(true);
        expect(roleLabel('dueno')).toBe('Dueño');
        expect(roleLabel('administrador')).toBe('Encargado');
        expect(roleLabel('inventario')).toBe('Inventario');
    });

    it('describe la caja sin repetir el nombre (antes: «Caja A · Caja A»)', () => {
        const base = { account: { name: 'Bodega de Prueba Nube' }, sedes: [{ id: 's1', name: 'Principal' }] };
        expect(describeDeviceLocation({ ...base, device: { sede_id: 's1', caja_letter: 'A', label: 'Caja A', role: 'caja' } }))
            .toEqual({ business: 'Bodega de Prueba Nube', sede: 'Principal', device: 'Caja A' });
        expect(describeDeviceLocation({ ...base, device: { sede_id: 's1', caja_letter: 'A', label: ' caja  a ', role: 'caja' } }).device).toBe('Caja A');
        expect(describeDeviceLocation({ ...base, device: { sede_id: 's1', caja_letter: 'B', label: 'Caja del frente', role: 'caja' } }).device)
            .toBe('Caja B · Caja del frente');
        expect(describeDeviceLocation({ ...base, device: { sede_id: 's1', caja_letter: null, label: 'Teléfono', role: 'consulta' } }).device)
            .toBe('Consulta · Teléfono');
        expect(describeDeviceLocation(null)).toEqual({ business: null, sede: null, device: null });
    });

    it('correo y fuerza de la clave', () => {
        expect(isEmail('a@b.co')).toBe(true);
        expect(isEmail('a@b')).toBe(false);
        expect(passwordStrength('')).toBe(0);
        expect(passwordStrength('abcdefgh')).toBe(1);
        expect(passwordStrength('Abcdefgh1234!')).toBe(4);
    });
});

describe('F1b · servicio del equipo contra el SQL real', () => {
    let db;
    let device;
    let owner;
    let ownerToken;
    beforeAll(async () => {
        db = await createDb();
        const accounts = new Map();
        device = new FakeSupabase(db, { accounts });
        const uid = await ensureDeviceSession(device);
        owner = new FakeSupabase(db, { accounts });
        await ownerSignUp(owner, 'equipo@bodega.test', 'clave-segura-1');
        await createAccount(owner, { businessName: 'Bodega Equipo', sedeName: 'Centro', ownerName: 'Dueña', ownerPin: '482913' });
        await registerDevice(owner, { deviceUserId: uid, label: 'Caja A' });
        const team = await listTeam(device);
        ownerToken = (await loginWithPin(device, team[0].id, '482913')).token;
    }, 60_000);

    it('crea un cajero, le cambia el PIN, lo desactiva y la lista lo muestra desactivado', async () => {
        const id = await teamUpsertMember(device, ownerToken, { name: 'Carlos', role: 'cajero', pin: '1357' });
        expect((await loginWithPin(device, id, '1357')).name).toBe('Carlos');
        await teamUpsertMember(device, ownerToken, { id, name: 'Carlos', role: 'cajero', pin: '2468' });
        await expect(loginWithPin(device, id, '1357')).rejects.toThrow(/PIN incorrecto/);
        expect((await loginWithPin(device, id, '2468')).role).toBe('cajero');
        await teamUpsertMember(device, ownerToken, { id, name: 'Carlos', role: 'cajero', active: false });
        const carlos = (await listTeam(device)).find((m) => m.id === id);
        expect(carlos.active).toBe(false);
    });

    it('RBAC: crea un empleado de inventario (PIN 6+ obligatorio) y un encargado puede gestionarlo', async () => {
        const invId = await teamUpsertMember(device, ownerToken, { name: 'Sofía Almacén', role: 'inventario', pin: '654321' });
        expect((await loginWithPin(device, invId, '654321')).role).toBe('inventario');
        // Inventario no puede quedar sin PIN ni con PIN de 4 dígitos
        await expect(teamUpsertMember(device, ownerToken, { name: 'Otro Inv', role: 'inventario', sinPin: true }))
            .rejects.toThrow(/Solo el cajero/);
        await expect(teamUpsertMember(device, ownerToken, { name: 'Otro Inv', role: 'inventario', pin: '1234' }))
            .rejects.toThrow(/6 y 32/);
        // Encargado puede editar a inventario pero no crear otro encargado
        const encId = await teamUpsertMember(device, ownerToken, { name: 'Luis Encargado', role: 'administrador', pin: '789012' });
        const encToken = (await loginWithPin(device, encId, '789012')).token;
        await teamUpsertMember(device, encToken, { id: invId, name: 'Sofía Stock', role: 'inventario' });
        await expect(teamUpsertMember(device, encToken, { name: 'Otro Enc', role: 'administrador', pin: '890123' }))
            .rejects.toThrow(/Solo el dueño/);
    });

    it('nombre repetido o sin sesión: errores claros', async () => {
        await expect(teamUpsertMember(device, ownerToken, { name: 'carlos', role: 'cajero', pin: '1358' }))
            .rejects.toThrow(/Ya hay alguien llamado/);
        await expect(teamUpsertMember(device, null, { name: 'Otro', role: 'cajero', pin: '1358' }))
            .rejects.toThrow(/sesión venció/);
    });

    it('cambiar mi PIN y reponer el del dueño con el correo', async () => {
        await expect(changeOwnPin(device, ownerToken, '000001', '777888')).rejects.toThrow(/PIN actual no es correcto/);
        await changeOwnPin(device, ownerToken, '482913', '777888');
        const ownerId = (await listTeam(device)).find((m) => m.role === 'dueno').id;
        expect((await loginWithPin(device, ownerId, '777888')).role).toBe('dueno');
        await ownerSetOwnPin(owner, '991122');
        expect((await loginWithPin(device, ownerId, '991122')).role).toBe('dueno');
    });

    it('el panel del dueño (upsert_member) también da error claro con nombre repetido', async () => {
        await upsertMember(owner, { name: 'Pía', role: 'cajero', pin: '1237' });
        const err = toNubeError({ message: 'duplicate key value violates unique constraint "account_members_account_id_display_name_key"' });
        expect(err.message).toMatch(/Ya hay alguien con ese nombre/);
    });
});

describe('Clave del dueño olvidada', () => {
    it('lee el regreso del enlace y lo ignora si no es de recuperación', () => {
        expect(parseRecoveryHash('#access_token=aaa&refresh_token=bbb&type=recovery&expires_in=3600'))
            .toEqual({ accessToken: 'aaa', refreshToken: 'bbb' });
        expect(parseRecoveryHash('#access_token=aaa&refresh_token=bbb&type=signup')).toEqual({ confirmed: true });
        expect(parseRecoveryHash('#foo=bar')).toBeNull();
        expect(parseRecoveryHash('')).toBeNull();
        expect(parseRecoveryHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid'))
            .toEqual({ error: expect.stringMatching(/enlace venció/) });
    });

    it('pide el enlace con la dirección de regreso y valida el correo', async () => {
        const client = { auth: { resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }) } };
        await requestPasswordReset(client, ' dueno@bodega.test ', 'http://localhost:5180/');
        expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('dueno@bodega.test', { redirectTo: 'http://localhost:5180/' });
        await expect(requestPasswordReset(client, 'sin-arroba', 'x')).rejects.toThrow(/correo del dueño/);
        client.auth.resetPasswordForEmail.mockResolvedValue({ error: { message: 'For security purposes, you can only request this after 42 seconds.' } });
        await expect(requestPasswordReset(client, 'dueno@bodega.test', 'x')).rejects.toThrow(/Espera un minuto/);
        client.auth.resetPasswordForEmail.mockResolvedValue({ error: { message: 'Email address "dueno@bodega.test" is invalid' } });
        await expect(requestPasswordReset(client, 'dueno@bodega.test', 'x')).rejects.toThrow(/no puede recibir mensajes/);
    });

    it('registro con regreso a la app, reenvío de confirmación y «correo sin confirmar»', async () => {
        const auth = {
            signUp: vi.fn().mockResolvedValue({ data: { user: { id: 'u' }, session: null }, error: null }),
            resend: vi.fn().mockResolvedValue({ error: null }),
        };
        const res = await ownerSignUp({ auth }, ' dueno@bodega.test ', 'clave-segura-1', { redirectTo: 'http://localhost:5180/' });
        expect(res.needsConfirmation).toBe(true);
        expect(auth.signUp).toHaveBeenCalledWith({ email: 'dueno@bodega.test', password: 'clave-segura-1', options: { emailRedirectTo: 'http://localhost:5180/' } });
        await resendConfirmation({ auth }, 'dueno@bodega.test', 'http://localhost:5180/');
        expect(auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'dueno@bodega.test', options: { emailRedirectTo: 'http://localhost:5180/' } });
        const notConfirmed = toNubeError({ code: 'email_not_confirmed', message: 'Email not confirmed' });
        expect(isEmailNotConfirmed(notConfirmed)).toBe(true);
        expect(notConfirmed.message).toMatch(/Todavía no confirmas tu correo/);
        expect(isEmailNotConfirmed(toNubeError({ message: 'Invalid login credentials' }))).toBe(false);
        expect(toNubeError({ code: 'invalid_credentials', message: 'x' }).message).toBe('Correo o contraseña incorrectos.');
    });

    it('guarda la clave nueva con la sesión del enlace y cierra esa sesión', async () => {
        const auth = {
            setSession: vi.fn().mockResolvedValue({ error: null }),
            updateUser: vi.fn().mockResolvedValue({ error: null }),
            signOut: vi.fn().mockResolvedValue({ error: null }),
        };
        await completePasswordReset({ auth }, { accessToken: 'a', refreshToken: 'r' }, 'nueva-clave-1');
        expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
        expect(auth.updateUser).toHaveBeenCalledWith({ password: 'nueva-clave-1' });
        expect(auth.signOut).toHaveBeenCalled();
        await expect(completePasswordReset({ auth }, { accessToken: 'a', refreshToken: 'r' }, 'corta')).rejects.toThrow(/8 caracteres/);
        auth.setSession.mockResolvedValue({ error: { message: 'Auth session missing!' } });
        await expect(completePasswordReset({ auth }, { accessToken: 'a', refreshToken: 'r' }, 'nueva-clave-2')).rejects.toThrow(/enlace venció/);
    });
});

describe('PIN por empleado (migración 012)', () => {
    it('cuántos dígitos pide la entrada', () => {
        expect(memberPinLength({ pin_length: 4 })).toBe(4);
        expect(memberPinLength({ pin_length: 6 })).toBe(6);
        expect(memberPinLength({ pin_length: null })).toBeNull(); // sin PIN
        expect(memberPinLength({ id: 'x' })).toBe(6); // servidor sin la migración
        expect(pinHint('cajero')).toBe('4 números');
        expect(pinHint('administrador')).toBe('6 números o más');
    });
});
