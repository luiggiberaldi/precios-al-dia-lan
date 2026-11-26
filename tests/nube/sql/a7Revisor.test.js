/**
 * A7 · el revisor de cuadres encuentra lo que no cuadra y nada más.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

describe('A7 · revisor de cuadres', () => {
    it('vacío con todo en orden; detecta un nivel alterado; solo service_role lo corre', async () => {
        const db = await createDb();
        const owner = await createUser(db, { email: 'a7@x.test' });
        await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['A7', 'Centro', 'Dueño', '482913']);
        const user = await createUser(db, { anonymous: true });
        await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, 'Caja']);
        const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
        await q(db, user, 'select * from public.process_stock_movements($1, $2, $3::jsonb)', [s.session_token, 'INICIAL', JSON.stringify([{ id: randomUUID(), product_id: 'p', qty: 5 }])]);
        await q(db, user, 'select * from public.process_checkout($1, $2::jsonb)', [s.session_token, JSON.stringify({ id: randomUUID(), items: [{ product_id: 'p', qty: 2 }] })]);
        await q(db, user, 'select * from public.push_customer_movements($1, $2::jsonb)', [s.session_token, JSON.stringify([{ id: randomUUID(), customer_id: 'c', type: 'VENTA_FIADA', amount_usd: 3 }])]);

        expect(await q(db, 'service', 'select * from nube_private.verify_invariants()')).toEqual([]);

        // Alguien toca el nivel por fuera del libro (no debería poder; simulamos el daño).
        await db.exec("update public.stock_levels set qty = 99 where product_id = 'p'");
        await db.exec("update public.customer_balances set balance_usd = 0 where customer_id = 'c'");
        const found = await q(db, 'service', 'select check_name from nube_private.verify_invariants() order by 1');
        expect(found.map((r) => r.check_name)).toEqual(['cartera', 'stock']);

        expect(await expectError(q(db, owner, 'select * from nube_private.verify_invariants()'))).toMatch(/permission denied/);
    }, 60_000);
});
