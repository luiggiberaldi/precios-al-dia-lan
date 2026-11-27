// @vitest-environment jsdom
//
// T12 · Creación segura de clientes en Ventas/Dashboard bajo pos_write_lock + mergeScreenList (C9)
// y unificación del historial/estado de cuenta multi-caja desde bodega_customer_ledger_v1 (A14, BAJ-02).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    appendCustomerLocked,
    buildUnifiedCustomerHistory,
} from '../../src/utils/customerHistory.js';

function createFakeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: async (k, def = null) => (m.has(k) ? structuredClone(m.get(k)) : def),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
        raw: m,
    };
}

describe('T12 · Creación segura de clientes e historial multi-caja', () => {
    it('1. C9 appendCustomerLocked con estado viejo [c1] preserva c2 creado en otra caja -> [c1, c2, c3]', async () => {
        // React en Caja A todavía ve [c1]
        const staleBase = [{ id: 'c1', code: 'CLI-00001', name: 'Ana', deuda: 0, favor: 0 }];
        // IndexedDB ya recibió c2 desde Caja B por sync
        const storage = createFakeStorage({
            bodega_customers_v1: [
                { id: 'c1', code: 'CLI-00001', name: 'Ana', deuda: 0, favor: 0 },
                { id: 'c2', code: 'CLI-00002', name: 'Luis (Caja B)', deuda: 5, favor: 0 },
            ],
        });

        const { customer: c3, customers: persisted } = await appendCustomerLocked(
            { name: 'Marta', documentId: 'V-123', phone: '0414' },
            { baseCustomers: staleBase, storage },
        );

        expect(c3.code).toBe('CLI-00003');
        expect(persisted.map((c) => c.id)).toContain('c1');
        expect(persisted.map((c) => c.id)).toContain('c2');
        expect(persisted.map((c) => c.id)).toContain(c3.id);
        expect(persisted).toHaveLength(3);
    });

    it('2. A14 buildUnifiedCustomerHistory incluye fiados/abonos de Caja B desde el ledger sin duplicar ventas locales', () => {
        const localSales = [
            {
                id: 'sale-A1',
                customerId: 'c1',
                tipo: 'VENTA_FIADA',
                totalUsd: 15,
                fiadoUsd: 15,
                status: 'COMPLETADA',
                timestamp: '2026-11-26T10:00:00.000Z',
            },
        ];
        const ledger = [
            // Movimiento correspondiente a sale-A1 (local) -> NO debe duplicarse
            {
                id: 'mov-A1',
                customerId: 'c1',
                type: 'VENTA_FIADA',
                direction: 'DEBIT',
                amountUsd: 15,
                sourceSaleId: 'sale-A1',
                reason: 'Venta fiada',
                timestamp: '2026-11-26T10:00:00.000Z',
                status: 'COMPLETED',
            },
            // Abono hecho en Caja B (no existe en localSales de Caja A) -> SÍ debe aparecer
            {
                id: 'mov-B1',
                customerId: 'c1',
                type: 'ABONO_DEUDA',
                direction: 'CREDIT',
                amountUsd: 10,
                sourceSaleId: 'sale-B-abono',
                reason: 'Abono en Caja B',
                timestamp: '2026-11-26T12:00:00.000Z',
                status: 'COMPLETED',
            },
        ];

        const history = buildUnifiedCustomerHistory('c1', localSales, ledger);
        expect(history).toHaveLength(2);
        // Más reciente primero (abono Caja B a las 12:00, luego venta Caja A a las 10:00)
        expect(history[0].id).toBe('mov-B1');
        expect(history[0].tipo).toBe('COBRO_DEUDA');
        expect(history[0].totalUsd).toBe(10);
        expect(history[1].id).toBe('sale-A1');
    });

    it('3. C9 + BAJ-02 useCheckoutFlow, DashboardView y CustomersView usan appendCustomerLocked, buildUnifiedCustomerHistory y app_storage_update', () => {
        const checkoutSrc = readFileSync(join(process.cwd(), 'src', 'hooks', 'useCheckoutFlow.js'), 'utf8');
        const dashSrc = readFileSync(join(process.cwd(), 'src', 'views', 'DashboardView.jsx'), 'utf8');
        const custSrc = readFileSync(join(process.cwd(), 'src', 'views', 'CustomersView.jsx'), 'utf8');

        expect(checkoutSrc).toMatch(/appendCustomerLocked/);
        expect(dashSrc).toMatch(/appendCustomerLocked/);
        expect(custSrc).toMatch(/buildUnifiedCustomerHistory/);
        expect(custSrc).toMatch(/app_storage_update/);
    });
});
