-- Precios al Día Nube · Arnés A7 — Revisor de cuadres (solo lectura).
--
-- Devuelve una fila por cada cosa que NO cuadra. Vacío = todo bien.
--   · stock: el nivel de cada producto y sede debe ser la suma de su libro;
--   · cartera: el saldo de cada cliente debe ser la suma de su libro;
--   · venta_sin_movimientos: toda venta completada o anulada dejó sus líneas VENTA;
--   · movimiento_sin_venta: toda línea VENTA/ANULACION apunta a una venta que existe;
--   · diferencias_abiertas: sobreventas sin internet pendientes (informativo, E4).
-- Solo service_role (se corre a diario desde el servidor o a mano en el SQL Editor).
-- Idempotente. Vuelta atrás al final.

create or replace function nube_private.verify_invariants()
returns table (check_name text, account_id uuid, detail jsonb)
language sql stable security definer set search_path = public as $$
    select 'stock', l.account_id,
           jsonb_build_object('sede_id', l.sede_id, 'product_id', l.product_id, 'nivel', l.qty, 'libro', coalesce(m.s, 0))
    from public.stock_levels l
    left join lateral (select sum(qty) s from public.stock_movements x
                       where x.account_id = l.account_id and x.sede_id = l.sede_id and x.product_id = l.product_id) m on true
    where l.qty <> coalesce(m.s, 0)
    union all
    select 'cartera', b.account_id,
           jsonb_build_object('customer_id', b.customer_id, 'saldo', b.balance_usd, 'libro', coalesce(m.s, 0))
    from public.customer_balances b
    left join lateral (select sum(case when direction = 'CREDIT' then amount_usd else -amount_usd end) s
                       from public.customer_movements x where x.account_id = b.account_id and x.customer_id = b.customer_id) m on true
    where b.balance_usd <> coalesce(m.s, 0)
    union all
    select 'venta_sin_movimientos', s.account_id, jsonb_build_object('sale_id', s.id, 'number', s.number)
    from public.sales s
    where not exists (select 1 from public.stock_movements x where x.account_id = s.account_id and x.reference = s.id::text and x.reason = 'VENTA')
    union all
    select 'movimiento_sin_venta', x.account_id, jsonb_build_object('movement_id', x.id, 'reference', x.reference, 'reason', x.reason)
    from public.stock_movements x
    where x.reason in ('VENTA', 'ANULACION')
      and not exists (select 1 from public.sales s where s.id::text = x.reference)
    union all
    select 'diferencias_abiertas', d.account_id, jsonb_build_object('pendientes', count(*))
    from public.stock_discrepancies d where d.resolved_at is null
    group by d.account_id;
$$;

revoke all on function nube_private.verify_invariants() from public, anon, authenticated;
grant usage on schema nube_private to service_role;
grant execute on function nube_private.verify_invariants() to service_role;

-- ROLLBACK
-- drop function if exists nube_private.verify_invariants();
