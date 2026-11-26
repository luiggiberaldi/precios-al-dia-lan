-- Precios al Día Nube · F3 — Libro de stock y cobro en el servidor.
--
-- El stock ya no lo resta la caja: es la SUMA de los movimientos de un libro de solo
-- agregar (baranda G6). Cada venta, anulación, compra, ajuste o conteo deja su línea.
-- Dos cajas vendiendo lo mismo a la vez escriben dos líneas; el nivel se actualiza
-- en la MISMA transacción con bloqueo de fila, así ninguna venta se pierde (E1, E2).
--
--   stock_movements   libro (id creado en el equipo → reintentos sin duplicar, G7)
--   stock_levels      nivel actual por sede y producto (solo lo toca el trigger del libro)
--   sales             una fila por venta, con su número por caja (#A-00001)
--   device_counters   último número de venta de cada caja
--   stock_discrepancies  diferencias pendientes para el dueño (sobreventa sin internet, E4)
--
-- Idempotente. Vuelta atrás al final.

create table if not exists public.stock_movements (
    id              uuid primary key,
    account_id      uuid not null references public.accounts(id) on delete cascade,
    sede_id         uuid not null references public.sedes(id),
    product_id      text not null check (length(product_id) between 1 and 120),
    qty             numeric(14, 3) not null check (qty <> 0),
    reason          text not null check (reason in ('VENTA', 'ANULACION', 'COMPRA', 'AJUSTE', 'CONTEO', 'INICIAL')),
    reference       text,
    device_id       text references public.account_devices(id),
    member_id       uuid references public.account_members(id),
    device_at       timestamptz,
    server_at       timestamptz not null default now(),
    note            text check (note is null or length(note) <= 300)
);
create index if not exists stock_movements_product on public.stock_movements (account_id, sede_id, product_id, server_at);
create index if not exists stock_movements_reference on public.stock_movements (account_id, reference);

create table if not exists public.stock_levels (
    account_id      uuid not null references public.accounts(id) on delete cascade,
    sede_id         uuid not null references public.sedes(id),
    product_id      text not null,
    qty             numeric(14, 3) not null default 0,
    updated_at      timestamptz not null default now(),
    primary key (account_id, sede_id, product_id)
);

create table if not exists public.device_counters (
    device_id       text primary key references public.account_devices(id) on delete cascade,
    last_number     integer not null default 0
);

create table if not exists public.sales (
    id              uuid primary key,
    account_id      uuid not null references public.accounts(id) on delete cascade,
    sede_id         uuid not null references public.sedes(id),
    device_id       text not null references public.account_devices(id),
    member_id       uuid references public.account_members(id),
    number          text not null,
    total_usd       numeric(14, 2),
    total_bs        numeric(16, 2),
    rate            numeric(14, 4),
    payload         jsonb not null default '{}'::jsonb,
    status          text not null default 'completada' check (status in ('completada', 'anulada')),
    offline         boolean not null default false,
    device_at       timestamptz,
    server_at       timestamptz not null default now(),
    voided_at       timestamptz,
    voided_by_device text references public.account_devices(id),
    voided_by_member uuid references public.account_members(id),
    void_reason     text,
    unique (account_id, number)
);
create index if not exists sales_by_day on public.sales (account_id, sede_id, server_at);

create table if not exists public.stock_discrepancies (
    id              uuid primary key default gen_random_uuid(),
    account_id      uuid not null references public.accounts(id) on delete cascade,
    sede_id         uuid not null references public.sedes(id),
    product_id      text not null,
    sale_id         uuid references public.sales(id),
    expected_qty    numeric(14, 3) not null,   -- lo que había en el servidor
    sold_qty        numeric(14, 3) not null,   -- lo que se vendió
    created_at      timestamptz not null default now(),
    resolved_at     timestamptz,
    resolved_by     uuid references public.account_members(id),
    resolution_note text
);

-- ─── Libro de solo agregar (G6) ──────────────────────────────────────────────

create or replace function nube_private.stock_movement_apply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.stock_levels as l (account_id, sede_id, product_id, qty, updated_at)
    values (new.account_id, new.sede_id, new.product_id, new.qty, now())
    on conflict (account_id, sede_id, product_id)
    do update set qty = l.qty + excluded.qty, updated_at = now();
    return null;
end;
$$;

create or replace function nube_private.reject_ledger_change()
returns trigger language plpgsql as $$
begin
    raise exception 'El libro de stock no se edita ni se borra: registra un movimiento inverso.' using errcode = '42501';
end;
$$;

drop trigger if exists stock_movements_apply on public.stock_movements;
create trigger stock_movements_apply after insert on public.stock_movements
    for each row execute function nube_private.stock_movement_apply();

drop trigger if exists stock_movements_no_change on public.stock_movements;
create trigger stock_movements_no_change before update or delete on public.stock_movements
    for each row execute function nube_private.reject_ledger_change();

alter function nube_private.reject_ledger_change() set search_path = public;

-- ─── RLS: lectura de lo propio; escritura solo por RPC ───────────────────────

alter table public.stock_movements     enable row level security;
alter table public.stock_levels        enable row level security;
alter table public.device_counters     enable row level security;
alter table public.sales               enable row level security;
alter table public.stock_discrepancies enable row level security;

revoke all on public.stock_movements, public.stock_levels, public.device_counters, public.sales,
              public.stock_discrepancies from anon, authenticated;
grant select on public.stock_movements, public.stock_levels, public.sales, public.stock_discrepancies to authenticated;

drop policy if exists stock_movements_read on public.stock_movements;
create policy stock_movements_read on public.stock_movements for select to authenticated using (account_id = nube_private.my_account_id());
drop policy if exists stock_levels_read on public.stock_levels;
create policy stock_levels_read on public.stock_levels for select to authenticated using (account_id = nube_private.my_account_id());
drop policy if exists sales_read on public.sales;
create policy sales_read on public.sales for select to authenticated using (account_id = nube_private.my_account_id());
drop policy if exists discrepancies_read on public.stock_discrepancies;
create policy discrepancies_read on public.stock_discrepancies for select to authenticated using (account_id = nube_private.my_account_id());

-- ─── Ayudante: quién cobra (sesión de PIN en ESTE equipo) ────────────────────

create or replace function nube_private.session_context(p_session uuid)
returns table (account_id uuid, member_id uuid, role text, device_id text, sede_id uuid, caja_letter text)
language sql stable security definer set search_path = public as $$
    select m.account_id, m.id, m.role, d.id, d.sede_id, d.caja_letter
    from public.nube_session_member(p_session) m
    join public.account_devices d on d.auth_user_id = auth.uid() and d.revoked_at is null and d.account_id = m.account_id
    where m.id is not null;
$$;

-- ─── Cobro ───────────────────────────────────────────────────────────────────
-- p_sale = {
--   "id": uuid (creado en el equipo), "items": [{ "product_id": "...", "qty": 2 }, ...],
--   "total_usd": 10.5, "total_bs": 4000, "rate": 380, "device_at": "...", "payload": {...}
-- }
-- p_offline: la venta se hizo sin internet y se está subiendo ahora → nunca se rechaza;
--            si no alcanzaba, se anota una diferencia pendiente para el dueño (E4).
-- p_allow_negative: la cuenta permite vender por debajo de cero (como Bodega).
create or replace function public.process_checkout(p_session uuid, p_sale jsonb, p_offline boolean default false, p_allow_negative boolean default false)
returns table (sale_id uuid, number text, already_registered boolean, shortages jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    ctx record;
    v_sale_id uuid := (p_sale ->> 'id')::uuid;
    v_existing public.sales;
    v_number text;
    v_n integer;
    v_item record;
    v_level numeric;
    v_short jsonb := '[]'::jsonb;
begin
    select * into ctx from nube_private.session_context(p_session);
    if ctx.account_id is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    if v_sale_id is null then raise exception 'La venta necesita un id' using errcode = '22023'; end if;

    -- Reintento (G7 / E11): la venta ya está; responder «ya registrada».
    select * into v_existing from public.sales where id = v_sale_id;
    if found then
        if v_existing.account_id <> ctx.account_id then raise exception 'Venta de otra cuenta' using errcode = '42501'; end if;
        return query select v_existing.id, v_existing.number, true, '[]'::jsonb;
        return;
    end if;

    if jsonb_typeof(p_sale -> 'items') <> 'array' or jsonb_array_length(p_sale -> 'items') = 0 then
        raise exception 'La venta no tiene productos' using errcode = '22023';
    end if;

    -- Cantidades por producto (sumadas) en orden fijo: los bloqueos siempre en el mismo
    -- orden evitan que dos cajas se traben entre sí.
    create temporary table if not exists pg_temp.nube_checkout_items (product_id text primary key, qty numeric) on commit drop;
    truncate pg_temp.nube_checkout_items;
    insert into pg_temp.nube_checkout_items (product_id, qty)
    select it ->> 'product_id', sum((it ->> 'qty')::numeric)
    from jsonb_array_elements(p_sale -> 'items') it
    group by it ->> 'product_id';
    if exists (select 1 from pg_temp.nube_checkout_items where product_id is null or product_id = '' or qty is null or qty <= 0) then
        raise exception 'Producto o cantidad inválidos en la venta' using errcode = '22023';
    end if;

    insert into public.stock_levels (account_id, sede_id, product_id, qty)
    select ctx.account_id, ctx.sede_id, i.product_id, 0 from pg_temp.nube_checkout_items i
    on conflict do nothing;

    for v_item in
        select i.product_id, i.qty, l.qty as level
        from pg_temp.nube_checkout_items i
        join public.stock_levels l on l.account_id = ctx.account_id and l.sede_id = ctx.sede_id and l.product_id = i.product_id
        order by i.product_id
        for update of l
    loop
        if v_item.level < v_item.qty then
            v_short := v_short || jsonb_build_object('product_id', v_item.product_id, 'available', v_item.level, 'requested', v_item.qty);
        end if;
    end loop;

    if jsonb_array_length(v_short) > 0 and not p_offline and not p_allow_negative then
        raise exception 'Sin stock suficiente: %', (
            select string_agg(format('%s (hay %s, pides %s)', s ->> 'product_id', s ->> 'available', s ->> 'requested'), '; ')
            from jsonb_array_elements(v_short) s
        ) using errcode = 'P0001', detail = v_short::text;
    end if;

    insert into public.device_counters (device_id, last_number) values (ctx.device_id, 1)
    on conflict (device_id) do update set last_number = public.device_counters.last_number + 1
    returning last_number into v_n;
    v_number := '#' || coalesce(ctx.caja_letter, 'Z') || '-' || lpad(v_n::text, 5, '0');

    insert into public.sales (id, account_id, sede_id, device_id, member_id, number, total_usd, total_bs, rate, payload, offline, device_at)
    values (v_sale_id, ctx.account_id, ctx.sede_id, ctx.device_id, ctx.member_id, v_number,
            (p_sale ->> 'total_usd')::numeric, (p_sale ->> 'total_bs')::numeric, (p_sale ->> 'rate')::numeric,
            coalesce(p_sale -> 'payload', '{}'::jsonb), p_offline, (p_sale ->> 'device_at')::timestamptz);

    insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason, reference, device_id, member_id, device_at)
    select gen_random_uuid(), ctx.account_id, ctx.sede_id, i.product_id, -i.qty, 'VENTA', v_sale_id::text,
           ctx.device_id, ctx.member_id, (p_sale ->> 'device_at')::timestamptz
    from pg_temp.nube_checkout_items i;

    -- Sobreventa: se guarda igual y queda una diferencia pendiente para el dueño (G10).
    insert into public.stock_discrepancies (account_id, sede_id, product_id, sale_id, expected_qty, sold_qty)
    select ctx.account_id, ctx.sede_id, s ->> 'product_id', v_sale_id, (s ->> 'available')::numeric, (s ->> 'requested')::numeric
    from jsonb_array_elements(v_short) s;

    return query select v_sale_id, v_number, false, v_short;
end;
$$;

-- Anular: movimiento inverso por cada línea de la venta (nunca se borra nada, E7).
-- Lo puede hacer cualquier caja de la cuenta (dueño o administrador); queda quién y dónde.
create or replace function public.process_void(p_session uuid, p_sale_id uuid, p_reason text default null)
returns table (sale_id uuid, number text, already_voided boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    ctx record;
    v_sale public.sales;
begin
    select * into ctx from nube_private.session_context(p_session);
    if ctx.account_id is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    if ctx.role not in ('dueno', 'administrador') then raise exception 'Solo el dueño o un administrador anulan ventas' using errcode = '42501'; end if;

    select * into v_sale from public.sales where id = p_sale_id and account_id = ctx.account_id for update;
    if not found then raise exception 'Venta no encontrada' using errcode = 'P0002'; end if;
    if v_sale.status = 'anulada' then
        return query select v_sale.id, v_sale.number, true;
        return;
    end if;

    update public.sales
       set status = 'anulada', voided_at = now(), voided_by_device = ctx.device_id,
           voided_by_member = ctx.member_id, void_reason = left(p_reason, 300)
     where id = v_sale.id;

    -- El stock vuelve a la sede donde se vendió.
    insert into public.stock_movements (id, account_id, sede_id, product_id, qty, reason, reference, device_id, member_id, note)
    select gen_random_uuid(), m.account_id, m.sede_id, m.product_id, -m.qty, 'ANULACION', v_sale.id::text,
           ctx.device_id, ctx.member_id, left(p_reason, 300)
    from public.stock_movements m
    where m.account_id = ctx.account_id and m.reference = v_sale.id::text and m.reason = 'VENTA';

    return query select v_sale.id, v_sale.number, false;
end;
$$;

-- Compras, ajustes, conteos y stock inicial: una sola puerta con motivo.
-- p_movements = [{ "id": uuid, "product_id": "...", "qty": 12, "note": "..." }, ...]
--   COMPRA / AJUSTE / INICIAL: qty es la cantidad a sumar (± en AJUSTE).
--   CONTEO: qty es lo CONTADO; el servidor registra la diferencia contra el nivel actual.
-- Dueño o administrador. Desde el dueño (correo, p. ej. importar): p_session nulo y p_sede_id.
create or replace function public.process_stock_movements(p_session uuid, p_reason text, p_movements jsonb, p_reference text default null, p_sede_id uuid default null)
returns table (id uuid, product_id text, qty numeric, already_registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_role text; v_device text; v_sede uuid;
    v_mov jsonb; v_id uuid; v_qty numeric; v_level numeric; v_pid text;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.role, c.device_id, c.sede_id into v_account, v_member, v_role, v_device, v_sede
        from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión' using errcode = '42501'; end if;
        v_role := 'dueno';
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
        v_sede := coalesce(p_sede_id, (select s.id from public.sedes s where s.account_id = v_account and s.archived_at is null order by s.created_at limit 1));
    end if;
    if v_role not in ('dueno', 'administrador') then raise exception 'Solo el dueño o un administrador mueven inventario' using errcode = '42501'; end if;
    if p_reason not in ('COMPRA', 'AJUSTE', 'CONTEO', 'INICIAL') then raise exception 'Motivo inválido' using errcode = '22023'; end if;
    if p_sede_id is not null and p_session is not null and p_sede_id <> v_sede then raise exception 'Este equipo solo mueve el inventario de su sede' using errcode = '42501'; end if;
    if not exists (select 1 from public.sedes s where s.id = v_sede and s.account_id = v_account) then raise exception 'Sede inválida' using errcode = '22023'; end if;
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
            v_qty := v_qty - v_level;   -- se registra la diferencia contada
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

-- El dueño abre otra sede (D6: stock por sede), dentro del límite de su licencia.
create or replace function public.create_sede(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    v_account uuid := nube_private.owner_account_id();
    v_max integer;
    v_count integer;
    v_id uuid;
begin
    if v_account is null then raise exception 'Solo el dueño abre sedes' using errcode = '42501'; end if;
    select max_sedes into v_max from public.account_licenses where account_id = v_account for update;
    select count(*) into v_count from public.sedes where account_id = v_account and archived_at is null;
    if v_count >= v_max then
        raise exception 'Tu licencia permite % sede(s).', v_max using errcode = 'P0001';
    end if;
    insert into public.sedes (account_id, name) values (v_account, btrim(p_name)) returning id into v_id;
    return v_id;
end;
$$;
revoke all on function public.create_sede(text) from public, anon;
grant execute on function public.create_sede(text) to authenticated;

-- El dueño o un administrador cierra una diferencia pendiente con una nota.
create or replace function public.resolve_discrepancy(p_session uuid, p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare ctx record;
begin
    select * into ctx from nube_private.session_context(p_session);
    if ctx.account_id is null or ctx.role not in ('dueno', 'administrador') then
        raise exception 'Solo el dueño o un administrador' using errcode = '42501';
    end if;
    update public.stock_discrepancies set resolved_at = now(), resolved_by = ctx.member_id, resolution_note = left(p_note, 300)
     where id = p_id and account_id = ctx.account_id and resolved_at is null;
    if not found then raise exception 'Diferencia no encontrada o ya resuelta' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.process_checkout(uuid, jsonb, boolean, boolean), public.process_void(uuid, uuid, text),
    public.process_stock_movements(uuid, text, jsonb, text, uuid), public.resolve_discrepancy(uuid, uuid, text) from public, anon;
grant execute on function public.process_checkout(uuid, jsonb, boolean, boolean), public.process_void(uuid, uuid, text),
    public.process_stock_movements(uuid, text, jsonb, text, uuid), public.resolve_discrepancy(uuid, uuid, text) to authenticated;
revoke all on function nube_private.session_context(uuid), nube_private.stock_movement_apply(),
    nube_private.reject_ledger_change() from public, anon, authenticated;

-- Los niveles de stock avisan por Realtime (filas chicas: producto y cantidad).
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_levels') then
        alter publication supabase_realtime add table public.stock_levels;
    end if;
end $$;

-- ROLLBACK
-- alter publication supabase_realtime drop table public.stock_levels;
-- drop function if exists public.resolve_discrepancy(uuid, uuid, text), public.process_stock_movements(uuid, text, jsonb, text, uuid),
--     public.process_void(uuid, uuid, text), public.process_checkout(uuid, jsonb, boolean, boolean), nube_private.session_context(uuid);
-- drop trigger if exists stock_movements_no_change on public.stock_movements;
-- drop trigger if exists stock_movements_apply on public.stock_movements;
-- drop function if exists nube_private.reject_ledger_change(), nube_private.stock_movement_apply();
-- drop table if exists public.stock_discrepancies, public.sales, public.device_counters, public.stock_levels, public.stock_movements;
