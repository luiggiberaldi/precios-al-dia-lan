-- Precios al Día Nube / LAN · 026 — Consolidado exacto de cajas (cash_day_summary) y nuevos permisos RBAC.
--
-- Corrige en `public.cash_day_summary`:
--   1. Excluye de `egresos_usd` retiros que NO sacan dinero de la gaveta (`afectaCaja = false` o `isAutoconsumo = true`,
--      como mercancía de nómina al personal, autoconsumo de bodega o pagos a proveedor por banco).
--   2. Cruza `public.sales` (libro atómico e inmediato de cobros y anulaciones) con `account_records(collection='cash')`
--      sin duplicar ventas y descartando de inmediato ventas anuladas (`public.sales.status = 'anulada'`).
--   3. Calcula `caja_abierta` respetando tanto el modo Caja Compartida (`shared_cash_shifts`) como el último evento
--      de turno (`APERTURA_CAJA` vs `REGISTRO_CIERRE`) por equipo, evitando falsos «Siguen abiertas» por registros viejos.
--   4. Extiende `nube_private.has_permission` con los permisos operativos de caja (`sales.staff_goods`, `sales.free_amount`,
--      `sales.cash_advance`, `cash.expenses`).
--
-- Idempotente.

create or replace function public.cash_day_summary(p_day date default null, p_tz text default 'America/Caracas')
returns table (device_id text, label text, caja_letter text, sede_id uuid, sede_name text,
               ventas integer, ventas_usd numeric, cobros_usd numeric, egresos_usd numeric, aportes_usd numeric,
               caja_abierta boolean, ultima_actividad timestamptz)
