-- Precios al Día Nube / LAN · 020 — Proveedores, Nómina y Compras Multi-Caja (Ola 4 · T20/T21/T22).
--
-- Cierra:
--   · ALT-15 (Proveedores): facturas (`supplier_invoices`) + libro append-only
--     `supplier_movements` + `supplier_balances` + RPC `push_supplier_movements` +
--     strip de `deuda` en `suppliers` (anti-LWW).
--   · ALT-14 (Nómina): colecciones `employees` y `payroll_entries` en `account_records`.
--   · ALT-16 (Compras de mercancía): colección `purchases` en `account_records`.
--
-- Idempotente.

-- ─── 1. Extender colecciones permitidas y strip_ledger_fields ────────────────

alter table public.account_records drop constraint if exists account_records_collection_check;
alter table public.account_records add constraint account_records_collection_check
    check (collection in (
        'products', 'customers', 'suppliers', 'supplier_invoices',
        'payment_methods', 'settings', 'cash', 'cashea',
        'employees', 'payroll_entries', 'purchases'
    ));

create or replace function nube_private.strip_ledger_fields(p_collection text, p_data jsonb)
returns jsonb language sql immutable as $$
    select case p_collection
        when 'products'  then p_data - array['stock', 'stockInLotes', 'stockAsOf', 'stockBefore', 'stockAfter']
        when 'customers' then p_data - array['deuda', 'favor', 'saldo', 'balance', 'creditBalance', 'casheaDeuda']
        when 'suppliers' then p_data - array['deuda']
        else p_data
    end;
$$;

-- Actualizar push_records_v2 para aceptar las 4 colecciones nuevas (solo dueño/admin).
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
        'employees', 'payroll_entries', 'purchases'
    ) then
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

-- ─── 2. Libro append-only de proveedores (supplier_movements + supplier_balances) ─

create table if not exists public.supplier_movements (
    id              text primary key,
    seq             bigserial not null,
    account_id      uuid not null references public.accounts(id) on delete cascade,
    supplier_id     text not null,
    type            text not null check (type in (
                        'FACTURA', 'PAGO', 'AJUSTE_DEBITO', 'AJUSTE_CREDITO',
                        'ANULACION_PAGO', 'SALDO_INICIAL_MIGRADO'
                    )),
    direction       text not null check (direction in ('DEBIT', 'CREDIT')),
    amount_usd      numeric(14, 2) not null check (amount_usd >= 0),
    debt_after      numeric(14, 2) not null,
    invoice_id      text,
    source_id       text,
    reason          text,
    sede_id         uuid references public.sedes(id),
    device_id       text references public.account_devices(id),
    member_id       uuid references public.account_members(id),
    device_at       timestamptz,
    server_at       timestamptz not null default now()
);

create index if not exists supplier_movements_account_seq_idx
    on public.supplier_movements (account_id, seq);
create index if not exists supplier_movements_account_server_at_idx
    on public.supplier_movements (account_id, server_at);
create index if not exists supplier_movements_supplier_idx
    on public.supplier_movements (account_id, supplier_id, seq);

create table if not exists public.supplier_balances (
    account_id      uuid not null references public.accounts(id) on delete cascade,
    supplier_id     text not null,
    debt_usd        numeric(14, 2) not null default 0,
    updated_at      timestamptz not null default now(),
    primary key (account_id, supplier_id)
);

create index if not exists supplier_balances_updated_idx
    on public.supplier_balances (account_id, updated_at);

alter table public.supplier_movements enable row level security;
alter table public.supplier_balances  enable row level security;

drop policy if exists supplier_movements_read on public.supplier_movements;
create policy supplier_movements_read on public.supplier_movements for select to authenticated
    using (account_id = nube_private.my_account_id());

drop policy if exists supplier_balances_read on public.supplier_balances;
create policy supplier_balances_read on public.supplier_balances for select to authenticated
    using (account_id = nube_private.my_account_id());

