// @vitest-environment jsdom
/**
 * TDD — Fase 4: Venta en Caja (SearchBar, CategoryBar), Tarjeta de Inventario
 * (ProductCard) y Ajuste por Lotes (StockBatchModal) con 1, 2 y 3 niveles.
 *
 * Ejecutar: npx vitest run tests/salesAndInventoryMultilevel.test.jsx
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/SmartImage', () => ({ default: () => null }));
vi.mock('../src/components/Toast', () => ({ showToast: vi.fn() }));

import SearchBar from '../src/components/Sales/SearchBar';
import CategoryBar from '../src/components/Sales/CategoryBar';
import ProductCard from '../src/components/Products/ProductCard';
import StockBatchModal from '../src/components/Products/StockBatchModal';

const PHARMA_3_LEVEL = {
    id: 'med-1',
    name: 'Acetaminofen 500mg',
    barcode: '7590001',
    category: 'otros',
    packagingMode: 'multilevel',
    packagingType: 'lote',
    unit: 'paquete',
    unitsPerPackage: 30,
    sellByUnit: true,
    priceUsd: 7.0,
    priceUsdt: 7.0,
    unitPriceUsd: 0.3,
    costUsd: 3.6,
    stock: 74,
    lowStockAlert: 10,
    presentations: [
        { id: 'unit', level: 1, name: 'Tableta', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.3, costUsd: 0.12, barcode: null },
        { id: 'mid', level: 2, name: 'Blíster', containsQty: 10, factorToBase: 10, sellable: true, priceUsd: 2.5, costUsd: 1.2, barcode: '7590010' },
        { id: 'pack', level: 3, name: 'Caja', containsQty: 3, factorToBase: 30, sellable: true, priceUsd: 7.0, costUsd: 3.6, barcode: '7590030' },
    ],
};

const TWO_LEVEL_CUSTOM = {
    id: 'snack-1',
    name: 'Café Instantáneo',
    category: 'otros',
    packagingMode: 'multilevel',
    packagingType: 'lote',
    unit: 'paquete',
    unitsPerPackage: 12,
    sellByUnit: true,
    priceUsd: 6.0,
    priceUsdt: 6.0,
    unitPriceUsd: 0.6,
    costUsd: 4.0,
    stock: 25,
    presentations: [
        { id: 'unit', level: 1, name: 'Sobre', containsQty: 1, factorToBase: 1, sellable: true, priceUsd: 0.6, costUsd: 0.33 },
        { id: 'pack', level: 2, name: 'Display', containsQty: 12, factorToBase: 12, sellable: true, priceUsd: 6.0, costUsd: 4.0 },
    ],
};

describe('Fase 4 — SearchBar & CategoryBar multinivel', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => cleanup());

    it('SearchBar renderiza 3 tarjetas personalizadas en hierarchyPending y envía forceMode exacto', () => {
        const addToCart = vi.fn();
        render(
            <SearchBar
                searchTerm=""
                onSearchChange={vi.fn()}
                onKeyDown={vi.fn()}
                searchResults={[]}
                selectedIndex={0}
                setSelectedIndex={vi.fn()}
                handlePasteBarcode={vi.fn()}
                addToCart={addToCart}
                effectiveRate={50}
                tasaCop={0}
                copEnabled={false}
                copPrimary={false}
                hierarchyPending={PHARMA_3_LEVEL}
                setHierarchyPending={vi.fn()}
                weightPending={null}
                setWeightPending={vi.fn()}
                posSearchViewMode="hybrid"
                onViewModeChange={vi.fn()}
            />,
        );

        const blisterBtn = screen.getByTestId('hierarchy-option-mid');
        const cajaBtn = screen.getByTestId('hierarchy-option-pack');
        const tabBtn = screen.getByTestId('hierarchy-option-unit');

        expect(blisterBtn.textContent).toContain('Blíster');
        expect(blisterBtn.textContent).toContain('10 Tabletas');
        expect(cajaBtn.textContent).toContain('Caja');
        expect(cajaBtn.textContent).toContain('30 Tabletas');
        expect(tabBtn.textContent).toContain('Tableta');
        expect(tabBtn.textContent).toContain('$0.30');

        fireEvent.click(blisterBtn);
        expect(addToCart).toHaveBeenCalledWith(PHARMA_3_LEVEL, null, 'mid');
    });

    it('CategoryBar muestra nombres personalizados en 2 niveles y selector de 3 pres. en 3 niveles', () => {
        const addToCart = vi.fn();
        render(
            <CategoryBar
                products={[TWO_LEVEL_CUSTOM, PHARMA_3_LEVEL]}
                filteredByCategory={[TWO_LEVEL_CUSTOM, PHARMA_3_LEVEL]}
                categories={[{ id: 'todos', label: 'Todos' }, { id: 'otros', label: 'Otros' }]}
                selectedCategory="todos"
                setSelectedCategory={vi.fn()}
                cart={[]}
                addToCart={addToCart}
                effectiveRate={50}
                tasaCop={0}
                copEnabled={false}
                copPrimary={false}
                triggerHaptic={vi.fn()}
                searchTerm=""
                deferredSearchTerm=""
                posSearchViewMode="grid"
                onOpenCustomAmount={vi.fn()}
            />,
        );

        // 2 niveles personalizados
        const displayBtn = screen.getByTestId(`pos-level-btn-${TWO_LEVEL_CUSTOM.id}-pack`);
        const sobreBtn = screen.getByTestId(`pos-level-btn-${TWO_LEVEL_CUSTOM.id}-unit`);
        expect(displayBtn.textContent).toContain('Display');
        expect(displayBtn.textContent).toContain('x12');
        expect(sobreBtn.textContent).toContain('Sobre');
        fireEvent.click(sobreBtn);
        expect(addToCart).toHaveBeenCalledWith(TWO_LEVEL_CUSTOM, null, 'unit');

        // 3 niveles: botón principal Caja + botón "3 pres." que abre hierarchyPending
        const elegirBtn = screen.getByTestId(`pos-choose-pres-${PHARMA_3_LEVEL.id}`);
        expect(elegirBtn.textContent).toContain('3 pres');
        fireEvent.click(elegirBtn);
        expect(addToCart).toHaveBeenCalledWith(PHARMA_3_LEVEL);
    });
});

describe('Fase 4 — ProductCard y StockBatchModal multinivel', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => cleanup());

    it('ProductCard muestra desglose de stock de 3 niveles y precios reales por nivel', () => {
        render(
            <ProductCard
                product={PHARMA_3_LEVEL}
                effectiveRate={50}
                streetRate={0}
                categories={[]}
                onAdjustStock={vi.fn()}
                onSetDirectStock={vi.fn()}
                onEdit={vi.fn()}
                onDelete={vi.fn()}
                onPrint={vi.fn()}
            />,
        );

        expect(document.body.textContent).toContain('2 Cajas · 1 Blíster · 4 Tabletas');
        expect(document.body.textContent).toContain('Blíster');
        expect(document.body.textContent).toContain('Tableta');
    });

    it('StockBatchModal permite seleccionar nivel intermedio (Blíster ×10) y sumar +30 unidades', async () => {
        const adjustStock = vi.fn(async () => {});
        const onClose = vi.fn();

        render(
            <StockBatchModal
                isOpen
                onClose={onClose}
                products={[PHARMA_3_LEVEL]}
                categories={[{ id: 'otros', label: 'Otros' }]}
                adjustStock={adjustStock}
                setProducts={vi.fn()}
                triggerHaptic={vi.fn()}
            />,
        );

        // Seleccionar producto desde el catálogo
        fireEvent.click(screen.getByText('Acetaminofen 500mg'));
        fireEvent.click(screen.getByRole('button', { name: /En ajuste/i }));

        // Elegir Blíster (×10) e ingresar 3
        const blisterToggle = screen.getByRole('button', { name: /Blíster/i });
        fireEvent.click(blisterToggle);

        const qtyInput = document.querySelector('input[inputmode="numeric"]');
        fireEvent.change(qtyInput, { target: { value: '3' } });

        expect(document.body.textContent).toContain('+3 Blísters');
        expect(document.body.textContent).toContain('→ 104');

        fireEvent.click(screen.getByRole('button', { name: /Aplicar Ingreso/i }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Confirmar Ingreso/i }));
        });

        expect(adjustStock).toHaveBeenCalledWith('med-1', 30);
    });
});
