// @vitest-environment jsdom
//
// T08 · Proteger probeAndUpgrade post-reset (C15), DeleteHistoryModal en Nube/LAN (ALT-09)
// y cierre de caja bajo pos_write_lock (A7).

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOfflineProbeUpgrade } from '../../src/nube/NubeGate.jsx';

describe('T08 · GuardReset en reconexión offline y protección de historial/arqueo', () => {
    it('1. C15 runOfflineProbeUpgrade llama guardReset() ANTES de loginWithPin y aborta si hubo reset_account', async () => {
        const order = [];
        const loginWithPin = vi.fn(async () => {
            order.push('loginWithPin');
            return { token: 'real-tok', memberId: 'm1' };
        });
        const saveSession = vi.fn(() => { order.push('saveSession'); });
        const onUpgraded = vi.fn(() => { order.push('onUpgraded'); });

        // Escenario A: el dueño ejecutó reset_account mientras la caja estaba offline -> guardReset devuelve true
        const resReset = await runOfflineProbeUpgrade({
            checkHealth: async () => { order.push('health'); },
            guardReset: async () => { order.push('guardReset'); return true; },
            readSession: () => ({ offline: true, memberId: 'm1' }),
            offlinePin: { memberId: 'm1', pin: '1234' },
            loginWithPin,
            saveSession,
            onUpgraded,
            onFallbackRefresh: vi.fn(),
            phase: 'listo',
        });

        expect(resReset).toBe('reset');
        expect(order).toEqual(['health', 'guardReset']);
        expect(loginWithPin).not.toHaveBeenCalled();
        expect(saveSession).not.toHaveBeenCalled();
        expect(onUpgraded).not.toHaveBeenCalled();

        // Escenario B: NO hubo reset -> sí hace loginWithPin y actualiza sesión
        order.length = 0;
        const resOk = await runOfflineProbeUpgrade({
            checkHealth: async () => { order.push('health'); },
            guardReset: async () => { order.push('guardReset'); return false; },
            readSession: () => ({ offline: true, memberId: 'm1' }),
            offlinePin: { memberId: 'm1', pin: '1234' },
            loginWithPin,
            saveSession,
            onUpgraded,
            onFallbackRefresh: vi.fn(),
            phase: 'listo',
        });

        expect(resOk).toBe('upgraded');
        expect(order).toEqual(['health', 'guardReset', 'loginWithPin', 'saveSession', 'onUpgraded']);
    });

    it('2. ALT-09 + A7 DashboardView bloquea DeleteHistoryModal con sync activo y envuelve cierre de caja en pos_write_lock', () => {
        const src = readFileSync(join(process.cwd(), 'src', 'views', 'DashboardView.jsx'), 'utf8');
        // DeleteHistoryModal onConfirm debe verificar isNubeSyncActive / isNubeAccountsEnabled antes de borrar SALES_KEY
        const deleteModalIdx = src.indexOf('<DeleteHistoryModal');
        const deleteModalBlock = src.slice(deleteModalIdx, deleteModalIdx + 900);
        expect(deleteModalBlock).toMatch(/isNubeSyncActive|isNubeAccountsEnabled/);

        // handleConfirmCashRecon debe usar withLock('pos_write_lock') al marcar cajaCerrada = true
        const reconIdx = src.indexOf('handleConfirmCashRecon');
        const reconBlock = src.slice(reconIdx, reconIdx + 8000);
        expect(reconBlock).toMatch(/withLock\(['"]pos_write_lock['"]/);
    });
});
