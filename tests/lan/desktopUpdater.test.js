import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAutoUpdaterController } = require('../../desktop/updater.js');

function createFakeAutoUpdater() {
    const emitter = new EventEmitter();
    emitter.autoDownload = false;
    emitter.autoInstallOnAppQuit = false;
    emitter.allowPrerelease = true;
    emitter.checkForUpdates = vi.fn(async () => {});
    emitter.quitAndInstall = vi.fn();
    return emitter;
}

describe('Auto-updater desktop (desktop/updater.js)', () => {
    it('reporta unsupported cuando la app no está empaquetada (.exe)', async () => {
        const ctrl = createAutoUpdaterController({
            app: { isPackaged: false, getVersion: () => '1.0.0' },
            autoUpdater: createFakeAutoUpdater(),
        });
        expect(ctrl.getState().supported).toBe(false);
        expect(ctrl.getState().status).toBe('unsupported');
        const res = await ctrl.checkForUpdates({ manual: true });
        expect(res.ok).toBe(false);
        expect(res.state.error).toContain('.exe');
    });

    it('recorre descarga automática, emite estado a la ventana y cierra servidor antes de reiniciar', async () => {
        const fakeUpdater = createFakeAutoUpdater();
        const sent = [];
        const beforeInstall = vi.fn(async () => {});
        const ctrl = createAutoUpdaterController({
            app: { isPackaged: true, getVersion: () => '1.0.0' },
            autoUpdater: fakeUpdater,
            getMainWindow: () => ({
                isDestroyed: () => false,
                webContents: { send: (ch, payload) => sent.push([ch, payload]) },
            }),
            beforeInstall,
        });

        expect(fakeUpdater.autoDownload).toBe(true);
        expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
        expect(fakeUpdater.allowPrerelease).toBe(false);
        expect(fakeUpdater.allowDowngrade).toBe(false);

        const checkPromise = ctrl.checkForUpdates({ manual: true });
        fakeUpdater.emit('checking-for-update');
        fakeUpdater.emit('update-available', {
            version: '1.0.3',
            releaseDate: '2026-11-26T00:00:00Z',
            releaseNotes: '<p>Mejoras en actualizaciones</p><ul><li>Versión sincronizada</li></ul>',
        });
        fakeUpdater.emit('download-progress', {
            percent: 54.6,
            bytesPerSecond: 1200000,
            transferred: 5000000,
            total: 10000000,
        });
        const progressState = ctrl.getState();
        expect(progressState.bytesPerSecond).toBe(1200000);
        expect(progressState.transferredBytes).toBe(5000000);
        expect(progressState.totalBytes).toBe(10000000);

        fakeUpdater.emit('update-downloaded', {
            version: '1.0.3',
            releaseDate: '2026-11-26T00:00:00Z',
            releaseNotes: '<p>Mejoras en actualizaciones</p><ul><li>Versión sincronizada</li></ul>',
        });
        await checkPromise;

        const st = ctrl.getState();
        expect(st.status).toBe('downloaded');
        expect(st.availableVersion).toBe('1.0.3');
        expect(st.progressPercent).toBe(100);
        expect(st.downloaded).toBe(true);
        expect(st.releaseNotes).toContain('Mejoras en actualizaciones');
        expect(st.releaseNotes).toContain('Versión sincronizada');
        expect(st.releaseNotes).not.toContain('<p>');
        expect(sent.some(([ch, p]) => ch === 'app:updateState' && p.status === 'downloading' && p.progressPercent === 55)).toBe(true);

        const installRes = await ctrl.installUpdateNow();
        expect(installRes.ok).toBe(true);
        expect(beforeInstall).toHaveBeenCalledTimes(1);
        expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('marca up-to-date y guarda lastCheckedAt cuando no hay nueva versión', async () => {
        const fakeUpdater = createFakeAutoUpdater();
        const ctrl = createAutoUpdaterController({
            app: { isPackaged: true, getVersion: () => '1.0.3' },
            autoUpdater: fakeUpdater,
        });
        const checkPromise = ctrl.checkForUpdates({ manual: true });
        fakeUpdater.emit('checking-for-update');
        fakeUpdater.emit('update-not-available', { version: '1.0.3' });
        await checkPromise;

        const st = ctrl.getState();
        expect(st.status).toBe('up-to-date');
        expect(st.downloaded).toBe(false);
        expect(typeof st.lastCheckedAt).toBe('string');
    });

    it('silencia fallos de red en chequeo automático y muestra aviso amigable en chequeo manual', async () => {
        const fakeUpdater = createFakeAutoUpdater();
        fakeUpdater.checkForUpdates = vi.fn(async () => {
            throw new Error('net::ERR_INTERNET_DISCONNECTED');
        });
        const ctrl = createAutoUpdaterController({
            app: { isPackaged: true, getVersion: () => '1.0.0' },
            autoUpdater: fakeUpdater,
            logger: { warn: () => {} },
        });

        const autoRes = await ctrl.checkForUpdates({ manual: false });
        expect(autoRes.ok).toBe(false);
        expect(autoRes.state.status).toBe('idle');
        expect(autoRes.state.error).toBeNull();

        const manualRes = await ctrl.checkForUpdates({ manual: true });
        expect(manualRes.ok).toBe(false);
        expect(manualRes.state.status).toBe('offline');
        expect(manualRes.state.error).toContain('red local');
    });
});
