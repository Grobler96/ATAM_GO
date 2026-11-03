-- Phone alerts (web push). Re-runnable.
--
-- How it fits together:
--   push_config         one row: the VAPID key pair that identifies ATAM GO to the phone makers' push services. Created by the n8n workflow
--                       "Phone alerts sender" the first time it runs (so the private key never passes through chat or the repo). Service role only.
--   push_subscriptions  one row per phone / browser that has switched alerts on (written only by save_push_subscription). A person sees only their own.
--   push_outbox         alerts waiting to go out. Service role only. Rows are inserted by push_scan() (real events), send_test_push() (a test to yourself).
--   push_seen           remembers which events have already been alerted, so nobody gets the same alert twice.
-- The sender workflow calls push_scan() (find new events), push_claim() (take pending alerts, mark them so they can never go twice, return them with the
-- devices to send to) and push_report() (record what happened; devices that are gone are switched off).
-- Alerts so far: a customer replied to a quote (to the quote's salesperson), and an order has just become late (to the order's salesperson).
-- The first time push_scan() runs it only records what already exists, so switching alerts on does not send a flood about old events.

create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  subject text not null default 'mailto:support@atam.co.uk',
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0,
  disabled boolean not null default false
);
alter table public.push_subscriptions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own rows') then
    create policy "own rows" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
  end if;
end $$;
revoke all on public.push_subscriptions from anon, authenticated;
grant select (id, created_at, last_ok_at, disabled, user_agent) on public.push_subscriptions to authenticated;

create table if not exists public.push_outbox (
  id bigserial primary key,
  user_id uuid,
  rep_name text,
  kind text not null default 'alert',
  title text not null,
  body text,
  url text not null default './',
  tag text,
  created_at timestamptz not null default now(),
  status text not null default 'pending',     -- pending, no_devices, claimed, sent, failed
  processed_at timestamptz,
  note text,
  check (user_id is not null or rep_name is not null)
);
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;
create index if not exists push_outbox_pending on public.push_outbox (status) where status = 'pending';

create table if not exists public.push_seen (
  key text primary key,
  seen_at timestamptz not null default now()
);
alter table public.push_seen enable row level security;
revoke all on public.push_seen from anon, authenticated;

-- The public half of the key, which the browser needs to subscribe. Null until the sender has made the keys.
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when auth.uid() is null then null else (select public_key from push_config where id = 1) end
$$;
revoke all on function public.push_public_key() from public, anon;
grant execute on function public.push_public_key() to authenticated;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then raise exception 'bad subscription'; end if;
  if coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'bad subscription'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
    disabled = false, fail_count = 0;
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- How many of my devices have alerts on.
create or replace function public.my_push_devices() returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when auth.uid() is null then 0 else (select count(*)::int from push_subscriptions where user_id = auth.uid() and not disabled) end
$$;
revoke all on function public.my_push_devices() from public, anon;
grant execute on function public.my_push_devices() to authenticated;

-- A test alert to myself (limited to 5 an hour).
create or replace function public.send_test_push() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from push_outbox where user_id = auth.uid() and kind = 'test' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'that is enough test alerts for now, try again in an hour';
  end if;
  insert into push_outbox (user_id, kind, title, body, tag) values (auth.uid(), 'test', 'ATAM GO alerts are on', 'This is a test. Real alerts will look like this.', 'test');
end $$;
revoke all on function public.send_test_push() from public, anon;
grant execute on function public.send_test_push() to authenticated;

