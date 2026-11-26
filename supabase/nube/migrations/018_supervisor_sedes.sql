-- Precios al Día LAN · 018 — Stock por sede y acciones de puente para Modo Supervisor.
--
-- 1. En multi-sede, un equipo `consulta` (Modo Supervisor del dueño/administrador)
--    puede elegir explícitamente la sede (`p_sede_id`) al registrar compras, ajustes
--    o conteos, siempre que esa sede pertenezca a la misma cuenta y no esté archivada.
--    Las cajas (`role = 'caja'`) siguen limitadas a su propia sede.
-- 2. `process_void` y `resolve_discrepancy` también admiten `p_session is null` cuando
--    los llama el dueño autenticado (igual que `push_records_v2` y `process_stock_movements`),
--    permitiendo ejecutar comandos del puente de internet con auditoría del dueño.
-- Idempotente. Vuelta atrás al final.

create or replace function public.process_void(p_session uuid, p_sale_id uuid, p_reason text default null)
returns table (sale_id uuid, number text, already_voided boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text;
    v_sale public.sales;
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

    update public.sales
       set status = 'anulada', voided_at = now(), voided_by_device = v_device,
           voided_by_member = v_member, void_reason = left(p_reason, 300)
     where id = v_sale.id;

    insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason, reference, device_id, member_id, note)
    select gen_random_uuid(), m.account_id, m.sede_id, m.product_id, -m.qty, 'ANULACION', v_sale.id::text,
           v_device, v_member, left(p_reason, 300)
    from public.stock_movements m
    where m.account_id = v_account and m.reference = v_sale.id::text and m.reason = 'VENTA';

    return query select v_sale.id, v_sale.number, false;
end;
$$;

create or replace function public.process_stock_movements(p_session uuid, p_reason text, p_movements jsonb, p_reference text default null, p_sede_id uuid default null)
returns table (id uuid, product_id text, qty numeric, already_registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text; v_sede uuid;
    v_device_role text;
    v_mov jsonb; v_id uuid; v_qty numeric; v_level numeric; v_pid text;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role, c.device_id, c.sede_id into v_account, v_member, v_role, v_device, v_sede
        from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
        select d.role into v_device_role from public.account_devices d where d.id = v_device;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión' using errcode = '42501'; end if;
        v_role := 'dueno';
        v_device_role := 'owner';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
        v_sede := coalesce(p_sede_id, (select s.id from public.sedes s where s.account_id = v_account and s.archived_at is null order by s.created_at limit 1));
    end if;
    if v_role not in ('dueno', 'administrador') then raise exception 'Solo el dueño o un administrador mueven inventario' using errcode = '42501'; end if;
    if p_reason not in ('COMPRA', 'AJUSTE', 'CONTEO', 'INICIAL') then raise exception 'Motivo inválido' using errcode = '22023'; end if;
    if p_sede_id is not null and p_session is not null and p_sede_id <> v_sede then
        if coalesce(v_device_role, '') = 'consulta' then
            v_sede := p_sede_id;
        else
            raise exception 'Este equipo solo mueve el inventario de su sede' using errcode = '42501';
        end if;
    elsif p_sede_id is not null and coalesce(v_device_role, '') = 'consulta' then
        v_sede := p_sede_id;
    end if;
    if not exists (select 1 from public.sedes s where s.id = v_sede and s.account_id = v_account and s.archived_at is null) then
        raise exception 'Sede inválida' using errcode = '22023';
    end if;
    if jsonb_typeof(p_movements) <> 'array' or jsonb_array_length(p_movements) > 1000 then raise exception 'Envía de 0 a 1000 movimientos' using errcode = '22023'; end if;

    for v_mov in select * from jsonb_array_elements(p_movements) loop
        v_id := (v_mov ->> 'id')::uuid;
        v_pid := v_mov ->> 'product_id';
        v_qty := (v_mov ->> 'qty')::numeric;
        if v_id is null or coalesce(v_pid, '') = '' or v_qty is null then raise exception 'Movimiento inválido' using errcode = '22023'; end if;

        if exists (select 1 from public.stock_movements m where m.id = v_id) then
            return query select v_id, v_pid, v_qty, true;   -- reintento (G7)
            continue;
        end if;

        if p_reason = 'CONTEO' then
            insert into public.stock_levels (account_id, sede_id, product_id, qty) values (v_account, v_sede, v_pid, 0) on conflict do nothing;
            select l.qty into v_level from public.stock_levels l
             where l.account_id = v_account and l.sede_id = v_sede and l.product_id = v_pid for update;
            v_qty := v_qty - v_level;
            if v_qty = 0 then
                return query select v_id, v_pid, 0::numeric, false;
                continue;
            end if;
        elsif p_reason in ('COMPRA', 'INICIAL') and v_qty <= 0 then
            raise exception 'La cantidad de % debe ser positiva', p_reason using errcode = '22023';
        elsif v_qty = 0 then
            continue;
        end if;

        insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason, reference, device_id, member_id, note)
        values (v_id, v_account, v_sede, v_pid, v_qty, p_reason, p_reference, v_device, v_member, left(v_mov ->> 'note', 300));
        return query select v_id, v_pid, v_qty, false;
    end loop;
end;
$$;

create or replace function public.resolve_discrepancy(p_session uuid, p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_account uuid; v_member uuid; v_role text;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role into v_account, v_member, v_role
          from nube_private.session_context(p_session) c;
    else
        v_account := nube_private.owner_account_id();
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    if v_account is null or v_role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador' using errcode = '42501';
    end if;
    update public.stock_discrepancies set resolved_at = now(), resolved_by = v_member, resolution_note = left(p_note, 300)
     where id = p_id and account_id = v_account and resolved_at is null;
    if not found then raise exception 'Diferencia no encontrada o ya resuelta' using errcode = 'P0002'; end if;
end;
$$;

-- ROLLBACK
-- (volver a aplicar process_void, process_stock_movements y resolve_discrepancy de 005_libro_stock_y_cobro.sql)