language sql stable security definer set search_path = public as $$
    with acc as (
        select nube_private.my_account_id() as id
    ),
    day as (
        select coalesce(p_day, (now() at time zone p_tz)::date) as d
    ),
    active_cajas as (
        select d.id, d.label, d.caja_letter, d.sede_id, s.name as sede_name,
               row_number() over (order by s.name nulls last, d.caja_letter, d.id) as rn
          from public.account_devices d
          join acc on d.account_id = acc.id
          left join public.sedes s on s.id = d.sede_id
         where d.revoked_at is null and d.role = 'caja'
    ),
    first_caja as (
        select id from active_cajas where rn = 1
    ),
    srv_sales as (
        select coalesce(s.device_id, (select id from first_caja)) as device_id,
               s.id::text as sale_id,
               nullif(s.payload ->> 'localId', '') as local_id,
               (s.status = 'anulada') as is_void,
               coalesce(s.total_usd, 0)::numeric as total_usd,
               coalesce(s.device_at, s.server_at) as ts
          from public.sales s, acc
         where s.account_id = acc.id
    ),
    cash_recs as (
        select coalesce(
                   r.updated_by_device,
                   nullif(substring(r.id from '@([^@]+)$'), ''),
                   (select id from first_caja)
               ) as device_id,
               r.id as rec_id,
               nullif(r.data ->> 'id', '') as local_id,
               nullif(r.data -> 'nube' ->> 'saleId', '') as nube_sale_id,
               coalesce(r.data ->> 'tipo', '') as tipo,
               coalesce(r.data ->> 'status', '') as status,
               case
                   when (r.data ->> 'totalUsd') ~ '^-?[0-9]+(\.[0-9]+)?$' then (r.data ->> 'totalUsd')::numeric
                   else 0::numeric
               end as total_usd,
               coalesce((r.data ->> 'afectaCaja')::boolean, true) as afecta_caja,
               coalesce((r.data ->> 'isAutoconsumo')::boolean, false) as is_autoconsumo,
               coalesce((r.data ->> 'cajaCerrada')::boolean, false) as caja_cerrada,
               case
                   when coalesce(r.data ->> 'timestamp', '') <> '' then (r.data ->> 'timestamp')::timestamptz
                   else r.updated_at
               end as ts
          from public.account_records r, acc
         where r.account_id = acc.id
           and r.collection = 'cash'
           and r.deleted_at is null
    ),
    day_sales_union as (
        -- 1) Ventas confirmadas en public.sales (excluye anuladas al instante)
        select s.device_id, s.total_usd
          from srv_sales s
         where not s.is_void
           and (s.ts at time zone p_tz)::date = (select d from day)
        union all
        -- 2) Ventas en account_records(cash) que no viven en public.sales (ej. Venta Libre / respaldo)
        --    y que tampoco estén anuladas en public.sales.
        select c.device_id, c.total_usd
          from cash_recs c
         where c.tipo in ('VENTA', 'VENTA_FIADA', 'VENTA_CASHEA')
           and c.status <> 'ANULADA'
           and (c.ts at time zone p_tz)::date = (select d from day)
           and not exists (
               select 1
                 from srv_sales s
                where (c.nube_sale_id is not null and s.sale_id = c.nube_sale_id)
                   or (c.local_id is not null and s.local_id = c.local_id)
           )
    ),
    sales_per_device as (
        select device_id,
               count(*)::int as ventas,
               coalesce(sum(total_usd), 0) as ventas_usd
          from day_sales_union
         group by device_id
    ),
    movements_per_device as (
        select c.device_id,
               coalesce(sum(c.total_usd) filter (
                   where c.tipo in ('COBRO_DEUDA', 'COBRO_CASHEA')
                     and c.status <> 'ANULADA'
                     and c.total_usd > 0
                     and (c.ts at time zone p_tz)::date = (select d from day)
               ), 0) as cobros_usd,
               coalesce(sum(-c.total_usd) filter (
                   where c.tipo in ('GASTO_INTERNO', 'PAGO_PROVEEDOR')
                     and c.status <> 'ANULADA'
                     and c.afecta_caja = true
                     and c.is_autoconsumo = false
                     and c.total_usd < 0
                     and (c.ts at time zone p_tz)::date = (select d from day)
               ), 0) as egresos_usd,
               coalesce(sum(c.total_usd) filter (
                   where c.tipo = 'APORTE_CAJA'
                     and c.status <> 'ANULADA'
                     and c.total_usd > 0
                     and (c.ts at time zone p_tz)::date = (select d from day)
               ), 0) as aportes_usd,
               max(c.ts) as max_cash_ts
          from cash_recs c
         group by c.device_id
    ),
    srv_activity as (
        select device_id, max(ts) as max_sale_ts
          from srv_sales
         group by device_id
    ),
    latest_shift_event as (
        select distinct on (c.device_id)
               c.device_id,
               c.tipo,
               c.caja_cerrada
          from cash_recs c
         where c.tipo in ('APERTURA_CAJA', 'REGISTRO_CIERRE')
           and c.status <> 'ANULADA'
         order by c.device_id,
                  c.ts desc,
                  -- Ante empate exacto de milisegundo, REGISTRO_CIERRE prevalece sobre APERTURA_CAJA
                  case when c.tipo = 'REGISTRO_CIERRE' then 0 else 1 end,
                  c.rec_id desc
    ),
    shared_mode as (
        select coalesce(nube_private.is_shared_cash_drawer(acc.id), false) as enabled
          from acc
    ),
    open_shared as (
        select coalesce(sh.opened_by_device_id, (select id from first_caja)) as device_id
          from public.shared_cash_shifts sh, acc
         where sh.account_id = acc.id
           and sh.status = 'open'
         limit 1
    )
    select ac.id as device_id,
           ac.label,
           ac.caja_letter,
           ac.sede_id,
           ac.sede_name,
           coalesce(sp.ventas, 0) as ventas,
           coalesce(sp.ventas_usd, 0) as ventas_usd,
           coalesce(mp.cobros_usd, 0) as cobros_usd,
           coalesce(mp.egresos_usd, 0) as egresos_usd,
           coalesce(mp.aportes_usd, 0) as aportes_usd,
           case
               when (select enabled from shared_mode) then exists (
                   select 1 from open_shared os where os.device_id = ac.id
               )
               else coalesce(lse.tipo = 'APERTURA_CAJA' and lse.caja_cerrada = false, false)
           end as caja_abierta,
           case
               when mp.max_cash_ts is null then sa.max_sale_ts
               when sa.max_sale_ts is null then mp.max_cash_ts
               else greatest(mp.max_cash_ts, sa.max_sale_ts)
           end as ultima_actividad
      from active_cajas ac
      left join sales_per_device sp on sp.device_id = ac.id
      left join movements_per_device mp on mp.device_id = ac.id
      left join srv_activity sa on sa.device_id = ac.id
      left join latest_shift_event lse on lse.device_id = ac.id
     order by ac.sede_name, ac.caja_letter;
$$;

revoke all on function public.cash_day_summary(date, text) from public, anon;
grant execute on function public.cash_day_summary(date, text) to authenticated;

-- Actualizar helper autoritativo de permisos RBAC en servidor con permisos operativos de caja.
create or replace function nube_private.has_permission(p_role text, p_permission text)
returns boolean language sql immutable set search_path = public as $$
    select case
        when p_role = 'dueno' then true
        when p_role = 'administrador' then p_permission in (
            'tab.dashboard', 'tab.sales', 'tab.products', 'tab.customers',
            'tab.suppliers', 'tab.reports', 'tab.settings',
            'sales.create', 'sales.void', 'sales.discount', 'sales.view_all_cajas',
            'sales.staff_goods', 'sales.free_amount', 'sales.cash_advance',
            'cash.manage', 'cash.expenses', 'rates.adjust',
            'products.edit', 'products.delete', 'products.view_cost', 'inventory.adjust',
            'customers.credit', 'customers.delete',
            'users.manage_staff'
        )
        when p_role = 'inventario' then p_permission in (
            'tab.products', 'tab.suppliers',
            'products.edit', 'inventory.adjust'
        )
        when p_role = 'cajero' then p_permission in (
            'tab.dashboard', 'tab.sales', 'tab.products', 'tab.customers',
            'sales.create', 'sales.staff_goods', 'sales.free_amount', 'sales.cash_advance',
            'customers.credit'
        )
        else false
    end;
$$;

notify pgrst, 'reload schema';
