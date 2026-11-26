-- Precios al Día Nube · «Equipos y empleados» con el PIN del dueño.
--
-- Hasta ahora renombrar o expulsar equipos pedía la sesión del dueño con correo y clave
-- (assign_device, revoke_device). Desde el selector «¿Quién está operando?» el dueño
-- ahora entra con su PIN en el propio equipo, así que hacen falta versiones que acepten
-- esa sesión de PIN:
--   · team_rename_device: cambia el nombre (y opcionalmente la sede) de un equipo.
--   · team_revoke_device: expulsa un equipo y cierra sus sesiones de PIN.
-- Solo el dueño (no el administrador). El correo sigue sirviendo para registrar equipos
-- nuevos y para reponer el PIN del dueño si lo olvidó.
-- Idempotente. Vuelta atrás al final.

create or replace function public.team_rename_device(
    p_session uuid, p_device_id text, p_label text default null, p_sede_id uuid default null)
returns public.account_devices language plpgsql security definer set search_path = public as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
    v_row public.account_devices;
begin
    if v_me.id is null then
        raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501';
    end if;
    if v_me.role <> 'dueno' then raise exception 'Solo el dueño cambia equipos' using errcode = '42501'; end if;
    if p_sede_id is not null and not exists (
        select 1 from public.sedes where id = p_sede_id and account_id = v_me.account_id and archived_at is null) then
        raise exception 'Sede inválida' using errcode = '22023';
    end if;
    update public.account_devices
       set label = coalesce(nullif(btrim(p_label), ''), label),
           sede_id = coalesce(p_sede_id, sede_id)
     where id = p_device_id and account_id = v_me.account_id and revoked_at is null
    returning * into v_row;
    if not found then raise exception 'Equipo no encontrado' using errcode = 'P0002'; end if;
    return v_row;
end;
$$;

create or replace function public.team_revoke_device(p_session uuid, p_device_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_me public.account_members := public.nube_session_member(p_session);
begin
    if v_me.id is null then
        raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501';
    end if;
    if v_me.role <> 'dueno' then raise exception 'Solo el dueño expulsa equipos' using errcode = '42501'; end if;
    update public.account_devices set revoked_at = now()
     where id = p_device_id and account_id = v_me.account_id and revoked_at is null;
    if not found then raise exception 'Equipo no encontrado' using errcode = 'P0002'; end if;
    update public.member_sessions set ended_at = now() where device_id = p_device_id and ended_at is null;
end;
$$;

revoke all on function public.team_rename_device(uuid, text, text, uuid),
    public.team_revoke_device(uuid, text)
from public, anon;
grant execute on function public.team_rename_device(uuid, text, text, uuid),
    public.team_revoke_device(uuid, text)
to authenticated;

-- ROLLBACK
-- drop function if exists public.team_revoke_device(uuid, text), public.team_rename_device(uuid, text, text, uuid);
