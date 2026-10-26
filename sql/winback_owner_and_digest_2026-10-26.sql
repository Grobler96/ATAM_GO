-- Win-back: change the owner by hand, and a morning digest for each owner. Re-runnable.
-- Applied to the live database on 26 Oct 2026.

-- 1) Hand-picked owner. Wins over the automatic owner (salesperson on the last order, else on the quote).
--    Removing the row puts the customer back on the automatic owner.
create table if not exists public.winback_owner_override (
  customer_id text primary key,
  owner text not null,
  set_by text,
  set_at timestamptz not null default now()
);
alter table public.winback_owner_override enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'winback_owner_override' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.winback_owner_override for select to authenticated using (true);
  end if;
end $$;
revoke all on public.winback_owner_override from anon;
grant select on public.winback_owner_override to authenticated;

-- 2) What status each customer was in when the digest last looked, so "became due soon" can be told apart from
--    "has been due soon for weeks". Service role / security-definer only. Seeded with today's statuses so the first
--    digest does not announce every existing customer as new.
create table if not exists public.winback_status_seen (
  customer_id text primary key,
  reorder_status text,
  status_since date not null default current_date
);
alter table public.winback_status_seen enable row level security;
revoke all on public.winback_status_seen from anon, authenticated;
insert into public.winback_status_seen (customer_id, reorder_status, status_since)
select customer_id, reorder_status, date '2000-01-01' from public.customer_reorder_alerts
on conflict (customer_id) do nothing;

-- 3) The board, with the hand-picked owner applied. New column owner_manual is last so the existing columns do not move.
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
       coalesce(oo.owner, wc.assigned_to, wn.assigned_to, qo.assigned_to) as owner,
       lc.created_at as last_contact_at, lc.contacted_by as last_contact_by, lc.method as last_contact_method,
       lc.outcome as last_contact_outcome, lc.note as last_contact_note, lc.follow_up_on,
       coalesce(cn.n, 0) as contact_count,
       ac.created_at as attributed_contact_at, ac.contacted_by as attributed_contact_by,
       s.parked_until, s.closed_at, s.closed_reason,
       em.chase_no as email_no, em.sent_at as email_sent_at, em.reply_due_at as email_due_at, em.replied_at as email_replied_at,
       em.sender_email as email_sender,
       (oo.customer_id is not null) as owner_manual
from customer_reorder_alerts a
left join winback_state s on s.customer_id = a.customer_id
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id order by c.created_at desc limit 1) lc on true
left join lateral (select count(*)::int n from winback_contacts c where c.customer_id = a.customer_id) cn on true
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id and a.last_order_date is not null
                   and c.created_at::date <= a.last_order_date and c.created_at::date >= a.last_order_date - 120 order by c.created_at desc limit 1) ac on true
left join lateral (select e.chase_no, e.sent_at, e.reply_due_at, e.replied_at, e.sender_email from winback_emails e
                   where e.customer_id = a.customer_id and e.status = 'sent' order by e.sent_at desc limit 1) em on true
left join winback_owner_override oo on oo.customer_id = a.customer_id
left join wip_owner wc on wc.k = wb_norm(a.company)
left join wip_owner wn on wn.k = wb_norm(a.name)
left join quote_owner qo on qo.customer_id = a.customer_id
where a.reorder_status in ('At Risk', 'Due Soon')
   or lc.created_at > now() - interval '120 days'
   or s.customer_id is not null
   or oo.customer_id is not null
   or exists (select 1 from winback_customer_quotes wq where wq.customer_id = a.customer_id and wq.approved_at is null
              and wq.order_status is distinct from 4 and greatest(wq.created_at, wq.modified_at) > now() - interval '45 days');
grant select on public.winback_board to authenticated;
revoke all on public.winback_board from anon;

