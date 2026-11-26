// @vitest-environment jsdom
//
// F2 · desvío de storageService: con la nube activa las escrituras van al
// sincronizador por registro (src/nube) y NO al sincronizador viejo de Bodega.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const queueCloudSyncMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/hooks/useCloudSync', () => ({ queueCloudSync: queueCloudSyncMock }));

const localforageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        config: vi.fn(),
        getItem: vi.fn(async (key) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null)),
        setItem: vi.fn(async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
        removeItem: vi.fn(async (key) => { store.delete(key); }),
        createInstance: () => localforageMock,
    };
});
vi.mock('localforage', () => ({ default: localforageMock }));
vi.mock('../../src/utils/shadowBackupService', () => ({ shadowBackupService: { saveShadow: vi.fn(async () => {}) } }));

const syncFlags = vi.hoisted(() => ({ syncing: false }));
vi.mock('../../src/utils/syncFlags', () => ({
    isSyncingFromCloud: () => syncFlags.syncing,
    runWithoutEco: async (fn) => fn(),
}));

import { storageService } from '../../src/utils/storageService';
import { setNubeLocalWriteHandler, isNubeSyncActive } from '../../src/nube/localWriteHook';

describe('storageService con Precios al Día Nube', () => {
    beforeEach(() => {
        localforageMock.store.clear();
        queueCloudSyncMock.mockClear();
        syncFlags.syncing = false;
    });
    afterEach(() => setNubeLocalWriteHandler(null));

    it('con la nube apagada todo sigue igual que en Bodega', async () => {
        expect(isNubeSyncActive()).toBe(false);
        await storageService.setItem('bodega_products_v1', [{ id: 'p1' }]);
        expect(queueCloudSyncMock).toHaveBeenCalledWith('bodega_products_v1', [{ id: 'p1' }]);
    });

    it('con la nube activa avisa al sincronizador nuevo y no al viejo', async () => {
        const handler = vi.fn(async () => true);
        setNubeLocalWriteHandler(handler);
        await storageService.setItem('bodega_customers_v1', [{ id: 'c1', name: 'Ana' }]);
        expect(handler).toHaveBeenCalledWith('bodega_customers_v1', [{ id: 'c1', name: 'Ana' }]);
        expect(queueCloudSyncMock).not.toHaveBeenCalled();
        expect(localforageMock.store.get('bodega_customers_v1')).toEqual([{ id: 'c1', name: 'Ana' }]);
    });

    it('lo que baja de la nube (sin eco) no se vuelve a subir', async () => {
        const handler = vi.fn(async () => true);
        setNubeLocalWriteHandler(handler);
        syncFlags.syncing = true;
        await storageService.setItem('bodega_products_v1', [{ id: 'p1' }]);
        expect(handler).not.toHaveBeenCalled();
    });

    it('un error del sincronizador no rompe el guardado local', async () => {
        setNubeLocalWriteHandler(() => { throw new Error('sin red'); });
        await expect(storageService.setItem('bodega_products_v1', [{ id: 'p2' }])).resolves.toBeUndefined();
        expect(localforageMock.store.get('bodega_products_v1')).toEqual([{ id: 'p2' }]);
    });
});
