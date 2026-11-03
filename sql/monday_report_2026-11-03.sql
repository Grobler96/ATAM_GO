-- Monday morning report: one function that returns everything the weekly email to Daniel needs, as JSON. Re-runnable.
--
-- monday_report(p_today) looks at the last full working week (Monday to Sunday before p_today, UK dates) against the week before it:
--   orders_approved  quotes / orders approved in the week (count and value; quotes.approved_at)
--   quotes_raised    quotes and orders created in the week
--   invoiced         Xero sales invoices dated in the week (approved or paid, not drafts, voided or deleted)
--   production       pieces decorated (decoration_records quantity by report_date): embroidery and print
-- and the situation now:
--   pipeline         open quotes (count, value), expected to win (value x chance to win, see quote_win_chance), and how many are quiet 3+ days
--   late_orders      open orders due today or up to 14 days ago that have not shipped (view today_work)
--   overdue          overdue Xero invoices up to 90 days, and over 90 days (many of those look stale)
--   reps             per salesperson: raised, approved, open and expected to win
--   top_open         the five open quotes worth the most (value x chance to win)
-- "Open" here is worked out in SQL (not approved, not cancelled, touched in the last 30 days, taking the latest of the quote's own dates, our
-- emails and chases), so it can differ by a quote or two from the Quotes tab, which uses the same idea with a few more signals.
-- Read only. security invoker, so it only sees what the caller may see; the weekly email reads it with the service role.

create or replace function public.monday_report(p_today date default (now() at time zone 'Europe/London')::date)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_from date := date_trunc('week', p_today)::date - 7;          -- Monday of the last full week
  v_to date := date_trunc('week', p_today)::date - 1;            -- its Sunday
  v_pfrom date := date_trunc('week', p_today)::date - 14;
  v_pto date := date_trunc('week', p_today)::date - 8;
  v_out jsonb;
begin
  with
  qd as (select q.*, (q.created_at at time zone 'Europe/London')::date as c_day, (q.approved_at at time zone 'Europe/London')::date as a_day from public.quotes q),
  approved as (
    select count(*) filter (where a_day between v_from and v_to) n, coalesce(sum(quote_value) filter (where a_day between v_from and v_to), 0) v,
           count(*) filter (where a_day between v_pfrom and v_pto) pn, coalesce(sum(quote_value) filter (where a_day between v_pfrom and v_pto), 0) pv
      from qd where approved_at is not null),
  raised as (
    select count(*) filter (where c_day between v_from and v_to) n, coalesce(sum(quote_value) filter (where c_day between v_from and v_to), 0) v,
           count(*) filter (where c_day between v_pfrom and v_pto) pn, coalesce(sum(quote_value) filter (where c_day between v_pfrom and v_pto), 0) pv
      from qd),
  inv as (
    select count(*) filter (where doc_date::date between v_from and v_to) n, coalesce(sum(total) filter (where doc_date::date between v_from and v_to), 0) v,
           count(*) filter (where doc_date::date between v_pfrom and v_pto) pn, coalesce(sum(total) filter (where doc_date::date between v_pfrom and v_pto), 0) pv
      from public.xero_sales_documents where doc_type = 'invoice' and status in ('AUTHORISED', 'PAID')),
  prod as (
    select coalesce(sum(quantity) filter (where decoration_type = 'embroidery' and report_date between v_from and v_to), 0) emb,
           coalesce(sum(quantity) filter (where decoration_type = 'print' and report_date between v_from and v_to), 0) prn,
           coalesce(sum(quantity) filter (where decoration_type = 'embroidery' and report_date between v_pfrom and v_pto), 0) pemb,
           coalesce(sum(quantity) filter (where decoration_type = 'print' and report_date between v_pfrom and v_pto), 0) pprn
      from public.decoration_records where report_date between v_pfrom and v_to),
  openq as (
    select b.order_id, b.customer_name, b.assigned_to, b.quote_value, w.win_pct,
           greatest(coalesce(b.modified_at, b.created_at), b.created_at, b.last_to_customer_at, b.last_from_customer_at, b.last_chase_at, b.email_sent_at) as last_touch
      from public.quotes_board b
      left join public.quote_win_chance w on w.order_id = b.order_id
     where b.approved_at is null and b.order_status is distinct from 4),
  live as (select *, extract(epoch from (now() - last_touch)) / 86400 as idle from openq where last_touch >= now() - interval '30 days'),
  pipe as (
    select count(*) n, coalesce(sum(quote_value), 0) v,
           coalesce(sum(quote_value * coalesce(win_pct, 0) / 100.0), 0) expected,
           count(*) filter (where idle >= 3) chase_n, coalesce(sum(quote_value) filter (where idle >= 3), 0) chase_v
      from live),
  late as (select count(*) n, coalesce(sum(value), 0) v from public.today_work where kind = 'order_late'),
  od as (
    select count(*) filter (where days_late <= 90) n, coalesce(sum(value) filter (where days_late <= 90), 0) v,
           count(*) filter (where days_late > 90) old_n, coalesce(sum(value) filter (where days_late > 90), 0) old_v
      from public.today_work where kind = 'invoice_overdue'),
  reps as (
    select coalesce(nullif(btrim(assigned_to), ''), 'Unassigned') as rep,
           count(*) filter (where c_day between v_from and v_to) raised_n,
           coalesce(sum(quote_value) filter (where c_day between v_from and v_to), 0) raised_v,
           count(*) filter (where a_day between v_from and v_to) approved_n,
           coalesce(sum(quote_value) filter (where a_day between v_from and v_to), 0) approved_v
      from qd group by 1),
  reps_open as (
    select coalesce(nullif(btrim(assigned_to), ''), 'Unassigned') as rep, count(*) open_n,
           coalesce(sum(quote_value * coalesce(win_pct, 0) / 100.0), 0) expected
      from live group by 1),
  reps_all as (
    select r.rep, r.raised_n, r.raised_v, r.approved_n, r.approved_v, coalesce(o.open_n, 0) open_n, coalesce(o.expected, 0) expected
      from reps r left join reps_open o using (rep)
     where r.raised_n > 0 or r.approved_n > 0 or coalesce(o.open_n, 0) > 0),
  top as (
    select customer_name, assigned_to, quote_value, win_pct, round(idle)::int as idle_days, order_id
      from live order by quote_value * coalesce(win_pct, 0) desc, quote_value desc limit 5)
  select jsonb_build_object(
    'week', jsonb_build_object('from', v_from, 'to', v_to, 'prev_from', v_pfrom, 'prev_to', v_pto),
    'orders_approved', (select to_jsonb(approved) from approved),
    'quotes_raised', (select to_jsonb(raised) from raised),
    'invoiced', (select to_jsonb(inv) from inv),
    'production', (select to_jsonb(prod) from prod),
    'pipeline', (select to_jsonb(pipe) from pipe),
    'late_orders', (select to_jsonb(late) from late),
    'overdue', (select to_jsonb(od) from od),
    'reps', coalesce((select jsonb_agg(to_jsonb(reps_all) order by reps_all.approved_v desc, reps_all.raised_v desc) from reps_all), '[]'::jsonb),
    'top_open', coalesce((select jsonb_agg(to_jsonb(top)) from top), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;

revoke all on function public.monday_report(date) from public, anon;
grant execute on function public.monday_report(date) to authenticated, service_role;
