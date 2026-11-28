/**
 * tests/payrollUi.test.js — Nómina F3: portero de sub-pestañas y datos del recibo.
 * Plan: docs/plans/2026-11-14-plan-nomina-simple-bodega.md
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', async (importOriginal) => ({ ...(await importOriginal()), Users: () => null, Truck: () => null, Wallet: () => null }));
vi.mock('../src/config/paymentMethods', () => ({ getPaymentLabel: (id) => ({ pago_movil: 'Pago Móvil' })[id] }));

import { canOpenGestionTab, GESTION_TABS } from '../src/components/Gestion/GestionTabs.jsx';
import { buildPayrollReceiptData, buildPayrollReceiptHtml } from '../src/utils/payrollReceipt.js';

describe('Gestión: sub-pestañas', () => {
    it('el Cajero solo ve Clientes; el Administrador ve las tres', () => {
        expect(GESTION_TABS.map(t => t.id)).toEqual(['clientes', 'proveedores', 'nomina']);
        expect(canOpenGestionTab('clientes', true)).toBe(true);
        expect(canOpenGestionTab('proveedores', true)).toBe(false);
        expect(canOpenGestionTab('nomina', true)).toBe(false);
        expect(canOpenGestionTab('nomina', false)).toBe(true);
        expect(canOpenGestionTab('otra', false)).toBe(false);
    });
});

describe('recibo de nómina', () => {
    const employee = { nombre: 'María <b>', cedula: 'V-1', cargo: 'Cajera', frecuencia: 'quincenal' };
    const entry = {
        id: 'nom_abcdef123456', tipo: 'PAGO', periodoId: 'Q-2026-11-2', moneda: 'BS', montoBs: 3600, montoUsd: 90, tasa: 40,
        metodoId: 'pago_movil', status: 'ACTIVO', timestamp: '2026-11-20T15:00:00.000Z', actor: 'Administrador', nota: '',
    };

    it('arma los datos con periodo, forma de pago, monto en Bs y su equivalente', () => {
        const d = buildPayrollReceiptData({ entry, employee, saldoDespuesUsd: 0, business: { name: 'Bodega X' } });
        expect(d.titulo).toBe('Recibo de pago');
        expect(d.numero).toBe('EF123456');
        expect(d.rows).toEqual(expect.arrayContaining([
            ['Periodo', '2.ª quincena de noviembre de 2026 (16–30)'],
            ['Forma de pago', 'Pago Móvil'],
        ]));
        expect(d.montoPrincipal).toMatch(/^Bs 3\.600,00$/);
        expect(d.montoSecundario).toMatch(/\$90[.,]00 \(tasa 40\)/);
        expect(d.firma).toBe(true);
        expect(d.anulado).toBe(false);
    });

    it('el HTML escapa los textos y marca ANULADO', () => {
        const d = buildPayrollReceiptData({ entry: { ...entry, status: 'ANULADO' }, employee, saldoDespuesUsd: 10, business: { name: 'Bodega X' } });
        const html = buildPayrollReceiptHtml(d, '80');
        expect(html).toContain('María &lt;b&gt;');
        expect(html).toContain('ANULADO');
        expect(html).toContain('80mm');
    });

    it('recibo de mercancía incluye logo, tabla de productos, origen, saldo anterior y quién autorizó', () => {
        const goodsEntry = {
            id: 'nom_0e646ea9',
            tipo: 'MERCANCIA',
            source: 'CAJA',
            periodoId: 'Q-2026-11-2',
            moneda: 'USD',
            montoUsd: 2.5,
            montoBs: 2200,
            tasa: 880,
            valoracion: 'venta',
            saldoAntesUsd: 85,
            status: 'ACTIVO',
            timestamp: '2026-11-28T14:41:00.000Z',
            actor: 'Luigi',
            actorRol: 'CAJERO',
            authorizedBy: 'Carlos Dueño',
            authorizedByRol: 'DUENO',
            createdByDevice: 'Caja A',
            items: [
                { name: 'Glup Fresh 1lt', qty: 2, unitUsd: 1.25, subtotalUsd: 2.5 },
            ],
            nota: 'Entregado en turno mañana',
        };
        const d = buildPayrollReceiptData({
            entry: goodsEntry,
            employee,
            saldoDespuesUsd: 82.5,
            business: { name: 'Abasto Central', rif: 'J-12345678-9', phone: '0414-0000000', logoSrc: '/logo.png' },
        });
        const html = buildPayrollReceiptHtml(d, '58');
        expect(html).toContain('<img src="/logo.png"');
        expect(html).toContain('Abasto Central');
        expect(html).toContain('RIF: J-12345678-9');
        expect(html).toContain('CONCEPTO');
        expect(html).toContain('Glup Fresh 1lt');
        expect(html).toContain('Caja (Punto de Venta)');
        expect(html).toContain('Saldo antes:');
        expect(html).toContain('Registrado por:');
        expect(html).toContain('Luigi (Cajero)');
        expect(html).toContain('Autorizado por:');
        expect(html).toContain('Carlos Dueño (Dueño)');
        expect(html).toContain('Recibí conforme');
    });
});
