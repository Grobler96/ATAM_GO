-- Own Xero account for people who pay up front in shared shops. Re-runnable.
--
-- Problem (11 Nov 2026, Steph): the AWR, All Weather Roofline and Bill Plant Driving School shops let individuals buy and pay when they order, but many type the
-- company as their customer name. The invoice builder (WF6) finds the Xero customer by that name alone, so the invoice goes to head office. Deco used the buyer's own
-- email; Xero uses the email on the Xero customer.
-- Fix: shops listed in own_account_stores (add a row for each new shop). For an order in one of them with no outstanding balance (paid up front, or payment not
-- recorded yet), stage_sales_invoice drops the head-office match, adds the review reason 'own_account' and saves the buyer's name and email from DecoNetwork
-- (deco_orders_raw) on the invoice, so the review screen can offer "Create in Xero" with them filled in. Orders with an outstanding balance (on account) are
-- unchanged. A Xero customer already carrying the buyer's own email is kept. Everything else is as in sales_invoice_extras_check_2026-11-11.sql.

create table if not exists public.own_account_stores (
  store_name text primary key,
  note text,
  added_at timestamptz not null default now()
);
alter table public.own_account_stores enable row level security;
drop policy if exists own_account_stores_read on public.own_account_stores;
create policy own_account_stores_read on public.own_account_stores for select to authenticated using (true);
revoke all on public.own_account_stores from anon;
revoke insert, update, delete, truncate on public.own_account_stores from authenticated;
insert into public.own_account_stores (store_name, note) values
  ('ATAM-AWR Uniform Shop', 'AWR and All Weather Roofline: individuals pay when they order'),
  ('Bill Plant Shop', 'Bill Plant Driving School: individuals pay when they order'),
  ('Bill Plant Instructor Shop', 'Bill Plant Driving School: instructors; orders on account are left alone')
on conflict (store_name) do nothing;

alter table public.pending_sales_invoices add column if not exists buyer_name text;
alter table public.pending_sales_invoices add column if not exists buyer_email text;

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
    if v_ex.status = 'awaiting_review' and v_ex.final_lines is null
       and v_ex.final_xero_contact_id is null and v_ex.reviewed_by is null then
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
      where id = v_ex.id;
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
