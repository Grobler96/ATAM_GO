-- Today screen: the two kinds of work that do not already come from the quotes board or the calendar view. Re-runnable.
--
--   invoice_overdue  a Xero invoice that has been approved, still has an amount due, and is past its due date.
--                    Owner = whoever handled the order (wip_orders.assigned_to), else 'Unassigned'.
--   order_late       an open order (new, production complete, on hold, awaiting stock, in production, awaiting payment) that has not
--                    shipped and is due today or up to 14 days ago. Older ones are left out: many of those are stale records.
-- Read only, signed-in only (security_invoker, so the underlying row level security applies). Nothing is written from the Today screen.

create or replace view public.today_work with (security_invoker = true) as
select 'invoice_overdue'::text as kind,
       coalesce(nullif(btrim(w.assigned_to), ''), 'Unassigned') as owner,
       coalesce(nullif(btrim(d.xero_contact_name), ''), 'Unknown customer') as label,
       d.xero_id::text as ref_id,
       d.doc_number::text as doc_ref,
       d.amount_due::numeric as value,
       (current_date - d.due_date::date)::integer as days_late
  from public.xero_sales_documents d
  left join lateral (select o.assigned_to from public.wip_orders o where o.order_id::text = d.order_id::text limit 1) w on true
 where d.doc_type = 'invoice' and d.status = 'AUTHORISED' and d.amount_due > 0 and d.due_date::date < current_date
union all
select 'order_late'::text,
       coalesce(nullif(btrim(o.assigned_to), ''), 'Unassigned'),
       coalesce(nullif(btrim(o.customer_name), ''), 'Unknown customer'),
       o.order_id::text,
       o.order_id::text,
       coalesce(o.order_value, 0)::numeric,
       (current_date - o.date_due::date)::integer
  from public.wip_orders o
 where o.date_shipped is null
   and o.order_status in (1, 2, 5, 6, 8, 9)
   and o.date_due::date <= current_date
   and o.date_due::date >= current_date - 14;

revoke all on public.today_work from anon, public;
grant select on public.today_work to authenticated;
