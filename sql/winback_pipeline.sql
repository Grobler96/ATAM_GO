-- Win-back pipeline (reorder review + quotes). Everything is read by signed-in users only; writes go through the
-- three security-definer functions at the bottom. Re-runnable.

-- 1) name normaliser used to match quote customers to reorder customers
create or replace function public.wb_norm(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(lower(coalesce(t, '')), '\m(ltd|limited|uk|plc|llp|inc|the|and)\M', ' ', 'g'), '[^a-z0-9]+', '', 'g'), '')
$$;

-- 2) tables
create table if not exists public.winback_contacts (
  id bigserial primary key,
  customer_id text not null,
  contacted_by text,
  method text not null,
  outcome text not null,
  note text,
  follow_up_on date,
  created_at timestamptz not null default now()
);
create index if not exists winback_contacts_customer_idx on public.winback_contacts (customer_id, created_at desc);

create table if not exists public.winback_state (
  customer_id text primary key,
  parked_until date,
  closed_at timestamptz,
  closed_reason text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- quote customer name (normalised) -> reorder customer. customer_id '_none' = "not an existing customer".
create table if not exists public.winback_quote_links (
  quote_key text primary key,
  quote_name text,
  customer_id text not null,
  linked_by text,
  linked_at timestamptz not null default now()
);

alter table public.winback_contacts enable row level security;
alter table public.winback_state enable row level security;
alter table public.winback_quote_links enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'winback_contacts' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.winback_contacts for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'winback_state' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.winback_state for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'winback_quote_links' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.winback_quote_links for select to authenticated using (true);
  end if;
end $$;
revoke all on public.winback_contacts, public.winback_state, public.winback_quote_links from anon;
grant select on public.winback_contacts, public.winback_state, public.winback_quote_links to authenticated;
revoke usage, select on sequence public.winback_contacts_id_seq from anon;

-- 3) quotes matched to reorder customers: manual link > same email > same company/name. One customer per quote
--    (if several customers tie, the one who ordered most recently).
create or replace view public.winback_customer_quotes with (security_invoker = true) as
with cust as (
  select customer_id, wb_norm(company) cn, wb_norm(name) nn, nullif(lower(btrim(email)), '') em, last_order_date
  from customer_reorder_alerts
), q as (
  select order_id, customer_name, contact_name, contact_email, wb_norm(customer_name) qk, lower(btrim(contact_email)) qe from quotes_board
), cand as (
  select q.order_id, c.customer_id, 1 rnk, c.last_order_date from q join winback_quote_links l on l.quote_key = q.qk and l.customer_id <> '_none' join cust c on c.customer_id = l.customer_id
  union all
  select q.order_id, c.customer_id, 2, c.last_order_date from q join cust c on c.em is not null and c.em = q.qe
  union all
  select q.order_id, c.customer_id, 3, c.last_order_date from q join cust c on q.qk is not null and (c.cn = q.qk or c.nn = q.qk)
), best as (
  select distinct on (order_id) order_id, customer_id, rnk from cand
  where order_id not in (select q.order_id from q join winback_quote_links l on l.quote_key = q.qk and l.customer_id = '_none')
  order by order_id, rnk, last_order_date desc nulls last, customer_id
)
select b.customer_id, case b.rnk when 1 then 'linked' when 2 then 'email' else 'name' end as match_kind,
       qb.order_id, qb.deco_id, qb.job_name, qb.customer_name, qb.contact_name, qb.contact_email, qb.store_name, qb.assigned_to,
       qb.order_status, qb.quote_value, qb.garment_qty, qb.created_at, qb.approved_at, qb.modified_at,
       qb.last_to_customer_at, qb.last_from_customer_at, qb.last_chase_at
from best b join quotes_board qb on qb.order_id = b.order_id;

-- 4) quotes nobody could match (recent, not yet approved), one row per customer name
create or replace view public.winback_unmatched_quotes with (security_invoker = true) as
select wb_norm(qb.customer_name) as quote_key, max(qb.customer_name) as customer_name, max(qb.contact_name) as contact_name,
       max(qb.contact_email) as contact_email, max(qb.assigned_to) as assigned_to, count(*)::int as quotes, sum(qb.quote_value) as value,
       max(qb.created_at) as latest_at, (array_agg(qb.order_id order by qb.created_at desc))[1] as latest_order_id,
       (array_agg(qb.job_name order by qb.created_at desc))[1] as latest_job
from quotes_board qb
where qb.approved_at is null and qb.order_status is distinct from 4 and qb.created_at > now() - interval '120 days'
  and wb_norm(qb.customer_name) is not null
  and qb.order_id not in (select order_id from winback_customer_quotes)
  and wb_norm(qb.customer_name) not in (select quote_key from winback_quote_links where customer_id = '_none')
