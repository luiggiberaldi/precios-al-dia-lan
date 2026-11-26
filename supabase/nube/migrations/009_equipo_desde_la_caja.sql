-- Precios al Día Nube · F1b — Equipo desde la caja.
--
-- Hasta ahora solo el dueño, con su correo y clave, podía tocar empleados (upsert_member).
-- Con esto, desde Ajustes → Usuarios de una caja y con la sesión de PIN:
--   · team_upsert_member: el dueño o un administrador crea, edita, cambia el PIN,
--     desactiva o reactiva empleados. El administrador solo maneja cajeros.
--   · member_change_own_pin: cualquiera cambia SU PIN (pide el actual), también el dueño.
--   · owner_set_own_pin: el dueño que olvidó su PIN lo repone con su correo y clave.
-- Nombres repetidos dan un error claro en vez del de la restricción única.
-- Idempotente. Vuelta atrás al final.

-- Nombre libre dentro de la cuenta (sin distinguir mayúsculas). Uso interno.
create or replace function nube_private.check_member_name(p_account uuid, p_member uuid, p_name text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
    v_name text := btrim(coalesce(p_name, ''));
begin
    if length(v_name) < 1 or length(v_name) > 40 then
        raise exception 'El nombre debe tener entre 1 y 40 caracteres' using errcode = '22023';
    end if;
    if exists (select 1 from public.account_members m
               where m.account_id = p_account and lower(m.display_name) = lower(v_name)
                 and (p_member is null or m.id <> p_member)) then
        raise exception 'Ya hay alguien llamado «%» en el equipo. Usa otro nombre.', v_name using errcode = '23505';
    end if;
    return v_name;
end;
$$;

-- El dueño o un administrador gestiona empleados desde una caja, con su sesión de PIN.
create or replace function public.team_upsert_member(
    p_session uuid, p_member_id uuid, p_display_name text, p_role text,
    p_pin text default null, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
    v_target public.account_members;
    v_name text;
    v_id uuid;
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
    end if;

    v_name := nube_private.check_member_name(v_me.account_id, p_member_id, p_display_name);
    if p_pin is not null then perform public.nube_validate_pin(p_pin, p_role); end if;

    if p_member_id is null then
        if p_pin is null then raise exception 'El empleado necesita un PIN' using errcode = '22023'; end if;
        insert into public.account_members (account_id, display_name, role, pin_hash)
        values (v_me.account_id, v_name, p_role, crypt(p_pin, gen_salt('bf')))
        returning id into v_id;
    else
        update public.account_members
           set display_name = v_name,
               role = p_role,
               active = coalesce(p_active, true),
               pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf')) end,
               failed_attempts = case when p_pin is null then failed_attempts else 0 end,
               lockouts = case when p_pin is null then lockouts else 0 end,
               locked_until = case when p_pin is null then locked_until else null end
         where id = p_member_id
        returning id into v_id;
        -- Desactivado o con PIN nuevo: sus sesiones abiertas se cierran.
        if not coalesce(p_active, true) or p_pin is not null then
            update public.member_sessions set ended_at = now() where member_id = v_id and ended_at is null;
        end if;
    end if;
    return v_id;
end;
$$;

-- Cualquiera cambia su propio PIN con su sesión y el PIN actual.
create or replace function public.member_change_own_pin(p_session uuid, p_current_pin text, p_new_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
begin
    if v_me.id is null then
        raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501';
    end if;
    if v_me.pin_hash <> crypt(coalesce(p_current_pin, ''), v_me.pin_hash) then
        raise exception 'El PIN actual no es correcto' using errcode = '28P01';
    end if;
    perform public.nube_validate_pin(p_new_pin, v_me.role);
    if p_new_pin = p_current_pin then
        raise exception 'El PIN nuevo debe ser distinto del actual' using errcode = '22023';
    end if;
    update public.account_members
       set pin_hash = crypt(p_new_pin, gen_salt('bf')), failed_attempts = 0, lockouts = 0, locked_until = null
     where id = v_me.id;
end;
$$;

-- El dueño (correo y clave) repone su PIN si lo olvidó. También lo desbloquea.
create or replace function public.owner_set_own_pin(p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
    v_account uuid := public.nube_owner_account_id();
begin
    if v_account is null then raise exception 'Solo el dueño, con su correo, repone su PIN' using errcode = '42501'; end if;
    perform public.nube_validate_pin(p_pin, 'dueno');
    update public.account_members
       set pin_hash = crypt(p_pin, gen_salt('bf')), failed_attempts = 0, lockouts = 0, locked_until = null
     where account_id = v_account and role = 'dueno';
end;
$$;

revoke all on function nube_private.check_member_name(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.team_upsert_member(uuid, uuid, text, text, text, boolean),
    public.member_change_own_pin(uuid, text, text),
    public.owner_set_own_pin(text)
from public, anon;
grant execute on function public.team_upsert_member(uuid, uuid, text, text, text, boolean),
    public.member_change_own_pin(uuid, text, text),
    public.owner_set_own_pin(text)
to authenticated;

-- ROLLBACK
-- drop function if exists public.owner_set_own_pin(text), public.member_change_own_pin(uuid, text, text),
--     public.team_upsert_member(uuid, uuid, text, text, text, boolean), nube_private.check_member_name(uuid, uuid, text);
