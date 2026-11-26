-- Precios al Día Nube · F4 — Fiados, abonos y billetera en el servidor.
--
-- El saldo de cada cliente (deuda o saldo a favor) es la SUMA de su libro, calculada
-- en el servidor. Un fiado en la sede A y un abono en la sede B al mismo tiempo no se
-- pisan: cada uno es una línea y el saldo se actualiza en la misma transacción con
-- bloqueo de fila (E5). Libro de solo agregar (G6): se corrige con una ANULACION.
--
-- Mismo modelo que bodega_customer_ledger_v1 (src/utils/customerLedger.js):
--   saldo = favor − deuda. CREDIT suma (abono, vuelto a billetera, devolución, ajuste a
--   favor, saldo inicial); DEBIT resta (venta fiada, uso de saldo a favor, ajuste en contra).
--
-- Idempotente. Vuelta atrás al final.

create table if not exists public.customer_movements (
    id              text primary key check (length(id) between 1 and 120),
    account_id      uuid not null references public.accounts(id) on delete cascade,
    customer_id     text not null check (length(customer_id) between 1 and 120),
    type            text not null check (type in ('SALDO_INICIAL_MIGRADO', 'ABONO_DEUDA', 'VENTA_FIADA', 'SALDO_FAVOR_USADO',
                                                  'VUELTO_ACREDITADO', 'DEVOLUCION_A_FAVOR', 'AJUSTE_CREDITO', 'AJUSTE_DEBITO', 'ANULACION')),
    direction       text not null check (direction in ('CREDIT', 'DEBIT')),
    amount_usd      numeric(14, 2) not null check (amount_usd >= 0),
    balance_after   numeric(14, 2) not null,     -- saldo del cliente tras esta línea (lo calcula el servidor)
    source_type     text,
    source_id       text,
    source_sale_id  text,
    reversal_of     text,
    reason          text check (reason is null or length(reason) <= 300),
    sede_id         uuid references public.sedes(id),
    device_id       text references public.account_devices(id),
    member_id       uuid references public.account_members(id),
    device_at       timestamptz,
    server_at       timestamptz not null default now(),
    seq             bigserial
);
create index if not exists customer_movements_customer on public.customer_movements (account_id, customer_id, seq);
create index if not exists customer_movements_since on public.customer_movements (account_id, seq);

create table if not exists public.customer_balances (
    account_id      uuid not null references public.accounts(id) on delete cascade,
    customer_id     text not null,
    balance_usd     numeric(14, 2) not null default 0,
    updated_at      timestamptz not null default now(),
    primary key (account_id, customer_id)
);

create or replace function nube_private.reject_customer_ledger_change()
returns trigger language plpgsql set search_path = public as $$
begin
    raise exception 'El libro de clientes no se edita ni se borra: registra una ANULACION.' using errcode = '42501';
end;
$$;

drop trigger if exists customer_movements_no_change on public.customer_movements;
create trigger customer_movements_no_change before update or delete on public.customer_movements
    for each row execute function nube_private.reject_customer_ledger_change();

alter table public.customer_movements enable row level security;
alter table public.customer_balances  enable row level security;
revoke all on public.customer_movements, public.customer_balances from anon, authenticated;
grant select on public.customer_movements, public.customer_balances to authenticated;

drop policy if exists customer_movements_read on public.customer_movements;
create policy customer_movements_read on public.customer_movements for select to authenticated using (account_id = nube_private.my_account_id());
drop policy if exists customer_balances_read on public.customer_balances;
create policy customer_balances_read on public.customer_balances for select to authenticated using (account_id = nube_private.my_account_id());

