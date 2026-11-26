// @vitest-environment jsdom
/**
 * Ajustes → Sistema: «Reiniciar la cuenta» solo en nube y solo para el dueño; pide correo
 * y contraseña y, al terminar, cierra la sesión de PIN y recarga. Ver reinicioCuenta.test.js.
 */
import React from 'react';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../src/nube/nubeSupabase', async (orig) => ({
    ...(await orig()),
    getDeviceClient: () => ({ tag: 'device' }),
    createOwnerClient: () => ({ tag: 'owner' }),
}));

import SettingsTabSistema from '../../src/components/Settings/tabs/SettingsTabSistema';
import NubeAccountReset from '../../src/nube/NubeAccountReset';
import { MEMBER_SESSION_KEY } from '../../src/nube/memberSession';

const props = {
    deviceId: 'DEVICE-1', idCopied: false, setIdCopied: vi.fn(), isAdmin: true,
    importStatus: null, statusMessage: '', handleExport: vi.fn(), handleImportClick: vi.fn(),
    handleSyncCloud: vi.fn(), dataConflictPending: null, handleDataConflictChoice: vi.fn(),
    lastError: null, onDismissError: vi.fn(), setIsShareOpen: vi.fn(), setShowDeleteConfirm: vi.fn(),
    triggerHaptic: vi.fn(),
};

const enterAs = (role) => localStorage.setItem(MEMBER_SESSION_KEY, JSON.stringify({ token: 't', memberId: 'm', role, name: 'X' }));

describe('Reiniciar la cuenta en Ajustes → Sistema', () => {
    afterEach(() => {
        cleanup();
        localStorage.clear();
        vi.unstubAllEnvs();
    });

    it('en nube la ve el dueño', () => {
        vi.stubEnv('VITE_NUBE_ACCOUNTS', 'true');
        enterAs('dueno');
        render(<SettingsTabSistema {...props} />);
        expect(screen.queryByTestId('nube-account-reset')).not.toBeNull();
    });

    it('en nube no la ven el administrador ni el cajero', () => {
        vi.stubEnv('VITE_NUBE_ACCOUNTS', 'true');
        for (const role of ['administrador', 'cajero']) {
            enterAs(role);
            render(<SettingsTabSistema {...props} />);
            expect(screen.queryByTestId('nube-account-reset')).toBeNull();
            cleanup();
        }
    });

    it('en Bodega no existe', () => {
        enterAs('dueno');
        render(<SettingsTabSistema {...props} />);
        expect(screen.queryByTestId('nube-account-reset')).toBeNull();
    });

    it('pide correo y contraseña, reinicia, cierra la sesión de PIN y recarga', async () => {
        enterAs('dueno');
        const reset = vi.fn().mockResolvedValue({ epoch: 1 });
        const reload = vi.fn();
        render(<NubeAccountReset deps={{ deviceClient: { tag: 'device' }, makeOwnerClient: () => ({ tag: 'owner' }), reset, reload }} />);
        fireEvent.click(screen.getByTestId('nube-reset-open'));
        expect(screen.getByText(/TODAS las cajas y sedes/)).toBeTruthy();
        expect(screen.getByTestId('nube-reset-submit').disabled).toBe(true);
        fireEvent.change(screen.getByTestId('nube-reset-email'), { target: { value: 'dueno@x.test' } });
        fireEvent.change(screen.getByTestId('nube-reset-password'), { target: { value: 'clave1234' } });
        fireEvent.click(screen.getByTestId('nube-reset-submit'));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(reset).toHaveBeenCalledWith(expect.objectContaining({ email: 'dueno@x.test', password: 'clave1234', ownerClient: { tag: 'owner' } }));
        expect(localStorage.getItem(MEMBER_SESSION_KEY)).toBeNull();
    });

    it('si el servidor lo rechaza, muestra el motivo y no recarga', async () => {
        enterAs('dueno');
        const reset = vi.fn().mockRejectedValue(new Error('Correo o contraseña incorrectos.'));
        const reload = vi.fn();
        render(<NubeAccountReset deps={{ deviceClient: {}, makeOwnerClient: () => ({}), reset, reload }} />);
        fireEvent.click(screen.getByTestId('nube-reset-open'));
        fireEvent.change(screen.getByTestId('nube-reset-email'), { target: { value: 'dueno@x.test' } });
        fireEvent.change(screen.getByTestId('nube-reset-password'), { target: { value: 'mala' } });
        fireEvent.click(screen.getByTestId('nube-reset-submit'));
        await waitFor(() => expect(screen.getByTestId('nube-reset-error').textContent).toMatch(/incorrectos/));
        expect(reload).not.toHaveBeenCalled();
        expect(localStorage.getItem(MEMBER_SESSION_KEY)).not.toBeNull();
    });
});
