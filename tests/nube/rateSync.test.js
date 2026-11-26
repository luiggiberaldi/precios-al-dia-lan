/**
 * Tasa única por cuenta: la que pone el dueño o un administrador en una caja llega a las
 * demás, y un cajero no la publica (ni atasca la cola de la caja).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync } from '../../src/nube/recordSync.js';
import {
    RATE_KEY, readRateSnapshot, applyRateSnapshot, setNubeRateLink, markNubeRateReady, publishRate,
} from '../../src/nube/rateSync.js';

function fakeLocalStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, dump: () => Object.fromEntries(m) };
}

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

afterEach(() => setNubeRateLink(null));

describe('tasa · utilidades', () => {
    it('lee y aplica la tasa en las claves de siempre, avisando solo lo que cambió', () => {
        const a = fakeLocalStorage({ bodega_rate_mode: 'manual', bodega_custom_rate: '950.5', tasa_cop: '4100', cop_enabled: 'true' });
        const snap = readRateSnapshot(a);
        expect(snap).toEqual({ rateMode: 'manual', customRate: '950.5', copEnabled: true, autoCopEnabled: false, tasaCop: '4100', copPrimary: false });

        const b = fakeLocalStorage({ bodega_rate_mode: 'bcv', cop_enabled: 'false', auto_cop_enabled: 'false', cop_primary: 'false' });
        const avisos = [];
        applyRateSnapshot(snap, { storage: b, dispatch: (k) => avisos.push(k) });
        expect(readRateSnapshot(b)).toEqual(snap);
        expect(b.getItem('bodega_use_auto_rate')).toBe('false');
        expect(avisos.sort()).toEqual(['bodega_custom_rate', 'bodega_rate_mode', 'bodega_use_auto_rate', 'cop_enabled', 'tasa_cop'].sort());
        expect(applyRateSnapshot(snap, { storage: b, dispatch: () => {} })).toEqual([]);
        expect(applyRateSnapshot({ rateMode: 'raro' }, { storage: b, dispatch: () => {} })).toEqual([]);
    });

    it('no publica antes de la primera bajada, ni si es cajero, ni si no cambió', async () => {
        let cloud = null;
        let role = 'cajero';
        const storage = fakeLocalStorage({ bodega_rate_mode: 'manual', bodega_custom_rate: '900' });
        setNubeRateLink({ readCloud: async () => cloud, writeCloud: async (v) => { cloud = v; }, canEdit: () => role !== 'cajero' });
        expect(await publishRate({ storage })).toBe(false); // aún sin bajar
        await markNubeRateReady();
        expect(await publishRate({ storage })).toBe(false); // cajero
        role = 'administrador';
        expect(await publishRate({ storage })).toBe(true);
        expect(cloud.customRate).toBe('900');
        expect(await publishRate({ storage })).toBe(false); // igual que la nube
        storage.setItem('bodega_custom_rate', '910');
        expect(await publishRate({ storage, onlyIfMissing: true })).toBe(false); // al entrar no pisa la de la cuenta
    });
});

describe('tasa · entre cajas (SQL real)', () => {
    it('la tasa que pone el administrador en la caja A llega a la caja B; la de un cajero no atasca la caja', async () => {
        const db = await createDb();
        const owner = await createUser(db, { email: 'tasa@x.test' });
        const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Tasa', 'Centro', 'Dueño', '482913']);
        await q(db, 'service', 'update public.account_licenses set max_cajas = 10 where account_id = $1', [accountId]);
        const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
        const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);

        async function caja(label, memberId, pin) {
            const user = await createUser(db, { anonymous: true });
            await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, label]);
            const [{ id: deviceId }] = await q(db, 'service', 'select id from public.account_devices where label = $1', [label]);
            const client = new FakeSupabase(db);
            client.user = user;
            const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [memberId, pin]);
            const local = new Map();
            const ls = fakeLocalStorage({ bodega_rate_mode: 'bcv' });
            const sync = createRecordSync({
                client, getSession: () => s.session_token, store: memoryStore(), cashIdSuffix: deviceId,
                readLocal: async (k) => structuredClone(local.get(k) ?? null),
                writeLocal: async (k, v) => {
                    local.set(k, structuredClone(v));
                    if (k === RATE_KEY) applyRateSnapshot(v, { storage: ls, dispatch: () => {} });
                },
            });
            const write = async (k, v) => { local.set(k, structuredClone(v)); await sync.onLocalWrite(k, v); await sync.flush(); };
            return { sync, local, ls, write };
        }

        const a = await caja('Caja A', adminId, '246801');
        const b = await caja('Caja B', cajeroId, '1357');

        a.ls.setItem('bodega_rate_mode', 'manual');
        a.ls.setItem('bodega_custom_rate', '987.65');
        await a.write(RATE_KEY, readRateSnapshot(a.ls));
        expect(a.sync.getLastError()).toBeNull();

        await b.sync.pull();
        expect(b.ls.getItem('bodega_rate_mode')).toBe('manual');
        expect(b.ls.getItem('bodega_custom_rate')).toBe('987.65');

        // Si un cajero llegara a encolar la tasa, el servidor la rechaza, pero su turno sube igual.
        await b.write(RATE_KEY, { ...readRateSnapshot(b.ls), customRate: '1' });
        await b.write('bodega_sales_v1', [{ id: 'v1', tipo: 'VENTA', totalUsd: 1, timestamp: new Date().toISOString() }]);
        expect(b.sync.getLastError()).toMatch(/dueño o un administrador/);
        const rows = await q(db, 'service', "select id from public.account_records where collection = 'cash'");
        expect(rows).toHaveLength(1);
    }, 90_000);
});
