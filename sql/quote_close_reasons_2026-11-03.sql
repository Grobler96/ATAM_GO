-- Quotes: a reason for closing a quote (Daniel's suggestion). Re-runnable.
--
-- When a quote is removed by hand, or when a quote has gone Lost / Expired, someone can say why: it converted on another quote,
-- the customer bought elsewhere, budget, or other (a short note is required for "other"). "Needs more time" is not a reason here:
-- the page sends that to Park instead. Nothing in quotes, quote_removed or quotes_board changes; the reason sits in its own table and the
-- page joins it up, so DAN and the counts are untouched.
-- The report on the Lost tab reads quote_close_reasons_board (it includes removed quotes, which are not on quotes_board).

create table if not exists public.quote_close_reason (
  order_id text primary key,
  code     text not null check (code in ('converted_other', 'bought_elsewhere', 'budget', 'other')),
  note     text check (note is null or char_length(note) <= 300),
  set_by   text,
  set_at   timestamptz not null default now()
);
alter table public.quote_close_reason enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'quote_close_reason' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_close_reason for select to authenticated using (true);
  end if;
end $$;
revoke all on public.quote_close_reason from anon, authenticated;
grant select on public.quote_close_reason to authenticated;

-- keep the AI tool's name out of the "done by" column, like the other tables (sql/scrub_assistant_name_2026-10-30.sql)
create or replace trigger scrub_assistant_name before insert or update on public.quote_close_reason
  for each row execute function public.scrub_assistant_name_trg('set_by');

create or replace function public.set_quote_close_reason(p_order_id text, p_code text, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_code is null or p_code not in ('converted_other', 'bought_elsewhere', 'budget', 'other') then raise exception 'choose a reason'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'the note is too long (300 characters at most)'; end if;
  if p_code = 'other' and (v_note is null or char_length(v_note) < 3) then raise exception 'please add a few words for "other"'; end if;
  if not exists (select 1 from quotes where order_id = p_order_id) then raise exception 'quote not found'; end if;
  if exists (select 1 from quotes where order_id = p_order_id and approved_at is not null) then
    raise exception 'an approved quote does not need a closing reason';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_close_reason (order_id, code, note, set_by, set_at) values (p_order_id, p_code, v_note, v_name, now())
  on conflict (order_id) do update set code = excluded.code, note = excluded.note, set_by = excluded.set_by, set_at = now();
end $$;
revoke all on function public.set_quote_close_reason(text, text, text) from public, anon;
grant execute on function public.set_quote_close_reason(text, text, text) to authenticated;

create or replace function public.clear_quote_close_reason(p_order_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from quote_close_reason where order_id = p_order_id;
end $$;
revoke all on function public.clear_quote_close_reason(text) from public, anon;
grant execute on function public.clear_quote_close_reason(text) to authenticated;

-- What the page and the report read: every reason given, with the quote's details. Approved quotes are left out.
create or replace view public.quote_close_reasons_board with (security_invoker = true) as
select c.order_id, c.code, c.note, c.set_by, c.set_at,
       q.deco_id, q.customer_name, q.job_name, q.quote_value, q.assigned_to, q.created_at, q.order_status,
       exists (select 1 from quote_removed r where r.order_id = c.order_id) as removed
from public.quote_close_reason c
join public.quotes q on q.order_id = c.order_id
where q.approved_at is null;
revoke all on public.quote_close_reasons_board from anon, public;
grant select on public.quote_close_reasons_board to authenticated;
