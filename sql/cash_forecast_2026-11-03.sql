-- Cash forecast: money expected in and supplier bills due out over the next 8 weeks, plus the overdue invoices to chase. Re-runnable.
--
-- MONEY IN. Open sales invoices (Xero, approved, amount still due). When a customer pays is estimated from how invoices have actually been paid
-- over the last 12 months: days between the due date and the day the invoice was marked paid (xero_updated_at of PAID invoices, a close
-- stand-in because the payments table is empty). About 46% were paid on or before the due date and about 10% more than 30 days late.
--   * not yet due: its pay date is spread over the historical pattern (due date + each lateness seen);
--   * (an invoice that is still unpaid today can only be paid from today on, so only paid invoices that were also still unpaid at the same point are used);
--   * already overdue by k days: only the invoices that were also still unpaid at k days late are used. If fewer than 30 such invoices exist
--     (very old invoices) it is left out of the forecast and shown as "unlikely".
-- Everything is weighted: an invoice of 1,000 that has a 40% chance of being paid in a week adds 400 to that week.
-- MONEY OUT. Supplier bills posted to Xero from ATAM GO (pending_invoices, status posted) whose due date is today or later. We do NOT know whether a
-- bill has already been paid in Xero, and bills posted before mid August 2026 are not here, so this is a partial view, not a bank forecast.
-- There is no bank balance, wages, rent or VAT in here.
-- Read only, security invoker. cash_forecast() returns one JSON object.

create or replace function public.cash_forecast(p_today date default (now() at time zone 'Europe/London')::date)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_week0 date := date_trunc('week', p_today)::date;
  v_out jsonb;
begin
  with
  paid as (
    select ((d.xero_updated_at at time zone 'Europe/London')::date - d.due_date) as lat
      from xero_sales_documents d
     where d.doc_type = 'invoice' and d.status = 'PAID' and d.doc_date >= p_today - interval '12 months'
       and d.due_date is not null and d.total > 0),
  hist as (select greatest(-60, least(150, lat))::int as lat, count(*)::numeric as c from paid group by 1),
  openinv as (
    select d.xero_id, d.xero_contact_name as customer, d.doc_number, d.due_date, d.amount_due,
           (p_today - d.due_date) as k, greatest(0, p_today - d.due_date) as days_over
      from xero_sales_documents d
     where d.doc_type = 'invoice' and d.status = 'AUTHORISED' and d.amount_due > 0 and d.due_date is not null),
  base as (select o.*, (select coalesce(sum(c), 0) from hist h where h.lat >= o.k) as n_ok from openinv o),
  spread as (
    select b.xero_id, b.amount_due, (b.due_date + h.lat) as pay_date, h.c / nullif(b.n_ok, 0) as p
      from base b join hist h on h.lat >= b.k
     where b.n_ok >= 30),
  weeks as (select g as k, (v_week0 + g * 7) as w_start from generate_series(0, 7) g),
  inw as (
    select w.k, coalesce(sum(s.amount_due * s.p) filter (where s.pay_date >= greatest(w.w_start, p_today) and s.pay_date < w.w_start + 7), 0) as v
      from weeks w left join spread s on true group by w.k),
  outw as (
    select w.k, coalesce(sum(coalesce(i.final_total, i.extracted_total)) filter (
             where coalesce(i.final_due_date, i.extracted_due_date) >= greatest(w.w_start, p_today) and coalesce(i.final_due_date, i.extracted_due_date) < w.w_start + 7), 0) as v
      from weeks w left join pending_invoices i on i.status = 'posted' group by w.k),
  totals as (
    select coalesce(sum(amount_due), 0) as open_v, count(*) as open_n,
           coalesce(sum(amount_due) filter (where days_over between 1 and 90), 0) as over_v, count(*) filter (where days_over between 1 and 90) as over_n,
           coalesce(sum(amount_due) filter (where days_over > 90), 0) as old_v, count(*) filter (where days_over > 90) as old_n,
           coalesce(sum(amount_due) filter (where due_date between p_today and p_today + 7), 0) as due7_v,
           coalesce(sum(amount_due) filter (where n_ok < 30 and days_over > 0), 0) as unlikely_v
      from base),
  chase as (
    select customer, sum(amount_due) as total, max(days_over) as oldest, count(*) as n,
           jsonb_agg(jsonb_build_object('doc', doc_number, 'due', due_date, 'days', days_over, 'amount', amount_due) order by days_over desc) as invoices
      from base where days_over between 1 and 90 group by customer order by sum(amount_due) desc limit 40),
  stats as (select count(*)::int as n, (select percentile_cont(0.5) within group (order by lat) from paid) as med,
                   round(100.0 * count(*) filter (where lat <= 0) / nullif(count(*), 0))::int as on_time from paid)
  select jsonb_build_object(
    'today', p_today,
    'weeks', (select jsonb_agg(jsonb_build_object('start', w.w_start, 'in', round(i.v), 'out', round(o.v)) order by w.k) from weeks w join inw i on i.k = w.k join outw o on o.k = w.k),
    'totals', (select to_jsonb(totals) from totals),
    'chase', coalesce((select jsonb_agg(to_jsonb(chase) order by chase.total desc) from chase), '[]'::jsonb),
    'pay_stats', (select to_jsonb(stats) from stats)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.cash_forecast(date) from public, anon;
grant execute on function public.cash_forecast(date) to authenticated, service_role;
