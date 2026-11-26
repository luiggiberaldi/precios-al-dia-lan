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
});
