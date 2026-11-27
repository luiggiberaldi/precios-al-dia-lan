-- Precios al Día Nube / LAN · 019 — Integridad multi-caja (Ola 1 · T04).
--
-- Cierra:
--   · C11 (anti-zombi): push_records_v2 NO ejecuta merge_record_3way contra una fila
--     borrada (`deleted_at is not null`), evitando revivir objetos incompletos sin name/category.
--   · C9 (borrado con saldo): push_records_v2 rechaza borrar un cliente si su saldo en
--     `customer_balances` es distinto de 0 (|balance_usd| > 0.005), republicándolo.
--   · BAJ-01 (S4): si un cajero envía deleted=true para un cliente YA borrado por un
--     administrador, no se reporta rechazo falso ni se republica.
--   · A8 (roles cartera): push_customer_movements exige dueño o administrador para
--     AJUSTE_CREDITO, AJUSTE_DEBITO, ANULACION y SALDO_INICIAL_MIGRADO.
--   · C8 (idempotencia migración): dos cajas enviando SALDO_INICIAL_MIGRADO con UUID
--     distinto para el mismo cliente se tratan como idempotentes (no duplican deuda).
--   · C4 (process_void atómico): anular una venta revierte también customer_movements /
--     customer_balances, marca status='ANULADA' en account_records(collection='cash') y
--     toca account_sync_state('cash_voids') para notificar a las cajas.
--   · A1 (cash_records_range): índice y RPC para consultar ventas/movimientos de caja por
--     rango de fechas y equipo sin tope de 20,000 filas ordenadas por UUID.
--
-- Idempotente. Vuelta atrás al final.

-- ─── 0. Colección `cashea` aditiva y protección de `casheaDeuda` (C9 / T11) ──

alter table public.account_records drop constraint if exists account_records_collection_check;
alter table public.account_records add constraint account_records_collection_check
    check (collection in ('products', 'customers', 'suppliers', 'payment_methods', 'settings', 'cash', 'cashea'));

create or replace function nube_private.strip_ledger_fields(p_collection text, p_data jsonb)
returns jsonb language sql immutable as $$
    select case p_collection
        when 'products'  then p_data - array['stock', 'stockInLotes', 'stockAsOf', 'stockBefore', 'stockAfter']
        when 'customers' then p_data - array['deuda', 'favor', 'saldo', 'balance', 'creditBalance', 'casheaDeuda']
        else p_data
    end;
$$;

-- ─── 1. push_records_v2 endurecido (C11, C9, BAJ-01) ─────────────────────────

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

    if p_collection not in ('products', 'customers', 'suppliers', 'payment_methods', 'settings', 'cash', 'cashea') then
        raise exception 'Colección inválida' using errcode = '22023';
    end if;
    if p_collection not in ('customers', 'cash', 'cashea') and v_role not in ('dueno', 'administrador') then
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

        -- S4 + BAJ-01: un cajero no borra clientes vivos. Si ya estaba borrado por un
        -- administrador (`deleted_at is not null`), se confirma sin falso rechazo.
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

        -- C9: nadie (ni dueño/admin) puede borrar un cliente con saldo pendiente en cartera.
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

        -- S2 + C11: fundir por campo SOLO si el registro sigue vivo (`deleted_at is null`).
        -- Si fue borrado en otra caja (`data = {"id": id}`), NO hacer merge contra el stub
        -- de borrado para no crear objetos zombi sin name/category.
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

-- ─── 2. push_customer_movements con roles (A8) e idempotencia migración (C8) ─

