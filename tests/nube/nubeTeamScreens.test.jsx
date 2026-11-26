// @vitest-environment jsdom
/**
 * F1b · pantallas: «¿Quién está operando?», Ajustes → Usuarios con la nube,
 * panel del dueño sin window.prompt y regreso del enlace de clave olvidada.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    listTeam: vi.fn(),
    teamUpsertMember: vi.fn(),
    changeOwnPin: vi.fn(),
    authState: { usuarioActivo: null, usuarios: [] },
}));

vi.mock('../../src/nube/nubeSupabase', () => ({
    getDeviceClient: () => ({}),
    createOwnerClient: () => ({}),
}));

vi.mock('../../src/nube/accountService', async (importOriginal) => {
    const real = await importOriginal();
    return { ...real, listTeam: mocks.listTeam, teamUpsertMember: mocks.teamUpsertMember, changeOwnPin: mocks.changeOwnPin };
});

vi.mock('../../src/hooks/store/useAuthStore', () => {
    const useAuthStore = (selector) => (selector ? selector(mocks.authState) : mocks.authState);
    useAuthStore.setState = vi.fn();
    useAuthStore.getState = () => mocks.authState;
    return { useAuthStore };
});

import { MemberPickerScreen, ManagePanel, OwnerAuthScreen, RegisterDeviceScreen } from '../../src/nube/NubeScreens';
import NubeTeamSettings from '../../src/nube/NubeTeamSettings';
import SettingsTabUsuarios from '../../src/components/Settings/tabs/SettingsTabUsuarios';

let container;
let root;

async function render(el) {
    await act(async () => { root.render(el); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const $ = (sel) => container.querySelector(sel) || document.body.querySelector(sel);
async function click(el) { await act(async () => { el.click(); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function type(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const byText = (text) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes(text));

const STATUS = {
    account: { name: 'Bodega de Prueba Nube' },
    sedes: [{ id: 's1', name: 'Principal' }],
    device: { id: 'PDN-1', sede_id: 's1', caja_letter: 'A', label: 'Caja A', role: 'caja' },
};
const TEAM = [
    { id: 'o1', display_name: 'Dueño Prueba', role: 'dueno', active: true },
    { id: 'a1', display_name: 'Ana', role: 'administrador', active: true },
    { id: 'c1', display_name: 'Luis', role: 'cajero', active: true },
    { id: 'c2', display_name: 'Pepe', role: 'cajero', active: false },
];

describe('F1b · pantallas del equipo', () => {
    beforeEach(() => {
        localStorage.clear();
        Object.values(mocks).forEach((m) => typeof m?.mockReset === 'function' && m.mockReset());
        mocks.authState.usuarioActivo = null;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        document.body.innerHTML = '';
    });

    it('«Este equipo es…» lista los equipos conectados y permite desvincular uno', async () => {
        const onRevoke = vi.fn().mockResolvedValue(undefined);
        const devices = [
            { id: 'PDN-1', label: 'Caja A', role: 'caja', caja_letter: 'A', last_seen_at: '2026-11-17T10:00:00Z' },
            { id: 'PDN-2', label: 'Teléfono', role: 'consulta', last_seen_at: null },
        ];
        await render(<RegisterDeviceScreen account={{ name: 'Bodega' }} sedes={[{ id: 's1', name: 'Principal' }]}
            devices={devices} license={{ max_cajas: 1, status: 'trial' }} onRevoke={onRevoke} onSubmit={() => {}} />);
        const list = $('[data-testid="nube-register-devices"]');
        expect(list.textContent).toContain('1 de 1 caja(s)');
        expect(list.textContent).toContain('Caja A');
        expect(list.textContent).toContain('Solo consulta');
        expect($('[data-testid="nube-register-full"]')).not.toBeNull();
        await click($('button[aria-label="Desvincular Caja A"]'));
        expect(document.body.textContent).toContain('¿Desvincular «Caja A»?');
        await click($('[data-testid="nube-confirm-ok"]'));
        expect(onRevoke).toHaveBeenCalledWith('PDN-1');
        expect($('[data-testid="nube-confirm-ok"]')).toBeNull();
    });

    it('«Este equipo es…» muestra en la confirmación el error al desvincular', async () => {
        const onRevoke = vi.fn().mockRejectedValue(new Error('Equipo no encontrado'));
        await render(<RegisterDeviceScreen account={{ name: 'Bodega' }} sedes={[]}
            devices={[{ id: 'PDN-1', label: 'Caja A', role: 'caja' }]} license={{ max_cajas: 2 }} onRevoke={onRevoke} onSubmit={() => {}} />);
        expect($('[data-testid="nube-register-full"]')).toBeNull();
        await click($('button[aria-label="Desvincular Caja A"]'));
        await click($('[data-testid="nube-confirm-ok"]'));
        expect(document.body.textContent).toContain('Equipo no encontrado');
    });

    it('«¿Quién está operando?» muestra negocio, sede y caja sin repetir, reloj y el acceso del dueño', async () => {
        const onManage = vi.fn();
        await render(<MemberPickerScreen status={STATUS} members={TEAM.filter((m) => m.active)} onPick={() => {}} onManage={onManage} />);
        expect($('[data-testid="nube-loc-business"]').textContent).toBe('Bodega de Prueba Nube');
        expect($('[data-testid="nube-loc-sede"]').textContent).toBe('Principal');
        expect($('[data-testid="nube-loc-device"]').textContent).toBe('Caja A');
        expect(container.textContent.match(/Caja A/g)).toHaveLength(1);
        expect($('[data-testid="nube-clock"]')).not.toBeNull();
        expect($('img[alt="Precios al Día Nube"]')).not.toBeNull();
        expect(container.textContent).toContain('Dueño');
        expect(container.textContent).toContain('Administrador');
        await click($('[data-testid="nube-manage"]'));
        expect(onManage).toHaveBeenCalled();
    });

    it('Ajustes → Usuarios con la nube lista el equipo real y no los usuarios locales', async () => {
        mocks.authState.usuarioActivo = { id: 'o1', nombre: 'Dueño Prueba', rol: 'ADMIN', nube: true };
        localStorage.setItem('pdn-member-session', JSON.stringify({ token: 't-1', memberId: 'o1', name: 'Dueño Prueba', role: 'dueno' }));
        mocks.listTeam.mockResolvedValue(TEAM);
        await render(<SettingsTabUsuarios autoLockMinutes="3" setAutoLockMinutes={() => {}} showToast={() => {}} />);
        expect($('[data-testid="nube-team-settings"]')).not.toBeNull();
        expect(container.textContent).toContain('Luis');
        expect(container.textContent).toContain('Desactivados');
        expect(container.textContent).not.toContain('El Administrador entra sin PIN');
        expect(container.textContent).toContain('No hay Clave Maestra de Emergencia');
        expect(container.textContent).not.toContain('Pantalla de Inicio de Sesión');
    });

    it('el dueño agrega un cajero: valida el PIN en español y llama al servidor con su sesión', async () => {
        const session = { token: 't-1', memberId: 'o1', name: 'Dueño Prueba', role: 'dueno' };
        mocks.listTeam.mockResolvedValue(TEAM);
        mocks.teamUpsertMember.mockResolvedValue('nuevo');
        const showToast = vi.fn();
        await render(<NubeTeamSettings session={session} client={{}} showToast={showToast} autoLockMinutes="3" />);
        await click($('[data-testid="nube-team-add"]'));
        await type($('[data-testid="nube-member-name"]'), 'María');
        await type($('[data-testid="nube-member-pin"]'), '12');
        await type($('[data-testid="nube-member-pin2"]'), '12');
        await click($('[data-testid="nube-member-save"]'));
        expect(document.body.textContent).toContain('El PIN del cajero debe tener 4 números.');
        await type($('[data-testid="nube-member-pin"]'), '1357');
        await type($('[data-testid="nube-member-pin2"]'), '1358');
        await click($('[data-testid="nube-member-save"]'));
        expect(document.body.textContent).toContain('Los PIN no coinciden');
        await type($('[data-testid="nube-member-pin2"]'), '1357');
        await click($('[data-testid="nube-member-save"]'));
        expect(mocks.teamUpsertMember).toHaveBeenCalledWith({}, 't-1', { id: null, name: 'María', role: 'cajero', pin: '1357', active: true, sinPin: false });
        expect(showToast).toHaveBeenCalledWith('María ya puede entrar con su PIN', 'success');
        expect($('[data-testid="nube-member-form"]')).toBeNull();
    });

    it('el dueño agrega un cajero que entra sin PIN', async () => {
        const session = { token: 't-1', memberId: 'o1', name: 'Dueño Prueba', role: 'dueno' };
        mocks.listTeam.mockResolvedValue(TEAM);
        mocks.teamUpsertMember.mockResolvedValue('nuevo');
        await render(<NubeTeamSettings session={session} client={{}} showToast={vi.fn()} autoLockMinutes="3" />);
        await click($('[data-testid="nube-team-add"]'));
        await type($('[data-testid="nube-member-name"]'), 'Caja libre');
        await click($('[data-testid="nube-member-sin-pin"]'));
        expect($('[data-testid="nube-member-pin"]')).toBeNull();
        await click($('[data-testid="nube-member-save"]'));
        expect(mocks.teamUpsertMember).toHaveBeenCalledWith({}, 't-1', { id: null, name: 'Caja libre', role: 'cajero', pin: null, active: true, sinPin: true });
    });

    it('el error del servidor se muestra dentro del modal', async () => {
        const session = { token: 't-1', memberId: 'o1', role: 'dueno' };
        mocks.listTeam.mockResolvedValue(TEAM);
        mocks.teamUpsertMember.mockRejectedValue(new Error('Ya hay alguien llamado «luis» en el equipo. Usa otro nombre.'));
        await render(<NubeTeamSettings session={session} client={{}} autoLockMinutes="3" />);
        await click($('[data-testid="nube-team-add"]'));
        await type($('[data-testid="nube-member-name"]'), 'luis');
        await type($('[data-testid="nube-member-pin"]'), '1357');
        await type($('[data-testid="nube-member-pin2"]'), '1357');
        await click($('[data-testid="nube-member-save"]'));
        expect($('[data-testid="nube-member-form"]').textContent).toContain('Ya hay alguien llamado');
    });

    it('un cajero solo ve su acceso y puede cambiar su PIN (pide el actual)', async () => {
        const session = { token: 't-2', memberId: 'c1', name: 'Luis', role: 'cajero' };
        mocks.listTeam.mockResolvedValue(TEAM);
        mocks.changeOwnPin.mockResolvedValue(null);
        await render(<NubeTeamSettings session={session} client={{}} showToast={() => {}} autoLockMinutes="3" />);
        expect(container.textContent).toContain('Luis');
        expect(container.textContent).not.toContain('Ana');
        expect($('[data-testid="nube-team-add"]')).toBeNull();
        await click($('[data-testid="nube-my-pin"]'));
        await type($('[data-testid="nube-pin-current"]'), '1357');
        await type($('[data-testid="nube-pin-new"]'), '2468');
        await type($('[data-testid="nube-pin-confirm"]'), '2468');
        await click($('[data-testid="nube-pin-save"]'));
        expect(mocks.changeOwnPin).toHaveBeenCalledWith({}, 't-2', '1357', '2468');
    });

    it('panel del dueño: cambiar PIN usa un modal propio, no window.prompt', async () => {
        const promptSpy = vi.spyOn(window, 'prompt');
        const onSaveMember = vi.fn().mockResolvedValue(undefined);
        await render(<ManagePanel license={null} devices={[]} members={TEAM} summary={[]} onSaveMember={onSaveMember}
            onSetOwnerPin={vi.fn()} onRename={vi.fn()} onRevoke={vi.fn()} onClose={() => {}} />);
        await click($('button[aria-label="Cambiar PIN de Luis"]'));
        expect(promptSpy).not.toHaveBeenCalled();
        await type($('[data-testid="nube-pin-new"]'), '12');
        await type($('[data-testid="nube-pin-confirm"]'), '12');
        await click($('[data-testid="nube-pin-save"]'));
        expect(document.body.textContent).toContain('El PIN del cajero debe tener 4 números.');
        await type($('[data-testid="nube-pin-new"]'), '9081');
        await type($('[data-testid="nube-pin-confirm"]'), '9081');
        await click($('[data-testid="nube-pin-save"]'));
        expect(onSaveMember).toHaveBeenCalledWith({ id: 'c1', name: 'Luis', role: 'cajero', pin: '9081' });
        expect(container.textContent).toContain('Desactivados');
        promptSpy.mockRestore();
    });

    it('acceso del dueño: pestañas Entrar / Crear cuenta y «¿Olvidaste tu clave?»', async () => {
        const onSubmit = vi.fn();
        const onForgot = vi.fn().mockResolvedValue(true);
        await render(<OwnerAuthScreen onSubmit={onSubmit} onForgot={onForgot} />);
        expect(document.body.textContent).toContain('Crear cuenta');
        await type($('[data-testid="nube-owner-email"]'), 'dueno@bodega.test');
        await type($('[data-testid="nube-owner-password"]'), 'clave-1234');
        await click($('[data-testid="nube-owner-submit"]'));
        expect(onSubmit).toHaveBeenCalledWith({ mode: 'login', email: 'dueno@bodega.test', password: 'clave-1234' });

        await click(byText('Crear cuenta'));
        await type($('[data-testid="nube-owner-email"]'), 'dueno@bodega.test');
        await type($('[data-testid="nube-owner-password"]'), 'clave-1234');
        await type($('[data-testid="nube-owner-password2"]'), 'clave-9999');
        await click($('[data-testid="nube-owner-submit"]'));
        expect(document.body.textContent).toContain('Las contraseñas no coinciden.');

        await click(byText('Entrar'));
        await click($('[data-testid="nube-owner-forgot"]'));
        expect(document.body.textContent).toContain('¿Olvidaste tu contraseña?');
        await type($('[data-testid="nube-owner-email"]'), 'dueno@bodega.test');
        await click($('[data-testid="nube-owner-submit"]'));
        expect(onForgot).toHaveBeenCalledWith('dueno@bodega.test');
        expect($('[data-testid="nube-check-email"]').textContent).toContain('dueno@bodega.test');
    });

    it('cuenta sin confirmar: «Revisa tu correo» con reenviar y volver a entrar', async () => {
        const onResend = vi.fn();
        const onConfirmedBack = vi.fn();
        await render(<OwnerAuthScreen onSubmit={() => {}} onForgot={() => {}} onResend={onResend} onConfirmedBack={onConfirmedBack}
            pendingConfirmation="dueno@bodega.test" />);
        expect(document.body.textContent).toContain('Revisa tu correo');
        await click($('[data-testid="nube-resend"]'));
        expect(onResend).toHaveBeenCalledWith('dueno@bodega.test');
        await click(byText('Ya lo confirmé, entrar'));
        expect(onConfirmedBack).toHaveBeenCalled();
    });

    it('confirmar al dueño (administrar) no ofrece crear cuenta', async () => {
        await render(<OwnerAuthScreen onSubmit={() => {}} onForgot={() => {}} allowSignup={false} title="Confirma que eres el dueño" />);
        expect(document.body.textContent).toContain('Confirma que eres el dueño');
        expect(byText('Crear cuenta')).toBeUndefined();
    });
});
