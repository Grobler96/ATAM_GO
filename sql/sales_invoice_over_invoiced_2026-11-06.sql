-- "Over invoiced" check for sales invoice drafts. Re-runnable (it does nothing if the check is already in the function).
--
-- Problem (6 Nov 2026, Steph): order 636616 (GXO, 30 hi-vis vests, GBP 226.80) was invoiced in full on 636616. Then 636616-2 (10 Large vests, GBP 75.60) was
-- raised in error (fixed on 29 Oct, v44) and Steph deleted it in Xero. On 5 Nov 636616-3 (1 Medium vest, GBP 7.56 + VAT = 9.07) appeared. The cause: DecoNetwork's
-- PRODUCTION record for the Medium vests says 11 are required (9 made), while the SALES line still says 10 Medium and 30 in total at GBP 226.80. GO bills from the
-- production record's required quantity, so it saw one more than it had invoiced. Nothing more was ordered: the order is fully invoiced.
--
-- Check added to stage_sales_invoice: if the invoices already posted or approved for the order, plus this proposed one, come to more than the DecoNetwork order
-- total before VAT (billable_amount - tax_amount) plus GBP 1, the draft gets the review reason 'over_invoiced', so it is never approved automatically and a
-- person has to look. A part invoice is still fine: only a total ABOVE the order is flagged. Checked against all 320 invoiced orders: only 636616 (this one)
-- and 636528 (GBP 3.00 over, a separate point for Steph) would have been flagged.
-- Applied as a patch of the live function so the rest of it (including the per-line VAT change) is untouched.

do $patch$
declare
  d text;
  d2 text;
  marker_decl constant text := E'  v_taxable numeric;\nbegin';
  marker_check constant text := E'  if v_dn_billable is not null and v_dn_tax is not null and v_subtotal > 0 then\n    v_expected_inc';
  new_block constant text := E'  -- OVER-INVOICED CHECK (6 Nov 2026, Steph: 636616-3). Invoices already posted or approved for this order plus this one must not come to more than\n  -- the DecoNetwork order total before VAT (plus GBP 1). A part invoice is fine; a total above the order means something has been billed twice.\n  select coalesce(sum(coalesce(final_subtotal, subtotal)::numeric), 0) into v_prior\n    from pending_sales_invoices where order_id = v_order and status in (''posted'', ''approved'');\n  if v_prior > 0 and coalesce(v_dn_billable, 0) > 0 and v_prior + v_subtotal > (v_dn_billable - coalesce(v_dn_tax, 0)) + 1.00 then\n    v_reasons := array_append(v_reasons, ''over_invoiced''::text);\n  end if;\n\n';
begin
  d := pg_get_functiondef('public.stage_sales_invoice(jsonb)'::regprocedure);
  if position('over_invoiced' in d) > 0 then
    raise notice 'over_invoiced check already present';
    return;
  end if;
  if position(marker_decl in d) = 0 or position(marker_check in d) = 0 then
    raise exception 'stage_sales_invoice has changed: patch not applied';
  end if;
  d2 := replace(d, marker_decl, E'  v_taxable numeric;\n  v_prior numeric;\nbegin');
  d2 := replace(d2, marker_check, new_block || marker_check);
  execute d2;
end
$patch$;
