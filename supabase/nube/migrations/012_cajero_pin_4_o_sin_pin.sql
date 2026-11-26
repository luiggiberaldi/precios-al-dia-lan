-- Precios al Día Nube · Cajero con PIN de 4 dígitos o sin PIN.
--
-- Hasta ahora todo empleado necesitaba un PIN de 6 a 32 dígitos. Ahora:
--   · cajero: PIN de 4 dígitos exactos, o SIN PIN (entra con solo tocar su nombre).
--   · dueño y administrador: siguen con 6 a 32 dígitos (sin 000000).
-- `pin_length` (null = sin PIN) le dice a la caja cuántos dígitos pedir; los cajeros
-- que ya tenían PIN de 6 lo conservan y siguen entrando con él.
-- El bloqueo por intentos fallidos (5 intentos, espera creciente) se mantiene.
-- Idempotente. Vuelta atrás al final.

alter table public.account_members alter column pin_hash drop not null;
alter table public.account_members add column if not exists pin_length smallint;
update public.account_members set pin_length = 6 where pin_hash is not null and pin_length is null;

alter table public.account_members drop constraint if exists account_members_pin_presence_check;
alter table public.account_members add constraint account_members_pin_presence_check
    check ((pin_hash is null) = (pin_length is null) and (pin_hash is not null or role = 'cajero'));

grant select (pin_length) on public.account_members to authenticated;

create or replace function public.nube_validate_pin(p_pin text, p_role text)
returns void language plpgsql immutable set search_path = public as $$
begin
    if p_role = 'cajero' then
        if p_pin is null or p_pin !~ '^[0-9]{4}$' then
            raise exception 'El PIN del cajero debe tener 4 dígitos' using errcode = '22023';
        end if;
        return;
    end if;
    if p_pin is null or p_pin !~ '^[0-9]{6,32}$' then
        raise exception 'El PIN debe tener entre 6 y 32 dígitos' using errcode = '22023';
    end if;
    if p_role in ('dueno', 'administrador') and p_pin = '000000' then
        raise exception 'Elige un PIN distinto de 000000 (es el de fábrica)' using errcode = '22023';
    end if;
end;
$$;

-- Entrar: el cajero sin PIN entra directo; los demás como siempre.
create or replace function public.member_login_pin(p_member_id uuid, p_pin text)
returns table(session_token uuid, member_id uuid, display_name text, role text, expires_at timestamptz)
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

    if v_m.pin_hash is null then
        if v_m.role <> 'cajero' then raise exception 'Usuario o PIN incorrecto' using errcode = '28P01'; end if;
    else
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
            return;
        end if;
    end if;

    update public.account_members set failed_attempts = 0, lockouts = 0, locked_until = null where id = v_m.id;
    update public.account_devices set last_seen_at = now() where id = v_device.id;
    insert into public.member_sessions (member_id, device_id, expires_at)
        values (v_m.id, v_device.id, v_exp) returning token into v_token;

    return query select v_token, v_m.id, v_m.display_name, v_m.role, v_exp;
end;
$$;

