-- Precios al Día Nube · F1 — Cuentas, sedes, empleados, equipos y licencia.
-- Plan: docs/plans/2026-11-15-plan-definitivo-precios-al-dia-nube.md (sección F1).
--
-- Modelo:
--   · La CUENTA es el negocio. La crea el dueño con su correo (usuario de Supabase Auth).
--   · Cada EQUIPO (PC, tablet, teléfono) tiene su propio usuario de Auth (sesión
--     anónima) y queda ligado a la cuenta cuando el dueño lo registra. Así una caja
--     nunca guarda la sesión del dueño.
--   · Los EMPLEADOS entran con PIN en un equipo registrado. El PIN se guarda con hash
--     (bcrypt) y nunca se puede leer desde la app.
--   · La LICENCIA es de la cuenta (D7): cuántas cajas y sedes. Solo el servidor
--     (service_role, Estación Maestra) la cambia. Los teléfonos de consulta no cuentan.
--
-- Barandas: G7 (IDs y reintentos), G8 (toda escritura por RPC, RLS en todo),
-- G13 (cada cuenta aislada). Nada se escribe directo en las tablas desde la app.
--
-- Idempotente. Vuelta atrás al final (sección -- ROLLBACK).

create extension if not exists pgcrypto with schema extensions;

-- ─── Tablas ──────────────────────────────────────────────────────────────────

create table if not exists public.accounts (
    id              uuid primary key default gen_random_uuid(),
    name            text not null check (length(btrim(name)) between 2 and 80),
    owner_user_id   uuid not null unique,
    created_at      timestamptz not null default now()
);
comment on table public.accounts is 'Negocio (cuenta). Un dueño = una cuenta por ahora.';

create table if not exists public.account_licenses (
    account_id      uuid primary key references public.accounts(id) on delete cascade,
    product         text not null default 'nube' check (product = 'nube'),
    status          text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
    max_cajas       integer not null default 1 check (max_cajas between 0 and 100),
    max_sedes       integer not null default 1 check (max_sedes between 1 and 50),
    expires_at      timestamptz,
    updated_at      timestamptz not null default now()
);
comment on table public.account_licenses is 'Licencia por cuenta (D7). Solo service_role escribe; el dueño solo lee.';

create table if not exists public.sedes (
    id              uuid primary key default gen_random_uuid(),
    account_id      uuid not null references public.accounts(id) on delete cascade,
    name            text not null check (length(btrim(name)) between 1 and 60),
    created_at      timestamptz not null default now(),
    archived_at     timestamptz,
    unique (account_id, name)
);

create table if not exists public.account_members (
    id              uuid primary key default gen_random_uuid(),
    account_id      uuid not null references public.accounts(id) on delete cascade,
    display_name    text not null check (length(btrim(display_name)) between 1 and 40),
    role            text not null check (role in ('dueno', 'administrador', 'cajero')),
    pin_hash        text not null,
    user_id         uuid,                 -- solo el dueño: su usuario de Auth
    active          boolean not null default true,
    failed_attempts integer not null default 0,
    lockouts        integer not null default 0,
    locked_until    timestamptz,
    created_at      timestamptz not null default now(),
    unique (account_id, display_name)
);
create unique index if not exists account_members_one_owner
    on public.account_members (account_id) where role = 'dueno';

create table if not exists public.account_devices (
    id              text primary key check (id ~ '^PDN-[0-9A-F]{32}$'),
    account_id      uuid not null references public.accounts(id) on delete cascade,
    auth_user_id    uuid not null unique, -- usuario de Auth (anónimo) del equipo
    sede_id         uuid references public.sedes(id),
    role            text not null check (role in ('caja', 'consulta')),
    caja_letter     text check (caja_letter ~ '^[A-Z]{1,2}$'),
    label           text not null check (length(btrim(label)) between 1 and 40),
    registered_by   uuid not null,
    created_at      timestamptz not null default now(),
    last_seen_at    timestamptz,
    revoked_at      timestamptz,
    check ((role = 'caja') = (caja_letter is not null))
);
create unique index if not exists account_devices_letter_active
    on public.account_devices (account_id, caja_letter) where revoked_at is null and caja_letter is not null;

