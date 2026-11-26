-- Precios al Día Nube · F2 — Catálogo, clientes y ajustes en la nube, por registro.
--
-- Una fila por registro (producto, cliente, proveedor, método de pago o ajuste), nunca
-- documentos gigantes (baranda G12). Cada fila guarda el objeto de la app tal cual
-- (`data`), sin los campos que en la nube los maneja un libro:
--   · stock de productos → libro de stock (F3);
--   · deuda y saldo a favor de clientes → libro de clientes (F4).
-- Esos campos los quita la app antes de subir y el servidor los vuelve a quitar.
--
-- Conflictos: gana la última escritura que llega al servidor (catálogo y ajustes).
-- `version` sube en cada cambio para que cada equipo sepa si ya tiene la última.
-- Borrar = marcar `deleted_at` (borrado suave): el equipo lo quita de su copia.
--
-- Avisos baratos: `account_sync_state` guarda una fila por cuenta y colección con la
-- hora del último cambio. Los equipos escuchan ESA tabla por Realtime (≈100 bytes) y
-- bajan solo lo que cambió desde su última vez.
--
-- Idempotente. Vuelta atrás al final.

create table if not exists public.account_records (
    account_id          uuid not null references public.accounts(id) on delete cascade,
    collection          text not null check (collection in ('products', 'customers', 'suppliers', 'payment_methods', 'settings')),
    id                  text not null check (length(id) between 1 and 120),
    data                jsonb not null check (jsonb_typeof(data) = 'object'),
    version             integer not null default 1,
    updated_at          timestamptz not null default now(),
    deleted_at          timestamptz,
    updated_by_device   text references public.account_devices(id),
    updated_by_member   uuid references public.account_members(id),
    primary key (account_id, collection, id)
);
create index if not exists account_records_changes on public.account_records (account_id, collection, updated_at);

create table if not exists public.account_sync_state (
    account_id  uuid not null references public.accounts(id) on delete cascade,
    collection  text not null,
    changed_at  timestamptz not null default now(),
    primary key (account_id, collection)
);

-- Campos que nunca viajan en `data` (los maneja un libro en el servidor).
create or replace function nube_private.strip_ledger_fields(p_collection text, p_data jsonb)
returns jsonb language sql immutable as $$
    select case p_collection
        when 'products'  then p_data - array['stock', 'stockInLotes', 'stockAsOf', 'stockBefore', 'stockAfter']
        when 'customers' then p_data - array['deuda', 'favor', 'saldo', 'balance', 'creditBalance']
        else p_data
    end;
$$;

create or replace function nube_private.touch_sync_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.account_sync_state (account_id, collection, changed_at)
    values (new.account_id, new.collection, now())
    on conflict (account_id, collection) do update set changed_at = excluded.changed_at;
    return null;
end;
$$;

drop trigger if exists account_records_touch on public.account_records;
create trigger account_records_touch after insert or update on public.account_records
    for each row execute function nube_private.touch_sync_state();

alter table public.account_records    enable row level security;
alter table public.account_sync_state enable row level security;
revoke all on public.account_records, public.account_sync_state from anon, authenticated;
grant select on public.account_records, public.account_sync_state to authenticated;

drop policy if exists records_read on public.account_records;
create policy records_read on public.account_records for select to authenticated
    using (account_id = nube_private.my_account_id());

drop policy if exists sync_state_read on public.account_sync_state;
create policy sync_state_read on public.account_sync_state for select to authenticated
    using (account_id = nube_private.my_account_id());

-- Sube registros. Desde una caja: con la sesión de PIN (p_session). Desde el dueño
-- (correo, p. ej. al importar su respaldo): p_session nulo.
-- Clientes: cualquier empleado. Lo demás: dueño o administrador.
-- p_records = [{ "id": "...", "data": {...}, "deleted": false }, ...] (máx. 500 por llamada).
create or replace function public.push_records(p_session uuid, p_collection text, p_records jsonb)
returns table (id text, version integer, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid;
    v_role text;
    v_member uuid;
    v_device text;
    v_rec jsonb;
    v_data jsonb;
begin
    if p_session is not null then
        select m.account_id, m.role, m.id into v_account, v_role, v_member
        from public.nube_session_member(p_session) m where m.id is not null;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
        select d.id into v_device from public.account_devices d where d.auth_user_id = auth.uid() and d.revoked_at is null;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión pueden guardar' using errcode = '42501'; end if;
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;

    if p_collection not in ('products', 'customers', 'suppliers', 'payment_methods', 'settings') then
        raise exception 'Colección inválida' using errcode = '22023';
    end if;
    if p_collection <> 'customers' and v_role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador pueden cambiar esto' using errcode = '42501';
    end if;
    if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
        raise exception 'Envía de 0 a 500 registros por vez' using errcode = '22023';
    end if;

    for v_rec in select * from jsonb_array_elements(p_records) loop
        if coalesce(v_rec ->> 'id', '') = '' then raise exception 'Registro sin id' using errcode = '22023'; end if;
        v_data := nube_private.strip_ledger_fields(p_collection, coalesce(v_rec -> 'data', '{}'::jsonb));
        if jsonb_typeof(v_data) <> 'object' then raise exception 'Registro inválido' using errcode = '22023'; end if;
        if pg_column_size(v_data) > 100000 then
            raise exception 'El registro % es demasiado grande (¿imagen incrustada?)', v_rec ->> 'id' using errcode = '22023';
        end if;

        return query
        insert into public.account_records as r (account_id, collection, id, data, deleted_at, updated_by_device, updated_by_member)
        values (v_account, p_collection, v_rec ->> 'id', v_data,
                case when coalesce((v_rec ->> 'deleted')::boolean, false) then now() end, v_device, v_member)
        on conflict (account_id, collection, id) do update
            set data = excluded.data,
                deleted_at = excluded.deleted_at,
                version = r.version + 1,
                updated_at = now(),
                updated_by_device = excluded.updated_by_device,
                updated_by_member = excluded.updated_by_member
        returning r.id, r.version, r.updated_at;
    end loop;
end;
$$;

revoke all on function public.push_records(uuid, text, jsonb) from public, anon;
grant execute on function public.push_records(uuid, text, jsonb) to authenticated;
revoke all on function nube_private.strip_ledger_fields(text, jsonb), nube_private.touch_sync_state() from public, anon, authenticated;

-- Realtime: solo la tabla de avisos (no la de registros, para cuidar el consumo).
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_sync_state') then
        alter publication supabase_realtime add table public.account_sync_state;
    end if;
end $$;

-- ROLLBACK
-- alter publication supabase_realtime drop table public.account_sync_state;
-- drop function if exists public.push_records(uuid, text, jsonb);
-- drop trigger if exists account_records_touch on public.account_records;
-- drop function if exists nube_private.touch_sync_state(), nube_private.strip_ledger_fields(text, jsonb);
-- drop table if exists public.account_sync_state, public.account_records;
