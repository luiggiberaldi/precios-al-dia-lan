-- Precios al Día Nube · Prueba configurable desde la Estación Maestra.
--
-- Hasta ahora create_account daba a cada negocio nuevo una prueba fija de 15 días
-- y 2 cajas (011). Ahora esos dos valores viven en public.nube_settings (una sola
-- fila) y la Estación los cambia con la llave service_role.
--   · trial_days       días de prueba de una cuenta nueva      (1–90, hoy 15)
--   · trial_max_cajas  equipos de caja de la prueba             (1–20, hoy 2)
-- La sede de la prueba sigue en 1. Solo afecta a las cuentas que se creen después:
-- no toca ninguna licencia existente. Idempotente. Vuelta atrás al final.

begin;

create table if not exists public.nube_settings (
    id              smallint primary key default 1 check (id = 1),
    trial_days      integer not null default 15 check (trial_days between 1 and 90),
    trial_max_cajas integer not null default 2  check (trial_max_cajas between 1 and 20),
    updated_at      timestamptz not null default now()
);
comment on table public.nube_settings is
    'Ajustes globales de la Nube (una fila). Solo service_role (Estación) lee y escribe; create_account los lee.';

insert into public.nube_settings (id) values (1) on conflict (id) do nothing;

-- Nadie fuera de service_role: ni el dueño ni los equipos leen ni escriben aquí.
alter table public.nube_settings enable row level security;
revoke all on public.nube_settings from anon, authenticated;

-- El dueño crea su negocio, su primera sede y su usuario con PIN.
-- Licencia inicial: prueba con los días y cajas de nube_settings y 1 sede.
-- (Misma función que en 012, solo cambia la licencia inicial.)
create or replace function public.create_account(p_name text, p_sede_name text, p_owner_name text, p_owner_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
    v_uid uuid := auth.uid();
    v_account uuid;
    v_days integer;
    v_cajas integer;
begin
    if v_uid is null then raise exception 'Inicia sesión con tu correo' using errcode = '42501'; end if;
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        raise exception 'Solo el dueño, con su correo, puede crear la cuenta' using errcode = '42501';
    end if;
    select id into v_account from public.accounts where owner_user_id = v_uid;
    if v_account is not null then return v_account; end if;  -- reintento: ya existe (G7)

    perform public.nube_validate_pin(p_owner_pin, 'dueno');

    -- Sin fila de ajustes (no debería pasar) se usan los valores de siempre.
    select trial_days, trial_max_cajas into v_days, v_cajas from public.nube_settings where id = 1;
    v_days  := coalesce(v_days, 15);
    v_cajas := coalesce(v_cajas, 2);

    insert into public.accounts (name, owner_user_id) values (btrim(p_name), v_uid) returning id into v_account;
    insert into public.account_licenses (account_id, status, max_cajas, max_sedes, expires_at)
        values (v_account, 'trial', v_cajas, 1, now() + make_interval(days => v_days));
    insert into public.sedes (account_id, name) values (v_account, btrim(coalesce(nullif(p_sede_name, ''), 'Principal')));
    insert into public.account_members (account_id, display_name, role, pin_hash, pin_length, user_id)
        values (v_account, btrim(p_owner_name), 'dueno', crypt(p_owner_pin, gen_salt('bf')), length(p_owner_pin), v_uid);
    return v_account;
end;
$$;

-- PostgREST debe ver la tabla nueva para que la Estación la lea.
notify pgrst, 'reload schema';

commit;

-- ROLLBACK
-- begin;
-- create or replace function public.create_account(...) como en 012 (prueba fija: 2 cajas, 15 días);
-- drop table if exists public.nube_settings;
-- notify pgrst, 'reload schema';
-- commit;
