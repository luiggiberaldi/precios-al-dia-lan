-- Precios al Día Nube · F5 — Turnos por caja, cierres y consolidado del día.
--
-- En Bodega el turno vive dentro de la lista de ventas: apertura, ventas, gastos,
-- aportes, avances, cobros de deuda y pagos a proveedores son registros con su `tipo`,
-- y el cierre los marca con `cajaCerrada`. En la nube cada caja SUBE sus registros de
-- caja (colección `cash` de account_records, una fila por registro, aligerados) y
-- ninguna baja los de otra: el turno de cada caja es suyo (cerrar A no cierra B).
-- El stock y los saldos siguen mandados por sus libros (F3/F4); esto es para cuadres
-- y reportes.
--
-- cash_day_summary(): el dueño (o cualquier equipo de la cuenta) ve, por caja y sede,
-- ventas, cobros, egresos, aportes y si la caja sigue abierta.
--
-- Idempotente. Vuelta atrás al final.

alter table public.account_records drop constraint if exists account_records_collection_check;
alter table public.account_records add constraint account_records_collection_check
    check (collection in ('products', 'customers', 'suppliers', 'payment_methods', 'settings', 'cash'));

create index if not exists account_records_cash_day on public.account_records (account_id, collection, ((data ->> 'timestamp')))
    where collection = 'cash';

-- push_records: `cash` lo sube cualquier empleado con sesión (es su turno); solo el
-- mismo equipo puede volver a escribir sus registros de caja.
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
        if coalesce(v_rec ->> 'id', '') = '' then raise exception 'Registro sin id' using errcode = '22023'; end if;
        v_data := nube_private.strip_ledger_fields(p_collection, coalesce(v_rec -> 'data', '{}'::jsonb));
        if jsonb_typeof(v_data) <> 'object' then raise exception 'Registro inválido' using errcode = '22023'; end if;
        if pg_column_size(v_data) > 100000 then
            raise exception 'El registro % es demasiado grande (¿imagen incrustada?)', v_rec ->> 'id' using errcode = '22023';
        end if;
        if p_collection = 'cash' then
            select r.updated_by_device into v_owner_device from public.account_records r
             where r.account_id = v_account and r.collection = 'cash' and r.id = v_rec ->> 'id';
            if v_owner_device is not null and v_owner_device <> v_device then
                raise exception 'Ese registro de caja es de otra caja' using errcode = '42501';
            end if;
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

-- Consolidado de un día (por defecto hoy en Venezuela): una fila por caja.
create or replace function public.cash_day_summary(p_day date default null, p_tz text default 'America/Caracas')
returns table (device_id text, label text, caja_letter text, sede_id uuid, sede_name text,
               ventas integer, ventas_usd numeric, cobros_usd numeric, egresos_usd numeric, aportes_usd numeric,
               caja_abierta boolean, ultima_actividad timestamptz)
language sql stable security definer set search_path = public as $$
    with acc as (select nube_private.my_account_id() as id),
    day as (select coalesce(p_day, (now() at time zone p_tz)::date) as d),
    recs as (
        select r.updated_by_device as device_id, r.data, (r.data ->> 'timestamp')::timestamptz as ts
        from public.account_records r, acc
        where r.account_id = acc.id and r.collection = 'cash' and r.deleted_at is null
    ),
    per_device as (
        select device_id,
            count(*) filter (where data ->> 'tipo' in ('VENTA', 'VENTA_FIADA', 'VENTA_CASHEA') and coalesce(data ->> 'status', '') <> 'ANULADA'
                             and (ts at time zone p_tz)::date = (select d from day))::int as ventas,
            coalesce(sum((data ->> 'totalUsd')::numeric) filter (where data ->> 'tipo' in ('VENTA', 'VENTA_FIADA', 'VENTA_CASHEA')
                             and coalesce(data ->> 'status', '') <> 'ANULADA' and (ts at time zone p_tz)::date = (select d from day)), 0) as ventas_usd,
            coalesce(sum((data ->> 'totalUsd')::numeric) filter (where data ->> 'tipo' in ('COBRO_DEUDA', 'COBRO_CASHEA')
                             and coalesce(data ->> 'status', '') <> 'ANULADA' and (ts at time zone p_tz)::date = (select d from day)), 0) as cobros_usd,
            coalesce(sum(-(data ->> 'totalUsd')::numeric) filter (where (data ->> 'totalUsd')::numeric < 0
                             and coalesce(data ->> 'status', '') <> 'ANULADA' and (ts at time zone p_tz)::date = (select d from day)), 0) as egresos_usd,
            coalesce(sum((data ->> 'totalUsd')::numeric) filter (where data ->> 'tipo' = 'APORTE_CAJA'
                             and (ts at time zone p_tz)::date = (select d from day)), 0) as aportes_usd,
            bool_or(data ->> 'tipo' = 'APERTURA_CAJA' and coalesce((data ->> 'cajaCerrada')::boolean, false) = false) as caja_abierta,
            max(ts) as ultima_actividad
        from recs
        group by device_id
    )
    select d.id, d.label, d.caja_letter, d.sede_id, s.name,
           coalesce(p.ventas, 0), coalesce(p.ventas_usd, 0), coalesce(p.cobros_usd, 0), coalesce(p.egresos_usd, 0),
           coalesce(p.aportes_usd, 0), coalesce(p.caja_abierta, false), p.ultima_actividad
    from public.account_devices d
    join acc on d.account_id = acc.id
    left join public.sedes s on s.id = d.sede_id
    left join per_device p on p.device_id = d.id
    where d.revoked_at is null and d.role = 'caja'
    order by s.name, d.caja_letter;
$$;

revoke all on function public.cash_day_summary(date, text) from public, anon;
grant execute on function public.cash_day_summary(date, text) to authenticated;

-- ROLLBACK
-- drop function if exists public.cash_day_summary(date, text);
-- (restaurar push_records de 003 y la restricción de colecciones sin 'cash')
