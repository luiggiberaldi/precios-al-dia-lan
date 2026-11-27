/**
 * TDD — Integración de presentaciones multinivel en productProcessor,
 * useProductForm, duplicateMerge y supervisorProductCommand.
 * Ejecutar: npx vitest run tests/productProcessorPresentations.test.js
 */
import { describe, it, expect } from 'vitest';
import { buildProductPayload, applyProductFormEdit } from '../src/utils/productProcessor.js';
import { prepareProductFormState } from '../src/hooks/useProductForm.js';
import {
    buildProductRevision,
    extractEditableProductPatch,
    applySupervisorProductCommand,
} from '../src/services/supervisorProductCommand.js';
import { buildMergedProduct } from '../src/utils/duplicateMerge.js';

describe('buildProductPayload — presentaciones de 1, 2 y 3 niveles', () => {
    it('construye payload completo para producto de 3 niveles estilo farmacia con stock desglosado', () => {
        const payload = buildProductPayload({
            name: 'acetaminofen 500mg',
            barcode: '7590030',
            category: 'salud',
            lowStockAlert: '15',
            packagingMode: 'multilevel',
            costSourceLevel: 'pack',
            presentations: [
                { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, sellable: true, priceUsd: 0.3, priceCop: 1200, costUsd: 0.12, barcode: null },
                { id: 'mid', level: 2, name: 'Blíster', containsQty: 10, sellable: true, priceUsd: 2.5, priceCop: 10000, costUsd: 1.2, barcode: '7590010' },
                { id: 'pack', level: 3, name: 'Caja', containsQty: 3, sellable: true, priceUsd: 7.0, priceCop: 28000, costUsd: 3.6, barcode: '7590030' },
            ],
            stockByLevel: { pack: 2, mid: 1, unit: 4 },
            ivaMode: 'exento',
        }, 50);

        expect(payload.name).toBe('Acetaminofen 500mg');
        expect(payload.stock).toBe(74); // 2*30 + 1*10 + 4
        expect(payload.stockInLotes).toBeNull(); // INV-16: no persistir campo truncado
        expect(payload.packagingMode).toBe('multilevel');
        expect(payload.costSourceLevel).toBe('pack');
        expect(payload.presentations.map(l => [l.id, l.factorToBase])).toEqual([
            ['unit', 1],
            ['mid', 10],
            ['pack', 30],
        ]);

        // Proyección legacy coherente
        expect(payload.packagingType).toBe('lote');
        expect(payload.unit).toBe('paquete');
        expect(payload.unitsPerPackage).toBe(30);
        expect(payload.sellByUnit).toBe(true);
        expect(payload.unitPriceUsd).toBe(0.3);
        expect(payload.unitPriceCop).toBe(1200);
        expect(payload.priceUsd).toBe(7);
        expect(payload.priceUsdt).toBe(7);
        expect(payload.priceCop).toBe(28000);
        expect(payload.costUsd).toBe(3.6);
        expect(payload.costBs).toBe(180); // 3.6 * 50
        expect(payload.midPack).toEqual({ barcode: '7590010', units: 10, name: 'Blíster' });
        expect(payload.altBarcodes).toEqual(['7590010']);
        expect(payload.ivaRate).toBe(0);
    });

    it('soporta Unidad simple con bulto solo para inventario (sellable=false)', () => {
        const payload = buildProductPayload({
            name: 'refresco cola',
            barcode: '7591111',
            category: 'bebidas',
            lowStockAlert: '6',
            packagingMode: 'simple',
            costSourceLevel: 'unit',
            presentations: [
                { id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true, priceUsd: 1.5, costUsd: 1.0 },
                { id: 'pack', level: 2, name: 'Bulto', containsQty: 24, sellable: false, priceUsd: null, costUsd: 24.0 },
            ],
            stock: '48',
        }, 50);

        expect(payload.packagingMode).toBe('simple');
        expect(payload.packagingType).toBe('suelto');
        expect(payload.unit).toBe('unidad');
        expect(payload.unitsPerPackage).toBe(24);
        expect(payload.sellByUnit).toBe(false);
        expect(payload.priceUsd).toBe(1.5);
        expect(payload.costUsd).toBe(1);
        expect(payload.stock).toBe(48);
    });

    it('elimina desfase stockInLotes (INV-16) incluso en flujo legacy lote con 1.5 bultos', () => {
        const payload = buildProductPayload({
            name: 'Harina',
            priceUsd: '20',
            costUsd: '15',
            packagingType: 'lote',
            unitsPerPackage: '24',
            stockInLotes: '1.5',
            stock: '36',
            category: 'viveres',
        }, 50);

        expect(payload.stock).toBe(36);
        expect(payload.stockInLotes).toBeNull();
    });

    it('applyProductFormEdit preserva stock concurrente cuando stockTouched=false', () => {
        const updated = applyProductFormEdit(
            { id: 'med-1', name: 'Acetaminofen', stock: 70 },
            { name: 'Acetaminofen Forte', stock: 74, packagingMode: 'multilevel', presentations: [{ id: 'unit', name: 'Tableta', factorToBase: 1, sellable: true, priceUsd: 0.4 }] },
            { stockTouched: false }
        );
        expect(updated.stock).toBe(70);
        expect(updated.name).toBe('Acetaminofen Forte');
        expect(updated.presentations).toHaveLength(1);
    });
});

