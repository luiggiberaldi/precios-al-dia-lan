-- Precios al Día Nube · F1 — Los ayudantes de «quién soy» salen de la API.
--
-- Hallazgo del asesor de seguridad de Supabase tras aplicar 001: en Supabase el rol
-- `authenticated` recibe EXECUTE por defecto en las funciones de `public`, así que
-- nube_owner_account_id(), nube_current_device() y nube_my_account_id() quedaban
-- expuestas como /rest/v1/rpc/… Las RLS ahora usan copias en el esquema
-- `nube_private`, que PostgREST no publica, y las de `public` dejan de ser ejecutables
-- por la app (las RPC SECURITY DEFINER siguen usándolas con los permisos del dueño
-- de la función).
--
-- Idempotente. Vuelta atrás al final.

create schema if not exists nube_private;
revoke all on schema nube_private from public, anon;
grant usage on schema nube_private to authenticated;

create or replace function nube_private.owner_account_id()
returns uuid language sql stable security definer set search_path = public as $$
    select a.id from public.accounts a where a.owner_user_id = auth.uid();
$$;

create or replace function nube_private.device_account_id()
returns uuid language sql stable security definer set search_path = public as $$
    select d.account_id from public.account_devices d
    where d.auth_user_id = auth.uid() and d.revoked_at is null;
$$;

create or replace function nube_private.my_account_id()
returns uuid language sql stable security definer set search_path = public as $$
    select coalesce(nube_private.owner_account_id(), nube_private.device_account_id());
$$;

revoke all on function nube_private.owner_account_id(), nube_private.device_account_id(),
    nube_private.my_account_id() from public, anon;
grant execute on function nube_private.my_account_id() to authenticated;

drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated
    using (id = nube_private.my_account_id());

drop policy if exists licenses_read on public.account_licenses;
create policy licenses_read on public.account_licenses for select to authenticated
    using (account_id = nube_private.my_account_id());

drop policy if exists sedes_read on public.sedes;
create policy sedes_read on public.sedes for select to authenticated
    using (account_id = nube_private.my_account_id());

drop policy if exists members_read on public.account_members;
create policy members_read on public.account_members for select to authenticated
    using (account_id = nube_private.my_account_id());

drop policy if exists devices_read on public.account_devices;
create policy devices_read on public.account_devices for select to authenticated
    using (account_id = nube_private.my_account_id());

-- Los ayudantes de public ya no se llaman desde la app.
revoke execute on function public.nube_owner_account_id(), public.nube_current_device(),
    public.nube_my_account_id(), public.nube_validate_pin(text, text) from authenticated;

alter function public.nube_validate_pin(text, text) set search_path = public;

comment on table public.member_sessions is
    'Sesiones de PIN. Sin política RLS a propósito: solo las leen funciones SECURITY DEFINER.';

-- ROLLBACK
-- grant execute on function public.nube_my_account_id() to authenticated;
-- (recrear las políticas de 001 con public.nube_my_account_id())
-- drop schema if exists nube_private cascade;
