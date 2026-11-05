-- Real job profit: per-job revenue, garment cost and decoration (stitch) data pulled from DecoNetwork orders. Re-runnable.
--
-- DecoNetwork's order data (the same call the production capture workflow already makes, with workflow data included) carries, for every order line:
--   the price charged (total_price, ex VAT, garments plus decoration), the quantity, each size's garment cost (option cost), the supplier,
--   and for every decoration area its process and stitch_count. The n8n workflow "WF1_Capture Production Completions" now also writes those into
--   job_orders (one row per order) and job_lines (one row per order line). Writes are service role only; signed-in users can read.
-- job_settings holds the three production assumptions (one row), set only by Daniel or Oliver:
--   minutes_per_item     handling time per garment, default 3 (Daniel: "roughly a few minutes per item"),
--   stitches_per_minute  embroidery speed, default 700,
--   cost_per_hour        what an hour of production costs (labour + machine). NULL until someone enters the real figure: until then the page shows
--                        profit after garments only and does not guess a production cost.
-- job_profit(from, to) returns the orders shipped in the range with revenue, garment cost, pieces, stitches, estimated production minutes and margins.

create table if not exists public.job_orders (
  order_id text primary key,
  customer_id text,
  customer_name text,
  store_name text,
  assigned_to text,
  order_type integer,
  order_status integer,
  date_ordered timestamptz,
  date_due timestamptz,
  date_produced timestamptz,
  date_shipped timestamptz,
  date_modified timestamptz,
  item_amount numeric,
  shipping_amount numeric,
  discount_amount numeric,
  billable_amount numeric,
  synced_at timestamptz not null default now()
);
create table if not exists public.job_lines (
  order_id text not null,
  line_id text not null,
  product_code text,
  product_name text,
  supplier text,
  colour text,
  qty integer,
  line_total numeric,
  unit_price numeric,
  discount numeric,
  garment_cost_unit numeric,       -- cost-weighted average across the sizes on this line; null if DecoNetwork has no cost for it
  garment_cost_total numeric,
  decoration_unit_price numeric,
  processes text[],
  emb_areas integer not null default 0,
  other_areas integer not null default 0,
  stitches_per_piece integer not null default 0,   -- sum of the stitch counts of the line's embroidery areas
  synced_at timestamptz not null default now(),
  primary key (order_id, line_id)
);
create index if not exists job_orders_shipped on public.job_orders (date_shipped);
alter table public.job_orders enable row level security;
alter table public.job_lines enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'job_orders' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.job_orders for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_lines' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.job_lines for select to authenticated using (true);
  end if;
end $$;
revoke all on public.job_orders, public.job_lines from anon, authenticated;
grant select on public.job_orders, public.job_lines to authenticated;

create table if not exists public.job_settings (
  id int primary key default 1 check (id = 1),
  minutes_per_item numeric not null default 3 check (minutes_per_item >= 0 and minutes_per_item <= 120),
  stitches_per_minute numeric not null default 700 check (stitches_per_minute >= 50 and stitches_per_minute <= 5000),
  cost_per_hour numeric check (cost_per_hour is null or (cost_per_hour >= 0 and cost_per_hour <= 500)),
  set_by text,
  set_at timestamptz not null default now()
);
insert into public.job_settings (id) values (1) on conflict do nothing;
alter table public.job_settings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'job_settings' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.job_settings for select to authenticated using (true);
  end if;
end $$;
revoke all on public.job_settings from anon, authenticated;
grant select on public.job_settings to authenticated;
create or replace trigger scrub_assistant_name before insert or update on public.job_settings
  for each row execute function public.scrub_assistant_name_trg('set_by');

create or replace function public.set_job_settings(p_minutes numeric, p_stitches numeric, p_cost_per_hour numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.can_set_sales_targets() then raise exception 'only Daniel or Oliver can change these'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  update job_settings set minutes_per_item = coalesce(p_minutes, minutes_per_item), stitches_per_minute = coalesce(p_stitches, stitches_per_minute),
    cost_per_hour = p_cost_per_hour, set_by = v_name, set_at = now() where id = 1;
end $$;
revoke all on function public.set_job_settings(numeric, numeric, numeric) from public, anon;
grant execute on function public.set_job_settings(numeric, numeric, numeric) to authenticated;

-- Orders shipped between the two dates (UK dates), with margins. Cancelled orders and orders with no value are left out.
create or replace function public.job_profit(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v_set job_settings%rowtype; v_out jsonb;
begin
  select * into v_set from job_settings where id = 1;
  with
  l as (
    select order_id,
           sum(qty)::int as pieces,
           sum(garment_cost_total) as garment_cost,
           count(*) filter (where garment_cost_total is null) as lines_no_cost,
           count(*) as n_lines,
           sum(qty * stitches_per_piece)::bigint as stitches,
           sum(qty) filter (where emb_areas > 0)::int as emb_pieces,
           sum(qty) filter (where other_areas > 0 and emb_areas = 0)::int as other_deco_pieces
      from job_lines group by order_id),
  o as (
    select jo.order_id, jo.customer_name, jo.assigned_to, jo.date_ordered, jo.date_shipped, jo.item_amount, jo.shipping_amount,
           l.pieces, l.garment_cost, l.lines_no_cost, l.n_lines, coalesce(l.stitches, 0) as stitches, coalesce(l.emb_pieces, 0) as emb_pieces
      from job_orders jo join l on l.order_id = jo.order_id
     where jo.date_shipped is not null and (jo.date_shipped at time zone 'Europe/London')::date between p_from and p_to
       and jo.order_status is distinct from 4 and coalesce(jo.item_amount, 0) > 0),
  m as (
    select o.*, round(o.item_amount - coalesce(o.garment_cost, 0), 2) as margin_garments,
           round((coalesce(o.pieces, 0) * v_set.minutes_per_item + o.stitches / v_set.stitches_per_minute)::numeric, 1) as prod_minutes
      from o)
  select jsonb_build_object(
    'settings', jsonb_build_object('minutes_per_item', v_set.minutes_per_item, 'stitches_per_minute', v_set.stitches_per_minute, 'cost_per_hour', v_set.cost_per_hour, 'set_by', v_set.set_by, 'set_at', v_set.set_at),
    'from', p_from, 'to', p_to,
    'jobs', coalesce((select jsonb_agg(jsonb_build_object(
        'order_id', m.order_id, 'customer', m.customer_name, 'rep', m.assigned_to, 'shipped', m.date_shipped,
        'revenue', m.item_amount, 'garment_cost', m.garment_cost, 'lines_no_cost', m.lines_no_cost, 'lines', m.n_lines, 'pieces', m.pieces,
        'stitches', m.stitches, 'emb_pieces', m.emb_pieces, 'margin_garments', m.margin_garments, 'prod_minutes', m.prod_minutes,
        'prod_cost', case when v_set.cost_per_hour is null then null else round(m.prod_minutes / 60.0 * v_set.cost_per_hour, 2) end)
        order by m.date_shipped desc) from m), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'orders_with_lines', (select count(*) from o),
      'orders_shipped_in_range', (select count(*) from job_orders jo where jo.date_shipped is not null and (jo.date_shipped at time zone 'Europe/London')::date between p_from and p_to and jo.order_status is distinct from 4),
      'first_order_synced', (select min(date_shipped) from job_orders))
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.job_profit(date, date) from public, anon;
grant execute on function public.job_profit(date, date) to authenticated, service_role;
