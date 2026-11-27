// @vitest-environment jsdom
//
// T01 · Concurrencia y locks:
//   1. Eliminar el flag booleano global `runWithoutEco` en el motor Nube/LAN:
//      una escritura lenta con `fromCloud: true` NO debe silenciar una venta
//      concurrente en otra clave.
//   2. `recordSync` y `stockMirror` serializan read-modify-write bajo `pos_write_lock`
//      para no pisar un descuento de stock concurrente.
//   3. `recordSync.inTurn(collection)` usa `withLock('pdn_sync_turn_<col>')` (cross-tab).
//   4. `syncFlags.runWithoutEco` usa contador de referencias para compatibilidad legada.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const queueCloudSyncMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/hooks/useCloudSync', () => ({ queueCloudSync: queueCloudSyncMock }));

const localforageMock = vi.hoisted(() => {
    const store = new Map();
    const delays = new Map();
    return {
        store,
        delays,
        config: vi.fn(),
        getItem: vi.fn(async (key) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null)),
        setItem: vi.fn(async (key, value) => {
            const delay = delays.get(key) || 0;
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            store.set(key, JSON.parse(JSON.stringify(value)));
        }),
        removeItem: vi.fn(async (key) => { store.delete(key); }),
        createInstance: () => localforageMock,
    };
});
vi.mock('localforage', () => ({ default: localforageMock }));
vi.mock('../../src/utils/shadowBackupService', () => ({ shadowBackupService: { saveShadow: vi.fn(async () => {}) } }));

import { storageService } from '../../src/utils/storageService';
import { setNubeLocalWriteHandler } from '../../src/nube/localWriteHook';
import { runWithoutEco, isSyncingFromCloud, _resetSyncFlag } from '../../src/utils/syncFlags';
import { withLock } from '../../src/utils/withLock';
import { createRecordSync } from '../../src/nube/recordSync';
import { createStockMirror } from '../../src/nube/stockMirror';

