-- Precios al Día Nube · 016 — Ediciones simultáneas sin pérdidas (S2) y clientes que
-- solo borran el dueño o un administrador (S4). Auditoría de sync del 2026-11-19.
--
-- S2 · Antes: dos cajas editaban el mismo registro y ganaba la última ENTERA (el
-- cambio de la otra se perdía sin aviso). Ahora cada caja manda, por registro, la
-- versión de la que partió (`base_version`). Si la nube ya va por una versión más
-- nueva, se funde por campo: los campos que esta caja cambió respecto de su base
-- ganan; los demás se quedan como están en la nube. Para eso la nube guarda 7 días
-- la versión anterior de cada registro (`account_record_history`): de sobra para
-- el permiso de 72 h sin internet. Sin base (cajas viejas) o con la base ya
-- vencida, sigue ganando la última, como antes.
--
-- S4 · Antes: un cajero podía borrar clientes (p. ej. guardando una lista vieja) y
-- desaparecían de todas las cajas. Ahora el borrado de un cliente por un cajero no
-- se aplica: el registro se vuelve a publicar (versión nueva) para que su caja lo
-- recupere, y la respuesta lo marca como `rejected`.
--
-- push_records_v2 devuelve además `merged` (se fundió), `rejected` (S4) y `data` (solo
-- si se fundió: lo que quedó en la nube, para que la caja lo muestre sin esperar a
-- bajarlo). `push_records` queda como envoltorio con su forma de siempre, para las
-- cajas con la app vieja (sin base: gana la última, pero S4 también las cubre).
--
-- Idempotente. Vuelta atrás al final.

create table if not exists public.account_record_history (
    account_id  uuid not null,
    collection  text not null,
    id          text not null,
    version     integer not null,
    data        jsonb not null,
    saved_at    timestamptz not null default now(),
    primary key (account_id, collection, id, version),
    foreign key (account_id, collection, id)
        references public.account_records (account_id, collection, id) on delete cascade
);
alter table public.account_record_history enable row level security;
revoke all on public.account_record_history from anon, authenticated;

-- Guarda la versión que se reemplaza (no la caja: cada caja escribe solo lo suyo).
create or replace function nube_private.save_record_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if old.collection = 'cash' or old.version is not distinct from new.version then
        return null;
    end if;
    insert into public.account_record_history (account_id, collection, id, version, data)
    values (old.account_id, old.collection, old.id, old.version, old.data)
    on conflict do nothing;
    delete from public.account_record_history h
     where h.account_id = old.account_id and h.collection = old.collection and h.id = old.id
       and h.saved_at < now() - interval '7 days';
    return null;
end;
$$;

drop trigger if exists account_records_history on public.account_records;
create trigger account_records_history after update on public.account_records
    for each row execute function nube_private.save_record_history();

-- Fusión de tres vías por campo (primer nivel del objeto).
create or replace function nube_private.merge_record_3way(p_base jsonb, p_theirs jsonb, p_mine jsonb)
returns jsonb language sql immutable as $$
    select coalesce(jsonb_object_agg(k, v) filter (where v is not null), '{}'::jsonb)
    from (
        select k, case when (p_mine -> k) is distinct from (p_base -> k) then p_mine -> k else p_theirs -> k end as v
        from (
            select jsonb_object_keys(p_base) as k
            union select jsonb_object_keys(p_theirs)
            union select jsonb_object_keys(p_mine)
        ) keys
    ) merged;
$$;

