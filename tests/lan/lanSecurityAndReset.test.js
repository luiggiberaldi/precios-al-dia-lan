// @vitest-environment jsdom
//
// T15 · Seguridad LAN (CORS restringido, auth en rutas admin localhost, path traversal staticDir)
// y reset_account por PIN para dueño local LAN (C21, MED-09).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { DEFAULT_LAN_MASTER_KEY } from '../../desktop/server/lanDb.mjs';
import { createLanClient } from '../../src/lan/lanClient.js';
import * as svc from '../../src/nube/accountService.js';
import { ownerPinResetAccount } from '../../src/nube/accountReset.js';

const cleanups = [];
afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

describe('T15 · Seguridad LAN (CORS, auth localhost, path traversal) y reset por PIN', () => {
    it('1. C21 CORS: rechaza Origin externo malicioso y permite orígenes locales / RFC1918', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const evil = await fetch(`${srv.baseUrl}/lan/health`, {
            headers: { Origin: 'https://sitio-malicioso.com' },
        });
        expect(evil.headers.get('access-control-allow-origin')).toBeNull();

        const local = await fetch(`${srv.baseUrl}/lan/health`, {
            headers: { Origin: 'http://192.168.1.25:47800' },
        });
        expect(local.headers.get('access-control-allow-origin')).toBe('http://192.168.1.25:47800');
    }, 60_000);

    it('2. C21 rutas admin en localhost exigen sesión de dueño o X-PDN-Local-Secret', async () => {
        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            localAdminSecret: 'secreto-desktop-test-123',
        });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'sec@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Seguro',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '142536',
        });

        // Sin sesión y sin X-PDN-Local-Secret -> 401/403
        const resetNoAuth = await fetch(`${srv.baseUrl}/lan/auth/local-reset-pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '999999' }),
        });
        expect([401, 403]).toContain(resetNoAuth.status);

        const snapNoAuth = await fetch(`${srv.baseUrl}/lan/backup/snapshot`);
        expect([401, 403]).toContain(snapNoAuth.status);

        const bridgeNoAuth = await fetch(`${srv.baseUrl}/lan/bridge/status`);
        expect([401, 403]).toContain(bridgeNoAuth.status);

        // Con X-PDN-Local-Secret válido -> 200
        const snapWithSecret = await fetch(`${srv.baseUrl}/lan/backup/snapshot`, {
            headers: { 'X-PDN-Local-Secret': 'secreto-desktop-test-123' },
        });
        expect(snapWithSecret.status).toBe(200);

        // Con sesión de dueño -> 200
        const snapWithOwner = await owner.lan.exportSnapshot();
        expect(snapWithOwner.format).toBe('preciosaldia-lan-snapshot-v1');
    }, 60_000);

    it('3. MED-09 staticDir bloquea path traversal a directorio hermano con prefijo común (dist-web vs dist-web2)', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-t15-'));
        const dirA = path.join(tmp, 'dist-web');
        const dirB = path.join(tmp, 'dist-web2');
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });
        fs.writeFileSync(path.join(dirA, 'index.html'), '<html>OK</html>');
        fs.writeFileSync(path.join(dirB, 'secret.txt'), 'TOP_SECRET');
        cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));

        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            staticDir: dirA,
            enableDiscovery: false,
        });
        cleanups.push(() => srv.close());

        // Usar http.request con objeto { hostname, port, path } para evitar que URL() normalice `/../`
        const http = await import('node:http');
        const sendRawPath = (rawPath) => new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: rawPath, method: 'GET' }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('error', reject);
            req.end();
        });
        const r1 = await sendRawPath('/../dist-web2/secret.txt');
        expect(r1.body).not.toContain('TOP_SECRET');
        expect([403, 404]).toContain(r1.status);

        const r2 = await sendRawPath('/%2e%2e/dist-web2/secret.txt');
        expect(r2.body).not.toContain('TOP_SECRET');
        expect([403, 404]).toContain(r2.status);
    }, 60_000);

    it('4. C21 ownerPinResetAccount permite al dueño LAN local reiniciar la cuenta usando su PIN de dueño', async () => {
        expect(typeof ownerPinResetAccount).toBe('function');
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const ownerBootstrap = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await ownerBootstrap.lan.bootstrapLocalOwner();
        await svc.createAccount(ownerBootstrap, {
            businessName: 'Abasto Local',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '246810',
        });

        const device = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(device);
        await svc.registerDevice(ownerBootstrap, { deviceUserId: uid, label: 'Caja 1', role: 'caja' });

        const makeMemoryStore = () => {
            const m = new Map();
            return {
                keys: async () => [...m.keys()],
                getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
                setItem: async (k, v) => { m.set(k, structuredClone(v)); },
                removeItem: async (k) => { m.delete(k); },
                clear: async () => { m.clear(); },
            };
        };

        const ownerTemp = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const result = await ownerPinResetAccount({
            deviceClient: device,
            ownerClient: ownerTemp,
            pin: '246810',
            stores: {
                appStore: makeMemoryStore(),
                shadowStore: makeMemoryStore(),
                syncStore: makeMemoryStore(),
                storage: localStorage,
            },
        });
        expect(result.local.reset).toBe(true);
        expect(result.local.epoch).toBe(1);
    }, 60_000);

    it('5. Clave Maestra LAN: bloquea reseteo físico sin Clave Maestra, permite inicio directo, personalización, respaldo y rate-limit', async () => {
        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            localAdminSecret: 'secreto-fisico-caja-principal',
        });
        cleanups.push(() => srv.close());

        const ownerBootstrap = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await ownerBootstrap.lan.bootstrapLocalOwner();
        await svc.createAccount(ownerBootstrap, {
            businessName: 'Bodega Clave Maestra',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '135790',
        });

        const device = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(device);
        await svc.registerDevice(ownerBootstrap, { deviceUserId: uid, label: 'Caja 1', role: 'caja' });
        await svc.upsertMember(ownerBootstrap, { name: 'Cajero Prueba', role: 'cajero', pin: '1234', active: true });

        // 1) Incluso sentado en la Caja Principal (con X-PDN-Local-Secret), NO permite resetear PIN sin Clave Maestra
        const resetWithoutMaster = await fetch(`${srv.baseUrl}/lan/auth/local-reset-pin`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PDN-Local-Secret': 'secreto-fisico-caja-principal',
            },
            body: JSON.stringify({ pin: '998877' }),
        });
        expect(resetWithoutMaster.status).toBe(401);

        // 2) Un cajero NO puede configurar/cambiar la Clave Maestra
        const members = await svc.listMembers(device);
        const cajero = members.find((m) => m.role === 'cajero');
        const cajeroSes = await svc.loginWithPin(device, cajero.id, '1234');
        await expect(
            device.lan.setMasterKey({ newMasterKey: 'IntentoCajero99', memberSessionToken: cajeroSes.token }),
        ).rejects.toThrow(/Solo el dueño/);

        // 3) Inicio directo del dueño con Clave Maestra inicial (sin cambiar su PIN) abre sesión real de miembro dueño
        const directLogin = await device.lan.loginWithMasterKey({ masterKey: DEFAULT_LAN_MASTER_KEY });
        expect(directLogin.memberSession?.role).toBe('dueno');
        expect(directLogin.memberSession?.token).toBeTruthy();
        const checked = await svc.checkMemberSession(device, directLogin.memberSession.token);
        expect(checked?.role).toBe('dueno');

        // 4) El dueño configura su propia Clave Maestra personalizada -> la inicial deja de servir
        const statusBefore = await device.lan.getMasterKeyStatus();
        expect(statusBefore.isCustom).toBe(false);

        await device.lan.setMasterKey({
            newMasterKey: 'MiClaveSecreta2026',
            memberSessionToken: directLogin.memberSession.token,
        });
        const statusAfter = await device.lan.getMasterKeyStatus();
        expect(statusAfter.isCustom).toBe(true);

        await expect(
            device.lan.loginWithMasterKey({ masterKey: DEFAULT_LAN_MASTER_KEY }),
        ).rejects.toThrow(/Clave Maestra incorrecta/);

        // 5) Con la Clave Maestra personalizada puede cambiar su PIN y entrar
        const resetOk = await device.lan.loginWithMasterKey({
            masterKey: 'MiClaveSecreta2026',
            newPin: '654987',
        });
        expect(resetOk.pinChanged).toBe(true);
        const dueno = members.find((m) => m.role === 'dueno');
        const pinLogin = await svc.loginWithPin(device, dueno.id, '654987');
        expect(pinLogin.role).toBe('dueno');

        // 6) Respaldo exportado conserva la Clave Maestra personalizada
        const ownerClient = createLanClient({
            baseUrl: srv.baseUrl,
            persistSession: false,
            localAdminSecret: 'secreto-fisico-caja-principal',
        });
        const snapshot = await ownerClient.lan.exportSnapshot();
        expect(snapshot.ownerMasterKey?.custom).toBe(true);

        // 7) Rate-limit tras 5 intentos fallidos bloquea temporalmente con 429
        for (let i = 0; i < 5; i += 1) {
            await expect(
                device.lan.loginWithMasterKey({ masterKey: `ClaveMala-${i}` }),
            ).rejects.toThrow(/Clave Maestra incorrecta/);
        }
        await expect(
            device.lan.loginWithMasterKey({ masterKey: 'MiClaveSecreta2026' }),
        ).rejects.toThrow(/Demasiados intentos/);
    }, 60_000);
});
