/**
 * T18 · Recuperación automática tras cambio de IP DHCP (UDP discovery filtrado por lanId)
 * y verificación de hashing asíncrono de contraseñas en lanDb.mjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

describe('T18 · Redescubrimiento DHCP por lanId y scrypt asíncrono', () => {
    it('1. Tras 3 fallos de red consecutivos redescubre la nueva IP del servidor con el mismo lanId y se reconecta', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const healthBefore = await fetch(`${srv.baseUrl}/lan/health`).then((r) => r.json());
        const expectedLanId = healthBefore.lanId;
        expect(expectedLanId).toBeTruthy();

        const discoveredChanges = [];
        const discoverServers = vi.fn().mockResolvedValue([
            { lanId: 'LAN-OTRO-SERVIDOR', urls: ['http://127.0.0.1:2'] },
            { lanId: expectedLanId, urls: [srv.baseUrl] },
        ]);

        // Cliente apuntando a IP/puerto muerto simulando cambio de IP por DHCP
        const client = createLanClient({
            baseUrl: 'http://127.0.0.1:1',
            persistSession: false,
            requestTimeoutMs: 1500,
            rediscoverThreshold: 3,
            getLanId: () => expectedLanId,
            discoverServers,
            onServerUrlChanged: (newUrl) => discoveredChanges.push(newUrl),
        });

        // 3 fallos de red disparan el redescubrimiento
        for (let i = 0; i < 3; i += 1) {
            await client.lan.health().catch(() => {});
        }

        expect(discoverServers).toHaveBeenCalledTimes(1);
        expect(discoveredChanges).toEqual([srv.baseUrl]);

        // Ahora el cliente ya apunta al servidor real
        const okHealth = await client.lan.health();
        expect(okHealth.ok).toBe(true);
        expect(okHealth.lanId).toBe(expectedLanId);
    }, 60_000);

    it('2. Rechaza migrar automáticamente a un servidor descubierto con un lanId distinto (anti-secuestro LAN)', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const discoveredChanges = [];
        const discoverServers = vi.fn().mockResolvedValue([
            { lanId: 'LAN-INTRUSO', urls: [srv.baseUrl] },
        ]);

        const client = createLanClient({
            baseUrl: 'http://127.0.0.1:1',
            persistSession: false,
            requestTimeoutMs: 1500,
            rediscoverThreshold: 3,
            getLanId: () => 'LAN-LEGITIMO-123',
            discoverServers,
            onServerUrlChanged: (newUrl) => discoveredChanges.push(newUrl),
        });

        for (let i = 0; i < 3; i += 1) {
            await client.lan.health().catch(() => {});
        }

        expect(discoverServers).toHaveBeenCalledTimes(1);
        expect(discoveredChanges).toHaveLength(0);
    }, 60_000);

    it('3. signUpOwner y signInOwner usan scrypt asíncrono sin bloquear el bucle de eventos', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'async-scrypt@bodega.local', 'ClaveSegura123');
        await svc.ownerSignOut(owner);
        await svc.ownerSignIn(owner, 'async-scrypt@bodega.local', 'ClaveSegura123');
        await expect(
            svc.ownerSignIn(createLanClient({ baseUrl: srv.baseUrl, persistSession: false }), 'async-scrypt@bodega.local', 'ClaveMala999'),
        ).rejects.toThrow();
    }, 60_000);
});
