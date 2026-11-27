// @vitest-environment jsdom
/**
 * TDD — Fase 3: Formulario unificado de producto con 1, 2 y 3 niveles,
 * divulgación progresiva (sin campos de bulto en Unidad simple), matriz de
 * costos/precios y vista previa viva en Caja.
 *
 * Ejecutar: npx vitest run tests/productFormPresentations.test.jsx
 */
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductFormQuick from '../src/components/Products/ProductFormQuick';
import { useProductForm } from '../src/hooks/useProductForm';

vi.mock('../src/context/ProductContext', () => ({
    useProductContext: () => ({
        products: [],
        categories: [
            { id: 'salud', label: 'Salud', icon: '◆', color: 'emerald' },
            { id: 'otros', label: 'Otros', icon: '◆', color: 'emerald' },
        ],
        setCategories: vi.fn(),
        granelUnitMode: 'kg_lt',
    }),
}));

vi.mock('../src/components/Toast', () => ({ showToast: vi.fn() }));

function Harness({ initialProduct = null }) {
    const form = useProductForm();
    const [priceCop, setPriceCop] = useState('');
    const [unitPriceCop, setUnitPriceCop] = useState('');
    const [costCop, setCostCop] = useState('');

    React.useEffect(() => {
        if (initialProduct) {
            form.populateForm(initialProduct, 50);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <ProductFormQuick
            {...form}
            handlePriceUsdChange={form.setPriceUsd}
            handlePriceBsChange={form.setPriceBs}
            handlePriceCopChange={setPriceCop}
            priceCop={priceCop}
            handleCostUsdChange={form.setCostUsd}
            handleCostBsChange={form.setCostBs}
            handleCostCopChange={setCostCop}
            costCop={costCop}
            handleCostFactorChange={form.setCostFactor}
            unitPriceCop={unitPriceCop}
            setUnitPriceCop={setUnitPriceCop}
            effectiveRate={50}
            copEnabled={false}
            copPrimary={false}
            tasaCop={0}
            handleImageUpload={() => {}}
            categories={[
                { id: 'salud', label: 'Salud', icon: '◆', color: 'emerald' },
                { id: 'otros', label: 'Otros', icon: '◆', color: 'emerald' },
            ]}
            isSearchingImage={false}
            handleLoadImageFromUrl={() => {}}
            handleAutoSearchImage={() => {}}
            imageMatches={[]}
            setImageMatches={() => {}}
            handleSelectImage={() => {}}
        />
    );
}

describe('Fase 3 — ProductFormQuick multinivel e intuitivo', () => {
    let container;
    let root;

    beforeEach(() => {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        container?.remove();
    });

    function setInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    it('en Unidad simple oculta inputs de Uds. por Bulto/Caja por defecto', async () => {
        await act(async () => root.render(<Harness />));

        expect(container.textContent).not.toContain('Uds. por Bulto / Caja');
        expect(container.querySelector('[aria-label="Cantidad en Bulto"]')).toBeNull();
        expect(container.textContent).toContain('Unidad simple');
        expect(container.textContent).toContain('Presentaciones');
    });

    it('al activar Presentaciones con plantilla de 3 niveles muestra cadena de equivalencias y desglose de stock', async () => {
        await act(async () => root.render(<Harness />));

        const multiBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Presentaciones'));
        expect(multiBtn).toBeTruthy();
        await act(async () => multiBtn.click());

        const pharmaPreset = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Caja + Blíster + Tableta'));
        expect(pharmaPreset).toBeTruthy();
        await act(async () => pharmaPreset.click());

        const chain = container.querySelector('[data-testid="equivalence-chain"]');
        expect(chain?.textContent).toContain('1 Caja = 3 Blísters = 30 Tabletas');

        // Editar stock desglosado: 2 Cajas + 1 Blíster + 4 Tabletas = 74 Tabletas
        const stockPack = container.querySelector('input[aria-label="Stock en Caja"]');
        const stockMid = container.querySelector('input[aria-label="Stock en Blíster"]');
        const stockUnit = container.querySelector('input[aria-label="Stock en Tableta"]');
        expect(stockPack && stockMid && stockUnit).toBeTruthy();

        await act(async () => setInputValue(stockPack, '2'));
        await act(async () => setInputValue(stockMid, '1'));
        await act(async () => setInputValue(stockUnit, '4'));

        const totalBadge = container.querySelector('[data-testid="stock-total-base"]');
        expect(totalBadge?.textContent).toContain('74');
    });

    it('reparte automáticamente el costo ingresado por Caja hacia Blíster y Tableta', async () => {
        await act(async () => root.render(<Harness />));

        const multiBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Presentaciones'));
        await act(async () => multiBtn.click());
        const pharmaPreset = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Caja + Blíster + Tableta'));
        await act(async () => pharmaPreset.click());

        const costSourceCaja = Array.from(container.querySelectorAll('button[data-testid="cost-source-pack"]'))[0];
        expect(costSourceCaja).toBeTruthy();
        await act(async () => costSourceCaja.click());

        const costInput = container.querySelector('input[aria-label="Costo en USD"]');
        expect(costInput).toBeTruthy();
        await act(async () => setInputValue(costInput, '6'));

        expect(container.textContent).toContain('$2.00 / Blíster');
        expect(container.textContent).toContain('$0.20 / Tableta');
    });

    it('alerta en vista previa si una presentación mayor resulta más cara por unidad que vender suelto', async () => {
        await act(async () => root.render(
            <Harness
                initialProduct={{
                    id: 'med-1',
                    name: 'Acetaminofen 500mg',
                    packagingMode: 'multilevel',
                    packagingType: 'lote',
                    unitsPerPackage: 10,
                    sellByUnit: true,
                    priceUsd: 4.0,
                    unitPriceUsd: 0.3,
                    costUsd: 2.0,
                    stock: 20,
                    presentations: [
                        { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, costUsd: 0.2 },
                        { id: 'pack', level: 2, name: 'Caja', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 4.0, costUsd: 2.0 },
                    ],
                }}
            />,
        ));

        const preview = container.querySelector('[data-testid="product-live-preview"]');
        expect(preview?.textContent).toContain('Acetaminofen 500mg');
        expect(preview?.textContent).toContain('sale más cara que');
    });
});
