-- Quotes: "Park until a date" for a quote the customer wants to come back to later. Re-runnable.
--
-- Parking a quote takes it out of the Pipeline, the chase lists, the counts, the win rate and DAN until the chosen date. On that date it
-- comes back by itself (no scheduled job: the quotes_board view simply stops hiding it) and counts as touched that day, so it returns as Hot
-- with its original reason shown. Until then it is listed on the Parked tab (view quotes_parked_board) and on the Calendar (kind quote_return).
-- Nothing is changed in DecoNetwork and no row in quotes is touched, so the 6-hourly sync cannot undo it.
-- Quotes that get approved (or cancelled) in DecoNetwork while parked are NOT hidden, so conversions are never missed.
-- Approved and cancelled quotes cannot be parked. The date must be after today (UK time) and no more than 400 days away.

create table if not exists public.quote_parked (
  order_id     text primary key,
  parked_until date not null,
  reason       text check (reason is null or char_length(reason) <= 300),
  parked_by    text,
  parked_at    timestamptz not null default now(),
  times        integer not null default 1
);
alter table public.quote_parked enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'quote_parked' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_parked for select to authenticated using (true);
  end if;
end $$;
revoke all on public.quote_parked from anon, authenticated;
grant select on public.quote_parked to authenticated;

-- The board: same columns in the same order as before, with park_returned_at / park_reason / parked_by added at the END.
-- A quote is hidden only while its park date is still in the future (UK date) and it has not been approved or cancelled.
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
    rv.times AS revived_times,
    CASE WHEN pk.order_id IS NOT NULL AND pk.parked_until <= (now() AT TIME ZONE 'Europe/London')::date
         THEN (pk.parked_until::timestamp AT TIME ZONE 'Europe/London') END AS park_returned_at,
    pk.reason AS park_reason,
    pk.parked_by AS parked_by
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
     LEFT JOIN quote_parked pk ON pk.order_id = q.order_id
  WHERE NOT EXISTS (SELECT 1 FROM quote_removed r2 WHERE r2.order_id = q.order_id)
    AND (pk.order_id IS NULL
         OR pk.parked_until <= (now() AT TIME ZONE 'Europe/London')::date
         OR q.approved_at IS NOT NULL
         OR q.order_status = 4);

-- What the Parked tab reads: quotes parked and still waiting.
create or replace view public.quotes_parked_board with (security_invoker = true) as
SELECT q.order_id, q.deco_id, q.job_name, q.customer_name, q.contact_name, q.contact_email, q.store_name, q.assigned_to,
       q.quote_value, q.garment_qty, q.created_at, q.modified_at,
       pk.parked_until, pk.reason, pk.parked_by, pk.parked_at, pk.times
  FROM quote_parked pk
  JOIN quotes q ON q.order_id = pk.order_id
 WHERE pk.parked_until > (now() AT TIME ZONE 'Europe/London')::date
   AND q.approved_at IS NULL
   AND q.order_status IS DISTINCT FROM 4
   AND NOT EXISTS (SELECT 1 FROM quote_removed r2 WHERE r2.order_id = q.order_id);
revoke all on public.quotes_parked_board from anon, public;
grant select on public.quotes_parked_board to authenticated;

