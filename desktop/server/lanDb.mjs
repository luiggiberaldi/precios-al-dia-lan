/**
 * Motor de base de datos local para Precios al Día LAN.
 *
 * Ejecuta Postgres real en disco (o en memoria para pruebas) mediante PGlite,
 * aplicando exactamente las mismas migraciones SQL de `supabase/nube/migrations`
 * más un esquema interno `lan_auth` para usuarios, sesiones, códigos de
 * vinculación y metadatos del servidor local.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_SHIM = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users (
    id uuid primary key,
    email text,
    is_anonymous boolean not null default false
);
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
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const LAN_AUTH_PRE_SCHEMA = `
create schema if not exists lan_auth;
create table if not exists lan_auth.applied_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
);
create table if not exists lan_auth.owner_credentials (
    user_id uuid primary key references auth.users(id) on delete cascade,
    email text not null unique,
    password_hash text not null,
    created_at timestamptz not null default now()
);
create table if not exists lan_auth.sessions (
    token text primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    is_anonymous boolean not null default false,
    created_at timestamptz not null default now()
);
create table if not exists lan_auth.meta (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
);
`;

const LAN_AUTH_POST_SCHEMA = `
create table if not exists lan_auth.pairing_codes (
    code text primary key,
    account_id uuid references public.accounts(id) on delete cascade,
    owner_user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz
);
create table if not exists lan_auth.offline_pin_verifiers (
    member_id uuid primary key references public.account_members(id) on delete cascade,
    salt text not null,
    hash text not null,
    no_pin boolean not null default false,
    iterations integer not null default 1000,
    updated_at timestamptz not null default now()
);
`;

// Misma clave pública RSA que src/security/tokenCrypto.js (Estación Maestra)
const DEFAULT_PUBLIC_KEY_JWK = {
    kty: 'RSA',
    n: '-Gh3FwCQ0uA4uHjdfnA6JQtVRZ6oG1bS6LDngpmB2AZY4Zbewed9cBVWI_Gh7NOoTcSRfwcqMUE_6IaEYLMgY2J-6vSbfCX3unuTn4ZHk9qKUPtUeBl6xJVHpMh-vGd3cqQiMHUvxEOMKQcOJDJyhf1sVR2ODKnVuVJvsX9-uYuUhLC4DrrrJe56PMW0gJwKnri5a9PEAJs0Ku-GeTbbE-3_gvGgsRaRDI8bgfwfxtussO_JYNM-gqMf8HiMPopNMW05NZQ-BrHIxRHBJRli6Q8ptsP5iH_qw46T7LXdsM0UqGSwxwRTfrxb5T4fgLwIE2rqIyFtJvaFiPRDWnNBjw',
    e: 'AQAB',
};

function sha256HexNode(str) {
    return crypto.createHash('sha256').update(String(str ?? ''), 'utf8').digest('hex');
}

function deriveOfflinePinDigestNode(pin, salt, memberId, iterations = 1000) {
    let hash = sha256HexNode(`${salt}:${memberId}:${pin}`);
    for (let i = 1; i < iterations; i += 1) {
        hash = sha256HexNode(`${hash}:${salt}`);
    }
    return hash;
}

const ALLOWED_TABLES = new Set([
    'accounts',
    'account_licenses',
    'sedes',
    'account_members',
    'account_devices',
    'account_records',
    'account_sync_state',
    'stock_levels',
    'stock_movements',
    'sales',
    'stock_discrepancies',
    'customer_movements',
    'customer_balances',
    'cash_shifts',
]);

const MUTATING_RPCS = new Set([
    'process_checkout',
    'process_void',
    'process_stock_movements',
    'push_records',
    'push_records_v2',
    'push_customer_movements',
    'reset_account',
    'register_device',
    'assign_device',
    'team_rename_device',
    'revoke_device',
    'team_revoke_device',
    'upsert_member',
    'team_upsert_member',
    'create_account',
]);

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const JSON_EXTRACT_RE = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)->>([a-z_][a-z0-9_]*)$/;
const ALIAS_COL_RE = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)$/;

const toIso = (v) => String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
const TIMESTAMP_AS_TEXT = { 1184: toIso, 1114: toIso };

function sqlIdent(name) {
    if (typeof name !== 'string' || !IDENT_RE.test(name)) {
        throw new Error(`Identificador SQL inválido: ${name}`);
    }
    return name;
}

function parseSelectList(selectStr) {
    const raw = String(selectStr || '*').trim();
    if (!raw || raw === '*') return '*';
    return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((token) => {
            if (token === '*') return '*';
            const jsonMatch = token.match(JSON_EXTRACT_RE);
            if (jsonMatch) {
                const [, alias, col, jsonKey] = jsonMatch;
                return `${col}->>'${jsonKey}' as ${alias}`;
            }
            const aliasMatch = token.match(ALIAS_COL_RE);
            if (aliasMatch) {
                const [, alias, col] = aliasMatch;
                return `${col} as ${alias}`;
            }
            return sqlIdent(token);
        })
        .join(', ');
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hex] = parts;
    const expected = Buffer.from(hex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}

function resolveDefaultMigrationsDir() {
    const candidates = [
        path.resolve(__dirname, '../../supabase/nube/migrations'),
        process.resourcesPath ? path.resolve(process.resourcesPath, 'migrations') : null,
    ].filter(Boolean);
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    return candidates[0];
}

export async function createLanDb({
    dataDir = null,
    migrationsDir = resolveDefaultMigrationsDir(),
} = {}) {
    if (dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const db = new PGlite({
        ...(dataDir ? { dataDir } : {}),
        extensions: { pgcrypto },
    });

    await db.exec(SUPABASE_SHIM);
    await db.exec(LAN_AUTH_PRE_SCHEMA);

    const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((f) => /^\d{3}_.+\.sql$/.test(f))
        .sort();

    const appliedRows = (await db.query('select filename from lan_auth.applied_migrations')).rows;
    const appliedSet = new Set(appliedRows.map((r) => r.filename));

    for (const file of migrationFiles) {
        if (appliedSet.has(file)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await db.exec(sql);
        await db.query('insert into lan_auth.applied_migrations (filename) values ($1) on conflict do nothing', [file]);
    }
    await db.exec(LAN_AUTH_POST_SCHEMA);
    await db.exec('grant all on all tables in schema public to service_role;');

    // Garantizar un lan_id persistente para identificar este servidor local.
    const existingMeta = (await db.query("select value from lan_auth.meta where key = 'lan_id'")).rows;
    let lanId = existingMeta[0]?.value?.id;
    if (!lanId) {
        lanId = `LAN-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        await db.query(
            "insert into lan_auth.meta (key, value) values ('lan_id', $1::jsonb) on conflict (key) do nothing",
            [JSON.stringify({ id: lanId })],
        );
    }

    // Cola secuencial: PGlite corre en una sola instancia WASM y las transacciones HTTP
    // concurrentes deben entrar ordenadamente para evitar colisiones de conexión.
    let queue = Promise.resolve();
    const enqueue = (fn) => {
        const next = queue.then(fn);
        queue = next.catch(() => {});
        return next;
    };

    async function asUser(user, fn) {
        return db.transaction(async (tx) => {
            if (user === 'service') {
                await tx.exec("set local role service_role; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);");
            } else if (user && user.id) {
                const claims = JSON.stringify({
                    sub: user.id,
                    role: 'authenticated',
                    is_anonymous: Boolean(user.anonymous),
                });
                await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
                await tx.exec('set local role authenticated;');
            } else {
                await tx.exec("set local role anon; select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true);");
            }
            return fn(tx);
        });
    }

    async function createDeviceSession() {
        return enqueue(async () => {
            const userId = crypto.randomUUID();
            const token = crypto.randomBytes(32).toString('hex');
            await db.query('insert into auth.users (id, email, is_anonymous) values ($1, null, true)', [userId]);
            await db.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, true)', [token, userId]);
            return { token, user: { id: userId, email: null, anonymous: true } };
        });
    }

    async function signUpOwner(email, password) {
        const cleanEmail = String(email || '').trim().toLowerCase();
        if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            throw Object.assign(new Error('Escribe un correo válido.'), { code: 'invalid_email', status: 400 });
        }
        if (String(password || '').length < 8) {
            throw Object.assign(new Error('La contraseña debe tener al menos 8 caracteres.'), { code: 'weak_password', status: 400 });
        }
        return enqueue(async () => {
            const exists = (await db.query('select user_id from lan_auth.owner_credentials where lower(email) = $1', [cleanEmail])).rows;
            if (exists.length) {
                throw Object.assign(new Error('User already registered'), { code: 'user_already_exists', status: 400 });
            }
            const userId = crypto.randomUUID();
            const token = crypto.randomBytes(32).toString('hex');
            const pwHash = hashPassword(password);
            await db.transaction(async (tx) => {
                await tx.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, false)', [userId, cleanEmail]);
                await tx.query('insert into lan_auth.owner_credentials (user_id, email, password_hash) values ($1, $2, $3)', [userId, cleanEmail, pwHash]);
                await tx.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, userId]);
            });
            return { token, user: { id: userId, email: cleanEmail, anonymous: false } };
        });
    }

    async function signInOwner(email, password) {
        const cleanEmail = String(email || '').trim().toLowerCase();
        return enqueue(async () => {
            const rows = (
                await db.query('select user_id, email, password_hash from lan_auth.owner_credentials where lower(email) = $1', [cleanEmail])
            ).rows;
            const row = rows[0];
            if (!row || !verifyPassword(password, row.password_hash)) {
                throw Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials', status: 401 });
            }
            const token = crypto.randomBytes(32).toString('hex');
            await db.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, row.user_id]);
            return { token, user: { id: row.user_id, email: row.email, anonymous: false } };
        });
    }

    async function getSessionByToken(token) {
        if (!token) return null;
        return enqueue(async () => {
            const rows = (
                await db.query(
                    `select s.token, s.user_id, s.is_anonymous, u.email
                     from lan_auth.sessions s
                     join auth.users u on u.id = s.user_id
                     where s.token = $1`,
                    [token],
                )
            ).rows;
            const row = rows[0];
            if (!row) return null;
            return {
                token: row.token,
                user: { id: row.user_id, email: row.email, anonymous: Boolean(row.is_anonymous) },
            };
        });
    }

    async function signOutToken(token) {
        if (!token) return;
        return enqueue(async () => {
            await db.query('delete from lan_auth.sessions where token = $1', [token]);
        });
    }

    async function updateOwnerPassword(user, newPassword) {
        if (!user?.id || user.anonymous) {
            throw Object.assign(new Error('No autorizado'), { status: 401 });
        }
        if (String(newPassword || '').length < 8) {
            throw Object.assign(new Error('La contraseña debe tener al menos 8 caracteres.'), { code: 'weak_password', status: 400 });
        }
        return enqueue(async () => {
            const pwHash = hashPassword(newPassword);
            await db.query('update lan_auth.owner_credentials set password_hash = $1 where user_id = $2', [pwHash, user.id]);
            const rows = (await db.query('select email from auth.users where id = $1', [user.id])).rows;
            return { email: rows[0]?.email ?? null };
        });
    }

    async function readServerSummaryUnsafe() {
        const accounts = (await db.query('select id, name, owner_user_id from public.accounts order by created_at limit 1')).rows;
        const acc = accounts[0] || null;
        const devicesCount = acc
            ? (await db.query('select count(*)::int as n from public.account_devices where account_id = $1 and revoked_at is null', [acc.id])).rows[0]?.n || 0
            : 0;
        return {
            lanId,
            hasAccount: Boolean(acc),
            accountId: acc?.id ?? null,
            businessName: acc?.name ?? null,
            activeDevices: devicesCount,
        };
    }

    async function getServerSummary() {
        return enqueue(readServerSummaryUnsafe);
    }

    async function createPairingCode({ accountId = null, ttlMinutes = 10 } = {}) {
        return enqueue(async () => {
            const accRows = accountId
                ? (await db.query('select id, owner_user_id from public.accounts where id = $1', [accountId])).rows
                : (await db.query('select id, owner_user_id from public.accounts order by created_at limit 1')).rows;
            const acc = accRows[0];
            if (!acc) {
                throw Object.assign(new Error('Primero crea el negocio en la Caja Principal.'), { status: 400 });
            }
            const code = String(crypto.randomInt(100000, 1000000));
            const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
            await db.query(
                'insert into lan_auth.pairing_codes (code, account_id, owner_user_id, expires_at) values ($1, $2, $3, $4)',
                [code, acc.id, acc.owner_user_id, expiresAt],
            );
            return { code, accountId: acc.id, expiresAt };
        });
    }

    async function claimPairingCode(code) {
        const cleanCode = String(code || '').trim();
        if (!/^\d{6}$/.test(cleanCode)) {
            throw Object.assign(new Error('El código de vinculación debe tener 6 dígitos.'), { status: 400 });
        }
        return enqueue(async () => {
            const rows = (
                await db.query(
                    `select pc.code, pc.account_id, pc.owner_user_id, pc.expires_at, pc.used_at, u.email
                     from lan_auth.pairing_codes pc
                     join auth.users u on u.id = pc.owner_user_id
                     where pc.code = $1`,
                    [cleanCode],
                )
            ).rows;
            const row = rows[0];
            if (!row) {
                throw Object.assign(new Error('Código de vinculación no encontrado.'), { status: 404 });
            }
            if (row.used_at) {
                throw Object.assign(new Error('Ese código ya fue utilizado. Pide uno nuevo en la Caja Principal.'), { status: 400 });
            }
            if (Date.parse(row.expires_at) <= Date.now()) {
                throw Object.assign(new Error('El código venció. Genera uno nuevo en la Caja Principal.'), { status: 400 });
            }
            const token = crypto.randomBytes(32).toString('hex');
            await db.transaction(async (tx) => {
                await tx.query('update lan_auth.pairing_codes set used_at = now() where code = $1', [cleanCode]);
                await tx.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, row.owner_user_id]);
            });
            return {
                token,
                user: { id: row.owner_user_id, email: row.email, anonymous: false },
                accountId: row.account_id,
            };
        });
    }

    async function runSelectQuery(user, spec) {
        const table = String(spec?.table || '');
        if (!ALLOWED_TABLES.has(table)) {
            return { data: null, error: { message: `Tabla no permitida: ${table}`, code: '42501' } };
        }
        let selectCols;
        try {
            selectCols = parseSelectList(spec.select);
        } catch (err) {
            return { data: null, error: { message: err.message, code: '42601' } };
        }

        const where = [];
        const params = [];
        for (const f of Array.isArray(spec?.filters) ? spec.filters : []) {
            let col;
            try {
                col = sqlIdent(f.col);
            } catch (err) {
                return { data: null, error: { message: err.message, code: '42601' } };
            }
            if (f.op === 'is') {
                if (f.val !== null) return { data: null, error: { message: 'Solo se admite is(null)', code: '22023' } };
                where.push(`${col} is null`);
            } else if (f.op === 'eq') {
                params.push(f.val);
                where.push(`${col} = $${params.length}`);
            } else if (f.op === 'neq') {
                params.push(f.val);
                where.push(`${col} <> $${params.length}`);
            } else if (f.op === 'gt') {
                params.push(f.val);
                where.push(`${col} > $${params.length}`);
            } else if (f.op === 'gte') {
                params.push(f.val);
                where.push(`${col} >= $${params.length}`);
            } else if (f.op === 'lt') {
                params.push(f.val);
                where.push(`${col} < $${params.length}`);
            } else if (f.op === 'lte') {
                params.push(f.val);
                where.push(`${col} <= $${params.length}`);
            } else if (f.op === 'in') {
                const list = Array.isArray(f.val) ? f.val : [];
                params.push(list);
                where.push(`${col} = any($${params.length})`);
            } else {
                return { data: null, error: { message: `Filtro no soportado: ${f.op}`, code: '22023' } };
            }
        }

        const orderBy = [];
        for (const o of Array.isArray(spec?.orders) ? spec.orders : []) {
            try {
                orderBy.push(`${sqlIdent(o.col)}${o.ascending === false ? ' desc' : ''}`);
            } catch (err) {
                return { data: null, error: { message: err.message, code: '42601' } };
            }
        }

        let sql = `select ${selectCols} from public.${table}`;
        if (where.length) sql += ` where ${where.join(' and ')}`;
        if (orderBy.length) sql += ` order by ${orderBy.join(', ')}`;

        if (spec?.range && Number.isInteger(spec.range.from) && Number.isInteger(spec.range.to)) {
            const from = Math.max(0, spec.range.from);
            const count = Math.max(0, spec.range.to - from + 1);
            sql += ` limit ${count} offset ${from}`;
        } else if (Number.isInteger(spec?.limit) && spec.limit > 0) {
            sql += ` limit ${spec.limit}`;
        }

        return enqueue(async () => {
            try {
                const rows = await asUser(user, async (tx) => (await tx.query(sql, params, { parsers: TIMESTAMP_AS_TEXT })).rows);
                return { data: rows, error: null };
            } catch (error) {
                return { data: null, error: { message: error.message, code: error.code ?? null } };
            }
        });
    }

    async function collectChangedEvents(sinceTs) {
        const events = [];
        const syncRows = (
            await db.query(
                'select account_id, collection, changed_at from public.account_sync_state where changed_at >= $1',
                [sinceTs],
                { parsers: TIMESTAMP_AS_TEXT },
            )
        ).rows;
        for (const r of syncRows) {
            events.push({
                table: 'account_sync_state',
                account_id: r.account_id,
                new: r,
            });
        }

        const stockRows = (
            await db.query(
                'select account_id, sede_id, product_id, qty, updated_at from public.stock_levels where updated_at >= $1',
                [sinceTs],
                { parsers: TIMESTAMP_AS_TEXT },
            )
        ).rows;
        for (const r of stockRows) {
            events.push({
                table: 'stock_levels',
                account_id: r.account_id,
                sede_id: r.sede_id,
                new: { ...r, qty: Number(r.qty) },
            });
        }

        const balRows = (
            await db.query(
                'select account_id, customer_id, balance_usd, updated_at from public.customer_balances where updated_at >= $1',
                [sinceTs],
                { parsers: TIMESTAMP_AS_TEXT },
            )
        ).rows;
        for (const r of balRows) {
            events.push({
                table: 'customer_balances',
                account_id: r.account_id,
                new: { ...r, balance_usd: Number(r.balance_usd) },
            });
        }

        return events;
    }

    async function saveOfflinePinVerifier(memberId, pin, { noPin = false } = {}) {
        if (!memberId) return;
        const salt = crypto.randomBytes(16).toString('hex');
        const iterations = 1000;
        const hash = noPin ? '' : deriveOfflinePinDigestNode(String(pin), salt, memberId, iterations);
        await db.query(
            `insert into lan_auth.offline_pin_verifiers (member_id, salt, hash, no_pin, iterations, updated_at)
             values ($1, $2, $3, $4, $5, now())
             on conflict (member_id) do update
                set salt = excluded.salt,
                    hash = excluded.hash,
                    no_pin = excluded.no_pin,
                    iterations = excluded.iterations,
                    updated_at = now()`,
            [memberId, salt, hash, Boolean(noPin), iterations],
        );
    }

    async function syncOfflinePinFromRpc(safeFn, user, args, data) {
        try {
            if (safeFn === 'create_account' && user?.id && args?.p_owner_pin) {
                const { rows } = await db.query(
                    `select m.id from public.account_members m
                     join public.accounts a on a.id = m.account_id
                     where a.owner_user_id = $1 and m.role = 'dueno' limit 1`,
                    [user.id],
                );
                if (rows[0]?.id) await saveOfflinePinVerifier(rows[0].id, args.p_owner_pin);
            } else if ((safeFn === 'upsert_member' || safeFn === 'team_upsert_member') && data) {
                if (args?.p_sin_pin) {
                    await saveOfflinePinVerifier(data, null, { noPin: true });
                } else if (args?.p_pin) {
                    await saveOfflinePinVerifier(data, args.p_pin);
                }
            } else if (safeFn === 'member_change_own_pin' && args?.p_session && args?.p_new_pin) {
                const { rows } = await db.query('select member_id from public.member_sessions where token = $1 limit 1', [args.p_session]);
                if (rows[0]?.member_id) await saveOfflinePinVerifier(rows[0].member_id, args.p_new_pin);
            } else if (safeFn === 'owner_set_own_pin' && user?.id && args?.p_pin) {
                const { rows } = await db.query(
                    `select m.id from public.account_members m
                     join public.accounts a on a.id = m.account_id
                     where a.owner_user_id = $1 and m.role = 'dueno' limit 1`,
                    [user.id],
                );
                if (rows[0]?.id) await saveOfflinePinVerifier(rows[0].id, args.p_pin);
            } else if (safeFn === 'member_login_pin' && Array.isArray(data) && data[0]?.session_token) {
                const memberId = data[0].member_id;
                const noPin = args?.p_pin === null || args?.p_pin === undefined || args?.p_pin === '';
                await saveOfflinePinVerifier(memberId, args?.p_pin ?? null, { noPin });
            }
        } catch {
            /* best-effort: no bloquea la RPC principal */
        }
    }

    async function runRpc(user, fn, args = {}) {
        let safeFn;
        let entries;
        try {
            safeFn = sqlIdent(fn);
            entries = Object.entries(args || {})
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [sqlIdent(k), v]);
        } catch (err) {
            return { data: null, error: { message: err.message, code: '42601' }, events: [] };
        }

        const placeholders = entries.map(([name], i) => `${name} => $${i + 1}`).join(', ');
        const sql = `select * from public.${safeFn}(${placeholders})`;
        const values = entries.map(([, v]) => v);

        return enqueue(async () => {
            let sinceTs = null;
            if (MUTATING_RPCS.has(safeFn)) {
                const { rows } = await db.query('select clock_timestamp() as ts', [], { parsers: TIMESTAMP_AS_TEXT });
                sinceTs = rows[0]?.ts || null;
            }
            try {
                const rows = await asUser(user, async (tx) => (await tx.query(sql, values, { parsers: TIMESTAMP_AS_TEXT })).rows);
                let data;
                if (rows.length === 1 && Object.keys(rows[0]).length === 1 && safeFn in rows[0]) {
                    data = rows[0][safeFn];
                } else if (rows.length === 1 && Object.values(rows[0]).every((v) => v === null)) {
                    data = null;
                } else {
                    data = rows;
                }
                await syncOfflinePinFromRpc(safeFn, user, args, data);
                const events = sinceTs ? await collectChangedEvents(sinceTs) : [];
                return { data, error: null, events };
            } catch (error) {
                return { data: null, error: { message: error.message, code: error.code ?? null }, events: [] };
            }
        });
    }

    async function buildOfflinePassport(user, { leaseHours = 72 } = {}) {
        if (!user?.id) throw Object.assign(new Error('Sesión de equipo requerida'), { status: 401 });
        return enqueue(async () => {
            const devRows = (
                await db.query(
                    `select id, account_id, sede_id, role, caja_letter, label, revoked_at, auth_user_id
                     from public.account_devices
                     where auth_user_id = $1 and revoked_at is null
                     limit 1`,
                    [user.id],
                    { parsers: TIMESTAMP_AS_TEXT },
                )
            ).rows;
            const device = devRows[0];
            if (!device) throw Object.assign(new Error('Equipo no registrado o expulsado'), { status: 404 });

            const [accRes, licRes, sedesRes, memRes, verRes] = await Promise.all([
                db.query('select id, name from public.accounts where id = $1 limit 1', [device.account_id]),
                db.query('select status, max_cajas, max_sedes, expires_at from public.account_licenses where account_id = $1 limit 1', [device.account_id], { parsers: TIMESTAMP_AS_TEXT }),
                db.query('select id, name, archived_at from public.sedes where account_id = $1 and archived_at is null order by created_at', [device.account_id]),
                db.query(
                    `select id, display_name, role, active, created_at,
                            case when pin_hash = '' then null when role = 'cajero' then 4 else 6 end as pin_length
                     from public.account_members
                     where account_id = $1 and active = true
                     order by created_at`,
                    [device.account_id],
                    { parsers: TIMESTAMP_AS_TEXT },
                ),
                db.query(
                    `select v.member_id, v.salt, v.hash, v.no_pin, v.iterations
                     from lan_auth.offline_pin_verifiers v
                     join public.account_members m on m.id = v.member_id
                     where m.account_id = $1 and m.active = true`,
                    [device.account_id],
                ),
            ]);

            const verifiers = {};
            for (const v of verRes.rows) {
                verifiers[v.member_id] = v.no_pin
                    ? { noPin: true }
                    : { salt: v.salt, hash: v.hash, iterations: Number(v.iterations) || 1000 };
            }

            const issuedAt = new Date().toISOString();
            const expiresAt = new Date(Date.now() + leaseHours * 3_600_000).toISOString();
            return {
                device,
                account: accRes.rows[0] || null,
                license: licRes.rows[0] || null,
                sedes: sedesRes.rows || [],
                members: memRes.rows || [],
                verifiers,
                issuedAt,
                expiresAt,
            };
        });
    }

    async function applyOfflineLicenseToken(user, token, publicKeyJwk = DEFAULT_PUBLIC_KEY_JWK) {
        if (!user?.id || user.anonymous) {
            throw Object.assign(new Error('Solo el dueño puede activar la licencia.'), { status: 401 });
        }
        if (typeof token !== 'string' || !token.includes('.')) {
            throw Object.assign(new Error('Token de licencia inválido.'), { status: 400 });
        }
        const parts = token.trim().split('.');
        if (parts.length !== 2) {
            throw Object.assign(new Error('Formato de token de licencia inválido.'), { status: 400 });
        }

        let payload;
        try {
            const payloadStr = Buffer.from(parts[0], 'base64').toString('utf8');
            const signatureBuf = Buffer.from(parts[1], 'base64');
            const pubKey = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
            const valid = crypto.verify('RSA-SHA256', Buffer.from(payloadStr, 'utf8'), pubKey, signatureBuf);
            if (!valid) {
                throw new Error('Firma RSA inválida');
            }
            payload = JSON.parse(payloadStr);
        } catch (err) {
            throw Object.assign(new Error(err?.message || 'No se pudo validar la firma de la licencia.'), { status: 400 });
        }

        const expRaw = payload?.expiresAt ?? payload?.expires_at ?? null;
        if (expRaw && Number.isFinite(Date.parse(expRaw)) && Date.parse(expRaw) <= Date.now()) {
            throw Object.assign(new Error('Esta licencia ya está vencida.'), { status: 400 });
        }
        const maxCajas = Math.max(1, Math.min(100, Number(payload?.maxCajas ?? payload?.max_cajas ?? 5) || 5));
        const maxSedes = Math.max(1, Math.min(50, Number(payload?.maxSedes ?? payload?.max_sedes ?? 2) || 2));
        const status = ['trial', 'active', 'suspended'].includes(payload?.status) ? payload.status : 'active';

        return enqueue(async () => {
            const accRows = (await db.query('select id from public.accounts where owner_user_id = $1 limit 1', [user.id])).rows;
            const accountId = accRows[0]?.id;
            if (!accountId) throw Object.assign(new Error('Primero crea el negocio.'), { status: 400 });
            const { rows } = await db.query(
                `update public.account_licenses
                    set status = $2, max_cajas = $3, max_sedes = $4, expires_at = $5, updated_at = now()
                  where account_id = $1
                 returning account_id, product, status, max_cajas, max_sedes, expires_at`,
                [accountId, status, maxCajas, maxSedes, expRaw],
                { parsers: TIMESTAMP_AS_TEXT },
            );
            return rows[0] || null;
        });
    }

    async function setAccountLicense(accountId, { status = 'active', maxCajas = 5, maxSedes = 2, expiresAt = null } = {}) {
        return enqueue(async () => {
            const { rows } = await db.query(
                `update public.account_licenses
                    set status = $2, max_cajas = $3, max_sedes = $4, expires_at = $5, updated_at = now()
                  where account_id = $1
                 returning account_id, product, status, max_cajas, max_sedes, expires_at`,
                [accountId, status, maxCajas, maxSedes, expiresAt],
                { parsers: TIMESTAMP_AS_TEXT },
            );
            return rows[0] || null;
        });
    }

    async function dumpArchive(compression = 'gzip') {
        return enqueue(async () => db.dumpDataDir(compression));
    }

    async function exportJsonSnapshot() {
        return enqueue(async () => {
            const tables = [
                'accounts',
                'account_licenses',
                'sedes',
                'account_members',
                'account_devices',
                'account_records',
                'account_record_history',
                'account_sync_state',
                'stock_movements',
                'stock_levels',
                'device_counters',
                'sales',
                'stock_discrepancies',
                'customer_movements',
                'customer_balances',
                'nube_settings',
            ];
            const data = {};
            for (const table of tables) {
                try {
                    data[table] = (await db.query(`select * from public.${table}`, [], { parsers: TIMESTAMP_AS_TEXT })).rows;
                } catch {
                    data[table] = [];
                }
            }
            const authUsers = (await db.query('select id, email, is_anonymous from auth.users', [], { parsers: TIMESTAMP_AS_TEXT })).rows;
            const ownerCredentials = (await db.query('select user_id, email, password_hash, created_at from lan_auth.owner_credentials', [], { parsers: TIMESTAMP_AS_TEXT })).rows;
            const offlineVerifiers = (await db.query('select member_id, salt, hash, no_pin, iterations, updated_at from lan_auth.offline_pin_verifiers', [], { parsers: TIMESTAMP_AS_TEXT })).rows;
            return {
                format: 'preciosaldia-lan-snapshot-v1',
                lanId,
                exportedAt: new Date().toISOString(),
                tables: data,
                authUsers,
                ownerCredentials,
                offlineVerifiers,
            };
        });
    }

    async function restoreJsonSnapshot(snapshot) {
        if (snapshot?.format !== 'preciosaldia-lan-snapshot-v1' || !snapshot?.tables) {
            throw Object.assign(new Error('El archivo no es un respaldo válido de Precios al Día LAN.'), { status: 400 });
        }
        const t = snapshot.tables;
        return enqueue(async () => {
            await db.transaction(async (tx) => {
                await tx.exec('truncate public.accounts, public.stock_movements, public.customer_movements, public.nube_settings restart identity cascade;');
                await tx.exec('delete from lan_auth.pairing_codes; delete from lan_auth.offline_pin_verifiers; delete from lan_auth.sessions;');

                const neededUsers = new Map();
                for (const u of snapshot.authUsers || []) {
                    if (u?.id) neededUsers.set(u.id, { id: u.id, email: u.email ?? null, is_anonymous: Boolean(u.is_anonymous) });
                }
                for (const a of t.accounts || []) {
                    if (a?.owner_user_id && !neededUsers.has(a.owner_user_id)) {
                        neededUsers.set(a.owner_user_id, { id: a.owner_user_id, email: null, is_anonymous: false });
                    }
                }
                for (const d of t.account_devices || []) {
                    if (d?.auth_user_id && !neededUsers.has(d.auth_user_id)) {
                        neededUsers.set(d.auth_user_id, { id: d.auth_user_id, email: null, is_anonymous: true });
                    }
                    if (d?.registered_by && !neededUsers.has(d.registered_by)) {
                        neededUsers.set(d.registered_by, { id: d.registered_by, email: null, is_anonymous: false });
                    }
                }
                for (const u of neededUsers.values()) {
                    await tx.query(
                        `insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)
                         on conflict (id) do update set email = coalesce(excluded.email, auth.users.email), is_anonymous = excluded.is_anonymous`,
                        [u.id, u.email, u.is_anonymous],
                    );
                }

                for (const c of snapshot.ownerCredentials || []) {
                    await tx.query(
                        `insert into lan_auth.owner_credentials (user_id, email, password_hash, created_at)
                         values ($1, $2, $3, $4)
                         on conflict (user_id) do update set email = excluded.email, password_hash = excluded.password_hash`,
                        [c.user_id, c.email, c.password_hash, c.created_at || new Date().toISOString()],
                    );
                }

                // Nota: `stock_levels` se reconstruye automáticamente con el trigger AFTER INSERT de `stock_movements`.
                const insertOrder = [
                    'accounts',
                    'account_licenses',
                    'sedes',
                    'account_members',
                    'account_devices',
                    'device_counters',
                    'account_records',
                    'account_record_history',
                    'sales',
                    'stock_movements',
                    'stock_discrepancies',
                    'customer_movements',
                    'customer_balances',
                    'nube_settings',
                ];
                for (const table of insertOrder) {
                    const rows = t[table];
                    if (!Array.isArray(rows) || !rows.length) continue;
                    await tx.query(
                        `insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
                        [JSON.stringify(rows)],
                    );
                }

                if (Array.isArray(t.customer_movements) && t.customer_movements.length) {
                    await tx.exec(
                        `select setval(pg_get_serial_sequence('public.customer_movements', 'seq'),
                                (select max(seq) from public.customer_movements), true)`,
                    );
                }

                for (const v of snapshot.offlineVerifiers || []) {
                    await tx.query(
                        `insert into lan_auth.offline_pin_verifiers (member_id, salt, hash, no_pin, iterations, updated_at)
                         values ($1, $2, $3, $4, $5, $6)
                         on conflict (member_id) do nothing`,
                        [v.member_id, v.salt, v.hash, Boolean(v.no_pin), v.iterations || 1000, v.updated_at || new Date().toISOString()],
                    );
                }

                const invariants = (await tx.query('select * from nube_private.verify_invariants()')).rows;
                if (invariants.length) {
                    throw new Error(`El respaldo tiene descuadres internos: ${invariants[0].issue || 'invariante fallida'}`);
                }
            });
            return await readServerSummaryUnsafe();
        });
    }

    async function getMeta(key) {
        return enqueue(async () => {
            const { rows } = await db.query('select value from lan_auth.meta where key = $1 limit 1', [key]);
            return rows[0]?.value ?? null;
        });
    }

    async function setMeta(key, value) {
        return enqueue(async () => {
            await db.query(
                `insert into lan_auth.meta (key, value, updated_at)
                 values ($1, $2::jsonb, now())
                 on conflict (key) do update set value = excluded.value, updated_at = now()`,
                [key, JSON.stringify(value)],
            );
            return value;
        });
    }

    async function buildSupervisorSnapshot() {
        return enqueue(async () => {
            const accRows = (
                await db.query('select id, name, owner_user_id from public.accounts order by created_at limit 1')
            ).rows;
            const acc = accRows[0];
            if (!acc) return null;
            const ownerUser = { id: acc.owner_user_id, anonymous: false };

            const data = await asUser(ownerUser, async (tx) => {
                const [daySummary, sales, sedes, products, customers, stockLevels, balances, discrepancies, settings] = await Promise.all([
                    tx.query('select * from public.cash_day_summary()', [], { parsers: TIMESTAMP_AS_TEXT }),
                    tx.query(
                        'select id, number, total_usd, status, offline, server_at, device_id, sede_id from public.sales order by server_at desc limit 50',
                        [],
                        { parsers: TIMESTAMP_AS_TEXT },
                    ),
                    tx.query('select id, name from public.sedes where archived_at is null order by created_at'),
                    tx.query(
                        "select id, data, version, updated_at from public.account_records where collection = 'products' and deleted_at is null order by updated_at desc",
                        [],
                        { parsers: TIMESTAMP_AS_TEXT },
                    ),
                    tx.query(
                        "select id, data, version from public.account_records where collection = 'customers' and deleted_at is null",
                        [],
                        { parsers: TIMESTAMP_AS_TEXT },
                    ),
                    tx.query('select product_id, sede_id, qty from public.stock_levels'),
                    tx.query('select customer_id, balance_usd from public.customer_balances'),
                    tx.query(
                        'select id, product_id, expected_qty, sold_qty, created_at from public.stock_discrepancies where resolved_at is null order by created_at',
                        [],
                        { parsers: TIMESTAMP_AS_TEXT },
                    ),
                    tx.query(
                        "select id, data, version, updated_at from public.account_records where collection = 'settings' and id = 'pdn_rate_v1' and deleted_at is null limit 1",
                        [],
                        { parsers: TIMESTAMP_AS_TEXT },
                    ),
                ]);

                return {
                    accountId: acc.id,
                    accountName: acc.name,
                    generatedAt: new Date().toISOString(),
                    daySummary: daySummary.rows,
                    sales: sales.rows,
                    sedes: sedes.rows,
                    products: products.rows,
                    customers: customers.rows,
                    stockLevels: stockLevels.rows.map((r) => ({ ...r, qty: Number(r.qty) || 0 })),
                    customerBalances: balances.rows.map((b) => ({ ...b, balance_usd: Number(b.balance_usd) || 0 })),
                    discrepancies: discrepancies.rows,
                    rateRecord: settings.rows[0] || null,
                };
            });
            return data;
        });
    }

    async function executeSupervisorCommand(action, payload = {}) {
        const summary = await getServerSummary();
        if (!summary?.accountId) {
            throw new Error('La Caja Principal aún no tiene un negocio creado.');
        }
        const ownerRes = await enqueue(async () => (
            await db.query('select owner_user_id from public.accounts where id = $1 limit 1', [summary.accountId])
        ).rows);
        const ownerId = ownerRes[0]?.owner_user_id;
        if (!ownerId) throw new Error('Dueño de cuenta no encontrado.');
        const ownerUser = { id: ownerId, anonymous: false };

        if (action === 'refresh_snapshot') {
            return { data: { refreshed: true }, events: [] };
        }

        if (action === 'save_product') {
            const res = await runRpc(ownerUser, 'push_records_v2', {
                p_session: null,
                p_collection: 'products',
                p_records: [{
                    id: payload.id,
                    data: payload.data,
                    ...(payload.base_version != null ? { base_version: payload.base_version } : {}),
                }],
            });
            if (res.error) throw new Error(res.error.message);
            let allEvents = [...(res.events || [])];
            if (Number(payload.initialStock) > 0 && payload.initialMovementId) {
                const stRes = await runRpc(ownerUser, 'process_stock_movements', {
                    p_session: null,
                    p_reason: 'INICIAL',
                    p_movements: [{
                        id: payload.initialMovementId,
                        product_id: payload.id,
                        qty: Number(payload.initialStock),
                        note: 'Stock inicial (Supervisor remoto)',
                    }],
                    p_reference: 'supervisor-remoto',
                    ...(payload.sedeId ? { p_sede_id: payload.sedeId } : {}),
                });
                if (stRes.error) throw new Error(stRes.error.message);
                allEvents = allEvents.concat(stRes.events || []);
            }
            return { data: res.data, events: allEvents };
        }

        if (action === 'delete_product') {
            const res = await runRpc(ownerUser, 'push_records_v2', {
                p_session: null,
                p_collection: 'products',
                p_records: [{
                    id: payload.id,
                    data: payload.data || { id: payload.id },
                    deleted: true,
                    ...(payload.base_version != null ? { base_version: payload.base_version } : {}),
                }],
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        if (action === 'adjust_stock') {
            const res = await runRpc(ownerUser, 'process_stock_movements', {
                p_session: null,
                p_reason: payload.reason || 'AJUSTE',
                p_movements: payload.movements || [],
                p_reference: 'supervisor-remoto',
                ...(payload.sedeId ? { p_sede_id: payload.sedeId } : {}),
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        if (action === 'update_rate') {
            const res = await runRpc(ownerUser, 'push_records_v2', {
                p_session: null,
                p_collection: 'settings',
                p_records: [{
                    id: 'pdn_rate_v1',
                    data: payload.data || {},
                    ...(payload.base_version != null ? { base_version: payload.base_version } : {}),
                }],
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        if (action === 'void_sale') {
            const res = await runRpc(ownerUser, 'process_void', {
                p_session: null,
                p_sale_id: payload.saleId,
                p_reason: payload.reason || 'Anulada desde Supervisor remoto',
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        if (action === 'customer_payment') {
            const res = await runRpc(ownerUser, 'push_customer_movements', {
                p_session: null,
                p_movements: payload.movements || [],
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        if (action === 'resolve_discrepancy') {
            const res = await runRpc(ownerUser, 'resolve_discrepancy', {
                p_session: null,
                p_id: payload.discrepancyId,
                p_note: payload.note || 'Resuelto desde Supervisor remoto',
            });
            if (res.error) throw new Error(res.error.message);
            return { data: res.data, events: res.events || [] };
        }

        throw new Error(`Acción desconocida: ${action}`);
    }

    async function bootstrapLocalOwner() {
        return enqueue(async () => {
            const existing = (await db.query('select id, owner_user_id from public.accounts order by created_at limit 1')).rows;
            if (existing.length) {
                throw Object.assign(new Error('Ya existe un negocio configurado. Entra con tu PIN de dueño.'), { status: 403 });
            }
            const userId = crypto.randomUUID();
            const token = crypto.randomBytes(32).toString('hex');
            const email = `dueno-${userId.slice(0, 8)}@local.lan`;
            const pwHash = hashPassword(crypto.randomBytes(24).toString('hex'));
            await db.transaction(async (tx) => {
                await tx.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, false)', [userId, email]);
                await tx.query('insert into lan_auth.owner_credentials (user_id, email, password_hash) values ($1, $2, $3)', [userId, email, pwHash]);
                await tx.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, userId]);
            });
            return { token, user: { id: userId, email, anonymous: false } };
        });
    }

    async function signInLocalOwnerByPin(pin) {
        const cleanPin = String(pin || '').trim();
        if (!/^[0-9]{6,32}$/.test(cleanPin)) {
            throw Object.assign(new Error('Escribe tu PIN de dueño (mínimo 6 números).'), { status: 400 });
        }
        return enqueue(async () => {
            const rows = (
                await db.query(
                    `select m.id as member_id, m.pin_hash, m.failed_attempts, m.lockouts, m.locked_until,
                            a.owner_user_id, u.email
                     from public.account_members m
                     join public.accounts a on a.id = m.account_id
                     join auth.users u on u.id = a.owner_user_id
                     where m.role = 'dueno' and m.active = true
                     order by m.created_at
                     limit 1`,
                    [],
                    { parsers: TIMESTAMP_AS_TEXT },
                )
            ).rows;
            const row = rows[0];
            if (!row) {
                throw Object.assign(new Error('Primero crea el negocio en esta Caja Principal.'), { status: 404 });
            }
            if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
                const secs = Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000));
                throw Object.assign(new Error(`Demasiados intentos. Espera ${secs} segundos.`), { status: 429 });
            }
            const okRow = (
                await db.query("select ($1 = extensions.crypt($2, $1)) as valid", [row.pin_hash, cleanPin])
            ).rows[0];
            if (!okRow?.valid) {
                const fails = Number(row.failed_attempts || 0) + 1;
                if (fails >= 5) {
                    const lockSecs = Math.min(30 * (2 ** Number(row.lockouts || 0)), 15 * 60);
                    await db.query(
                        `update public.account_members
                            set failed_attempts = 0,
                                lockouts = lockouts + 1,
                                locked_until = now() + ($2 || ' seconds')::interval
                          where id = $1`,
                        [row.member_id, String(lockSecs)],
                    );
                } else {
                    await db.query('update public.account_members set failed_attempts = failed_attempts + 1 where id = $1', [row.member_id]);
                }
                throw Object.assign(new Error('PIN incorrecto.'), { status: 401 });
            }

            const token = crypto.randomBytes(32).toString('hex');
            await db.transaction(async (tx) => {
                await tx.query('update public.account_members set failed_attempts = 0, lockouts = 0, locked_until = null where id = $1', [row.member_id]);
                await tx.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, row.owner_user_id]);
            });
            return { token, user: { id: row.owner_user_id, email: row.email, anonymous: false } };
        });
    }

    async function resetLocalOwnerPin(newPin) {
        const cleanPin = String(newPin || '').trim();
        if (!/^[0-9]{6,32}$/.test(cleanPin) || cleanPin === '000000') {
            throw Object.assign(new Error('El PIN nuevo debe tener 6 o más números y no puede ser 000000.'), { status: 400 });
        }
        return enqueue(async () => {
            const rows = (
                await db.query(
                    `select m.id as member_id, a.owner_user_id, u.email
                     from public.account_members m
                     join public.accounts a on a.id = m.account_id
                     join auth.users u on u.id = a.owner_user_id
                     where m.role = 'dueno'
                     order by m.created_at
                     limit 1`,
                )
            ).rows;
            const row = rows[0];
            if (!row) {
                throw Object.assign(new Error('Todavía no existe un negocio creado.'), { status: 404 });
            }
            const token = crypto.randomBytes(32).toString('hex');
            await db.transaction(async (tx) => {
                await tx.query(
                    `update public.account_members
                        set pin_hash = extensions.crypt($2, extensions.gen_salt('bf')),
                            pin_length = 6,
                            active = true,
                            failed_attempts = 0,
                            lockouts = 0,
                            locked_until = null
                      where id = $1`,
                    [row.member_id, cleanPin],
                );
                await tx.query('update public.member_sessions set ended_at = now() where member_id = $1 and ended_at is null', [row.member_id]);
                await tx.query('insert into lan_auth.sessions (token, user_id, is_anonymous) values ($1, $2, false)', [token, row.owner_user_id]);
            });
            await saveOfflinePinVerifier(row.member_id, cleanPin);
            return { token, user: { id: row.owner_user_id, email: row.email, anonymous: false } };
        });
    }

    async function close() {
        await enqueue(async () => {
            await db.close();
        });
    }

    return {
        db,
        lanId,
        createDeviceSession,
        signUpOwner,
        signInOwner,
        bootstrapLocalOwner,
        signInLocalOwnerByPin,
        resetLocalOwnerPin,
        getSessionByToken,
        signOutToken,
        updateOwnerPassword,
        getServerSummary,
        createPairingCode,
        claimPairingCode,
        runSelectQuery,
        runRpc,
        buildOfflinePassport,
        applyOfflineLicenseToken,
        setAccountLicense,
        dumpArchive,
        exportJsonSnapshot,
        restoreJsonSnapshot,
        getMeta,
        setMeta,
        buildSupervisorSnapshot,
        executeSupervisorCommand,
        close,
    };
}
