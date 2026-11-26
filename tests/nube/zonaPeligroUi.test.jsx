// @vitest-environment jsdom
/**
 * Zona de Peligro en nube: no aparece (ni «Borrar historial» ni «Empezar desde cero») y,
 * si alguien llega al borrado del historial, no vacía las ventas (subirían como bajas de
 * los registros de caja de esta caja). En Bodega sigue igual. Ver zonaPeligro.test.js.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn() } }));
vi.mock('../../src/components/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../src/components/SettingsShared', () => ({
    SectionCard: ({ children, title }) => <section><h2>{title}</h2>{children}</section>,
    Toggle: () => null,
}));
vi.mock('../../src/components/Settings/PairingManager', () => ({ default: () => null }));
vi.mock('../../src/components/Settings/SystemHealthPanel', () => ({ default: () => null }));
vi.mock('../../src/hooks/useSecurity', () => ({ useSecurity: () => ({ fixDuplicateDeviceId: vi.fn() }) }));
vi.mock('../../src/utils/storageService', () => ({ storageService: { setItem: vi.fn(), getItem: vi.fn() } }));

import SettingsTabSistema from '../../src/components/Settings/tabs/SettingsTabSistema';
import { useDataImportExport } from '../../src/hooks/useDataImportExport';
import { storageService } from '../../src/utils/storageService';

const props = {
    deviceId: 'DEVICE-1', idCopied: false, setIdCopied: vi.fn(), isAdmin: true,
    importStatus: null, statusMessage: '', handleExport: vi.fn(), handleImportClick: vi.fn(),
    handleSyncCloud: vi.fn(), dataConflictPending: null, handleDataConflictChoice: vi.fn(),
    lastError: null, onDismissError: vi.fn(), setIsShareOpen: vi.fn(), setShowDeleteConfirm: vi.fn(),
    triggerHaptic: vi.fn(),
};

describe('Zona de Peligro según el modo', () => {
    let container;
    let root;
    beforeEach(() => {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        vi.clearAllMocks();
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllEnvs();
    });

    it('en nube no aparece para el administrador', async () => {
        vi.stubEnv('VITE_NUBE_ACCOUNTS', 'true');
        await act(async () => root.render(<SettingsTabSistema {...props} />));
        expect(container.textContent).not.toContain('Zona de Peligro');
        expect(container.textContent).not.toContain('Borrar historial de ventas');
        expect(container.textContent).not.toContain('Empezar desde cero');
    });

    it('en Bodega sigue con sus dos botones', async () => {
        vi.stubEnv('VITE_NUBE_ACCOUNTS', 'false');
        await act(async () => root.render(<SettingsTabSistema {...props} />));
        expect(container.textContent).toContain('Borrar historial de ventas');
        expect(container.textContent).toContain('Empezar desde cero');
    });

    it('en nube el borrado del historial no vacía las ventas', async () => {
        vi.stubEnv('VITE_NUBE_ACCOUNTS', 'true');
        const { result, rerender } = renderHook(() => useDataImportExport({
            auditLog: vi.fn(), setImportStatus: vi.fn(), setStatusMessage: vi.fn(),
        }));
        await act(async () => result.current.setDeleteInput('ELIMINAR'));
        rerender();
        await act(async () => result.current.handleDeleteAllData());
        expect(storageService.setItem).not.toHaveBeenCalled();
    });
});
