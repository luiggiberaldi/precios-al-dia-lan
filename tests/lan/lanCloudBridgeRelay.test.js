/**
 * Prueba completa del flujo Puente Internet ↔ Caja Principal ↔ Cajas LAN del local:
 *   1. Caja Principal (Windows) enciende servidor LAN y activa el puente en la nube
 *   2. Supervisor entra desde Android/iOS/PC fuera del local vía `createCloudSupervisorClient`
 *   3. Crea producto con stock inicial y cambia tasa remotamente
 *   4. Caja Principal aplica los cambios en Postgres LAN y dispara SSE a Caja A
 *   5. Caja A vende y fía; Supervisor remoto anula la venta y registra abono de deuda
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createCloudSupervisorClient } from '../../src/lan/cloudSupervisorClient';
import { createCloudBridge } from '../../desktop/server/cloudBridge.mjs';
import { safeUuid } from '../../src/utils/safeUuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.resolve(__dirname, '../../supabase/lan/001_puente_supervisor.sql');

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop();
        await fn().catch(() => {});
    }
});

async function createMockSupabaseRelay() {
    const cloudDb = new PGlite({ extensions: { pgcrypto } });
    await cloudDb.exec(`
        do $$ begin
            if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        end $$;
        grant usage on schema public to anon, authenticated;
    `);
    await cloudDb.exec(fs.readFileSync(SQL_PATH, 'utf8'));

    async function callRpc(fn, args = {}) {
        const entries = Object.entries(args).filter(([, v]) => v !== undefined);
        const placeholders = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
        const values = entries.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
        const sql = `select * from public.${fn}(${placeholders})`;
        const rows = await cloudDb.transaction(async (tx) => {
            await tx.exec('set local role anon;');
            return (await tx.query(sql, values)).rows;
        });
        if (rows.length === 1 && Object.keys(rows[0]).length === 1 && fn in rows[0]) {
            return rows[0][fn];
        }
        return rows;
    }

    return {
        cloudDb,
        callRpc,
        close: () => cloudDb.close(),
    };
}

describe('Puente de Internet para Modo Supervisor (end-to-end)', () => {
    it('sincroniza snapshots y ejecuta comandos remotos en Caja Principal + SSE en Caja A', async () => {
        const relay = await createMockSupabaseRelay();
        cleanups.push(() => relay.close());

        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            cloudUrl: 'https://relay-simulado.supabase.co',
            cloudAnonKey: 'anon-simulado',
            cloudPollMs: 60_000,
            cloudRpcCaller: (fn, args) => relay.callRpc(fn, args),
        });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'puente@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Puente',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '753951',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaUid = await svc.ensureDeviceSession(cajaA);
        await svc.registerDevice(owner, { deviceUserId: cajaUid, label: 'Caja A', role: 'caja' });
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const cajaSession = await svc.loginWithPin(cajaA, dueno.id, '753951');

        // Subir un cliente desde Caja A
        await cajaA.rpc('push_records_v2', {
            p_session: cajaSession.token,
            p_collection: 'customers',
            p_records: [{ id: 'cli-remoto', data: { id: 'cli-remoto', name: 'María Gómez' } }],
        });

        // Escuchar eventos SSE en Caja A
        const sseReceived = [];
        const ch = cajaA
            .channel('caja-a-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state' }, (ev) => sseReceived.push(ev))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels' }, (ev) => sseReceived.push(ev))
            .subscribe();
        cleanups.push(() => cajaA.removeChannel(ch));
        await new Promise((r) => setTimeout(r, 150));

        // 1. Dueño activa el puente en la Caja Principal
        const setupRes = await owner.lan.setupBridge({
            cloudUrl: 'https://relay-simulado.supabase.co',
            cloudAnonKey: 'anon-simulado',
            ownerPin: '753951',
        });
        expect(setupRes.status.enabled).toBe(true);
        const code = setupRes.status.supervisorCode;
        expect(code).toMatch(/^SUP-\d{6}$/);

        // Confirmar que getBridgeStatus nunca expone masterSecret
        const pubStatus = await owner.lan.getBridgeStatus();
        expect(pubStatus.masterSecret).toBeUndefined();
        expect(pubStatus.supervisorCode).toBe(code);

        // 2. Dueño se conecta desde su teléfono Android/iOS por internet
        const mobileSup = createCloudSupervisorClient({
            url: 'https://relay-simulado.supabase.co',
            key: 'anon-simulado',
            rpcCaller: (fn, args) => relay.callRpc(fn, args),
        });
        const supSess = await mobileSup.login(code, '753951');
        expect(supSess.accountName).toBe('Abasto Puente');

        // 3. Supervisor crea producto (con stock 10) y cambia tasa desde el teléfono
        await mobileSup.loaders.saveSupervisorProduct(mobileSup.client, supSess.token, {
            name: 'Café Molido 500g',
            priceUsd: '4.25',
            costUsd: '3.00',
            initialStock: '10',
        });
        await mobileSup.loaders.updateSupervisorRate(mobileSup.client, supSess.token, {
            rateMode: 'manual',
            customRate: '102.50',
        });

        // 4. Caja Principal sincroniza puente → aplica cambios en LAN y avisa a Caja A por SSE
        const cycle1 = await owner.lan.syncBridgeNow();
        expect(cycle1.processed).toBe(2);
        await new Promise((r) => setTimeout(r, 150));

        expect(sseReceived.some((e) => e.table === 'account_sync_state')).toBe(true);
        expect(sseReceived.some((e) => e.table === 'stock_levels')).toBe(true);

        const supProducts = await mobileSup.loaders.loadSupervisorProducts();
        expect(supProducts.products).toHaveLength(1);
        const cafe = supProducts.products[0];
        expect(cafe.name).toBe('Café Molido 500g');
        expect(cafe.totalStock).toBe(10);

        const supRate = await mobileSup.loaders.loadCurrentRate();
        expect(supRate.rateMode).toBe('manual');
        expect(supRate.customRate).toBe('102.50');

        // 5. Caja A vende 3 unidades de café y fía $8 a María Gómez
        const saleId = safeUuid();
        await cajaA.rpc('process_checkout', {
            p_session: cajaSession.token,
            p_sale: {
                id: saleId,
                items: [{ product_id: cafe.id, qty: 3 }],
                total_usd: 12.75,
                total_bs: 1306.88,
                rate: 102.5,
                device_at: new Date().toISOString(),
            },
        });
        await cajaA.rpc('push_customer_movements', {
            p_session: cajaSession.token,
            p_movements: [{
                id: safeUuid(),
                customer_id: 'cli-remoto',
                type: 'VENTA_FIADA',
                direction: 'DEBIT',
                amount_usd: 8,
                device_at: new Date().toISOString(),
            }],
        });

        // Subir snapshot actualizado hacia la nube
        await owner.lan.syncBridgeNow();
        const remoteSales = await mobileSup.loaders.loadRecentSales();
        expect(remoteSales.some((s) => s.id === saleId && s.status === 'completada')).toBe(true);

        // 6. Supervisor anula la venta y registra un abono de $5 desde su móvil
        await mobileSup.loaders.voidSupervisorSale(mobileSup.client, supSess.token, {
            saleId,
            reason: 'Cliente devolvió producto',
        });
        await mobileSup.loaders.recordSupervisorCustomerPayment(mobileSup.client, supSess.token, {
            customerId: 'cli-remoto',
            amountUsd: '5',
            note: 'Zelle verificado',
        });

        const cycle2 = await owner.lan.syncBridgeNow();
        expect(cycle2.processed).toBe(2);

        // Verificar impacto real en Caja A (LAN) y en Supervisor remoto
        const { data: localStock } = await cajaA.from('stock_levels').select('qty').eq('product_id', cafe.id);
        expect(Number(localStock[0].qty)).toBe(10);

        const { data: localBal } = await cajaA.from('customer_balances').select('balance_usd').eq('customer_id', 'cli-remoto');
        expect(Number(localBal[0].balance_usd)).toBe(-3);

        const supCust = await mobileSup.loaders.loadCustomers();
        expect(supCust.find((c) => c.id === 'cli-remoto')?.balance).toBe(-3);
    }, 60_000);

    it('T17 · ALT-10/MED-15: setupBridge no deja enabled=true si falla; ack fallido no marca comando aplicado como failed y reintenta; snapshot respeta snapshotDirty', async () => {
        const calls = [];
        let failRegister = true;
        let failFirstAck = true;
        let executedCount = 0;
        const fakeLanDb = {
            getMeta: async () => null,
            setMeta: async () => ({}),
            buildSupervisorSnapshot: async () => ({ accountId: 'acc-1', accountName: 'Test', sales: [] }),
            executeSupervisorCommand: async () => {
                executedCount += 1;
                return { data: { ok: true }, events: [] };
            },
        };
        const bridge = createCloudBridge({
            lanDb: fakeLanDb,
            pollIntervalMs: 60_000,
            heartbeatMs: 60_000,
            rpcCaller: async (fn, args) => {
                calls.push({ fn, args });
                if (fn === 'lan_bridge_register') {
                    if (failRegister) throw new Error('sin internet');
                    return [{ account_id: 'acc-1', supervisor_code: args.p_supervisor_code }];
                }
                if (fn === 'lan_bridge_claim_commands') {
                    return executedCount === 0 ? [{ id: 'cmd-1', action: 'refresh_snapshot', payload: {} }] : [];
                }
                if (fn === 'lan_bridge_ack_command') {
                    if (failFirstAck) {
                        failFirstAck = false;
                        throw new Error('timeout ack');
                    }
                    return null;
                }
                return null;
            },
        });
        cleanups.push(async () => bridge.stop());

        // 1. Si lan_bridge_register falla, enabled sigue false
        await expect(bridge.setupBridge({
            cloudUrl: 'https://relay.test',
            cloudAnonKey: 'anon',
            ownerPin: '123456',
        })).rejects.toThrow(/sin internet/);
        expect(bridge.getPublicStatus().enabled).toBe(false);

        // 2. Setup exitoso
        failRegister = false;
        const st = await bridge.setupBridge({
            cloudUrl: 'https://relay.test',
            cloudAnonKey: 'anon',
            ownerPin: '123456',
        });
        expect(st.enabled).toBe(true);

        // 3. Ciclo 1: ejecuta cmd-1 y falla el ACK -> NO debe enviar status='failed'
        await bridge.syncOnce();
        expect(executedCount).toBe(1);
        const ackCallsAfter1 = calls.filter((c) => c.fn === 'lan_bridge_ack_command');
        expect(ackCallsAfter1).toHaveLength(1);
        expect(ackCallsAfter1[0].args.p_status).toBe('applied');

        // 4. Ciclo 2: reintenta ACK como 'applied' sin re-ejecutar, y no empuja snapshot innecesario en ciclo 3
        await bridge.syncOnce();
        expect(executedCount).toBe(1);
        const ackCallsAfter2 = calls.filter((c) => c.fn === 'lan_bridge_ack_command');
        expect(ackCallsAfter2).toHaveLength(2);
        expect(ackCallsAfter2[1].args.p_status).toBe('applied');

        const pushesBeforeIdle = calls.filter((c) => c.fn === 'lan_bridge_push_snapshot').length;
        await bridge.syncOnce();
        const pushesAfterIdle = calls.filter((c) => c.fn === 'lan_bridge_push_snapshot').length;
        expect(pushesAfterIdle).toBe(pushesBeforeIdle);
    });
});
