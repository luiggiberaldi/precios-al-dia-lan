/**
 * Verifica las migraciones del Puente de Internet (`supabase/lan/001_puente_supervisor.sql`)
 * ejecutándose sobre Postgres real (PGlite):
 *   - Tablas bloqueadas para `anon` (RLS estricta)
 *   - Validación bcrypt de `master_secret` en push/claim/ack
 *   - Login de supervisor con código + PIN + bloqueo tras 5 fallos
 *   - Encolado idempotente, reclamo atómico y confirmación de comandos
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.resolve(__dirname, '../../supabase/lan/001_puente_supervisor.sql');
const SQL_PATH_002 = path.resolve(__dirname, '../../supabase/lan/002_puente_supervisor_hardening.sql');

async function setupCloudDb() {
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
        do $$ begin
            if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        end $$;
        grant usage on schema public to anon, authenticated;
    `);
    await db.exec(fs.readFileSync(SQL_PATH, 'utf8'));
    await db.exec(fs.readFileSync(SQL_PATH_002, 'utf8'));
    return db;
}

async function asAnon(db, sql, params = []) {
    return db.transaction(async (tx) => {
        await tx.exec('set local role anon;');
        return (await tx.query(sql, params)).rows;
    });
}

describe('Puente de Supervisor en Supabase (SQL real en PGlite)', () => {
    it('bloquea acceso directo por RLS, protege secreto de Caja Principal y aplica bloqueo de PIN', async () => {
        const db = await setupCloudDb();
        const accountId = '11111111-1111-4111-8111-111111111111';
        const masterSecret = 'secreto-super-largo-1234567890';

        // 1. Anon no puede leer ninguna tabla directa
        await expect(asAnon(db, 'select * from public.lan_cloud_accounts')).rejects.toThrow();
        await expect(asAnon(db, 'select * from public.lan_supervisor_commands')).rejects.toThrow();

        // 2. Caja Principal registra el negocio en el puente
        const reg = await asAnon(
            db,
            'select * from public.lan_bridge_register($1, $2, $3, $4, $5)',
            [accountId, 'Bodega Puente', masterSecret, 'SUP-482910', '753951'],
        );
        expect(reg[0].supervisor_code).toBe('SUP-482910');

        // 3. Un tercero con secreto incorrecto no puede sobrescribir ni subir snapshot
        await expect(
            asAnon(db, 'select * from public.lan_bridge_register($1, $2, $3, $4, $5)', [accountId, 'Otro', 'secreto-incorrecto-12345', 'SUP-999999', null]),
        ).rejects.toThrow(/inválido/i);

        await expect(
            asAnon(db, 'select * from public.lan_bridge_push_snapshot($1, $2, $3::jsonb)', [accountId, 'secreto-incorrecto', JSON.stringify({ ok: false })]),
        ).rejects.toThrow(/inválido/i);

        // 4. Push de snapshot con secreto válido
        await asAnon(
            db,
            'select public.lan_bridge_push_snapshot($1, $2, $3::jsonb)',
            [accountId, masterSecret, JSON.stringify({ sales: [{ id: 's1', number: '#A-00001' }] })],
        );

        // 5. Bloqueo tras 5 intentos fallidos de PIN (devuelve vacío sin abortar tx para guardar failed_attempts)
        for (let i = 0; i < 5; i += 1) {
            const bad = await asAnon(db, 'select * from public.lan_supervisor_login($1, $2)', ['SUP-482910', '000000']);
            expect(bad).toHaveLength(0);
        }
        await expect(
            asAnon(db, 'select * from public.lan_supervisor_login($1, $2)', ['SUP-482910', '753951']),
        ).rejects.toThrow(/Demasiados intentos/);

        // Desbloquear manualmente en BD de prueba y probar login válido + ciclo de comandos
        await db.query('update public.lan_cloud_accounts set failed_attempts = 0, locked_until = null where account_id = $1', [accountId]);
        const loginRows = await asAnon(db, 'select * from public.lan_supervisor_login($1, $2)', ['SUP-482910', '753951']);
        const sessionToken = loginRows[0].session_token;
        expect(sessionToken).toBeTruthy();

        const snapRows = await asAnon(db, 'select * from public.lan_supervisor_get_snapshot($1)', [sessionToken]);
        expect(snapRows[0].snapshot.sales[0].number).toBe('#A-00001');

        // 6. Encolado idempotente y reclamo atómico por Caja Principal
        const cmdId = '22222222-2222-4222-8222-222222222222';
        await asAnon(db, 'select * from public.lan_supervisor_enqueue($1, $2, $3, $4::jsonb)', [sessionToken, cmdId, 'update_rate', JSON.stringify({ data: { rateMode: 'manual', customRate: '98.5' } })]);
        await asAnon(db, 'select * from public.lan_supervisor_enqueue($1, $2, $3, $4::jsonb)', [sessionToken, cmdId, 'update_rate', JSON.stringify({ data: { rateMode: 'manual', customRate: '98.5' } })]);

        const claimed = await asAnon(db, 'select * from public.lan_bridge_claim_commands($1, $2, $3)', [accountId, masterSecret, 10]);
        expect(claimed).toHaveLength(1);
        expect(claimed[0].action).toBe('update_rate');

        // Segunda llamada ya no lo devuelve (está processing)
        const claimedAgain = await asAnon(db, 'select * from public.lan_bridge_claim_commands($1, $2, $3)', [accountId, masterSecret, 10]);
        expect(claimedAgain).toHaveLength(0);

        // Confirmar y verificar en resumen del supervisor
        await asAnon(db, 'select public.lan_bridge_ack_command($1, $2, $3, $4, $5)', [accountId, masterSecret, cmdId, 'applied', null]);
        const snap2 = await asAnon(db, 'select * from public.lan_supervisor_get_snapshot($1)', [sessionToken]);
        expect(snap2[0].recent_commands[0].status).toBe('applied');

        // T17 (002): 1) Sin oráculo de código inexistente (devuelve vacío igual que PIN erróneo)
        const unknownCode = await asAnon(db, 'select * from public.lan_supervisor_login($1, $2)', ['SUP-000000', '753951']);
        expect(unknownCode).toHaveLength(0);

        // T17 (002): 2) Reclamación de comando atascado en 'processing' > 60s
        const stuckId = '33333333-3333-4333-8333-333333333333';
        await asAnon(db, 'select * from public.lan_supervisor_enqueue($1, $2, $3, $4::jsonb)', [sessionToken, stuckId, 'refresh_snapshot', '{}']);
        const firstClaim = await asAnon(db, 'select * from public.lan_bridge_claim_commands($1, $2, $3)', [accountId, masterSecret, 10]);
        expect(firstClaim).toHaveLength(1);
        await db.query("update public.lan_supervisor_commands set updated_at = now() - interval '90 seconds' where id = $1", [stuckId]);
        const reclaimed = await asAnon(db, 'select * from public.lan_bridge_claim_commands($1, $2, $3)', [accountId, masterSecret, 10]);
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0].id).toBe(stuckId);

        // T17 (002): 3) Cambiar el PIN en lan_bridge_register revoca sesiones activas inmediatamente
        await asAnon(db, 'select * from public.lan_bridge_register($1, $2, $3, $4, $5)', [accountId, 'Bodega Puente', masterSecret, 'SUP-482910', '888999']);
        await expect(
            asAnon(db, 'select * from public.lan_supervisor_get_snapshot($1)', [sessionToken]),
        ).rejects.toThrow(/vencida/i);

        await db.close();
    }, 60_000);
});