function memoryStore() {
    const m = new Map();
    return {
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

describe('T01 · concurrencia, sin eco por escritura y pos_write_lock', () => {
    beforeEach(() => {
        localforageMock.store.clear();
        localforageMock.delays.clear();
        queueCloudSyncMock.mockClear();
        _resetSyncFlag();
    });

    afterEach(() => {
        setNubeLocalWriteHandler(null);
        _resetSyncFlag();
    });

    it('escritura lenta desde la nube ({ fromCloud: true }) NO silencia una venta concurrente y emite source="remote"', async () => {
        const handler = vi.fn(async () => true);
        setNubeLocalWriteHandler(handler);

        const events = [];
        const onUpdate = (e) => events.push(e.detail);
        window.addEventListener('app_storage_update', onUpdate);

        try {
            // Simular IndexedDB lento al bajar productos desde la nube (40 ms).
            localforageMock.delays.set('bodega_products_v1', 40);

            const cloudWrite = storageService.setItem(
                'bodega_products_v1',
                [{ id: 'p1', name: 'Harina', stock: 10 }],
                { fromCloud: true },
            );

            // A los 10 ms (mientras cloudWrite sigue pendiente), el cajero guarda una venta local.
            await new Promise((r) => setTimeout(r, 10));
            const saleWrite = storageService.setItem('bodega_sales_v1', [{ id: 's1', totalUsd: 5 }]);

            await Promise.all([cloudWrite, saleWrite]);

            // La venta local SÍ debe notificarse al motor de sincronización; la bajada de la nube NO.
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith('bodega_sales_v1', [{ id: 's1', totalUsd: 5 }]);

            const saleEvent = events.find((e) => e.key === 'bodega_sales_v1');
            const cloudEvent = events.find((e) => e.key === 'bodega_products_v1');
            expect(saleEvent?.source).toBe('local');
            expect(cloudEvent?.source).toBe('remote');
        } finally {
            window.removeEventListener('app_storage_update', onUpdate);
        }
    });

    it('recordSync.pull() serializa read-modify-write con withLocalLock(pos_write_lock) sin pisar descuento concurrente de venta', async () => {
        const local = new Map();
        local.set('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1, stock: 10 }]);

        // Fake client que devuelve cambio de precio en p1 (version 2)
        const fakeClient = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        order: () => ({
                            order: () => ({
                                limit: async () => ({
                                    data: [{
                                        id: 'p1',
                                        data: { id: 'p1', name: 'Harina', priceUsd: 1.5 },
                                        version: 2,
                                        deleted_at: null,
                                        updated_at: '2026-11-26T20:00:00.000Z',
                                    }],
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        };

        const sync = createRecordSync({
            client: fakeClient,
            getSession: () => 'tok',
            store: memoryStore(),
            withLocalLock: (fn) => withLock('pos_write_lock', fn, { fallbackWarning: false }),
            readLocal: async (k) => {
                // Demora artificial para exponer la carrera si no hay lock
                await new Promise((r) => setTimeout(r, 25));
                return structuredClone(local.get(k) ?? null);
            },
            writeLocal: async (k, v) => {
                local.set(k, structuredClone(v));
            },
        });

        // Arranca pull (lee stock: 10 si no tuviera lock)
        const pullPromise = sync.pull(['products']);

        // Concurrentemente, una venta bajo pos_write_lock descuenta 2 unidades (10 -> 8)
        await new Promise((r) => setTimeout(r, 5));
        const salePromise = withLock('pos_write_lock', async () => {
            const list = structuredClone(local.get('bodega_products_v1'));
            await new Promise((r) => setTimeout(r, 25));
            list[0].stock = 8;
            local.set('bodega_products_v1', list);
        }, { fallbackWarning: false });

        await Promise.all([pullPromise, salePromise]);

        // Resultado: precio nuevo (1.5) Y stock descontado (8) preservados ambos.
        expect(local.get('bodega_products_v1')).toEqual([
            { id: 'p1', name: 'Harina', priceUsd: 1.5, stock: 8 },
        ]);
    });

    it('stockMirror.applyKnown usa withLocalLock(pos_write_lock) para no pisar escrituras concurrentes de catálogo', async () => {
        const local = new Map();
        local.set('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsd: 1, stock: 10 }]);

        const watcher = {
            flush: vi.fn(async () => ({ ok: true })),
            pendingProducts: vi.fn(async () => new Set()),
            setBaseline: vi.fn(async () => {}),
        };

        const fakeClient = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        order: () => ({
                            order: () => ({
                                limit: async () => ({
                                    data: [{ product_id: 'p1', qty: 7, updated_at: '2026-11-26T20:00:00.000Z' }],
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        };

        const mirror = createStockMirror({
            client: fakeClient,
            sedeId: 'sede-1',
            watcher,
            withLocalLock: (fn) => withLock('pos_write_lock', fn, { fallbackWarning: false }),
            readProducts: async () => {
                await new Promise((r) => setTimeout(r, 25));
                return structuredClone(local.get('bodega_products_v1') || []);
            },
            writeProducts: async (products) => {
                local.set('bodega_products_v1', structuredClone(products));
            },
        });

        const refreshPromise = mirror.refresh();
        await new Promise((r) => setTimeout(r, 5));
        // Edición concurrente de precio bajo pos_write_lock
        const editPromise = withLock('pos_write_lock', async () => {
            const list = structuredClone(local.get('bodega_products_v1'));
            await new Promise((r) => setTimeout(r, 25));
            list[0].priceUsd = 2.5;
            local.set('bodega_products_v1', list);
        }, { fallbackWarning: false });

        await Promise.all([refreshPromise, editPromise]);

        // Debe conservar tanto el nuevo precio (2.5) como el nuevo stock (7).
        expect(local.get('bodega_products_v1')).toEqual([
            { id: 'p1', name: 'Harina', priceUsd: 2.5, stock: 7 },
        ]);
    });

    it('recordSync.inTurn(collection) adquiere withLock("pdn_sync_turn_<collection>")', async () => {
        const lockNames = [];
        const origLocks = navigator.locks;
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: async (name, _opts, cb) => {
                    lockNames.push(name);
                    return cb();
                },
            },
        });

        try {
            const sync = createRecordSync({
                client: { rpc: async () => ({ data: [], error: null }) },
                getSession: () => null,
                store: memoryStore(),
                readLocal: async () => [],
                writeLocal: async () => {},
            });
            await sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'A' }]);
            expect(lockNames).toContain('pdn_sync_turn_products');
        } finally {
            Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
        }
    });

    it('syncFlags.runWithoutEco soporta llamadas solapadas con contador de referencias sin apagar el flag antes de tiempo', async () => {
        let stateAfterFirstEnds = null;
        let resolveFirst;
        let resolveSecond;
        const firstDone = new Promise((r) => { resolveFirst = r; });
        const secondDone = new Promise((r) => { resolveSecond = r; });

        const p1 = runWithoutEco(async () => {
            await firstDone;
        });
        const p2 = runWithoutEco(async () => {
            await secondDone;
        });

        resolveFirst();
        await p1;
        // p2 sigue activa: el flag DEBE seguir en true!
        stateAfterFirstEnds = isSyncingFromCloud();

        resolveSecond();
        await p2;

        expect(stateAfterFirstEnds).toBe(true);
        expect(isSyncingFromCloud()).toBe(false);
    });
});
