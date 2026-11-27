/**
 * Fase 5 — Integración multi-caja LAN real: Modo "Caja compartida / Gaveta única".
 *
 * Levanta un servidor LAN real (PGlite + HTTP + SSE) con Caja A y Caja B y verifica:
 *  1. Activar `cash_drawer_mode = 'shared'` en `pdn_business_config_v1` se replica a Caja B.
 *  2. Apertura única en Caja A (`open_shared_cash_shift`) → Caja B baja el turno abierto
 *     con el mismo `shiftId` y un intento duplicado devuelve `already_open: true`.
 *  3. Ventas en Caja A ($20) y Caja B ($15) se sincronizan bidireccionalmente en `bodega_sales_v1`
 *     con `buildAllCajasSummary` sin doble conteo ($35 total) y desglose por equipo intacto.
 *  4. Anulación cruzada: Caja B anula la venta de Caja A conservando `_deviceId` de Caja A.
 *  5. Cierre único atómico (`close_shared_cash_shift`) en Caja A cierra ambos equipos e impide
 *     cierre duplicado desde Caja B (`already_closed: true`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createRecordSync } from '../../src/nube/recordSync';
import { buildAllCajasSummary } from '../../src/nube/allCajasToday';
import { findOpenCashShift } from '../../src/utils/cashShift';

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
        getItem: async (k) => (map.has(k) ? map.get(k) : null),
        setItem: async (k, v) => map.set(k, v),
    };
}

describe('Fase 5 · LAN multi-caja: Modo Caja compartida / Gaveta única', () => {
    it('flujo completo Caja A + Caja B: ajuste, apertura única, ventas/anulación cruzada, arqueo sin doble conteo y cierre único', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-lan-shared-cash-'));
        cleanups.push(async () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            dataDir: path.join(tmpRoot, 'db'),
            imagesDir: path.join(tmpRoot, 'images'),
            backupsDir: path.join(tmpRoot, 'backups'),
        });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'dueno@shared.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Farmacia Compartida',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false, localAdminSecret: srv.localAdminSecret });
        const uidA = await svc.ensureDeviceSession(cajaA);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja 1', role: 'caja', sedeId: null });
        const stA = await svc.getDeviceStatus(cajaA, uidA);

        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja 2', role: 'caja', sedeId: null });
        const stB = await svc.getDeviceStatus(cajaB, uidB);

        const members = await svc.listMembers(cajaA);
        const ownerMember = members.find((m) => m.role === 'dueno');
        const loginA = await svc.loginWithPin(cajaA, ownerMember.id, '142536');
        const loginB = await svc.loginWithPin(cajaB, ownerMember.id, '142536');

        // 1. Activar modo caja compartida en pdn_business_config_v1
        const localA = new Map();
        const localB = new Map();
        let modeA = 'shared';
        let modeB = 'shared';

        const syncA = createRecordSync({
            client: cajaA,
            getSession: () => loginA.token,
            store: makeMemStore(),
            cashIdSuffix: stA.device.id,
            readLocal: async (k) => localA.get(k) ?? [],
            writeLocal: async (k, v) => localA.set(k, v),
            isSharedCashMode: () => modeA === 'shared',
        });
        const syncB = createRecordSync({
            client: cajaB,
            getSession: () => loginB.token,
            store: makeMemStore(),
            cashIdSuffix: stB.device.id,
            readLocal: async (k) => localB.get(k) ?? [],
            writeLocal: async (k, v) => localB.set(k, v),
            isSharedCashMode: () => modeB === 'shared',
        });

        localA.set('pdn_business_config_v1', { cash_drawer_mode: 'shared' });
        await syncA.onLocalWrite('pdn_business_config_v1', { cash_drawer_mode: 'shared' });
        await syncA.flush();

        await syncB.pull(['settings']);
        expect(localB.get('pdn_business_config_v1')?.cash_drawer_mode).toBe('shared');

        // 2. Apertura única en Caja A → Caja B recibe mismo turno e intento duplicado devuelve already_open
        const nowIso = new Date().toISOString();
        const { data: openA, error: errOpenA } = await cajaA.rpc('open_shared_cash_shift', {
            p_session: loginA.token,
            p_shift_id: 'shift_lan_1',
            p_opening_record: {
                id: 'ap_lan_1',
                tipo: 'APERTURA_CAJA',
                openingUsd: 50,
                openingBs: 2000,
                openingCop: 0,
                timestamp: nowIso,
                cajaCerrada: false,
            },
        });
        expect(errOpenA).toBeNull();
        expect(openA.already_open).toBe(false);

        const { data: openB } = await cajaB.rpc('open_shared_cash_shift', {
            p_session: loginB.token,
            p_shift_id: 'shift_lan_2',
            p_opening_record: { id: 'ap_lan_2', openingUsd: 999, timestamp: nowIso },
        });
        expect(openB.already_open).toBe(true);
        expect(openB.shift.id).toBe('shift_lan_1');

        await syncA.pull(['cash']);
        await syncB.pull(['cash']);
        expect(findOpenCashShift(localA.get('bodega_sales_v1'))?.shiftId).toBe('shift_lan_1');
        expect(findOpenCashShift(localB.get('bodega_sales_v1'))?.shiftId).toBe('shift_lan_1');

        // 3. Ventas en Caja A ($20) y Caja B ($15)
        const saleA = {
            id: 'v_lan_a',
            tipo: 'VENTA',
            shiftId: 'shift_lan_1',
            totalUsd: 20,
            totalBs: 800,
            payments: [{ methodId: 'efectivo_usd', amountUsd: 20 }],
            timestamp: new Date().toISOString(),
            cajaCerrada: false,
        };
        const nextA = [...(localA.get('bodega_sales_v1') || []), saleA];
        localA.set('bodega_sales_v1', nextA);
        await syncA.onLocalWrite('bodega_sales_v1', nextA);
        await syncA.flush();

        const saleB = {
            id: 'v_lan_b',
            tipo: 'VENTA',
            shiftId: 'shift_lan_1',
            totalUsd: 15,
            totalBs: 600,
            payments: [{ methodId: 'efectivo_usd', amountUsd: 15 }],
            timestamp: new Date().toISOString(),
            cajaCerrada: false,
        };
        await syncB.pull(['cash']);
        const nextB = [...(localB.get('bodega_sales_v1') || []), saleB];
        localB.set('bodega_sales_v1', nextB);
        await syncB.onLocalWrite('bodega_sales_v1', nextB);
        await syncB.flush();

        await syncA.pull(['cash']);

        // Verificar resumen consolidado sin doble conteo
        const summary = buildAllCajasSummary({
            localSales: localA.get('bodega_sales_v1'),
            remoteSales: localB.get('bodega_sales_v1'),
            localDeviceId: stA.device.id,
            labels: { [stA.device.id]: 'Caja 1', [stB.device.id]: 'Caja 2' },
            bcvRate: 40,
            sharedDrawerMode: true,
        });
        expect(summary.isSharedDrawer).toBe(true);
        expect(summary.totals.todayTotalUsd).toBe(35);
        expect(summary.totals.todaySales).toHaveLength(2);

        // 4. Anulación cruzada: Caja B anula la venta de Caja A
        const voidedB = localB.get('bodega_sales_v1').map((s) =>
            s.id === 'v_lan_a' ? { ...s, status: 'ANULADA' } : s,
        );
        localB.set('bodega_sales_v1', voidedB);
        await syncB.onLocalWrite('bodega_sales_v1', voidedB);
        await syncB.flush();

        await syncA.pull(['cash']);
        const saleAOnA = localA.get('bodega_sales_v1').find((s) => s.id === 'v_lan_a');
        expect(saleAOnA?.status).toBe('ANULADA');
        expect(saleAOnA?._deviceId).toBe(stA.device.id);

        // 5. Cierre único en Caja A → Caja B queda cerrada y un segundo cierre devuelve already_closed
        const { data: closeA, error: errCloseA } = await cajaA.rpc('close_shared_cash_shift', {
            p_session: loginA.token,
            p_shift_id: 'shift_lan_1',
            p_close_record: { id: 'cierre_lan_1', cierreId: Date.now(), summary: { todayTotalUsd: 15 } },
        });
        expect(errCloseA).toBeNull();
        expect(closeA.already_closed).toBe(false);

        const { data: closeB } = await cajaB.rpc('close_shared_cash_shift', {
            p_session: loginB.token,
            p_shift_id: 'shift_lan_1',
            p_close_record: { id: 'cierre_lan_2', cierreId: Date.now() },
        });
        expect(closeB.already_closed).toBe(true);

        await syncB.pull(['cash']);
        expect(findOpenCashShift(localB.get('bodega_sales_v1'))).toBeNull();
    }, 60_000);
});
