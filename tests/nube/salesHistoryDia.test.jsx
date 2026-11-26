// @vitest-environment jsdom
/**
 * Pestaña «Ventas del día» (todas las cajas): solo dueño/administrador; el cajero ve solo
 * su turno. Lo de otras cajas es de solo lectura; lo de esta caja se puede anular.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/nube/useAllCajasSales', () => ({
    useAllCajasSales: () => ({ sales: [], loading: false, error: null, refresh: () => {} }),
}));

const { default: SalesHistory } = await import('../../src/components/Dashboard/SalesHistory.jsx');

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
const tab = () => container.querySelector('[data-testid="history-tab-dia"]');

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

const daySales = [
    { id: 'b1', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 4, timestamp: '2026-11-17T11:00:00Z', items: [], _deviceId: 'dev-tel', _cajaName: 'Caja 2 teléfono' },
    { id: 'a1', tipo: 'VENTA', status: 'COMPLETADA', totalUsd: 10, timestamp: '2026-11-17T10:00:00Z', items: [], _cajaName: 'Caja 1' },
];

describe('Historial · Ventas del día de todas las cajas', () => {
    it('el cajero no la ve aunque le lleguen datos (solo su turno)', async () => {
        await render({ isAdmin: false, daySales });
        expect(tab()).toBeNull();
    });

    it('sin datos de todas las cajas (Bodega o cajero) no aparece', async () => {
        await render({ isAdmin: true, daySales: null });
        expect(tab()).toBeNull();
    });

    it('el administrador ve las ventas de hoy de todas las cajas con su nombre', async () => {
        await render({ isAdmin: true, daySales, daySalesStatus: { loading: false, error: null, refresh: () => {} } });
        expect(tab().textContent).toMatch(/Ventas del día\s*2/);
        await act(async () => { tab().click(); });
        const names = [...container.querySelectorAll('[data-testid="caja-name-badge"]')].map((b) => b.textContent);
        expect(names).toEqual(['Caja 2 teléfono', 'Caja 1']);
        expect(container.querySelector('[data-testid="history-dia-status"]').textContent).toMatch(/todas las cajas/);
    });

    it('solo se anula lo de esta caja', async () => {
        await render({ isAdmin: true, daySales });
        await act(async () => { tab().click(); });
        const rows = () => [...container.querySelectorAll('[data-testid="caja-name-badge"]')];
        const anularAfterExpand = async (i) => {
            const clickable = rows()[i].closest('[class*="cursor-pointer"]') || rows()[i].closest('div');
            await act(async () => { clickable.click(); });
            return [...container.querySelectorAll('button')].some((b) => /Anular/.test(b.textContent));
        };
        expect(await anularAfterExpand(0)).toBe(false); // otra caja
        expect(await anularAfterExpand(1)).toBe(true);  // esta caja
    });
});
