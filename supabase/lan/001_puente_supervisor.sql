-- Precios al Día LAN · Puente de Internet para Modo Supervisor (Android, iOS y Windows).
--
-- Este esquema corre en un proyecto Supabase ligero para permitir que el dueño vea su
-- negocio y envíe cambios desde cualquier lugar con internet SIN conectar las cajas PC
-- del local a la nube ni exponer puertos del router.
--
-- Seguridad:
--   · Todas las tablas tienen RLS habilitada sin acceso directo para `anon` / `authenticated`.
--   · Toda lectura y escritura pasa por funciones `security definer` con verificación bcrypt
--     de `master_secret` (solo lo conoce la Caja Principal Windows) o de `supervisor_code + PIN`
--     del dueño (bloqueo automático tras 5 intentos fallidos).
-- Idempotente. Vuelta atrás al final.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.lan_cloud_accounts (
    account_id          uuid primary key,
    account_name        text not null,
    supervisor_code     text not null unique,
    master_secret_hash  text not null,
    supervisor_pin_hash text not null,
    failed_attempts     integer not null default 0,
    locked_until        timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.lan_cloud_snapshots (
    account_id          uuid primary key references public.lan_cloud_accounts(account_id) on delete cascade,
    snapshot            jsonb not null default '{}'::jsonb,
    pushed_at           timestamptz not null default now()
);

create table if not exists public.lan_supervisor_sessions (
    token               uuid primary key,
    account_id          uuid not null references public.lan_cloud_accounts(account_id) on delete cascade,
    expires_at          timestamptz not null,
    ended_at            timestamptz,
    created_at          timestamptz not null default now()
);

create table if not exists public.lan_supervisor_commands (
    id                  uuid primary key,
    account_id          uuid not null references public.lan_cloud_accounts(account_id) on delete cascade,
    action              text not null,
    payload             jsonb not null default '{}'::jsonb,
    status              text not null default 'pending' check (status in ('pending', 'processing', 'applied', 'failed')),
    error               text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    applied_at          timestamptz
);

create index if not exists lan_supervisor_commands_pending_idx
    on public.lan_supervisor_commands (account_id, status, created_at);

alter table public.lan_cloud_accounts      enable row level security;
alter table public.lan_cloud_snapshots     enable row level security;
alter table public.lan_supervisor_sessions enable row level security;
alter table public.lan_supervisor_commands enable row level security;

revoke all on public.lan_cloud_accounts, public.lan_cloud_snapshots,
    public.lan_supervisor_sessions, public.lan_supervisor_commands from public, anon, authenticated;

-- Helper interno: valida secreto de la Caja Principal (192-bit CSPRNG, hash SHA-256 rápido).
create or replace function public.lan_hash_master_secret(p_secret text)
returns text
language sql immutable security definer set search_path = public, extensions as $$
    select encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex');
$$;

create or replace function public.lan_verify_master(p_account_id uuid, p_master_secret text)
returns public.lan_cloud_accounts
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_acc public.lan_cloud_accounts;
begin
    if p_account_id is null or coalesce(p_master_secret, '') = '' then
        raise exception 'Credenciales del puente incompletas' using errcode = '42501';
    end if;
    select * into v_acc from public.lan_cloud_accounts where account_id = p_account_id;
    if not found then
        raise exception 'Puente no registrado para esta cuenta' using errcode = '42501';
    end if;
    if v_acc.master_secret_hash <> public.lan_hash_master_secret(p_master_secret) then
        raise exception 'Secreto de la Caja Principal inválido' using errcode = '42501';
    end if;
    return v_acc;
end;
$$;

-- Helper interno: valida sesión activa de Supervisor.
create or replace function public.lan_verify_supervisor_session(p_session uuid)
returns public.lan_cloud_accounts
language plpgsql security definer set search_path = public as $$
declare
    v_sess public.lan_supervisor_sessions;
    v_acc public.lan_cloud_accounts;
begin
    if p_session is null then
        raise exception 'Sesión de supervisor vencida' using errcode = '42501';
    end if;
    select * into v_sess from public.lan_supervisor_sessions
     where token = p_session and ended_at is null and expires_at > now();
    if not found then
        raise exception 'Sesión de supervisor vencida' using errcode = '42501';
    end if;
    select * into v_acc from public.lan_cloud_accounts where account_id = v_sess.account_id;
    return v_acc;
end;
$$;

-- 1. Caja Principal registra o actualiza credenciales del puente.
create or replace function public.lan_bridge_register(
    p_account_id uuid,
    p_account_name text,
    p_master_secret text,
    p_supervisor_code text,
    p_pin text default null
)
returns table (account_id uuid, supervisor_code text, updated_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    v_existing public.lan_cloud_accounts;
    v_code text := upper(btrim(coalesce(p_supervisor_code, '')));
begin
    if p_account_id is null or length(coalesce(p_master_secret, '')) < 16 then
        raise exception 'Cuenta o secreto del puente inválido' using errcode = '22023';
    end if;
    if v_code !~ '^[A-Z0-9-]{4,24}$' then
        raise exception 'El código del negocio debe tener entre 4 y 24 caracteres alfanuméricos' using errcode = '22023';
    end if;

    select * into v_existing from public.lan_cloud_accounts a where a.account_id = p_account_id for update;
    if found then
        if v_existing.master_secret_hash <> public.lan_hash_master_secret(p_master_secret) then
            raise exception 'Secreto de la Caja Principal inválido' using errcode = '42501';
        end if;
        update public.lan_cloud_accounts a
           set account_name = coalesce(nullif(btrim(p_account_name), ''), a.account_name),
               supervisor_code = v_code,
               supervisor_pin_hash = case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) else a.supervisor_pin_hash end,
               updated_at = now()
         where a.account_id = p_account_id
        returning a.account_id, a.supervisor_code, a.updated_at into account_id, supervisor_code, updated_at;
        return next;
        return;
    end if;

    if coalesce(p_pin, '') !~ '^[0-9]{6,32}$' then
        raise exception 'El PIN de supervisor inicial debe tener entre 6 y 32 dígitos' using errcode = '22023';
    end if;

    insert into public.lan_cloud_accounts (account_id, account_name, supervisor_code, master_secret_hash, supervisor_pin_hash)
    values (
        p_account_id,
        coalesce(nullif(btrim(p_account_name), ''), 'Mi Negocio'),
        v_code,
        public.lan_hash_master_secret(p_master_secret),
        crypt(p_pin, gen_salt('bf'))
    )
    returning public.lan_cloud_accounts.account_id, public.lan_cloud_accounts.supervisor_code, public.lan_cloud_accounts.updated_at
    into account_id, supervisor_code, updated_at;

    return next;
end;
$$;

-- 2. Caja Principal sube el resumen actualizado del negocio.
create or replace function public.lan_bridge_push_snapshot(
    p_account_id uuid,
    p_master_secret text,
    p_snapshot jsonb
)
returns timestamptz
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_ts timestamptz;
begin
    perform public.lan_verify_master(p_account_id, p_master_secret);
    insert into public.lan_cloud_snapshots (account_id, snapshot, pushed_at)
    values (p_account_id, coalesce(p_snapshot, '{}'::jsonb), now())
    on conflict (account_id) do update
        set snapshot = excluded.snapshot,
            pushed_at = now()
    returning pushed_at into v_ts;
    return v_ts;
end;
$$;

-- 3. Caja Principal toma comandos pendientes de forma atómica.
create or replace function public.lan_bridge_claim_commands(
    p_account_id uuid,
    p_master_secret text,
    p_limit integer default 20
)
returns table (id uuid, action text, payload jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
    perform public.lan_verify_master(p_account_id, p_master_secret);
    return query
    with picked as (
        select c.id
          from public.lan_supervisor_commands c
         where c.account_id = p_account_id and c.status = 'pending'
         order by c.created_at
         limit v_limit
         for update skip locked
    )
    update public.lan_supervisor_commands c
       set status = 'processing',
           updated_at = now()
      from picked
     where c.id = picked.id
    returning c.id, c.action, c.payload, c.created_at;
end;
$$;

-- 4. Caja Principal confirma el resultado de un comando.
create or replace function public.lan_bridge_ack_command(
    p_account_id uuid,
    p_master_secret text,
    p_command_id uuid,
    p_status text,
    p_error text default null
)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
    perform public.lan_verify_master(p_account_id, p_master_secret);
    if p_status not in ('applied', 'failed') then
        raise exception 'Estado inválido' using errcode = '22023';
    end if;
    update public.lan_supervisor_commands
       set status = p_status,
           error = case when p_status = 'failed' then left(p_error, 400) else null end,
           updated_at = now(),
           applied_at = now()
     where id = p_command_id and account_id = p_account_id;
end;
$$;

-- 5. Dueño entra por internet desde Android, iOS o Windows con Código del negocio + PIN.
create or replace function public.lan_supervisor_login(p_supervisor_code text, p_pin text)
returns table (session_token uuid, account_id uuid, account_name text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    v_acc public.lan_cloud_accounts;
    v_code text := upper(btrim(coalesce(p_supervisor_code, '')));
    v_token uuid := gen_random_uuid();
    v_exp timestamptz := now() + interval '12 hours';
begin
    select * into v_acc from public.lan_cloud_accounts a where a.supervisor_code = v_code for update;
    if not found then
        raise exception 'Código de negocio o PIN incorrecto' using errcode = '28P01';
    end if;

    if v_acc.locked_until is not null and v_acc.locked_until > now() then
        raise exception 'Demasiados intentos. Espera un minuto antes de volver a intentar.' using errcode = '42501';
    end if;

    if coalesce(p_pin, '') = '' or v_acc.supervisor_pin_hash <> crypt(p_pin, v_acc.supervisor_pin_hash) then
        update public.lan_cloud_accounts a
           set failed_attempts = a.failed_attempts + 1,
               locked_until = case when a.failed_attempts + 1 >= 5 then now() + interval '60 seconds' else null end,
               updated_at = now()
         where a.account_id = v_acc.account_id;
        return;
    end if;

    update public.lan_cloud_accounts a
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where a.account_id = v_acc.account_id;

    insert into public.lan_supervisor_sessions (token, account_id, expires_at)
    values (v_token, v_acc.account_id, v_exp);

    return query select v_token, v_acc.account_id, v_acc.account_name, v_exp;
end;
$$;

-- 6. Dueño lee el resumen actualizado y sus últimos comandos.
create or replace function public.lan_supervisor_get_snapshot(p_session uuid)
returns table (account_id uuid, account_name text, pushed_at timestamptz, snapshot jsonb, recent_commands jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_acc public.lan_cloud_accounts := public.lan_verify_supervisor_session(p_session);
    v_snap public.lan_cloud_snapshots;
    v_cmds jsonb;
begin
    select * into v_snap from public.lan_cloud_snapshots s where s.account_id = v_acc.account_id;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'action', c.action, 'status', c.status, 'error', c.error,
        'created_at', c.created_at, 'applied_at', c.applied_at
    ) order by c.created_at desc), '[]'::jsonb)
      into v_cmds
      from (
          select * from public.lan_supervisor_commands cm
           where cm.account_id = v_acc.account_id
           order by cm.created_at desc
           limit 20
      ) c;

    return query select v_acc.account_id, v_acc.account_name, v_snap.pushed_at, coalesce(v_snap.snapshot, '{}'::jsonb), v_cmds;
end;
$$;

-- 7. Dueño envía un cambio remoto para que la Caja Principal lo aplique y avise a todas las cajas.
create or replace function public.lan_supervisor_enqueue(
    p_session uuid,
    p_id uuid,
    p_action text,
    p_payload jsonb default '{}'::jsonb
)
returns table (id uuid, status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_acc public.lan_cloud_accounts := public.lan_verify_supervisor_session(p_session);
    v_existing public.lan_supervisor_commands;
begin
    if p_id is null then raise exception 'El comando necesita un id' using errcode = '22023'; end if;
    if p_action not in ('save_product', 'delete_product', 'adjust_stock', 'update_rate', 'void_sale', 'customer_payment', 'resolve_discrepancy', 'refresh_snapshot') then
        raise exception 'Acción de supervisor no permitida' using errcode = '22023';
    end if;

    select * into v_existing from public.lan_supervisor_commands c where c.id = p_id;
    if found then
        if v_existing.account_id <> v_acc.account_id then
            raise exception 'Comando de otra cuenta' using errcode = '42501';
        end if;
        return query select v_existing.id, v_existing.status;
        return;
    end if;

    insert into public.lan_supervisor_commands (id, account_id, action, payload, status)
    values (p_id, v_acc.account_id, p_action, coalesce(p_payload, '{}'::jsonb), 'pending');

    return query select p_id, 'pending'::text;
end;
$$;

create or replace function public.lan_supervisor_logout(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    update public.lan_supervisor_sessions set ended_at = now() where token = p_session;
end;
$$;

revoke all on function
    public.lan_hash_master_secret(text),
    public.lan_verify_master(uuid, text),
    public.lan_verify_supervisor_session(uuid)
    from public, anon, authenticated;

revoke all on function
    public.lan_bridge_register(uuid, text, text, text, text),
    public.lan_bridge_push_snapshot(uuid, text, jsonb),
    public.lan_bridge_claim_commands(uuid, text, integer),
    public.lan_bridge_ack_command(uuid, text, uuid, text, text),
    public.lan_supervisor_login(text, text),
    public.lan_supervisor_get_snapshot(uuid),
    public.lan_supervisor_enqueue(uuid, uuid, text, jsonb),
    public.lan_supervisor_logout(uuid)
    from public;

grant execute on function
    public.lan_bridge_register(uuid, text, text, text, text),
    public.lan_bridge_push_snapshot(uuid, text, jsonb),
    public.lan_bridge_claim_commands(uuid, text, integer),
    public.lan_bridge_ack_command(uuid, text, uuid, text, text),
    public.lan_supervisor_login(text, text),
    public.lan_supervisor_get_snapshot(uuid),
    public.lan_supervisor_enqueue(uuid, uuid, text, jsonb),
    public.lan_supervisor_logout(uuid)
    to anon, authenticated;

-- ROLLBACK
-- drop function if exists
--   public.lan_supervisor_logout(uuid), public.lan_supervisor_enqueue(uuid, uuid, text, jsonb),
--   public.lan_supervisor_get_snapshot(uuid), public.lan_supervisor_login(text, text),
--   public.lan_bridge_ack_command(uuid, text, uuid, text, text), public.lan_bridge_claim_commands(uuid, text, integer),
--   public.lan_bridge_push_snapshot(uuid, text, jsonb), public.lan_bridge_register(uuid, text, text, text, text),
--   public.lan_verify_supervisor_session(uuid), public.lan_verify_master(uuid, text);
-- drop table if exists public.lan_supervisor_commands, public.lan_supervisor_sessions,
--   public.lan_cloud_snapshots, public.lan_cloud_accounts;