describe('prepareProductFormState — hidratación de 1, 2 y 3 niveles', () => {
    it('reconstruye packagingMode, presentations y stockByLevel desde producto de 3 niveles', () => {
        const state = prepareProductFormState({
            id: 'med-1',
            name: 'Acetaminofen',
            stock: 74,
            packagingMode: 'multilevel',
            packagingType: 'lote',
            costSourceLevel: 'pack',
            priceUsd: 7,
            costUsd: 3.6,
            presentations: [
                { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, costUsd: 0.12 },
                { id: 'mid', level: 2, name: 'Blíster', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.5, costUsd: 1.2, barcode: '7590010' },
                { id: 'pack', level: 3, name: 'Caja', containsQty: 3, factorToBase: 30, sellable: true, priceUsd: 7, costUsd: 3.6, barcode: '7590030' },
            ],
        }, 50);

        expect(state.packagingMode).toBe('multilevel');
        expect(state.costSourceLevel).toBe('pack');
        expect(state.presentations).toHaveLength(3);
        expect(state.stockByLevel).toEqual({ pack: 2, mid: 1, unit: 4 });
    });

    it('hidrata producto legacy suelto como simple y granel como granel', () => {
        const simple = prepareProductFormState({ id: 'p1', name: 'Agua', priceUsd: 1, stock: 10, packagingType: 'suelto' }, 50);
        const granel = prepareProductFormState({ id: 'p2', name: 'Queso', priceUsd: 8, stock: 2.5, packagingType: 'granel', granelUnit: 'kg' }, 50);

        expect(simple.packagingMode).toBe('simple');
        expect(simple.presentations).toHaveLength(1);
        expect(granel.packagingMode).toBe('granel');
        expect(granel.presentations).toEqual([]);
    });
});

describe('supervisorProductCommand & duplicateMerge — contratos multinivel', () => {
    it('extractEditableProductPatch y buildProductRevision incluyen presentaciones pero ignoran stock', () => {
        const productA = {
            id: 'med-1',
            name: 'Ibuprofeno',
            packagingMode: 'multilevel',
            costSourceLevel: 'pack',
            presentations: [
                { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.25 },
                { id: 'pack', level: 2, name: 'Caja', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.2 },
            ],
            stock: 40,
            updatedAt: '2026-11-27T10:00:00.000Z',
        };
        const productB = { ...productA, stock: 25, updatedAt: '2026-11-27T11:00:00.000Z' };
        const productC = {
            ...productA,
            presentations: [
                { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.30 },
                { id: 'pack', level: 2, name: 'Caja', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.2 },
            ],
        };

        const revA = buildProductRevision(productA);
        expect(revA.length).toBeLessThan(2048);
        expect(revA).toBe(buildProductRevision(productB));
        expect(revA).not.toBe(buildProductRevision(productC));

        const patch = extractEditableProductPatch({ ...productA, stockInLotes: 4, unknown: 'x' });
        expect(patch.presentations).toHaveLength(2);
        expect(patch.packagingMode).toBe('multilevel');
        expect(patch.costSourceLevel).toBe('pack');
        expect(patch.stock).toBeUndefined();
        expect(patch.stockInLotes).toBeUndefined();
        expect(patch.unknown).toBeUndefined();

        const applied = applySupervisorProductCommand([productB], {
            action: 'edit',
            baseRevision: revA,
            product: { id: 'med-1', presentations: productC.presentations, unitPriceUsd: 0.3 },
        });
        expect(applied.product.stock).toBe(25);
        expect(applied.product.presentations[0].priceUsd).toBe(0.3);
    });

    it('buildMergedProduct recolecta barcodes de presentaciones secundarias sin perder stock', () => {
        const keep = { id: 'k1', name: 'Prod', barcode: '111', stock: 10 };
        const dup = {
            id: 'd1',
            name: 'Prod',
            barcode: '222',
            stock: 5,
            presentations: [{ id: 'unit', name: 'Tab', factorToBase: 1 }, { id: 'mid', name: 'Blíster', factorToBase: 10, barcode: '333' }],
        };
        const { merged } = buildMergedProduct(keep, [dup]);
        expect(merged.stock).toBe(15);
        expect(merged.altBarcodes).toEqual(['222', '333']);
        expect(merged.stockInLotes).toBeUndefined();
    });
});
