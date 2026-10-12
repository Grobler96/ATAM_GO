-- Quote tracking for ATAM GO (applied to Supabase project aobosyvlhgkxhjxkfzlz on 12 Oct 2026).
--
-- Source of truth is DecoNetwork itself. The n8n workflow WF7_Quotes_Sync (hourly, plus a manual 150-day backfill)
-- reads manage_orders/find and upserts into public.quotes:
--   order_type 2 + no date_ordered  = an open quote
--   order_type 3 + date_ordered     = a quote the customer approved (date_started = created, date_ordered = approved)
--   order_type 0                    = plain web-store order, ignored
--   notes of type to_customer / from_customer = emails sent to / received from the customer
-- (Order status 1 is NOT a quote: every status-1 order has already been approved.)
--
-- The browser reads the quotes_board view (authenticated only) and writes only via log_quote_chase().

create table if not exists public.quotes (
  order_id      text primary key,
  deco_id       text,                 -- DecoNetwork's internal id, used for the "Open in DecoNetwork" link
  job_name      text,
  customer_name text,
  contact_name  text,
  contact_email text,
  customer_po   text,
  store_name    text,
  assigned_to   text,
  order_type    int,
  order_status  int,
  quote_value   numeric,              -- item_amount, ex VAT
  garment_qty   int,
  processes     text[],
  created_at    timestamptz,          -- date_started
  approved_at   timestamptz,          -- date_ordered
  modified_at   timestamptz,
  date_due      timestamptz,
  date_shipped  timestamptz,
  notes_count   int not null default 0,
  last_note_at  timestamptz,
  last_to_customer_at   timestamptz,
  last_from_customer_at timestamptz,
  to_customer_count   int not null default 0,
  from_customer_count int not null default 0,
  synced_at     timestamptz not null default now()
);
create index if not exists quotes_assigned_idx on public.quotes (assigned_to);
create index if not exists quotes_created_idx on public.quotes (created_at);
create index if not exists quotes_approved_idx on public.quotes (approved_at);
alter table public.quotes enable row level security;
create policy "authenticated read quotes" on public.quotes for select to authenticated using (true);
revoke all on public.quotes from anon;

-- chases made by phone / visit, logged from the Quotes tab
create table if not exists public.quote_chases (
  id         bigserial primary key,
  order_id   text not null,
  chased_by  text,
  method     text,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists quote_chases_order_idx on public.quote_chases (order_id, created_at desc);
alter table public.quote_chases enable row level security;
create policy "authenticated read quote_chases" on public.quote_chases for select to authenticated using (true);
revoke all on public.quote_chases from anon;

create or replace view public.quotes_board with (security_invoker = on) as
select q.*, c.chase_count, c.last_chase_at, c.last_chase_by, c.last_chase_note
from public.quotes q
left join lateral (
  select count(*)::int chase_count, max(created_at) last_chase_at,
         (array_agg(chased_by order by created_at desc))[1] last_chase_by,
         (array_agg(note order by created_at desc))[1] last_chase_note
  from public.quote_chases x where x.order_id = q.order_id
) c on true;
grant select on public.quotes_board to authenticated;
revoke all on public.quotes_board from anon;

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
