import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

function signTestLicenseToken(payload, privateKeyPem) {
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(payloadStr, 'utf8');
    sign.end();
    const sigB64 = sign.sign(privateKeyPem, 'base64');
    return `${payloadB64}.${sigB64}`;
}

describe('F-21 Restauración de respaldo y F-22 Licencia RSA Offline', () => {
    it('F-21: exporta respaldo completo del servidor 1 y lo restaura idéntico en servidor 2', async () => {
        const srv1 = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv1.close());

        const owner1 = createLanClient({ baseUrl: srv1.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner1, 'bak@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner1, {
            businessName: 'Abasto Respaldo',
            sedeName: 'Principal',
            ownerName: 'Marta',
            ownerPin: '142536',
        });

        const caja1 = createLanClient({ baseUrl: srv1.baseUrl, persistSession: false });
        const uid1 = await svc.ensureDeviceSession(caja1);
        await svc.registerDevice(owner1, { deviceUserId: uid1, label: 'Caja 1', role: 'caja' });
        const members1 = await svc.listMembers(caja1);
        const sess1 = await svc.loginWithPin(caja1, members1[0].id, '142536');

        await caja1.rpc('push_records_v2', {
            p_session: sess1.token,
            p_collection: 'products',
            p_records: [{ id: 'p-cafe', data: { id: 'p-cafe', name: 'Café 500g', priceUsd: 4.5 }, base_version: 0 }],
        });
        await caja1.rpc('process_stock_movements', {
            p_session: sess1.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'p-cafe', qty: 30 }],
        });
        await caja1.rpc('process_checkout', {
            p_session: sess1.token,
            p_sale: { id: randomUUID(), items: [{ product_id: 'p-cafe', qty: 4 }], total_usd: 18 },
            p_offline: false,
            p_allow_negative: false,
        });

        const snapshot = await owner1.lan.exportSnapshot();
        expect(snapshot.tables.sales).toHaveLength(1);

        // Levantar Servidor 2 completamente vacío y restaurar el snapshot
        const srv2 = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv2.close());

        const restoreRes = await fetch(`${srv2.baseUrl}/lan/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot),
        });
        const restoreJson = await restoreRes.json();
        expect(restoreRes.status).toBe(200);
        expect(restoreJson.ok).toBe(true);
        expect(restoreJson.summary.businessName).toBe('Abasto Respaldo');

        // Dueño entra con su misma clave en el Servidor 2 restaurado y verifica stock exacto (30 - 4 = 26)
        const owner2 = createLanClient({ baseUrl: srv2.baseUrl, persistSession: false });
        await svc.ownerSignIn(owner2, 'bak@bodega.local', 'ClaveSegura123');
        const { data: levels } = await owner2.from('stock_levels').select('product_id, qty');
        expect(Number(levels[0].qty)).toBe(26);
        const { data: sales2 } = await owner2.from('sales').select('number, total_usd');
        expect(sales2).toHaveLength(1);
        expect(sales2[0].number).toBe('#A-00001');
    }, 60_000);

    it('F-22: valida firma RSA de licencia offline para ampliar límite de cajas y rechaza tokens alterados', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubJwk = publicKey.export({ format: 'jwk' });
        const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });

        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const signup = await svc.ownerSignUp(owner, 'lic@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega Multi',
            sedeName: 'Centro',
            ownerName: 'Pedro',
            ownerPin: '142536',
        });

        // Token adulterado (cambiando el payload manteniendo la firma anterior) debe fallar
        const signed = signTestLicenseToken({ maxCajas: 2 }, privPem);
        const [, sigPart] = signed.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ maxCajas: 10 }), 'utf8').toString('base64');
        const fakeToken = `${tamperedPayload}.${sigPart}`;
        await expect(srv.lanDb.applyOfflineLicenseToken(signup.user, fakeToken, pubJwk)).rejects.toThrow();

        // Token válido firmado con la clave privada amplía a 5 cajas
        const goodToken = signTestLicenseToken(
            {
                product: 'lan',
                status: 'active',
                maxCajas: 5,
                maxSedes: 2,
                expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            },
            privPem,
        );
        const updated = await srv.lanDb.applyOfflineLicenseToken(signup.user, goodToken, pubJwk);
        expect(updated.max_cajas).toBe(5);
        expect(updated.status).toBe('active');

        // Ahora permite registrar 3 cajas sin error de límite
        for (const label of ['Caja 1', 'Caja 2', 'Caja 3']) {
            const dev = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
            const uid = await svc.ensureDeviceSession(dev);
            await svc.registerDevice(owner, { deviceUserId: uid, label, role: 'caja' });
        }
        const devices = await svc.listOwnerDevices(owner);
        expect(devices).toHaveLength(3);
    }, 60_000);
});
