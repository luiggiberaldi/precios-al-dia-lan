-- Precios al Día Nube / LAN · 025 — Corrección de bloqueo mutuo al cerrar en modo Caja Compartida.
--
-- Corrige tres condiciones que impedían cerrar caja desde cualquiera de los equipos:
--   1. `close_shared_cash_shift` devolvía `already_closed: true` cuando `shared_cash_shifts`
--      no tenía fila abierta (apertura previa al modo compartido, apertura local en reconexión
--      o movimientos huérfanos sin `shiftId`), dejando `account_records(cash)` sin cerrar.
--   2. Cuando `shared_cash_shifts` ya figuraba `closed`, no reconciliaba registros residuales
--      en `account_records(cash)` que hubieran quedado con `cajaCerrada = false` (incluyendo
--      registros históricos con sufijo `@deviceId` o gastos/aportes sin `shiftId`).
--   3. `push_records_v2` en modo compartido podía sobrescribir `cajaCerrada: true` de vuelta a
--      `false` cuando otra caja empujaba su cola local rezagada tras el cierre.
--
-- Idempotente.

-- ─── 1. Endurecer push_records_v2: cierre y anulación monotónicos en modo caja compartida ───

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
    v_existing_cash jsonb;
    v_shift_status text;
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
        v_existing_cash := null;

        if p_collection = 'cash' then
            select r.updated_by_device, case when r.deleted_at is null then r.data else null end
              into v_owner_device, v_existing_cash
              from public.account_records r
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

        -- En modo caja compartida, una cola rezagada de otro equipo jamás puede reabrir
        -- un registro ya cerrado ni deshacer una anulación ya confirmada.
        if v_shared_cash and not v_deleted then
            if v_existing_cash is not null then
                if coalesce((v_existing_cash ->> 'cajaCerrada')::boolean, false) = true
                   and coalesce((v_data ->> 'cajaCerrada')::boolean, false) = false then
                    v_data := v_data || jsonb_build_object('cajaCerrada', true)
                        || case when v_existing_cash ? 'cierreId' then jsonb_build_object('cierreId', v_existing_cash -> 'cierreId') else '{}'::jsonb end
                        || case when v_existing_cash ? 'shiftId' and not (v_data ? 'shiftId') then jsonb_build_object('shiftId', v_existing_cash -> 'shiftId') else '{}'::jsonb end;
                    v_merged := true;
                end if;
                if coalesce(v_existing_cash ->> 'status', '') = 'ANULADA'
                   and coalesce(v_data ->> 'status', '') <> 'ANULADA' then
                    v_data := v_data || jsonb_build_object('status', 'ANULADA');
                    v_merged := true;
                end if;
            end if;

            -- Si llega una APERTURA_CAJA rezagada de un shiftId que ya fue cerrado en shared_cash_shifts,
            -- mantenerla cerrada para que no vuelva a abrir el turno en las cajas.
            if coalesce(v_data ->> 'tipo', '') = 'APERTURA_CAJA'
               and coalesce((v_data ->> 'cajaCerrada')::boolean, false) = false
               and coalesce(v_data ->> 'shiftId', '') <> '' then
                select s.status into v_shift_status
                  from public.shared_cash_shifts s
                 where s.account_id = v_account and s.id = (v_data ->> 'shiftId');
                if v_shift_status = 'closed' then
                    v_data := v_data || jsonb_build_object('cajaCerrada', true);
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
                updated_by_device = case
                    when v_shared_cash and r.updated_by_device is not null then r.updated_by_device
                    else excluded.updated_by_device
                end,
                updated_by_member = excluded.updated_by_member
        returning r.id, r.version, r.updated_at, v_merged, false, case when v_merged then r.data end;
    end loop;
end;
$$;

