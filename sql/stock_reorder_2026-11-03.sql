-- Suggested reorder list for the garments we actually keep in stock. Re-runnable.
--
-- ATAM mostly buys garments per job, so only SKUs that are genuinely HELD are considered: a SKU counts as held if it had stock in at least 14 of the
-- daily stock snapshots since July (inventory_value_history). Of those, only SKUs used on at least 2 orders approved in the last 70 days are looked at.
-- Usage = units on those orders' lines (sales_order_lines.qty_required, order date = quotes.approved_at, because the lines' own created_at is the date
-- the sync first saw them). Weekly usage = 70-day total / 10. Cover = stock on hand / weekly usage, in weeks.
--   out  = nothing on hand;   low = under 3 weeks of cover;   a suggestion is made for those only.
-- Suggested quantity = enough to reach 6 weeks of cover (6 x weekly usage - on hand), rounded up. Estimated cost = quantity x the latest unit cost (sku_costs).
-- It does NOT know supplier minimums, pack sizes, prices, what is already on order, or what is allocated to open jobs (working stock is shown for information):
-- a person checks it before ordering. Nothing is ordered from here. Read only, security invoker.

create or replace function public.stock_reorder_suggestions()
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v_out jsonb;
begin
  with
  held as (select sku from inventory_value_history where qty_on_hand > 0 group by sku having count(distinct snapshot_date) >= 14),
  usage as (
    select l.sku, sum(l.qty_required)::int as q70, count(distinct l.order_id)::int as n_orders
      from sales_order_lines l join quotes q on q.order_id = l.order_id
     where q.approved_at >= now() - interval '70 days' and l.sku is not null
     group by l.sku having count(distinct l.order_id) >= 2),
  inv as (select sku, max(product_name) as product_name, max(color) as color, max(size) as size, sum(qty_on_hand)::int as oh from sku_inventory group by sku),
  base as (
    select u.sku, i.product_name, i.color, i.size, coalesce(i.oh, 0) as on_hand, u.q70, u.n_orders,
           coalesce(w.working_stock_qty, 0) as allocated, c.unit_cost,
           (u.q70 / 10.0) as weekly
      from usage u join held h on h.sku = u.sku
      left join inv i on i.sku = u.sku
      left join sku_working_stock w on w.sku = u.sku
      left join sku_costs c on c.sku = u.sku),
  scored as (
    select b.*, case when b.on_hand <= 0 then 'out' when b.on_hand / nullif(b.weekly, 0) < 3 then 'low' else 'ok' end as status,
           round((b.on_hand / nullif(b.weekly, 0))::numeric, 1) as cover_weeks,
           greatest(1, ceil(b.weekly * 6 - b.on_hand))::int as suggest_qty
      from base b)
  select coalesce(jsonb_agg(jsonb_build_object(
           'sku', sku, 'product', product_name, 'color', color, 'size', size, 'on_hand', on_hand, 'used_70d', q70, 'orders', n_orders,
           'allocated', allocated, 'cover_weeks', cover_weeks, 'status', status, 'suggest_qty', suggest_qty, 'unit_cost', unit_cost,
           'est_cost', case when unit_cost is null then null else round(suggest_qty * unit_cost, 2) end)
         order by (case status when 'out' then 0 else 1 end), cover_weeks nulls first, q70 desc), '[]'::jsonb)
    into v_out from scored where status in ('out', 'low');
  return v_out;
end $$;
revoke all on function public.stock_reorder_suggestions() from public, anon;
grant execute on function public.stock_reorder_suggestions() to authenticated, service_role;
