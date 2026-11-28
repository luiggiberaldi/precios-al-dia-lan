-- Precios al Día Nube · RBAC (4 roles: dueno, administrador, inventario, cajero).
--
-- Amplía `account_members.role` para incluir el rol `inventario` (gestión de
-- catálogo, precios, stock, compras y proveedores sin acceso a caja ni nómina)
-- y añade el helper autoritativo `nube_private.has_permission(role, permission)`.
--
-- Reglas de jerarquía (idénticas a src/security/permissions.js y teamRules.js):
--   · dueno: crea/edita administrador, inventario y cajero.
--   · administrador (Encargado): crea/edita inventario y cajero.
--   · inventario / cajero: no gestionan equipo.
--   · Solo `cajero` puede entrar sin PIN; los demás roles exigen 6..32 dígitos (sin 000000).
-- Idempotente. Vuelta atrás al final.

alter table public.account_members drop constraint if exists account_members_role_check;
alter table public.account_members add constraint account_members_role_check
    check (role in ('dueno', 'administrador', 'inventario', 'cajero'));

-- Helper autoritativo de permisos RBAC en servidor.
create or replace function nube_private.has_permission(p_role text, p_permission text)
returns boolean language sql immutable set search_path = public as $$
    select case
        when p_role = 'dueno' then true
        when p_role = 'administrador' then p_permission in (
            'tab.dashboard', 'tab.sales', 'tab.products', 'tab.customers',
            'tab.suppliers', 'tab.reports', 'tab.settings',
            'sales.create', 'sales.void', 'sales.discount', 'sales.view_all_cajas',
            'cash.manage', 'rates.adjust',
            'products.edit', 'products.delete', 'products.view_cost', 'inventory.adjust',
            'customers.credit', 'customers.delete',
            'users.manage_staff'
        )
        when p_role = 'inventario' then p_permission in (
            'tab.products', 'tab.suppliers',
            'products.edit', 'inventory.adjust'
        )
        when p_role = 'cajero' then p_permission in (
            'tab.dashboard', 'tab.sales', 'tab.products', 'tab.customers',
            'sales.create', 'customers.credit'
        )
        else false
    end;
$$;

-- Política de PIN: cajero 4 dígitos exactos; dueno/administrador/inventario 6..32 dígitos sin 000000.
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
    if p_role in ('dueno', 'administrador', 'inventario') and p_pin = '000000' then
        raise exception 'Elige un PIN distinto de 000000 (es el de fábrica)' using errcode = '22023';
    end if;
end;
$$;

-- Crear / editar empleado desde la caja (sesión de PIN de dueño o administrador).
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
    if not nube_private.has_permission(v_me.role, 'users.manage_staff') then
        raise exception 'Solo el dueño o un administrador gestiona empleados' using errcode = '42501';
    end if;
    if p_role not in ('administrador', 'inventario', 'cajero') then
        raise exception 'Rol inválido' using errcode = '22023';
    end if;
    if p_role = 'administrador' and not nube_private.has_permission(v_me.role, 'users.manage_admins') then
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
        if v_target.role = 'administrador' and not nube_private.has_permission(v_me.role, 'users.manage_admins') then
            raise exception 'Solo el dueño crea o edita administradores' using errcode = '42501';
        end if;
        if p_role in ('administrador', 'inventario') and p_pin is null and coalesce(v_target.pin_length, 0) < 6 then
            raise exception 'Para asignar este rol ponle un PIN de 6 números o más' using errcode = '22023';
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
        if not coalesce(p_active, true) or v_change_pin then
            update public.member_sessions set ended_at = now() where member_id = v_id and ended_at is null;
        end if;
    end if;
    return v_id;
end;
$$;

-- Lo mismo para el dueño con su correo (panel de administración).
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
    if p_role not in ('administrador', 'inventario', 'cajero') then
        raise exception 'Rol inválido' using errcode = '22023';
    end if;
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
        if p_role in ('administrador', 'inventario') and p_pin is null and coalesce(v_target.pin_length, 0) < 6 then
            raise exception 'Para asignar este rol ponle un PIN de 6 números o más' using errcode = '22023';
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

-- ROLLBACK (antes, cambiar cualquier empleado con role = 'inventario' a 'cajero' o 'administrador')
-- drop function if exists nube_private.has_permission(text, text);
-- alter table public.account_members drop constraint if exists account_members_role_check;
-- alter table public.account_members add constraint account_members_role_check
--     check (role in ('dueno', 'administrador', 'cajero'));
-- volver a aplicar 012_cajero_pin_4_o_sin_pin.sql para team_upsert_member, upsert_member y nube_validate_pin.