create or replace function public.push_records_v2(p_session uuid, p_collection text, p_records jsonb)
returns table (id text, version integer, updated_at timestamptz, merged boolean, rejected boolean, data jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid;
    v_role text;
    v_member uuid;
    v_device text;
    v_rec jsonb;
    v_data jsonb;
    v_id text;
    v_deleted boolean;
    v_base integer;
    v_base_data jsonb;
    v_cur_version integer;
    v_cur_data jsonb;
    v_merged boolean;
    v_owner_device text;
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

    if p_collection not in ('products', 'customers', 'suppliers', 'payment_methods', 'settings', 'cash') then
        raise exception 'Colección inválida' using errcode = '22023';
    end if;
    if p_collection not in ('customers', 'cash') and v_role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador pueden cambiar esto' using errcode = '42501';
    end if;
    if p_collection = 'cash' and v_device is null then
        raise exception 'Los registros de caja se suben desde una caja registrada' using errcode = '42501';
    end if;
    if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
        raise exception 'Envía de 0 a 500 registros por vez' using errcode = '22023';
    end if;

    for v_rec in select * from jsonb_array_elements(p_records) loop
        v_id := coalesce(v_rec ->> 'id', '');
        if v_id = '' then raise exception 'Registro sin id' using errcode = '22023'; end if;
        v_data := nube_private.strip_ledger_fields(p_collection, coalesce(v_rec -> 'data', '{}'::jsonb));
        if jsonb_typeof(v_data) <> 'object' then raise exception 'Registro inválido' using errcode = '22023'; end if;
        if pg_column_size(v_data) > 100000 then
            raise exception 'El registro % es demasiado grande (¿imagen incrustada?)', v_id using errcode = '22023';
        end if;
        v_deleted := coalesce((v_rec ->> 'deleted')::boolean, false);
        v_base := case when jsonb_typeof(v_rec -> 'base_version') = 'number' then (v_rec ->> 'base_version')::integer end;
        v_merged := false;

        if p_collection = 'cash' then
            select r.updated_by_device into v_owner_device from public.account_records r
             where r.account_id = v_account and r.collection = 'cash' and r.id = v_id;
            if v_owner_device is not null and v_owner_device <> v_device then
                raise exception 'Ese registro de caja es de otra caja' using errcode = '42501';
            end if;
        end if;

        -- S4: un cajero no borra clientes. Se republica el registro para que su caja
        -- lo recupere (si no existe en la nube, no hay nada que recuperar).
        if p_collection = 'customers' and v_deleted and v_role not in ('dueno', 'administrador') then
            return query
            update public.account_records r
               set version = r.version + 1, updated_at = now()
             where r.account_id = v_account and r.collection = 'customers' and r.id = v_id
            returning r.id, r.version, r.updated_at, false, true, null::jsonb;
            if not found then
                return query select v_id, 0, now(), false, true, null::jsonb;
            end if;
            continue;
        end if;

        -- S2: la caja partió de una versión vieja → fundir por campo con la de la nube.
        if not v_deleted and v_base is not null then
            select r.version, r.data into v_cur_version, v_cur_data
              from public.account_records r
             where r.account_id = v_account and r.collection = p_collection and r.id = v_id
             for update;
            if found and v_cur_version > v_base then
                select h.data into v_base_data from public.account_record_history h
                 where h.account_id = v_account and h.collection = p_collection and h.id = v_id and h.version = v_base;
                if found then
                    v_data := nube_private.merge_record_3way(v_base_data, v_cur_data, v_data);
                    v_merged := true;
                end if;
            end if;
        end if;

        return query
        insert into public.account_records as r (account_id, collection, id, data, deleted_at, updated_by_device, updated_by_member)
        values (v_account, p_collection, v_id, v_data, case when v_deleted then now() end, v_device, v_member)
        on conflict (account_id, collection, id) do update
            set data = excluded.data,
                deleted_at = excluded.deleted_at,
                version = r.version + 1,
                updated_at = now(),
                updated_by_device = excluded.updated_by_device,
                updated_by_member = excluded.updated_by_member
        returning r.id, r.version, r.updated_at, v_merged, false, case when v_merged then r.data end;
    end loop;
end;
$$;

-- La forma de siempre (la usan las cajas con la app anterior a esta migración).
create or replace function public.push_records(p_session uuid, p_collection text, p_records jsonb)
returns table (id text, version integer, updated_at timestamptz)
language sql set search_path = public as $$
    select r.id, r.version, r.updated_at from public.push_records_v2(p_session, p_collection, p_records) r;
$$;

revoke all on function public.push_records_v2(uuid, text, jsonb) from public, anon;
grant execute on function public.push_records_v2(uuid, text, jsonb) to authenticated;
revoke all on function public.push_records(uuid, text, jsonb) from public, anon;
grant execute on function public.push_records(uuid, text, jsonb) to authenticated;
revoke all on function nube_private.save_record_history(), nube_private.merge_record_3way(jsonb, jsonb, jsonb)
    from public, anon, authenticated;

-- ROLLBACK
-- (volver a aplicar push_records de 007)
-- drop function if exists public.push_records_v2(uuid, text, jsonb);
-- drop trigger if exists account_records_history on public.account_records;
-- drop function if exists nube_private.save_record_history(), nube_private.merge_record_3way(jsonb, jsonb, jsonb);
-- drop table if exists public.account_record_history;
