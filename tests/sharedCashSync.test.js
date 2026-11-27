import { describe, expect, it, vi } from 'vitest';
import { createRecordSync } from '../src/nube/recordSync';
import { buildAllCajasSummary } from '../src/nube/allCajasToday';

function makeStore() {
    const map = new Map();
    return {
        getItem: async (k) => (map.has(k) ? map.get(k) : null),
        setItem: async (k, v) => map.set(k, v),
    };
}

function makeFakeClient(rowsByCollection = {}) {
    const pulledCollections = [];
    const makeQuery = (collection) => {
        const rows = rowsByCollection[collection] || [];
        const q = {
            select: () => q,
            eq: (col, val) => {
                if (col === 'collection') collection = val;
                return q;
            },
            gt: () => q,
            gte: () => q,
            order: () => q,
            limit: async () => {
                pulledCollections.push(collection);
                return { data: rowsByCollection[collection] || rows, error: null };
            },
        };
        return q;
    };
    return {
        pulledCollections,
        from: () => makeQuery(null),
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
}

describe('Fase 3 — sync bidireccional de cash y deduplicación en allCajasToday', () => {
    it('en modo separate NO baja cash; en modo shared SÍ baja cash y adjunta _deviceId', async () => {
        const cashRow = {
            id: 'v_pc1',
            data: { id: 'v_pc1', tipo: 'VENTA', shiftId: 's1', totalUsd: 15, timestamp: '2026-11-27T14:00:00.000Z' },
            version: 1,
            deleted_at: null,
            updated_at: '2026-11-27T14:00:00.000Z',
            updated_by_device: 'DEV-PC1',
        };
        const local = new Map();

        const clientSep = makeFakeClient({ cash: [cashRow] });
        const syncSep = createRecordSync({
            client: clientSep,
            getSession: () => 'tok',
            store: makeStore(),
            readLocal: async (k) => local.get(k) || [],
            writeLocal: async (k, v) => local.set(k, v),
            isSharedCashMode: () => false,
        });
        await syncSep.pull(['cash']);
        expect(clientSep.pulledCollections).not.toContain('cash');
        expect(local.get('bodega_sales_v1')).toBeUndefined();

        const clientShared = makeFakeClient({ cash: [cashRow] });
        const syncShared = createRecordSync({
            client: clientShared,
            getSession: () => 'tok',
            store: makeStore(),
            readLocal: async (k) => local.get(k) || [],
            writeLocal: async (k, v) => local.set(k, v),
            isSharedCashMode: () => true,
        });
        const applied = await syncShared.pull(['cash']);
        expect(applied).toBe(1);
        expect(clientShared.pulledCollections).toContain('cash');
        expect(local.get('bodega_sales_v1')).toEqual([
            expect.objectContaining({ id: 'v_pc1', _deviceId: 'DEV-PC1', totalUsd: 15 }),
        ]);
    });

    it('buildAllCajasSummary en modo shared deduplica por id y nunca cuenta doble', () => {
        const opening = {
            id: 'ap_1',
            tipo: 'APERTURA_CAJA',
            shiftId: 's_shared',
            openingUsd: 50,
            cajaCerrada: false,
            _deviceId: 'DEV-A',
            timestamp: '2026-11-27T10:00:00.000Z',
        };
        const saleA = {
            id: 'v_a',
            tipo: 'VENTA',
            shiftId: 's_shared',
            totalUsd: 20,
            totalBs: 800,
            _deviceId: 'DEV-A',
            payments: [{ methodId: 'efectivo_usd', amountUsd: 20 }],
            timestamp: '2026-11-27T10:15:00.000Z',
        };
        const saleB = {
            id: 'v_b',
            tipo: 'VENTA',
            shiftId: 's_shared',
            totalUsd: 15,
            totalBs: 600,
            _deviceId: 'DEV-B',
            payments: [{ methodId: 'efectivo_usd', amountUsd: 15 }],
            timestamp: '2026-11-27T10:20:00.000Z',
        };

        // En modo shared, tanto localSales como remoteSales ya tienen todos los registros del turno
        const summary = buildAllCajasSummary({
            localSales: [opening, saleA, saleB],
            remoteSales: [opening, saleA, saleB],
            localDeviceId: 'DEV-A',
            labels: { 'DEV-A': 'Caja 1', 'DEV-B': 'Caja 2' },
            today: '2026-11-27',
            bcvRate: 40,
            sharedDrawerMode: true,
        });

        expect(summary.isSharedDrawer).toBe(true);
        // Suma exacta: 20 + 15 = 35 (NO 70!)
        expect(summary.totals.todayTotalUsd).toBe(35);
        expect(summary.totals.todaySales).toHaveLength(2);
        // Desglose informativo por equipo intacto
        const caja1 = summary.cajas.find((c) => c.deviceId === 'DEV-A');
        const caja2 = summary.cajas.find((c) => c.deviceId === 'DEV-B');
        expect(caja1?.totalUsd).toBe(20);
        expect(caja2?.totalUsd).toBe(15);
    });
});
