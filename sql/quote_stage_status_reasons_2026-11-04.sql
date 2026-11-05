-- Quotes: move a quote to another stage by hand, say what is happening with it, and more reasons for losing it. Re-runnable.
--
-- 1) Stage by hand (quote_stage_override). The person picks Hot / Needs chasing / Going cold / Lost on the card. It holds only until something new
--    happens on the quote: the page ignores an override when the quote has been touched after it was set (customer replied, we emailed or chased,
--    the quote was edited in DecoNetwork, re-ignited or came back from parking). No scheduled job: it is a date comparison in the page.
--    Converted can never be set by hand: that comes from the customer approving in DecoNetwork. Approved and cancelled quotes are refused.
-- 2) What is happening (quote_status): one choice per quote from a fixed list, with a short note. It stays until changed or cleared.
-- 3) Lost reasons: four more (price, project cancelled, lead time, went quiet) and, for "converted on another quote", the number of the new quote
--    (quote_close_reason.linked_order_id). The old 3-argument set_quote_close_reason keeps working (used by older code).
-- quotes_board gains the new columns at the end (stage_override, stage_override_at, stage_override_by, deal_status, deal_status_note, deal_status_at,
-- deal_status_by); nothing else in the view changes, so DAN and the counts are untouched. The Monday report and Team board work out their own stages
-- in SQL and do not use the hand-set stage.

create table if not exists public.quote_stage_override (
  order_id text primary key,
  stage    text not null check (stage in ('fresh', 'chase', 'cold', 'lost')),
  set_by   text,
  set_at   timestamptz not null default now()
);
create table if not exists public.quote_status (
  order_id text primary key,
  code     text not null check (code in ('deciding', 'revising', 'artwork', 'budget_approval', 'sample', 'comparing', 'on_hold', 'ready_to_order')),
  note     text check (note is null or char_length(note) <= 200),
  set_by   text,
  set_at   timestamptz not null default now()
);
alter table public.quote_stage_override enable row level security;
alter table public.quote_status enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'quote_stage_override' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_stage_override for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'quote_status' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.quote_status for select to authenticated using (true);
  end if;
end $$;
revoke all on public.quote_stage_override, public.quote_status from anon, authenticated;
grant select on public.quote_stage_override, public.quote_status to authenticated;
create or replace trigger scrub_assistant_name before insert or update on public.quote_stage_override
  for each row execute function public.scrub_assistant_name_trg('set_by');
create or replace trigger scrub_assistant_name before insert or update on public.quote_status
  for each row execute function public.scrub_assistant_name_trg('set_by');

