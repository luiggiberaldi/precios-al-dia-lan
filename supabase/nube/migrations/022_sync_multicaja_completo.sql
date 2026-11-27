-- Precios al Día Nube / LAN · 022 — Sincronización completa multi-caja (ventas en espera, bitácora y avisos Realtime).
--
-- Cierra:
--   · Colecciones `holds` (ventas en espera, `bodega_pending_holds_v1`) y `audit`
--     (bitácora de actividad, `abasto_audit_log_v1`) en `account_records` / `push_records_v2`.
--     Un cajero puede registrar ventas en espera y entradas de bitácora, pero solo el
--     dueño o un administrador pueden borrar la bitácora.
--   · Publicación Realtime de `account_licenses`, `sedes` y `stock_discrepancies`.
--
-- Idempotente.

-- ─── 1. Extender colecciones permitidas en account_records y push_records_v2 ──

alter table public.account_records drop constraint if exists account_records_collection_check;
alter table public.account_records add constraint account_records_collection_check
    check (collection in (
        'products', 'customers', 'suppliers', 'supplier_invoices',
        'payment_methods', 'settings', 'cash', 'cashea',
        'employees', 'payroll_entries', 'purchases',
        'holds', 'audit'
    ));

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
    v_cur_deleted timestamptz;
    v_cur_updated timestamptz;
    v_merged boolean;
    v_owner_device text;
    v_balance numeric;
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

    if p_collection not in (
        'products', 'customers', 'suppliers', 'supplier_invoices',
        'payment_methods', 'settings', 'cash', 'cashea',
        'employees', 'payroll_entries', 'purchases',
        'holds', 'audit'
    ) then
        raise exception 'Colección inválida' using errcode = '22023';
    end if;
    if p_collection not in ('customers', 'cash', 'cashea', 'holds', 'audit') and v_role not in ('dueno', 'administrador') then
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

        if p_collection = 'audit' and v_deleted and v_role not in ('dueno', 'administrador') then
            select r.version, r.updated_at, r.deleted_at
              into v_cur_version, v_cur_updated, v_cur_deleted
              from public.account_records r
             where r.account_id = v_account and r.collection = 'audit' and r.id = v_id
             for update;
            if found and v_cur_deleted is not null then
                return query select v_id, v_cur_version, v_cur_updated, false, false, null::jsonb;
                continue;
            end if;
            return query
            update public.account_records r
               set version = r.version + 1, updated_at = now()
             where r.account_id = v_account and r.collection = 'audit' and r.id = v_id and r.deleted_at is null
            returning r.id, r.version, r.updated_at, false, true, null::jsonb;
            if not found then
                return query select v_id, 0, now(), false, true, null::jsonb;
            end if;
            continue;
        end if;

        if p_collection = 'customers' and v_deleted and v_role not in ('dueno', 'administrador') then
            select r.version, r.updated_at, r.deleted_at
              into v_cur_version, v_cur_updated, v_cur_deleted
              from public.account_records r
             where r.account_id = v_account and r.collection = 'customers' and r.id = v_id
             for update;
            if found and v_cur_deleted is not null then
                return query select v_id, v_cur_version, v_cur_updated, false, false, null::jsonb;
                continue;
            end if;
            return query
            update public.account_records r
               set version = r.version + 1, updated_at = now()
             where r.account_id = v_account and r.collection = 'customers' and r.id = v_id and r.deleted_at is null
            returning r.id, r.version, r.updated_at, false, true, null::jsonb;
            if not found then
                return query select v_id, 0, now(), false, true, null::jsonb;
            end if;
            continue;
        end if;

        if p_collection = 'customers' and v_deleted then
            select coalesce((
                select b.balance_usd from public.customer_balances b
                 where b.account_id = v_account and b.customer_id = v_id
            ), 0) into v_balance;
            if abs(v_balance) > 0.005 then
                return query
                update public.account_records r
                   set version = r.version + 1, updated_at = now()
                 where r.account_id = v_account and r.collection = 'customers' and r.id = v_id and r.deleted_at is null
                returning r.id, r.version, r.updated_at, false, true, null::jsonb;
                if not found then
                    return query select v_id, 0, now(), false, true, null::jsonb;
                end if;
                continue;
            end if;
        end if;

        if not v_deleted and v_base is not null then
            select r.version, r.data into v_cur_version, v_cur_data
              from public.account_records r
             where r.account_id = v_account
               and r.collection = p_collection
               and r.id = v_id
               and r.deleted_at is null
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

-- ─── 2. Publicar account_licenses, sedes, stock_discrepancies, account_devices y account_members en Realtime ──

do $$ begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_licenses'
        ) then
            alter publication supabase_realtime add table public.account_licenses;
        end if;
        if not exists (
            select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sedes'
        ) then
            alter publication supabase_realtime add table public.sedes;
        end if;
        if not exists (
            select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_discrepancies'
        ) then
            alter publication supabase_realtime add table public.stock_discrepancies;
        end if;
        if not exists (
            select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_devices'
        ) then
            alter publication supabase_realtime add table public.account_devices;
        end if;
        if not exists (
            select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_members'
        ) then
            alter publication supabase_realtime add table public.account_members;
        end if;
    end if;
end $$;
