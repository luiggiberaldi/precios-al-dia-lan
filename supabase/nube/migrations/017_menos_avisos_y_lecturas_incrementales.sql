-- Precios al Día Nube · 017 — Menos mensajes en vivo (S6) e índices para leer solo lo
-- cambiado (S5). Auditoría de sync del 2026-11-19 y de egress del 2026-11-16.
--
-- S6 · `account_records_touch` es por FILA: subir 200 registros escribía 200 veces la
-- fila de aviso de esa colección y cada caja recibía 200 mensajes en vivo (cuentan para
-- la cuota de Realtime). Ahora, dentro de una misma transacción, solo la primera fila
-- cambia `changed_at` (now() es fijo en la transacción); las demás no escriben nada, así
-- que no hay mensaje: UN aviso por colección y por subida.
-- Además, los registros de caja (`cash`) ya no avisan: cada caja sube lo suyo y ninguna
-- baja lo de otra, así que cada venta despertaba a todas las cajas para nada.
--
-- S5 · Las cajas ya no releen todo `stock_levels` ni todo `customer_balances`: piden lo
-- cambiado desde su última lectura (`updated_at`). Índices para que esa consulta no
-- recorra la tabla entera.
--
-- Idempotente. Vuelta atrás al final.

create index if not exists stock_levels_changes on public.stock_levels (account_id, sede_id, updated_at, product_id);
create index if not exists customer_balances_changes on public.customer_balances (account_id, updated_at, customer_id);

create or replace function nube_private.touch_sync_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.collection = 'cash' then
        return null;
    end if;
    insert into public.account_sync_state as s (account_id, collection, changed_at)
    values (new.account_id, new.collection, now())
    on conflict (account_id, collection) do update set changed_at = excluded.changed_at
        where s.changed_at is distinct from excluded.changed_at;
    return null;
end;
$$;

revoke all on function nube_private.touch_sync_state() from public, anon, authenticated;

-- ROLLBACK
-- drop index if exists public.stock_levels_changes, public.customer_balances_changes;
-- (volver a aplicar nube_private.touch_sync_state de 003)
