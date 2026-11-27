/**
 * TDD — Fase 2: deducción de stock, etiquetas, cesta viva, códigos de barras,
 * valorización y snapshot de venta para presentaciones de 1, 2 y 3 niveles.
 * Ejecutar: npx vitest run tests/multilevelStockAndCart.test.js
 */
import { describe, it, expect } from 'vitest';
import {
    productHasCode,
    findProductByCode,
    findProductAndPresentationByCode,
    findDuplicateCodeIndex,
} from '../src/utils/barcodeAssign.js';
import { calculateItemStockDeduction, formatPresentationLabel } from '../src/utils/granel.js';
import { deriveCartFields, resyncCartItems, cartLineName } from '../src/utils/cartSync.js';
import {
    isPackageProduct,
    packageFactor,
    perUnitRetailUsd,
    perUnitCostUsd,
    computeInventoryValuation,
} from '../src/utils/inventoryValuation.js';

const MULTILEVEL_MED = {
    id: 'med-1',
    name: 'Acetaminofen 500mg',
    barcode: '7590001',
    packagingMode: 'multilevel',
    packagingType: 'lote',
    unit: 'paquete',
    unitsPerPackage: 30,
    sellByUnit: true,
    priceUsd: 7.0,
    priceUsdt: 7.0,
    priceCop: 28000,
    unitPriceUsd: 0.3,
    unitPriceCop: 1200,
    costUsd: 3.6,
    stock: 74,
    presentations: [
        { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, priceCop: 1200, costUsd: 0.12, barcode: null },
        { id: 'mid', level: 2, name: 'Blíster', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.5, priceCop: 10000, costUsd: 1.2, barcode: '7590010' },
        { id: 'pack', level: 3, name: 'Caja', containsQty: 3, factorToBase: 30, sellable: true, priceUsd: 7.0, priceCop: 28000, costUsd: 3.6, barcode: '7590030' },
    ],
};

const CTX = { tasaCop: 4000, effectiveRate: 50 };

describe('barcodeAssign — búsqueda y colisiones por presentación', () => {
    it('detecta productos por código de cualquier nivel en presentations', () => {
        expect(productHasCode(MULTILEVEL_MED, '7590010')).toBe(true);
        expect(productHasCode(MULTILEVEL_MED, '7590030')).toBe(true);
        expect(findProductByCode([MULTILEVEL_MED], '7590010')?.id).toBe('med-1');
    });

    it('findProductAndPresentationByCode identifica el nivel exacto cuando tiene código propio', () => {
        const blisterHit = findProductAndPresentationByCode([MULTILEVEL_MED], '7590010');
        expect(blisterHit?.product.id).toBe('med-1');
        expect(blisterHit?.presentation?.id).toBe('mid');

        const cajaHit = findProductAndPresentationByCode([MULTILEVEL_MED], '7590030');
        expect(cajaHit?.presentation?.id).toBe('pack');

        const sharedHit = findProductAndPresentationByCode([MULTILEVEL_MED], '7590001');
        expect(sharedHit?.product.id).toBe('med-1');
        expect(sharedHit?.presentation).toBeNull();
    });

    it('findDuplicateCodeIndex detecta código repetido entre presentaciones de distintos productos', () => {
        const other = {
            id: 'med-2',
            name: 'Ibuprofeno',
            barcode: '8880001',
            presentations: [{ id: 'unit', name: 'Tab', factorToBase: 1 }, { id: 'mid', name: 'Blíster', factorToBase: 10, barcode: '7590010' }],
        };
        const dups = findDuplicateCodeIndex([MULTILEVEL_MED, other]);
        expect(dups.get('med-1')).toBe('7590010');
        expect(dups.get('med-2')).toBe('7590010');
    });
});

