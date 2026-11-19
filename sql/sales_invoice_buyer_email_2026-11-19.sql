-- Buyer name and email on every sales invoice, known as soon as the order is (19 Nov 2026, v92). Re-runnable.
--
-- Problem (Steph, order 636868, Diana Porter): the Create in Xero box had the delivery address (v89) but the Email box was empty, so the email had to be typed by hand, and
-- Xero needs it to send the invoice. The buyer's name and email were only read from deco_orders_raw, which the nightly 03:00 sync fills, and only saved on the invoice when
-- the shop was on the own-account list. 636868 was invoiced at 10:10 on 17 Nov; its record reached deco_orders_raw at 03:01 on 18 Nov. So for the first day the email was unknown
-- (and the "Own account needed" check could not fire either, because it needs the buyer's email).
-- Fix: 1. upcoming_orders (filled hourly by WF3) now also holds buyer_name / buyer_email (DecoNetwork billing_details). 2. stage_sales_invoice uses deco_orders_raw first and
-- falls back to upcoming_orders, and saves buyer_name / buyer_email on EVERY invoice it builds (it used to save them only when the own-account rule fired). The own-account rule
-- itself is unchanged. 3. Open invoices are filled in once (backfill at the bottom).
-- stage_sales_invoice is patched in place with exact text replacements, so the rest of the function (all the checks) is untouched; each replacement is checked first.

alter table public.upcoming_orders add column if not exists buyer_name text, add column if not exists buyer_email text;

do $patch$
declare
  v_def text := pg_get_functiondef('public.stage_sales_invoice(jsonb)'::regprocedure);
  v_new text := v_def;
  a1 text := E'    from deco_orders_raw r where r.order_id::text = v_order limit 1;\n';
  b1 text := a1 || E'  if v_buyer_email is null then\n    v_buyer_email := (select nullif(lower(btrim(u.buyer_email)), \'\') from upcoming_orders u where u.order_id = v_order limit 1);\n    v_buyer_name := coalesce(v_buyer_name, (select nullif(btrim(u.buyer_name), \'\') from upcoming_orders u where u.order_id = v_order limit 1));\n  end if;\n';
  a2 text := 'buyer_name = case when v_own then v_buyer_name end, buyer_email = case when v_own then v_buyer_email end,';
  b2 text := 'buyer_name = v_buyer_name, buyer_email = v_buyer_email,';
  a3 text := 'case when v_own then v_buyer_name end, case when v_own then v_buyer_email end, v_dn_billable,';
  b3 text := 'v_buyer_name, v_buyer_email, v_dn_billable,';
begin
  if position('from upcoming_orders u where u.order_id = v_order limit 1);' in v_def) > 0 then
    raise notice 'stage_sales_invoice already patched, nothing to do';
    return;
  end if;
  if position(a1 in v_def) = 0 or position(a2 in v_def) = 0 or position(a3 in v_def) = 0 then
    raise exception 'stage_sales_invoice is not in the expected shape; patch not applied';
  end if;
  v_new := replace(v_new, a1, b1);
  v_new := replace(v_new, a2, b2);
  v_new := replace(v_new, a3, b3);
  execute v_new;
end
$patch$;

-- Backfill: invoices still open get the buyer from the order data (nothing posted or approved by a person is changed except these two text fields).
update public.pending_sales_invoices p
   set buyer_name = coalesce(p.buyer_name, nullif(btrim(u.buyer_name), '')),
       buyer_email = coalesce(p.buyer_email, nullif(lower(btrim(u.buyer_email)), ''))
  from public.upcoming_orders u
 where u.order_id = p.order_id
   and p.status in ('awaiting_review', 'in_review', 'approved')
   and (p.buyer_email is null or p.buyer_name is null)
   and (u.buyer_email is not null or u.buyer_name is not null);
