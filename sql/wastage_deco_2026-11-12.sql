-- Wasted items from DecoNetwork: do not bill the replacement, and show the wastage in ATAM FLOW. Re-runnable.
--
-- Problem (12 Nov 2026, Steph / Bethan: 636730 Cool T Large): when a shirt is marked as wasted in DecoNetwork ("Wastage Recorded ... Qty marked as wasted: 1"), DecoNetwork
-- adds one to the item's qty_required so a replacement is made (15 ordered and paid for, 16 required). GO bills paid-in-full orders on the REQUIRED quantity
-- (sales_lines_outstanding), so the replacement was billed as an extra shirt (636730-2). DecoNetwork sends the wasted quantity on every workflow item (qty_wasted) and GO
-- never read it.
-- 1. sales_order_lines.qty_wasted is filled by the hourly order sync (WF3, step "Add Line VAT"). null = DecoNetwork did not send it.
-- 2. sales_lines_outstanding: for paid-in-full orders the quantity to bill is now the larger of what shipped and (required - wasted), never below 0. Orders billed on
--    what shipped are unaffected (the wasted shirt never ships).
-- 3. ATAM FLOW: flow.waste_events.source may now be 'deco', and flow.waste_suggest() (called by the FLOW Wastage page through public.flow_waste_suggest(), and by
--    stocktake_close) has a fourth block that adds one status 'suggested' entry per item for the wasted quantity not yet suggested (source_key 'deco:<workflow item>:<running
--    total>', so nothing is counted twice and only extra wastage is added). DecoNetwork sends no reason and no time, so the cause is 'other', the party 'us', the stage 'in_house'
--    and the time is when GO first saw it; the person confirming it finds the real time, person and reason in the order history in DecoNetwork. Cost = flow.waste_cost(sku)
--    (public.sku_costs). The first run creates about 25 suggestions (about GBP 173) for wastage on orders from the last month; 10 link to open FLOW orders, the rest have no FLOW order.
-- The three existing blocks of flow.waste_suggest() (qc, receipts, courier) are unchanged.

alter table public.sales_order_lines add column if not exists qty_wasted integer;

create or replace view public.sales_lines_outstanding as
 SELECT l.id,
    l.order_id,
    l.line_id,
    l.workflow_item_id,
    l.product_name,
    l.product_code,
    l.sku,
    l.option_name,
    l.qty_required,
    l.qty_produced,
        CASE
            WHEN (u.order_id IS NOT NULL) THEN GREATEST(COALESCE(l.qty_shipped, 0), GREATEST(COALESCE(l.qty_required, 0) - COALESCE(l.qty_wasted, 0), 0))
            ELSE l.qty_shipped
        END AS qty_shipped,
    l.qty_invoiced,
    l.unit_price,
    l.shipping_status,
    l.production_status,
    l.shipped_date,
    l.synced_at,
    l.created_at,
    l.updated_at,
    l.size,
    l.line_total,
    l.line_qty
   FROM (sales_order_lines l
     LEFT JOIN upcoming_orders u ON (((u.order_id = l.order_id) AND (u.payment_status = ANY (ARRAY[4, 5])) AND (u.outstanding_balance = (0)::numeric) AND (COALESCE(u.billable_amount, (0)::numeric) > (0)::numeric) AND (u.dismissed_at IS NULL) AND (u.order_status = ANY (ARRAY[1, 2, 8, 9])))))
  WHERE ((l.qty_invoiced IS NOT NULL) AND (
        CASE
            WHEN (u.order_id IS NOT NULL) THEN GREATEST(COALESCE(l.qty_shipped, 0), GREATEST(COALESCE(l.qty_required, 0) - COALESCE(l.qty_wasted, 0), 0))
            ELSE l.qty_shipped
        END > GREATEST(l.qty_invoiced, COALESCE(( SELECT max(COALESCE(o.qty_invoiced, 0)) AS max
           FROM sales_order_lines o
          WHERE ((o.order_id = l.order_id) AND (o.line_id = l.line_id) AND (o.id <> l.id) AND (NOT (o.size IS DISTINCT FROM l.size)) AND (NOT (o.option_name IS DISTINCT FROM l.option_name)) AND (EXISTS ( SELECT 1
                   FROM sales_order_lines nn
                  WHERE ((nn.order_id = o.order_id) AND (nn.synced_at > (o.synced_at + '00:05:00'::interval))))))), 0))) AND (NOT (EXISTS ( SELECT 1
           FROM sales_order_lines n
          WHERE ((n.order_id = l.order_id) AND (n.synced_at > (l.synced_at + '00:05:00'::interval)))))));

-- ATAM FLOW: allow DecoNetwork as a source of wastage.
alter table flow.waste_events drop constraint if exists waste_events_source_check;
alter table flow.waste_events add constraint waste_events_source_check
  check (source = any (array['manual'::text, 'qc'::text, 'receipt'::text, 'courier'::text, 'deco'::text]));

CREATE OR REPLACE FUNCTION flow.waste_suggest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'flow', 'public'
AS $function$
declare n_qc int := 0; n_rc int := 0; n_cr int := 0; n_dc int := 0;
begin
  with ins as (
    insert into flow.waste_events (waste_ref, occurred_at, stage, cause_code, party, qty, sku, unit_cost, order_id, order_ref, producer_id, movement_id, source, source_key, status, reason, recorded_by)
    select 'WST-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('flow.waste_seq')::text, 4, '0'), coalesce(r.completed_at, r.created_at), case when r.producer_id is not null then 'decorator' else 'qc' end,
           case r.cause when 'producer' then 'decorator_spoilage' when 'supplier' then 'supplier_fault' when 'artwork' then 'artwork_error' when 'operator' then 'wrong_decoration' when 'machine' then 'misprint' else 'other' end,
           case r.cause when 'producer' then 'decorator' when 'supplier' then 'supplier' when 'artwork' then 'artwork' else 'us' end,
           r.units_scrapped, l.sku, flow.waste_cost(l.sku), r.order_id, o.order_ref, r.producer_id, r.movement_id, 'qc', 'qc:' || r.id, 'suggested',
           'Scrapped in rework ' || r.rework_ref || ' (' || r.defect_type || ')', 'system'
    from flow.rework_jobs r join flow.orders o on o.id = r.order_id left join flow.order_lines l on l.id = r.order_line_id
    where r.units_scrapped > 0
    on conflict (source_key) do nothing returning 1) select count(*) into n_qc from ins;
  with ins as (
    insert into flow.waste_events (waste_ref, occurred_at, stage, cause_code, party, qty, sku, unit_cost, order_id, order_ref, producer_id, movement_id, source, source_key, status, reason, recorded_by)
    select 'WST-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('flow.waste_seq')::text, 4, '0'), t.received_at, 'decorator', 'decorator_spoilage', 'decorator', t.qty_damaged, i.sku, flow.waste_cost(i.sku),
           i.order_id, o.order_ref, m.producer_id, m.id, 'receipt', 'receipt:' || t.id, 'suggested',
           'Decorator reported ' || t.qty_damaged || ' damaged on check-in of ' || m.movement_code || coalesce(' (' || t.note || ')', ''), 'system'
    from flow.tp_receipts t join flow.tp_movements m on m.id = t.movement_id join flow.tp_movement_items i on i.id = t.item_id join flow.orders o on o.id = i.order_id
    where t.qty_damaged > 0
    on conflict (source_key) do nothing returning 1) select count(*) into n_rc from ins;
  with ins as (
    insert into flow.waste_events (waste_ref, occurred_at, stage, cause_code, party, qty, sku, unit_cost, order_id, order_ref, producer_id, movement_id, source, source_key, status, reason, recorded_by)
    select 'WST-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('flow.waste_seq')::text, 4, '0'), c.opened_at, 'courier', case c.kind when 'lost' then 'courier_lost' else 'courier_damaged' end, 'courier',
           greatest((select coalesce(sum(i.qty_sent), 1) from flow.tp_movement_items i where i.movement_id = c.movement_id), 1), null,
           round(coalesce(c.value_claimed, 0) / greatest((select coalesce(sum(i.qty_sent), 1) from flow.tp_movement_items i where i.movement_id = c.movement_id), 1), 4),
           null, null, m.producer_id, m.id, 'courier', 'claim:' || c.id, 'suggested', 'Courier claim ' || c.claim_ref || ' (' || c.kind || ')' || coalesce(': ' || c.note, ''), 'system'
    from flow.courier_claims c join flow.tp_movements m on m.id = c.movement_id
    where c.kind in ('lost', 'damaged') and coalesce(c.value_claimed, 0) > 0
    on conflict (source_key) do nothing returning 1) select count(*) into n_cr from ins;
  -- DECONETWORK WASTAGE (12 Nov 2026): see the note at the top of this file.
  with w as (
    select l.workflow_item_id, l.order_id as deco_order, l.sku, l.product_name, l.size, l.qty_wasted,
           coalesce((select sum(e.qty) from flow.waste_events e where e.source = 'deco' and e.source_key like 'deco:' || l.workflow_item_id || ':%'), 0) as done
      from public.sales_order_lines l
     where coalesce(l.qty_wasted, 0) > 0
  ), ins as (
    insert into flow.waste_events (waste_ref, occurred_at, stage, cause_code, party, qty, sku, product_name, unit_cost, order_id, order_ref, source, source_key, status, reason, recorded_by)
    select 'WST-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('flow.waste_seq')::text, 4, '0'), now(), 'in_house', 'other', 'us', (w.qty_wasted - w.done)::int, w.sku,
           trim(both ' ' from coalesce(w.product_name, '') || coalesce(', ' || w.size, '')), flow.waste_cost(w.sku), o.id, '#' || w.deco_order, 'deco', 'deco:' || w.workflow_item_id || ':' || w.qty_wasted, 'suggested',
           'Marked as wasted in DecoNetwork on order #' || w.deco_order || '. The time, who recorded it and any reason are in the order history in DecoNetwork.', 'system'
      from w left join flow.orders o on o.deco_order_id = w.deco_order
     where w.qty_wasted > w.done
    on conflict (source_key) do nothing returning 1) select count(*) into n_dc from ins;
  return jsonb_build_object('qc', n_qc, 'receipts', n_rc, 'courier', n_cr, 'deco', n_dc);
end $function$;
