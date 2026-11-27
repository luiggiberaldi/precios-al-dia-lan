/**
 * TDD — Modelo puro de presentaciones de 1, 2 y 3 niveles.
 * Ejecutar: npx vitest run tests/presentations.test.js
 */
import { describe, it, expect } from 'vitest';
import {
    PRESENTATION_PRESETS,
    normalizePriceUsd,
    buildPresetPresentations,
    computeFactorToBase,
    reconcileCostCascade,
    suggestLevelPrice,
    resolveProductPresentations,
    getSellablePresentations,
    getPrimarySellablePresentation,
    findPresentationByBarcode,
    decomposeStockByLevels,
    composeBaseStock,
    validatePresentationCoherence,
    projectLegacyFieldsFromPresentations,
} from '../src/utils/presentations.js';

describe('presentations.js — presets y factores en cascada', () => {
    it('construye preset simple de 1 nivel', () => {
        const levels = buildPresetPresentations('simple');
        expect(levels).toHaveLength(1);
        expect(levels[0]).toMatchObject({
            id: 'unit',
            level: 1,
            name: 'Unidad',
            containsQty: 1,
            factorToBase: 1,
            sellable: true,
        });
    });

    it('construye preset de 2 niveles (Caja + Unidad)', () => {
        const levels = buildPresetPresentations('caja_unidad');
        expect(levels).toHaveLength(2);
        expect(levels[0].id).toBe('unit');
        expect(levels[1]).toMatchObject({
            id: 'pack',
            level: 2,
            name: 'Caja',
            containsQty: 12,
            factorToBase: 12,
        });
    });

    it('construye preset de 3 niveles estilo farmacia con factores en cascada', () => {
        expect(PRESENTATION_PRESETS.caja_blister_tableta).toBeDefined();
        const levels = buildPresetPresentations('caja_blister_tableta');
        expect(levels).toHaveLength(3);
        expect(levels.map(l => [l.id, l.name, l.containsQty, l.factorToBase])).toEqual([
            ['unit', 'Tableta', 1, 1],
            ['mid', 'Blíster', 10, 10],
            ['pack', 'Caja', 3, 30],
        ]);
    });

    it('computeFactorToBase recalcula factores al editar containsQty y normaliza bordes', () => {
        const updated = computeFactorToBase([
            { id: 'unit', name: '  Sobre  ', containsQty: 0, sellable: true },
            { id: 'mid', name: 'Display', containsQty: 12, sellable: true },
            { id: 'pack', name: 'Bulto', containsQty: 6, sellable: false },
        ]);
        expect(updated.map(l => ({ id: l.id, level: l.level, name: l.name, factorToBase: l.factorToBase }))).toEqual([
            { id: 'unit', level: 1, name: 'Sobre', factorToBase: 1 },
            { id: 'mid', level: 2, name: 'Display', factorToBase: 12 },
            { id: 'pack', level: 3, name: 'Bulto', factorToBase: 72 },
        ]);
    });
});

describe('presentations.js — reparto de costo y precios sugeridos', () => {
    it('reconcileCostCascade reparte el costo de Caja hacia Blíster y Tableta', () => {
        const levels = buildPresetPresentations('caja_blister_tableta');
        const withCosts = reconcileCostCascade(levels, 'pack', 3.6);
        expect(withCosts[2].costUsd).toBe(3.6);
        expect(withCosts[1].costUsd).toBe(1.2);
        expect(withCosts[0].costUsd).toBe(0.12);
    });

    it('reconcileCostCascade escala desde Unidad base hacia Paquete y Caja', () => {
        const levels = buildPresetPresentations('caja_paquete_unidad'); // 1, 6, 24
        const withCosts = reconcileCostCascade(levels, 'unit', 0.25);
        expect(withCosts[0].costUsd).toBe(0.25);
        expect(withCosts[1].costUsd).toBe(1.5);
        expect(withCosts[2].costUsd).toBe(6);
    });

    it('suggestLevelPrice escala y aplica descuento por volumen', () => {
        const levels = buildPresetPresentations('caja_blister_tableta');
        levels[0].priceUsd = 0.5;
        levels[0].priceCop = 2000;

        const blisterAuto = suggestLevelPrice(levels, 'mid', { anchorLevelId: 'unit', discountPct: 10 });
        expect(blisterAuto.priceUsd).toBe(4.5); // 0.5 * 10 * 0.9
        expect(blisterAuto.priceCop).toBe(18000);

        const cajaAuto = suggestLevelPrice(levels, 'pack', { anchorLevelId: 'unit', discountPct: 20 });
        expect(cajaAuto.priceUsd).toBe(12); // 0.5 * 30 * 0.8
    });

    it('normalizePriceUsd mantiene 6 decimales bajo $0.10 y 4 desde $0.10', () => {
        expect(normalizePriceUsd(0.057143)).toBe(0.057143);
        expect(normalizePriceUsd(1.23456)).toBe(1.2346);
    });
});

