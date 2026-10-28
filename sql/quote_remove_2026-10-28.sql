-- Quotes: take an old quote off the list completely, and bring it back if needed. Re-runnable.
-- Applied to the live database on 28 Oct 2026 and tested (remove, restore, approved quote refused, direct writes blocked).
--
-- The quotes table is refilled from DecoNetwork every 6 hours, so deleting a row would just bring it back.
-- Instead the order id goes in quote_removed, and the quotes_board view (which the Quotes tab and DAN both read)
-- leaves out anything listed there. Nothing is deleted from DecoNetwork or from quotes. Restoring removes the row.
-- Approved (converted) quotes cannot be removed: they are real wins and would skew the conversion rate.

create table if not exists public.quote_removed (
  order_id text primary key,
  removed_by text,
  removed_at timestamptz not null default now(),
  reason text check (reason is null or char_length(reason) <= 300)
);
alter table public.quote_removed enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'quote_removed' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_removed for select to authenticated using (true);
  end if;
end $$;
revoke all on public.quote_removed from anon, authenticated;
grant select on public.quote_removed to authenticated;

-- The board, now leaving out removed quotes. Same columns in the same order as before.
create or replace view public.quotes_board with (security_invoker = true) as
SELECT q.order_id,
    q.deco_id,
    q.job_name,
    q.customer_name,
    q.contact_name,
    q.contact_email,
    q.customer_po,
    q.store_name,
    q.assigned_to,
    q.order_type,
    q.order_status,
    q.quote_value,
    q.garment_qty,
    q.processes,
    q.created_at,
    q.approved_at,
    q.modified_at,
    q.date_due,
    q.date_shipped,
    q.notes_count,
    q.last_note_at,
    q.last_to_customer_at,
    q.last_from_customer_at,
    q.to_customer_count,
    q.from_customer_count,
    q.synced_at,
    c.chase_count,
    c.last_chase_at,
    c.last_chase_by,
    c.last_chase_note,
    m.email_chase_no,
    m.email_sent_at,
    m.email_due_at,
    m.email_replied_at,
    m.email_sender
   FROM quotes q
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS chase_count,
            max(x.created_at) AS last_chase_at,
            (array_agg(x.chased_by ORDER BY x.created_at DESC))[1] AS last_chase_by,
            (array_agg(x.note ORDER BY x.created_at DESC))[1] AS last_chase_note
           FROM quote_chases x
          WHERE x.order_id = q.order_id) c ON true
     LEFT JOIN LATERAL ( SELECT e.chase_no AS email_chase_no,
            e.sent_at AS email_sent_at,
            e.reply_due_at AS email_due_at,
            e.replied_at AS email_replied_at,
            e.sender_email AS email_sender
           FROM quote_emails e
          WHERE e.order_id = q.order_id AND e.status = 'sent'::text
          ORDER BY e.sent_at DESC
         LIMIT 1) m ON true
  WHERE NOT EXISTS (SELECT 1 FROM quote_removed rm WHERE rm.order_id = q.order_id);

-- What the "Removed quotes" list at the bottom of the Quotes tab reads.
create or replace view public.quotes_removed_board with (security_invoker = true) as
select r.order_id, q.customer_name, q.job_name, q.quote_value, q.assigned_to, q.created_at,
       r.removed_by, r.removed_at, r.reason
from public.quote_removed r
left join public.quotes q on q.order_id = r.order_id;
revoke all on public.quotes_removed_board from anon, authenticated;
grant select on public.quotes_removed_board to authenticated;

create or replace function public.remove_quote(p_order_id text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from quotes where order_id = p_order_id) then raise exception 'quote not found'; end if;
  if exists (select 1 from quotes where order_id = p_order_id and approved_at is not null) then
    raise exception 'an approved quote cannot be removed';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_removed (order_id, removed_by, reason) values (p_order_id, v_name, nullif(btrim(p_reason), ''))
  on conflict (order_id) do nothing;
end $$;

create or replace function public.restore_quote(p_order_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from quote_removed where order_id = p_order_id;
end $$;

revoke all on function public.remove_quote(text, text) from public, anon;
revoke all on function public.restore_quote(text) from public, anon;
grant execute on function public.remove_quote(text, text) to authenticated;
grant execute on function public.restore_quote(text) to authenticated;
