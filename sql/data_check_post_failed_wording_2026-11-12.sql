-- Data check: only say "will not retry" for sales invoices that really will not retry. Re-runnable.
--
-- Problem (12 Nov 2026, Oliver): the 07:25 "Data check" email said 3 approved sales invoices (636613, 636738, 636730-2) "have a posting error and will not retry
-- on their own". They had failed once each with a Xero rate limit ("Try spacing your requests out") at the 5pm post on 11 Nov, when 26 invoices were posted in
-- one run. The poster (claim_approved_sales_invoices) takes every approved row with post_attempts < 3, so these retry at the next 5pm run. The message was wrong.
-- Fix: the check now only counts rows with post_attempts >= 3 (the ones the poster skips). Anything stuck longer is still caught by the 55 hour check.
-- The rate limit itself was handled in the n8n workflow WF6 (Check Duplicate (Post) and Create Xero Invoice (Post) batch interval 2600 ms to 6000 ms).
-- The full function is below; only the last "stuck" branch changed (the post_attempts >= 3 condition and the wording).

CREATE OR REPLACE FUNCTION public.data_freshness_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with t(name, schedule, last_ts, max_hours) as (
    values
      ('Orders from DecoNetwork (upcoming_orders)', 'WF3 order sync, hourly', (select max(synced_at) from public.upcoming_orders), 3),
      ('Order lines (sales_order_lines)', 'WF3 order sync, hourly', (select max(synced_at) from public.sales_order_lines), 3),
      ('WIP orders and revenue (wip_orders)', 'WF5, hourly', (select max(synced_at) from public.wip_orders), 3),
      ('Stock levels for the website (sku_inventory)', 'stock feed, every 3 hours', (select max(updated_at) from public.sku_inventory), 7),
      ('PO costs (sku_costs)', 'PO costs sync, every 3 hours', (select max(updated_at) from public.sku_costs), 7),
      ('Purchase orders (purchase_orders)', 'PO sync, every 3 hours', (select max(synced_at) from public.purchase_orders), 7),
      ('Stock value (inventory_value)', 'stock merge, every 3 hours', (select max(updated_at) from public.inventory_value), 7),
      ('Ralawise stock (ralawise_stock)', 'Ralawise sync', (select max(updated_at) from public.ralawise_stock), 13),
      ('Portwest stock (portwest_stock)', 'Portwest sync', (select max(updated_at) from public.portwest_stock), 13)
  ),
  stale_tables as (
    select jsonb_build_object(
      'what', name,
      'detail', case when last_ts is null then 'no data at all'
                     else 'last updated ' || round((extract(epoch from (now() - last_ts)) / 3600)::numeric, 1)
                          || ' hours ago, but it should refresh at least every ' || max_hours || ' hours (' || schedule || ')' end
    ) as p
    from t
    where last_ts is null or now() - last_ts > make_interval(hours => max_hours)
  ),
  stuck as (
    select jsonb_build_object(
      'what', 'Purchase bills approved but not posted to Xero',
      'detail', count(*) || ' bill(s) approved for over 27 hours; the 5pm poster should have posted them (oldest: '
                || to_char(min(updated_at) at time zone 'Europe/London', 'DD Mon HH24:MI') || ')'
    ) as p
    from public.pending_invoices
    where status = 'approved' and xero_bill_id is null and updated_at < now() - interval '27 hours'
    having count(*) > 0
    union all
    select jsonb_build_object(
      'what', 'Sales invoices approved but not posted to Xero',
      'detail', count(*) || ' invoice(s) approved for over 55 hours; the 5pm poster (Mon-Sat) should have posted them (oldest: '
                || to_char(min(updated_at) at time zone 'Europe/London', 'DD Mon HH24:MI') || ')'
    )
    from public.pending_sales_invoices
    where status = 'approved' and updated_at < now() - interval '55 hours'
    having count(*) > 0
    union all
    -- 12 Nov 2026: only rows that have failed 3 times are skipped by the poster (claim_approved_sales_invoices takes post_attempts < 3), so only those "will not retry".
    -- One or two failures (for example a Xero rate limit) are retried by the next 5pm run and the 55 hour check above covers anything stuck for longer.
    select jsonb_build_object(
      'what', 'Sales invoices that failed to post to Xero',
      'detail', count(*) || ' approved invoice(s) failed to post 3 times and will not retry on their own (e.g. order '
                || min(order_id) || ': ' || left(coalesce(min(post_error), ''), 160) || ')'
    )
    from public.pending_sales_invoices
    where status = 'approved' and post_error is not null and post_attempts >= 3 and updated_at < now() - interval '1 hour'
    having count(*) > 0
  )
  select jsonb_build_object(
    'checked_at', now(),
    'tables_checked', (select count(*) from t),
    'problem_count', (select count(*) from stale_tables) + (select count(*) from stuck),
    'problems', coalesce((select jsonb_agg(p) from (select p from stale_tables union all select p from stuck) x), '[]'::jsonb)
  );
$function$;