create table if not exists public.member_sessions (
    token           uuid primary key default gen_random_uuid(),
    member_id       uuid not null references public.account_members(id) on delete cascade,
    device_id       text not null references public.account_devices(id) on delete cascade,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    ended_at        timestamptz
);
create index if not exists member_sessions_device on public.member_sessions (device_id);

-- ─── Ayudantes (quién soy) ───────────────────────────────────────────────────

-- Cuenta de la que soy dueño (sesión con correo, no anónima).
create or replace function public.nube_owner_account_id()
returns uuid language sql stable security definer set search_path = public as $$
    select a.id from public.accounts a where a.owner_user_id = auth.uid();
$$;

-- Equipo activo de esta sesión (sesión anónima de un equipo registrado).
create or replace function public.nube_current_device()
returns public.account_devices language sql stable security definer set search_path = public as $$
    select d.* from public.account_devices d
    where d.auth_user_id = auth.uid() and d.revoked_at is null;
$$;

-- Cuenta visible para esta sesión: la del dueño o la del equipo.
create or replace function public.nube_my_account_id()
returns uuid language sql stable security definer set search_path = public as $$
    select coalesce(public.nube_owner_account_id(), (public.nube_current_device()).account_id);
$$;

-- Reglas del PIN (las mismas de Bodega: 6 a 32 dígitos; dueño y administrador sin 000000).
create or replace function public.nube_validate_pin(p_pin text, p_role text)
returns void language plpgsql immutable as $$
begin
    if p_pin is null or p_pin !~ '^[0-9]{6,32}$' then
        raise exception 'El PIN debe tener entre 6 y 32 dígitos' using errcode = '22023';
    end if;
    if p_role in ('dueno', 'administrador') and p_pin = '000000' then
        raise exception 'Elige un PIN distinto de 000000 (es el de fábrica)' using errcode = '22023';
    end if;
end;
$$;

-- ─── RLS: solo lectura de lo propio; toda escritura por RPC ──────────────────

alter table public.accounts         enable row level security;
alter table public.account_licenses enable row level security;
alter table public.sedes            enable row level security;
alter table public.account_members  enable row level security;
alter table public.account_devices  enable row level security;
alter table public.member_sessions  enable row level security;

revoke all on public.accounts, public.account_licenses, public.sedes, public.account_members,
              public.account_devices, public.member_sessions from anon, authenticated;

grant select on public.accounts, public.account_licenses, public.sedes, public.account_devices to authenticated;
-- El hash del PIN y los contadores de intentos nunca se leen desde la app.
grant select (id, account_id, display_name, role, active, created_at) on public.account_members to authenticated;

drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated
    using (id = public.nube_my_account_id());

drop policy if exists licenses_read on public.account_licenses;
create policy licenses_read on public.account_licenses for select to authenticated
    using (account_id = public.nube_my_account_id());

drop policy if exists sedes_read on public.sedes;
create policy sedes_read on public.sedes for select to authenticated
    using (account_id = public.nube_my_account_id());

drop policy if exists members_read on public.account_members;
create policy members_read on public.account_members for select to authenticated
    using (account_id = public.nube_my_account_id());

drop policy if exists devices_read on public.account_devices;
create policy devices_read on public.account_devices for select to authenticated
    using (account_id = public.nube_my_account_id());
-- member_sessions: sin política = nadie la lee desde la app.

-- ─── RPC ─────────────────────────────────────────────────────────────────────

