/**
 * T04 · Pruebas SQL PGlite de la migración 019_sync_integridad_multicaja.sql:
 *   1. C11 anti-zombi: editar un producto borrado concurrentemente NO aplica merge_record_3way contra {"id": id}.
 *   2. C9 borrado de cliente con saldo: push_records_v2 rechaza borrar cliente si balance_usd <> 0.
 *   3. BAJ-01 S4: cajero borrando cliente ya borrado por admin NO devuelve rejected = true falsamente.
 *   4. A8 roles cartera: cajero NO puede enviar AJUSTE_CREDITO/AJUSTE_DEBITO/ANULACION/SALDO_INICIAL_MIGRADO.
 *   5. C8 dedup SALDO_INICIAL_MIGRADO: dos cajas con distinto UUID no duplican saldo inicial del mismo cliente.
 *   6. C4 process_void atómico: anular venta fiada revierte stock, revierte customer_movements/customer_balances,
 *      marca status='ANULADA' en account_records(collection='cash') y toca account_sync_state('cash_voids').
 *   7. A1 cash_records_range: consulta registros de caja por rango de fechas usando índice sin tope de 20,000 UUIDs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(db, owner, 'select public.create_account($1,$2,$3,$4)', ['Int019', 'Centro', 'Dueño', '482913']);
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    const [{ upsert_member: adminId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Admin', 'administrador', '246801']);
    const [{ upsert_member: cajeroId }] = await q(db, owner, 'select public.upsert_member(null,$1,$2,$3)', ['Cajero', 'cajero', '1357']);

    const uA = await createUser(db, { anonymous: true });
    const [devA] = await q(db, owner, 'select * from public.register_device($1, $2)', [uA.id, 'Caja A']);
    const [adminA] = await q(db, uA, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);
    const [cajeroA] = await q(db, uA, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);

    const uB = await createUser(db, { anonymous: true });
    const [devB] = await q(db, owner, 'select * from public.register_device($1, $2)', [uB.id, 'Caja B']);
    const [adminB] = await q(db, uB, 'select * from public.member_login_pin($1,$2)', [adminId, '246801']);

    return {
        owner, accountId,
        uA, devA: devA.id, adminA: adminA.session_token, cajeroA: cajeroA.session_token,
        uB, devB: devB.id, adminB: adminB.session_token,
    };
}

describe('T04 · Migración 019 de integridad multi-caja', () => {
    let db;
    beforeAll(async () => { db = await createDb({ times: 2 }); }, 60_000);

    it('1. C11 anti-zombi: editar un producto borrado en otra caja NO genera objeto incompleto sin name/category', async () => {
        const ctx = await setup(db);
        // v1: crear P1 completo
        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'products', JSON.stringify([{ id: 'p1', data: { id: 'p1', name: 'Harina', category: 'viveres', priceUsdt: 1.0 } }]),
        ]);
        // v2: Caja B borra P1 (guarda data = {"id":"p1"}, deleted_at = now())
        await q(db, ctx.uB, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminB, 'products', JSON.stringify([{ id: 'p1', data: { id: 'p1' }, deleted: true }]),
        ]);
        // v3: Caja A offline edita solo el precio partiendo de base_version = 1
        const [res] = await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'products', JSON.stringify([{
                id: 'p1',
                data: { id: 'p1', name: 'Harina', category: 'viveres', priceUsdt: 1.5 },
                base_version: 1,
            }]),
        ]);
        expect(res.merged).toBe(false);
        const [row] = await q(db, 'service', "select data, deleted_at from public.account_records where account_id = $1 and collection = 'products' and id = 'p1'", [ctx.accountId]);
        expect(row.deleted_at).toBeNull();
        // Debe conservar todos los campos completos (NUNCA zombi { id, priceUsdt } sin name!)
        expect(row.data.name).toBe('Harina');
        expect(row.data.category).toBe('viveres');
        expect(row.data.priceUsdt).toBe(1.5);
    });

    it('2. C9 borrado de cliente con saldo != 0: push_records_v2 rechaza el borrado y conserva el cliente vivo', async () => {
        const ctx = await setup(db);
        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'customers', JSON.stringify([{ id: 'c-deuda', data: { id: 'c-deuda', name: 'Juan Deudor' } }]),
        ]);
        // Registrar deuda de $25 en customer_movements
        await q(db, ctx.uA, 'select * from public.push_customer_movements($1, $2::jsonb)', [
            ctx.adminA, JSON.stringify([{ id: randomUUID(), customer_id: 'c-deuda', type: 'VENTA_FIADA', amount_usd: 25 }]),
        ]);
        // Admin intenta borrar c-deuda -> debe ser rechazado
        const [res] = await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'customers', JSON.stringify([{ id: 'c-deuda', data: { id: 'c-deuda' }, deleted: true }]),
        ]);
        expect(res.rejected).toBe(true);
        const [row] = await q(db, 'service', "select deleted_at from public.account_records where account_id = $1 and collection = 'customers' and id = 'c-deuda'", [ctx.accountId]);
        expect(row.deleted_at).toBeNull();
    });

    it('3. BAJ-01 S4: cajero enviando deleted=true para un cliente YA borrado por admin NO reporta rejected=true falsamente', async () => {
        const ctx = await setup(db);
        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'customers', JSON.stringify([{ id: 'c-del', data: { id: 'c-del', name: 'Viejo' } }]),
        ]);
        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'customers', JSON.stringify([{ id: 'c-del', data: { id: 'c-del' }, deleted: true }]),
        ]);
        const [res] = await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.cajeroA, 'customers', JSON.stringify([{ id: 'c-del', data: { id: 'c-del' }, deleted: true }]),
        ]);
        expect(res.rejected).toBe(false);
    });

    it('4. A8 roles en cartera: cajero NO puede empujar AJUSTE_CREDITO, AJUSTE_DEBITO, ANULACION ni SALDO_INICIAL_MIGRADO', async () => {
        const ctx = await setup(db);
        for (const forbiddenType of ['AJUSTE_CREDITO', 'AJUSTE_DEBITO', 'ANULACION', 'SALDO_INICIAL_MIGRADO']) {
            const msg = await expectError(
                q(db, ctx.uA, 'select * from public.push_customer_movements($1, $2::jsonb)', [
                    ctx.cajeroA, JSON.stringify([{
                        id: randomUUID(),
                        customer_id: 'c1',
                        type: forbiddenType,
                        direction: 'CREDIT',
                        amount_usd: 10,
                    }]),
                ]),
            );
            expect(msg).toMatch(/dueño o un administrador/i);
        }
        // Pero cajero SÍ puede registrar VENTA_FIADA y ABONO_DEUDA
        const [ok] = await q(db, ctx.uA, 'select * from public.push_customer_movements($1, $2::jsonb)', [
            ctx.cajeroA, JSON.stringify([{ id: randomUUID(), customer_id: 'c1', type: 'VENTA_FIADA', amount_usd: 10 }]),
        ]);
        expect(Number(ok.balance_after)).toBe(-10);
    });

    it('5. C8 dedup SALDO_INICIAL_MIGRADO: dos cajas con distinto UUID no duplican el saldo migrado del mismo cliente', async () => {
        const ctx = await setup(db);
        const [r1] = await q(db, ctx.uA, 'select * from public.push_customer_movements($1, $2::jsonb)', [
            ctx.adminA, JSON.stringify([{
                id: randomUUID(),
                customer_id: 'c-mig',
                type: 'SALDO_INICIAL_MIGRADO',
                direction: 'DEBIT',
                amount_usd: 30,
                source_type: 'MIGRATION',
                source_id: 'mig-c-mig',
            }]),
        ]);
        expect(r1.already_registered).toBe(false);
        expect(Number(r1.balance_after)).toBe(-30);

        const [r2] = await q(db, ctx.uB, 'select * from public.push_customer_movements($1, $2::jsonb)', [
            ctx.adminB, JSON.stringify([{
                id: randomUUID(), // UUID distinto en Caja B!
                customer_id: 'c-mig',
                type: 'SALDO_INICIAL_MIGRADO',
                direction: 'DEBIT',
                amount_usd: 30,
                source_type: 'MIGRATION',
                source_id: 'mig-c-mig',
            }]),
        ]);
        expect(r2.already_registered).toBe(true);
        expect(Number(r2.balance_after)).toBe(-30);
        const [bal] = await q(db, 'service', "select balance_usd from public.customer_balances where account_id = $1 and customer_id = 'c-mig'", [ctx.accountId]);
        expect(Number(bal.balance_usd)).toBe(-30);
    });

    it('6. C4 process_void atómico desde Supervisor: revierte stock, revierte cartera, marca cash ANULADA y toca cash_voids', async () => {
        const ctx = await setup(db);
        // Stock inicial 10
        await q(db, ctx.uA, 'select * from public.process_stock_movements($1, $2, $3::jsonb)', [
            ctx.adminA, 'INICIAL', JSON.stringify([{ id: randomUUID(), product_id: 'p-void', qty: 10 }]),
        ]);
        const saleId = randomUUID();
        const localSaleId = `local-${saleId.slice(0, 8)}`;
        // Cobrar venta fiada de 2 uds ($20) en Caja A
        await q(db, ctx.uA, 'select * from public.process_checkout($1, $2::jsonb, false, false)', [
            ctx.adminA, JSON.stringify({
                id: saleId,
                items: [{ product_id: 'p-void', qty: 2 }],
                total_usd: 20,
                payload: { localId: localSaleId, customerId: 'c-fiado', fiadoUsd: 20 },
            }),
        ]);
        // Registrar movimiento de fiado ligado al saleId (o localSaleId)
        await q(db, ctx.uA, 'select * from public.push_customer_movements($1, $2::jsonb)', [
            ctx.adminA, JSON.stringify([{
                id: randomUUID(),
                customer_id: 'c-fiado',
                type: 'VENTA_FIADA',
                direction: 'DEBIT',
                amount_usd: 20,
                source_type: 'SALE',
                source_sale_id: localSaleId,
            }]),
        ]);
        // Subir registro de caja (collection = 'cash')
        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'cash', JSON.stringify([{
                id: `${localSaleId}@${ctx.devA}`,
                data: { id: localSaleId, status: 'COMPLETADA', totalUsd: 20, nube: { saleId } },
            }]),
        ]);

        // Supervisor (p_session = null, dueño autenticado) anula la venta
        const [voidRes] = await q(db, ctx.owner, 'select * from public.process_void(null, $1, $2)', [saleId, 'Error de cobro']);
        expect(voidRes.already_voided).toBe(false);

        // 1) Stock restaurado a 10
        const [lvl] = await q(db, 'service', "select qty from public.stock_levels where account_id = $1 and product_id = 'p-void'", [ctx.accountId]);
        expect(Number(lvl.qty)).toBe(10);

        // 2) Cartera del cliente revertida a 0
        const [bal] = await q(db, 'service', "select balance_usd from public.customer_balances where account_id = $1 and customer_id = 'c-fiado'", [ctx.accountId]);
        expect(Number(bal.balance_usd)).toBe(0);

        // 3) Registro de caja marcado ANULADA
        const [cashRow] = await q(db, 'service', "select data from public.account_records where account_id = $1 and collection = 'cash' and id = $2", [ctx.accountId, `${localSaleId}@${ctx.devA}`]);
        expect(cashRow.data.status).toBe('ANULADA');
        expect(cashRow.data.voidReason).toBe('Error de cobro');

        // 4) Aviso en account_sync_state('cash_voids') emitido
        const [syncRow] = await q(db, 'service', "select collection, changed_at from public.account_sync_state where account_id = $1 and collection = 'cash_voids'", [ctx.accountId]);
        expect(syncRow?.collection).toBe('cash_voids');
    });

    it('7. A1 cash_records_range devuelve registros de caja en el rango de fechas y filtra opcionalmente por device_id', async () => {
        const ctx = await setup(db);
        const now = new Date();
        const from = new Date(now.getTime() - 60_000).toISOString();
        const to = new Date(now.getTime() + 60_000).toISOString();

        await q(db, ctx.uA, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminA, 'cash', JSON.stringify([{ id: `sale-A1@${ctx.devA}`, data: { id: 'sale-A1', totalUsd: 12, timestamp: now.toISOString() } }]),
        ]);
        await q(db, ctx.uB, 'select * from public.push_records_v2($1, $2, $3::jsonb)', [
            ctx.adminB, 'cash', JSON.stringify([{ id: `sale-B1@${ctx.devB}`, data: { id: 'sale-B1', totalUsd: 34, timestamp: now.toISOString() } }]),
        ]);

        const all = await q(db, ctx.uA, 'select * from public.cash_records_range($1::timestamptz, $2::timestamptz, null)', [from, to]);
        expect(all.map((r) => r.id).sort()).toEqual([`sale-A1@${ctx.devA}`, `sale-B1@${ctx.devB}`].sort());

        const onlyB = await q(db, ctx.uA, 'select * from public.cash_records_range($1::timestamptz, $2::timestamptz, $3)', [from, to, ctx.devB]);
        expect(onlyB).toHaveLength(1);
        expect(onlyB[0].id).toBe(`sale-B1@${ctx.devB}`);
    });
});