create or replace function public.push_customer_movements(p_session uuid, p_movements jsonb)
returns table (id text, customer_id text, balance_after numeric, already_registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text; v_sede uuid;
    v_m jsonb; v_id text; v_cust text; v_type text; v_dir text; v_amount numeric; v_balance numeric;
    v_source_type text; v_source_id text;
    v_existing public.customer_movements;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role, c.device_id, c.sede_id
          into v_account, v_member, v_role, v_device, v_sede
          from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión' using errcode = '42501'; end if;
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    if jsonb_typeof(p_movements) <> 'array' or jsonb_array_length(p_movements) > 500 then
        raise exception 'Envía de 0 a 500 movimientos' using errcode = '22023';
    end if;

    for v_m in select * from jsonb_array_elements(p_movements) loop
        v_id := v_m ->> 'id';
        v_cust := v_m ->> 'customer_id';
        v_type := v_m ->> 'type';
        v_amount := round((v_m ->> 'amount_usd')::numeric, 2);
        v_source_type := v_m ->> 'source_type';
        v_source_id := v_m ->> 'source_id';
        if coalesce(v_id, '') = '' or coalesce(v_cust, '') = '' or v_type is null or v_amount is null or v_amount < 0 then
            raise exception 'Movimiento de cliente inválido' using errcode = '22023';
        end if;

        -- A8: ajustes administrativos, anulaciones y migraciones solo dueño/administrador.
        if v_type in ('AJUSTE_CREDITO', 'AJUSTE_DEBITO', 'ANULACION', 'SALDO_INICIAL_MIGRADO')
           and v_role not in ('dueno', 'administrador') then
            raise exception 'Solo el dueño o un administrador pueden registrar %', v_type using errcode = '42501';
        end if;

        select * into v_existing from public.customer_movements cm where cm.id = v_id;
        if found then
            if v_existing.account_id <> v_account then raise exception 'Movimiento de otra cuenta' using errcode = '42501'; end if;
            return query select v_existing.id, v_existing.customer_id, v_existing.balance_after, true;
            continue;
        end if;

        v_dir := coalesce(v_m ->> 'direction', case
            when v_type in ('SALDO_INICIAL_MIGRADO', 'ABONO_DEUDA', 'VUELTO_ACREDITADO', 'DEVOLUCION_A_FAVOR', 'AJUSTE_CREDITO') then 'CREDIT'
            when v_type in ('VENTA_FIADA', 'SALDO_FAVOR_USADO', 'AJUSTE_DEBITO') then 'DEBIT'
        end);
        if v_dir is null then raise exception 'La anulación necesita su dirección (CREDIT o DEBIT)' using errcode = '22023'; end if;

        -- Bloqueo de la fila de saldo del cliente: dos cajas a la vez se ordenan aquí (E5).
        insert into public.customer_balances (account_id, customer_id, balance_usd) values (v_account, v_cust, 0) on conflict do nothing;
        select b.balance_usd into v_balance from public.customer_balances b
         where b.account_id = v_account and b.customer_id = v_cust for update;

        -- C8: SALDO_INICIAL_MIGRADO es único por (account_id, customer_id, source_id) o
        -- por (account_id, customer_id) para migraciones sin source_id distinto.
        if v_type = 'SALDO_INICIAL_MIGRADO' then
            select * into v_existing
              from public.customer_movements cm
             where cm.account_id = v_account
               and cm.customer_id = v_cust
               and cm.type = 'SALDO_INICIAL_MIGRADO'
               and (
                   (v_source_id is not null and cm.source_id = v_source_id)
                   or (v_source_id is null and cm.source_id is null)
                   or coalesce(v_source_type, 'MIGRATION') = 'MIGRATION'
               )
             order by cm.seq asc
             limit 1;
            if found then
                return query select v_existing.id, v_existing.customer_id, v_existing.balance_after, true;
                continue;
            end if;
        end if;

        v_balance := v_balance + case when v_dir = 'CREDIT' then v_amount else -v_amount end;
        update public.customer_balances b set balance_usd = v_balance, updated_at = now()
         where b.account_id = v_account and b.customer_id = v_cust;

        insert into public.customer_movements (id, account_id, customer_id, type, direction, amount_usd, balance_after,
            source_type, source_id, source_sale_id, reversal_of, reason, sede_id, device_id, member_id, device_at)
        values (v_id, v_account, v_cust, v_type, v_dir, v_amount, v_balance,
            v_source_type, v_source_id, v_m ->> 'source_sale_id', v_m ->> 'reversal_of', left(v_m ->> 'reason', 300),
            v_sede, v_device, v_member, (v_m ->> 'device_at')::timestamptz);

        return query select v_id, v_cust, v_balance, false;
    end loop;
end;
$$;

-- ─── 3. process_void atómico (stock + cartera + cash + aviso cash_voids, C4) ─

create or replace function public.process_void(p_session uuid, p_sale_id uuid, p_reason text default null)
returns table (sale_id uuid, number text, already_voided boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text;
    v_sale public.sales;
    v_local_id text;
    v_cm record;
    v_rev_dir text;
    v_rev_id text;
    v_balance numeric;
    v_void_iso text;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role, c.device_id
          into v_account, v_member, v_role, v_device
          from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión anulan ventas' using errcode = '42501'; end if;
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    if v_role not in ('dueno', 'administrador') then raise exception 'Solo el dueño o un administrador anulan ventas' using errcode = '42501'; end if;

    select * into v_sale from public.sales where id = p_sale_id and account_id = v_account for update;
    if not found then raise exception 'Venta no encontrada' using errcode = 'P0002'; end if;
    if v_sale.status = 'anulada' then
        return query select v_sale.id, v_sale.number, true;
        return;
    end if;

    v_local_id := nullif(v_sale.payload ->> 'localId', '');
    v_void_iso := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

    update public.sales
       set status = 'anulada', voided_at = now(), voided_by_device = v_device,
           voided_by_member = v_member, void_reason = left(p_reason, 300)
     where id = v_sale.id;

    -- 1. Reversión de stock
    insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason, reference, device_id, member_id, note)
    select gen_random_uuid(), m.account_id, m.sede_id, m.product_id, -m.qty, 'ANULACION', v_sale.id::text,
           v_device, v_member, left(p_reason, 300)
    from public.stock_movements m
    where m.account_id = v_account and m.reference = v_sale.id::text and m.reason = 'VENTA';

    -- 2. C4: Reversión atómica en el libro de clientes (si la venta generó fiado / uso de saldo / vuelto a favor)
    for v_cm in
        select cm.*
          from public.customer_movements cm
         where cm.account_id = v_account
           and cm.type <> 'ANULACION'
           and (
               cm.source_sale_id = v_sale.id::text
               or (v_local_id is not null and cm.source_sale_id = v_local_id)
           )
           and not exists (
               select 1 from public.customer_movements r
                where r.account_id = v_account and r.reversal_of = cm.id
           )
         order by cm.seq asc
    loop
        v_rev_id := left('void-rev:' || v_cm.id, 120);
        if exists (select 1 from public.customer_movements r where r.id = v_rev_id) then
            continue;
        end if;
        v_rev_dir := case when v_cm.direction = 'CREDIT' then 'DEBIT' else 'CREDIT' end;

        insert into public.customer_balances (account_id, customer_id, balance_usd)
        values (v_account, v_cm.customer_id, 0) on conflict do nothing;
        select b.balance_usd into v_balance
          from public.customer_balances b
         where b.account_id = v_account and b.customer_id = v_cm.customer_id
         for update;

        v_balance := v_balance + case when v_rev_dir = 'CREDIT' then v_cm.amount_usd else -v_cm.amount_usd end;
        update public.customer_balances b
           set balance_usd = v_balance, updated_at = now()
         where b.account_id = v_account and b.customer_id = v_cm.customer_id;

        insert into public.customer_movements (
            id, account_id, customer_id, type, direction, amount_usd, balance_after,
            source_type, source_id, source_sale_id, reversal_of, reason,
            sede_id, device_id, member_id, device_at
        ) values (
            v_rev_id, v_account, v_cm.customer_id, 'ANULACION', v_rev_dir, v_cm.amount_usd, v_balance,
            'REVERSAL', v_rev_id, v_cm.source_sale_id, v_cm.id,
            coalesce(left(p_reason, 300), 'Anulación de venta'),
            v_sale.sede_id, v_device, v_member, now()
        );
    end loop;

    -- 3. C4: Marcar ANULADA en account_records(collection='cash') para convergencia multi-caja
    update public.account_records r
       set data = r.data || jsonb_build_object(
               'status', 'ANULADA',
               'voidedAt', v_void_iso,
               'voidReason', coalesce(left(p_reason, 300), '')
           ),
           version = r.version + 1,
           updated_at = now(),
           updated_by_member = v_member
     where r.account_id = v_account
       and r.collection = 'cash'
       and r.deleted_at is null
       and (
           r.id = v_sale.id::text || '@' || v_sale.device_id
           or (v_local_id is not null and r.id = v_local_id || '@' || v_sale.device_id)
           or r.data ->> 'id' = v_sale.id::text
           or (v_local_id is not null and r.data ->> 'id' = v_local_id)
           or r.data -> 'nube' ->> 'saleId' = v_sale.id::text
       );

    -- 4. C4: Notificar a las cajas por account_sync_state('cash_voids')
    insert into public.account_sync_state as s (account_id, collection, changed_at)
    values (v_account, 'cash_voids', now())
    on conflict (account_id, collection) do update set changed_at = excluded.changed_at;

    return query select v_sale.id, v_sale.number, false;
end;
$$;

-- ─── 4. Índice y RPC cash_records_range por fecha y equipo (A1) ──────────────

create index if not exists idx_account_records_cash_updated
    on public.account_records (account_id, updated_at desc)
    where collection = 'cash' and deleted_at is null;

create or replace function public.cash_records_range(
    p_from timestamptz,
    p_to timestamptz,
    p_device_id text default null
)
returns table (
    id text,
    data jsonb,
    version integer,
    updated_at timestamptz,
    updated_by_device text
)
language plpgsql stable security definer set search_path = public as $$
declare
    v_account uuid := nube_private.my_account_id();
begin
    if v_account is null then
        return;
    end if;
    return query
    select r.id, r.data, r.version, r.updated_at, r.updated_by_device
      from public.account_records r
     where r.account_id = v_account
       and r.collection = 'cash'
       and r.deleted_at is null
       and (
           p_device_id is null
           or r.updated_by_device = p_device_id
           or r.id like '%@' || p_device_id
       )
       and (
           (p_from is null or coalesce(
               case when (r.data ->> 'timestamp') ~ '^\d{4}-\d{2}-\d{2}' then (r.data ->> 'timestamp')::timestamptz end,
               r.updated_at
           ) >= p_from)
           and (p_to is null or coalesce(
               case when (r.data ->> 'timestamp') ~ '^\d{4}-\d{2}-\d{2}' then (r.data ->> 'timestamp')::timestamptz end,
               r.updated_at
           ) <= p_to)
       )
     order by r.updated_at desc, r.id desc;
end;
$$;

revoke all on function public.cash_records_range(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.cash_records_range(timestamptz, timestamptz, text) to authenticated;

-- ROLLBACK
-- drop function if exists public.cash_records_range(timestamptz, timestamptz, text);
-- drop index if exists public.idx_account_records_cash_updated;
-- (volver a aplicar push_records_v2 de 016, push_customer_movements de 006 y process_void de 018)
