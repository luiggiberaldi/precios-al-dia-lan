-- Precios al Día Nube / LAN · 023 — Modo "Caja compartida / Gaveta única".
--
-- Permite que 2 o más equipos de una misma cuenta operen sobre un único turno
-- compartido (`shared_cash_shifts`) cuando `pdn_business_config_v1.cash_drawer_mode = 'shared'`.
-- En modo por defecto (`'separate'`), el comportamiento de cajas independientes
-- permanece idéntico.
--
-- Idempotente.

-- ─── 1. Tabla de turnos compartidos (máximo 1 abierto por cuenta) ────────────

create table if not exists public.shared_cash_shifts (
    id text primary key,
    account_id uuid not null references public.accounts(id) on delete cascade,
    status text not null check (status in ('open', 'closed')) default 'open',
    opened_at timestamptz not null default now(),
    opened_by_device_id text,
    opened_by_name text,
    opening_record_id text,
    closed_at timestamptz,
    closed_by_device_id text,
    closed_by_name text,
    close_record_id text,
    updated_at timestamptz not null default now()
);

create unique index if not exists shared_cash_shifts_one_open_per_account
    on public.shared_cash_shifts (account_id)
    where status = 'open';

create index if not exists shared_cash_shifts_account_opened_idx
    on public.shared_cash_shifts (account_id, opened_at desc);

alter table public.shared_cash_shifts enable row level security;

drop policy if exists shared_cash_shifts_select on public.shared_cash_shifts;
create policy shared_cash_shifts_select on public.shared_cash_shifts
    for select to authenticated
    using (
        account_id = nube_private.owner_account_id()
        or exists (
            select 1 from public.account_devices d
             where d.account_id = shared_cash_shifts.account_id
               and d.auth_user_id = auth.uid()
               and d.revoked_at is null
        )
    );

-- ─── 2. Helper privado: ¿la cuenta tiene activo el modo caja compartida? ─────

create or replace function nube_private.is_shared_cash_drawer(p_account uuid)
returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1
          from public.account_records r
         where r.account_id = p_account
           and r.collection = 'settings'
           and r.id = 'pdn_business_config_v1'
           and r.deleted_at is null
           and r.data ->> 'cash_drawer_mode' = 'shared'
    );
$$;

revoke all on function nube_private.is_shared_cash_drawer(uuid) from public, anon, authenticated;

-- ─── 3. Actualizar push_records_v2: permitir editar/anular/cerrar cash entre PCs en modo compartido ──

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
    v_shared_cash boolean;
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

    v_shared_cash := (p_collection = 'cash') and nube_private.is_shared_cash_drawer(v_account);

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
            if v_owner_device is not null and v_owner_device <> v_device and not v_shared_cash then
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
                -- En modo caja compartida, conservar el equipo original que registró la venta/movimiento
                updated_by_device = case
                    when v_shared_cash and r.updated_by_device is not null then r.updated_by_device
                    else excluded.updated_by_device
                end,
                updated_by_member = excluded.updated_by_member
        returning r.id, r.version, r.updated_at, v_merged, false, case when v_merged then r.data end;
    end loop;
end;
$$;

-- ─── 4. RPCs atómicas de turno compartido ────────────────────────────────────

create or replace function public.open_shared_cash_shift(
    p_session uuid,
    p_shift_id text,
    p_opening_record jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_account uuid;
    v_member uuid;
    v_member_name text;
    v_device text;
    v_existing public.shared_cash_shifts%rowtype;
    v_existing_rec jsonb;
    v_rec_id text;
    v_data jsonb;
    v_shift public.shared_cash_shifts%rowtype;
begin
    if p_session is not null then
        select m.account_id, m.id into v_account, v_member
        from public.nube_session_member(p_session) m where m.id is not null;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
        select d.id into v_device from public.account_devices d where d.auth_user_id = auth.uid() and d.revoked_at is null;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión pueden abrir caja' using errcode = '42501'; end if;
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    v_member_name := coalesce(p_opening_record -> 'cashier' ->> 'nombre', 'Usuario');

    if coalesce(trim(p_shift_id), '') = '' then
        raise exception 'shift_id inválido' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtext(v_account::text || ':shared_shift'));

    select * into v_existing
      from public.shared_cash_shifts s
     where s.account_id = v_account and s.status = 'open'
     limit 1;

    if found then
        select r.data into v_existing_rec
          from public.account_records r
         where r.account_id = v_account
           and r.collection = 'cash'
           and r.id = v_existing.opening_record_id
           and r.deleted_at is null;

        return jsonb_build_object(
            'already_open', true,
            'shift', to_jsonb(v_existing),
            'opening_record', v_existing_rec
        );
    end if;

    v_rec_id := coalesce(nullif(p_opening_record ->> 'id', ''), 'apertura_' || p_shift_id);
    v_data := coalesce(p_opening_record, '{}'::jsonb)
        || jsonb_build_object(
            'id', v_rec_id,
            'tipo', 'APERTURA_CAJA',
            'shiftId', p_shift_id,
            'cajaCerrada', false
        );

    insert into public.shared_cash_shifts (
        id, account_id, status, opened_at, opened_by_device_id, opened_by_name, opening_record_id, updated_at
    )
    values (
        p_shift_id, v_account, 'open', now(), v_device, coalesce(v_member_name, p_opening_record -> 'cashier' ->> 'nombre', 'Usuario'), v_rec_id, now()
    )
    returning * into v_shift;

    insert into public.account_records (account_id, collection, id, data, updated_by_device, updated_by_member)
    values (v_account, 'cash', v_rec_id, v_data, v_device, v_member)
    on conflict (account_id, collection, id) do update
        set data = excluded.data,
            deleted_at = null,
            version = public.account_records.version + 1,
            updated_at = now();

    return jsonb_build_object(
        'already_open', false,
        'shift', to_jsonb(v_shift),
        'opening_record', v_data
    );
