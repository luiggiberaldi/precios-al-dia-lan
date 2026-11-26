// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureDeviceSession: vi.fn(),
    getDeviceStatus: vi.fn(),
    listMembers: vi.fn(),
    checkMemberSession: vi.fn(),
    loginWithPin: vi.fn(),
    listOwnerDevices: vi.fn(),
    listTeam: vi.fn(),
    logoutMember: vi.fn(),
    deviceSignOut: vi.fn(),
    wipeLocalData: vi.fn().mockResolvedValue({ discarded: 0 }),
    ownerSignIn: vi.fn(),
    ownerSignOut: vi.fn(),
    getOwnerAccount: vi.fn(),
    revokeDevice: vi.fn(),
    ownerClient: null,
    deviceClient: {
        from: () => ({ select: () => ({ limit: async () => ({ data: [{ status: 'active', max_cajas: 1 }] }) }) }),
        rpc: async () => ({ data: [] }),
    },
    authState: { usuarioActivo: null },
    setState: vi.fn(),
}));

vi.mock('../../src/nube/nubeSupabase', () => ({
    getDeviceClient: () => mocks.deviceClient,
    createOwnerClient: () => mocks.ownerClient ?? {},
}));

vi.mock('../../src/nube/accountService', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        ensureDeviceSession: mocks.ensureDeviceSession,
        getDeviceStatus: mocks.getDeviceStatus,
        listMembers: mocks.listMembers,
        checkMemberSession: mocks.checkMemberSession,
        loginWithPin: mocks.loginWithPin,
        listOwnerDevices: mocks.listOwnerDevices,
        listTeam: mocks.listTeam,
        logoutMember: mocks.logoutMember,
        deviceSignOut: mocks.deviceSignOut,
        ownerSignIn: mocks.ownerSignIn,
        ownerSignOut: mocks.ownerSignOut,
        getOwnerAccount: mocks.getOwnerAccount,
        revokeDevice: mocks.revokeDevice,
    };
});

vi.mock('../../src/nube/accountReset', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        wipeLocalData: mocks.wipeLocalData,
    };
});

vi.mock('../../src/hooks/store/useAuthStore', () => {
    const useAuthStore = (selector) => (selector ? selector(mocks.authState) : mocks.authState);
    useAuthStore.setState = mocks.setState;
    return { useAuthStore };
});

import NubeGate from '../../src/nube/NubeGate';

let container;
let root;