create or replace function public.park_quote(p_order_id text, p_until date, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text; v_approved timestamptz; v_status integer;
  v_today date := (now() at time zone 'Europe/London')::date;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_until is null then raise exception 'choose a date to bring it back'; end if;
  if p_until <= v_today then raise exception 'choose a date after today'; end if;
  if p_until > v_today + 400 then raise exception 'that date is too far away (400 days at most)'; end if;
  if v_reason is not null and char_length(v_reason) > 300 then raise exception 'the reason is too long (300 characters at most)'; end if;
  select approved_at, order_status into v_approved, v_status from quotes where order_id = p_order_id;
  if not found then raise exception 'quote not found'; end if;
  if v_approved is not null then raise exception 'this quote has already been approved'; end if;
  if v_status = 4 then raise exception 'a cancelled quote cannot be parked'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_parked (order_id, parked_until, reason, parked_by, parked_at, times) values (p_order_id, p_until, v_reason, v_name, now(), 1)
  on conflict (order_id) do update set parked_until = excluded.parked_until, reason = excluded.reason, parked_by = excluded.parked_by,
    parked_at = now(), times = quote_parked.times + 1;
end $$;
revoke all on function public.park_quote(text, date, text) from public, anon;
grant execute on function public.park_quote(text, date, text) to authenticated;

-- Bring a parked quote back now (it returns as Hot, with the reason still shown). No-op if it is not currently parked.
create or replace function public.unpark_quote(p_order_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := (now() at time zone 'Europe/London')::date;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update quote_parked set parked_until = v_today where order_id = p_order_id and parked_until > v_today;
end $$;
revoke all on function public.unpark_quote(text) from public, anon;
grant execute on function public.unpark_quote(text) to authenticated;

-- Calendar: a parked quote shows on the day it comes back (kind quote_return). Everything else in the view is as before.
create or replace view public.calendar_actions with (security_invoker = true) as
SELECT b.follow_up_on AS item_date,
    'winback_followup'::text AS kind,
    COALESCE(b.owner, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(b.company), ''::text), NULLIF(btrim(b.name), ''::text), b.customer_id) AS label,
    b.customer_id AS ref_id,
    COALESCE(b.last_contact_outcome, ''::text) AS detail
   FROM winback_board b
  WHERE ((b.follow_up_on IS NOT NULL) AND (COALESCE(b.suppress_alerts, false) = false) AND (b.closed_at IS NULL) AND ((b.parked_until IS NULL) OR (b.parked_until <= CURRENT_DATE)) AND (COALESCE(b.last_contact_outcome, ''::text) <> ALL (ARRAY['ordered'::text, 'not_interested'::text])) AND ((b.last_order_date IS NULL) OR (b.last_contact_at IS NULL) OR (b.last_order_date <= (b.last_contact_at)::date)))
UNION ALL
 SELECT ((b.email_due_at AT TIME ZONE 'Europe/London'::text))::date AS item_date,
    'winback_reply'::text AS kind,
    COALESCE(b.owner, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(b.company), ''::text), NULLIF(btrim(b.name), ''::text), b.customer_id) AS label,
    b.customer_id AS ref_id,
    ('email '::text || COALESCE(b.email_no, 1)) AS detail
   FROM winback_board b
  WHERE ((b.email_due_at IS NOT NULL) AND (b.email_replied_at IS NULL) AND (b.closed_at IS NULL) AND (b.email_sent_at > (now() - '30 days'::interval)))
UNION ALL
 SELECT ((q.email_due_at AT TIME ZONE 'Europe/London'::text))::date AS item_date,
    'quote_reply'::text AS kind,
    COALESCE(q.assigned_to, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(q.customer_name), ''::text), NULLIF(btrim(q.job_name), ''::text), q.order_id) AS label,
    q.order_id AS ref_id,
    ((('quote '::text || COALESCE(q.deco_id, q.order_id)) || ' email '::text) || COALESCE(q.email_chase_no, 1)) AS detail
   FROM quotes_board q
  WHERE ((q.email_due_at IS NOT NULL) AND (q.email_replied_at IS NULL) AND (q.approved_at IS NULL) AND (q.order_status IS DISTINCT FROM 4) AND (q.email_sent_at > (now() - '30 days'::interval)))
UNION ALL
 SELECT n.follow_up_on AS item_date,
    'nc_followup'::text AS kind,
    COALESCE(n.owner, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(n.company), ''::text), NULLIF(btrim(n.contact_name), ''::text), 'New customer'::text) AS label,
    (n.id)::text AS ref_id,
    COALESCE(n.last_activity_outcome, ''::text) AS detail
   FROM nc_board n
  WHERE ((n.follow_up_on IS NOT NULL) AND (n.closed_at IS NULL) AND ((n.parked_until IS NULL) OR (n.parked_until <= CURRENT_DATE)) AND (n.first_order_id IS NULL))
UNION ALL
 SELECT ((n.email_due_at AT TIME ZONE 'Europe/London'::text))::date AS item_date,
    'nc_reply'::text AS kind,
    COALESCE(n.owner, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(n.company), ''::text), NULLIF(btrim(n.contact_name), ''::text), 'New customer'::text) AS label,
    (n.id)::text AS ref_id,
    ('email '::text || COALESCE(n.email_no, 1)) AS detail
   FROM nc_board n
  WHERE ((n.email_due_at IS NOT NULL) AND (n.email_replied_at IS NULL) AND (n.closed_at IS NULL) AND (n.email_sent_at > (now() - '30 days'::interval)))
UNION ALL
 SELECT p.parked_until AS item_date,
    'quote_return'::text AS kind,
    COALESCE(p.assigned_to, 'Unassigned'::text) AS owner,
    COALESCE(NULLIF(btrim(p.customer_name), ''::text), NULLIF(btrim(p.job_name), ''::text), p.order_id) AS label,
    p.order_id AS ref_id,
    COALESCE(p.reason, ''::text) AS detail
   FROM quotes_parked_board p;
