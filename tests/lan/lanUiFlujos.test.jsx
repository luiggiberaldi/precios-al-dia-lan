// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { DEFAULT_LAN_MASTER_KEY } from '../../desktop/server/lanDb.mjs';
import { clearLanServerUrl, setLanServerUrl } from '../../src/lan/lanConfig';
import * as svc from '../../src/nube/accountService';
import { createLanClient } from '../../src/lan/lanClient';

const mockState = vi.hoisted(() => ({
    authState: { usuarioActivo: null },
    setAuthState: vi.fn(),
}));

vi.mock('../../src/lan/lanConfig', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isLanModeEnabled: () => true,
    };
});

vi.mock('../../src/nube/useNubeSync', () => ({
    useNubeSync: () => ({ pending: 0, salesPending: 0, stockPending: 0, ledgerPending: 0, lastError: null }),
}));

vi.mock('../../src/nube/accountReset', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkAccountReset: async () => ({ reset: false }),
        wipeLocalData: async () => ({ discarded: 0 }),
    };
});

vi.mock('../../src/hooks/useSecurity', () => ({
    useSecurity: () => ({ fixDuplicateDeviceId: vi.fn() }),
}));

vi.mock('../../src/hooks/store/useAuthStore', () => {
    const useAuthStore = (selector) => (selector ? selector(mockState.authState) : mockState.authState);
    useAuthStore.setState = (patch) => {
        Object.assign(mockState.authState, patch);
        mockState.setAuthState(patch);
    };
    return { useAuthStore };
});

import LanSetupScreen from '../../src/lan/LanSetupScreen';
import LanPairingModal from '../../src/lan/LanPairingModal';
import NubeGate from '../../src/nube/NubeGate';
import { getDeviceClient, resetDeviceClient } from '../../src/nube/nubeSupabase';

const cleanups = [];

async function flush(ms = 40) {
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

async function waitForSelector(rootEl, selector, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const found = rootEl.querySelector(selector);
        if (found) return found;
        await flush(40);
    }
    return rootEl.querySelector(selector);
}

async function setInputValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

