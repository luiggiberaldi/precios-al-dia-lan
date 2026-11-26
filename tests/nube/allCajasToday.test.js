/**
 * Inicio del dueño / administrador: lo de hoy sumado de todas las cajas y «Por caja».
 */
import { describe, it, expect } from 'vitest';
import {
    buildAllCajasSummary, salesOfDayAllCajas, inferLocalDeviceId, isNubeManagerRole,
    summarizeCajaRecords, loadDashboardCajas,
} from '../../src/nube/allCajasToday.js';
import { getLocalISODate } from '../../src/utils/dateHelpers.js';

const now = new Date();
const today = getLocalISODate(now);
const at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const yesterday = (() => { const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(12); return d.toISOString(); })();

const venta = (id, usd, extra = {}) => ({
    id, tipo: 'VENTA', status: 'COMPLETADA', totalUsd: usd, totalBs: usd * 40, timestamp: at(9),
    items: [{ id: 'p1', name: 'Café', qty: 2, priceUsd: usd / 2 }],
    payments: [{ methodId: 'efectivo_usd', currency: 'USD', amountUsd: usd, amount: usd }],
    ...extra,
});
const remote = (sale, deviceId, label) => ({ ...sale, _deviceId: deviceId, _cajaLabel: label });

// Caja 1 (esta PC): 2 ventas locales; la nube tiene la primera ya subida.
const local = [venta('a1', 10), venta('a2', 6), venta('viejo', 99, { timestamp: yesterday })];
// Caja 2 (teléfono): 1 venta hoy, 1 anulada y 1 de ayer.
const remoteSales = [
    remote(venta('a1', 10), 'dev-pc', 'Caja 1'),
    remote(venta('b1', 4), 'dev-tel', 'Caja 2 teléfono'),
    remote(venta('b2', 50, { status: 'ANULADA' }), 'dev-tel', 'Caja 2 teléfono'),
    remote(venta('b0', 70, { timestamp: yesterday }), 'dev-tel', 'Caja 2 teléfono'),
    remote({ id: 'g1', tipo: 'GASTO_INTERNO', status: 'COMPLETADA', totalUsd: -3, timestamp: at(10) }, 'dev-tel', 'Caja 2 teléfono'),
];
const labels = { 'dev-pc': 'Caja 1', 'dev-tel': 'Caja 2 teléfono' };

