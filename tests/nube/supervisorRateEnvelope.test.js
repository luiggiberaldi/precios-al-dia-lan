// @vitest-environment jsdom
//
// T06 · Sincronización de tasas:
//   1. C12: Supervisor lee y escribe `pdn_rate_v1` con sobre `{ value: snap }` compatible con recordSync.
//   2. A6: Tasas automáticas (`autoRates: { bcv, euro, usdt, updatedAt }`) viajan dentro de `pdn_rate_v1`
//      para que cajas LAN sin internet apliquen la tasa BCV/Euro/USDT exacta (no el fallback 36.35).
//   3. A6: `accountReset.wipeLocalData` conserva las claves locales de tasa para no volver al default tras reinicio.
//   4. MED-05: `applyRateSnapshot` limpia `bodega_custom_rate` y `tasa_cop` cuando llegan vacíos.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync } from '../../src/nube/recordSync.js';
import { loadCurrentRate, updateSupervisorRate } from '../../src/nube/ownerDashboard.js';
import {
    RATE_KEY,
    readRateSnapshot,
    applyRateSnapshot,
    unwrapRateRecord,
    wrapRateRecord,
} from '../../src/nube/rateSync.js';
import { wipeLocalData } from '../../src/nube/accountReset.js';

function memoryStore() {
    const m = new Map();
    return {
        keys: async () => [...m.keys()],
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
        removeItem: async (k) => { m.delete(k); },
        clear: async () => { m.clear(); },
    };
}

function createFakeStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return {
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        clear: () => { m.clear(); },
        dump: () => Object.fromEntries(m.entries()),
    };
}