-- Cambiar mi PIN: quien no tenía PIN (cajero) no necesita escribir el actual.
create or replace function public.member_change_own_pin(p_session uuid, p_current_pin text, p_new_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
begin
    if v_me.id is null then
        raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501';
    end if;
    if v_me.pin_hash is not null and v_me.pin_hash <> crypt(coalesce(p_current_pin, ''), v_me.pin_hash) then
        raise exception 'El PIN actual no es correcto' using errcode = '28P01';
    end if;
    perform public.nube_validate_pin(p_new_pin, v_me.role);
    if v_me.pin_hash is not null and p_new_pin = p_current_pin then
        raise exception 'El PIN nuevo debe ser distinto del actual' using errcode = '22023';
    end if;
    update public.account_members
       set pin_hash = crypt(p_new_pin, gen_salt('bf')), pin_length = length(p_new_pin),
           failed_attempts = 0, lockouts = 0, locked_until = null
     where id = v_me.id;
end;
$$;

create or replace function public.owner_set_own_pin(p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
    v_account uuid := public.nube_owner_account_id();
begin
    if v_account is null then raise exception 'Solo el dueño, con su correo, repone su PIN' using errcode = '42501'; end if;
    perform public.nube_validate_pin(p_pin, 'dueno');
    update public.account_members
       set pin_hash = crypt(p_pin, gen_salt('bf')), pin_length = length(p_pin),
           failed_attempts = 0, lockouts = 0, locked_until = null
     where account_id = v_account and role = 'dueno';
end;
$$;

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
        values (v_account, 'trial', 2, 1, now() + interval '15 days');
    insert into public.sedes (account_id, name) values (v_account, btrim(coalesce(nullif(p_sede_name, ''), 'Principal')));
    insert into public.account_members (account_id, display_name, role, pin_hash, pin_length, user_id)
        values (v_account, btrim(p_owner_name), 'dueno', crypt(p_owner_pin, gen_salt('bf')), length(p_owner_pin), v_uid);
    return v_account;
end;
$$;

-- Crear / editar empleado. p_sin_pin = true: cajero que entra sin PIN.
-- p_pin null y p_sin_pin false al editar: conserva el PIN que tenga.
drop function if exists public.team_upsert_member(uuid, uuid, text, text, text, boolean);
create or replace function public.team_upsert_member(
    p_session uuid, p_member_id uuid, p_display_name text, p_role text,
    p_pin text default null, p_active boolean default true, p_sin_pin boolean default false)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
    v_target public.account_members;
    v_name text;
    v_id uuid;
    v_change_pin boolean := p_pin is not null or coalesce(p_sin_pin, false);
begin
    if v_me.id is null then
        raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501';
    end if;
    if v_me.role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador gestiona empleados' using errcode = '42501';
    end if;
    if p_role not in ('administrador', 'cajero') then raise exception 'Rol inválido' using errcode = '22023'; end if;
    if v_me.role = 'administrador' and p_role = 'administrador' then
        raise exception 'Solo el dueño crea o edita administradores' using errcode = '42501';
    end if;
    if coalesce(p_sin_pin, false) and p_role <> 'cajero' then
        raise exception 'Solo el cajero puede entrar sin PIN' using errcode = '22023';
    end if;

    if p_member_id is not null then
        select * into v_target from public.account_members
         where id = p_member_id and account_id = v_me.account_id for update;
        if not found or v_target.role = 'dueno' then
            raise exception 'Empleado no encontrado' using errcode = 'P0002';
        end if;
        if v_target.id = v_me.id then
            raise exception 'Para cambiar tu propio PIN usa «Cambiar mi PIN»' using errcode = '42501';
        end if;
        if v_me.role = 'administrador' and v_target.role = 'administrador' then
            raise exception 'Solo el dueño crea o edita administradores' using errcode = '42501';
        end if;
        if p_role = 'administrador' and p_pin is null and coalesce(v_target.pin_length, 0) < 6 then
            raise exception 'Para hacerlo administrador ponle un PIN de 6 números o más' using errcode = '22023';
        end if;
    end if;

    v_name := nube_private.check_member_name(v_me.account_id, p_member_id, p_display_name);
    if p_pin is not null then perform public.nube_validate_pin(p_pin, p_role); end if;

    if p_member_id is null then
        if p_pin is null and not coalesce(p_sin_pin, false) then
            raise exception 'El empleado necesita un PIN' using errcode = '22023';
        end if;
        insert into public.account_members (account_id, display_name, role, pin_hash, pin_length)
        values (v_me.account_id, v_name, p_role,
                case when p_pin is null then null else crypt(p_pin, gen_salt('bf')) end,
                case when p_pin is null then null else length(p_pin) end)
        returning id into v_id;
    else
        update public.account_members
           set display_name = v_name,
               role = p_role,
               active = coalesce(p_active, true),
               pin_hash = case when p_pin is not null then crypt(p_pin, gen_salt('bf'))
                               when p_sin_pin then null else pin_hash end,
               pin_length = case when p_pin is not null then length(p_pin)
                                 when p_sin_pin then null else pin_length end,
               failed_attempts = case when v_change_pin then 0 else failed_attempts end,
               lockouts = case when v_change_pin then 0 else lockouts end,
               locked_until = case when v_change_pin then null else locked_until end
         where id = p_member_id
        returning id into v_id;
        -- Desactivado o con PIN nuevo: sus sesiones abiertas se cierran.
        if not coalesce(p_active, true) or v_change_pin then
            update public.member_sessions set ended_at = now() where member_id = v_id and ended_at is null;
        end if;
    end if;
    return v_id;
end;
$$;

-- Lo mismo para el dueño con su correo (panel de administración).
drop function if exists public.upsert_member(uuid, text, text, text, boolean);
create or replace function public.upsert_member(
    p_member_id uuid, p_display_name text, p_role text,
    p_pin text default null, p_active boolean default true, p_sin_pin boolean default false)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_account uuid := public.nube_owner_account_id();
    v_target public.account_members;
    v_id uuid;
    v_change_pin boolean := p_pin is not null or coalesce(p_sin_pin, false);
begin
    if v_account is null then raise exception 'Solo el dueño gestiona empleados' using errcode = '42501'; end if;
    if p_role not in ('administrador', 'cajero') then raise exception 'Rol inválido' using errcode = '22023'; end if;
    if coalesce(p_sin_pin, false) and p_role <> 'cajero' then
        raise exception 'Solo el cajero puede entrar sin PIN' using errcode = '22023';
    end if;
    if p_pin is not null then perform public.nube_validate_pin(p_pin, p_role); end if;

    if p_member_id is null then
        if p_pin is null and not coalesce(p_sin_pin, false) then
            raise exception 'El empleado necesita un PIN' using errcode = '22023';
        end if;
        insert into public.account_members (account_id, display_name, role, pin_hash, pin_length)
        values (v_account, btrim(p_display_name), p_role,
                case when p_pin is null then null else crypt(p_pin, gen_salt('bf')) end,
                case when p_pin is null then null else length(p_pin) end)
        returning id into v_id;
    else
        select * into v_target from public.account_members
         where id = p_member_id and account_id = v_account and role <> 'dueno' for update;
        if not found then raise exception 'Empleado no encontrado' using errcode = 'P0002'; end if;
        if p_role = 'administrador' and p_pin is null and coalesce(v_target.pin_length, 0) < 6 then
            raise exception 'Para hacerlo administrador ponle un PIN de 6 números o más' using errcode = '22023';
        end if;
        update public.account_members
           set display_name = btrim(p_display_name),
               role = p_role,
               active = p_active,
               pin_hash = case when p_pin is not null then crypt(p_pin, gen_salt('bf'))
                               when p_sin_pin then null else pin_hash end,
               pin_length = case when p_pin is not null then length(p_pin)
                                 when p_sin_pin then null else pin_length end,
               failed_attempts = case when v_change_pin then 0 else failed_attempts end,
               lockouts = case when v_change_pin then 0 else lockouts end,
               locked_until = case when v_change_pin then null else locked_until end
         where id = p_member_id
        returning id into v_id;
        if not coalesce(p_active, true) or v_change_pin then
            update public.member_sessions set ended_at = now() where member_id = v_id and ended_at is null;
        end if;
    end if;
    return v_id;
end;
$$;

revoke all on function public.team_upsert_member(uuid, uuid, text, text, text, boolean, boolean),
    public.upsert_member(uuid, text, text, text, boolean, boolean)
from public, anon;
grant execute on function public.team_upsert_member(uuid, uuid, text, text, text, boolean, boolean),
    public.upsert_member(uuid, text, text, text, boolean, boolean)
to authenticated;

notify pgrst, 'reload schema';

-- ROLLBACK (antes, ponerle PIN de 6 a los cajeros sin PIN o con PIN de 4)
-- drop function public.team_upsert_member(uuid, uuid, text, text, text, boolean, boolean);
-- drop function public.upsert_member(uuid, text, text, text, boolean, boolean);
-- volver a crear team_upsert_member (009), upsert_member, member_login_pin y nube_validate_pin (001),
-- member_change_own_pin y owner_set_own_pin (009), create_account (011);
-- alter table public.account_members drop constraint account_members_pin_presence_check;
-- alter table public.account_members drop column pin_length;
-- alter table public.account_members alter column pin_hash set not null;
