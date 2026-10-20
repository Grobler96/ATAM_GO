-- Security fix, applied to the live database on 20 Oct 2026 (project aobosyvlhgkxhjxkfzlz).
--
-- Problem (flagged by the Supabase advisor): ten tables had row level security OFF, and every signed-in user could read
-- them; six could also be inserted into, changed or deleted by any signed-in login, and on all ten any signed-in login
-- held the TRUNCATE privilege. Signed-out visitors had no access (the 13 Oct lockdown held).
--
-- Fix:
--   * Row level security ON for all ten tables.
--   * Signed-in users can only READ, and only the tables the site and DAN need:
--       xero_sales_documents, xero_sales_line_items, xero_sales_payments, customer_groups, customer_accounts,
--       customer_account_aliases, revenue_account_categories, product_type_rules
--   * vendor_xero_contact_override and xero_sync_state are internal (n8n and security-definer functions only): signed-in
--     users get nothing.
--   * All write, TRUNCATE, REFERENCES and TRIGGER privileges removed from signed-in users on these tables.
--   * n8n uses the service role (it bypasses row level security and keeps all its privileges), so the Xero sync and the
--     other workflows are not affected. The Customer Spend tab reads through functions and views owned by the database
--     owner, so it is not affected either.
--   * classify_product_type no longer runnable by signed-out visitors; refresh_product_types (a write function used only
--     by n8n) no longer runnable by signed-in users.
--
-- Checked before applying, inside a transaction that was rolled back: Customer Spend summary and the customer history
-- panel return identical results for a signed-in user; row counts readable; insert / update / delete / truncate blocked;
-- the two internal tables hidden; service role unaffected.
--
-- Rollback (restores the old, open behaviour; only if something unexpected breaks):
--   alter table public.<table> disable row level security;
--   grant insert, update, delete, truncate, references, trigger on public.<table> to authenticated;   -- as before
--   grant select on public.<table> to authenticated;
--   drop policy "authenticated read <table>" on public.<table>;   (run by hand in the SQL editor; the Supabase tool hangs on DROP)
--   grant execute on function public.refresh_product_types() to authenticated;   -- check the exact signature first

do $fix$
declare
  t text; f record;
  all_t text[] := array['vendor_xero_contact_override','xero_sales_documents','xero_sync_state','customer_groups','customer_accounts','customer_account_aliases','xero_sales_line_items','xero_sales_payments','revenue_account_categories','product_type_rules'];
  read_t text[] := array['xero_sales_documents','xero_sales_line_items','xero_sales_payments','customer_groups','customer_accounts','customer_account_aliases','revenue_account_categories','product_type_rules'];
begin
  set local lock_timeout = '15s';
  foreach t in array all_t loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
  end loop;
  foreach t in array read_t loop
    execute format('create policy %I on public.%I for select to authenticated using (true)', 'authenticated read ' || t, t);
  end loop;
  revoke all on public.vendor_xero_contact_override, public.xero_sync_state from authenticated;
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public' where p.proname = 'classify_product_type' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public' where p.proname = 'refresh_product_types' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $fix$;