describe('F-18 · Flujos de interfaz React LAN contra servidor real', () => {
    let container;
    let root;

    beforeEach(() => {
        localStorage.clear();
        clearLanServerUrl();
        resetDeviceClient();
        mockState.authState.usuarioActivo = null;
        delete window.electronAPI;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        act(() => root.unmount());
        container.remove();
        while (cleanups.length) {
            const fn = cleanups.pop();
            await fn().catch(() => {});
        }
    });

    it('LanSetupScreen conecta al servidor LAN real y reporta éxito', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const onConfigured = vi.fn();
        await act(async () => {
            root.render(<LanSetupScreen onConfigured={onConfigured} />);
        });
        await flush();

        const input = container.querySelector('[data-testid="lan-server-url-input"]');
        await setInputValue(input, srv.baseUrl);

        await act(async () => {
            container.querySelector('[data-testid="lan-connect-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(120);

        expect(onConfigured).toHaveBeenCalledWith(srv.baseUrl, 'client', expect.objectContaining({ ok: true }));
    }, 60_000);

    it('NubeGate recorre flujo completo LAN en Caja Principal SIN correo ni contraseña: setup → negocio → registrar caja → PIN → app abierta', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        setLanServerUrl(srv.baseUrl, 'master');
        resetDeviceClient();

        await act(async () => {
            root.render(<NubeGate><div data-testid="pos-open">POS LAN ACTIVO</div></NubeGate>);
        });

        // 1. Salta directo a "Crea tu negocio" sin pedir correo ni contraseña
        const bizBtn = await waitForSelector(container, 'input[placeholder="Nombre del negocio"]', 6000);
        expect(bizBtn).not.toBeNull();
        expect(container.querySelector('[data-testid="nube-owner-email"]')).toBeNull();
        expect(container.textContent).toContain('Crea tu negocio');
        const inputsBiz = container.querySelectorAll('input');
        await setInputValue(inputsBiz[0], 'Bodega UI LAN');
        await setInputValue(inputsBiz[1], 'Principal');
        await setInputValue(inputsBiz[2], 'Luigi');
        await setInputValue(inputsBiz[3], '654321');
        await setInputValue(inputsBiz[4], '654321');
        await act(async () => {
            container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        // 2. Pantalla Este equipo es…
        const regInput = await waitForSelector(container, 'input[placeholder^="Nombre (ej."]', 6000);
        expect(regInput).not.toBeNull();
        expect(container.textContent).toContain('Este equipo es');
        await act(async () => {
            container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        // 3. Selector de empleados muestra «En red local», logo LAN y al dueño
        const firstMemberBtn = await waitForSelector(container, 'button[data-testid^="nube-member-"]', 6000);
        expect(firstMemberBtn).not.toBeNull();
        const picker = container.querySelector('[data-testid="nube-member-picker"]');
        expect(picker).not.toBeNull();
        expect(picker.textContent).toContain('En red local');
        expect(picker.textContent).toContain('LAN · todas tus cajas en red local');
        expect(picker.textContent).toContain('Luigi');

        // 4. Tocar al dueño y entrar con PIN 654321
        await act(async () => { firstMemberBtn.click(); });

        const pinInput = await waitForSelector(container, 'input[type="tel"]', 6000);
        expect(pinInput).not.toBeNull();
        await setInputValue(pinInput, '654321');

        const posOpen = await waitForSelector(container, '[data-testid="pos-open"]', 6000);
        expect(posOpen).not.toBeNull();
    }, 60_000);

    it('Caja adicional pide código QR directo y Caja Principal existente entra con PIN + reset local (sin correo)', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        // Crear negocio desde Caja Principal
        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await owner.lan.bootstrapLocalOwner();
        const accId = await svc.createAccount(owner, {
            businessName: 'Abasto Sin Correo',
            sedeName: 'Centro',
            ownerName: 'Luigi',
            ownerPin: '654321',
        });
        const pairing = await owner.lan.generatePairingCode(accId);

        // 1. Caja adicional: arranca directo en código de 6 dígitos (cero correo/contraseña)
        setLanServerUrl(srv.baseUrl, 'client');
        resetDeviceClient();
        await act(async () => {
            root.render(<NubeGate><div data-testid="pos-open">POS OK</div></NubeGate>);
        });
        const codeInput = await waitForSelector(container, '[data-testid="lan-claim-code-input"]', 6000);
        expect(codeInput).not.toBeNull();
        expect(container.querySelector('[data-testid="nube-owner-email"]')).toBeNull();
        expect(container.textContent).toContain('LAN · todas tus cajas en red local');

        await setInputValue(codeInput, pairing.code);
        await act(async () => {
            container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        const regInputClient = await waitForSelector(container, 'input[placeholder^="Nombre (ej."]', 6000);
        expect(regInputClient).not.toBeNull();

        // 2. Caja Principal ya configurada: pide PIN de dueño y permite restablecimiento local en esta PC
        act(() => root.unmount());
        localStorage.clear();
        setLanServerUrl(srv.baseUrl, 'master');
        window.__PDN_LAN_LOCAL_SECRET__ = srv.localAdminSecret;
        cleanups.push(async () => { delete window.__PDN_LAN_LOCAL_SECRET__; });
        resetDeviceClient();
        root = createRoot(container);
        await act(async () => {
            root.render(<NubeGate><div data-testid="pos-open">POS OK</div></NubeGate>);
        });

        const ownerPinInput = await waitForSelector(container, '[data-testid="lan-owner-pin-input"]', 6000);
        expect(ownerPinInput).not.toBeNull();
        expect(container.querySelector('[data-testid="nube-owner-email"]')).toBeNull();

        const openResetBtn = container.querySelector('[data-testid="lan-open-reset-pin"]');
        expect(openResetBtn).not.toBeNull();
        await act(async () => { openResetBtn.click(); });

        // Sin Clave Maestra rechaza en el formulario
        await setInputValue(await waitForSelector(container, '[data-testid="lan-reset-pin1"]'), '112233');
        await setInputValue(container.querySelector('[data-testid="lan-reset-pin2"]'), '112233');
        await act(async () => {
            container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        expect(container.textContent).toContain('Escribe la Clave Maestra');

        await setInputValue(container.querySelector('[data-testid="lan-master-key-input"]'), DEFAULT_LAN_MASTER_KEY);
        await act(async () => {
            container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        const regAfterReset = await waitForSelector(container, 'input[placeholder^="Nombre (ej."]', 6000);
        expect(regAfterReset).not.toBeNull();
    }, 60_000);

    it('Avatar del dueño y «Equipos y empleados» abren inicio con Clave Maestra en 1 clic y Ajustes muestra textos LAN', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const { default: NubeTeamSettings } = await import('../../src/nube/NubeTeamSettings.jsx');

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await owner.lan.bootstrapLocalOwner();
        await svc.createAccount(owner, {
            businessName: 'Bodega Clave UI',
            sedeName: 'Centro',
            ownerName: 'Luigi',
            ownerPin: '654321',
        });

        setLanServerUrl(srv.baseUrl, 'master');
        resetDeviceClient();

        // Registrar esta caja con el mismo storageKey ('pdn-device-auth') que usa NubeGate
        const dev = getDeviceClient();
        const devUid = await svc.ensureDeviceSession(dev);
        await svc.registerDevice(owner, { deviceUserId: devUid, label: 'Caja 1', role: 'caja' });

        await act(async () => {
            root.render(<NubeGate><div data-testid="pos-open">POS ABIERTO CON CLAVE MAESTRA</div></NubeGate>);
        });

        // 1) «Equipos y empleados» abajo -> abre modal de Clave Maestra en 1 solo clic (sin doble clic)
        const manageBtn = await waitForSelector(container, '[data-testid="nube-manage"]', 6000);
        expect(manageBtn).not.toBeNull();
        await act(async () => { manageBtn.click(); });

        const manageMasterLink = await waitForSelector(document.body, '[data-testid="nube-manage-email"]', 3000);
        expect(manageMasterLink?.textContent).toContain('Clave Maestra');
        await act(async () => { manageMasterLink.click(); });

        const mkManageModal = await waitForSelector(document.body, '[data-testid="lan-master-key-modal"]', 3000);
        expect(mkManageModal).not.toBeNull();
        await act(async () => { mkManageModal.querySelector('button[aria-label="Cerrar"]').click(); });

        // 2) Tocar el avatar del dueño arriba -> muestra enlace de Clave Maestra y entra directo al POS en 1 clic
        const ownerCard = await waitForSelector(container, 'button[data-testid^="nube-member-"]', 6000);
        expect(ownerCard).not.toBeNull();
        await act(async () => { ownerCard.click(); });

        const pickedMasterBtn = await waitForSelector(document.body, '[data-testid="lan-picked-master-key"]', 3000);
        expect(pickedMasterBtn).not.toBeNull();
        await act(async () => { pickedMasterBtn.click(); });

        const mkModal = await waitForSelector(document.body, '[data-testid="lan-master-key-modal"]', 3000);
        expect(mkModal).not.toBeNull();

        await setInputValue(mkModal.querySelector('[data-testid="master-key-login-input"]'), DEFAULT_LAN_MASTER_KEY);
        await act(async () => {
            mkModal.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        const posOpen = await waitForSelector(container, '[data-testid="pos-open"]', 6000);
        expect(posOpen).not.toBeNull();

        // 3) En Ajustes -> Usuarios (Modo LAN): muestra «El equipo vive en tu red local.» y tarjeta para personalizar Clave Maestra
        await act(async () => {
            root.render(<NubeTeamSettings autoLockMinutes="3" setAutoLockMinutes={() => {}} showToast={() => {}} />);
        });
        const settingsEl = await waitForSelector(container, '[data-testid="nube-team-settings"]', 4000);
        expect(settingsEl.textContent).toContain('El equipo vive en tu red local.');
        expect(settingsEl.textContent).not.toContain('No hay Clave Maestra de Emergencia');
        expect(container.querySelector('[data-testid="lan-config-master-key"]')).not.toBeNull();
    }, 60_000);

    it('LanPairingModal genera QR y código de 6 dígitos real contra el servidor', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'qr@ui.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto QR',
            sedeName: 'Principal',
            ownerName: 'Ana',
            ownerPin: '142536',
        });
        const acc = await svc.getOwnerAccount(owner);

        await act(async () => {
            root.render(<LanPairingModal client={owner} accountId={acc.id} onClose={() => {}} />);
        });
        await flush(250);

        for (let i = 0; i < 20 && !document.body.querySelector('img[alt="QR de conexión LAN"]'); i += 1) {
            await flush(80);
        }
        const codeEl = document.body.querySelector('[data-testid="lan-pairing-code"]');
        expect(codeEl?.textContent).toMatch(/^\d{6}$/);
        expect(document.body.querySelector('img[alt="QR de conexión LAN"]')).not.toBeNull();
    }, 60_000);

    it('NubeGate permite entrar como Supervisor por internet en navegador móvil/PC (sin Electron)', async () => {
        const realFetch = globalThis.fetch;
        cleanups.push(async () => {
            globalThis.fetch = realFetch;
        });

        globalThis.fetch = vi.fn(async (input) => {
            const url = String(input || '');
            if (url.includes('/rpc/lan_supervisor_login')) {
                return new Response(
                    JSON.stringify([{
                        session_token: '33333333-3333-4333-8333-333333333333',
                        account_id: '11111111-1111-4111-8111-111111111111',
                        account_name: 'Bodega Remota',
                        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                    }]),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            if (url.includes('/rpc/lan_supervisor_get_snapshot')) {
                return new Response(
                    JSON.stringify([{
                        account_id: '11111111-1111-4111-8111-111111111111',
                        account_name: 'Bodega Remota',
                        pushed_at: new Date().toISOString(),
                        snapshot: {
                            daySummary: [{ device_id: 'd1', caja_letter: 'A', sede_name: 'Centro', ventas: 4, ventas_usd: 45, cobros_usd: 0, egresos_usd: 0, caja_abierta: true }],
                            sales: [],
                            sedes: [],
                            products: [],
                            customers: [],
                            stockLevels: [],
                            customerBalances: [],
                            discrepancies: [],
                        },
                        recent_commands: [],
                    }]),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });

        await act(async () => {
            root.render(<NubeGate><div data-testid="pos-open">POS LAN ACTIVO</div></NubeGate>);
        });
        const openCloudBtn = await waitForSelector(container, '[data-testid="lan-open-cloud-supervisor"]');
        expect(openCloudBtn).not.toBeNull();

        await act(async () => { openCloudBtn.click(); });
        const form = await waitForSelector(container, '[data-testid="lan-cloud-login-form"]');
        await setInputValue(form.querySelector('input[placeholder="URL de Supabase puente"]'), 'https://puente.supabase.co');
        await setInputValue(form.querySelector('input[placeholder="Llave anon pública"]'), 'anon-test');
        await setInputValue(form.querySelector('[data-testid="lan-cloud-code-input"]'), 'SUP-123456');
        await setInputValue(form.querySelector('[data-testid="lan-cloud-pin-input"]'), '753951');

        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        const summary = await waitForSelector(container, '[data-testid="nube-day-summary"]');
        expect(summary).not.toBeNull();
        expect(container.textContent).toContain('Bodega Remota');
        expect(container.textContent).toContain('Dueño (Internet)');
    }, 30_000);

    it('LanSetupScreen busca cajas automáticamente al elegir Caja adicional y conecta en un clic', async () => {
        const { LAN_PROTOCOL_VERSION } = await import('../../src/lan/lanConfig.js');
        const waitUntil = async (pred) => {
            for (let i = 0; i < 50; i += 1) {
                if (pred()) return;
                await act(async () => {
                    await new Promise((r) => setTimeout(r, 15));
                });
            }
        };

        const discoverServers = vi.fn(async () => [
            {
                url: 'http://192.168.1.50:47800',
                host: '192.168.1.50',
                port: 47800,
                businessName: 'Bodega Central',
            },
        ]);
        const setClientMode = vi.fn(async ({ serverUrl }) => ({ ok: true, serverUrl }));
        const onConfigured = vi.fn();

        const realFetch = globalThis.fetch;
        cleanups.push(async () => {
            globalThis.fetch = realFetch;
        });

        globalThis.fetch = vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : String(input?.url || '');
            if (url.endsWith('/lan/health')) {
                return new Response(
                    JSON.stringify({
                        ok: true,
                        protocolVersion: LAN_PROTOCOL_VERSION,
                        businessName: 'Bodega Central',
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            return new Response(JSON.stringify({ ok: false }), { status: 404 });
        });

        window.electronAPI = {
            isElectron: true,
            platform: 'win32',
            lan: { discoverServers, setClientMode },
        };

        try {
            await act(async () => {
                root.render(<LanSetupScreen onConfigured={onConfigured} />);
            });

            const chooseClientBtn = await waitForSelector(container, '[data-testid="lan-choose-client"]');
            expect(chooseClientBtn).not.toBeNull();

            await act(async () => {
                chooseClientBtn.click();
            });

            const list = await waitForSelector(container, '[data-testid="lan-discovered-list"]');
            expect(list).not.toBeNull();
            expect(discoverServers).toHaveBeenCalledTimes(1);
            expect(list.textContent).toContain('Bodega Central');

            const serverBtn = list.querySelector('button');
            await act(async () => {
                serverBtn.click();
            });

            await waitUntil(() => onConfigured.mock.calls.length === 1);
            expect(setClientMode).toHaveBeenCalledWith({ serverUrl: 'http://192.168.1.50:47800' });
            expect(onConfigured).toHaveBeenCalledWith(
                'http://192.168.1.50:47800',
                'client',
                expect.objectContaining({ businessName: 'Bodega Central' }),
            );
        } finally {
            delete window.electronAPI;
            localStorage.clear();
        }
    });

    it('LanPairingModal muestra botón de 1 clic para reparar el permiso de Firewall', async () => {
        const waitUntil = async (pred) => {
            for (let i = 0; i < 50; i += 1) {
                if (pred()) return;
                await act(async () => {
                    await new Promise((r) => setTimeout(r, 15));
                });
            }
        };
        const repairFirewall = vi.fn(async () => ({ ok: true }));
        const fakeClient = {
            lan: {
                generatePairingCode: vi.fn(async () => ({
                    code: '654321',
                    primaryUrl: 'http://192.168.1.50:47800',
                    expiresAt: new Date(Date.now() + 600_000).toISOString(),
                    lanUrls: ['http://192.168.1.50:47800'],
                    supervisorUrls: [],
                })),
                getBridgeStatus: vi.fn(async () => ({ configured: false })),
            },
        };

        window.electronAPI = {
            isElectron: true,
            platform: 'win32',
            lan: { repairFirewall },
        };

        try {
            await act(async () => {
                root.render(<LanPairingModal client={fakeClient} accountId="acc-1" onClose={() => {}} />);
            });

            const repairBtn = await waitForSelector(container, '[data-testid="lan-repair-firewall-btn"]');
            expect(repairBtn).not.toBeNull();
            await waitUntil(() => !repairBtn.disabled);

            await act(async () => {
                repairBtn.click();
            });

            await waitUntil(() => container.textContent.includes('Permiso de red local listo'));
            expect(repairFirewall).toHaveBeenCalledTimes(1);
            expect(container.textContent).toContain('Permiso de red local listo');
        } finally {
            delete window.electronAPI;
            localStorage.clear();
        }
    });

    it('LanUpdateBanner muestra centro manual, modal entrante, pospone para Más tarde e instala al reiniciar', async () => {
        const { default: LanUpdateBanner } = await import('../../src/lan/LanUpdateBanner.jsx');
        const { triggerManualUpdateCheck } = await import('../../src/lan/lanConfig.js');
        const waitUntil = async (pred) => {
            for (let i = 0; i < 60; i += 1) {
                if (pred()) return;
                await act(async () => {
                    await new Promise((r) => setTimeout(r, 15));
                });
            }
        };

        let listener = null;
        let currentState = {
            supported: true,
            currentVersion: '1.0.2',
            status: 'idle',
            availableVersion: null,
            releaseNotes: null,
            progressPercent: 0,
            downloaded: false,
            error: null,
        };
        const installNow = vi.fn(async () => ({ ok: true }));
        const checkNow = vi.fn(async () => {
            currentState = {
                ...currentState,
                status: 'up-to-date',
                lastCheckedAt: '2026-11-26T00:00:00Z',
            };
            listener?.(currentState);
            return { ok: true, state: currentState };
        });

        window.electronAPI = {
            isElectron: true,
            platform: 'win32',
            updater: {
                getState: vi.fn(async () => currentState),
                checkNow,
                installNow,
                onStateChange: (cb) => {
                    listener = cb;
                    return () => { listener = null; };
                },
            },
        };

        try {
            await act(async () => {
                root.render(<LanUpdateBanner />);
            });
            await waitUntil(() => typeof listener === 'function');

            // 1. Abrir centro manual "Buscar actualizaciones" cuando aún no hay descarga
            await act(async () => {
                await triggerManualUpdateCheck();
            });
            const centerModal = await waitForSelector(container, '[data-testid="lan-update-center-modal"]');
            expect(centerModal).not.toBeNull();
            expect(centerModal.textContent).toContain('v1.0.2');
            expect(checkNow).toHaveBeenCalledTimes(1);

            // 2. Llegan progreso y descarga completada de v1.0.3 -> abre modal entrante
            await act(async () => {
                listener?.({
                    ...currentState,
                    status: 'downloading',
                    availableVersion: '1.0.3',
                    progressPercent: 60,
                    transferredBytes: 60 * 1024 * 1024,
                    totalBytes: 100 * 1024 * 1024,
                    bytesPerSecond: 2 * 1024 * 1024,
                });
            });
            const progressBanner = await waitForSelector(container, '[data-testid="lan-update-progress-banner"]');
            expect(progressBanner).not.toBeNull();
            expect(progressBanner.textContent).toContain('60%');

            await act(async () => {
                listener?.({
                    ...currentState,
                    status: 'downloaded',
                    availableVersion: '1.0.3',
                    releaseNotes: '• Nueva interfaz de actualizaciones\n• Versión unificada v1.0.3',
                    progressPercent: 100,
                    downloaded: true,
                });
            });

            const readyModal = await waitForSelector(container, '[data-testid="lan-update-ready-modal"]');
            expect(readyModal).not.toBeNull();
            expect(readyModal.textContent).toContain('v1.0.3');
            expect(readyModal.textContent).toContain('Versión unificada');

            // 3. Elegir "Más tarde" minimiza a píldora flotante sin reiniciar
            const laterBtn = await waitForSelector(container, '[data-testid="lan-update-later-btn"]');
            expect(laterBtn).not.toBeNull();
            await act(async () => { laterBtn.click(); });
            const readyPill = await waitForSelector(container, '[data-testid="lan-update-ready-pill"]');
            expect(readyPill).not.toBeNull();

            // 4. Reabrir desde la píldora y confirmar "Instalar ahorita (reiniciar)"
            const pillOpenBtn = await waitForSelector(container, '[data-testid="lan-update-pill-open-btn"]');
            expect(pillOpenBtn).not.toBeNull();
            await act(async () => { pillOpenBtn.click(); });

            const installBtn = await waitForSelector(container, '[data-testid="lan-update-install-btn"]');
            expect(installBtn).not.toBeNull();
            await act(async () => { installBtn.click(); });
            await waitUntil(() => installNow.mock.calls.length === 1);
            expect(installNow).toHaveBeenCalledTimes(1);
        } finally {
            delete window.electronAPI;
            localStorage.clear();
        }
    }, 15_000);

    it('SettingsTabSistema y MemberPickerScreen muestran versión sincronizada y zona de búsqueda', async () => {
        const { default: SettingsTabSistema } = await import('../../src/components/Settings/tabs/SettingsTabSistema.jsx');
        const { MemberPickerScreen } = await import('../../src/nube/NubeScreens.jsx');
        const waitUntil = async (pred) => {
            for (let i = 0; i < 60; i += 1) {
                if (pred()) return;
                await act(async () => {
                    await new Promise((r) => setTimeout(r, 15));
                });
            }
        };

        let listener = null;
        let currentState = {
            supported: true,
            currentVersion: '1.0.3',
            status: 'idle',
            downloaded: false,
            availableVersion: null,
            progressPercent: 0,
            error: null,
        };
        const installNow = vi.fn(async () => ({ ok: true }));
        const checkNow = vi.fn(async () => {
            currentState = {
                ...currentState,
                status: 'downloaded',
                availableVersion: '1.0.4',
                downloaded: true,
                progressPercent: 100,
                lastCheckedAt: '2026-11-26T00:00:00Z',
            };
            listener?.(currentState);
            return { ok: true, state: currentState };
        });

        window.electronAPI = {
            isElectron: true,
            platform: 'win32',
            updater: {
                getState: vi.fn(async () => currentState),
                checkNow,
                installNow,
                onStateChange: (cb) => {
                    listener = cb;
                    return () => { listener = null; };
                },
            },
        };

        try {
            await act(async () => {
                root.render(
                    <SettingsTabSistema
                        deviceId="dev-123"
                        idCopied={false}
                        setIdCopied={() => {}}
                        isAdmin
                        handleExport={() => {}}
                        handleImportClick={() => {}}
                        handleSyncCloud={() => {}}
                        setIsShareOpen={() => {}}
                        setShowDeleteConfirm={() => {}}
                    />,
                );
            });
            const settingsZone = await waitForSelector(container, '[data-testid="lan-settings-updates"]');
            expect(settingsZone).not.toBeNull();
            expect(container.querySelector('[data-testid="app-version"]')?.textContent).toContain('v1.0.3');

            const checkBtn = await waitForSelector(container, '[data-testid="check-update"]');
            await act(async () => { checkBtn.click(); });
            await waitUntil(() => checkNow.mock.calls.length === 1);
            expect(checkNow).toHaveBeenCalledTimes(1);

            const settingsInstallBtn = await waitForSelector(container, '[data-testid="lan-settings-install-btn"]');
            expect(settingsInstallBtn).not.toBeNull();
            expect(container.querySelector('[data-testid="lan-settings-later-btn"]')).not.toBeNull();
            await act(async () => { settingsInstallBtn.click(); });
            await waitUntil(() => installNow.mock.calls.length === 1);
            expect(installNow).toHaveBeenCalledTimes(1);

            await act(async () => {
                root.render(
                    <MemberPickerScreen
                        status={{ account: { name: 'Bodega Test' }, device: { label: 'Caja 1', caja_letter: 'A', role: 'caja' }, sedes: [] }}
                        members={[{ id: 'm1', display_name: 'Luigi', role: 'dueno', pin_length: 6 }]}
                        onPick={() => {}}
                        onManage={() => {}}
                    />,
                );
            });
            const versionBadge = await waitForSelector(container, '[data-testid="member-picker-version"]');
            expect(versionBadge?.textContent).toContain('v1.0.3');
            expect(container.querySelector('[data-testid="lan-check-updates-btn"]')).not.toBeNull();
        } finally {
            delete window.electronAPI;
            localStorage.clear();
        }
    }, 30_000);

    it('rebindDevice permite reconectar la misma Caja A sin crear Caja B, oculta Instalar App en Electron y limita PIN a 6 dígitos', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());
        try {
            const { MemberPickerScreen, RegisterDeviceScreen } = await import('../../src/nube/NubeScreens.jsx');
            const { OwnerAuthScreen } = await import('../../src/nube/NubeOwnerAuth.jsx');
            setLanServerUrl(srv.baseUrl, 'master');

            // 1. Crear negocio y registrar Caja A
            const dev1 = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
            const { data: d1 } = await dev1.auth.signInAnonymously();
            const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
            await owner.lan.bootstrapLocalOwner();
            await owner.rpc('create_account', {
                p_name: 'Bodega Reconnect',
                p_sede_name: 'Principal',
                p_owner_name: 'Luigi',
                p_owner_pin: '246810',
            });
            await owner.rpc('register_device', {
                p_device_user_id: d1.user.id,
                p_label: 'Caja 1',
                p_role: 'caja',
                p_sede_id: null,
            });
            const beforeDevices = (await owner.from('account_devices').select('id, label, caja_letter, role, last_seen_at').order('created_at')).data;
            expect(beforeDevices).toHaveLength(1);
            const cajaAId = beforeDevices[0].id;

            // Verificar que RegisterDeviceScreen muestra botón Reconectar aquí junto a Caja A
            const onRebind = vi.fn();
            await act(async () => {
                root.render(
                    <RegisterDeviceScreen
                        account={{ name: 'Bodega Reconnect' }}
                        sedes={[{ id: 's1', name: 'Principal' }]}
                        devices={beforeDevices}
                        license={{ max_cajas: 2 }}
                        onRebind={onRebind}
                        onSubmit={() => {}}
                    />,
                );
            });
            const rebindBtn = await waitForSelector(container, `[data-testid="nube-rebind-${cajaAId}"]`);
            expect(rebindBtn).not.toBeNull();
            await act(async () => { rebindBtn.click(); });
            expect(onRebind).toHaveBeenCalledWith(cajaAId);

            // 2. Simular nueva sesión anónima en el mismo equipo y reconectar Caja A mediante /lan/devices/rebind
            const dev2 = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
            const { data: d2 } = await dev2.auth.signInAnonymously();
            const rebound = await owner.lan.rebindDevice({ deviceId: cajaAId, deviceUserId: d2.user.id });
            expect(rebound.id).toBe(cajaAId);

            const afterDevices = (await owner.from('account_devices').select('id, auth_user_id').order('created_at')).data;
            expect(afterDevices).toHaveLength(1);
            expect(afterDevices[0].auth_user_id).toBe(d2.user.id);

            // 3. Verificar que MemberPickerScreen en Electron NO muestra Instalar App
            window.electronAPI = { isElectron: true, platform: 'win32', lan: {} };
            await act(async () => {
                root.render(
                    <MemberPickerScreen
                        status={{ account: { name: 'Bodega Reconnect' }, device: { label: 'Caja 1', caja_letter: 'A', role: 'caja' }, sedes: [] }}
                        members={[{ id: 'm1', display_name: 'Luigi', role: 'dueno', pin_length: 6 }]}
                        onPick={() => {}}
                        onManage={() => {}}
                    />,
                );
            });
            expect(container.querySelector('[data-testid="nube-install"]')).toBeNull();
            expect(container.textContent).not.toContain('App Instalada');

            // 4. Verificar que OwnerAuthScreen en Caja Principal limita el PIN a 6 dígitos exactos
            const onPinSubmit = vi.fn();
            await act(async () => {
                root.render(
                    <OwnerAuthScreen
                        isLocalMaster
                        onOwnerPinSubmit={onPinSubmit}
                        onSubmit={() => {}}
                        onForgot={() => {}}
                        onResend={() => {}}
                    />,
                );
            });
            const pinInput = await waitForSelector(container, '[data-testid="lan-owner-pin-input"]');
            expect(pinInput.maxLength).toBe(6);
            await setInputValue(pinInput, '123456789');
            expect(pinInput.value).toBe('123456');
        } finally {
            delete window.electronAPI;
            localStorage.clear();
        }
    }, 30_000);
});