-- Look for new events worth an alert and queue them. Service role only (the sender workflow calls it).
create or replace function public.push_scan() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_first boolean; v_n int := 0; r record;
begin
  v_first := not exists (select 1 from push_seen);
  -- 1. A customer replied to a quote and nobody has answered yet (reply in the last 2 days).
  for r in
    select b.order_id, b.customer_name, b.assigned_to, b.quote_value, b.last_from_customer_at,
           'reply:' || b.order_id || ':' || extract(epoch from b.last_from_customer_at)::bigint as k
      from quotes_board b
     where b.approved_at is null and b.order_status is distinct from 4
       and b.last_from_customer_at is not null
       and b.last_from_customer_at > coalesce(b.last_to_customer_at, '-infinity'::timestamptz)
       and b.last_from_customer_at > now() - interval '2 days'
  loop
    if not exists (select 1 from push_seen where key = r.k) then
      insert into push_seen (key) values (r.k);
      if not v_first and nullif(btrim(r.assigned_to), '') is not null then
        insert into push_outbox (rep_name, kind, title, body, url, tag)
        values (r.assigned_to, 'reply', 'Customer replied', coalesce(r.customer_name, 'A customer') || ' replied on quote #' || r.order_id || ' (£' || round(coalesce(r.quote_value, 0)) || ')', './?go=quotes', 'reply:' || r.order_id);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;
  -- 2. An open order became late (due in the last 2 days, not shipped).
  for r in
    select o.order_id, o.customer_name, o.assigned_to, o.order_value, 'late:' || o.order_id as k
      from wip_orders o
     where o.date_shipped is null and o.order_status in (1, 2, 5, 6, 8, 9)
       and o.date_due::date < (now() at time zone 'Europe/London')::date
       and o.date_due::date >= (now() at time zone 'Europe/London')::date - 2
  loop
    if not exists (select 1 from push_seen where key = r.k) then
      insert into push_seen (key) values (r.k);
      if not v_first and nullif(btrim(r.assigned_to), '') is not null then
        insert into push_outbox (rep_name, kind, title, body, url, tag)
        values (r.assigned_to, 'late', 'Order is late', coalesce(r.customer_name, 'An order') || ', order #' || r.order_id || ' was due and has not shipped', './?go=today', 'late:' || r.order_id);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;
  delete from push_seen where seen_at < now() - interval '30 days';
  return v_n;
end $$;
revoke all on function public.push_scan() from public, anon, authenticated;
grant execute on function public.push_scan() to service_role;

-- Take the pending alerts and the devices to send each one to. Marks them as taken straight away, so an alert can never go twice.
create or replace function public.push_claim(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_out jsonb := '[]'::jsonb; r record; subs jsonb;
begin
  for r in select * from push_outbox where status = 'pending' order by id limit greatest(1, least(p_limit, 200)) for update skip locked loop
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb) into subs
      from push_subscriptions s
     where not s.disabled
       and ((r.user_id is not null and s.user_id = r.user_id)
         or (r.rep_name is not null and exists (select 1 from profiles p where p.id = s.user_id and lower(btrim(p.full_name)) = lower(btrim(r.rep_name)))));
    if jsonb_array_length(subs) = 0 then
      update push_outbox set status = 'no_devices', processed_at = now() where id = r.id;
    else
      update push_outbox set status = 'claimed', processed_at = now() where id = r.id;
      v_out := v_out || jsonb_build_array(jsonb_build_object('outbox_id', r.id, 'title', r.title, 'body', r.body, 'url', r.url, 'tag', r.tag, 'subs', subs));
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.push_claim(int) from public, anon, authenticated;
grant execute on function public.push_claim(int) to service_role;

-- Record what happened: [{"outbox_id":1,"subscription_id":"...","ok":true,"status":201}, ...]
create or replace function public.push_report(p_results jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare x jsonb;
begin
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if (x->>'ok')::boolean then
      update push_subscriptions set last_ok_at = now(), fail_count = 0 where id = (x->>'subscription_id')::uuid;
    elsif (x->>'status') in ('404', '410') then
      update push_subscriptions set disabled = true where id = (x->>'subscription_id')::uuid;
    else
      update push_subscriptions set fail_count = fail_count + 1, disabled = (fail_count + 1 >= 5) where id = (x->>'subscription_id')::uuid;
    end if;
  end loop;
  update push_outbox o set status = case when exists (select 1 from jsonb_array_elements(p_results) y where (y->>'outbox_id')::bigint = o.id and (y->>'ok')::boolean) then 'sent' else 'failed' end
   where o.id in (select (y->>'outbox_id')::bigint from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) y) and o.status = 'claimed';
end $$;
revoke all on function public.push_report(jsonb) from public, anon, authenticated;
grant execute on function public.push_report(jsonb) to service_role;