-- Sube movimientos de clientes (cualquier empleado con sesión; el dueño sin PIN al importar).
-- p_movements = [{ "id", "customer_id", "type", "direction"?, "amount_usd", "source_type"?, "source_id"?,
--                  "source_sale_id"?, "reversal_of"?, "reason"?, "device_at"? }, ...]
-- Reenviar un id ya registrado responde already_registered (G7). El servidor ignora el
-- saldo que calculó el equipo y pone el suyo (balance_after).
create or replace function public.push_customer_movements(p_session uuid, p_movements jsonb)
returns table (id text, customer_id text, balance_after numeric, already_registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_account uuid; v_member uuid; v_device text; v_sede uuid;
    v_m jsonb; v_id text; v_cust text; v_type text; v_dir text; v_amount numeric; v_balance numeric;
    v_existing public.customer_movements;
begin
    if p_session is not null then
        select c.account_id, c.member_id, c.device_id, c.sede_id into v_account, v_member, v_device, v_sede
        from nube_private.session_context(p_session) c;
        if v_account is null then raise exception 'Tu sesión venció. Vuelve a entrar con tu PIN.' using errcode = '42501'; end if;
    else
        v_account := nube_private.owner_account_id();
        if v_account is null then raise exception 'Solo el dueño o un empleado con sesión' using errcode = '42501'; end if;
        select m.id into v_member from public.account_members m where m.account_id = v_account and m.role = 'dueno';
    end if;
    if jsonb_typeof(p_movements) <> 'array' or jsonb_array_length(p_movements) > 500 then
        raise exception 'Envía de 0 a 500 movimientos' using errcode = '22023';
    end if;

    for v_m in select * from jsonb_array_elements(p_movements) loop
        v_id := v_m ->> 'id';
        v_cust := v_m ->> 'customer_id';
        v_type := v_m ->> 'type';
        v_amount := round((v_m ->> 'amount_usd')::numeric, 2);
        if coalesce(v_id, '') = '' or coalesce(v_cust, '') = '' or v_type is null or v_amount is null or v_amount < 0 then
            raise exception 'Movimiento de cliente inválido' using errcode = '22023';
        end if;

        select * into v_existing from public.customer_movements cm where cm.id = v_id;
        if found then
            if v_existing.account_id <> v_account then raise exception 'Movimiento de otra cuenta' using errcode = '42501'; end if;
            return query select v_existing.id, v_existing.customer_id, v_existing.balance_after, true;
            continue;
        end if;

        v_dir := coalesce(v_m ->> 'direction', case
            when v_type in ('SALDO_INICIAL_MIGRADO', 'ABONO_DEUDA', 'VUELTO_ACREDITADO', 'DEVOLUCION_A_FAVOR', 'AJUSTE_CREDITO') then 'CREDIT'
            when v_type in ('VENTA_FIADA', 'SALDO_FAVOR_USADO', 'AJUSTE_DEBITO') then 'DEBIT'
        end);
        if v_dir is null then raise exception 'La anulación necesita su dirección (CREDIT o DEBIT)' using errcode = '22023'; end if;

        -- Bloqueo de la fila de saldo del cliente: dos cajas a la vez se ordenan aquí (E5).
        insert into public.customer_balances (account_id, customer_id, balance_usd) values (v_account, v_cust, 0) on conflict do nothing;
        select b.balance_usd into v_balance from public.customer_balances b
         where b.account_id = v_account and b.customer_id = v_cust for update;
        v_balance := v_balance + case when v_dir = 'CREDIT' then v_amount else -v_amount end;
        update public.customer_balances b set balance_usd = v_balance, updated_at = now()
         where b.account_id = v_account and b.customer_id = v_cust;

        insert into public.customer_movements (id, account_id, customer_id, type, direction, amount_usd, balance_after,
            source_type, source_id, source_sale_id, reversal_of, reason, sede_id, device_id, member_id, device_at)
        values (v_id, v_account, v_cust, v_type, v_dir, v_amount, v_balance,
            v_m ->> 'source_type', v_m ->> 'source_id', v_m ->> 'source_sale_id', v_m ->> 'reversal_of', left(v_m ->> 'reason', 300),
            v_sede, v_device, v_member, (v_m ->> 'device_at')::timestamptz);

        return query select v_id, v_cust, v_balance, false;
    end loop;
end;
$$;

revoke all on function public.push_customer_movements(uuid, jsonb) from public, anon;
grant execute on function public.push_customer_movements(uuid, jsonb) to authenticated;
revoke all on function nube_private.reject_customer_ledger_change() from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customer_balances') then
        alter publication supabase_realtime add table public.customer_balances;
    end if;
end $$;

-- ROLLBACK
-- alter publication supabase_realtime drop table public.customer_balances;
-- drop function if exists public.push_customer_movements(uuid, jsonb);
-- drop trigger if exists customer_movements_no_change on public.customer_movements;
-- drop function if exists nube_private.reject_customer_ledger_change();
-- drop table if exists public.customer_balances, public.customer_movements;
