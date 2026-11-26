-- Precios al Día Nube · Licencia de prueba con 2 equipos.
--
-- Hasta ahora un negocio nuevo empezaba con 1 caja (1 equipo). Por ahora arranca con 2:
--   · valor por defecto de account_licenses.max_cajas → 2
--   · create_account crea la licencia de prueba con 2 cajas (sede: sigue en 1)
-- No toca las licencias que ya existen. Idempotente. Vuelta atrás al final.

alter table public.account_licenses alter column max_cajas set default 2;

-- El dueño crea su negocio, su primera sede y su usuario con PIN.
-- Licencia inicial: prueba con 2 cajas y 1 sede, 15 días (la Estación la amplía).
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
    insert into public.account_members (account_id, display_name, role, pin_hash, user_id)
        values (v_account, btrim(p_owner_name), 'dueno', crypt(p_owner_pin, gen_salt('bf')), v_uid);
    return v_account;
end;
$$;

-- ROLLBACK
-- alter table public.account_licenses alter column max_cajas set default 1;
-- y volver a crear public.create_account como en 001 (licencia de prueba con 1 caja).
