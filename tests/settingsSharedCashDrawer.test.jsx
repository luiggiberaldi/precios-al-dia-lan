// @vitest-environment jsdom
/**
 * Fase 4 — UI de Modo "Caja compartida / Gaveta única" en SettingsTabVentas (Caja & Vuelto).
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSales = { value: [] };

vi.mock('../src/context/ProductContext', () => ({
    useProductContext: () => ({
        checkoutMode: 'pos',
        setCheckoutMode: vi.fn(),
        granelUnitMode: 'kg_lt',
        setGranelUnitMode: vi.fn(),
    }),
}));

vi.mock('../src/utils/storageService', () => ({
    storageService: {
        getItem: vi.fn(async (key, fallback) => (key === 'bodega_sales_v1' ? mockSales.value : fallback)),
        setItem: vi.fn(async () => {}),
    },
}));

vi.mock('../src/hooks/useCloudSync', () => ({ pushLocalSync: vi.fn() }));
vi.mock('../src/nube/businessConfigSync', () => ({ notifyBusinessConfigChanged: vi.fn() }));
vi.mock('../src/nube/sharedCashShiftBridge', () => ({ pullSharedCashNow: vi.fn(async () => 0) }));
vi.mock('../src/components/Settings/PaymentMethodsManager', () => ({ default: () => <div data-testid="pm-stub" /> }));
vi.mock('../src/components/Settings/TouchKeypadSetting', () => ({ default: () => <div data-testid="tk-stub" /> }));
vi.mock('../src/components/Settings/PrinterHardwareManager', () => ({ default: () => <div data-testid="pr-stub" /> }));

import SettingsTabVentas from '../src/components/Settings/tabs/SettingsTabVentas';
import { CASH_DRAWER_MODE_KEY } from '../src/utils/cashDrawerMode';

describe('Fase 4 — SettingsTabVentas: Modo de operación multi-caja', () => {
    let container;
    let root;

    beforeEach(() => {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        localStorage.clear();
        localStorage.setItem('settings_ventas_active_subtab', 'caja');
        mockSales.value = [];
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        container?.remove();
    });

    it('arranca en Cajas independientes por defecto y permite activar Caja compartida cuando no hay turno abierto', async () => {
        const showToast = vi.fn();
        await act(async () => {
            root.render(
                <SettingsTabVentas
                    allowNegativeStock={false}
                    setAllowNegativeStock={vi.fn()}
                    forceHeartbeat={vi.fn()}
                    showToast={showToast}
                    triggerHaptic={vi.fn()}
                    paperWidth="58mm"
                    setPaperWidth={vi.fn()}
                />,
            );
        });

        const sepBtn = container.querySelector('[data-testid="cash-drawer-mode-separate"]');
        const sharedBtn = container.querySelector('[data-testid="cash-drawer-mode-shared"]');
        expect(sepBtn?.getAttribute('aria-checked')).toBe('true');
        expect(sharedBtn?.getAttribute('aria-checked')).toBe('false');
        expect(sharedBtn?.disabled).toBe(false);

        await act(async () => sharedBtn.click());

        expect(localStorage.getItem(CASH_DRAWER_MODE_KEY)).toBe('shared');
        expect(sharedBtn?.getAttribute('aria-checked')).toBe('true');
        expect(showToast).toHaveBeenCalledWith('Modo Caja compartida (Gaveta única) activado', 'success');
    });

    it('bloquea el cambio de modo mientras haya un turno de caja abierto', async () => {
        mockSales.value = [{
            id: 'ap_open',
            tipo: 'APERTURA_CAJA',
            openingUsd: 20,
            cajaCerrada: false,
            timestamp: new Date().toISOString(),
        }];

        await act(async () => {
            root.render(
                <SettingsTabVentas
                    allowNegativeStock={false}
                    setAllowNegativeStock={vi.fn()}
                    forceHeartbeat={vi.fn()}
                    showToast={vi.fn()}
                    triggerHaptic={vi.fn()}
                    paperWidth="58mm"
                    setPaperWidth={vi.fn()}
                />,
            );
        });

        const sharedBtn = container.querySelector('[data-testid="cash-drawer-mode-shared"]');
        expect(sharedBtn?.disabled).toBe(true);
        expect(container.textContent).toContain('Cierra el turno de caja actual');
    });
});
