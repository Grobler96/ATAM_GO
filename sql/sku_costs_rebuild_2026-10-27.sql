-- Supplier costs: refresh sku_costs from the purchase orders already stored in
-- purchase_orders (latest positive unit price per SKU). Same rule as the
-- po_line_cost_fallback view. Called by the n8n job "DecoNetwork PO Costs".
-- Never lowers an existing cost date: an older PO cannot overwrite a newer cost.
create or replace function public.rebuild_sku_costs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  with latest as (
    select distinct on (sku) sku, product_name, unit_price, date_raised
    from (
      select po.date_raised,
             line.value ->> 'sku' as sku,
             line.value ->> 'product_name' as product_name,
             (line.value ->> 'unit_price')::numeric as unit_price
      from purchase_orders po,
           lateral jsonb_array_elements(po.lines) line(value)
      where coalesce(line.value ->> 'sku', '') <> ''
        and (line.value ->> 'unit_price') is not null
        and (line.value ->> 'unit_price')::numeric > 0
    ) x
    order by sku, date_raised desc
  ), up as (
    insert into sku_costs (sku, product_name, unit_cost, last_cost_date, updated_at)
    select sku, product_name, unit_price, date_raised, now() from latest
    on conflict (sku) do update
      set unit_cost = excluded.unit_cost,
          product_name = coalesce(excluded.product_name, sku_costs.product_name),
          last_cost_date = excluded.last_cost_date,
          updated_at = now()
      where sku_costs.last_cost_date is null
         or excluded.last_cost_date >= sku_costs.last_cost_date
    returning 1
  )
  select count(*) into n from up;
  return n;
end $$;

revoke all on function public.rebuild_sku_costs() from public, anon, authenticated;
grant execute on function public.rebuild_sku_costs() to service_role;
