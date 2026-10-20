-- Email chasing from the Quotes tab (built 20 Oct 2026; applied to Supabase project aobosyvlhgkxhjxkfzlz).
--
-- How it works:
--   1. A signed-in user picks a sender and writes the email on the quote card. The browser calls queue_quote_email(),
--      which checks everything and stores the email as 'queued'. The browser can NOT make anything go out by itself.
--   2. The browser then tells the n8n workflow "quote-email-send" the email id. n8n checks the login, reads the queued
--      row, sends it through Microsoft 365 (Graph) from the chosen mailbox, then calls mark_quote_email_sent().
--   3. mark_quote_email_sent() stores the 3-day reply deadline and logs a chase (method 'email') so the quiet clock resets.
--   4. A second n8n workflow looks for replies and calls mark_quote_email_replied().
-- The three mark_* functions are for the service role only (n8n); signed-in website users cannot call them.
-- Money rule respected: nothing here sends without a person pressing Send. The 2nd chase is a reminder, not automatic.

-- who can be chosen in the From box. rep_name must match quotes.assigned_to exactly.
create table if not exists public.mail_senders (
  id         bigserial primary key,
  label      text not null,
  email      text not null unique,
  kind       text not null default 'rep' check (kind in ('rep', 'shared')),
  rep_name   text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.mail_senders enable row level security;
create policy "authenticated read mail_senders" on public.mail_senders for select to authenticated using (true);
revoke all on public.mail_senders from anon;
revoke insert, update, delete on public.mail_senders from authenticated;

create table if not exists public.quote_emails (
  id               bigserial primary key,
  order_id         text not null,
  chase_no         int  not null,
  sender_id        bigint references public.mail_senders (id),
  sender_email     text not null,
  to_email         text not null,
  subject          text not null,
  body             text not null,
  sent_by          text,
  sent_by_user     uuid,
  status           text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error            text,
  graph_message_id text,
  conversation_id  text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  reply_due_at     timestamptz,
  replied_at       timestamptz
);
create index if not exists quote_emails_order_idx on public.quote_emails (order_id, created_at desc);
create index if not exists quote_emails_open_idx on public.quote_emails (status, replied_at);
alter table public.quote_emails enable row level security;
create policy "authenticated read quote_emails" on public.quote_emails for select to authenticated using (true);
revoke all on public.quote_emails from anon;
revoke insert, update, delete on public.quote_emails from authenticated;

-- the website calls this. Checks everything, stores the email as queued, returns its id.
create or replace function public.queue_quote_email(p_order_id text, p_sender_id bigint, p_to text, p_subject text, p_body text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_sender mail_senders; v_name text; v_no int; v_id bigint; v_approved timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_sender from mail_senders where id = p_sender_id and active;
  if not found then raise exception 'that sender is not set up or is switched off'; end if;
  if p_to is null or p_to !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$' then raise exception 'the customer email address does not look right'; end if;
  if btrim(coalesce(p_subject, '')) = '' or length(p_subject) > 300 then raise exception 'add a subject (300 characters at most)'; end if;
  if btrim(coalesce(p_body, '')) = '' or length(p_body) > 20000 then raise exception 'add a message'; end if;
  select approved_at into v_approved from quotes where order_id = p_order_id;
  if not found then raise exception 'quote not found'; end if;
  if v_approved is not null then raise exception 'this quote has already been approved'; end if;
  if exists (select 1 from quote_emails where order_id = p_order_id and status = 'queued' and created_at > now() - interval '2 minutes') then
    raise exception 'an email for this quote was only just sent for sending, give it a minute';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  select count(*) + 1 into v_no from quote_emails where order_id = p_order_id and status = 'sent';
  insert into quote_emails (order_id, chase_no, sender_id, sender_email, to_email, subject, body, sent_by, sent_by_user)
  values (p_order_id, v_no, v_sender.id, v_sender.email, btrim(p_to), btrim(p_subject), p_body, v_name, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.queue_quote_email(text, bigint, text, text, text) from public, anon;
grant execute on function public.queue_quote_email(text, bigint, text, text, text) to authenticated;

-- n8n (service role) only -------------------------------------------------------------------------------------------
create or replace function public.mark_quote_email_sent(p_id bigint, p_graph_id text, p_conversation_id text)
returns void language plpgsql security definer set search_path = public as $$
declare e quote_emails;
begin
  update quote_emails set status = 'sent', sent_at = now(), reply_due_at = now() + interval '3 days',
         graph_message_id = p_graph_id, conversation_id = p_conversation_id, error = null
   where id = p_id and status = 'queued' returning * into e;
  if not found then raise exception 'email % is not waiting to be sent', p_id; end if;
  insert into quote_chases (order_id, chased_by, method, note)
  values (e.order_id, e.sent_by, 'email', 'Emailed via ATAM GO (chase #' || e.chase_no || ') from ' || e.sender_email);
end $$;

create or replace function public.mark_quote_email_failed(p_id bigint, p_error text)
returns void language sql security definer set search_path = public as $$
  update quote_emails set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 500) where id = p_id and status = 'queued';
$$;

create or replace function public.mark_quote_email_replied(p_id bigint, p_at timestamptz)
returns void language sql security definer set search_path = public as $$
  update quote_emails set replied_at = coalesce(p_at, now()) where id = p_id and status = 'sent' and replied_at is null;
$$;

revoke all on function public.mark_quote_email_sent(bigint, text, text), public.mark_quote_email_failed(bigint, text), public.mark_quote_email_replied(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_quote_email_sent(bigint, text, text), public.mark_quote_email_failed(bigint, text), public.mark_quote_email_replied(bigint, timestamptz) to service_role;

-- the board gets the latest sent email per quote (columns added at the end of the view)
create or replace view public.quotes_board with (security_invoker = on) as
select q.*, c.chase_count, c.last_chase_at, c.last_chase_by, c.last_chase_note,
       m.email_chase_no, m.email_sent_at, m.email_due_at, m.email_replied_at, m.email_sender
from public.quotes q
left join lateral (
  select count(*)::int chase_count, max(created_at) last_chase_at,
         (array_agg(chased_by order by created_at desc))[1] last_chase_by,
         (array_agg(note order by created_at desc))[1] last_chase_note
  from public.quote_chases x where x.order_id = q.order_id
) c on true
left join lateral (
  select e.chase_no email_chase_no, e.sent_at email_sent_at, e.reply_due_at email_due_at, e.replied_at email_replied_at, e.sender_email email_sender
  from public.quote_emails e where e.order_id = q.order_id and e.status = 'sent' order by e.sent_at desc limit 1
) m on true;
grant select on public.quotes_board to authenticated;
revoke all on public.quotes_board from anon;