create or replace function public.set_quote_stage(p_order_id text, p_stage text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_stage is null or p_stage not in ('fresh', 'chase', 'cold', 'lost') then raise exception 'choose a stage'; end if;
  if not exists (select 1 from quotes where order_id = p_order_id) then raise exception 'quote not found'; end if;
  if exists (select 1 from quotes where order_id = p_order_id and (approved_at is not null or order_status = 4)) then
    raise exception 'an approved or cancelled quote cannot be moved';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_stage_override (order_id, stage, set_by, set_at) values (p_order_id, p_stage, v_name, now())
  on conflict (order_id) do update set stage = excluded.stage, set_by = excluded.set_by, set_at = now();
end $$;
revoke all on function public.set_quote_stage(text, text) from public, anon;
grant execute on function public.set_quote_stage(text, text) to authenticated;

create or replace function public.clear_quote_stage(p_order_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from quote_stage_override where order_id = p_order_id;
end $$;
revoke all on function public.clear_quote_stage(text) from public, anon;
grant execute on function public.clear_quote_stage(text) to authenticated;

-- A null or empty code clears the status.
create or replace function public.set_quote_status(p_order_id text, p_code text, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if nullif(btrim(coalesce(p_code, '')), '') is null then
    delete from quote_status where order_id = p_order_id;
    return;
  end if;
  if p_code not in ('deciding', 'revising', 'artwork', 'budget_approval', 'sample', 'comparing', 'on_hold', 'ready_to_order') then raise exception 'choose a status'; end if;
  if v_note is not null and char_length(v_note) > 200 then raise exception 'the note is too long (200 characters at most)'; end if;
  if not exists (select 1 from quotes where order_id = p_order_id) then raise exception 'quote not found'; end if;
  if exists (select 1 from quotes where order_id = p_order_id and (approved_at is not null or order_status = 4)) then
    raise exception 'an approved or cancelled quote does not need a status';
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_status (order_id, code, note, set_by, set_at) values (p_order_id, p_code, v_note, v_name, now())
  on conflict (order_id) do update set code = excluded.code, note = excluded.note, set_by = excluded.set_by, set_at = now();
end $$;
revoke all on function public.set_quote_status(text, text, text) from public, anon;
grant execute on function public.set_quote_status(text, text, text) to authenticated;

-- Lost reasons: more codes, and the new quote a requote became.
alter table public.quote_close_reason drop constraint if exists quote_close_reason_code_check;
alter table public.quote_close_reason add constraint quote_close_reason_code_check
  check (code in ('converted_other', 'bought_elsewhere', 'budget', 'other', 'price', 'project_cancelled', 'lead_time', 'went_quiet'));
alter table public.quote_close_reason add column if not exists linked_order_id text;

create or replace function public.set_quote_close_reason(p_order_id text, p_code text, p_note text, p_linked text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_note text := nullif(btrim(p_note), ''); v_link text := nullif(btrim(coalesce(p_linked, '')), ''); v_linked_id text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_code is null or p_code not in ('converted_other', 'bought_elsewhere', 'budget', 'other', 'price', 'project_cancelled', 'lead_time', 'went_quiet') then raise exception 'choose a reason'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'the note is too long (300 characters at most)'; end if;
  if p_code = 'other' and (v_note is null or char_length(v_note) < 3) then raise exception 'please add a few words for "other"'; end if;
  if not exists (select 1 from quotes where order_id = p_order_id) then raise exception 'quote not found'; end if;
  if exists (select 1 from quotes where order_id = p_order_id and approved_at is not null) then
    raise exception 'an approved quote does not need a closing reason';
  end if;
  if v_link is not null then
    if p_code <> 'converted_other' then raise exception 'a new quote number only goes with "converted on another quote"'; end if;
    v_link := ltrim(v_link, '#');
    select order_id into v_linked_id from quotes where order_id = v_link or deco_id::text = v_link order by (order_id = v_link) desc limit 1;
    if v_linked_id is null then raise exception 'quote % was not found', v_link; end if;
    if v_linked_id = p_order_id then raise exception 'that is the same quote'; end if;
  end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into quote_close_reason (order_id, code, note, set_by, set_at, linked_order_id) values (p_order_id, p_code, v_note, v_name, now(), v_linked_id)
  on conflict (order_id) do update set code = excluded.code, note = excluded.note, set_by = excluded.set_by, set_at = now(), linked_order_id = excluded.linked_order_id;
end $$;
revoke all on function public.set_quote_close_reason(text, text, text, text) from public, anon;
grant execute on function public.set_quote_close_reason(text, text, text, text) to authenticated;

create or replace function public.set_quote_close_reason(p_order_id text, p_code text, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.set_quote_close_reason(p_order_id, p_code, p_note, null::text);
end $$;
revoke all on function public.set_quote_close_reason(text, text, text) from public, anon;
grant execute on function public.set_quote_close_reason(text, text, text) to authenticated;

create or replace view public.quote_close_reasons_board with (security_invoker = true) as
select c.order_id, c.code, c.note, c.set_by, c.set_at,
       q.deco_id, q.customer_name, q.job_name, q.quote_value, q.assigned_to, q.created_at, q.order_status,
       exists (select 1 from quote_removed r where r.order_id = c.order_id) as removed,
       c.linked_order_id, lq.deco_id as linked_deco_id, lq.quote_value as linked_value, lq.approved_at as linked_approved_at
from public.quote_close_reason c
join public.quotes q on q.order_id = c.order_id
left join public.quotes lq on lq.order_id = c.linked_order_id
where q.approved_at is null;
revoke all on public.quote_close_reasons_board from anon, public;
grant select on public.quote_close_reasons_board to authenticated;

-- quotes_board: the existing definition with the new columns added at the end.
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
        CASE
            WHEN pk.order_id IS NOT NULL AND pk.parked_until <= (now() AT TIME ZONE 'Europe/London'::text)::date THEN (pk.parked_until::timestamp without time zone AT TIME ZONE 'Europe/London'::text)
            ELSE NULL::timestamp with time zone
        END AS park_returned_at,
    pk.reason AS park_reason,
    pk.parked_by,
    so.stage AS stage_override,
    so.set_at AS stage_override_at,
    so.set_by AS stage_override_by,
    qs.code AS deal_status,
    qs.note AS deal_status_note,
    qs.set_at AS deal_status_at,
    qs.set_by AS deal_status_by
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
     LEFT JOIN quote_stage_override so ON so.order_id = q.order_id
     LEFT JOIN quote_status qs ON qs.order_id = q.order_id
  WHERE NOT (EXISTS ( SELECT 1
           FROM quote_removed r2
          WHERE r2.order_id = q.order_id)) AND (pk.order_id IS NULL OR pk.parked_until <= (now() AT TIME ZONE 'Europe/London'::text)::date OR q.approved_at IS NOT NULL OR q.order_status = 4);
grant select on public.quotes_board to authenticated;
revoke all on public.quotes_board from anon;
