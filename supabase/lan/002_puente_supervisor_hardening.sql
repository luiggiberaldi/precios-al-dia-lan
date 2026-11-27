-- T17: Hardening del Puente de Internet para Modo Supervisor (ALT-10 / MED-15 / MED-16).
--   1. Reclamación de comandos huérfanos en estado 'processing' con >60s de antigüedad.
--   2. Backoff exponencial y eliminación de oráculo de código en `lan_supervisor_login`.
--   3. Revocación inmediata de sesiones de supervisor activas al cambiar el PIN.
-- Idempotente.

alter table public.lan_cloud_accounts
    add column if not exists lockouts integer not null default 0;

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
        if coalesce(p_pin, '') <> '' and p_pin !~ '^[0-9]{6,32}$' then
            raise exception 'El PIN de supervisor debe tener entre 6 y 32 dígitos' using errcode = '22023';
        end if;
        update public.lan_cloud_accounts a
           set account_name = coalesce(nullif(btrim(p_account_name), ''), a.account_name),
               supervisor_code = v_code,
               supervisor_pin_hash = case when coalesce(p_pin, '') <> '' then crypt(p_pin, gen_salt('bf')) else a.supervisor_pin_hash end,
               failed_attempts = case when coalesce(p_pin, '') <> '' then 0 else a.failed_attempts end,
               lockouts = case when coalesce(p_pin, '') <> '' then 0 else a.lockouts end,
               locked_until = case when coalesce(p_pin, '') <> '' then null else a.locked_until end,
               updated_at = now()
         where a.account_id = p_account_id
        returning a.account_id, a.supervisor_code, a.updated_at into account_id, supervisor_code, updated_at;

        -- Al cambiar el PIN del dueño, revocar sesiones activas previas inmediatamente.
        if coalesce(p_pin, '') <> '' then
            update public.lan_supervisor_sessions
               set ended_at = now()
             where public.lan_supervisor_sessions.account_id = p_account_id
               and ended_at is null;
        end if;

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
         where c.account_id = p_account_id
           and (
               c.status = 'pending'
               or (c.status = 'processing' and c.updated_at < now() - interval '60 seconds')
           )
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

create or replace function public.lan_supervisor_login(p_supervisor_code text, p_pin text)
returns table (session_token uuid, account_id uuid, account_name text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    v_acc public.lan_cloud_accounts;
    v_code text := upper(btrim(coalesce(p_supervisor_code, '')));
    v_token uuid := gen_random_uuid();
    v_exp timestamptz := now() + interval '12 hours';
    v_next_fails integer;
    v_lock_secs integer;
begin
    select * into v_acc from public.lan_cloud_accounts a where a.supervisor_code = v_code for update;
    if not found then
        -- Sin oráculo de existencia de código: mismo resultado vacío que PIN incorrecto.
        return;
    end if;

    if v_acc.locked_until is not null and v_acc.locked_until > now() then
        raise exception 'Demasiados intentos. Espera antes de volver a intentar.' using errcode = '42501';
    end if;

    if coalesce(p_pin, '') = '' or v_acc.supervisor_pin_hash <> crypt(p_pin, v_acc.supervisor_pin_hash) then
        v_next_fails := coalesce(v_acc.failed_attempts, 0) + 1;
        if v_next_fails >= 5 then
            v_lock_secs := least(60 * (2 ^ least(coalesce(v_acc.lockouts, 0), 4)), 900)::integer;
            update public.lan_cloud_accounts a
               set failed_attempts = 0,
                   lockouts = coalesce(a.lockouts, 0) + 1,
                   locked_until = now() + (v_lock_secs || ' seconds')::interval,
                   updated_at = now()
             where a.account_id = v_acc.account_id;
        else
            update public.lan_cloud_accounts a
               set failed_attempts = v_next_fails,
                   updated_at = now()
             where a.account_id = v_acc.account_id;
        end if;
        return;
    end if;

    update public.lan_cloud_accounts a
       set failed_attempts = 0, lockouts = 0, locked_until = null, updated_at = now()
     where a.account_id = v_acc.account_id;

    insert into public.lan_supervisor_sessions (token, account_id, expires_at)
    values (v_token, v_acc.account_id, v_exp);

    return query select v_token, v_acc.account_id, v_acc.account_name, v_exp;
end;
$$;
