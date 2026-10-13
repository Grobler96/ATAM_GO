-- Security hardening applied to the live database on 13 Oct 2026 (safe, reversible changes only).
-- Verified afterwards: spend/invoice functions return identical results; signed-out API probes return 401.

-- 1. Invoice-approval functions were callable without signing in.
revoke execute on function public.approve_pending_invoice_v2(uuid, text, text, text, numeric, text, text, numeric, numeric, date, date) from public, anon;
revoke execute on function public.correct_pending_invoice_date(uuid, date, text) from public, anon;
revoke execute on function public.resolve_vendor_xero_contact(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.approve_pending_invoice_v2(uuid, text, text, text, numeric, text, text, numeric, numeric, date, date) to authenticated, service_role;
grant execute on function public.correct_pending_invoice_date(uuid, date, text) to authenticated, service_role;
grant execute on function public.resolve_vendor_xero_contact(uuid, text, text, boolean, text) to authenticated, service_role;
-- new functions are no longer executable by signed-out visitors by default
alter default privileges in schema public revoke execute on functions from anon, public;

-- 2. Signed-out visitors no longer have write privileges on any view, or on any table that has row-level security on.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','v','m','p') and (c.relkind in ('v','m') or c.relrowsecurity)
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon', r.relname);
  end loop;
end $$;

-- 3. Two SECURITY DEFINER views were readable by signed-out visitors (purchase cost fallback, outstanding sales lines).
revoke select on public.po_line_cost_fallback from anon;
revoke select on public.sales_lines_outstanding from anon;

-- 4. The one table with row-level security off that signed-out visitors could read and write.
revoke all on public.vendor_xero_contact_override from anon;

-- 5. Pin the search_path of the functions Supabase flagged as mutable (extensions kept so behaviour is unchanged).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
           where ns.nspname='public' and p.prokind='f'
             and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', r.sig);
  end loop;
end $$;

-- Still to do (needs testing, one at a time): wip_orders / monthly_revenue "public read" policies -> authenticated only.
