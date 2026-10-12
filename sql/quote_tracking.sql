-- Quote tracking for ATAM GO (applied to Supabase project aobosyvlhgkxhjxkfzlz on 12 Oct 2026).
--
-- A DecoNetwork quote is a wip_orders row with order_status = 1. The hourly WF5 sync only keeps the
-- CURRENT state of each order, so these tables keep the HISTORY:
--   quote_tracker : one row per quote seen (first seen, converted_at / cancelled_at, quote value)
--   quote_events  : append-only log of status changes
--   quote_chases  : chase-ups logged from the Quotes tab
-- A trigger on wip_orders maintains them, so the n8n sync needs no changes.
--   converted = quote left status 1 for anything except 4 (Cancelled); cancelled = moved to status 4.
-- The browser reads the quotes_pipeline view (authenticated only) and writes only via log_quote_chase().

create table if not exists public.quote_tracker (
  order_id      text primary key,
  first_seen_at timestamptz not null default now(),
  raised_at     timestamptz,            -- real DecoNetwork creation date, once the sync supplies it
  quote_value   numeric,                -- frozen when the quote leaves status 1
  converted_at  timestamptz,
  cancelled_at  timestamptz,
  converted_status int,
  backfilled    boolean not null default false
);
create table if not exists public.quote_events (
  id bigserial primary key, order_id text not null, event text not null,
  from_status int, to_status int, quote_value numeric, created_at timestamptz not null default now()
);
create index if not exists quote_events_order_idx on public.quote_events (order_id, created_at);
create table if not exists public.quote_chases (
  id bigserial primary key, order_id text not null, chased_by text, method text, note text,
  created_at timestamptz not null default now()
);
create index if not exists quote_chases_order_idx on public.quote_chases (order_id, created_at desc);

alter table public.quote_tracker enable row level security;
alter table public.quote_events  enable row level security;
alter table public.quote_chases  enable row level security;
create policy "authenticated read quote_tracker" on public.quote_tracker for select to authenticated using (true);
create policy "authenticated read quote_events"  on public.quote_events  for select to authenticated using (true);
create policy "authenticated read quote_chases"  on public.quote_chases  for select to authenticated using (true);
revoke all on public.quote_tracker, public.quote_events, public.quote_chases from anon;

-- quotes that already existed when tracking started
insert into quote_tracker (order_id, quote_value, backfilled)
select order_id, order_value, true from wip_orders where order_status = 1 on conflict (order_id) do nothing;
insert into quote_events (order_id, event, to_status, quote_value)
select order_id, 'quote_seen', 1, order_value from wip_orders w
where order_status = 1 and not exists (select 1 from quote_events e where e.order_id = w.order_id);

create or replace function public.trg_wip_orders_quote_track()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.order_status = 1 then
      insert into quote_tracker (order_id, quote_value) values (new.order_id, new.order_value) on conflict (order_id) do nothing;
      insert into quote_events (order_id, event, to_status, quote_value) values (new.order_id, 'quote_seen', 1, new.order_value);
    end if;
    return new;
  end if;
  if new.order_status = 1 and old.order_status is distinct from 1 then
    insert into quote_tracker (order_id, quote_value) values (new.order_id, new.order_value)
      on conflict (order_id) do update set converted_at = null, cancelled_at = null, converted_status = null, quote_value = excluded.quote_value;
    insert into quote_events (order_id, event, from_status, to_status, quote_value) values (new.order_id, 'quote_seen', old.order_status, 1, new.order_value);
  elsif new.order_status = 1 then
    update quote_tracker set quote_value = new.order_value where order_id = new.order_id;
  elsif old.order_status = 1 then
    insert into quote_tracker (order_id, quote_value) values (new.order_id, old.order_value) on conflict (order_id) do nothing;
    if new.order_status = 4 then
      update quote_tracker set cancelled_at = now() where order_id = new.order_id and cancelled_at is null;
      insert into quote_events (order_id, event, from_status, to_status, quote_value) values (new.order_id, 'cancelled', 1, 4, old.order_value);
    else
      update quote_tracker set converted_at = now(), converted_status = new.order_status, quote_value = coalesce(old.order_value, quote_value)
        where order_id = new.order_id and converted_at is null;
      insert into quote_events (order_id, event, from_status, to_status, quote_value) values (new.order_id, 'converted', 1, new.order_status, old.order_value);
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_wip_orders_quote_track() from public, anon, authenticated;

create trigger wip_orders_quote_ins after insert on public.wip_orders
  for each row when (new.order_status = 1) execute function public.trg_wip_orders_quote_track();
create trigger wip_orders_quote_upd after update on public.wip_orders
  for each row when (old.order_status is distinct from new.order_status
                     or (new.order_status = 1 and old.order_value is distinct from new.order_value))
  execute function public.trg_wip_orders_quote_track();

create or replace view public.quotes_pipeline with (security_invoker = on) as
select t.order_id, w.customer_name, w.store_name, w.assigned_to,
  coalesce(w.order_status, 1) as order_status,
  coalesce(t.quote_value, w.order_value) as quote_value, w.order_value as current_value,
  w.garment_qty, w.processes, w.shipping_method, w.date_due, w.date_shipped,
  t.first_seen_at, t.raised_at, t.converted_at, t.cancelled_at, t.converted_status, t.backfilled,
  c.chase_count, c.last_chase_at, c.last_chase_by, c.last_chase_note
from quote_tracker t
left join wip_orders w on w.order_id = t.order_id
left join lateral (
  select count(*)::int chase_count, max(created_at) last_chase_at,
         (array_agg(chased_by order by created_at desc))[1] last_chase_by,
         (array_agg(note order by created_at desc))[1] last_chase_note
  from quote_chases q where q.order_id = t.order_id) c on true;
grant select on public.quotes_pipeline to authenticated;
revoke all on public.quotes_pipeline from anon;

create or replace function public.log_quote_chase(p_order_id text, p_method text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_chases (order_id, chased_by, method, note) values (p_order_id, v_name, nullif(p_method, ''), nullif(btrim(p_note), ''));
end $$;
revoke all on function public.log_quote_chase(text, text, text) from public, anon;
grant execute on function public.log_quote_chase(text, text, text) to authenticated;
