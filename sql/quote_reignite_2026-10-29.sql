-- Quotes: "Re-ignite" an expired quote (one that has gone quiet for 30+ days and so shows as Lost / Expired). Re-runnable.
--
-- DecoNetwork expires quotes after 30 days, and its API cannot reopen one, so the quote still has to be reopened in DecoNetwork.
-- Here we only record that someone has re-ignited it: its order id goes in quote_revived and the quotes_board view reports
-- revived_at / revived_by, which the Quotes tab treats as a touch (so the quote goes back to Hot and the 30 day clock starts again).
-- Nothing is changed in DecoNetwork and no row in quotes is touched, so the 6-hourly sync cannot undo it.
-- Approved and cancelled quotes cannot be re-ignited. Undo removes the row, and the quote goes back to Expired if it is still quiet.

create table if not exists public.quote_revived (
  order_id   text primary key,
  revived_by text,
  revived_at timestamptz not null default now(),
  times      integer not null default 1
);
alter table public.quote_revived enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'quote_revived' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_revived for select to authenticated using (true);
  end if;
end $$;
revoke all on public.quote_revived from anon, authenticated;
grant select on public.quote_revived to authenticated;

-- The board, with revived_at / revived_by / revived_times added at the END (same columns in the same order as before otherwise).
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
    m.email_sender,
    rv.revived_at,
    rv.revived_by,
    rv.times AS revived_times
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
     LEFT JOIN quote_revived rv ON rv.order_id = q.order_id
  WHERE NOT EXISTS (SELECT 1 FROM quote_removed r2 WHERE r2.order_id = q.order_id);

create or replace function public.reignite_quote(p_order_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_approved timestamptz; v_status integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select approved_at, order_status into v_approved, v_status from quotes where order_id = p_order_id;
  if not found then raise exception 'quote not found'; end if;
  if v_approved is not null then raise exception 'this quote has already been approved'; end if;
  if v_status = 4 then raise exception 'a cancelled quote cannot be re-ignited here'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_revived (order_id, revived_by, revived_at, times) values (p_order_id, v_name, now(), 1)
  on conflict (order_id) do update set revived_by = excluded.revived_by, revived_at = now(), times = quote_revived.times + 1;
end $$;
revoke all on function public.reignite_quote(text) from public, anon;
grant execute on function public.reignite_quote(text) to authenticated;

create or replace function public.undo_reignite_quote(p_order_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from quote_revived where order_id = p_order_id;
end $$;
revoke all on function public.undo_reignite_quote(text) from public, anon;
grant execute on function public.undo_reignite_quote(text) to authenticated;
