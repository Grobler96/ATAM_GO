-- Calendar tab: one list of "things to do on a date" across Win-back, Quotes and New customers. Read-only view,
-- signed-in users only (security_invoker, so the underlying row level security still applies). Applied 26 Oct 2026.
--   kind: winback_followup | winback_reply | quote_reply | nc_followup | nc_reply
--   *_followup = a "chase again on" date someone set; *_reply = the 3-day wait after an email we sent has run out.
-- Rules match the morning email (winback_owner_digest): parked, lost, switched-off and already-ordered customers are left out.
create or replace view public.calendar_actions with (security_invoker = true) as
select b.follow_up_on as item_date, 'winback_followup'::text as kind, coalesce(b.owner, 'Unassigned') as owner,
       coalesce(nullif(btrim(b.company), ''), nullif(btrim(b.name), ''), b.customer_id)::text as label,
       b.customer_id::text as ref_id, coalesce(b.last_contact_outcome, '')::text as detail
from winback_board b
where b.follow_up_on is not null and coalesce(b.suppress_alerts, false) = false and b.closed_at is null
  and (b.parked_until is null or b.parked_until <= current_date)
  and coalesce(b.last_contact_outcome, '') not in ('ordered', 'not_interested')
  and (b.last_order_date is null or b.last_contact_at is null or b.last_order_date::date <= b.last_contact_at::date)
union all
select (b.email_due_at at time zone 'Europe/London')::date, 'winback_reply', coalesce(b.owner, 'Unassigned'),
       coalesce(nullif(btrim(b.company), ''), nullif(btrim(b.name), ''), b.customer_id)::text, b.customer_id::text, ('email ' || coalesce(b.email_no, 1))::text
from winback_board b
where b.email_due_at is not null and b.email_replied_at is null and b.closed_at is null and b.email_sent_at > now() - interval '30 days'
union all
select (q.email_due_at at time zone 'Europe/London')::date, 'quote_reply', coalesce(q.assigned_to, 'Unassigned'),
       coalesce(nullif(btrim(q.customer_name), ''), nullif(btrim(q.job_name), ''), q.order_id)::text, q.order_id::text,
       ('quote ' || coalesce(q.deco_id, q.order_id) || ' email ' || coalesce(q.email_chase_no, 1))::text
from quotes_board q
where q.email_due_at is not null and q.email_replied_at is null and q.approved_at is null and q.order_status is distinct from 4
  and q.email_sent_at > now() - interval '30 days'
union all
select n.follow_up_on, 'nc_followup', coalesce(n.owner, 'Unassigned'),
       coalesce(nullif(btrim(n.company), ''), nullif(btrim(n.contact_name), ''), 'New customer')::text, n.id::text, coalesce(n.last_activity_outcome, '')::text
from nc_board n
where n.follow_up_on is not null and n.closed_at is null and (n.parked_until is null or n.parked_until <= current_date) and n.first_order_id is null
union all
select (n.email_due_at at time zone 'Europe/London')::date, 'nc_reply', coalesce(n.owner, 'Unassigned'),
       coalesce(nullif(btrim(n.company), ''), nullif(btrim(n.contact_name), ''), 'New customer')::text, n.id::text, ('email ' || coalesce(n.email_no, 1))::text
from nc_board n
where n.email_due_at is not null and n.email_replied_at is null and n.closed_at is null and n.email_sent_at > now() - interval '30 days';

grant select on public.calendar_actions to authenticated;
revoke all on public.calendar_actions from anon;
