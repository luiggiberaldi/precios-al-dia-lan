// @vitest-environment jsdom
/**
 * F7 · panel del dueño: agrega el stock por sede, ordena clientes por deuda y muestra
 * cada pestaña con datos del servidor.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import NubeOwnerDashboard from '../../src/nube/NubeOwnerDashboard';
import { loadStock, loadCustomers } from '../../src/nube/ownerDashboard';

/** Cliente mínimo que responde por tabla. */
function fakeClient(tables) {
    const q = (rows) => {
        const chain = { select: () => chain, eq: () => chain, is: () => chain, order: () => chain, limit: () => chain, then: (res) => res({ data: rows, error: null }) };
        return chain;
    };
    return { from: (t) => q(tables[t] || []), rpc: async () => ({ data: tables.rpc || [], error: null }) };
}

describe('F7 · datos del panel del dueño', () => {
    it('stock por sede y total, con nombres', async () => {
        const client = fakeClient({
            stock_levels: [{ product_id: 'p1', sede_id: 's1', qty: '5' }, { product_id: 'p1', sede_id: 's2', qty: '-1' }],
            account_records: [{ id: 'p1', name: 'Harina' }],
            sedes: [{ id: 's1', name: 'Centro' }, { id: 's2', name: 'Norte' }],
        });
        expect(await loadStock(client)).toEqual({
            products: [{ productId: 'p1', name: 'Harina', total: 4, sedes: { Centro: 5, Norte: -1 } }],
            sedes: ['Centro', 'Norte'],
        });
    });

    it('clientes con saldo, primero los que más deben', async () => {
        const client = fakeClient({
            customer_balances: [{ customer_id: 'a', balance_usd: '2' }, { customer_id: 'b', balance_usd: '-10' }, { customer_id: 'c', balance_usd: '0' }],
            account_records: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }],
        });
        expect(await loadCustomers(client)).toEqual([{ id: 'b', name: 'Beto', balance: -10 }, { id: 'a', name: 'Ana', balance: 2 }]);
    });
});

describe('F7 · pantalla del panel', () => {
    it('muestra hoy, ventas y diferencias', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const loaders = {
            loadDaySummary: async () => [{ device_id: 'd1', caja_letter: 'A', sede_name: 'Centro', ventas: 3, ventas_usd: 30, cobros_usd: 0, egresos_usd: 2, caja_abierta: true }],
            loadRecentSales: async () => [{ id: 's1', number: '#A-00003', total_usd: 12, status: 'completada', offline: true, server_at: new Date().toISOString() }],
            loadDiscrepancies: async () => [{ id: 'x', name: 'Harina', sold_qty: '1', expected_qty: '0', created_at: new Date().toISOString() }],
        };
        await act(async () => { root.render(<NubeOwnerDashboard client={{}} accountName="Bodega Luz" memberName="Luis" onLogout={() => {}} loaders={loaders} />); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container.textContent).toContain('Hoy en todas las cajas');
        expect(container.textContent).toContain('Siguen abiertas: Caja A');

        await act(async () => { container.querySelector('[data-testid="owner-tab-ventas"]').click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(container.textContent).toContain('#A-00003 · sin internet');

        await act(async () => { container.querySelector('[data-testid="owner-tab-diferencias"]').click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(container.textContent).toContain('Se vendieron 1 sin internet cuando había 0');
        act(() => root.unmount());
        container.remove();
    });
});
