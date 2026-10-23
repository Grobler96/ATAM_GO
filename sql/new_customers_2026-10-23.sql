-- New customers tab (23 Oct 2026; applied to Supabase project aobosyvlhgkxhjxkfzlz).
-- A nurture pipeline for people who are new and have not been quoted yet: post a catalogue, get a login set up, find out what
-- products they want and record it, so whoever quotes them later has a good starting point.
--
-- Where new customers come from:
--   deco    nc_sync_from_deco(days): customers whose first DecoNetwork order record is recent (default 90 days) and who have placed
--           at most one counted order, left out if the company already has an established account (3+ orders in total, e.g. a
--           branch of PPG). Run nightly by the n8n workflow "Sync customer reorder metrics" and by the "Check DecoNetwork now" button.
--           (DecoNetwork has no customer list in its API, so someone who registered but never ordered cannot be seen.)
--   manual  nc_add(): someone adds a customer by hand.
--   csv     nc_import(): rows from a customer export file, de-duplicated by email.
-- Reading is for signed-in users. Writing only goes through the security-definer functions below. Emails use the same n8n
-- workflow as quotes and win-back (body kind = 'nc').

create table if not exists public.nc_customers (
  id bigserial primary key,
  source text not null default 'manual' check (source in ('manual', 'deco', 'csv')),
  deco_customer_id text unique,
  company text, contact_name text, email text, phone text,
  owner text,
  first_seen date not null default current_date,
  interests text[] not null default '{}',
  decoration text[] not null default '{}',
  est_qty text, has_logo text, staff_count text, timing text, decision_maker text, budget text, notes text,
  catalogue_posted_at timestamptz, catalogue_posted_by text,
  login_created_at timestamptz, login_created_by text,
  ready_at timestamptz, ready_by text,
  parked_until date, closed_at timestamptz, closed_reason text,
  first_order_id text, first_order_value numeric, first_order_summary text,
  created_at timestamptz not null default now(), created_by text,
  updated_at timestamptz not null default now(), updated_by text
);
create index if not exists nc_customers_email_idx on public.nc_customers (lower(email));

create table if not exists public.nc_activity (
  id bigserial primary key,
  nc_id bigint not null references public.nc_customers (id) on delete cascade,
  by_name text, method text not null, outcome text not null, note text, follow_up_on date,
  created_at timestamptz not null default now()
);
create index if not exists nc_activity_nc_idx on public.nc_activity (nc_id, created_at desc);

create table if not exists public.nc_emails (
  id bigserial primary key,
  nc_id bigint not null references public.nc_customers (id) on delete cascade,
  chase_no int not null,
  sender_id bigint references public.mail_senders (id),
  sender_email text not null, to_email text not null, subject text not null, body text not null,
  sent_by text, sent_by_user uuid,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text, graph_message_id text, conversation_id text,
  created_at timestamptz not null default now(), sent_at timestamptz, reply_due_at timestamptz, replied_at timestamptz
);
create index if not exists nc_emails_nc_idx on public.nc_emails (nc_id, created_at desc);
create index if not exists nc_emails_open_idx on public.nc_emails (status, replied_at);

alter table public.nc_customers enable row level security;
alter table public.nc_activity enable row level security;
alter table public.nc_emails enable row level security;
create policy "authenticated read nc_customers" on public.nc_customers for select to authenticated using (true);
create policy "authenticated read nc_activity" on public.nc_activity for select to authenticated using (true);
create policy "authenticated read nc_emails" on public.nc_emails for select to authenticated using (true);
revoke all on public.nc_customers, public.nc_activity, public.nc_emails from anon;
revoke insert, update, delete, truncate on public.nc_customers, public.nc_activity, public.nc_emails from authenticated;
revoke usage, select on sequence public.nc_customers_id_seq, public.nc_activity_id_seq, public.nc_emails_id_seq from anon, authenticated;

create or replace function public.nc_user_name() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(full_name, email) from profiles where id = auth.uid()), 'Unknown')
$$;
revoke all on function public.nc_user_name() from public, anon;
grant execute on function public.nc_user_name() to authenticated;