describe('granel.js — deducción y etiqueta multinivel', () => {
    it('calculateItemStockDeduction multiplica por _factorToBase según presentación elegida', () => {
        expect(calculateItemStockDeduction({ qty: 4, _presentationId: 'unit', _factorToBase: 1 })).toBe(4);
        expect(calculateItemStockDeduction({ qty: 2, _presentationId: 'mid', _factorToBase: 10 })).toBe(20);
        expect(calculateItemStockDeduction({ qty: 1, _presentationId: 'pack', _factorToBase: 30 })).toBe(30);
    });

    it('formatPresentationLabel muestra nombre real de presentación > 1 y oculta unidad base', () => {
        expect(formatPresentationLabel({ _presentationId: 'mid', _presentationName: 'Blíster', _factorToBase: 10 })).toBe('Blíster · 10 uds');
        expect(formatPresentationLabel({ _presentationId: 'pack', _presentationName: 'Caja', _factorToBase: 30 })).toBe('Caja · 30 uds');
        expect(formatPresentationLabel({ _presentationId: 'unit', _presentationName: 'Tableta', _factorToBase: 1 })).toBeNull();
    });
});

describe('cartSync — precios, costos y resincronización por nivel', () => {
    it('deriveCartFields calcula precio y costo exactos para unit, mid y pack', () => {
        const fUnit = deriveCartFields(MULTILEVEL_MED, 'unit', 1, CTX);
        expect(fUnit.priceUsd).toBe(0.3);
        expect(fUnit.priceCop).toBe(1200);
        expect(fUnit.costUsd).toBe(0.12);
        expect(fUnit.costBs).toBe(6);
        expect(fUnit._presentationId).toBe('unit');
        expect(fUnit._factorToBase).toBe(1);

        const fMid = deriveCartFields(MULTILEVEL_MED, 'mid', 10, CTX);
        expect(fMid.priceUsd).toBe(2.5);
        expect(fMid.priceCop).toBe(10000);
        expect(fMid.costUsd).toBe(1.2);
        expect(fMid.costBs).toBe(60);
        expect(fMid._presentationId).toBe('mid');
        expect(fMid._presentationName).toBe('Blíster');
        expect(fMid._factorToBase).toBe(10);

        const fPack = deriveCartFields(MULTILEVEL_MED, 'pack', 30, CTX);
        expect(fPack.priceUsd).toBe(7.0);
        expect(fPack.costUsd).toBe(3.6);
        expect(fPack._presentationId).toBe('pack');
        expect(fPack._factorToBase).toBe(30);
    });

    it('resyncCartItems actualiza el precio del nivel intermedio (Blíster) sin alterar qty ni modo', () => {
        const line = {
            id: 'med-1__mid',
            _originalId: 'med-1',
            name: cartLineName(MULTILEVEL_MED.name, MULTILEVEL_MED.presentations[1]),
            qty: 2,
            isWeight: false,
            _mode: 'mid',
            ...deriveCartFields(MULTILEVEL_MED, 'mid', 10, CTX),
        };

        // Sin cambios: contrato anti-loop retorna null
        expect(resyncCartItems([line], [MULTILEVEL_MED], CTX)).toBeNull();

        const updatedProduct = {
            ...MULTILEVEL_MED,
            name: 'Acetaminofen Forte',
            presentations: MULTILEVEL_MED.presentations.map(l =>
                l.id === 'mid' ? { ...l, priceUsd: 3.0, priceCop: 12000 } : l
            ),
        };
        const synced = resyncCartItems([line], [updatedProduct], CTX);
        expect(synced).not.toBeNull();
        expect(synced.cart[0].priceUsd).toBe(3.0);
        expect(synced.cart[0].priceCop).toBe(12000);
        expect(synced.cart[0].qty).toBe(2);
        expect(synced.cart[0].name).toBe('Acetaminofen Forte (Blíster)');
        expect(synced.priceChanges).toEqual([{ name: 'Acetaminofen Forte', from: 2.5, to: 3.0 }]);
    });
});

describe('inventoryValuation — valorización unitaria en 3 niveles', () => {
    it('valúa stock base usando el costo y precio unitario real sin sobrevaluar ×30', () => {
        expect(isPackageProduct(MULTILEVEL_MED)).toBe(true);
        expect(packageFactor(MULTILEVEL_MED)).toBe(30);
        expect(perUnitRetailUsd(MULTILEVEL_MED)).toBe(0.3);
        expect(perUnitCostUsd(MULTILEVEL_MED)).toBe(0.12);

        const valuation = computeInventoryValuation([MULTILEVEL_MED]);
        expect(valuation.totalUnits).toBe(74);
        expect(valuation.totalRetailUsd).toBe(22.2); // 74 * 0.30
        expect(valuation.totalCostUsd).toBe(8.88);   // 74 * 0.12
    });
});
