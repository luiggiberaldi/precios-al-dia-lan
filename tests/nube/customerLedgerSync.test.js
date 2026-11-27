/**
 * F4 · cartera de clientes entre dos cajas contra el SQL real (PGlite): E5 de punta a
 * punta (fía en A, abona en B, las dos ven el mismo saldo) y cola que sobrevive sin red.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import {
    createCustomerLedgerSync,
    applyBalances,
    toServerMovement,
    LEDGER_KEY,
    CUSTOMERS_KEY,
    LEDGER_REJECTED_KEY,
} from '../../src/nube/customerLedgerSync.js';
import { withLock } from '../../src/utils/withLock.js';

function memoryStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

const mov = (customerId, type, direction, amountUsd) => ({
    id: `ledger_${randomUUID()}`, customerId, type, direction, amountUsd, timestamp: new Date().toISOString(), status: 'COMPLETED',
});

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Cartera', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Caja', 'cajero', '1357']);
    const cajas = [];
    for (const label of ['A', 'B']) {
        const user = await createUser(db, { anonymous: true });
        await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, `Caja ${label}`]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
        const base = new FakeSupabase(db);
        base.user = user;
        const state = { offline: false };
        const client = {
            from: (...a) => base.from(...a),
            rpc: async (...a) => (state.offline ? { data: null, error: { message: 'Failed to fetch' } } : base.rpc(...a)),
        };
        const local = new Map([[CUSTOMERS_KEY, [{ id: 'maria', name: 'María', deuda: 0, favor: 0 }]], [LEDGER_KEY, []]]);
        const sync = createCustomerLedgerSync({
            client, getSession: () => s.session_token, store: memoryStore(),
            readLocal: async (k) => structuredClone(local.get(k) ?? null),
            writeLocal: async (k, v) => { local.set(k, structuredClone(v)); },
        });
        // Simula a la app heredada anotando en su libro y guardando (storageService → enganche).
        const anotar = async (m) => {
            const ledger = [...local.get(LEDGER_KEY), m];
            local.set(LEDGER_KEY, ledger);
            await sync.onLedgerWrite(ledger);
            await sync.flush();
        };
        cajas.push({ sync, local, anotar, state });
    }
    return cajas;
}

describe('F4 · utilidades', () => {
    it('convierte movimientos y aplica el saldo oficial (deuda o favor)', () => {
        const m = mov('c1', 'VENTA_FIADA', 'DEBIT', 4);
        expect(toServerMovement(m)).toMatchObject({ id: m.id, customer_id: 'c1', type: 'VENTA_FIADA', direction: 'DEBIT', amount_usd: 4 });
        const { customers, changed } = applyBalances([{ id: 'c1', deuda: 0, favor: 0 }, { id: 'c2', deuda: 1, favor: 0 }], { c1: -4.5, c2: 2 });
        expect(customers.map((c) => [c.deuda, c.favor])).toEqual([[4.5, 0], [0, 2]]);
        expect(changed).toBe(2);
    });
});

describe('F4 · dos cajas, una cartera', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('E5: fía en A, abona en B; las dos ven deuda de 5 y el mismo historial', async () => {
        const [a, b] = await setup(db);
        await a.anotar(mov('maria', 'VENTA_FIADA', 'DEBIT', 20));
        await b.sync.pull();
        expect(b.local.get(CUSTOMERS_KEY)[0].deuda).toBe(20);
        expect(b.local.get(LEDGER_KEY)).toHaveLength(1);

        await b.anotar(mov('maria', 'ABONO_DEUDA', 'CREDIT', 15));
        await a.sync.pull();
        await b.sync.pull();
        for (const caja of [a, b]) {
            expect(caja.local.get(CUSTOMERS_KEY)[0]).toMatchObject({ deuda: 5, favor: 0 });
            expect(caja.local.get(LEDGER_KEY).map((m) => m.balanceAfterUsd)).toEqual([-20, -5]);
        }
        // Bajar lo propio no lo vuelve a subir.
        expect(await a.sync.pending()).toBe(0);
        expect(await b.sync.pending()).toBe(0);
    });

    it('sin red el fiado queda en cola y sube después; nada se pierde (G10)', async () => {
        const [a, b] = await setup(db);
        a.state.offline = true;
        await a.anotar(mov('maria', 'VENTA_FIADA', 'DEBIT', 7));
        expect(await a.sync.pending()).toBe(1);
        expect(a.sync.getLastError()).toMatch(/Failed to fetch/);
        a.state.offline = false;
        await a.sync.flush();
        expect(await a.sync.pending()).toBe(0);
        await b.sync.pull();
        expect(b.local.get(CUSTOMERS_KEY)[0].deuda).toBe(7);
    });

    it('C6 doble gasto saldo_favor: pull() NO sobrescribe el saldo local de clientes con movimientos pendientes en queue', async () => {
        const [a] = await setup(db);
        // Servidor tiene favor = +10 para maría
        await a.anotar(mov('maria', 'VUELTO_ACREDITADO', 'CREDIT', 10));
        await a.sync.pull();
        expect(a.local.get(CUSTOMERS_KEY)[0]).toMatchObject({ favor: 10, deuda: 0 });

        // Caja A se desconecta y gasta el saldo a favor de $10 localmente -> local favor = 0, movimiento queda en queue
        a.state.offline = true;
        a.local.set(CUSTOMERS_KEY, [{ id: 'maria', name: 'María', deuda: 0, favor: 0 }]);
        await a.anotar(mov('maria', 'SALDO_FAVOR_USADO', 'DEBIT', 10));
        expect(await a.sync.pending()).toBe(1);

        // Llega un pull() antes de que flush() haya confirmado el movimiento -> servidor sigue devolviendo +10.
        // applyBalances DEBE omitir a maria porque está en state.queue!
        await a.sync.pull();
        expect(a.local.get(CUSTOMERS_KEY)[0]).toMatchObject({ favor: 0, deuda: 0 });

        // Al reconectar y hacer flush + pull -> servidor ya está en 0 y coincide.
        a.state.offline = false;
        await a.sync.flush();
        await a.sync.pull();
        expect(a.local.get(CUSTOMERS_KEY)[0]).toMatchObject({ favor: 0, deuda: 0 });
    });

    it('MED-11 applyBalances normaliza clientes corruptos con favor > 0 y deuda > 0 aunque el neto coincida, y respeta skipIds', () => {
        const { customers, changed } = applyBalances(
            [
                { id: 'c-corrupt', deuda: 5, favor: 5 },
                { id: 'c-queued', deuda: 0, favor: 0 },
            ],
            { 'c-corrupt': 0, 'c-queued': 10 },
            { skipIds: new Set(['c-queued']) },
        );
        expect(changed).toBe(1);
        expect(customers[0]).toMatchObject({ id: 'c-corrupt', deuda: 0, favor: 0 });
        expect(customers[1]).toMatchObject({ id: 'c-queued', deuda: 0, favor: 0 });
    });

    it('C8 poison-pill en customerLedgerSync.flush() se aparta a pdn_ledger_rejected_v1 sin bloquear movimientos válidos detrás', async () => {
        const store = memoryStore();
        const rpcMock = vi.fn(async (_fn, args) => {
            const list = args.p_movements || [];
            if (list.some((m) => m.id === 'mov-bad')) {
                return { data: null, error: { code: '22023', message: 'Movimiento de cliente inválido' } };
            }
            return {
                data: list.map((m) => ({ id: m.id, customer_id: m.customer_id, balance_after: -5, already_registered: false })),
                error: null,
            };
        });
        const sync = createCustomerLedgerSync({
            client: { rpc: rpcMock },
            getSession: () => 'tok',
            store,
            readLocal: async () => [],
            writeLocal: async () => {},
            withLocalLock: (fn) => withLock('pos_write_lock', fn, { fallbackWarning: false }),
        });

        await sync.onLedgerWrite([
            { id: 'mov-bad', customerId: 'c1', type: 'VENTA_FIADA', direction: 'DEBIT', amountUsd: -5, timestamp: new Date().toISOString() },
            { id: 'mov-good', customerId: 'c1', type: 'VENTA_FIADA', direction: 'DEBIT', amountUsd: 5, timestamp: new Date().toISOString() },
        ]);
        await sync.flush();

        expect(await sync.pending()).toBe(0);
        const rejected = await store.getItem(LEDGER_REJECTED_KEY);
        expect(Array.isArray(rejected)).toBe(true);
        expect(rejected.some((r) => r.id === 'mov-bad')).toBe(true);
        expect(rpcMock.mock.calls.some((c) => (c[1].p_movements || []).every((m) => m.id === 'mov-good'))).toBe(true);
        expect(typeof sync.applyKnownBalances).toBe('function');
    });
});
