// @vitest-environment jsdom
/**
 * F4 · pestaña «Todas las cajas»: solo dueño/administrador con la nube activa; el cajero
 * ve solo su caja. Es de solo lectura (sin Anular ni Reciclar).
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';

const cajasState = { sales: [], loading: false, error: null, refresh: vi.fn() };
vi.mock('../../src/nube/useAllCajasSales', () => ({ useAllCajasSales: () => cajasState }));

const { default: SalesHistory } = await import('../../src/components/Dashboard/SalesHistory.jsx');
const { setNubeLocalWriteHandler } = await import('../../src/nube/localWriteHook.js');

let root;
let container;
async function render(props) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = () => {};
    await act(async () => {
        root.render(<SalesHistory bcvRate={40} onVoidSale={noop} onShareWhatsApp={noop} onRecycleSale={noop}
            onRequestClientForTicket={noop} onOpenDeleteModal={noop} recentSales={[]} todaySales={[]} {...props} />);
    });
}
const tab = () => container.querySelector('[data-testid="history-tab-cajas"]');

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    setNubeLocalWriteHandler(null);
    cajasState.sales = [];
});

describe('F4 · historial de todas las cajas', () => {
    it('el cajero no ve la pestaña (solo su caja)', async () => {
        setNubeLocalWriteHandler(() => {});
        await render({ isAdmin: false });
        expect(tab()).toBeNull();
    });

    it('sin la nube no aparece (Bodega sigue igual)', async () => {
        await render({ isAdmin: true });
        expect(tab()).toBeNull();
    });

    it('el administrador ve las ventas de todas las cajas, con su letra y sin anular', async () => {
        setNubeLocalWriteHandler(() => {});
        cajasState.sales = [
            { id: 'v2', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 7, timestamp: '2026-11-17T11:00:00Z', items: [{ id: 'p', name: 'Café', qty: 1, priceUsd: 7 }], _caja: 'B' },
            { id: 'v1', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 5, timestamp: '2026-11-17T10:00:00Z', items: [], _caja: 'A' },
        ];
        await render({ isAdmin: true });
        expect(tab()).not.toBeNull();
        await act(async () => { tab().click(); });
        const badges = [...container.querySelectorAll('[data-testid="caja-badge"]')].map((b) => b.textContent);
        expect(badges).toEqual(['Caja B', 'Caja A']);
        expect(container.querySelector('[data-testid="history-cajas-status"]').textContent).toMatch(/solo lectura/);

        // Abrir una venta: no hay «Anular» (se anula en la caja que vendió).
        const row = container.querySelector('[data-testid="caja-badge"]').closest('.cursor-pointer');
        await act(async () => { row.click(); });
        expect(container.textContent).toContain('Café');
        expect(container.textContent).not.toContain('Anular');
    });

    it('cada venta dice correlativo, fecha y hora, vendedor y cliente; sin ajustes en $0', async () => {
        setNubeLocalWriteHandler(() => {});
        cajasState.sales = [
            {
                id: 'v9', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 21, discountAmountUsd: 2, discountType: 'percentage', discountValue: 10,
                timestamp: '2026-11-17T18:11:00Z', saleNumber: 3235, nube: { number: '#A-00001' }, vendedor: 'Ana',
                customerName: 'Pedro', customerDocument: 'V-12345678', customerPhone: '0414-0000000',
                items: [{ id: 'p', name: 'Chocolate', qty: 1, priceUsd: 21 }],
                payments: [{ methodId: 'efectivo_usd', methodLabel: 'Efectivo en Dólares', currency: 'USD', amountUsd: 21 }], _caja: 'A',
            },
            { id: 'old', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 1, timestamp: '2026-10-21T16:46:00Z', items: [], _vendedor: 'Luis', _caja: 'A' },
            { id: 'adj_1', tipo: 'AJUSTE_ENTRADA', status: 'COMPLETADA', totalUsd: 0, timestamp: '2026-11-17T18:12:00Z', items: [{ id: 'p', name: 'Cigarro', qty: 1 }], _caja: 'A' },
        ];
        await render({ isAdmin: true });
        await act(async () => { tab().click(); });

        expect(container.querySelectorAll('[data-testid="caja-badge"]')).toHaveLength(2);
        expect(container.textContent).not.toContain('Cigarro');
        expect(container.querySelector('[data-testid="nube-number"]').textContent).toBe('A-00001');
        const dates = [...container.querySelectorAll('[data-testid="sale-datetime"]')].map((n) => n.textContent);
        expect(dates[0]).toMatch(/17\/11\/2026/);
        expect(dates[1]).toMatch(/21\/10\/2026/);
        const sellers = [...container.querySelectorAll('[data-testid="sale-seller"]')].map((n) => n.textContent);
        expect(sellers).toEqual(['Ana', 'Luis']);

        const row = container.querySelector('[data-testid="nube-number"]').closest('.cursor-pointer');
        await act(async () => { row.click(); });
        const info = container.querySelector('[data-testid="sale-info"]').textContent;
        expect(info).toContain('Vendedor: Ana');
        expect(info).toContain('#0003235');
        expect(info).toContain('Correlativo nube: A-00001');
        expect(info).toContain('Cliente: Pedro');
        expect(info).toContain('V-12345678');
        expect(info).toContain('0414-0000000');
        expect(info).toContain('Descuento: -$2.00 (10%)');
        expect(container.textContent).toContain('Efectivo en Dólares');
    });
});
