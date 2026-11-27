import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import {
    isPassportValid,
    readOfflinePassport,
    saveOfflinePassport,
    verifyOfflinePin,
} from '../../src/lan/offlinePassport';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

function makeStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
    };
}

describe('Pasaporte Offline LAN', () => {
    it('emite pasaporte con verificadores de PIN, valida en local y aplica bloqueo tras 5 fallos', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'pasaporte@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega Offline',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const caja = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(caja);
        await svc.registerDevice(owner, { deviceUserId: uid, label: 'Caja B', role: 'caja' });

        // Crear cajero con PIN de 4 dígitos
        const cajeroId = await svc.upsertMember(owner, { name: 'Ana Cajera', role: 'cajero', pin: '2468' });

        const passport = await caja.lan.fetchOfflinePassport();
        expect(passport.device.caja_letter).toBe('A');
        expect(passport.members).toHaveLength(2);
        expect(isPassportValid(passport)).toBe(true);

        const storage = makeStorage();
        saveOfflinePassport(passport, storage);
        const restored = readOfflinePassport(storage);

        const ok = verifyOfflinePin(restored, cajeroId, '2468', { storage });
        expect(ok.valid).toBe(true);
        expect(ok.member.display_name).toBe('Ana Cajera');

        // 5 intentos fallidos activan bloqueo
        for (let i = 0; i < 4; i += 1) {
            const bad = verifyOfflinePin(restored, cajeroId, '0000', { storage });
            expect(bad.valid).toBe(false);
            expect(bad.error).toContain('PIN incorrecto');
        }
        const fifth = verifyOfflinePin(restored, cajeroId, '0000', { storage });
        expect(fifth.valid).toBe(false);
        expect(fifth.error).toContain('Bloqueado');

        // Pasaporte vencido (>72h) no permite entrar
        const expired = { ...restored, expiresAt: new Date(Date.now() - 1000).toISOString() };
        expect(isPassportValid(expired)).toBe(false);
        expect(verifyOfflinePin(expired, cajeroId, '2468', { storage }).valid).toBe(false);
    }, 60_000);

    it('T16 · ALT-07: buildOfflinePassport devuelve pin_length real (null para sin PIN, 8 para admin con PIN de 8 dígitos)', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'pinlen@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega PinLen',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const caja = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(caja);
        await svc.registerDevice(owner, { deviceUserId: uid, label: 'Caja A', role: 'caja' });

        const sinPinId = await svc.upsertMember(owner, { name: 'Cajero Libre', role: 'cajero', sinPin: true });
        const pin8Id = await svc.upsertMember(owner, { name: 'Admin Ocho', role: 'administrador', pin: '12345678' });

        const passport = await caja.lan.fetchOfflinePassport();
        const mSinPin = passport.members.find((m) => m.id === sinPinId);
        const mPin8 = passport.members.find((m) => m.id === pin8Id);
        expect(mSinPin?.pin_length).toBeNull();
        expect(mPin8?.pin_length).toBe(8);
    }, 60_000);

    it('T16 · ALT-09: SSE emite eventos en vivo para account_members y account_devices (revocación inmediata)', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'sse@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega SSE',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const caja = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(caja);
        await svc.registerDevice(owner, { deviceUserId: uid, label: 'Caja A', role: 'caja' });
        const st = await svc.getDeviceStatus(caja, uid);

        const memberEvents = [];
        const deviceEvents = [];
        const ch = caja.channel('t16-sse')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'account_members', filter: `account_id=eq.${st.account.id}` }, (p) => memberEvents.push(p.new))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'account_devices', filter: `account_id=eq.${st.account.id}` }, (p) => deviceEvents.push(p.new));
        await new Promise((resolve) => ch.subscribe((s) => { if (s === 'SUBSCRIBED') resolve(); }));
        cleanups.push(async () => caja.removeChannel(ch));

        await svc.upsertMember(owner, { name: 'Nuevo Cajero', role: 'cajero', pin: '1234' });
        await svc.revokeDevice(owner, st.device.id);

        // Esperar llegada SSE
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && (!memberEvents.length || !deviceEvents.length)) {
            await new Promise((r) => setTimeout(r, 40));
        }

        expect(memberEvents.some((m) => m.display_name === 'Nuevo Cajero')).toBe(true);
        expect(deviceEvents.some((d) => d.id === st.device.id && Boolean(d.revoked_at))).toBe(true);
    }, 60_000);

    it('T16 · MED-13/MED-14: POST /lan/images añade cache-buster ?v= y limpia extensión vieja al reemplazar', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const caja = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ensureDeviceSession(caja);

        // PNG 1x1 válido
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        const jpgData = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

        const url1 = await caja.lan.uploadImage(pngData, 'prod-img-1');
        expect(url1).toMatch(/\/lan\/images\/prod-img-1\.png\?v=\d+$/);

        const url2 = await caja.lan.uploadImage(jpgData, 'prod-img-1');
        expect(url2).toMatch(/\/lan\/images\/prod-img-1\.jpg\?v=\d+$/);

        // La extensión vieja (.png) debe haberse eliminado
        const oldRes = await fetch(`${srv.baseUrl}/lan/images/prod-img-1.png`);
        expect(oldRes.status).toBe(404);
        const newRes = await fetch(url2);
        expect(newRes.status).toBe(200);
    }, 60_000);
});
