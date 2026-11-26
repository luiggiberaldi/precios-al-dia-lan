-- Precios al Día Nube · Reinicio de fábrica de la cuenta.
--
-- El dueño, con su sesión de CORREO (nunca un administrador, un cajero ni una sesión de
-- PIN, que corren en la sesión anónima del equipo), vacía los datos de su negocio en
-- TODAS las cajas de una sola vez:
--
--   se borra   catálogo, clientes, proveedores, categorías y demás ajustes, registros de
--              caja (`cash`), libro de ventas, stock (niveles y libro), diferencias de
--              stock, cartera (saldos y libro) y la numeración de ventas (vuelve a #A-00001);
--   se conserva la cuenta, la licencia, las sedes, los equipos registrados, los empleados
--              con sus PIN, los métodos de pago y la tasa del día (`settings/pdn_rate_v1`).
--
-- Auditoría: antes de borrar, cada fila se copia tal cual (jsonb) a
-- nube_private.account_reset_archive y queda una línea en nube_private.account_resets
-- (quién, cuándo, cuántas filas). PostgREST no publica nube_private.
--
-- Los libros de stock y de clientes no se dejan editar ni borrar (005, 006). Sus triggers
-- ahora dejan pasar el borrado SOLO de la cuenta que la transacción marcó con
-- set_config('nube.reset_account', <cuenta>, true). Eso lo hace únicamente reset_account():
-- la app no tiene permiso DELETE en esas tablas (todo va por RPC, G8).
--
-- Contra la resurrección: el reinicio cierra TODAS las sesiones de PIN de la cuenta. Lo que
-- una caja tenga en cola (registros, ventas sin internet, ajustes de stock, cartera) lo
-- rechaza el servidor («Tu sesión venció») hasta que la caja se limpie. Cada caja compara
-- `accounts.reset_epoch` con la última época que vio y, si subió, vacía su copia local y
-- su cola antes de volver a entrar (src/nube/accountReset.js).
--
-- Idempotente. Vuelta atrás al final.

alter table public.accounts add column if not exists reset_epoch integer not null default 0;
alter table public.accounts add column if not exists reset_at timestamptz;
comment on column public.accounts.reset_epoch is
    'Sube en 1 con cada reinicio de fábrica; cada caja vacía su copia local si la suya es menor.';

create table if not exists nube_private.account_resets (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references public.accounts(id) on delete cascade,
    epoch       integer not null,
    by_user_id  uuid not null,
    at          timestamptz not null default now(),
    counts      jsonb not null default '{}'::jsonb
);

create table if not exists nube_private.account_reset_archive (
    reset_id    uuid not null references nube_private.account_resets(id) on delete cascade,
    table_name  text not null,
    row_data    jsonb not null
);
create index if not exists account_reset_archive_reset on nube_private.account_reset_archive (reset_id, table_name);

revoke all on nube_private.account_resets, nube_private.account_reset_archive from public, anon, authenticated;
grant select on nube_private.account_resets, nube_private.account_reset_archive to service_role;

-- ─── Los libros dejan pasar el borrado del reinicio (solo esa cuenta) ────────

create or replace function nube_private.reject_ledger_change()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'DELETE' and current_setting('nube.reset_account', true) = old.account_id::text then
        return old;
    end if;
    raise exception 'El libro de stock no se edita ni se borra: registra un movimiento inverso.' using errcode = '42501';
end;
$$;

create or replace function nube_private.reject_customer_ledger_change()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'DELETE' and current_setting('nube.reset_account', true) = old.account_id::text then
        return old;
    end if;
    raise exception 'El libro de clientes no se edita ni se borra: registra una ANULACION.' using errcode = '42501';
end;
$$;

-- ─── RPC ─────────────────────────────────────────────────────────────────────

-- p_confirm debe ser 'REINICIAR' (la pantalla lo manda tras la confirmación del dueño):
-- una llamada suelta o equivocada no borra nada.
create or replace function public.reset_account(p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    v_uid uuid := auth.uid();
    v_account uuid := nube_private.owner_account_id();
    v_epoch integer;
    v_reset uuid;
    v_counts jsonb := '{}'::jsonb;
    v_n integer;
begin
    if v_uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) or v_account is null then
        raise exception 'Solo el dueño, con su correo y contraseña, puede reiniciar la cuenta' using errcode = '42501';
    end if;
    if p_confirm is distinct from 'REINICIAR' then
        raise exception 'Falta la confirmación del reinicio' using errcode = '22023';
    end if;

    -- Un reinicio a la vez por cuenta.
    select a.reset_epoch + 1 into v_epoch from public.accounts a where a.id = v_account for update;

    -- Primero se cierran las sesiones de PIN: desde aquí ninguna caja puede subir nada.
    update public.member_sessions s set ended_at = now()
      from public.account_members m
     where s.member_id = m.id and m.account_id = v_account and s.ended_at is null;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('member_sessions_ended', v_n);

    insert into nube_private.account_resets (account_id, epoch, by_user_id)
    values (v_account, v_epoch, v_uid) returning id into v_reset;

    perform set_config('nube.reset_account', v_account::text, true);

    -- Registros: todo menos los métodos de pago y la tasa del día.
    with gone as (
        delete from public.account_records r
         where r.account_id = v_account
           and r.collection <> 'payment_methods'
           and not (r.collection = 'settings' and r.id = 'pdn_rate_v1')
        returning r.*
    ), arch as (
        insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
        select v_reset, 'account_records', to_jsonb(g) from gone g returning 1
    ) select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('account_records', v_n);

    with gone as (delete from public.stock_discrepancies t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'stock_discrepancies', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('stock_discrepancies', v_n);

    with gone as (delete from public.sales t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'sales', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('sales', v_n);

    with gone as (delete from public.stock_movements t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'stock_movements', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('stock_movements', v_n);

    with gone as (delete from public.stock_levels t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'stock_levels', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('stock_levels', v_n);

    with gone as (delete from public.customer_movements t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'customer_movements', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('customer_movements', v_n);

    with gone as (delete from public.customer_balances t where t.account_id = v_account returning t.*),
         arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                  select v_reset, 'customer_balances', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('customer_balances', v_n);

    -- La numeración de ventas vuelve a empezar en cada caja.
    with gone as (
        delete from public.device_counters c
         using public.account_devices d
         where c.device_id = d.id and d.account_id = v_account
        returning c.*
    ), arch as (insert into nube_private.account_reset_archive (reset_id, table_name, row_data)
                select v_reset, 'device_counters', to_jsonb(g) from gone g returning 1)
    select count(*) into v_n from arch;
    v_counts := v_counts || jsonb_build_object('device_counters', v_n);

    perform set_config('nube.reset_account', '', true);

    update public.accounts set reset_epoch = v_epoch, reset_at = now() where id = v_account;
    update nube_private.account_resets set counts = v_counts where id = v_reset;

    -- Aviso por Realtime a todas las cajas (account_sync_state, ~100 bytes).
    insert into public.account_sync_state (account_id, collection, changed_at)
    values (v_account, 'reset', now())
    on conflict (account_id, collection) do update set changed_at = excluded.changed_at;

    return jsonb_build_object('epoch', v_epoch, 'reset_id', v_reset, 'counts', v_counts);
end;
$$;

revoke all on function public.reset_account(text) from public, anon;
grant execute on function public.reset_account(text) to authenticated;

-- ROLLBACK
-- drop function if exists public.reset_account(text);
-- (recrear nube_private.reject_ledger_change() de 005 y nube_private.reject_customer_ledger_change() de 006)
-- drop table if exists nube_private.account_reset_archive, nube_private.account_resets;
-- alter table public.accounts drop column if exists reset_at, drop column if exists reset_epoch;
