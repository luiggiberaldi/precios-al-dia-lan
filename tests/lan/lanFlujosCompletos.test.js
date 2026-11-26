import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer, discoverLanServers } from '../../desktop/server/lanServer.mjs';
import { createLanClient, probeLanServer } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createSaleSubmitter } from '../../src/nube/stockService';
import { keepChannel } from '../../src/nube/realtimeChannel';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop();
        await fn().catch(() => {});
    }
});

function makeMemStore() {
    const map = new Map();
    return {
        async getItem(k) { return map.has(k) ? map.get(k) : null; },
        async setItem(k, v) { map.set(k, v); },
    };
}

async function startServer(opts = {}) {
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

async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 40));
    }
    return false;
}

async function setupBusinessWithTwoBoxes(srv) {
    const owner = makeClient(srv.baseUrl);
    await svc.ownerSignUp(owner, 'dueno@flujo.local', 'ClaveSegura123');
    await svc.createAccount(owner, {
        businessName: 'Bodega Flujos',
        sedeName: 'Centro',
        ownerName: 'Luigi',
        ownerPin: '142536',
    });
    const account = await svc.getOwnerAccount(owner);

    const cajaA = makeClient(srv.baseUrl);
    const uidA = await svc.ensureDeviceSession(cajaA);
    await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja A', role: 'caja' });
    const stA = await svc.getDeviceStatus(cajaA, uidA);

    const cajaB = makeClient(srv.baseUrl);
    const uidB = await svc.ensureDeviceSession(cajaB);
    await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja', sedeId: stA.device.sede_id });
    const stB = await svc.getDeviceStatus(cajaB, uidB);

    const members = await svc.listMembers(cajaA);
    const dueno = members.find((m) => m.role === 'dueno');
    const sessA = await svc.loginWithPin(cajaA, dueno.id, '142536');
    const sessB = await svc.loginWithPin(cajaB, dueno.id, '142536');

    return { owner, account, cajaA, cajaB, stA, stB, dueno, sessA, sessB };
}

