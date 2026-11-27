/**
 * T23 · Reportes y Dashboard consolidados multi-caja:
 *   1. `mergeCajasSales` usa clave compuesta `${deviceId}:${sale.id}`: dos cajas con el
 *      mismo id local NO se pisan entre sí.
 *   2. `loadAllCajasSalesRange` consulta por rango vía RPC `cash_records_range` en Postgres real.
 *   3. `mergeAllCajasRecords` + `computeConsolidatedDashboardCharts` consolidan `weekData`
 *      y `topProducts` de todas las cajas, incluyendo ventas de turnos ya cerrados hoy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { loadAllCajasSalesRange, mergeCajasSales } from '../../src/nube/allCajasSales';
import { computeConsolidatedDashboardCharts, mergeAllCajasRecords } from '../../src/nube/allCajasToday';
import { calculateReportsData } from '../../src/utils/reportsProcessor';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

describe('T23 · Reportes multi-caja y Dashboard consolidado', () => {
    it('1. mergeCajasSales conserva ventas con el mismo sale.id local provenientes de dos cajas distintas', () => {
        const merged = mergeCajasSales([
            { id: '1700000@DEV-A', updated_by_device: 'DEV-A', data: { id: '1700000', tipo: 'VENTA', totalUsd: 12, timestamp: '2026-11-26T10:00:00Z' } },
            { id: '1700000@DEV-B', updated_by_device: 'DEV-B', data: { id: '1700000', tipo: 'VENTA', totalUsd: 18, timestamp: '2026-11-26T10:00:01Z' } },
        ], { 'DEV-A': 'A', 'DEV-B': 'B' });

        expect(merged).toHaveLength(2);
        expect(merged.reduce((s, x) => s + x.totalUsd, 0)).toBe(30);
    });

    it('2. loadAllCajasSalesRange usa RPC cash_records_range en Postgres real y filtra por rango de fechas', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'rep@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Reportes',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '123456',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidA = await svc.ensureDeviceSession(cajaA);
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja A', role: 'caja' });
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja' });
        const stA = await svc.getDeviceStatus(cajaA, uidA);
        const stB = await svc.getDeviceStatus(cajaB, uidB);
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '123456');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '123456');

        await cajaA.rpc('push_records_v2', {
            p_session: sessA.token,
            p_collection: 'cash',
            p_records: [
                { id: `s-old@${stA.device.id}`, data: { id: 's-old', tipo: 'VENTA', totalUsd: 9, timestamp: '2026-10-05T15:00:00Z' } },
                { id: `s-nov-a@${stA.device.id}`, data: { id: 's-nov-a', tipo: 'VENTA', totalUsd: 20, timestamp: '2026-11-26T15:00:00Z', items: [{ id: 'p1', name: 'Harina', qty: 4, priceUsd: 5 }] } },
            ],
        });
        await cajaB.rpc('push_records_v2', {
            p_session: sessB.token,
            p_collection: 'cash',
            p_records: [
                { id: `s-nov-b@${stB.device.id}`, data: { id: 's-nov-b', tipo: 'VENTA', totalUsd: 15, timestamp: '2026-11-26T16:00:00Z', items: [{ id: 'p1', name: 'Harina', qty: 3, priceUsd: 5 }] } },
            ],
        });

        const novSales = await loadAllCajasSalesRange(cajaA, { from: '2026-11-25', to: '2026-11-27' });
        expect(novSales.map((s) => s.id).sort()).toEqual(['s-nov-a', 's-nov-b']);

        const consolidated = mergeAllCajasRecords({
            remoteSales: novSales,
            localSales: [{ id: 's-nov-a', tipo: 'VENTA', totalUsd: 20, timestamp: '2026-11-26T15:00:00Z', items: [{ id: 'p1', name: 'Harina', qty: 4, priceUsd: 5 }] }],
            localDeviceId: stA.device.id,
            labels: { [stA.device.id]: 'Caja A', [stB.device.id]: 'Caja B' },
        });
        const report = calculateReportsData(consolidated, '2026-11-26', '2026-11-26', 100, [], []);
        expect(report.totalUsd).toBe(35);
        expect(report.totalItems).toBe(7);
    }, 60_000);

    it('3. computeConsolidatedDashboardCharts consolida weekData y topProducts incluyendo turnos cerrados hoy', () => {
        const today = '2026-11-26';
        const merged = mergeAllCajasRecords({
            localSales: [
                { id: 'loc-1', tipo: 'VENTA', status: 'COMPLETADA', cajaCerrada: true, totalUsd: 10, timestamp: '2026-11-26T14:00:00Z', items: [{ id: 'p1', name: 'Café', qty: 2, priceUsd: 5 }] },
            ],
            remoteSales: [
                { id: 'rem-1', _deviceId: 'DEV-B', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 25, timestamp: '2026-11-26T16:00:00Z', items: [{ id: 'p1', name: 'Café', qty: 5, priceUsd: 5 }] },
            ],
            localDeviceId: 'DEV-A',
            labels: { 'DEV-A': 'Caja A', 'DEV-B': 'Caja B' },
        });
        const charts = computeConsolidatedDashboardCharts(merged, { today });
        expect(charts.todayCalendarTotalUsd).toBe(35);
        expect(charts.weekData.find((d) => d.date === today)?.total).toBe(35);
        expect(charts.topProducts[0]).toMatchObject({ name: 'Café', qty: 7, revenue: 35 });
    });
});
