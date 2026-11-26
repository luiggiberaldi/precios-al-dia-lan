-- Borra SOLO los datos de la medición de egress (prefijo egtest-) en nube-pruebas.
-- Los libros (stock_movements, customer_movements) rechazan borrar: se apaga su
-- disparador dentro de la transacción y se vuelve a encender. NUNCA en producción.
begin;
alter table public.stock_movements disable trigger stock_movements_no_change;
alter table public.customer_movements disable trigger customer_movements_no_change;

delete from public.stock_discrepancies where product_id like 'egtest-%';
delete from public.stock_movements where product_id like 'egtest-%';
delete from public.stock_levels where product_id like 'egtest-%';
delete from public.customer_movements where customer_id like 'egtest-%';
delete from public.customer_balances where customer_id like 'egtest-%';
delete from public.account_records where id like 'egtest-%';

alter table public.stock_movements enable trigger stock_movements_no_change;
alter table public.customer_movements enable trigger customer_movements_no_change;
commit;