group by wb_norm(qb.customer_name);

-- 5) the board: one row per customer worth showing
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
       s.parked_until, s.closed_at, s.closed_reason
from customer_reorder_alerts a
left join winback_state s on s.customer_id = a.customer_id
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id order by c.created_at desc limit 1) lc on true
left join lateral (select count(*)::int n from winback_contacts c where c.customer_id = a.customer_id) cn on true
left join lateral (select * from winback_contacts c where c.customer_id = a.customer_id and a.last_order_date is not null
                   and c.created_at::date <= a.last_order_date and c.created_at::date >= a.last_order_date - 60 order by c.created_at desc limit 1) ac on true
left join wip_owner wc on wc.k = wb_norm(a.company)
left join wip_owner wn on wn.k = wb_norm(a.name)
left join quote_owner qo on qo.customer_id = a.customer_id
where a.reorder_status in ('At Risk', 'Due Soon')
   or lc.created_at > now() - interval '120 days'
   or s.customer_id is not null
   or exists (select 1 from winback_customer_quotes wq where wq.customer_id = a.customer_id and wq.approved_at is null
              and wq.order_status is distinct from 4 and greatest(wq.created_at, wq.modified_at) > now() - interval '45 days');

grant select on public.winback_customer_quotes, public.winback_unmatched_quotes, public.winback_board to authenticated;
revoke all on public.winback_customer_quotes, public.winback_unmatched_quotes, public.winback_board from anon;

-- 6) writes
create or replace function public.log_winback_contact(p_customer_id text, p_method text, p_outcome text, p_note text, p_follow_up date)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_method not in ('call', 'email', 'whatsapp', 'visit', 'other') then raise exception 'unknown method'; end if;
  if p_outcome not in ('spoke', 'left_message', 'no_answer', 'replied', 'quote_requested', 'ring_back', 'not_interested', 'ordered') then raise exception 'unknown outcome'; end if;
  if not exists (select 1 from customer_reorder_alerts where customer_id = p_customer_id) then raise exception 'unknown customer'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into winback_contacts (customer_id, contacted_by, method, outcome, note, follow_up_on)
  values (p_customer_id, v_name, p_method, p_outcome, nullif(btrim(p_note), ''), p_follow_up);
  -- speaking to them again brings a parked / closed customer back onto the board
  update winback_state set parked_until = null, closed_at = null, closed_reason = null, updated_by = v_name, updated_at = now()
   where customer_id = p_customer_id and p_outcome <> 'not_interested';
end $$;

create or replace function public.set_winback_state(p_customer_id text, p_action text, p_until date, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_action not in ('park', 'lost', 'reopen') then raise exception 'unknown action'; end if;
  if not exists (select 1 from customer_reorder_alerts where customer_id = p_customer_id) then raise exception 'unknown customer'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  if p_action = 'park' and (p_until is null or p_until <= current_date) then raise exception 'pick a date in the future'; end if;
  insert into winback_state (customer_id, parked_until, closed_at, closed_reason, updated_by, updated_at)
  values (p_customer_id,
          case when p_action = 'park' then p_until end,
          case when p_action = 'lost' then now() end,
          case when p_action = 'lost' then nullif(btrim(p_reason), '') end, v_name, now())
  on conflict (customer_id) do update set parked_until = excluded.parked_until, closed_at = excluded.closed_at,
    closed_reason = excluded.closed_reason, updated_by = excluded.updated_by, updated_at = now();
end $$;

create or replace function public.link_quote_customer(p_quote_name text, p_customer_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_key text := wb_norm(p_quote_name);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if v_key is null then raise exception 'no customer name to link'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  if p_customer_id is null then delete from winback_quote_links where quote_key = v_key; return; end if;
  if p_customer_id <> '_none' and not exists (select 1 from customer_reorder_alerts where customer_id = p_customer_id) then raise exception 'unknown customer'; end if;
  insert into winback_quote_links (quote_key, quote_name, customer_id, linked_by) values (v_key, p_quote_name, p_customer_id, v_name)
  on conflict (quote_key) do update set customer_id = excluded.customer_id, linked_by = excluded.linked_by, linked_at = now();
end $$;

revoke all on function public.log_winback_contact(text, text, text, text, date), public.set_winback_state(text, text, date, text), public.link_quote_customer(text, text) from public, anon;
grant execute on function public.log_winback_contact(text, text, text, text, date), public.set_winback_state(text, text, date, text), public.link_quote_customer(text, text) to authenticated;
