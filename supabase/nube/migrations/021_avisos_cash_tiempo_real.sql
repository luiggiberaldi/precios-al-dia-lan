-- Precios al Día Nube / LAN · 021 — Avisos en tiempo real para movimientos de caja (`cash`).
--
-- En 017 se silenció `touch_sync_state()` cuando `new.collection = 'cash'` porque
-- entonces cada caja trabajaba aislada. Ahora el Inicio («Por caja», «Ventas del día»,
-- resumen consolidado), Reportes («Todas las cajas») y el panel de Consulta/Supervisor
-- se actualizan en tiempo real al vender o cerrar turno en cualquier PC.
--
-- Mantiene la deduplicación por transacción (`s.changed_at is distinct from excluded.changed_at`)
-- para seguir emitiendo un solo aviso por subida aunque lleguen varios registros juntos.

create or replace function nube_private.touch_sync_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.account_sync_state as s (account_id, collection, changed_at)
    values (new.account_id, new.collection, now())
    on conflict (account_id, collection) do update set changed_at = excluded.changed_at
        where s.changed_at is distinct from excluded.changed_at;
    return null;
end;
$$;

revoke all on function nube_private.touch_sync_state() from public, anon, authenticated;