-- add one by hand
create or replace function public.nc_add(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_email text := nullif(btrim(p->>'email'), '');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if nullif(btrim(coalesce(p->>'company', '')), '') is null and nullif(btrim(coalesce(p->>'contact_name', '')), '') is null then raise exception 'add a company or a contact name'; end if;
  if v_email is not null and v_email !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$' then raise exception 'the email address does not look right'; end if;
  if v_email is not null and exists (select 1 from nc_customers where lower(email) = lower(v_email)) then raise exception 'someone with that email is already in New customers'; end if;
  insert into nc_customers (source, company, contact_name, email, phone, owner, notes, created_by, updated_by)
  values ('manual', nullif(btrim(p->>'company'), ''), nullif(btrim(p->>'contact_name'), ''), v_email, nullif(btrim(p->>'phone'), ''),
          coalesce(nullif(btrim(p->>'owner'), ''), nc_user_name()), nullif(btrim(p->>'notes'), ''), nc_user_name(), nc_user_name())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.nc_add(jsonb) from public, anon; grant execute on function public.nc_add(jsonb) to authenticated;

-- change the details, interests and notes (only these fields can be changed)
create or replace function public.nc_update(p_id bigint, p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from nc_customers where id = p_id) then raise exception 'customer not found'; end if;
  if p ? 'email' then
    v_email := nullif(btrim(p->>'email'), '');
    if v_email is not null and v_email !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$' then raise exception 'the email address does not look right'; end if;
  end if;
  update nc_customers set
    company = case when p ? 'company' then nullif(btrim(p->>'company'), '') else company end,
    contact_name = case when p ? 'contact_name' then nullif(btrim(p->>'contact_name'), '') else contact_name end,
    email = case when p ? 'email' then v_email else email end,
    phone = case when p ? 'phone' then nullif(btrim(p->>'phone'), '') else phone end,
    owner = case when p ? 'owner' then nullif(btrim(p->>'owner'), '') else owner end,
    interests = case when p ? 'interests' then coalesce(array(select left(btrim(x), 60) from jsonb_array_elements_text(p->'interests') x limit 40), '{}') else interests end,
    decoration = case when p ? 'decoration' then coalesce(array(select left(btrim(x), 40) from jsonb_array_elements_text(p->'decoration') x limit 10), '{}') else decoration end,
    est_qty = case when p ? 'est_qty' then left(nullif(btrim(p->>'est_qty'), ''), 100) else est_qty end,
    has_logo = case when p ? 'has_logo' then left(nullif(btrim(p->>'has_logo'), ''), 20) else has_logo end,
    staff_count = case when p ? 'staff_count' then left(nullif(btrim(p->>'staff_count'), ''), 100) else staff_count end,
    timing = case when p ? 'timing' then left(nullif(btrim(p->>'timing'), ''), 200) else timing end,
    decision_maker = case when p ? 'decision_maker' then left(nullif(btrim(p->>'decision_maker'), ''), 200) else decision_maker end,
    budget = case when p ? 'budget' then left(nullif(btrim(p->>'budget'), ''), 200) else budget end,
    notes = case when p ? 'notes' then left(nullif(btrim(p->>'notes'), ''), 4000) else notes end,
    updated_at = now(), updated_by = nc_user_name()
  where id = p_id;
end $$;
revoke all on function public.nc_update(bigint, jsonb) from public, anon; grant execute on function public.nc_update(bigint, jsonb) to authenticated;

-- tick or untick: catalogue posted, login created, ready to quote
create or replace function public.nc_mark(p_id bigint, p_what text, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
declare v_by text := nc_user_name();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_what not in ('catalogue', 'login', 'ready') then raise exception 'unknown step'; end if;
  if not exists (select 1 from nc_customers where id = p_id) then raise exception 'customer not found'; end if;
  if p_what = 'catalogue' then
    update nc_customers set catalogue_posted_at = case when p_on then now() end, catalogue_posted_by = case when p_on then v_by end, updated_at = now(), updated_by = v_by where id = p_id;
    if p_on then insert into nc_activity (nc_id, by_name, method, outcome, note, follow_up_on) values (p_id, v_by, 'post', 'catalogue_posted', 'Catalogue posted', current_date + 7); end if;
  elsif p_what = 'login' then
    update nc_customers set login_created_at = case when p_on then now() end, login_created_by = case when p_on then v_by end, updated_at = now(), updated_by = v_by where id = p_id;
    if p_on then insert into nc_activity (nc_id, by_name, method, outcome, note) values (p_id, v_by, 'other', 'login_created', 'Login created'); end if;
  else
    update nc_customers set ready_at = case when p_on then now() end, ready_by = case when p_on then v_by end, updated_at = now(), updated_by = v_by where id = p_id;
    if p_on then insert into nc_activity (nc_id, by_name, method, outcome, note) values (p_id, v_by, 'other', 'ready_to_quote', 'Marked ready to quote'); end if;
  end if;
end $$;
revoke all on function public.nc_mark(bigint, text, boolean) from public, anon; grant execute on function public.nc_mark(bigint, text, boolean) to authenticated;

-- log a call, visit, message...
create or replace function public.nc_log(p_id bigint, p_method text, p_outcome text, p_note text, p_follow_up date) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_method not in ('call', 'email', 'whatsapp', 'visit', 'post', 'other') then raise exception 'unknown method'; end if;
  if p_outcome not in ('spoke', 'left_message', 'no_answer', 'ring_back', 'replied', 'quote_requested', 'not_interested', 'note') then raise exception 'unknown outcome'; end if;
  if not exists (select 1 from nc_customers where id = p_id) then raise exception 'customer not found'; end if;
  insert into nc_activity (nc_id, by_name, method, outcome, note, follow_up_on) values (p_id, nc_user_name(), p_method, p_outcome, left(nullif(btrim(p_note), ''), 1000), p_follow_up);
  update nc_customers set updated_at = now(), updated_by = nc_user_name() where id = p_id;
end $$;
revoke all on function public.nc_log(bigint, text, text, text, date) from public, anon; grant execute on function public.nc_log(bigint, text, text, text, date) to authenticated;

-- park, close (lost), reopen
create or replace function public.nc_set_state(p_id bigint, p_action text, p_until date, p_reason text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from nc_customers where id = p_id) then raise exception 'customer not found'; end if;
  if p_action = 'park' then
    if p_until is null or p_until <= current_date then raise exception 'pick a date in the future'; end if;
    update nc_customers set parked_until = p_until, closed_at = null, closed_reason = null, updated_at = now(), updated_by = nc_user_name() where id = p_id;
  elsif p_action = 'lost' then
    update nc_customers set closed_at = now(), closed_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Not interested'), 200), parked_until = null, updated_at = now(), updated_by = nc_user_name() where id = p_id;
  elsif p_action = 'reopen' then
    update nc_customers set parked_until = null, closed_at = null, closed_reason = null, updated_at = now(), updated_by = nc_user_name() where id = p_id;
  else raise exception 'unknown action'; end if;
end $$;
revoke all on function public.nc_set_state(bigint, text, date, text) from public, anon; grant execute on function public.nc_set_state(bigint, text, date, text) to authenticated;

-- rows from a customer export file: [{ company, contact_name, email, phone, date_added }]
create or replace function public.nc_import(p_rows jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_email text; v_added int := 0; v_skipped int := 0; v_bad int := 0; v_date date;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'send up to 2000 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_email := nullif(btrim(r->>'email'), '');
    if (nullif(btrim(coalesce(r->>'company', '')), '') is null and nullif(btrim(coalesce(r->>'contact_name', '')), '') is null)
       or (v_email is not null and v_email !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$') then v_bad := v_bad + 1; continue; end if;
    if v_email is not null and exists (select 1 from nc_customers where lower(email) = lower(v_email)) then v_skipped := v_skipped + 1; continue; end if;
    v_date := null; begin v_date := nullif(r->>'date_added', '')::date; exception when others then v_date := null; end;
    insert into nc_customers (source, company, contact_name, email, phone, first_seen, owner, created_by, updated_by)
    values ('csv', left(nullif(btrim(r->>'company'), ''), 200), left(nullif(btrim(r->>'contact_name'), ''), 200), v_email, left(nullif(btrim(r->>'phone'), ''), 60),
            coalesce(v_date, current_date), nullif(btrim(r->>'owner'), ''), nc_user_name(), nc_user_name());
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'already_there', v_skipped, 'skipped_bad_rows', v_bad);
end $$;
revoke all on function public.nc_import(jsonb) from public, anon; grant execute on function public.nc_import(jsonb) to authenticated;

-- pull new customers from the DecoNetwork orders already saved in deco_orders_raw
-- (owner = whoever handles the company's orders or quotes in DecoNetwork; later runs fill in a missing owner)
create or replace function public.nc_sync_from_deco(p_days int default 90) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role') then raise exception 'not signed in'; end if;
  with c as (
    select customer_id,
           min(nullif(date_ordered, '')::timestamp) filter (where order_status is distinct from 4) first_seen,
           count(*) filter (where order_type in (0, 3) and order_status in (1, 2, 3) and payment_status in (4, 5, 9)) counted,
           count(*) filter (where order_status is distinct from 4) live_rows,
           (array_agg(nullif(btrim(company), '') order by nullif(date_ordered, '')::timestamp desc))[1] company,
           (array_agg(nullif(btrim(name), '') order by nullif(date_ordered, '')::timestamp desc))[1] contact,
           (array_agg(nullif(btrim(email), '') order by nullif(date_ordered, '')::timestamp desc))[1] email,
           (array_agg(order_id order by nullif(date_ordered, '')::timestamp asc))[1] first_id,
           (array_agg(billable_amount order by nullif(date_ordered, '')::timestamp asc))[1] first_value,
           (array_agg(order_summary order by nullif(date_ordered, '')::timestamp asc))[1] first_summary
    from deco_orders_raw where coalesce(customer_id, '') <> '' and coalesce(date_ordered, '') <> '' group by customer_id
  ), est as (
    select wb_norm(coalesce(nullif(company, ''), name)) k from customer_reorder_metrics group by 1 having sum(total_orders) >= 3
  ), own as (
    select distinct on (k) k, assigned_to from (
      select wb_norm(customer_name) k, assigned_to, date_due from wip_orders where assigned_to is not null and btrim(assigned_to) <> '' and customer_name is not null) x
    where k is not null order by k, date_due desc nulls last
  ), qown as (
    select distinct on (e) e, assigned_to from (
      select lower(btrim(contact_email)) e, assigned_to, created_at from quotes_board where assigned_to is not null and btrim(assigned_to) <> '' and coalesce(btrim(contact_email), '') <> '') y
    order by e, created_at desc
  ), ins as (
    insert into nc_customers (source, deco_customer_id, company, contact_name, email, owner, first_seen, first_order_id, first_order_value, first_order_summary, created_by, updated_by)
    select 'deco', c.customer_id, c.company, c.contact, c.email, coalesce(o1.assigned_to, o2.assigned_to, qo.assigned_to), c.first_seen::date, c.first_id, c.first_value, c.first_summary, 'DecoNetwork', 'DecoNetwork'
    from c
    left join own o1 on o1.k = wb_norm(c.company)
    left join own o2 on o2.k = wb_norm(c.contact)
    left join qown qo on qo.e = lower(c.email)
    where c.first_seen >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 400))) and c.counted <= 1 and c.live_rows > 0
      and not exists (select 1 from est e where e.k = wb_norm(coalesce(c.company, c.contact)))
      and not exists (select 1 from customer_reorder_metrics m where m.customer_id = c.customer_id and m.total_orders >= 2)
      and not exists (select 1 from nc_customers x where x.deco_customer_id = c.customer_id or (c.email is not null and lower(x.email) = lower(c.email)))
    returning 1)
  select count(*) into n from ins;

  update nc_customers nc set owner = x.assigned_to, updated_at = now()
  from (
    select n2.id, coalesce(
      (select w.assigned_to from wip_orders w where w.assigned_to is not null and btrim(w.assigned_to) <> '' and wb_norm(w.customer_name) is not null and wb_norm(w.customer_name) in (wb_norm(n2.company), wb_norm(n2.contact_name)) order by w.date_due desc nulls last limit 1),
      (select q.assigned_to from quotes_board q where q.assigned_to is not null and btrim(q.assigned_to) <> '' and n2.email is not null and lower(btrim(q.contact_email)) = lower(n2.email) order by q.created_at desc limit 1)) assigned_to
    from nc_customers n2 where n2.owner is null) x
  where nc.id = x.id and x.assigned_to is not null;
  return n;
end $$;
revoke all on function public.nc_sync_from_deco(int) from public, anon; grant execute on function public.nc_sync_from_deco(int) to authenticated, service_role;

-- history panel (same panel as Quotes / Win-back)
create or replace function public.nc_customer_history(p_id bigint) returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v_name text;
begin
  select coalesce(nullif(btrim(company), ''), nullif(btrim(contact_name), '')) into v_name from nc_customers where id = p_id;
  return customer_history_by_name(v_name);
end $$;
revoke all on function public.nc_customer_history(bigint) from public, anon; grant execute on function public.nc_customer_history(bigint) to authenticated;

-- the board
create or replace view public.nc_board with (security_invoker = true) as
select c.*,
       la.created_at as last_activity_at, la.by_name as last_activity_by, la.method as last_activity_method, la.outcome as last_activity_outcome,
       la.note as last_activity_note, la.follow_up_on as follow_up_on,
       coalesce(ac.n, 0) as activity_count,
       em.chase_no as email_no, em.sent_at as email_sent_at, em.reply_due_at as email_due_at, em.replied_at as email_replied_at, em.sender_email as email_sender,
       m.total_orders as deco_total_orders, m.last_order_date as deco_last_order_date,
       q.quote_count, q.last_quote_at, q.last_quote_value, q.last_quote_id, q.last_quote_approved_at
from nc_customers c
left join lateral (select * from nc_activity a where a.nc_id = c.id order by a.created_at desc, a.id desc limit 1) la on true
left join lateral (select count(*)::int n from nc_activity a where a.nc_id = c.id) ac on true
left join lateral (select e.chase_no, e.sent_at, e.reply_due_at, e.replied_at, e.sender_email from nc_emails e where e.nc_id = c.id and e.status = 'sent' order by e.sent_at desc limit 1) em on true
left join lateral (select total_orders, last_order_date from customer_reorder_metrics x where x.customer_id = c.deco_customer_id limit 1) m on true
left join lateral (
  select count(*)::int quote_count, max(created_at) last_quote_at,
         (array_agg(quote_value order by created_at desc))[1] last_quote_value, (array_agg(order_id order by created_at desc))[1] last_quote_id,
         max(approved_at) last_quote_approved_at
  from quotes_board qb
  where (c.email is not null and lower(btrim(qb.contact_email)) = lower(c.email))
     or (wb_norm(qb.customer_name) is not null and wb_norm(qb.customer_name) in (wb_norm(c.company), wb_norm(c.contact_name)))
) q on true;
grant select on public.nc_board to authenticated;
revoke all on public.nc_board from anon;

-- emails (same pattern as quote_emails and winback_emails)
create or replace function public.queue_nc_email(p_nc_id bigint, p_sender_id bigint, p_to text, p_subject text, p_body text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_sender mail_senders; v_name text; v_no int; v_id bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_sender from mail_senders where id = p_sender_id and active;
  if not found then raise exception 'that sender is not set up or is switched off'; end if;
  if p_to is null or p_to !~* '^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$' then raise exception 'the customer email address does not look right'; end if;
  if btrim(coalesce(p_subject, '')) = '' or length(p_subject) > 300 then raise exception 'add a subject (300 characters at most)'; end if;
  if btrim(coalesce(p_body, '')) = '' or length(p_body) > 20000 then raise exception 'add a message'; end if;
  if not exists (select 1 from nc_customers where id = p_nc_id) then raise exception 'customer not found'; end if;
  if exists (select 1 from nc_emails where nc_id = p_nc_id and status = 'queued' and created_at > now() - interval '2 minutes') then
    raise exception 'an email for this customer was only just sent for sending, give it a minute';
  end if;
  v_name := nc_user_name();
  select count(*) + 1 into v_no from nc_emails where nc_id = p_nc_id and status = 'sent';
  insert into nc_emails (nc_id, chase_no, sender_id, sender_email, to_email, subject, body, sent_by, sent_by_user)
  values (p_nc_id, v_no, v_sender.id, v_sender.email, btrim(p_to), btrim(p_subject), p_body, v_name, auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.queue_nc_email(bigint, bigint, text, text, text) from public, anon;
grant execute on function public.queue_nc_email(bigint, bigint, text, text, text) to authenticated;

create or replace function public.mark_nc_email_sent(p_id bigint, p_graph_id text, p_conversation_id text)
returns void language plpgsql security definer set search_path = public as $$
declare e nc_emails;
begin
  update nc_emails set status = 'sent', sent_at = now(), reply_due_at = now() + interval '3 days', graph_message_id = p_graph_id, conversation_id = p_conversation_id, error = null
   where id = p_id and status = 'queued' returning * into e;
  if not found then raise exception 'email % is not waiting to be sent', p_id; end if;
  insert into nc_activity (nc_id, by_name, method, outcome, note, follow_up_on)
  values (e.nc_id, e.sent_by, 'email', 'left_message', 'Emailed via ATAM GO (email #' || e.chase_no || ') from ' || e.sender_email, current_date + 3);
end $$;
create or replace function public.mark_nc_email_failed(p_id bigint, p_error text)
returns void language sql security definer set search_path = public as $$
  update nc_emails set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 500) where id = p_id and status = 'queued';
$$;
create or replace function public.mark_nc_email_replied(p_id bigint, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare e nc_emails;
begin
  update nc_emails set replied_at = coalesce(p_at, now()) where id = p_id and status = 'sent' and replied_at is null returning * into e;
  if found then
    insert into nc_activity (nc_id, by_name, method, outcome, note, created_at)
    values (e.nc_id, 'Customer reply (automatic)', 'email', 'replied', 'Reply found in ' || e.sender_email || ' mailbox', coalesce(p_at, now()));
  end if;
end $$;
revoke all on function public.mark_nc_email_sent(bigint, text, text), public.mark_nc_email_failed(bigint, text), public.mark_nc_email_replied(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_nc_email_sent(bigint, text, text), public.mark_nc_email_failed(bigint, text), public.mark_nc_email_replied(bigint, timestamptz) to service_role;
