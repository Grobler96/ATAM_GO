-- Customer reorder metrics rebuild (23 Oct 2026; applied to Supabase project aobosyvlhgkxhjxkfzlz).
--
-- Why: customer_reorder_metrics (which feeds the Win-back tab and DAN's overdue alerts) had not been refreshed since 30 June 2026,
-- so 211 of the 213 customers flagged At Risk / Due Soon had in fact ordered since. The old n8n workflow also tried to hold every
-- order in memory and crashed. Now the n8n workflow "Sync customer reorder metrics (DecoNetwork to Supabase, nightly)" saves each
-- page of DecoNetwork orders into deco_orders_raw as it arrives, then calls rebuild_customer_reorder_metrics(), which works out the
-- figures here with the same rules the workflow used:
--   counted orders: order_type 0 or 3, order_status 1, 2 or 3, payment_status 4, 5 or 9, with a customer id and an order date
--   an "order event" = orders within 7 days of the first order of that event; reorder gap = days between event starts
--   mean_reorder_days = average gap (rounded), overdue_threshold_days = mean x 1.25 (rounded)
--   name / company / email / last order fields come from the customer's latest counted order
-- suppress_alerts, status_override and notes are never touched. A backup of the table before the rebuild is in
-- customer_reorder_metrics_backup_2026_10_23 (no access for the website; drop it once the new numbers are trusted).

create table if not exists public.deco_orders_raw (
  order_id       text primary key,
  customer_id    text,
  name           text,
  company        text,
  email          text,
  order_type     int,
  order_status   int,
  payment_status int,
  date_ordered   text,
  billable_amount numeric,
  order_summary  text,
  synced_at      timestamptz not null default now()
);
alter table public.deco_orders_raw enable row level security;
revoke all on public.deco_orders_raw from anon, authenticated;

create or replace function public.rebuild_customer_reorder_metrics()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record; anchor timestamp; starts timestamp[]; i int; n int := 0; mean numeric;
begin
  for r in
    select customer_id,
           array_agg(d order by d) ds,
           (array_agg(order_id order by d desc))[1] last_id,
           (array_agg(coalesce(name, '') order by d desc))[1] last_name,
           (array_agg(coalesce(company, '') order by d desc))[1] last_company,
           (array_agg(coalesce(email, '') order by d desc))[1] last_email,
           (array_agg(coalesce(order_summary, '') order by d desc))[1] last_summary,
           (array_agg(coalesce(billable_amount, 0) order by d desc))[1] last_value
    from (
      select customer_id, order_id, name, company, email, order_summary, billable_amount, nullif(date_ordered, '')::timestamp d
      from deco_orders_raw
      where order_type in (0, 3) and order_status in (1, 2, 3) and payment_status in (4, 5, 9)
        and coalesce(customer_id, '') <> '' and coalesce(date_ordered, '') <> ''
    ) v
    group by customer_id
  loop
    anchor := r.ds[1]; starts := array[anchor];
    for i in 2 .. array_length(r.ds, 1) loop
      if extract(epoch from (r.ds[i] - anchor)) / 86400 > 7 then anchor := r.ds[i]; starts := starts || anchor; end if;
    end loop;
    mean := null;
    if array_length(starts, 1) >= 2 then
      select avg(extract(epoch from (starts[g] - starts[g - 1])) / 86400) into mean from generate_series(2, array_length(starts, 1)) g;
    end if;
    insert into customer_reorder_metrics (customer_id, name, company, email, total_orders, grouped_order_events, first_order_date, last_order_date,
                                          mean_reorder_days, overdue_threshold_days, last_order_id, last_order_summary, last_order_value, synced_at, updated_at)
    values (r.customer_id, r.last_name, r.last_company, r.last_email, array_length(r.ds, 1), array_length(starts, 1), r.ds[1]::date, r.ds[array_length(r.ds, 1)]::date,
            case when mean is null then null else round(mean)::int end,
            case when mean is null or mean = 0 then null else round(mean * 1.25)::int end,
            r.last_id, r.last_summary, r.last_value, now(), now())
    on conflict (customer_id) do update set
      name = excluded.name, company = excluded.company, email = excluded.email, total_orders = excluded.total_orders,
      grouped_order_events = excluded.grouped_order_events, first_order_date = excluded.first_order_date, last_order_date = excluded.last_order_date,
      mean_reorder_days = excluded.mean_reorder_days, overdue_threshold_days = excluded.overdue_threshold_days, last_order_id = excluded.last_order_id,
      last_order_summary = excluded.last_order_summary, last_order_value = excluded.last_order_value, synced_at = now(), updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.rebuild_customer_reorder_metrics() from public, anon, authenticated;
grant execute on function public.rebuild_customer_reorder_metrics() to service_role;