-- ─── 2. Corregir close_shared_cash_shift: auto-curación de turnos sin fila o registros residuales ───

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
    v_last_closed public.shared_cash_shifts%rowtype;
    v_has_shift boolean := false;
    v_open_records integer := 0;
    v_synth_shift_id text;
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
         where s.account_id = v_account and s.id = trim(p_shift_id)
         for update;
        v_has_shift := found;
    end if;

    -- Si no se encontró por p_shift_id (o venía vacío), buscar turno abierto activo de la cuenta
    if not v_has_shift then
        select * into v_shift
          from public.shared_cash_shifts s
         where s.account_id = v_account and s.status = 'open'
         order by s.opened_at desc
         limit 1
         for update;
        v_has_shift := found;
    end if;

    -- Caso A: el turno existe y ya figura cerrado en shared_cash_shifts.
    -- Reconciliar de forma idempotente cualquier registro residual de ese turno o sin shiftId
    -- que haya quedado con cajaCerrada = false (sin duplicar REGISTRO_CIERRE).
    if v_has_shift and v_shift.status = 'closed' then
        v_cierre_num := to_jsonb((extract(epoch from coalesce(v_shift.closed_at, now()))::bigint) * 1000);
        update public.account_records r
           set data = r.data || jsonb_build_object(
                   'cajaCerrada', true,
                   'cierreId', coalesce(r.data -> 'cierreId', v_cierre_num),
                   'shiftId', coalesce(nullif(r.data ->> 'shiftId', ''), v_shift.id)
               ),
               version = r.version + 1,
               updated_at = now()
         where r.account_id = v_account
           and r.collection = 'cash'
           and r.deleted_at is null
           and coalesce((r.data ->> 'cajaCerrada')::boolean, false) = false
           and coalesce(r.data ->> 'tipo', '') <> 'REGISTRO_CIERRE'
           and (
               r.id = v_shift.opening_record_id
               or split_part(r.id, '@', 1) = v_shift.opening_record_id
               or r.data ->> 'shiftId' = v_shift.id
               or (r.data ->> 'shiftId' is null and r.updated_at <= coalesce(v_shift.closed_at, now()) + interval '1 minute')
           );
        get diagnostics v_closed_count = row_count;

        return jsonb_build_object(
            'already_closed', true,
            'shift', to_jsonb(v_shift),
            'closed_records', v_closed_count
        );
    end if;

    -- Caso B: no existe fila abierta en shared_cash_shifts (p. ej. apertura previa al modo compartido,
    -- apertura creada en fallback offline o movimientos sin APERTURA_CAJA).
    if not v_has_shift then
        select count(*) into v_open_records
          from public.account_records r
         where r.account_id = v_account
           and r.collection = 'cash'
           and r.deleted_at is null
           and coalesce((r.data ->> 'cajaCerrada')::boolean, false) = false
           and coalesce(r.data ->> 'tipo', '') <> 'REGISTRO_CIERRE';

        -- Si ya no queda ningún movimiento abierto en el servidor y hubo un cierre reciente,
        -- significa que otro equipo acaba de cerrar ese lote huérfano.
        if v_open_records = 0 then
            select * into v_last_closed
              from public.shared_cash_shifts s
             where s.account_id = v_account and s.status = 'closed'
             order by s.closed_at desc nulls last
             limit 1;
            if found then
                return jsonb_build_object(
                    'already_closed', true,
                    'shift', to_jsonb(v_last_closed),
                    'closed_records', 0
                );
            end if;
        end if;

        -- Sí hay movimientos abiertos sin fila en shared_cash_shifts (o nunca hubo cierres previos):
        -- registrar un turno sintético cerrado y proceder a cerrar todos los movimientos abiertos.
        v_synth_shift_id := coalesce(
            nullif(trim(p_shift_id), ''),
            'shift_auto_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text || '_' || substr(md5(random()::text), 1, 6)
        );
        v_close_id := coalesce(nullif(p_close_record ->> 'id', ''), 'cierre_' || extract(epoch from now())::bigint::text);

        insert into public.shared_cash_shifts (
            id, account_id, status, opened_at, opened_by_device_id, opened_by_name,
            closed_at, closed_by_device_id, closed_by_name, close_record_id, updated_at
        )
        values (
            v_synth_shift_id, v_account, 'closed', now(), v_device, v_member_name,
            now(), v_device, v_member_name, v_close_id, now()
        )
        on conflict (id) do update
            set status = 'closed',
                closed_at = coalesce(public.shared_cash_shifts.closed_at, now()),
                closed_by_device_id = coalesce(public.shared_cash_shifts.closed_by_device_id, excluded.closed_by_device_id),
                closed_by_name = coalesce(public.shared_cash_shifts.closed_by_name, excluded.closed_by_name),
                close_record_id = coalesce(public.shared_cash_shifts.close_record_id, excluded.close_record_id),
                updated_at = now()
        returning * into v_shift;
    else
        -- Caso C: turno abierto normal en shared_cash_shifts → marcarlo como closed
        v_close_id := coalesce(nullif(p_close_record ->> 'id', ''), 'cierre_' || extract(epoch from now())::bigint::text);
        update public.shared_cash_shifts
           set status = 'closed',
               closed_at = now(),
               closed_by_device_id = v_device,
               closed_by_name = coalesce(v_member_name, p_close_record -> 'summary' -> 'cashier' ->> 'nombre', 'Usuario'),
               close_record_id = v_close_id,
               updated_at = now()
         where id = v_shift.id
        returning * into v_shift;
    end if;

    v_cierre_num := coalesce(p_close_record -> 'cierreId', to_jsonb(extract(epoch from now())::bigint * 1000));

    -- Cerrar todos los movimientos abiertos del turno (incluyendo registros con sufijo @deviceId
    -- heredados de modo independiente y gastos/aportes/cobros que no tenían shiftId).
    update public.account_records r
       set data = r.data || jsonb_build_object(
               'cajaCerrada', true,
               'cierreId', v_cierre_num,
               'shiftId', coalesce(nullif(r.data ->> 'shiftId', ''), v_shift.id)
           ),
           version = r.version + 1,
           updated_at = now()
     where r.account_id = v_account
       and r.collection = 'cash'
       and r.deleted_at is null
       and coalesce((r.data ->> 'cajaCerrada')::boolean, false) = false
       and coalesce(r.data ->> 'tipo', '') <> 'REGISTRO_CIERRE'
       and (
           (v_shift.opening_record_id is not null and (
               r.id = v_shift.opening_record_id
               or split_part(r.id, '@', 1) = v_shift.opening_record_id
           ))
           or r.data ->> 'shiftId' = v_shift.id
           or coalesce(r.data ->> 'shiftId', '') = ''
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

grant execute on function public.open_shared_cash_shift(uuid, text, jsonb) to authenticated;
grant execute on function public.close_shared_cash_shift(uuid, text, jsonb) to authenticated;
grant execute on function public.get_active_shared_shift(uuid) to authenticated;

notify pgrst, 'reload schema';
