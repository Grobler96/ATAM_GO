-- Monthly purchase order spend (feeds the Stock tab Projections). Applied 27 Oct 2026.
-- Why: the n8n job "DecoNetwork PO Costs -> Supabase" stopped updating po_spend_monthly on 10 Jul 2026. Its monthly-total step
-- was wired to receive the output of the supplier-cost save (an empty reply) instead of the purchase orders, so it added up
-- nothing. Even once re-wired it could not work: that job asks DecoNetwork for the 400 OLDEST purchase orders since 180 days
-- ago (it sorts oldest first), which only reaches about the end of June.
-- Fix: work the months out from the purchase_orders table we already keep (a different job keeps it current).
-- Spend = the sum of each purchase order line's "total", which reproduces the old figures exactly for Dec 2025 to Mar 2026
-- (checked: difference 0.00 in all four months). A month is only overwritten when the new purchase order count is at least
-- the old one, so complete older months (May 2026, and months before Nov 2025, which purchase_orders does not hold) are never shrunk.
create or replace function public.rebuild_po_spend_monthly()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  with po as (
    select distinct on (po_number) po_number, date_raised, lines
    from purchase_orders where date_raised is not null order by po_number, synced_at desc
  ), m as (
    select to_char(po.date_raised at time zone 'UTC', 'YYYY-MM') as mk, count(*)::int as cnt,
           round(sum(coalesce((select sum(coalesce(nullif(x->>'total', '')::numeric, 0)) from jsonb_array_elements(po.lines) x), 0)), 2) as spend
    from po group by 1
  )
  insert into po_spend_monthly (month_key, po_count, total_spend, updated_at)
  select mk, cnt, spend, now() from m where spend > 0
  on conflict (month_key) do update
    set po_count = excluded.po_count, total_spend = excluded.total_spend, updated_at = now()
    where excluded.po_count >= po_spend_monthly.po_count;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.rebuild_po_spend_monthly() from public, anon, authenticated;
grant execute on function public.rebuild_po_spend_monthly() to service_role;
