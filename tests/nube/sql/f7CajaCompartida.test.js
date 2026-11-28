/**
 * Fase 2 — Migración 023: Modo "Caja compartida / Gaveta única".
 *
 * Verifica en Postgres real (PGlite):
 *  - apertura única idempotente entre Caja A y Caja B (sin duplicar turnos),
 *  - ventas + anulación cruzada entre PCs cuando cash_drawer_mode = 'shared'
 *    conservando updated_by_device original,
 *  - bloqueo intacto en modo 'separate' (una caja no toca registros de otra),
 *  - cierre único atómico e idempotente (cierra todos los registros del shiftId).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, q, expectError } from './harness.js';

async function setup(db, { shared = true } = {}) {
    const owner = await createUser(db, { email: `${randomUUID()}@x.test` });
    const [{ create_account: accountId }] = await q(
        db,
        owner,
        'select public.create_account($1,$2,$3,$4)',
        ['Gaveta Unica', 'Centro', 'Dueño', '482913'],
    );
    await q(db, 'service', 'update public.account_licenses set max_cajas = 5 where account_id = $1', [accountId]);
    if (shared) {
        await q(
            db,
            owner,
            "select * from public.push_records_v2(null, 'settings', $1::jsonb)",
            [JSON.stringify([{ id: 'pdn_business_config_v1', data: { cash_drawer_mode: 'shared' } }])],
        );
    }
    const [{ upsert_member: cajeroId }] = await q(
        db,
        owner,
        'select public.upsert_member(null,$1,$2,$3)',
        ['Cajero', 'cajero', '1357'],
    );
    const cajas = [];
    for (const label of ['A', 'B']) {
        const user = await createUser(db, { anonymous: true });
        const [row] = await q(db, owner, 'select * from public.register_device($1, $2)', [user.id, `Caja ${label}`]);
        const [s] = await q(db, user, 'select * from public.member_login_pin($1,$2)', [cajeroId, '1357']);
        cajas.push({ user, row, session: s.session_token });
    }
    return { owner, accountId, cajas };
}

const now = () => new Date().toISOString();

describe('Fase 2 · migración 023 — caja compartida / gaveta única', () => {
    let db;
    beforeAll(async () => { db = await createDb(); }, 60_000);

    it('apertura idempotente: Caja A abre turno y Caja B recibe el mismo shift sin duplicar', async () => {
        const { cajas: [a, b] } = await setup(db, { shared: true });
        const [resA] = await q(
            db,
            a.user,
            'select public.open_shared_cash_shift($1, $2, $3::jsonb) as res',
            [a.session, 'shift_001', JSON.stringify({ id: 'ap_001', openingUsd: 50, openingBs: 2000, timestamp: now() })],
        );
        expect(resA.res.already_open).toBe(false);
        expect(resA.res.shift.id).toBe('shift_001');
        expect(resA.res.opening_record.shiftId).toBe('shift_001');

        const [resB] = await q(
            db,
            b.user,
            'select public.open_shared_cash_shift($1, $2, $3::jsonb) as res',
            [b.session, 'shift_002', JSON.stringify({ id: 'ap_002', openingUsd: 999, timestamp: now() })],
        );
        expect(resB.res.already_open).toBe(true);
        expect(resB.res.shift.id).toBe('shift_001');
        expect(resB.res.opening_record.openingUsd).toBe(50);

        const [active] = await q(db, b.user, 'select public.get_active_shared_shift($1) as res', [b.session]);
        expect(active.res.shift.id).toBe('shift_001');
    });

    it('en modo compartido Caja B puede anular una venta de Caja A conservando updated_by_device original; en modo separate se rechaza', async () => {
        const { accountId, cajas: [a, b] } = await setup(db, { shared: true });
        await q(
            db,
            a.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [a.session, JSON.stringify([{ id: 'v_a1', data: { id: 'v_a1', tipo: 'VENTA', shiftId: 's1', totalUsd: 20, timestamp: now() } }])],
        );

        // Caja B anula la venta de Caja A
        await q(
            db,
            b.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [b.session, JSON.stringify([{ id: 'v_a1', data: { id: 'v_a1', tipo: 'VENTA', shiftId: 's1', totalUsd: 20, status: 'ANULADA', timestamp: now() } }])],
        );

        const [row] = await q(
            db,
            'service',
            "select data, updated_by_device from public.account_records where account_id = $1 and collection = 'cash' and id = 'v_a1'",
            [accountId],
        );
        expect(row.data.status).toBe('ANULADA');
        expect(row.updated_by_device).toBe(a.row.id);

        // En modo separate, el bloqueo entre cajas sigue intacto
        const sep = await setup(db, { shared: false });
        await q(
            db,
            sep.cajas[0].user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [sep.cajas[0].session, JSON.stringify([{ id: 'v_sep', data: { id: 'v_sep', tipo: 'VENTA', totalUsd: 10, timestamp: now() } }])],
        );
        expect(await expectError(
            q(
                db,
                sep.cajas[1].user,
                "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
                [sep.cajas[1].session, JSON.stringify([{ id: 'v_sep', data: { id: 'v_sep', tipo: 'VENTA', status: 'ANULADA', timestamp: now() } }])],
            ),
        )).toMatch(/de otra caja/);
    });

    it('cierre único atómico: cierra registros de ambas PCs e impide cierre duplicado', async () => {
        const { accountId, cajas: [a, b] } = await setup(db, { shared: true });
        await q(
            db,
            a.user,
            'select public.open_shared_cash_shift($1, $2, $3::jsonb)',
            [a.session, 'shift_close_1', JSON.stringify({ id: 'ap_c1', openingUsd: 30, timestamp: now() })],
        );
        await q(
            db,
            a.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [a.session, JSON.stringify([{ id: 'v_c1', data: { id: 'v_c1', tipo: 'VENTA', shiftId: 'shift_close_1', totalUsd: 12, cajaCerrada: false, timestamp: now() } }])],
        );
        await q(
            db,
            b.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [b.session, JSON.stringify([{ id: 'v_c2', data: { id: 'v_c2', tipo: 'VENTA', shiftId: 'shift_close_1', totalUsd: 18, cajaCerrada: false, timestamp: now() } }])],
        );

        const [close1] = await q(
            db,
            a.user,
            'select public.close_shared_cash_shift($1, $2, $3::jsonb) as res',
            [a.session, 'shift_close_1', JSON.stringify({ id: 'cierre_c1', cierreId: 123456, summary: { todayTotalUsd: 30 } })],
        );
        expect(close1.res.already_closed).toBe(false);
        expect(close1.res.closed_records).toBe(3); // ap_c1 + v_c1 + v_c2

        // Intento concurrente de Caja B devuelve already_closed: true
        const [close2] = await q(
            db,
            b.user,
            'select public.close_shared_cash_shift($1, $2, $3::jsonb) as res',
            [b.session, 'shift_close_1', JSON.stringify({ id: 'cierre_c2', cierreId: 123457 })],
        );
        expect(close2.res.already_closed).toBe(true);

        const openLeft = await q(
            db,
            'service',
            "select id from public.account_records where account_id = $1 and collection = 'cash' and coalesce((data ->> 'cajaCerrada')::boolean, false) = false",
            [accountId],
        );
        expect(openLeft).toHaveLength(0);
    });

    it('migración 025: destraba cierre cuando no hay fila en shared_cash_shifts (apertura previa, gasto sin shiftId o sufijo @deviceId) y evita que push rezagado reabra caja', async () => {
        const { accountId, cajas: [a, b] } = await setup(db, { shared: true });

        // Simular turno abierto previo sin fila en shared_cash_shifts + venta ($0.70) + gasto (-$3.00 sin shiftId)
        // incluyendo un registro con sufijo @device heredado del modo independiente.
        await q(
            db,
            a.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [a.session, JSON.stringify([
                { id: `ap_legacy@${a.row.id}`, data: { id: 'ap_legacy', tipo: 'APERTURA_CAJA', openingUsd: 0, openingBs: 0, cajaCerrada: false, timestamp: now() } },
                { id: 'v_070', data: { id: 'v_070', tipo: 'VENTA', totalUsd: 0.70, totalBs: 648.45, cajaCerrada: false, timestamp: now() } },
            ])],
        );
        await q(
            db,
            b.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [b.session, JSON.stringify([
                { id: 'g_300', data: { id: 'g_300', tipo: 'GASTO_INTERNO', totalUsd: -3, cajaCerrada: false, timestamp: now() } },
            ])],
        );

        // Caja A cierra sin shiftId → NO debe devolver already_closed: true, sino cerrar los 3 registros
        const [closeA] = await q(
            db,
            a.user,
            'select public.close_shared_cash_shift($1, $2, $3::jsonb) as res',
            [a.session, '', JSON.stringify({ id: 'cierre_fix_1', cierreId: 999001, summary: { todayTotalUsd: 0.70 } })],
        );
        expect(closeA.res.already_closed).toBe(false);
        expect(closeA.res.closed_records).toBe(3);
        expect(closeA.res.shift?.status).toBe('closed');

        // Ahora sí: si Caja B intenta volver a cerrar sin movimientos abiertos, recibe already_closed: true
        const [closeB] = await q(
            db,
            b.user,
            'select public.close_shared_cash_shift($1, $2, $3::jsonb) as res',
            [b.session, '', JSON.stringify({ id: 'cierre_fix_2', cierreId: 999002 })],
        );
        expect(closeB.res.already_closed).toBe(true);

        // Si Caja B empuja una cola rezagada con cajaCerrada: false sobre v_070, push_records_v2 conserva cajaCerrada: true
        const [pushedStale] = await q(
            db,
            b.user,
            "select * from public.push_records_v2($1, 'cash', $2::jsonb)",
            [b.session, JSON.stringify([
                { id: 'v_070', data: { id: 'v_070', tipo: 'VENTA', totalUsd: 0.70, totalBs: 648.45, cajaCerrada: false, timestamp: now() } },
            ])],
        );
        expect(pushedStale.merged).toBe(true);
        expect(pushedStale.data?.cajaCerrada).toBe(true);

        const openLeft = await q(
            db,
            'service',
            "select id from public.account_records where account_id = $1 and collection = 'cash' and coalesce((data ->> 'cajaCerrada')::boolean, false) = false",
            [accountId],
        );
        expect(openLeft).toHaveLength(0);
    });
});
