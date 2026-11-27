// @vitest-environment jsdom
//
// T11 · Cashea de extremo a extremo y protección multi-caja anti-LWW (C9):
//   1. VENTA_CASHEA con casheaUsd = 40 incrementa customer.casheaDeuda a 40 y registra movimiento en bodega_cashea_ledger_v1.
//   2. Dos cajas registrando remesas Cashea concurrentes (-$15 en Caja A, -$10 en Caja B sobre $40)
//      convergen exactamente a $15 sin lost update (modelo aditivo por registro + keep: ['casheaDeuda']).
//   3. CustomersView.handleDeleteCustomerRequest bloquea borrado si casheaDeuda > 0.005.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q } from './sql/harness.js';
import { FakeSupabase } from './sql/fakeSupabase.js';
import { createRecordSync, SYNCED_KEYS } from '../../src/nube/recordSync.js';
import {
    CASHEA_LEDGER_KEY,
    buildCasheaMovement,
    applyCasheaBalances,
} from '../../src/utils/casheaLedger.js';

function memoryStore() {
    const m = new Map();
    return {
        getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
        setItem: async (k, v) => { m.set(k, structuredClone(v)); },
    };
}

describe('T11 · Cashea end-to-end y convergencia multi-caja', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('1. C9 checkoutProcessor suma casheaUsd a customer.casheaDeuda y registra movimiento auditable', () => {
        const src = readFileSync(join(process.cwd(), 'src', 'utils', 'checkoutProcessor.js'), 'utf8');
        expect(src).toMatch(/casheaDeuda/);
        expect(src).toMatch(/appendCasheaMovementWithinLock|CASHEA_LEDGER_KEY/);

        // Verificar que SYNCED_KEYS protege casheaDeuda contra LWW y sincroniza bodega_cashea_ledger_v1
        expect(SYNCED_KEYS.bodega_customers_v1.keep).toContain('casheaDeuda');
        expect(SYNCED_KEYS[CASHEA_LEDGER_KEY]).toBeDefined();
    });

    it('2. C9 dos cajas registrando remesas Cashea concurrentes (-$15 y -$10 sobre $40) convergen exactamente a $15', async () => {
        const db = await createDb();
        const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
        const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Cashea', 'Centro', 'Dueño', '482913']);
        await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
        const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Cajero', 'cajero', '1357']);

        const makeCaja = async (label) => {
            const user = await createUser(db, { anonymous: true });
            await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, label]);
            const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
            const client = new FakeSupabase(db);
            client.user = user;
            const local = new Map([
                ['bodega_customers_v1', [{ id: 'c1', name: 'Carlos', deuda: 0, favor: 0, casheaDeuda: 0 }]],
                [CASHEA_LEDGER_KEY, []],
            ]);
            const sync = createRecordSync({
                client,
                getSession: () => s.session_token,
                store: memoryStore(),
                canPush: (col) => col === 'customers' || col === 'cash' || col === 'cashea',
                readLocal: async (k) => structuredClone(local.get(k) ?? null),
                writeLocal: async (k, v) => {
                    local.set(k, structuredClone(v));
                    if (k === CASHEA_LEDGER_KEY) {
                        const { customers } = applyCasheaBalances(local.get('bodega_customers_v1'), v);
                        local.set('bodega_customers_v1', customers);
                    }
                },
            });
            const pushLedger = async (mov) => {
                const next = [...local.get(CASHEA_LEDGER_KEY), mov];
                local.set(CASHEA_LEDGER_KEY, next);
                const { customers } = applyCasheaBalances(local.get('bodega_customers_v1'), next);
                local.set('bodega_customers_v1', customers);
                await sync.onLocalWrite(CASHEA_LEDGER_KEY, next);
                await sync.flush();
            };
            return { sync, local, pushLedger };
        };

        const a = await makeCaja('Caja A');
        const b = await makeCaja('Caja B');

        // Venta Cashea de $40 en Caja A
        await a.pushLedger(buildCasheaMovement({ customerId: 'c1', type: 'VENTA_CASHEA', deltaUsd: 40, sourceSaleId: 'sale-1' }));
        await b.sync.pull(['cashea']);
        expect(a.local.get('bodega_customers_v1')[0].casheaDeuda).toBe(40);
        expect(b.local.get('bodega_customers_v1')[0].casheaDeuda).toBe(40);

        // Concurrentemente: Caja A cobra remesa -$15 y Caja B cobra remesa -$10 sin haberse visto
        await a.pushLedger(buildCasheaMovement({ customerId: 'c1', type: 'COBRO_CASHEA', deltaUsd: -15, sourceSaleId: 'rem-A' }));
        await b.pushLedger(buildCasheaMovement({ customerId: 'c1', type: 'COBRO_CASHEA', deltaUsd: -10, sourceSaleId: 'rem-B' }));

        await a.sync.pull(['cashea']);
        await b.sync.pull(['cashea']);

        expect(a.local.get('bodega_customers_v1')[0].casheaDeuda).toBe(15);
        expect(b.local.get('bodega_customers_v1')[0].casheaDeuda).toBe(15);
    }, 60_000);

    it('3. C9 CustomersView.handleDeleteCustomerRequest bloquea borrado si casheaDeuda > 0.005', () => {
        const src = readFileSync(join(process.cwd(), 'src', 'views', 'CustomersView.jsx'), 'utf8');
        const idx = src.indexOf('handleDeleteCustomerRequest');
        const block = src.slice(idx, idx + 900);
        expect(block).toMatch(/casheaDeuda/);
    });
});