-- El dueño crea su negocio, su primera sede y su usuario con PIN.
-- Licencia inicial: prueba con 1 caja y 1 sede, 15 días (la Estación la amplía).
create or replace function public.create_account(p_name text, p_sede_name text, p_owner_name text, p_owner_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_uid uuid := auth.uid();
    v_account uuid;
begin
    if v_uid is null then raise exception 'Inicia sesión con tu correo' using errcode = '42501'; end if;
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        raise exception 'Solo el dueño, con su correo, puede crear la cuenta' using errcode = '42501';
    end if;
    select id into v_account from public.accounts where owner_user_id = v_uid;
    if v_account is not null then return v_account; end if;  -- reintento: ya existe (G7)

    perform public.nube_validate_pin(p_owner_pin, 'dueno');

    insert into public.accounts (name, owner_user_id) values (btrim(p_name), v_uid) returning id into v_account;
    insert into public.account_licenses (account_id, status, max_cajas, max_sedes, expires_at)
        values (v_account, 'trial', 1, 1, now() + interval '15 days');
    insert into public.sedes (account_id, name) values (v_account, btrim(coalesce(nullif(p_sede_name, ''), 'Principal')));
    insert into public.account_members (account_id, display_name, role, pin_hash, user_id)
        values (v_account, btrim(p_owner_name), 'dueno', crypt(p_owner_pin, gen_salt('bf')), v_uid);
    return v_account;
end;
$$;

-- El dueño registra un equipo. El equipo ya abrió su sesión anónima (p_device_user_id)
-- y el dueño, desde ese mismo equipo, confirma con su correo y clave.
create or replace function public.register_device(
    p_device_user_id uuid, p_label text, p_role text default 'caja', p_sede_id uuid default null)
returns public.account_devices language plpgsql security definer set search_path = public, extensions as $$
declare
    v_account uuid := public.nube_owner_account_id();
    v_lic public.account_licenses;
    v_sede uuid;
    v_letter text;
    v_count integer;
    v_row public.account_devices;
begin
    if v_account is null then raise exception 'Solo el dueño registra equipos' using errcode = '42501'; end if;
    if p_device_user_id is null or p_device_user_id = auth.uid() then
        raise exception 'El equipo necesita su propia sesión' using errcode = '22023';
    end if;
    if p_role not in ('caja', 'consulta') then raise exception 'Rol de equipo inválido' using errcode = '22023'; end if;

    -- Reintento del mismo equipo: devolver lo que ya existe (G7).
    select * into v_row from public.account_devices where auth_user_id = p_device_user_id;
    if found then
        if v_row.account_id <> v_account then raise exception 'Ese equipo es de otra cuenta' using errcode = '42501'; end if;
        if v_row.revoked_at is not null then raise exception 'Ese equipo fue expulsado' using errcode = '42501'; end if;
        return v_row;
    end if;

    select * into v_lic from public.account_licenses where account_id = v_account for update;
    if v_lic.status = 'suspended' or (v_lic.expires_at is not null and v_lic.expires_at < now()) then
        raise exception 'La licencia no está activa' using errcode = 'P0001';
    end if;

    v_sede := coalesce(p_sede_id, (select id from public.sedes where account_id = v_account and archived_at is null order by created_at limit 1));
    if not exists (select 1 from public.sedes where id = v_sede and account_id = v_account and archived_at is null) then
        raise exception 'Sede inválida' using errcode = '22023';
    end if;

    if p_role = 'caja' then
        select count(*) into v_count from public.account_devices
            where account_id = v_account and role = 'caja' and revoked_at is null;
        if v_count >= v_lic.max_cajas then
            raise exception 'Tu licencia permite % caja(s). Expulsa una o amplía la licencia.', v_lic.max_cajas
                using errcode = 'P0001';
        end if;
        select l into v_letter from (
            select chr(65 + g) as l from generate_series(0, 25) g
        ) letters
        where l not in (select caja_letter from public.account_devices
                        where account_id = v_account and revoked_at is null and caja_letter is not null)
        order by l limit 1;
    end if;

    insert into public.account_devices (id, account_id, auth_user_id, sede_id, role, caja_letter, label, registered_by)
    values ('PDN-' || upper(encode(gen_random_bytes(16), 'hex')), v_account, p_device_user_id, v_sede,
            p_role, v_letter, btrim(p_label), auth.uid())
    returning * into v_row;
    return v_row;
end;
$$;

-- El dueño cambia nombre o sede de un equipo.
create or replace function public.assign_device(p_device_id text, p_label text default null, p_sede_id uuid default null)
returns public.account_devices language plpgsql security definer set search_path = public as $$
declare
    v_account uuid := public.nube_owner_account_id();
    v_row public.account_devices;
begin
    if v_account is null then raise exception 'Solo el dueño cambia equipos' using errcode = '42501'; end if;
    if p_sede_id is not null and not exists (select 1 from public.sedes where id = p_sede_id and account_id = v_account and archived_at is null) then
        raise exception 'Sede inválida' using errcode = '22023';
    end if;
    update public.account_devices
       set label = coalesce(nullif(btrim(p_label), ''), label),
           sede_id = coalesce(p_sede_id, sede_id)
     where id = p_device_id and account_id = v_account and revoked_at is null
    returning * into v_row;
    if not found then raise exception 'Equipo no encontrado' using errcode = 'P0002'; end if;
    return v_row;
end;
$$;

-- El dueño expulsa un equipo: libera su caja y cierra las sesiones de PIN abiertas en él.
create or replace function public.revoke_device(p_device_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_account uuid := public.nube_owner_account_id();
begin
    if v_account is null then raise exception 'Solo el dueño expulsa equipos' using errcode = '42501'; end if;
    update public.account_devices set revoked_at = now()
     where id = p_device_id and account_id = v_account and revoked_at is null;
    if not found then raise exception 'Equipo no encontrado' using errcode = 'P0002'; end if;
    update public.member_sessions set ended_at = now() where device_id = p_device_id and ended_at is null;
end;
$$;

-- El dueño agrega o edita un empleado (administrador o cajero).
create or replace function public.upsert_member(p_member_id uuid, p_display_name text, p_role text, p_pin text default null, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_account uuid := public.nube_owner_account_id();
    v_id uuid;
begin
    if v_account is null then raise exception 'Solo el dueño gestiona empleados' using errcode = '42501'; end if;
    if p_role not in ('administrador', 'cajero') then raise exception 'Rol inválido' using errcode = '22023'; end if;
    if p_pin is not null then perform public.nube_validate_pin(p_pin, p_role); end if;

    if p_member_id is null then
        if p_pin is null then raise exception 'El empleado necesita un PIN' using errcode = '22023'; end if;
        insert into public.account_members (account_id, display_name, role, pin_hash)
        values (v_account, btrim(p_display_name), p_role, crypt(p_pin, gen_salt('bf')))
        returning id into v_id;
    else
        update public.account_members
           set display_name = btrim(p_display_name),
               role = p_role,
               active = p_active,
               pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf')) end,
               failed_attempts = case when p_pin is null then failed_attempts else 0 end,
               locked_until = case when p_pin is null then locked_until else null end
         where id = p_member_id and account_id = v_account and role <> 'dueno'
        returning id into v_id;
        if v_id is null then raise exception 'Empleado no encontrado' using errcode = 'P0002'; end if;
    end if;
    return v_id;
end;
$$;

-- Un empleado entra con su PIN en un equipo registrado. Devuelve una sesión de 12 h.
-- Bloqueo como en Bodega: 5 intentos fallidos → 30 s, y se duplica en cada bloqueo (máx. 15 min).
create or replace function public.member_login_pin(p_member_id uuid, p_pin text)
returns table (session_token uuid, member_id uuid, display_name text, role text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_device public.account_devices := public.nube_current_device();
    v_m public.account_members;
    v_lock interval;
    v_token uuid;
    v_exp timestamptz := now() + interval '12 hours';
begin
    if v_device.id is null then raise exception 'Este equipo no está registrado o fue expulsado' using errcode = '42501'; end if;

    select * into v_m from public.account_members
     where id = p_member_id and account_id = v_device.account_id and active
     for update;
    if not found then raise exception 'Usuario o PIN incorrecto' using errcode = '28P01'; end if;

    if v_m.locked_until is not null and v_m.locked_until > now() then
        raise exception 'Demasiados intentos. Espera % segundos.',
            ceil(extract(epoch from v_m.locked_until - now()))::int using errcode = 'P0001';
    end if;

    if v_m.pin_hash <> crypt(coalesce(p_pin, ''), v_m.pin_hash) then
        if v_m.failed_attempts + 1 >= 5 then
            v_lock := least(interval '30 seconds' * power(2, v_m.lockouts), interval '15 minutes');
            update public.account_members
               set failed_attempts = 0, lockouts = lockouts + 1, locked_until = now() + v_lock
             where id = v_m.id;
        else
            update public.account_members set failed_attempts = failed_attempts + 1 where id = v_m.id;
        end if;
        -- Los contadores se guardan aunque el login falle: se devuelve el error sin excepción
        -- para no deshacer el UPDATE; el cliente lo trata como «PIN incorrecto».
        return;
    end if;

    update public.account_members set failed_attempts = 0, lockouts = 0, locked_until = null where id = v_m.id;
    update public.account_devices set last_seen_at = now() where id = v_device.id;
    insert into public.member_sessions (member_id, device_id, expires_at)
        values (v_m.id, v_device.id, v_exp) returning token into v_token;

    return query select v_token, v_m.id, v_m.display_name, v_m.role, v_exp;
end;
$$;

-- Sesión de PIN válida en ESTE equipo (para las RPC de F3 en adelante).
create or replace function public.nube_session_member(p_session uuid)
returns public.account_members language sql stable security definer set search_path = public as $$
    select m.* from public.member_sessions s
    join public.account_members m on m.id = s.member_id and m.active
    join public.account_devices d on d.id = s.device_id and d.revoked_at is null
    where s.token = p_session and s.ended_at is null and s.expires_at > now()
      and d.auth_user_id = auth.uid();
$$;

-- Versión segura para la app: quién está en esta sesión (sin hash ni contadores).
create or replace function public.current_member(p_session uuid)
returns table (member_id uuid, display_name text, role text, account_id uuid)
language sql stable security definer set search_path = public as $$
    select m.id, m.display_name, m.role, m.account_id
    from public.nube_session_member(p_session) m
    where m.id is not null;
$$;

create or replace function public.member_logout(p_session uuid)
returns void language sql security definer set search_path = public as $$
    update public.member_sessions s set ended_at = now()
    from public.account_devices d
    where s.token = p_session and s.device_id = d.id and d.auth_user_id = auth.uid() and s.ended_at is null;
$$;

-- El equipo avisa que sigue vivo.
create or replace function public.touch_device()
returns void language sql security definer set search_path = public as $$
    update public.account_devices set last_seen_at = now() where auth_user_id = auth.uid() and revoked_at is null;
$$;

-- ─── Permisos de las funciones ───────────────────────────────────────────────

revoke all on function public.nube_owner_account_id(), public.nube_current_device(), public.nube_my_account_id(),
    public.nube_validate_pin(text, text),
    public.create_account(text, text, text, text),
    public.register_device(uuid, text, text, uuid),
    public.assign_device(text, text, uuid),
    public.revoke_device(text),
    public.upsert_member(uuid, text, text, text, boolean),
    public.member_login_pin(uuid, text),
    public.nube_session_member(uuid),
    public.current_member(uuid),
    public.member_logout(uuid),
    public.touch_device()
from public, anon;
-- nube_session_member devuelve la fila completa (con hash): solo para otras funciones.
revoke all on function public.nube_session_member(uuid) from authenticated;

grant execute on function public.nube_my_account_id(),
    public.create_account(text, text, text, text),
    public.register_device(uuid, text, text, uuid),
    public.assign_device(text, text, uuid),
    public.revoke_device(text),
    public.upsert_member(uuid, text, text, text, boolean),
    public.member_login_pin(uuid, text),
    public.current_member(uuid),
    public.member_logout(uuid),
    public.touch_device()
to authenticated;

-- ROLLBACK
-- drop function if exists public.touch_device(), public.member_logout(uuid), public.current_member(uuid), public.nube_session_member(uuid),
--     public.member_login_pin(uuid, text), public.upsert_member(uuid, text, text, text, boolean),
--     public.revoke_device(text), public.assign_device(text, text, uuid),
--     public.register_device(uuid, text, text, uuid), public.create_account(text, text, text, text),
--     public.nube_validate_pin(text, text), public.nube_my_account_id(), public.nube_current_device(),
--     public.nube_owner_account_id();
-- drop table if exists public.member_sessions, public.account_devices, public.account_members,
--     public.sedes, public.account_licenses, public.accounts;
