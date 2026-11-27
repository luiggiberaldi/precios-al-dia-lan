// @vitest-environment jsdom
//
// T07 · slimCashRecord (ganancias sellByUnit + avances de efectivo),
// cola de ventas stockService (onSaleConfirmed, sesión vencida, discardRejected)
// y anulación segura de ventas rechazadas / con cliente borrado (C4, C5, A2, A5, M4).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slimCashRecord } from '../../src/nube/recordSync.js';
import { FinancialEngine } from '../../src/core/FinancialEngine.js';
import { createSaleSubmitter, toServerSale, SALE_REJECTED_KEY } from '../../src/nube/stockService.js';
import { nubeVoidSale, setNubeSaleSubmitter, setNubeVoider } from '../../src/nube/checkoutBridge.js';

function memoryStore() {
    const m = new Map();
    return {
        raw: m,
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

describe('T07 · slimCashRecord financiero, stockService y anulación de rechazadas', () => {
    beforeEach(() => {
        setNubeSaleSubmitter(null);
        setNubeVoider(null);
    });
    afterEach(() => {
        setNubeSaleSubmitter(null);
        setNubeVoider(null);
    });

    it('1. C5 slimCashRecord conserva _unit, costUsd, _mode y _unitsPerPackage -> FinancialEngine calcula ganancia +$5.00 (no -$105.00)', () => {
        const product = {
            id: 'p1',
            name: 'Refresco 2L',
            priceUsdt: 15,
            costUsd: 12, // costo del bulto de 12 unidades ($1.00 c/u)
            unitsPerPackage: 12,
            sellByUnit: true,
            unitPriceUsd: 1.5,
        };
        const rawSale = {
            id: 'sale-unit-1',
            status: 'COMPLETADA',
            totalUsd: 15,
            items: [{
                id: 'p1_unit',
                _originalId: 'p1',
                _mode: 'unit',
                _unitsPerPackage: 12,
                name: 'Refresco 2L (Ud.)',
                qty: 10,
                priceUsd: 1.5,
                costUsd: 1.0, // costo unitario
                packagingType: 'bulto',
            }],
        };

        const slim = slimCashRecord(rawSale);
        expect(slim.items[0].id).toBe('p1_unit');
        expect(slim.items[0]._originalId).toBe('p1');
        expect(slim.items[0].costUsd).toBe(1.0);
        expect(slim.items[0]._mode).toBe('unit');
        expect(slim.items[0]._unitsPerPackage).toBe(12);

        const profitBs = FinancialEngine.calculateAggregateProfit([slim], 50, [product]);
        expect(profitBs / 50).toBeCloseTo(5.0, 2);
    });

    it('2. C5 slimCashRecord conserva campos de avance de efectivo (isCashAdvance, montoEfectivo, montoComision, currency)', () => {
        const rawSale = {
            id: 'sale-adv-1',
            status: 'COMPLETADA',
            totalUsd: 22,
            payments: [{ methodId: 'pago_movil', amountUsd: 22, currency: 'BS', amountBs: 1100 }],
            items: [{
                id: 'adv_1',
                name: 'Avance de Efectivo ($20)',
                qty: 1,
                priceUsd: 22,
                costUsd: 20,
                isCashAdvance: true,
                montoEfectivo: 20,
                montoComision: 2,
                comisionPct: 10,
                currency: 'USD',
            }],
        };

        const slim = slimCashRecord(rawSale);
        expect(slim.items[0].isCashAdvance).toBe(true);
        expect(slim.items[0].montoEfectivo).toBe(20);
        expect(slim.items[0].montoComision).toBe(2);
        expect(slim.items[0].currency).toBe('USD');

        const profitBs = FinancialEngine.calculateAggregateProfit([slim], 50, []);
        expect(profitBs / 50).toBeCloseTo(2.0, 2);
    });

    it('3. A2 stockService: sesión nula online NO se encola como offline; replay() invoca onSaleConfirmed y vacía cola antes de validar nueva venta', async () => {
        const store = memoryStore();
        const confirmed = [];
        let session = null;
        let callCount = 0;

        const client = {
            rpc: vi.fn(async (_fn, args) => {
                callCount += 1;
                return {
                    data: [{ sale_id: args.p_sale.id, number: `#A-0000${callCount}`, already_registered: false, shortages: [] }],
                    error: null,
                };
            }),
        };

        const submitter = createSaleSubmitter({
            client,
            getSession: () => session,
            store,
            onSaleConfirmed: async (saleId, number) => { confirmed.push({ saleId, number }); },
        });

        // 1) Con sesión nula y navegador online -> error de sesión (NO queued como offline!)
        const noSessRes = await submitter.submit(toServerSale({ nubeId: '11111111-1111-4111-8111-111111111111', items: [] }, [{ product_id: 'p1', qty: 1 }]));
        expect(noSessRes.ok).toBe(false);
        expect(noSessRes.queued).toBeFalsy();
        expect(noSessRes.message).toMatch(/sesión/i);
        expect(await submitter.pending()).toBe(0);

        // 2) Encolar una venta offline previa, luego volver online y enviar una nueva venta:
        //    submit() debe reenviar primero la cola (invocando onSaleConfirmed) y validar la nueva online.
        session = 'valid-token';
        await store.setItem('pdn_sale_queue_v1', [toServerSale({ nubeId: '22222222-2222-4222-8222-222222222222', items: [] }, [{ product_id: 'p1', qty: 1 }])]);

        const newSaleId = '33333333-3333-4333-8333-333333333333';
        const res = await submitter.submit(toServerSale({ nubeId: newSaleId, items: [] }, [{ product_id: 'p1', qty: 1 }]));
        expect(res.ok).toBe(true);
        expect(res.queued).toBeFalsy();
        expect(res.number).toBe('#A-00002');
        expect(confirmed).toEqual([{ saleId: '22222222-2222-4222-8222-222222222222', number: '#A-00001' }]);
        expect(await submitter.pending()).toBe(0);
    });

    it('4. C5/A5 nubeVoidSale permite anular/descartar una venta rechazada definitivamente (pdn_sale_rejected_v1) sin bloquearse en P0002', async () => {
        const store = memoryStore();
        const badSaleId = '44444444-4444-4444-8444-444444444444';
        await store.setItem(SALE_REJECTED_KEY, [{
            sale: { id: badSaleId },
            error: 'Producto inválido',
            code: '22023',
            at: new Date().toISOString(),
        }]);

        const submitter = createSaleSubmitter({
            client: { rpc: async () => ({ data: [], error: null }) },
            getSession: () => 'tok',
            store,
        });
        expect(typeof submitter.discardRejected).toBe('function');

        const voider = vi.fn(async () => ({ ok: false, code: 'P0002', message: 'Venta no encontrada' }));
        setNubeSaleSubmitter(submitter);
        setNubeVoider(voider);

        // Como badSaleId está en rejected(), nubeVoidSale la descarta localmente y devuelve null (éxito)
        // sin ni siquiera bloquearse en P0002 del servidor.
        const voidRes = await nubeVoidSale({ id: 'local-bad', nube: { saleId: badSaleId, pending: true } }, 'descartar rechazada');
        expect(voidRes).toBeNull();
        expect(await submitter.rejected()).toHaveLength(0);
        expect(voider).not.toHaveBeenCalled();
    });
});
