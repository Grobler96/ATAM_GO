-- Email from the Win-back tab (22 Oct 2026; applied to Supabase project aobosyvlhgkxhjxkfzlz).
-- Same design as the quote chase emails (sql/quote_email_chase.sql), for customers who are past their usual reorder time:
--   1. The browser calls queue_winback_email(): checks everything and stores the email as 'queued'. It cannot send anything itself.
--   2. The browser tells the n8n workflow "quote-email-send" (body kind = 'winback') the email id; n8n sends through Microsoft 365
--      and calls mark_winback_email_sent(), which logs a Win-back contact (email, "left a message") with a follow-up in 3 days.
--   3. The reply-check workflow calls mark_winback_email_replied(), which logs a "they replied" contact so the card moves to
--      "Replied, your move" by itself.
-- The three mark_* functions are for the service role only (n8n). Nothing sends without a person pressing Send.

create table if not exists public.winback_emails (
  id               bigserial primary key,
  customer_id      text not null,
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
create index if not exists winback_emails_customer_idx on public.winback_emails (customer_id, created_at desc);
create index if not exists winback_emails_open_idx on public.winback_emails (status, replied_at);
alter table public.winback_emails enable row level security;
create policy "authenticated read winback_emails" on public.winback_emails for select to authenticated using (true);
revoke all on public.winback_emails from anon;
revoke insert, update, delete on public.winback_emails from authenticated;
revoke usage, select on sequence public.winback_emails_id_seq from anon, authenticated;

create or replace function public.queue_winback_email(p_customer_id text, p_sender_id bigint, p_to text, p_subject text, p_body text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_sender mail_senders; v_name text; v_no int; v_id bigint; v_last date;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_sender from mail_senders where id = p_sender_id and active;
  if not found then raise exception 'that sender is not set up or is switched off'; end if;
  if p_to is null or p_to !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$' then raise exception 'the customer email address does not look right'; end if;
  if btrim(coalesce(p_subject, '')) = '' or length(p_subject) > 300 then raise exception 'add a subject (300 characters at most)'; end if;
  if btrim(coalesce(p_body, '')) = '' or length(p_body) > 20000 then raise exception 'add a message'; end if;
  select last_order_date into v_last from customer_reorder_alerts where customer_id = p_customer_id;
  if not found then raise exception 'customer not found'; end if;
  if exists (select 1 from winback_emails where customer_id = p_customer_id and status = 'queued' and created_at > now() - interval '2 minutes') then
    raise exception 'an email for this customer was only just sent for sending, give it a minute';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  -- email number = emails sent since their last order, plus this one
  select count(*) + 1 into v_no from winback_emails where customer_id = p_customer_id and status = 'sent' and (v_last is null or sent_at::date > v_last);
  insert into winback_emails (customer_id, chase_no, sender_id, sender_email, to_email, subject, body, sent_by, sent_by_user)
  values (p_customer_id, v_no, v_sender.id, v_sender.email, btrim(p_to), btrim(p_subject), p_body, v_name, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.queue_winback_email(text, bigint, text, text, text) from public, anon;
grant execute on function public.queue_winback_email(text, bigint, text, text, text) to authenticated;

-- n8n (service role) only -------------------------------------------------------------------------------------------
create or replace function public.mark_winback_email_sent(p_id bigint, p_graph_id text, p_conversation_id text)
returns void language plpgsql security definer set search_path = public as $$
declare e winback_emails;
begin
  update winback_emails set status = 'sent', sent_at = now(), reply_due_at = now() + interval '3 days',
         graph_message_id = p_graph_id, conversation_id = p_conversation_id, error = null
   where id = p_id and status = 'queued' returning * into e;
  if not found then raise exception 'email % is not waiting to be sent', p_id; end if;
  insert into winback_contacts (customer_id, contacted_by, method, outcome, note, follow_up_on)
  values (e.customer_id, e.sent_by, 'email', 'left_message', 'Emailed via ATAM GO (email #' || e.chase_no || ') from ' || e.sender_email, current_date + 3);
end $$;

create or replace function public.mark_winback_email_failed(p_id bigint, p_error text)
returns void language sql security definer set search_path = public as $$
  update winback_emails set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 500) where id = p_id and status = 'queued';
$$;

create or replace function public.mark_winback_email_replied(p_id bigint, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare e winback_emails;
begin
  update winback_emails set replied_at = coalesce(p_at, now()) where id = p_id and status = 'sent' and replied_at is null returning * into e;
  if found then
    insert into winback_contacts (customer_id, contacted_by, method, outcome, note, created_at)
    values (e.customer_id, 'Customer reply (automatic)', 'email', 'replied', 'Reply found in ' || e.sender_email || ' mailbox', coalesce(p_at, now()));
  end if;
end $$;

revoke all on function public.mark_winback_email_sent(bigint, text, text), public.mark_winback_email_failed(bigint, text), public.mark_winback_email_replied(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_winback_email_sent(bigint, text, text), public.mark_winback_email_failed(bigint, text), public.mark_winback_email_replied(bigint, timestamptz) to service_role;

-- the board gets the latest sent email per customer (columns added at the end of the view)
create or replace view public.winback_board with (security_invoker = true) as
with wip_owner as (
  select distinct on (k) k, assigned_to from (
    select wb_norm(customer_name) k, assigned_to, date_due from wip_orders where assigned_to is not null and btrim(assigned_to) <> '' and customer_name is not null
  ) x where k is not null order by k, date_due desc nulls last
), quote_owner as (
  select distinct on (customer_id) customer_id, assigned_to from winback_customer_quotes where assigned_to is not null order by customer_id, created_at desc
)
select a.customer_id, a.name, a.company, a.email, a.total_orders, a.first_order_date, a.last_order_date, a.mean_reorder_days,
       a.overdue_threshold_days, a.last_order_id, a.last_order_summary, a.last_order_value, a.suppress_alerts, a.notes,
       a.days_since_last_order, a.overdue_by_days, a.reorder_status, a.priority_score,
       coalesce(wc.assigned_to, wn.assigned_to, qo.assigned_to) as owner,
       lc.created_at as last_contact_at, lc.contacted_by as last_contact_by, lc.method as last_contact_method,
       lc.outcome as last_contact_outcome, lc.note as last_contact_note, lc.follow_up_on,
       coalesce(cn.n, 0) as contact_count,
       ac.created_at as attributed_contact_at, ac.contacted_by as attributed_contact_by,
       s.parked_until, s.closed_at, s.closed_reason,
       em.chase_no as email_no, em.sent_at as email_sent_at, em.reply_due_at as email_due_at, em.replied_at as email_replied_at, em.sender_email as email_sender
from customer_reorder_alerts a
left join winback_state s on s.customer_id = a.customer_id
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id order by c.created_at desc limit 1) lc on true
left join lateral (select count(*)::int n from winback_contacts c where c.customer_id = a.customer_id) cn on true
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id and a.last_order_date is not null
                   and c.created_at::date <= a.last_order_date and c.created_at::date >= a.last_order_date - 120 order by c.created_at desc limit 1) ac on true
left join lateral (select e.chase_no, e.sent_at, e.reply_due_at, e.replied_at, e.sender_email from winback_emails e
                   where e.customer_id = a.customer_id and e.status = 'sent' order by e.sent_at desc limit 1) em on true
left join wip_owner wc on wc.k = wb_norm(a.company)
left join wip_owner wn on wn.k = wb_norm(a.name)
left join quote_owner qo on qo.customer_id = a.customer_id
where a.reorder_status in ('At Risk', 'Due Soon')
   or lc.created_at > now() - interval '120 days'
   or s.customer_id is not null
   or exists (select 1 from winback_customer_quotes wq where wq.customer_id = a.customer_id and wq.approved_at is null
              and wq.order_status is distinct from 4 and greatest(wq.created_at, wq.modified_at) > now() - interval '45 days');
grant select on public.winback_board to authenticated;
revoke all on public.winback_board from anon;