describe('Inicio de todas las cajas', () => {
    it('solo dueño y administrador', () => {
        expect(isNubeManagerRole('dueno')).toBe(true);
        expect(isNubeManagerRole('administrador')).toBe(true);
        expect(isNubeManagerRole('cajero')).toBe(false);
        expect(isNubeManagerRole(undefined)).toBe(false);
    });

    it('deduce qué caja es esta por lo que ya subió', () => {
        expect(inferLocalDeviceId(remoteSales, local)).toBe('dev-pc');
        expect(inferLocalDeviceId(remoteSales, [])).toBeNull();
    });

    it('suma las cajas sin contar dos veces lo de esta caja', () => {
        const { totals, cajas, localDeviceId } = buildAllCajasSummary({ remoteSales, localSales: local, labels, today, bcvRate: 40 });
        expect(localDeviceId).toBe('dev-pc');
        expect(totals.todaySales.map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1']);
        expect(totals.todayTotalUsd).toBe(20);
        expect(totals.todayTotalBs).toBe(800);
        expect(totals.todayItemsSold).toBe(6);
        expect(totals.todayExpensesUsd).toBe(3);
        expect(totals.todayGastosUsd).toBe(3);
        expect(totals.paymentBreakdown.efectivo_usd.total).toBe(20);
        expect(cajas.map((c) => [c.name, c.isLocal, c.salesCount, c.totalUsd])).toEqual([
            ['Caja 1', true, 2, 16],
            ['Caja 2 teléfono', false, 1, 4],
        ]);
    });

    it('por caja trae el efectivo esperado de cada una', () => {
        const { cajas } = buildAllCajasSummary({ remoteSales, localSales: local, labels, today, bcvRate: 40 });
        expect(cajas[0].expectedUsd).toBe(16);
        expect(cajas[1].expectedUsd).toBe(4);
    });

    it('la suma coincide con lo que cada caja ve en su propio Inicio', () => {
        const caja2 = summarizeCajaRecords(remoteSales.filter((s) => s._deviceId === 'dev-tel'), { today, bcvRate: 40 });
        const caja1 = summarizeCajaRecords(local, { today, bcvRate: 40 });
        const { totals } = buildAllCajasSummary({ remoteSales, localSales: local, labels, today, bcvRate: 40 });
        expect(totals.todayTotalUsd).toBe(caja1.totalUsd + caja2.totalUsd);
        expect(totals.todaySales.length).toBe(caja1.salesCount + caja2.salesCount);
    });

    it('respeta el turno abierto de cada caja (lo cerrado no cuenta)', () => {
        const cerradas = [remote(venta('c1', 30, { cajaCerrada: true }), 'dev-x', 'Caja 3')];
        const { cajas, totals } = buildAllCajasSummary({ remoteSales: [...remoteSales, ...cerradas], localSales: local, labels, today });
        expect(cajas.find((c) => c.name === 'Caja 3')).toBeUndefined();
        expect(totals.todayTotalUsd).toBe(20);
    });

    it('sin nada subido aún, esta caja va aparte con su copia local', () => {
        const { cajas } = buildAllCajasSummary({ remoteSales: remoteSales.slice(1), localSales: local, labels, today });
        expect(cajas[0]).toMatchObject({ isLocal: true, name: 'Esta caja', salesCount: 2 });
    });

    it('oculta cajas desconectadas sin ventas ni dinero en caja, pero conserva las que sí vendieron hoy', () => {
        const aperturaCero = remote({ id: 'ap-rev', tipo: 'APERTURA_CAJA', openingUsd: 0, timestamp: at(8), _deviceRevoked: true }, 'dev-rev-empty', 'Caja claude');
        const ventaRev = remote(venta('v-rev', 12, { _deviceRevoked: true }), 'dev-rev-sale', 'Caja vieja');
        const { cajas, totals } = buildAllCajasSummary({
            remoteSales: [...remoteSales, aperturaCero, ventaRev],
            localSales: local,
            labels: { ...labels, 'dev-rev-empty': 'Caja claude', 'dev-rev-sale': 'Caja vieja' },
            today,
            bcvRate: 40,
        });
        expect(cajas.find((c) => c.name === 'Caja claude')).toBeUndefined();
        expect(cajas.find((c) => c.name === 'Caja vieja')).toMatchObject({ revoked: true, salesCount: 1, totalUsd: 12 });
        expect(totals.todayTotalUsd).toBe(32);
    });
});

describe('«Ventas del día» de todas las cajas', () => {
    it('junta lo de hoy de todas las cajas, con el nombre de cada una', () => {
        const list = salesOfDayAllCajas({ remoteSales, localSales: local, labels, today });
        expect(list.map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'g1']);
        expect(list.find((s) => s.id === 'a1')._cajaName).toBe('Caja 1');
        expect(list.find((s) => s.id === 'a1')._deviceId).toBeUndefined(); // local: se puede anular aquí
        expect(list.find((s) => s.id === 'b1')._cajaName).toBe('Caja 2 teléfono');
    });

    it('no mete ajustes de stock ni aperturas/cierres como si fueran ventas en $0', () => {
        const ajuste = { id: 'adj_1', tipo: 'AJUSTE_ENTRADA', status: 'COMPLETADA', totalUsd: 0, totalBs: 0, timestamp: at(11), items: [{ id: 'p1', name: 'Café', qty: 1 }] };
        const list = salesOfDayAllCajas({
            remoteSales: [
                ...remoteSales,
                remote(ajuste, 'dev-tel', 'Caja 2 teléfono'),
                remote({ id: 'adj_2', tipo: 'AJUSTE_SALIDA', status: 'COMPLETADA', totalUsd: 0, timestamp: at(11) }, 'dev-tel', 'Caja 2 teléfono'),
                remote({ id: 'ap1', tipo: 'APERTURA_CAJA', openingUsd: 0, timestamp: at(8) }, 'dev-tel', 'Caja 2 teléfono'),
                remote({ id: 'ci1', tipo: 'REGISTRO_CIERRE', timestamp: at(12) }, 'dev-tel', 'Caja 2 teléfono'),
            ],
            localSales: [...local, { ...ajuste, id: 'adj_local' }],
            labels, today,
        });
        expect(list.map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'g1']);
    });
});

describe('carga para el Inicio', () => {
    it('le pone a cada venta el nombre de su caja (account_devices.label)', async () => {
        const client = {
            from(table) {
                if (table === 'account_devices') {
                    return { select: (cols) => Promise.resolve({ data: cols.includes('label')
                        ? [{ id: 'dev-tel', label: 'Caja 2 teléfono' }]
                        : [{ id: 'dev-tel', caja_letter: 'B' }], error: null }) };
                }
                const q = {
                    select: () => q, eq: () => q, is: () => q, gt: () => q, order: () => q,
                    limit: () => Promise.resolve({ data: [{ id: 'b1@dev-tel', data: venta('b1', 4), deleted_at: null, updated_by_device: 'dev-tel' }], error: null }),
                };
                return q;
            },
        };
        const sales = await loadDashboardCajas(client);
        expect(sales[0]).toMatchObject({ id: 'b1', _deviceId: 'dev-tel', _cajaLabel: 'Caja 2 teléfono', _caja: 'B' });
    });

    it('marca _deviceRevoked cuando el equipo tiene revoked_at en account_devices', async () => {
        const client = {
            from(table) {
                if (table === 'account_devices') {
                    return { select: (cols) => Promise.resolve({ data: cols.includes('label')
                        ? [{ id: 'dev-old', label: 'Caja claude', revoked_at: '2026-11-18T12:00:00Z' }]
                        : [{ id: 'dev-old', caja_letter: 'C' }], error: null }) };
                }
                const q = {
                    select: () => q, eq: () => q, is: () => q, gt: () => q, order: () => q,
                    limit: () => Promise.resolve({ data: [{ id: 'ap@dev-old', data: { id: 'ap', tipo: 'APERTURA_CAJA', openingUsd: 0, timestamp: at(8) }, deleted_at: null, updated_by_device: 'dev-old' }], error: null }),
                };
                return q;
            },
        };
        const sales = await loadDashboardCajas(client);
        expect(sales[0]).toMatchObject({ _deviceId: 'dev-old', _cajaLabel: 'Caja claude', _deviceRevoked: true });
    });
});