grant select on public.supplier_movements, public.supplier_balances to authenticated;
revoke insert, update, delete on public.supplier_movements, public.supplier_balances from public, anon, authenticated;

-- RPC atómica e idempotente para registrar movimientos de deuda de proveedores (solo dueño/admin).
create or replace function public.push_supplier_movements(p_session uuid, p_movements jsonb)
returns table (id text, supplier_id text, debt_after numeric, already_registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text; v_sede uuid;
    v_m jsonb; v_id text; v_sup text; v_type text; v_dir text; v_amount numeric; v_debt numeric;
    v_existing public.supplier_movements;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role, c.device_id, c.sede_id
          into v_account, v_member, v_role, v_device, v_sede
          from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un administrador pueden mover cuentas de proveedores' using errcode = '42501'; end if;
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    if v_role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador pueden mover cuentas de proveedores' using errcode = '42501';
    end if;
    if jsonb_typeof(p_movements) <> 'array' or jsonb_array_length(p_movements) > 500 then
        raise exception 'Envía de 0 a 500 movimientos' using errcode = '22023';
    end if;

    for v_m in select * from jsonb_array_elements(p_movements) loop
        v_id := v_m ->> 'id';
        v_sup := v_m ->> 'supplier_id';
        v_type := v_m ->> 'type';
        v_amount := round((v_m ->> 'amount_usd')::numeric, 2);
        if coalesce(v_id, '') = '' or coalesce(v_sup, '') = '' or v_type is null or v_amount is null or v_amount < 0 then
            raise exception 'Movimiento de proveedor inválido' using errcode = '22023';
        end if;

        select * into v_existing from public.supplier_movements sm where sm.id = v_id;
        if found then
            if v_existing.account_id <> v_account then raise exception 'Movimiento de otra cuenta' using errcode = '42501'; end if;
            return query select v_existing.id, v_existing.supplier_id, v_existing.debt_after, true;
            continue;
        end if;

        -- DEBIT = aumenta deuda con el proveedor; CREDIT = reduce deuda (pago/abono/eliminación).
        v_dir := coalesce(v_m ->> 'direction', case
            when v_type in ('FACTURA', 'AJUSTE_DEBITO', 'ANULACION_PAGO', 'SALDO_INICIAL_MIGRADO') then 'DEBIT'
            when v_type in ('PAGO', 'AJUSTE_CREDITO') then 'CREDIT'
        end);
        if v_dir is null then raise exception 'Dirección de movimiento de proveedor inválida' using errcode = '22023'; end if;

        insert into public.supplier_balances (account_id, supplier_id, debt_usd)
        values (v_account, v_sup, 0) on conflict do nothing;

        select b.debt_usd into v_debt from public.supplier_balances b
         where b.account_id = v_account and b.supplier_id = v_sup for update;

        v_debt := round(v_debt + case when v_dir = 'DEBIT' then v_amount else -v_amount end, 2);
        update public.supplier_balances b set debt_usd = v_debt, updated_at = now()
         where b.account_id = v_account and b.supplier_id = v_sup;

        insert into public.supplier_movements (
            id, account_id, supplier_id, type, direction, amount_usd, debt_after,
            invoice_id, source_id, reason, sede_id, device_id, member_id, device_at
        ) values (
            v_id, v_account, v_sup, v_type, v_dir, v_amount, v_debt,
            v_m ->> 'invoice_id', v_m ->> 'source_id', left(v_m ->> 'reason', 300),
            v_sede, v_device, v_member, (v_m ->> 'device_at')::timestamptz
        );

        return query select v_id, v_sup, v_debt, false;
    end loop;
end;
$$;

grant execute on function public.push_supplier_movements(uuid, jsonb) to authenticated;

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        begin
            alter publication supabase_realtime add table public.supplier_balances;
        exception when duplicate_object then null;
        end;
    end if;
exception when others then null;
end $$;
