import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient, probeLanServer } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { keepChannel } from '../../src/nube/realtimeChannel';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop();
        await fn().catch(() => {});
    }
});

async function startTestServer(opts = {}) {
    const srv = await createLanServer({
        port: 0,
        host: '127.0.0.1',
        enableDiscovery: false,
        ...opts,
    });
    cleanups.push(() => srv.close());
    return srv;
}

function makeClient(baseUrl) {
    return createLanClient({ baseUrl, persistSession: false });
}

describe('Precios al Día LAN · multicaja sobre servidor local', () => {
    it('registra dueño sin correo, vincula Caja A y Caja B (con código QR) y sincroniza stock/fiados/SSE en vivo', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-lan-test-'));
        cleanups.push(async () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

        const srv = await startTestServer({
            dataDir: path.join(tmpRoot, 'db'),
            imagesDir: path.join(tmpRoot, 'images'),
            backupsDir: path.join(tmpRoot, 'backups'),
        });

        // 1. Health check y versión de protocolo
        const health = await probeLanServer(srv.baseUrl);
        expect(health.ok).toBe(true);
        expect(health.edition).toBe('lan');
        expect(health.hasAccount).toBe(false);

        // 2. Dueño crea cuenta sin confirmación por email + crea negocio
        const owner = makeClient(srv.baseUrl);
        const signup = await svc.ownerSignUp(owner, 'dueno@bodega.local', 'ClaveSegura123');
        expect(signup.needsConfirmation).toBe(false);

        await svc.createAccount(owner, {
            businessName: 'Bodega La Esquina',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const acc = await svc.getOwnerAccount(owner);
        expect(acc?.name).toBe('Bodega La Esquina');

        // 3. Registrar Caja A directamente con sesión del dueño
        const cajaA = makeClient(srv.baseUrl);
        const uidA = await svc.ensureDeviceSession(cajaA);
        await svc.registerDevice(owner, {
            deviceUserId: uidA,
            label: 'Caja Principal',
            role: 'caja',
            sedeId: null,
        });
        await svc.ownerSignOut(owner);

        const stA = await svc.getDeviceStatus(cajaA, uidA);
        expect(stA.device.caja_letter).toBe('A');

        // 4. Generar código de vinculación de 6 dígitos y vincular Caja B sin escribir correo/clave
        const pairing = await cajaA.lan.generatePairingCode(acc.id);
        expect(pairing.code).toMatch(/^\d{6}$/);

        const ownerViaCode = makeClient(srv.baseUrl);
        await ownerViaCode.lan.claimPairingCode(pairing.code);
        // Un código usado no puede volver a usarse
        await expect(makeClient(srv.baseUrl).lan.claimPairingCode(pairing.code)).rejects.toThrow(/utilizado/);

        const cajaB = makeClient(srv.baseUrl);
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(ownerViaCode, {
            deviceUserId: uidB,
            label: 'Caja Pasillo',
            role: 'caja',
            sedeId: stA.device.sede_id,
        });
        await svc.ownerSignOut(ownerViaCode);

        const stB = await svc.getDeviceStatus(cajaB, uidB);
        expect(stB.device.caja_letter).toBe('B');

        // 5. Empleados inician sesión con PIN en Caja A y Caja B
        const members = await svc.listMembers(cajaA);
        const dueno = members.find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '142536');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '142536');

        // 6. Suscribirse por SSE en Caja B para escuchar cambios de stock en vivo
        const liveStockEvents = [];
        let channelUp = false;
        const chB = keepChannel(
            cajaB,
            'test-stock-b',
            (ch) =>
                ch.on(
                    'postgres_changes',
                    { event: '*', schema: 'public', table: 'stock_levels', filter: `sede_id=eq.${stB.device.sede_id}` },
                    (payload) => liveStockEvents.push(payload.new),
                ),
            {
                onUp: () => {
                    channelUp = true;
                },
            },
        );
        cleanups.push(async () => chB.dispose());

        for (let i = 0; i < 30 && !channelUp; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(channelUp).toBe(true);

        // 7. Subir producto + stock inicial desde Caja A
        const pushRes = await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'products',
            p_records: [{ id: 'prod-harina', data: { id: 'prod-harina', name: 'Harina PAN', priceUsd: 1.2 }, base_version: 0 }],
        });
        expect(pushRes.error).toBeNull();

        const initStock = await cajaA.rpc('process_stock_movements', {
            p_session: sessA.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'prod-harina', qty: 20 }],
            p_reference: 'init-1',
        });
        expect(initStock.error).toBeNull();

        // 8. Venta concurrente desde Caja A (-3) y Caja B (-5)
        const saleIdA = randomUUID();
        const saleIdB = randomUUID();
        const [resA, resB] = await Promise.all([
            cajaA.rpc('process_checkout', {
                p_session: sessA.token,
                p_sale: {
                    id: saleIdA,
                    items: [{ product_id: 'prod-harina', qty: 3 }],
                    total_usd: 3.6,
                    total_bs: 144,
                    rate: 40,
                },
                p_offline: false,
                p_allow_negative: false,
            }),
            cajaB.rpc('process_checkout', {
                p_session: sessB.token,
                p_sale: {
                    id: saleIdB,
                    items: [{ product_id: 'prod-harina', qty: 5 }],
                    total_usd: 6.0,
                    total_bs: 240,
                    rate: 40,
                },
                p_offline: false,
                p_allow_negative: false,
            }),
        ]);
        expect(resA.error).toBeNull();
        expect(resB.error).toBeNull();
        expect(resA.data[0].number).toBe('#A-00001');
        expect(resB.data[0].number).toBe('#B-00001');

        // Reintento idempotente (G7): no debe descontar stock otra vez
        const replayB = await cajaB.rpc('process_checkout', {
            p_session: sessB.token,
            p_sale: {
                id: saleIdB,
                items: [{ product_id: 'prod-harina', qty: 5 }],
                total_usd: 6.0,
            },
            p_offline: true,
            p_allow_negative: false,
        });
        expect(replayB.error).toBeNull();
        expect(replayB.data[0].already_registered).toBe(true);

        // Esperar notificación SSE final (20 - 3 - 5 = 12)
        for (let i = 0; i < 30 && !liveStockEvents.some((e) => Number(e.qty) === 12); i += 1) {
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(liveStockEvents.some((e) => e.product_id === 'prod-harina' && Number(e.qty) === 12)).toBe(true);

        // 9. Fiado en Caja A ($10) y Abono en Caja B ($4) -> saldo oficial -$6.00
        await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'customers',
            p_records: [{ id: 'cli-1', data: { id: 'cli-1', name: 'María Pérez' }, base_version: 0 }],
        });
        const movA = await cajaA.rpc('push_customer_movements', {
            p_session: sessA.token,
            p_movements: [{ id: randomUUID(), customer_id: 'cli-1', type: 'VENTA_FIADA', direction: 'DEBIT', amount_usd: 10 }],
        });
        const movB = await cajaB.rpc('push_customer_movements', {
            p_session: sessB.token,
            p_movements: [{ id: randomUUID(), customer_id: 'cli-1', type: 'ABONO_DEUDA', direction: 'CREDIT', amount_usd: 4 }],
        });
        expect(movA.error).toBeNull();
        expect(movB.error).toBeNull();

        const { data: balances } = await cajaA.from('customer_balances').select('customer_id, balance_usd');
        expect(Number(balances[0].balance_usd)).toBe(-6);

        // Select tipo PostgREST con JSON extract (usado por ownerDashboard.js)
        const { data: prodNames } = await cajaB.from('account_records').select('id, name:data->>name').eq('collection', 'products').is('deleted_at', null);
        expect(prodNames).toEqual([{ id: 'prod-harina', name: 'Harina PAN' }]);

        // 10. Imagen local y respaldo
        const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        const imgUrl = await cajaA.lan.uploadImage(png1x1, 'prod-harina');
        expect(imgUrl).toContain('/lan/images/prod-harina.png');
        const imgRes = await fetch(imgUrl);
        expect(imgRes.status).toBe(200);
        expect(imgRes.headers.get('content-type')).toBe('image/png');

        const backupFile = await srv.saveDiskBackupNow();
        expect(fs.existsSync(backupFile)).toBe(true);
        const snap = await cajaA.lan.exportSnapshot();
        expect(snap.tables.sales).toHaveLength(2);
    }, 60_000);

    it('conserva negocio, cajas y stock en disco al reiniciar la Caja Principal', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-lan-persist-'));
        cleanups.push(async () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
        const dataDir = path.join(tmpRoot, 'db');

        const srv1 = await createLanServer({ port: 0, host: '127.0.0.1', dataDir, enableDiscovery: false });
        const owner1 = makeClient(srv1.baseUrl);
        await svc.ownerSignUp(owner1, 'persist@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner1, {
            businessName: 'Abasto Persistente',
            sedeName: 'Única',
            ownerName: 'Ana',
            ownerPin: '246810',
        });
        const caja = makeClient(srv1.baseUrl);
        const uid = await svc.ensureDeviceSession(caja);
        await svc.registerDevice(owner1, { deviceUserId: uid, label: 'Caja 1', role: 'caja' });
        const members = await svc.listMembers(caja);
        const sess = await svc.loginWithPin(caja, members[0].id, '246810');
        await caja.rpc('process_stock_movements', {
            p_session: sess.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'harina', qty: 15 }],
        });
        await srv1.close();

        // Reiniciar servidor sobre el mismo dataDir
        const srv2 = await startTestServer({ dataDir });
        const health2 = await probeLanServer(srv2.baseUrl);
        expect(health2.hasAccount).toBe(true);
        expect(health2.businessName).toBe('Abasto Persistente');

        const caja2 = makeClient(srv2.baseUrl);
        const unauthRes = await caja2.from('stock_levels').select('product_id, qty');
        // Sin sesión de equipo (anon), Postgres niega la lectura
        expect(unauthRes.data).toBeNull();
        expect(unauthRes.error).toBeTruthy();

        // Al iniciar sesión el dueño tras reiniciar el servidor, todo sigue en disco
        const owner2 = makeClient(srv2.baseUrl);
        await svc.ownerSignIn(owner2, 'persist@bodega.local', 'ClaveSegura123');
        const devices2 = await svc.listOwnerDevices(owner2);
        expect(devices2).toHaveLength(1);
        expect(devices2[0].label).toBe('Caja 1');
        const { data: levels2, error: err2 } = await owner2.from('stock_levels').select('product_id, qty');
        expect(err2).toBeNull();
        expect(levels2).toHaveLength(1);
        expect(levels2[0].product_id).toBe('harina');
        expect(Number(levels2[0].qty)).toBe(15);
    }, 60_000);
});
