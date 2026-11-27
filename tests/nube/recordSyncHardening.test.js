// @vitest-environment jsdom
//
// T05 · Endurecimiento de recordSync, storageService CircuitBreaker, realtimeChannel y useNubeSync
// Cierra: C13, C14, A4, A11, MED-01, MED-03, MED-07

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { storageService } from '../../src/utils/storageService';
import { createRecordSync, mergeIntoLocal, RECORD_REJECTED_KEY, MAX_RECORD_BYTES } from '../../src/nube/recordSync';
import { keepChannel } from '../../src/nube/realtimeChannel';

function memoryStore() {
    const m = new Map();
    return {
        raw: m,
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

describe('T05 · Hardening de recordSync, CircuitBreaker y realtimeChannel', () => {
    beforeEach(() => {
        localforageMock.store.clear();
        queueCloudSyncMock.mockClear();
    });

    it('1. C13 borrado masivo remoto (fromCloud: true) NO dispara CircuitBreaker; y si una colección falla en pull(), las demás igualmente bajan', async () => {
        // Sembrar 100 productos localmente
        const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `Prod ${i}` }));
        await storageService.setItem('bodega_products_v1', hundred);

        // Local sin confirmación sigue protegido por CircuitBreaker
        await expect(storageService.setItem('bodega_products_v1', hundred.slice(0, 5))).rejects.toThrow(/CircuitBreaker/);

        // Bajada remota (fromCloud: true) SÍ puede aplicar borrado masivo legítimo de otra caja
        await expect(storageService.setItem('bodega_products_v1', hundred.slice(0, 5), { fromCloud: true })).resolves.toBeUndefined();
        expect(localforageMock.store.get('bodega_products_v1')).toHaveLength(5);

        // Per-collection try/catch en pull(): si products falla, customers igual baja
        const local = new Map();
        const client = {
            from: () => ({
                select: () => ({
                    eq: (_col, collection) => ({
                        order: () => ({
                            order: () => ({
                                limit: async () => {
                                    if (collection === 'products') return { data: null, error: { message: 'boom products' } };
                                    if (collection === 'customers') {
                                        return {
                                            data: [{ id: 'c1', data: { id: 'c1', name: 'Ana' }, version: 1, deleted_at: null, updated_at: '2026-11-26T20:00:00.000Z' }],
                                            error: null,
                                        };
                                    }
                                    return { data: [], error: null };
                                },
                            }),
                        }),
                    }),
                }),
            }),
        };
        const sync = createRecordSync({
            client,
            getSession: () => 'tok',
            store: memoryStore(),
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
        });
        const total = await sync.pull(['products', 'customers']);
        expect(total).toBe(1);
        expect(local.get('bodega_customers_v1')).toEqual([{ id: 'c1', name: 'Ana' }]);
        expect(sync.getLastError()).toMatch(/boom products/);
    });

    it('2. C14 pendingLocal NO adelanta state.versions ni lastPulled: si luego entra Cajero, el siguiente pull() SÍ aplica v2', async () => {
        let isAdmin = true;
        const local = new Map([['bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsdt: 1.0 }]]]);
        const serverRows = [{ id: 'p1', data: { id: 'p1', name: 'Harina', priceUsdt: 2.0 }, version: 2, deleted_at: null, updated_at: '2026-11-26T20:00:00.000Z' }];
        const client = {
            rpc: async () => ({ data: null, error: { message: 'offline' } }),
            from: () => ({
                select: () => ({
                    eq: () => ({
                        order: () => ({
                            order: () => ({
                                limit: async () => ({ data: serverRows, error: null }),
                            }),
                        }),
                        gt: () => ({
                            order: () => ({
                                order: () => ({
                                    limit: async () => ({ data: [], error: null }),
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        };
        const sync = createRecordSync({
            client,
            getSession: () => 'tok',
            store: memoryStore(),
            canPush: (c) => c === 'customers' || c === 'cash' || isAdmin,
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
        });

        // Admin edita p1 offline (queda en state.queue)
        await sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'Harina', priceUsdt: 1.25 }]);
        // Llega pull con p1 v2 -> se salta porque p1 está en pendingLocal
        await sync.pull(['products']);
        expect(local.get('bodega_products_v1')[0].priceUsdt).toBe(1.0); // no pisado mientras era admin

        // Cambia turno a Cajero (canPush('products') === false)
        isAdmin = false;
        await sync.pull(['products']);
        // AHORA SÍ debe aplicar p1 v2 porque state.versions['p1'] NO se adelantó cuando se saltó!
        expect(local.get('bodega_products_v1')[0].priceUsdt).toBe(2.0);
    });

    it('3. C14 queueLocalWrite respeta canPush: un cajero NO encola cambios en products/settings', async () => {
        const store = memoryStore();
        const sync = createRecordSync({
            client: { rpc: async () => ({ data: [], error: null }) },
            getSession: () => null,
            store,
            canPush: (c) => c === 'customers' || c === 'cash',
            readLocal: async () => [],
            writeLocal: async () => {},
        });
        await sync.onLocalWrite('bodega_products_v1', [{ id: 'p1', name: 'Hack' }]);
        await sync.onLocalWrite('my_categories_v1', ['HackCat']);
        expect(await sync.pendingCount()).toBe(0);
    });

    it('4. A11 medición real en bytes UTF-8 y cuarentena de poison-pill clase 22/23 sin trabar otros registros', async () => {
        const store = memoryStore();
        const rpcMock = vi.fn(async (_fn, args) => {
            const recs = args.p_records || [];
            if (recs.some((r) => r.id === 'p-bad')) {
                return { data: null, error: { code: '22023', message: 'Registro inválido p-bad' } };
            }
            return {
                data: recs.map((r) => ({ id: r.id, version: 1, updated_at: '2026-11-26T20:00:00.000Z', merged: false, rejected: false, data: null })),
                error: null,
            };
        });
        const sync = createRecordSync({
            client: { rpc: rpcMock },
            getSession: () => 'tok',
            store,
            readLocal: async () => [],
            writeLocal: async () => {},
        });

        // Emoji = 4 bytes UTF-8 por cada 2 code units UTF-16 -> string.length < 90000 pero bytes > 90000
        const emojiStr = '😀'.repeat(Math.ceil(MAX_RECORD_BYTES / 3)); // ~60000 chars, ~120000 UTF-8 bytes
        expect(emojiStr.length).toBeLessThan(MAX_RECORD_BYTES);
        await sync.onLocalWrite('bodega_products_v1', [
            { id: 'p-emoji', name: emojiStr },
            { id: 'p-bad', name: 'Malo' },
            { id: 'p-good', name: 'Bueno' },
        ]);
        await sync.flush();

        // p-emoji no entró a la cola por exceder MAX_RECORD_BYTES en bytes UTF-8
        expect(rpcMock.mock.calls.some((c) => (c[1].p_records || []).some((r) => r.id === 'p-emoji'))).toBe(false);
        // p-good sí se confirmó; p-bad fue apartado a RECORD_REJECTED_KEY; cola vacía
        expect(await sync.pendingCount()).toBe(0);
        const quarantined = await store.getItem(RECORD_REJECTED_KEY);
        expect(Array.isArray(quarantined)).toBe(true);
        expect(quarantined.some((r) => r.id === 'p-bad')).toBe(true);
        expect(rpcMock.mock.calls.some((c) => (c[1].p_records || []).every((r) => r.id === 'p-good'))).toBe(true);
    });

    it('5. MED-07 mergeIntoLocal: registro borrado en pág 1 y recreado en pág 2 termina presente', () => {
        const local = [{ id: 'p1', name: 'Original', stock: 5 }];
        const merged = mergeIntoLocal('bodega_products_v1', local, [
            { id: 'p1', data: { id: 'p1' }, deleted_at: '2026-11-26T10:00:00Z' },
            { id: 'p1', data: { id: 'p1', name: 'Recreado' }, deleted_at: null },
        ]);
        expect(merged).toEqual([{ id: 'p1', name: 'Recreado', stock: 5 }]);
    });

    it('6. A4 + MED-01 onPulled se invoca al bajar filas y keepChannel dispara reconnected=true tras fallo inicial', async () => {
        const onPulled = vi.fn();
        const local = new Map();
        const client = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        order: () => ({
                            order: () => ({
                                limit: async () => ({
                                    data: [{ id: 'pNew', data: { id: 'pNew', name: 'Nuevo' }, version: 1, deleted_at: null, updated_at: '2026-11-26T20:00:00.000Z' }],
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        };
        const sync = createRecordSync({
            client,
            getSession: () => 'tok',
            store: memoryStore(),
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
            onPulled,
        });
        await sync.pull(['products']);
        expect(onPulled).toHaveBeenCalledWith('products', expect.arrayContaining([expect.objectContaining({ id: 'pNew' })]));

        // keepChannel: falla el primer intento (CHANNEL_ERROR), luego conecta por primera vez -> reconnected DEBE ser true
        let subCb = null;
        const fakeCh = {
            on: () => fakeCh,
            subscribe: (cb) => { subCb = cb; return fakeCh; },
        };
        const rtClient = { channel: () => fakeCh, removeChannel: vi.fn() };
        const onUp = vi.fn();
        const handle = keepChannel(rtClient, 'test-ch', (c) => c, { onUp, minDelayMs: 5, maxDelayMs: 20 });
        try {
            subCb('CHANNEL_ERROR');
            await new Promise((r) => setTimeout(r, 15));
            subCb('SUBSCRIBED');
            expect(onUp).toHaveBeenCalledWith({ reconnected: true });
        } finally {
            handle.dispose();
        }
    });
});