-- 4) Change the owner. Only the team members who can send mail (mail_senders, kind 'rep') can be picked. Null / blank = automatic.
create or replace function public.set_winback_owner(p_customer_id text, p_owner text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_owner text := nullif(btrim(p_owner), '');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from customer_reorder_alerts where customer_id = p_customer_id) then raise exception 'unknown customer'; end if;
  if v_owner is null then
    delete from winback_owner_override where customer_id = p_customer_id;
    return;
  end if;
  if not exists (select 1 from mail_senders where kind = 'rep' and active and rep_name = v_owner) then raise exception 'unknown team member'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into winback_owner_override (customer_id, owner, set_by, set_at) values (p_customer_id, v_owner, v_name, now())
  on conflict (customer_id) do update set owner = excluded.owner, set_by = excluded.set_by, set_at = now();
end $$;
revoke all on function public.set_winback_owner(text, text) from public, anon;
grant execute on function public.set_winback_owner(text, text) to authenticated;

-- 5) Morning digest, read by the n8n workflow "Win-back morning email to each owner" with the service role.
--    Returns one object per owner who has something: customers that became Due soon / At risk since the last working day,
--    and contacts whose "chase again on" date has arrived. Parked, lost and alert-suppressed customers are left out.
--    Safe to call twice in a day (the status snapshot only moves when a status really changes).
create or replace function public.winback_owner_digest()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_window int := case when extract(dow from current_date) = 1 then 3 else 1 end; v_out jsonb;
begin
  insert into winback_status_seen (customer_id, reorder_status, status_since)
  select customer_id, reorder_status, current_date from customer_reorder_alerts
  on conflict (customer_id) do update set
    status_since = case when winback_status_seen.reorder_status is distinct from excluded.reorder_status then current_date else winback_status_seen.status_since end,
    reorder_status = excluded.reorder_status;

  with el as (
    select b.customer_id, coalesce(nullif(btrim(b.company), ''), nullif(btrim(b.name), ''), b.customer_id) as label,
           coalesce(b.owner, 'Unassigned') as owner_key, b.reorder_status, b.overdue_by_days, b.last_order_value, b.last_order_date,
           b.follow_up_on, b.last_contact_outcome, b.last_contact_at, s.status_since
    from winback_board b join winback_status_seen s on s.customer_id = b.customer_id
    where coalesce(b.suppress_alerts, false) = false and b.closed_at is null and (b.parked_until is null or b.parked_until <= current_date)
  ), nd as (
    select * from el where reorder_status in ('Due Soon', 'At Risk') and status_since >= current_date - v_window
  ), fu as (
    select * from el where follow_up_on is not null and follow_up_on <= current_date
      and coalesce(last_contact_outcome, '') not in ('ordered', 'not_interested')
      and (last_order_date is null or last_contact_at is null or last_order_date::date <= last_contact_at::date)
  ), owners as (
    select distinct owner_key from (select owner_key from nd union all select owner_key from fu) z
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'owner', o.owner_key,
      'email', (select ms.email from mail_senders ms where ms.kind = 'rep' and ms.active and ms.rep_name = o.owner_key limit 1),
      'newly_due_count', (select count(*) from nd where nd.owner_key = o.owner_key),
      'newly_due', coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.customer_id, 'label', t.label, 'status', t.reorder_status,
                       'overdue_by_days', t.overdue_by_days, 'last_order_value', t.last_order_value, 'last_order_date', t.last_order_date)
                       order by t.overdue_by_days desc nulls last)
                     from (select * from nd where nd.owner_key = o.owner_key order by overdue_by_days desc nulls last limit 25) t), '[]'::jsonb),
      'follow_up_count', (select count(*) from fu where fu.owner_key = o.owner_key),
      'follow_ups', coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.customer_id, 'label', t.label, 'follow_up_on', t.follow_up_on,
                       'outcome', t.last_contact_outcome) order by t.follow_up_on)
                     from (select * from fu where fu.owner_key = o.owner_key order by follow_up_on limit 25) t), '[]'::jsonb)
    ) order by o.owner_key), '[]'::jsonb)
  into v_out from owners o;
  return v_out;
end $$;
revoke all on function public.winback_owner_digest() from public, anon, authenticated;
grant execute on function public.winback_owner_digest() to service_role;
