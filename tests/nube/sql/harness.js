/**
 * Arnés A2 de Precios al Día Nube: Postgres real (PGlite) dentro de vitest, sin Docker.
 *
 * Simula lo mínimo de Supabase que usan las migraciones:
 *   · esquema `auth` con `auth.users`, `auth.uid()` y `auth.jwt()` leyendo
 *     `request.jwt.claims` (igual que PostgREST);
 *   · roles `anon`, `authenticated` y `service_role`;
 *   · pgcrypto en el esquema `extensions`.
 * Luego aplica, en orden, todas las migraciones de supabase/nube/migrations.
 *
 * `as(db, user)` ejecuta como un usuario: `null` = anon; `{ id, anonymous }` = authenticated.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'nube', 'migrations');

const SUPABASE_SHIM = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, is_anonymous boolean not null default false);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
-- Como Supabase: anon y authenticated reciben EXECUTE por defecto en funciones de public.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export function listMigrations() {
    return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

/** Base nueva con el shim y todas las migraciones aplicadas `times` veces (G4: repetibles). */
export async function createDb({ times = 1 } = {}) {
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(SUPABASE_SHIM);
    for (let i = 0; i < times; i += 1) {
        for (const file of listMigrations()) {
            await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        }
    }
    await db.exec('grant all on all tables in schema public to service_role;');
    return db;
}

/** Crea un usuario de Auth (dueño con correo o equipo anónimo). */
export async function createUser(db, { anonymous = false, email = null } = {}) {
    const id = randomUUID();
    await db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)', [id, email, anonymous]);
    return { id, anonymous };
}

/**
 * Ejecuta `fn(tx)` como ese usuario dentro de una transacción que se confirma
 * (o se deshace si lanza). `user = null` → anon; `'service'` → service_role.
 */
export async function as(db, user, fn) {
    return db.transaction(async (tx) => {
        if (user === 'service') {
            await tx.exec("set local role service_role; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);");
        } else if (user) {
            const claims = JSON.stringify({ sub: user.id, role: 'authenticated', is_anonymous: Boolean(user.anonymous) });
            await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
            await tx.exec('set local role authenticated;');
        } else {
            await tx.exec("set local role anon; select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true);");
        }
        return fn(tx);
    });
}

/** Atajo: una sola consulta como ese usuario. Devuelve las filas. */
export async function q(db, user, sql, params = []) {
    return as(db, user, async (tx) => (await tx.query(sql, params)).rows);
}

/** Espera que la consulta falle; devuelve el mensaje de error. */
export async function expectError(promise) {
    try {
        await promise;
    } catch (error) {
        return error?.message || String(error);
    }
    throw new Error('Se esperaba un error y la consulta funcionó');
}