describe('Flujos completos LAN (F-01 a F-17)', () => {
    it('F-01/F-02/F-03: health, descubrimiento UDP en red y bloqueo a no autenticados', async () => {
        const srv = await startServer({ enableDiscovery: true, discoveryPort: 47899 });

        const health = await probeLanServer(srv.baseUrl);
        expect(health.ok).toBe(true);
        expect(health.protocolVersion).toBe(1);
        await expect(probeLanServer('http://127.0.0.1:1')).rejects.toThrow();

        const discovered = await discoverLanServers({ timeoutMs: 800, discoveryPort: 47899 });
        expect(discovered.some((d) => Number(d.port || new URL(d.url).port) === srv.port)).toBe(true);

        const anon = makeClient(srv.baseUrl);
        const qRes = await anon.from('accounts').select('id, name');
        expect(qRes.data).toBeNull();
        expect(qRes.error).toBeTruthy();

        const rpcRes = await anon.rpc('create_account', {
            p_name: 'Intruso',
            p_sede_name: 'X',
            p_owner_name: 'Y',
            p_owner_pin: '142536',
        });
        expect(rpcRes.error).toBeTruthy();
    }, 60_000);

    it('F-04/F-05/F-06/F-07: dueño, límite de licencia, códigos, equipo y expulsión de caja', async () => {
        const srv = await startServer();
        const { owner, account, cajaA, cajaB, stA, stB, sessA } = await setupBusinessWithTwoBoxes(srv);

        // F-04: cambio de contraseña del dueño y reingreso
        await owner.auth.updateUser({ password: 'NuevaClave456' });
        await svc.ownerSignOut(owner);
        await expect(svc.ownerSignIn(owner, 'dueno@flujo.local', 'ClaveSegura123')).rejects.toThrow();
        await svc.ownerSignIn(owner, 'dueno@flujo.local', 'NuevaClave456');

        // F-05: licencia de prueba permite máximo 2 cajas, pero sí permite equipo de consulta
        const cajaC = makeClient(srv.baseUrl);
        const uidC = await svc.ensureDeviceSession(cajaC);
        await expect(svc.registerDevice(owner, { deviceUserId: uidC, label: 'Caja C', role: 'caja' })).rejects.toThrow(/límite|caja/i);
        await svc.registerDevice(owner, { deviceUserId: uidC, label: 'Teléfono Dueño', role: 'consulta' });
        const stC = await svc.getDeviceStatus(cajaC, uidC);
        expect(stC.device.role).toBe('consulta');

        // F-06: formato de código inválido rechazado
        await expect(cajaC.lan.claimPairingCode('abc')).rejects.toThrow(/6 dígitos/);
        await expect(cajaC.lan.claimPairingCode('999999')).rejects.toThrow(/no encontrado/);

        // F-07: crear cajero, cambiar PIN y expulsar Caja B
        const cajeroId = await svc.teamUpsertMember(cajaA, sessA.token, {
            name: 'Pedro Cajero',
            role: 'cajero',
            pin: '2580',
        });
        const pedroSess = await svc.loginWithPin(cajaB, cajeroId, '2580');
        expect(pedroSess.role).toBe('cajero');

        // Expulsar Caja B: desaparece de getDeviceStatus y ya no puede vender
        await svc.teamRevokeDevice(cajaA, sessA.token, stB.device.id);
        const stBAfter = await svc.getDeviceStatus(cajaB, stB.device.auth_user_id);
        expect(stBAfter).toBeNull();
        const sellAfterRevoke = await cajaB.rpc('process_checkout', {
            p_session: pedroSess.token,
            p_sale: { id: randomUUID(), items: [{ product_id: 'p1', qty: 1 }], total_usd: 1 },
            p_offline: false,
            p_allow_negative: true,
        });
        expect(sellAfterRevoke.error).toBeTruthy();

        expect(account.id).toBeTruthy();
        expect(stA.device.caja_letter).toBe('A');
    }, 60_000);

    it('F-08/F-09/F-10/F-11: fusión por campo S2, rechazo sin stock, SSE y anulación', async () => {
        const srv = await startServer();
        const { cajaA, cajaB, stB, sessA, sessB } = await setupBusinessWithTwoBoxes(srv);

        const sseEvents = [];
        let subOk = false;
        const ch = keepChannel(
            cajaB,
            'flujos-sse',
            (c) =>
                c
                    .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels', filter: `sede_id=eq.${stB.device.sede_id}` }, (p) => sseEvents.push({ table: 'stock', row: p.new }))
                    .on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state' }, (p) => sseEvents.push({ table: 'sync', row: p.new })),
            { onUp: () => { subOk = true; } },
        );
        cleanups.push(async () => ch.dispose());
        expect(await waitFor(() => subOk)).toBe(true);

        // F-08: crear v1 y luego fusionar ediciones simultáneas (Caja A cambia name, Caja B cambia priceUsd)
        await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'products',
            p_records: [{ id: 'p-arroz', data: { id: 'p-arroz', name: 'Arroz', priceUsd: 1.0 }, base_version: 0 }],
        });
        const upA = await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'products',
            p_records: [{ id: 'p-arroz', data: { id: 'p-arroz', name: 'Arroz Mary', priceUsd: 1.0 }, base_version: 1 }],
        });
        expect(upA.data[0].version).toBe(2);

        const upB = await cajaB.rpc('push_records_v2', {
            p_session: sessB.token,
            p_collection: 'products',
            p_records: [{ id: 'p-arroz', data: { id: 'p-arroz', name: 'Arroz', priceUsd: 1.45 }, base_version: 1 }],
        });
        expect(upB.data[0].merged).toBe(true);
        expect(upB.data[0].data.name).toBe('Arroz Mary');
        expect(upB.data[0].data.priceUsd).toBe(1.45);

        // F-09: stock inicial = 4, venta de 6 rechazada con allowNegative=false
        await cajaA.rpc('process_stock_movements', {
            p_session: sessA.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'p-arroz', qty: 4 }],
        });
        const overSell = await cajaA.rpc('process_checkout', {
            p_session: sessA.token,
            p_sale: { id: randomUUID(), items: [{ product_id: 'p-arroz', qty: 6 }], total_usd: 8.7 },
            p_offline: false,
            p_allow_negative: false,
        });
        expect(overSell.error).toBeTruthy();

        // Venta válida de 3 -> queda 1, luego F-11 anulación -> vuelve a 4 y SSE lo avisa
        const saleId = randomUUID();
        const okSell = await cajaA.rpc('process_checkout', {
            p_session: sessA.token,
            p_sale: { id: saleId, items: [{ product_id: 'p-arroz', qty: 3 }], total_usd: 4.35 },
            p_offline: false,
            p_allow_negative: false,
        });
        expect(okSell.error).toBeNull();
        expect(await waitFor(() => sseEvents.some((e) => e.table === 'stock' && Number(e.row.qty) === 1))).toBe(true);

        const voidRes = await cajaA.rpc('process_void', {
            p_session: sessA.token,
            p_sale_id: saleId,
            p_reason: 'Error de cajero',
        });
        expect(voidRes.error).toBeNull();
        expect(await waitFor(() => sseEvents.some((e) => e.table === 'stock' && Number(e.row.qty) === 4))).toBe(true);
    }, 60_000);

    it('F-12/F-13/F-14: protección borrado S4, tasa compartida, turnos por caja y resumen del día', async () => {
        const srv = await startServer();
        const { cajaA, cajaB, stA, stB, sessA, sessB } = await setupBusinessWithTwoBoxes(srv);

        const cajeroId = await svc.teamUpsertMember(cajaA, sessA.token, {
            name: 'Cajero Tasa',
            role: 'cajero',
            pin: '1357',
        });
        const cajeroSess = await svc.loginWithPin(cajaB, cajeroId, '1357');

        // F-12: crear cliente y verificar que el cajero NO puede borrarlo (S4)
        await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'customers',
            p_records: [{ id: 'cli-s4', data: { id: 'cli-s4', name: 'Cliente Protegido' }, base_version: 0 }],
        });
        const delTry = await cajaB.rpc('push_records_v2', {
            p_session: cajeroSess.token,
            p_collection: 'customers',
            p_records: [{ id: 'cli-s4', data: { id: 'cli-s4', name: 'Cliente Protegido' }, deleted: true, base_version: 1 }],
        });
        expect(delTry.data[0].rejected).toBe(true);

        // F-13: tasa compartida — dueño cambia `settings`, cajero es rechazado
        const rateOk = await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'settings',
            p_records: [{ id: 'pdn_rate_v1', data: { value: { rateMode: 'manual', customRate: '42.50' } }, base_version: 0 }],
        });
        expect(rateOk.error).toBeNull();
        const rateCajero = await cajaB.rpc('push_records_v2', {
            p_session: cajeroSess.token,
            p_collection: 'settings',
            p_records: [{ id: 'pdn_rate_v1', data: { value: { rateMode: 'manual', customRate: '10' } }, base_version: 1 }],
        });
        expect(rateCajero.error).toBeTruthy();

        const { data: settingsRows } = await cajaB.from('account_records').select('id, data').eq('collection', 'settings');
        expect(settingsRows[0].data.value.customRate).toBe('42.50');

        // F-14: ventas y turnos independientes por caja + resumen consolidado del día
        const saleA = randomUUID();
        const saleB = randomUUID();
        await cajaA.rpc('process_checkout', {
            p_session: sessA.token,
            p_sale: { id: saleA, items: [{ product_id: 'libre', qty: 1 }], total_usd: 12 },
            p_offline: false,
            p_allow_negative: true,
        });
        await cajaB.rpc('process_checkout', {
            p_session: sessB.token,
            p_sale: { id: saleB, items: [{ product_id: 'libre', qty: 1 }], total_usd: 8 },
            p_offline: false,
            p_allow_negative: true,
        });

        const cashA = await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'cash',
            p_records: [{ id: `${saleA}@${stA.device.id}`, data: { id: saleA, tipo: 'VENTA', totalUsd: 12, timestamp: new Date().toISOString() }, base_version: 0 }],
        });
        expect(cashA.error).toBeNull();
        const cashB = await cajaB.rpc('push_records_v2', {
            p_session: sessB.token,
            p_collection: 'cash',
            p_records: [{ id: `${saleB}@${stB.device.id}`, data: { id: saleB, tipo: 'VENTA', totalUsd: 8, timestamp: new Date().toISOString() }, base_version: 0 }],
        });
        expect(cashB.error).toBeNull();

        // Caja B no puede pisar registro de caja de A
        const hijack = await cajaB.rpc('push_records_v2', {
            p_session: sessB.token,
            p_collection: 'cash',
            p_records: [{ id: `${saleA}@${stA.device.id}`, data: { id: saleA, tipo: 'VENTA', totalUsd: 999 }, base_version: 1 }],
        });
        expect(hijack.error).toBeTruthy();

        const daySummary = await cajaA.rpc('cash_day_summary', {});
        expect(daySummary.error).toBeNull();
        expect(daySummary.data).toHaveLength(2);
        const totalUsd = daySummary.data.reduce((s, r) => s + Number(r.ventas_usd || 0), 0);
        expect(totalUsd).toBe(20);
    }, 60_000);

    it('F-15: corte temporal de red LAN encola venta y al reconectar registra discrepancia por sobreventa', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-lan-offline-'));
        cleanups.push(async () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
        const dataDir = path.join(tmpRoot, 'db');

        let srv = await createLanServer({ port: 0, host: '127.0.0.1', dataDir, enableDiscovery: false });
        const { cajaA, cajaB, sessA, sessB } = await setupBusinessWithTwoBoxes(srv);

        await cajaA.rpc('process_stock_movements', {
            p_session: sessA.token,
            p_reason: 'INICIAL',
            p_movements: [{ id: randomUUID(), product_id: 'harina', qty: 2 }],
        });
        // Caja A vende los 2 disponibles
        await cajaA.rpc('process_checkout', {
            p_session: sessA.token,
            p_sale: { id: randomUUID(), items: [{ product_id: 'harina', qty: 2 }], total_usd: 2.4 },
            p_offline: false,
            p_allow_negative: false,
        });

        // Simular caída de la Caja Principal mientras Caja B intenta vender 1
        const port = srv.port;
        await srv.close();

        const storeB = makeMemStore();
        let activeUrl = `http://127.0.0.1:${port}`;
        const cajaBReconnect = createLanClient({
            getBaseUrl: () => activeUrl,
            storageKey: 'caja-b-reconnect',
            persistSession: false,
        });
        // Reutilizar sesión del dispositivo B copiando el token ya autenticado
        const submitter = createSaleSubmitter({
            client: cajaB,
            getSession: () => sessB.token,
            store: storeB,
            allowNegative: () => false,
        });

        const queuedRes = await submitter.submit({
            id: randomUUID(),
            items: [{ product_id: 'harina', qty: 1 }],
            total_usd: 1.2,
            device_at: new Date().toISOString(),
        });
        expect(queuedRes).toEqual({ ok: true, queued: true });
        expect(await submitter.pending()).toBe(1);

        // Levantar de nuevo el servidor en el mismo puerto y datos, y hacer replay
        srv = await startServer({ port, dataDir });
        activeUrl = srv.baseUrl;
        void cajaBReconnect;

        const replayRes = await submitter.replay();
        expect(replayRes).toHaveLength(1);
        expect(replayRes[0].number).toBe('#B-00001');
        expect(await submitter.pending()).toBe(0);

        // Verificar que la sobreventa sin conexión generó una discrepancia para el dueño
        const { data: disc } = await cajaA.from('stock_discrepancies').select('product_id, expected_qty, sold_qty');
        expect(disc).toHaveLength(1);
        expect(disc[0].product_id).toBe('harina');
        expect(Number(disc[0].sold_qty)).toBe(1);
    }, 60_000);
});