async function render() {
    await act(async () => {
        root.render(<NubeGate><div data-testid="app">APP</div></NubeGate>);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('NubeGate (F1)', () => {
    beforeEach(() => {
        localStorage.clear();
        Object.values(mocks).forEach((m) => typeof m?.mockReset === 'function' && m.mockReset());
        mocks.wipeLocalData.mockResolvedValue({ discarded: 0 });
        mocks.authState.usuarioActivo = null;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('sin sesiones anónimas en el servidor muestra un mensaje claro y no abre la app', async () => {
        mocks.ensureDeviceSession.mockRejectedValue({ message: 'Anonymous sign-ins are disabled' });
        await render();
        expect(container.textContent).toContain('No pudimos conectar');
        expect(container.textContent).toMatch(/sesiones anónimas apagadas/);
        expect(container.querySelector('[data-testid="app"]')).toBeNull();
    });

    it('equipo sin registrar pide al dueño su correo y clave', async () => {
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue(null);
        await render();
        expect(container.textContent).toContain('Registra este equipo');
        expect(container.querySelector('input[type="email"]')).not.toBeNull();
    });

    it('equipo registrado muestra los empleados y no la app hasta entrar con PIN', async () => {
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue({
            device: { id: 'PDN-X', caja_letter: 'A', label: 'Caja frente', role: 'caja' },
            account: { name: 'Bodega Luz' }, license: null, sedes: [],
        });
        mocks.listMembers.mockResolvedValue([
            { id: 'm1', display_name: 'Luis', role: 'dueno' },
            { id: 'm2', display_name: 'María', role: 'cajero' },
        ]);
        await render();
        expect(container.textContent).toContain('¿Quién está operando?');
        expect(container.textContent).toContain('Caja A');
        expect(container.textContent).toContain('María');
        expect(container.querySelector('[data-testid="app"]')).toBeNull();
    });

    it('«Equipos y empleados» pide el PIN del dueño (no el correo) y abre el panel', async () => {
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue({
            device: { id: 'PDN-X', caja_letter: 'A', label: 'Caja frente', role: 'caja' },
            account: { id: 'acc', name: 'Bodega Luz' }, license: null, sedes: [],
        });
        mocks.listMembers.mockResolvedValue([
            { id: 'm1', display_name: 'Luis', role: 'dueno' },
            { id: 'm2', display_name: 'María', role: 'cajero' },
        ]);
        mocks.loginWithPin.mockResolvedValue({ token: 'tok-dueno', memberId: 'm1', name: 'Luis', role: 'dueno' });
        mocks.listOwnerDevices.mockResolvedValue([{ id: 'PDN-X', label: 'Caja frente', role: 'caja', caja_letter: 'A' }]);
        mocks.listTeam.mockResolvedValue([{ id: 'm1', display_name: 'Luis', role: 'dueno', active: true }]);
        await render();
        await act(async () => { container.querySelector('[data-testid="nube-manage"]').click(); });
        expect(container.querySelector('input[type="email"]')).toBeNull();
        expect(container.textContent).toContain('PIN del dueño');
        const input = container.querySelector('input[type="tel"]');
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, '482913');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(mocks.loginWithPin).toHaveBeenCalledWith(mocks.deviceClient, 'm1', '482913');
        expect(mocks.listOwnerDevices).toHaveBeenCalledWith(mocks.deviceClient);
        expect(container.textContent).toContain('Caja frente');
        expect(container.textContent).not.toContain('¿Quién está operando?');
        // La sesión del panel no abre la app como el dueño.
        expect(localStorage.getItem('pdn-member-session')).toBeNull();
    });

    it('con una sesión de PIN vigente abre la app directamente', async () => {
        localStorage.setItem('pdn-member-session', JSON.stringify({
            token: 't1', memberId: 'm2', name: 'María', role: 'cajero',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }));
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue({ device: { id: 'PDN-X' }, account: {}, license: null, sedes: [] });
        mocks.checkMemberSession.mockResolvedValue({ memberId: 'm2', name: 'María', role: 'cajero' });
        mocks.authState.usuarioActivo = { id: 'm2' };
        await render();
        expect(container.querySelector('[data-testid="app"]')).not.toBeNull();
        expect(mocks.setState).toHaveBeenCalledWith(expect.objectContaining({
            usuarioActivo: { id: 'm2', nombre: 'María', rol: 'CAJERO', nube: true },
        }));
    });

    it('cerrar sesión de la nube pide confirmación y sale al login de correo y contraseña', async () => {
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue({
            device: { id: 'PDN-X', caja_letter: 'A', label: 'Caja 1', role: 'caja' },
            account: { name: 'prueba pc' }, license: null, sedes: [{ id: 's1', name: 'Principal' }],
        });
        mocks.listMembers.mockResolvedValue([
            { id: 'm1', display_name: 'Luigi', role: 'dueno' },
            { id: 'm2', display_name: 'Jose', role: 'cajero' },
        ]);
        await render();
        expect(container.textContent).toContain('¿Quién está operando?');

        const btn = container.querySelector('[data-testid="nube-signout-account"]');
        expect(btn).not.toBeNull();
        await act(async () => { btn.click(); });

        const modal = container.querySelector('[data-testid="nube-confirm"]');
        expect(modal).not.toBeNull();
        expect(modal.textContent).toContain('¿Cerrar sesión de la nube?');
        expect(mocks.deviceSignOut).not.toHaveBeenCalled();

        await act(async () => { modal.querySelector('[data-testid="nube-confirm-ok"]').click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        expect(mocks.wipeLocalData).toHaveBeenCalledWith({}, { keepSettings: false });
        expect(mocks.deviceSignOut).toHaveBeenCalledWith(mocks.deviceClient);
        expect(container.querySelector('input[type="email"]')).not.toBeNull();
        expect(container.querySelector('input[type="password"]')).not.toBeNull();
        expect(container.textContent).toContain('Registra este equipo');
    });
});

describe('NubeGate · E10 equipo expulsado', () => {
    it('al volver a la pestaña, si el equipo ya no está registrado cierra la sesión y lo explica', async () => {
        const container2 = document.createElement('div');
        document.body.appendChild(container2);
        const root2 = createRoot(container2);
        localStorage.setItem('pdn-member-session', JSON.stringify({
            token: 't1', memberId: 'm2', name: 'María', role: 'cajero', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }));
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValueOnce({ device: { id: 'PDN-X' }, account: {}, license: null, sedes: [] });
        mocks.checkMemberSession.mockResolvedValue({ memberId: 'm2', name: 'María', role: 'cajero' });
        mocks.authState.usuarioActivo = { id: 'm2' };
        await act(async () => { root2.render(<NubeGate><div data-testid="app">APP</div></NubeGate>); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container2.querySelector('[data-testid="app"]')).not.toBeNull();

        mocks.getDeviceStatus.mockResolvedValue(null);
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 0)); });
        expect(container2.querySelector('[data-testid="app"]')).toBeNull();
        expect(container2.textContent).toContain('quitó este equipo');
        expect(localStorage.getItem('pdn-member-session')).toBeNull();
        act(() => root2.unmount());
        container2.remove();
    });
});

describe('NubeGate · clave del dueño olvidada', () => {
    it('al volver del enlace de recuperación pide la clave nueva y borra el token de la URL', async () => {
        const container3 = document.createElement('div');
        document.body.appendChild(container3);
        const root3 = createRoot(container3);
        window.history.replaceState(null, '', '/#access_token=aaa&refresh_token=bbb&type=recovery');
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue(null);
        await act(async () => { root3.render(<NubeGate><div data-testid="app">APP</div></NubeGate>); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container3.textContent).toContain('Nueva contraseña');
        expect(window.location.hash).toBe('');
        act(() => root3.unmount());
        container3.remove();
    });

    it('si el enlace venció lo dice en la pantalla del dueño', async () => {
        const container4 = document.createElement('div');
        document.body.appendChild(container4);
        const root4 = createRoot(container4);
        window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired');
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue(null);
        await act(async () => { root4.render(<NubeGate><div data-testid="app">APP</div></NubeGate>); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container4.textContent).toContain('Este enlace ya no sirve');
        expect(container4.textContent).toContain('El enlace venció');
        act(() => root4.unmount());
        container4.remove();
    });

    it('al volver de «Confirmar mi correo» muestra «¡Correo confirmado!» y luego la pantalla de entrar', async () => {
        const container5 = document.createElement('div');
        document.body.appendChild(container5);
        const root5 = createRoot(container5);
        window.history.replaceState(null, '', '/#access_token=aaa&refresh_token=bbb&type=signup');
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue(null);
        await act(async () => { root5.render(<NubeGate><div data-testid="app">APP</div></NubeGate>); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container5.textContent).toContain('¡Correo confirmado!');
        expect(window.location.hash).toBe('');
        const entrar = [...container5.querySelectorAll('button')].find((b) => b.textContent.includes('Entrar con mi cuenta'));
        await act(async () => { entrar.click(); });
        expect(container5.textContent).not.toContain('¡Correo confirmado!');
        expect(container5.querySelector('input[type="email"]')).not.toBeNull();
        act(() => root5.unmount());
        container5.remove();
    });
    it('desvincular un equipo desde «Este equipo es…» deja al dueño en la misma pantalla (sin pedir el correo otra vez)', async () => {
        // Cliente del dueño con las consultas de sedes y licencia.
        const chain = (data) => { const c = { select: () => c, is: () => c, order: async () => ({ data }), limit: async () => ({ data }) }; return c; };
        mocks.ownerClient = { from: (t) => chain(t === 'sedes' ? [{ id: 's1', name: 'Principal' }] : [{ status: 'active', max_cajas: 1 }]) };
        mocks.ensureDeviceSession.mockResolvedValue('device-uid');
        mocks.getDeviceStatus.mockResolvedValue(null);
        mocks.ownerSignIn.mockResolvedValue(undefined);
        mocks.getOwnerAccount.mockResolvedValue({ id: 'acc', name: 'Bodega Luz' });
        mocks.listOwnerDevices
            .mockResolvedValueOnce([{ id: 'PDN-1', label: 'Caja vieja', role: 'caja', caja_letter: 'A' }])
            .mockResolvedValueOnce([]);
        mocks.revokeDevice.mockResolvedValue(undefined);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root6 = createRoot(container);
        await act(async () => { root6.render(<NubeGate><div data-testid="app">APP</div></NubeGate>); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        const setValue = async (el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
        };
        const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
        await setValue(container.querySelector('input[type="email"]'), 'dueno@ejemplo.com');
        await setValue(container.querySelector('input[type="password"]'), 'clave-de-prueba');
        await act(async () => { container.querySelector('[data-testid="nube-owner-submit"]').click(); });
        await flush();
        expect(container.textContent).toContain('Este equipo es');
        expect(container.textContent).toContain('Caja vieja');
        expect(container.querySelector('[data-testid="nube-register-full"]')).not.toBeNull();

        await act(async () => { container.querySelector('button[aria-label="Desvincular Caja vieja"]').click(); });
        await act(async () => { document.body.querySelector('[data-testid="nube-confirm-ok"]').click(); });
        await flush();

        expect(mocks.revokeDevice).toHaveBeenCalledWith(mocks.ownerClient, 'PDN-1');
        expect(mocks.ownerSignOut).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Este equipo es');
        expect(container.textContent).not.toContain('Caja vieja');
        expect(container.querySelector('[data-testid="nube-register-full"]')).toBeNull();
        expect(container.querySelector('input[type="email"]')).toBeNull();
        mocks.ownerClient = null;
        act(() => root6.unmount());
        container.remove();
    });
});