end;
$$;

create or replace function public.close_shared_cash_shift(
    p_session uuid,
    p_shift_id text,
    p_close_record jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_account uuid;
    v_member uuid;
    v_member_name text;
    v_device text;
    v_shift public.shared_cash_shifts%rowtype;
    v_close_id text;
    v_cierre_num jsonb;
    v_close_data jsonb;
    v_closed_count integer := 0;
begin
    if p_session is not null then
        select m.account_id, m.id into v_account, v_member
        from public.nube_session_member(p_session) m where m.id is not null;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
        select d.id into v_device from public.account_devices d where d.auth_user_id = auth.uid() and d.revoked_at is null;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión pueden cerrar caja' using errcode = '42501'; end if;
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    v_member_name := coalesce(p_close_record -> 'summary' -> 'cashier' ->> 'nombre', 'Usuario');

    perform pg_advisory_xact_lock(hashtext(v_account::text || ':shared_shift'));

    if coalesce(trim(p_shift_id), '') <> '' then
        select * into v_shift
          from public.shared_cash_shifts s
         where s.account_id = v_account and s.id = p_shift_id
         for update;
    else
        select * into v_shift
          from public.shared_cash_shifts s
         where s.account_id = v_account and s.status = 'open'
         order by s.opened_at desc
         limit 1
         for update;
    end if;

    if not found then
        return jsonb_build_object('already_closed', true, 'shift', null, 'closed_records', 0);
    end if;

    if v_shift.status = 'closed' then
        return jsonb_build_object('already_closed', true, 'shift', to_jsonb(v_shift), 'closed_records', 0);
    end if;

    v_close_id := coalesce(nullif(p_close_record ->> 'id', ''), 'cierre_' || extract(epoch from now())::bigint::text);
    v_cierre_num := coalesce(p_close_record -> 'cierreId', to_jsonb(extract(epoch from now())::bigint * 1000));

    update public.shared_cash_shifts
       set status = 'closed',
           closed_at = now(),
           closed_by_device_id = v_device,
           closed_by_name = coalesce(v_member_name, p_close_record -> 'summary' -> 'cashier' ->> 'nombre', 'Usuario'),
           close_record_id = v_close_id,
           updated_at = now()
     where id = v_shift.id
    returning * into v_shift;

    update public.account_records r
       set data = r.data || jsonb_build_object('cajaCerrada', true, 'cierreId', v_cierre_num, 'shiftId', v_shift.id),
           version = r.version + 1,
           updated_at = now()
     where r.account_id = v_account
       and r.collection = 'cash'
       and r.deleted_at is null
       and coalesce((r.data ->> 'cajaCerrada')::boolean, false) = false
       and (
           r.id = v_shift.opening_record_id
           or r.data ->> 'shiftId' = v_shift.id
           or (r.data ->> 'shiftId' is null and r.updated_at >= v_shift.opened_at - interval '5 minutes')
       );
    get diagnostics v_closed_count = row_count;

    if p_close_record is not null and jsonb_typeof(p_close_record) = 'object' then
        v_close_data := p_close_record || jsonb_build_object(
            'id', v_close_id,
            'tipo', 'REGISTRO_CIERRE',
            'shiftId', v_shift.id,
            'cajaCerrada', true,
            'sharedDrawer', true
        );
        insert into public.account_records (account_id, collection, id, data, updated_by_device, updated_by_member)
        values (v_account, 'cash', v_close_id, v_close_data, v_device, v_member)
        on conflict (account_id, collection, id) do update
            set data = excluded.data,
                deleted_at = null,
                version = public.account_records.version + 1,
                updated_at = now();
    end if;

    return jsonb_build_object(
        'already_closed', false,
        'shift', to_jsonb(v_shift),
        'closed_records', v_closed_count
    );
end;
$$;

create or replace function public.get_active_shared_shift(p_session uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
    v_account uuid;
    v_shift public.shared_cash_shifts%rowtype;
    v_rec jsonb;
begin
    if p_session is not null then
        select m.account_id into v_account
        from public.nube_session_member(p_session) m where m.id is not null;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Sin sesión activa' using errcode = '42501'; end if;
    end if;

    select * into v_shift
      from public.shared_cash_shifts s
     where s.account_id = v_account and s.status = 'open'
     limit 1;

    if not found then
        return null;
    end if;

    select r.data into v_rec
      from public.account_records r
     where r.account_id = v_account
       and r.collection = 'cash'
       and r.id = v_shift.opening_record_id
       and r.deleted_at is null;

    return jsonb_build_object(
        'shift', to_jsonb(v_shift),
        'opening_record', v_rec
    );
end;
$$;

grant execute on function public.open_shared_cash_shift(uuid, text, jsonb) to authenticated;
grant execute on function public.close_shared_cash_shift(uuid, text, jsonb) to authenticated;
grant execute on function public.get_active_shared_shift(uuid) to authenticated;
