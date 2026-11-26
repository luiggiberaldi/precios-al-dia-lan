-- 013 · Estadísticas de ventas por equipo para la Estación Maestra
--
-- La pestaña Nube de la Estación bajaba todas las filas de `sales` para contar
-- ventas por equipo. PostgREST corta cada lectura en 1000 filas, así que al
-- pasar de 1000 ventas los conteos quedaban mal sin avisar, y además se movían
-- datos de más. Esta función devuelve solo el conteo y la última venta de cada
-- equipo, ya calculados en la base. No cuenta las ventas anuladas.
--
-- Solo la llama la Estación con la llave service_role; las apps no la ven.
-- No cambia ni borra datos.

create or replace function public.estacion_device_sales_stats(p_account_id uuid default null)
returns table (device_id text, sales_count bigint, last_sale_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.device_id, count(*)::bigint, max(s.server_at)
    from public.sales s
   where s.status <> 'anulada'
     and (p_account_id is null or s.account_id = p_account_id)
   group by s.device_id
$$;

revoke all on function public.estacion_device_sales_stats(uuid) from public, anon, authenticated;
grant execute on function public.estacion_device_sales_stats(uuid) to service_role;
