-- Customers whose orders are invoiced ONLY when everything has shipped, as one invoice (19 Nov 2026, v99).
-- HH Associates: Steph / Bethan upload each invoice into HH's own system, which only accepts a full invoice that matches its own order.
-- Until now GO built an invoice for whatever had shipped (636431 became GBP 3.98 and then GBP 2,084.75).
-- How it works: orders whose customer name matches a pattern below are added to the list the hourly invoice builder skips
-- (get_sales_staging_blocklist) until EVERY current line has shipped (qty_shipped >= qty_required - qty_wasted), or until DecoNetwork has the
-- order as shipped (status 3) and nothing has shipped for 2 days (orders closed short are then released as they stand).
-- To add another customer: insert a row with an ILIKE pattern (use % for the end of the name).
create table if not exists public.invoice_in_full_customers (
  id bigint generated always as identity primary key,
  name_pattern text not null unique,
  note text,
  created_at timestamptz not null default now()
);
alter table public.invoice_in_full_customers enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='invoice_in_full_customers' and policyname='signed in read') then
    create policy "signed in read" on public.invoice_in_full_customers for select to authenticated using (true);
  end if;
end $$;
revoke all on public.invoice_in_full_customers from anon;
revoke insert, update, delete, truncate on public.invoice_in_full_customers from authenticated;
insert into public.invoice_in_full_customers (name_pattern, note)
values ('HH Associates%', 'HH upload invoices to their own system: one full invoice per order, only when everything has shipped (Steph, 19 Nov 2026)')
on conflict (name_pattern) do nothing;

create or replace function public.get_sales_staging_blocklist()
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object('order_ids', coalesce(jsonb_agg(distinct x.order_id), '[]'::jsonb))
  from (
    select p.order_id
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
    union
    -- invoice-in-full customers: hold the order until every current line has shipped
    select u.order_id
    from upcoming_orders u
    where exists (select 1 from invoice_in_full_customers c where u.customer_name ilike c.name_pattern)
      and not (
        -- released when DecoNetwork has the whole order as shipped and nothing has shipped for 2 days (an order closed short, e.g. 10 ordered, 5 sent)
        (u.order_status = 3 and coalesce(u.date_shipped, u.date_modified) < now() - interval '2 days')
        or (
        exists (select 1 from sales_order_lines l
                 where l.order_id = u.order_id
                   and not exists (select 1 from sales_order_lines n where n.order_id = l.order_id and n.synced_at > l.synced_at + interval '5 minutes'))
        and not exists (select 1 from sales_order_lines l
                 where l.order_id = u.order_id
                   and not exists (select 1 from sales_order_lines n where n.order_id = l.order_id and n.synced_at > l.synced_at + interval '5 minutes')
                   and coalesce(l.qty_shipped, 0) < greatest(coalesce(l.qty_required, 0) - coalesce(l.qty_wasted, 0), 0))
        )
      )
  ) x
$function$;
