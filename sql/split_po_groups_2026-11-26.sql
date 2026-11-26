-- Split POs tab (26 Nov 2026, v101). Steph: when one PO is invoiced in several parts she wants GO to group the bills,
-- say how much of the PO has been invoiced, and say when it is Complete so she can check and approve them together.
-- Read only. Groups bills (not rejected) by a single matched PO number. Compared ex VAT: goods less the identified delivery,
-- against the PO sub total, so the VAT-on-delivery gap does not matter here. Complete = within GBP 1 or 2%.
-- Shown: POs with at least one bill still open (awaiting review, in review, approved) that is split (2+ bills, or a bill that
-- covers only part of the PO), and POs with 2+ bills that are still short of the PO and had a bill in the last 45 days.
create or replace function public.split_po_groups()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with i as (
    select p.id, p.matched_po_number po, p.extracted_invoice_number inv, p.extracted_vendor vendor, p.status, p.match_status,
           p.extraction_confidence conf, p.extracted_goods g, p.extracted_vat vat, p.extracted_total tot,
           coalesce(p.identified_delivery_charge, 0) d, p.matched_po_sub_total sub, p.matched_po_vendor po_vendor,
           p.extracted_invoice_date idate, p.received_at,
           (coalesce(p.extraction_notes, '') like '%Extracted invoice date%' or coalesce(p.extraction_notes, '') like '%invoice date was read as%') date_warn
    from pending_invoices p
    where p.matched_po_number is not null and p.matched_po_number !~ ',' and btrim(p.matched_po_number) <> ''
      and p.status in ('awaiting_review', 'in_review', 'approved', 'posted')
      and p.received_at > now() - interval '120 days'
  ),
  g as (
    select po,
           count(*) n,
           count(*) filter (where status in ('awaiting_review', 'in_review', 'approved')) n_open,
           (array_agg(po_vendor order by received_at desc))[1] po_vendor,
           (array_agg(sub order by received_at desc))[1] po_sub,
           sum(coalesce(g, 0) - d) invoiced_net,
           max(received_at) last_in
    from i group by po
  ),
  g2 as (
    select g.*, coalesce(po_sub, 0) - invoiced_net remaining,
           greatest(1, 0.02 * coalesce(po_sub, 0)) tol
    from g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'po', g2.po,
      'vendor', g2.po_vendor,
      'po_sub', g2.po_sub,
      'invoiced_net', round(g2.invoiced_net, 2),
      'remaining', round(g2.remaining, 2),
      'state', case when coalesce(g2.po_sub, 0) <= 0 then 'unknown'
                    when abs(g2.remaining) <= g2.tol then 'complete'
                    when g2.remaining < 0 then 'over' else 'waiting' end,
      'n', g2.n, 'n_open', g2.n_open, 'last_in', g2.last_in,
      'invoices', (select jsonb_agg(jsonb_build_object(
          'id', i.id, 'invoice', i.inv, 'vendor', i.vendor, 'status', i.status, 'match_status', i.match_status, 'confidence', i.conf,
          'net', round(coalesce(i.g, 0) - i.d, 2), 'goods', i.g, 'vat', i.vat, 'total', i.tot, 'invoice_date', i.idate,
          'received_at', i.received_at, 'date_warn', i.date_warn) order by i.received_at)
        from i where i.po = g2.po)
    ) order by (g2.n_open > 0) desc, g2.last_in desc), '[]'::jsonb)
  from g2
  where (g2.n_open > 0 and (g2.n >= 2 or (coalesce(g2.po_sub, 0) > 0 and g2.remaining > g2.tol)))
     or (g2.n >= 2 and coalesce(g2.po_sub, 0) > 0 and g2.remaining > g2.tol and g2.last_in > now() - interval '45 days');
$$;
revoke execute on function public.split_po_groups() from public, anon;
grant execute on function public.split_po_groups() to authenticated, service_role;
