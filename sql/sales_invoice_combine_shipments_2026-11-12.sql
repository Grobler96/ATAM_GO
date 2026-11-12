-- Combine shipments that arrive before the 5pm post onto one sales invoice. Re-runnable.
--
-- Problem (12 Nov 2026, Steph: 636681, British Gypsum): 3 snoods shipped at 12:57 and the other 6 lines at 13:10 on 10 Nov. GO's hourly run at 13:10:40 built an
-- invoice for the snoods only (GBP 9.37), the main shipment was recorded 7 seconds later, and because an approved invoice for an order was never touched again, the
-- rest waited until that invoice posted at 5pm and became 636681-2 (posted the next day). Steph wants same-day shipments on one invoice.
-- Fix, in two parts:
--  1. get_sales_staging_blocklist no longer blocks an order whose only invoice is an automatic approval that has not started posting, when more has shipped since
--     (a line shipped quantity above what the invoice's source_lines recorded, or a line the invoice does not have). Such orders go back through the builder.
--  2. stage_sales_invoice refreshes an automatically approved invoice (reviewed_by starts 'system (auto', not posting, no post attempts, not in Xero) in place with the
--     new proposal, exactly as it already did for an invoice awaiting review. If the refreshed invoice now needs a check it goes back to Needs review. An invoice a
--     person approved or edited is never refreshed: later shipments still go on a new -2 invoice.
-- The n8n workflow WF6 also got an extra staging run at 16:55 (Mon-Sat) so the last run before the 5pm post is 16:55 instead of 16:10.
-- Everything else in stage_sales_invoice is as in sales_invoice_over_billed_2026-11-12.sql.

create or replace function public.get_sales_staging_blocklist()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object('order_ids', coalesce(jsonb_agg(distinct p.order_id), '[]'::jsonb))
  from pending_sales_invoices p
  where p.status in ('approved','in_review','rejected','ignored')
    and not (
      p.status = 'approved' and p.reviewed_by like 'system (auto%' and p.posting_started_at is null
      and coalesce(p.post_attempts, 0) = 0 and p.xero_invoice_id is null
      and exists (select 1 from sales_lines_outstanding o
                   where o.order_id = p.order_id
                     and coalesce(o.qty_shipped, 0) > coalesce((select max((e->>'qty_shipped')::numeric) from jsonb_array_elements(p.source_lines) e
                                                                   where e->>'workflow_item_id' = o.workflow_item_id), 0))
    )
$function$;

create or replace function public.stage_sales_invoice(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order text := p->>'order_id';
  v_inv text := p->>'invoice_number';
  v_lines jsonb := coalesce(p->'lines', '[]'::jsonb);
  v_subtotal numeric := public.psi_lines_total(coalesce(p->'lines', '[]'::jsonb));
  v_contact_status text := coalesce(p->>'contact_status', 'none');
  v_po_required boolean := coalesce((p->>'po_required')::boolean, false);
  v_po text := nullif(btrim(coalesce(p->>'customer_po_number', '')), '');
  v_reasons text[] := '{}'::text[];
  v_auto boolean;
  v_ex record;
  v_id uuid;
  v_x text;
  v_inv_date date := coalesce(nullif(p->>'invoice_date','')::date, current_date);
  v_due date := coalesce(nullif(p->>'due_date','')::date, coalesce(nullif(p->>'invoice_date','')::date, current_date) + 30);
  v_dn_billable numeric;
  v_dn_tax numeric;
  v_expected_inc numeric;
  v_n integer;
  v_new jsonb;
  v_zr_changed boolean := false;
  v_taxable numeric;
  v_own boolean := false;
  v_buyer_name text;
  v_buyer_email text;
  v_prior numeric;
  v_prior_n integer;
begin
  if v_order is null or v_inv is null then
    raise exception 'order_id and invoice_number are required';
  end if;

  -- OWN ACCOUNT (11 Nov 2026, Steph: AWR, All Weather Roofline, Bill Plant Driving School). In these shops individuals pay when they order, but the name they
  -- type is often the company, so the invoice was matched to the head-office Xero account. If the order is in a shop listed in own_account_stores, is not
  -- on account (no outstanding balance) and the Xero customer found is not one with the buyer's own email, drop the match and ask a person to create the buyer's own account.
  select nullif(btrim(r.name), ''), nullif(lower(btrim(r.email)), '') into v_buyer_name, v_buyer_email
    from deco_orders_raw r where r.order_id::text = v_order limit 1;
  if v_buyer_email is not null
     and exists (select 1 from own_account_stores s where lower(s.store_name) = lower(coalesce(p->>'store_name', '')))
     and coalesce((select u.outstanding_balance from upcoming_orders u where u.order_id = v_order limit 1), 0) <= 0
     and not exists (select 1 from jsonb_array_elements(coalesce(p->'contact_candidates', '[]'::jsonb)) c
                      where c->>'ContactID' = p->>'xero_contact_id' and lower(btrim(coalesce(c->>'Email', ''))) = v_buyer_email) then
    v_own := true;
    v_contact_status := 'none';
    p := p || jsonb_build_object('xero_contact_id', null, 'xero_contact_name', null, 'contact_status', 'none');
  end if;

  if v_contact_status = 'none' then v_reasons := array_append(v_reasons, 'no_contact'::text);
  elsif v_contact_status = 'ambiguous' then v_reasons := array_append(v_reasons, 'ambiguous_contact'::text);
  end if;
  if v_own then
    v_reasons := array_remove(array_remove(v_reasons, 'no_contact'::text), 'ambiguous_contact'::text);
    v_reasons := array_append(v_reasons, 'own_account'::text);
  end if;
  if v_po_required and v_po is null then v_reasons := array_append(v_reasons, 'missing_po'::text);
  elsif v_po_required and lower(v_po) in ('n/a','na','none','tbc','tba','-','.') then v_reasons := array_append(v_reasons, 'placeholder_po'::text);
  end if;
  if jsonb_array_length(v_lines) = 0 then v_reasons := array_append(v_reasons, 'no_lines'::text);
  elsif v_subtotal <= 0 then v_reasons := array_append(v_reasons, 'zero_total'::text);
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) e where (e->>'unit_price')::numeric < 0) then
    v_reasons := array_append(v_reasons, 'negative_price_line'::text);
  end if;
  if coalesce(p->>'customer_name', '') ilike '%CPI Corporate Solutions%' then
    v_reasons := array_append(v_reasons, 'internal_customer'::text);
  end if;
  -- DISCOUNT CHECK (6 Oct 2026, Steph: 636372 was a 100% discounted sample, paid in full, DecoNetwork total GBP 0,
  -- but the draft was built from the undiscounted line prices and came out at GBP 56.95).
  -- An invoice can legitimately be LESS than the DecoNetwork total (part shipments) but never MORE, so if the invoice
  -- (inc VAT as DecoNetwork charged it) is more than GBP 1 above DecoNetwork's own order total, a discount or credit
  -- is missing from the lines and a person must look before it goes to Xero.
  select billable_amount, tax_amount into v_dn_billable, v_dn_tax from upcoming_orders where order_id = v_order;

  -- 8 Oct 2026 (Steph, 636412/636271): DecoNetwork order total is GBP 0 (free samples / reorders) but lines are priced.
  -- Never invoice these: record as ignored so they stay out of the review queue and Xero.
  if v_dn_billable = 0 and v_subtotal > 0 and not exists (select 1 from pending_sales_invoices where order_id = v_order and status in ('approved','posted','in_review')) then
    update pending_sales_invoices set status='ignored', review_reasons = array['zero_order_total'], reviewed_by='system (auto: DecoNetwork total GBP 0)', reviewed_at=now(), updated_at=now()
      where order_id = v_order and status = 'awaiting_review';
    if not exists (select 1 from pending_sales_invoices where order_id = v_order) then
      insert into pending_sales_invoices (order_id, invoice_number, status, customer_name, customer_id, store_name, contact_status, lines, source_lines, subtotal, review_reasons, auto_approved, reviewed_by, reviewed_at, invoice_date, due_date)
      values (v_order, v_inv, 'ignored', p->>'customer_name', p->>'customer_id', p->>'store_name', v_contact_status, v_lines, coalesce(p->'source_lines','[]'::jsonb), v_subtotal, array['zero_order_total'], false, 'system (auto: DecoNetwork total GBP 0)', now(), v_inv_date, v_due);
    end if;
    return jsonb_build_object('result','skipped_zero_total');
  end if;

  -- PER-LINE VAT (6 Nov 2026, Steph: 636730, kids T shirts are zero rated). The first N lines of the proposal are the product lines, in the same order
  -- as source_lines. If DecoNetwork charged VAT on the order but none on that line (line_tax = 0), book the line at the zero rate and ask a person to check.
  v_n := jsonb_array_length(coalesce(p->'source_lines', '[]'::jsonb));
  if coalesce(v_dn_tax, 0) > 0 and v_n > 0 then
    with ls as (
      select e, o from jsonb_array_elements(v_lines) with ordinality as t(e, o)
    ), adj as (
      select o, e as orig,
        case when o <= v_n
              and coalesce(e->>'kind', 'product') = 'product'
              and coalesce(e->>'tax_type', 'OUTPUT2') = 'OUTPUT2'
              and coalesce((e->>'unit_price')::numeric, 0) > 0
              and exists (select 1 from sales_order_lines sl
                           where sl.workflow_item_id = (p->'source_lines'->((o - 1)::int)->>'workflow_item_id')
                             and sl.line_tax is not null and sl.line_tax = 0)
             then jsonb_set(e, '{tax_type}', '"ZERORATEDOUTPUT"'::jsonb)
             else e end as e2
      from ls
    )
    select jsonb_agg(e2 order by o), coalesce(bool_or(e2 is distinct from orig), false)
      into v_new, v_zr_changed from adj;
    if v_zr_changed then
      v_lines := v_new;
      v_reasons := array_append(v_reasons, 'mixed_vat'::text);
    end if;
  end if;
  v_taxable := v_subtotal - coalesce((select sum(round((e->>'qty')::numeric * (e->>'unit_price')::numeric, 2))
                                        from jsonb_array_elements(v_lines) e where e->>'tax_type' = 'ZERORATEDOUTPUT'), 0);

  if v_dn_billable is not null and v_dn_tax is not null and v_subtotal > 0 then
    v_expected_inc := v_subtotal + case when v_dn_tax > 0 then round(v_taxable * 0.2, 2) else 0 end;
    if v_expected_inc - v_dn_billable > 1.00 then
      v_reasons := array_append(v_reasons, 'discount_check'::text);
    end if;
  end if;
  -- EXTRA LINES (11 Nov 2026, Steph: 636643). Priced extras (kind 'extra', e.g. Portwest Vehicle Kit 8) have no shipped quantity in the data, and the builder puts
  -- them on the FIRST invoice for the order whether or not they have shipped. The kit was on back order but was billed. A person must check them first.
  -- RUNNING TOTAL (12 Nov 2026, Steph: 636730-2). The check above only looks at this invoice on its own. A second invoice for a small amount always passes it,
  -- even when the order is already fully billed. Add up the other invoices already approved, in review or posted for the order (ex VAT); if they plus this one
  -- come to more than DecoNetwork's order total ex VAT, hold it for a person.
  select coalesce(sum(coalesce(final_subtotal, subtotal)), 0), count(*) into v_prior, v_prior_n
    from pending_sales_invoices where order_id = v_order and invoice_number <> v_inv and status in ('approved', 'in_review', 'posted');
  if v_prior_n > 0 and v_dn_billable is not null and v_dn_tax is not null and v_subtotal > 0
     and v_prior + v_subtotal - (v_dn_billable - v_dn_tax) > 1.00 then
    v_reasons := array_append(v_reasons, 'over_billed'::text);
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) e where e->>'kind' = 'extra' and coalesce((e->>'unit_price')::numeric, 0) > 0) then
    v_reasons := array_append(v_reasons, 'extras_check'::text);
  end if;
  if jsonb_typeof(p->'extra_reasons') = 'array' then
    for v_x in select jsonb_array_elements_text(p->'extra_reasons') loop
      if v_x in ('vat_check') and not (v_x = any(v_reasons)) then v_reasons := array_append(v_reasons, v_x::text); end if;
    end loop;
  end if;
  v_auto := cardinality(v_reasons) = 0;

  select * into v_ex from pending_sales_invoices
   where order_id = v_order and status in ('rejected','ignored') order by created_at desc limit 1;
  if found then
    return jsonb_build_object('result','skipped_decision','id',v_ex.id,'status',v_ex.status);
  end if;

  select * into v_ex from pending_sales_invoices
   where order_id = v_order and status in ('awaiting_review','in_review','approved') limit 1;
  if found then
    if (v_ex.status = 'awaiting_review' and v_ex.final_lines is null
        and v_ex.final_xero_contact_id is null and v_ex.reviewed_by is null)
       or (v_ex.status = 'approved' and v_ex.reviewed_by like 'system (auto%' and v_ex.posting_started_at is null
           and coalesce(v_ex.post_attempts, 0) = 0 and v_ex.xero_invoice_id is null) then
      update pending_sales_invoices set
        invoice_number = v_inv, customer_name = p->>'customer_name', customer_id = p->>'customer_id',
        store_name = p->>'store_name', xero_contact_id = p->>'xero_contact_id',
        xero_contact_name = p->>'xero_contact_name', contact_status = v_contact_status,
        contact_candidates = coalesce(p->'contact_candidates','[]'::jsonb),
        customer_po_number = v_po, po_required = v_po_required, reference = p->>'reference',
        lines = v_lines, source_lines = coalesce(p->'source_lines','[]'::jsonb), subtotal = v_subtotal,
        shipping_method = p->>'shipping_method', shipping_address = p->>'shipping_address',
        buyer_name = case when v_own then v_buyer_name end, buyer_email = case when v_own then v_buyer_email end,
        review_reasons = v_reasons, auto_approved = v_auto,
        status = case when v_auto then 'approved' else 'awaiting_review' end,
        reviewed_by = case when v_auto then 'system (auto: clean match)' else null end,
        reviewed_at = case when v_auto then now() else null end,
        final_xero_contact_id = case when v_auto then p->>'xero_contact_id' else null end,
        final_xero_contact_name = case when v_auto then p->>'xero_contact_name' else null end,
        final_reference = case when v_auto then p->>'reference' else null end,
        final_lines = case when v_auto then v_lines else null end,
        final_subtotal = case when v_auto then v_subtotal else null end,
        updated_at = now()
      where id = v_ex.id
        and (status = 'awaiting_review' or (status = 'approved' and posting_started_at is null and xero_invoice_id is null));
      if not found then
        return jsonb_build_object('result','skipped_existing','id',v_ex.id,'status',v_ex.status);
      end if;
      return jsonb_build_object('result', case when v_auto then 'refreshed_auto_approved' else 'refreshed' end,
                                'id', v_ex.id, 'reasons', to_jsonb(v_reasons));
    end if;
    return jsonb_build_object('result','skipped_existing','id',v_ex.id,'status',v_ex.status);
  end if;

  begin
    insert into pending_sales_invoices (
      order_id, invoice_number, status, customer_name, customer_id, store_name,
      xero_contact_id, xero_contact_name, contact_status, contact_candidates,
      customer_po_number, po_required, reference, invoice_date, due_date,
      lines, source_lines, subtotal, shipping_method, shipping_address,
      buyer_name, buyer_email,
      review_reasons, auto_approved,
      final_xero_contact_id, final_xero_contact_name, final_reference, final_lines, final_subtotal,
      reviewed_by, reviewed_at)
    values (
      v_order, v_inv, case when v_auto then 'approved' else 'awaiting_review' end,
      p->>'customer_name', p->>'customer_id', p->>'store_name',
      p->>'xero_contact_id', p->>'xero_contact_name', v_contact_status,
      coalesce(p->'contact_candidates','[]'::jsonb),
      v_po, v_po_required, p->>'reference', v_inv_date, v_due,
      v_lines, coalesce(p->'source_lines','[]'::jsonb), v_subtotal,
      p->>'shipping_method', p->>'shipping_address',
      case when v_own then v_buyer_name end, case when v_own then v_buyer_email end,
      v_reasons, v_auto,
      case when v_auto then p->>'xero_contact_id' end, case when v_auto then p->>'xero_contact_name' end,
      case when v_auto then p->>'reference' end, case when v_auto then v_lines end,
      case when v_auto then v_subtotal end,
      case when v_auto then 'system (auto: clean match)' end, case when v_auto then now() end)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('result','skipped_existing');
  end;

  return jsonb_build_object('result','inserted','id',v_id,
    'status', case when v_auto then 'approved' else 'awaiting_review' end, 'reasons', to_jsonb(v_reasons));
end;
$function$;