describe('T06 · Tasas Supervisor { value }, autoRates en LAN y accountReset', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('1. C12 Supervisor lee tasa publicada por Caja A y al actualizarla a 70 Bs, Caja A y Caja B la aplican al bajar settings', async () => {
        const db = await createDb();
        const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
        const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Tasas', 'Centro', 'Dueño', '482913']);
        await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
        const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);

        const uA = await createUser(db, { anonymous: true });
        await q(db, owner, 'select * from public.register_device($1, $2)', [uA.id, 'Caja A']);
        const [sA] = await q(db, uA, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        const clientA = new FakeSupabase(db);
        clientA.user = uA;

        const uB = await createUser(db, { anonymous: true });
        await q(db, owner, 'select * from public.register_device($1, $2)', [uB.id, 'Caja B']);
        const [sB] = await q(db, uB, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        const clientB = new FakeSupabase(db);
        clientB.user = uB;

        const localA = new Map();
        const storageA = createFakeStorage();
        const syncA = createRecordSync({
            client: clientA,
            getSession: () => sA.session_token,
            store: memoryStore(),
            readLocal: async (k) => structuredClone(localA.get(k) ?? null),
            writeLocal: async (k, v) => {
                localA.set(k, structuredClone(v));
                if (k === RATE_KEY) applyRateSnapshot(v, { storage: storageA, dispatch: () => {} });
            },
        });

        const localB = new Map();
        const storageB = createFakeStorage();
        const syncB = createRecordSync({
            client: clientB,
            getSession: () => sB.session_token,
            store: memoryStore(),
            readLocal: async (k) => structuredClone(localB.get(k) ?? null),
            writeLocal: async (k, v) => {
                localB.set(k, structuredClone(v));
                if (k === RATE_KEY) applyRateSnapshot(v, { storage: storageB, dispatch: () => {} });
            },
        });

        // 1. Caja A guarda tasa manual 65 Bs mediante recordSync (envuelve en { value: snap })
        const snap65 = { rateMode: 'manual', customRate: '65', copEnabled: false, autoCopEnabled: false, tasaCop: '', copPrimary: false };
        localA.set(RATE_KEY, snap65);
        await syncA.onLocalWrite(RATE_KEY, snap65);
        await syncA.flush();

        // 2. Supervisor (dueño) lee la tasa actual -> DEBE ver manual 65 (antes leía 'bcv' y '')
        const ownerClient = new FakeSupabase(db);
        ownerClient.user = owner;
        const current = await loadCurrentRate(ownerClient);
        expect(current.rateMode).toBe('manual');
        expect(current.customRate).toBe('65');

        // 3. Supervisor actualiza a manual 70 Bs -> debe escribir { value: { rateMode: 'manual', customRate: '70', ... } }
        await updateSupervisorRate(ownerClient, null, { rateMode: 'manual', customRate: '70', copEnabled: false });

        // 4. Caja A y Caja B hacen pull(['settings']) -> ambas aplican 70 Bs!
        await syncA.pull(['settings']);
        await syncB.pull(['settings']);

        expect(storageA.getItem('bodega_rate_mode')).toBe('manual');
        expect(storageA.getItem('bodega_custom_rate')).toBe('70');
        expect(storageB.getItem('bodega_rate_mode')).toBe('manual');
        expect(storageB.getItem('bodega_custom_rate')).toBe('70');
    }, 60_000);

    it('2. A6 autoRates (bcv, euro, usdt) viajan en pdn_rate_v1 y se aplican en monitor_rates_v12 de Caja Secundaria sin internet', () => {
        const storageA = createFakeStorage({
            bodega_rate_mode: 'bcv',
            bodega_use_auto_rate: 'true',
            monitor_rates_v12: JSON.stringify({
                bcv: { price: 92.45, source: 'BCV Oficial', change: 0 },
                euro: { price: 99.80, source: 'BCV Euro', change: 0 },
                usdt: { price: 95.10, source: 'Binance', change: 0 },
                lastUpdate: '2026-11-26T20:00:00.000Z',
            }),
        });
        const snap = readRateSnapshot(storageA);
        expect(snap.autoRates?.bcv).toBe(92.45);
        expect(snap.autoRates?.euro).toBe(99.80);
        expect(snap.autoRates?.usdt).toBe(95.10);

        const storageB = createFakeStorage();
        const dispatched = [];
        applyRateSnapshot(snap, { storage: storageB, dispatch: (k) => dispatched.push(k) });

        const cachedB = JSON.parse(storageB.getItem('monitor_rates_v12'));
        expect(cachedB.bcv.price).toBe(92.45);
        expect(cachedB.euro.price).toBe(99.80);
        expect(cachedB.usdt.price).toBe(95.10);
        expect(dispatched).toContain('monitor_rates_v12');
    });

    it('3. A6 wipeLocalData conserva las claves locales de tasa en localStorage tras reinicio de cuenta', async () => {
        const storage = createFakeStorage({
            bodega_rate_mode: 'manual',
            bodega_custom_rate: '75.50',
            bodega_use_auto_rate: 'false',
            bodega_products_v1: '[{"id":"p1"}]',
            bodega_sales_v1: '[{"id":"s1"}]',
        });
        await wipeLocalData({
            appStore: memoryStore(),
            shadowStore: memoryStore(),
            syncStore: memoryStore(),
            storage,
        });
        expect(storage.getItem('bodega_rate_mode')).toBe('manual');
        expect(storage.getItem('bodega_custom_rate')).toBe('75.50');
        expect(storage.getItem('bodega_use_auto_rate')).toBe('false');
        expect(storage.getItem('bodega_products_v1')).toBeNull();
        expect(storage.getItem('bodega_sales_v1')).toBeNull();
    });

    it('4. MED-05 applyRateSnapshot limpia bodega_custom_rate y tasa_cop cuando vienen vacíos y unwrap/wrap son retrocompatibles', () => {
        expect(typeof unwrapRateRecord).toBe('function');
        expect(typeof wrapRateRecord).toBe('function');
        expect(unwrapRateRecord({ value: { rateMode: 'manual', customRate: '60' } })).toEqual({ rateMode: 'manual', customRate: '60' });
        expect(unwrapRateRecord({ rateMode: 'bcv', customRate: '' })).toEqual({ rateMode: 'bcv', customRate: '' });
        expect(wrapRateRecord({ rateMode: 'manual', customRate: '60' })).toEqual({ value: { rateMode: 'manual', customRate: '60' } });

        const storage = createFakeStorage({
            bodega_rate_mode: 'manual',
            bodega_custom_rate: '55',
            tasa_cop: '4100',
        });
        applyRateSnapshot({
            rateMode: 'bcv',
            customRate: '',
            copEnabled: false,
            autoCopEnabled: false,
            tasaCop: '',
            copPrimary: false,
        }, { storage, dispatch: () => {} });

        expect(storage.getItem('bodega_rate_mode')).toBe('bcv');
        expect(storage.getItem('bodega_custom_rate')).toBeNull();
        expect(storage.getItem('tasa_cop')).toBeNull();
    });
});