describe('presentations.js — compatibilidad legacy y desglose de stock', () => {
    it('convierte producto suelto legacy con unitsPerPackage en bulto no vendible (solo inventario)', () => {
        const levels = resolveProductPresentations({
            id: 'p1',
            name: 'Refresco',
            packagingType: 'suelto',
            unitsPerPackage: 24,
            priceUsd: 1.5,
            costUsd: 1.0,
        });
        expect(levels).toHaveLength(2);
        expect(levels[0]).toMatchObject({ id: 'unit', factorToBase: 1, sellable: true, priceUsd: 1.5, costUsd: 1 });
        expect(levels[1]).toMatchObject({ id: 'pack', name: 'Bulto', factorToBase: 24, sellable: false, costUsd: 24 });
        expect(getSellablePresentations(levels)).toHaveLength(1);
    });

    it('convierte producto lote legacy con sellByUnit=true en 2 niveles vendibles', () => {
        const levels = resolveProductPresentations({
            id: 'p2',
            name: 'Harina',
            packagingType: 'lote',
            unit: 'paquete',
            unitsPerPackage: 20,
            sellByUnit: true,
            priceUsdt: 18,
            unitPriceUsd: 1,
            costUsd: 14,
            barcode: '7591',
        });
        expect(levels).toHaveLength(2);
        expect(levels[0]).toMatchObject({ id: 'unit', sellable: true, priceUsd: 1, costUsd: 0.7 });
        expect(levels[1]).toMatchObject({ id: 'pack', factorToBase: 20, sellable: true, priceUsd: 18, costUsd: 14, barcode: '7591' });
        expect(getPrimarySellablePresentation(levels)?.id).toBe('pack');
    });

    it('decomposeStockByLevels y composeBaseStock son inversos exactos en 3 niveles', () => {
        const levels = buildPresetPresentations('caja_blister_tableta'); // 1, 10, 30
        const decomposed = decomposeStockByLevels(74, levels);
        expect(decomposed.parts.map(p => [p.id, p.qty])).toEqual([
            ['pack', 2],
            ['mid', 1],
            ['unit', 4],
        ]);
        expect(decomposed.text).toBe('2 Cajas · 1 Blíster · 4 Tabletas');
        expect(composeBaseStock({ pack: 2, mid: 1, unit: 4 }, levels)).toBe(74);
    });

    it('findPresentationByBarcode identifica escaneo específico de nivel o retorna null si es ambiguo', () => {
        const product = {
            id: 'med-1',
            barcode: '7590001',
            presentations: [
                { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, barcode: null },
                { id: 'mid', level: 2, name: 'Blíster', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.5, barcode: '7590010' },
                { id: 'pack', level: 3, name: 'Caja', containsQty: 3, factorToBase: 30, sellable: true, priceUsd: 7.0, barcode: '7590030' },
            ],
        };
        expect(findPresentationByBarcode(product, '7590010')?.id).toBe('mid');
        expect(findPresentationByBarcode(product, '7590030')?.id).toBe('pack');
        expect(findPresentationByBarcode(product, '7590001')).toBeNull();
    });

    it('validatePresentationCoherence detecta inversión de precio por volumen y margen negativo', () => {
        const levels = [
            { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, costUsd: 0.35 },
            { id: 'pack', level: 2, name: 'Caja', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 3.5, costUsd: 2.0 },
        ];
        const warnings = validatePresentationCoherence(levels);
        expect(warnings.some(w => w.type === 'negative_margin' && w.levelId === 'unit')).toBe(true);
        expect(warnings.some(w => w.type === 'volume_price_inversion')).toBe(true);
    });

    it('projectLegacyFieldsFromPresentations proyecta 3 niveles manteniendo compatibilidad completa', () => {
        const levels = computeFactorToBase([
            { id: 'unit', name: 'Tableta', containsQty: 1, sellable: true, priceUsd: 0.3, priceCop: 1200, costUsd: 0.12 },
            { id: 'mid', name: 'Blíster', containsQty: 10, sellable: true, priceUsd: 2.5, priceCop: 10000, costUsd: 1.2, barcode: '7590010' },
            { id: 'pack', name: 'Caja', containsQty: 3, sellable: true, priceUsd: 7.0, priceCop: 28000, costUsd: 3.6, barcode: '7590030' },
        ]);
        const legacy = projectLegacyFieldsFromPresentations(levels, { packagingMode: 'multilevel', baseBarcode: '7590030' });
        expect(legacy.packagingType).toBe('lote');
        expect(legacy.unit).toBe('paquete');
        expect(legacy.unitsPerPackage).toBe(30);
        expect(legacy.sellByUnit).toBe(true);
        expect(legacy.unitPriceUsd).toBe(0.3);
        expect(legacy.unitPriceCop).toBe(1200);
        expect(legacy.priceUsd).toBe(7);
        expect(legacy.priceUsdt).toBe(7);
        expect(legacy.costUsd).toBe(3.6);
        expect(legacy.midPack).toEqual({ barcode: '7590010', units: 10, name: 'Blíster' });
        expect(legacy.altBarcodes).toEqual(['7590010']);
    });
});
