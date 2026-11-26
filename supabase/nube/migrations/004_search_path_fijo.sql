-- Precios al Día Nube · F2 — search_path fijo en strip_ledger_fields
-- (aviso «function_search_path_mutable» del asesor de seguridad de Supabase tras 003).
-- Idempotente.

alter function nube_private.strip_ledger_fields(text, jsonb) set search_path = public;

-- ROLLBACK
-- alter function nube_private.strip_ledger_fields(text, jsonb) reset search_path;
