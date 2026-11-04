-- Reminders and appointments: "contact this customer on a date", not tied to a quote or Win-back. Re-runnable.
--
-- Who can do what (agreed with Oliver, 4 Nov 2026):
--   * Anyone signed in can add a reminder for THEMSELVES, and edit, tick off or delete reminders that are theirs (assigned to them or made by them).
--   * Only Daniel and Oliver (sign-in email, in can_assign_reminders()) can add a reminder for someone else, or move one to someone else.
--     They can also edit, tick off or delete anyone's.
--   * Everyone signed in can read all reminders (the Calendar tab shows the whole team).
-- The account is free text: if it matches an account on the Customers / Account managers lists (am_norm, account_name_map) it is stored under
-- that account's name and flagged account_known; otherwise it is kept as typed (a prospect, a contact, anything).
-- Repeating: every N days / weeks / months / years from anchor_on, optionally until a date. Ticking a repeating reminder off moves it to its next
-- date after today (counted from the original date, so "monthly on the 31st" does not drift). A one-off goes to status 'done'.
-- Writes only through the functions below.

create table if not exists public.contact_reminders (
  id            uuid primary key default gen_random_uuid(),
  account_name  text not null check (char_length(btrim(account_name)) between 1 and 200),
  account_known boolean not null default false,
  kind          text not null default 'call' check (kind in ('call', 'visit', 'email', 'meeting', 'other')),
  note          text check (note is null or char_length(note) <= 500),
  remind_on     date not null,
  remind_time   time,
  anchor_on     date not null,
  repeat_every  int check (repeat_every is null or repeat_every between 1 and 60),
  repeat_unit   text check (repeat_unit is null or repeat_unit in ('day', 'week', 'month', 'year')),
  repeat_until  date,
  assigned_to   text not null,
  created_by    text,
  created_by_id uuid,
  created_at    timestamptz not null default now(),
  status        text not null default 'open' check (status in ('open', 'done')),
  last_done_at  timestamptz,
  last_done_by  text,
  done_count    int not null default 0,
  check ((repeat_every is null) = (repeat_unit is null))
);
create index if not exists contact_reminders_open_idx on public.contact_reminders (remind_on) where status = 'open';
create index if not exists contact_reminders_assignee_idx on public.contact_reminders (assigned_to) where status = 'open';

alter table public.contact_reminders enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'contact_reminders' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.contact_reminders for select to authenticated using (true);
  end if;
end $$;
revoke all on public.contact_reminders from anon, authenticated;
grant select on public.contact_reminders to authenticated;

create or replace trigger scrub_assistant_name before insert or update on public.contact_reminders
  for each row execute function public.scrub_assistant_name_trg('created_by', 'last_done_by', 'assigned_to');

-- Who may set reminders for other people. One place to change it (same two people as can_set_sales_targets).
create or replace function public.can_assign_reminders() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles p where p.id = auth.uid()
                 and lower(p.email) in ('daniel.spooner@atam.co.uk', 'grobleroliver@gmail.com'))
$$;
revoke all on function public.can_assign_reminders() from public, anon;
grant execute on function public.can_assign_reminders() to authenticated;

create or replace function public.reminder_my_name() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select nullif(btrim(coalesce(p.full_name, '')), '') from profiles p where p.id = auth.uid()
$$;
revoke all on function public.reminder_my_name() from public, anon;
grant execute on function public.reminder_my_name() to authenticated;

-- Shared checks for add and update. Returns the cleaned account name and whether it is a known account.
create or replace function public._reminder_check(p_account text, p_kind text, p_note text, p_date date, p_every int, p_unit text, p_until date,
                                                  out o_account text, out o_known boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_today date := (now() at time zone 'Europe/London')::date; v_disp text;
begin
  if nullif(btrim(coalesce(p_account, '')), '') is null then raise exception 'choose or type who to contact'; end if;
  if char_length(btrim(p_account)) > 200 then raise exception 'the name is too long'; end if;
  if p_kind not in ('call', 'visit', 'email', 'meeting', 'other') then raise exception 'unknown type'; end if;
  if p_note is not null and char_length(p_note) > 500 then raise exception 'the note is too long (500 characters at most)'; end if;
  if p_date is null then raise exception 'choose a date'; end if;
  if p_date < v_today then raise exception 'the date is in the past'; end if;
  if p_date > v_today + interval '5 years' then raise exception 'that date is too far ahead'; end if;
  if (p_every is null) <> (p_unit is null) then raise exception 'choose how often it repeats'; end if;
  if p_every is not null then
    if p_every < 1 or p_every > 60 then raise exception 'repeat every 1 to 60'; end if;
    if p_unit not in ('day', 'week', 'month', 'year') then raise exception 'unknown repeat unit'; end if;
  end if;
  if p_until is not null then
    if p_every is null then raise exception 'an end date only makes sense for a repeating reminder'; end if;
    if p_until < p_date then raise exception 'the end date is before the first date'; end if;
    if p_until > p_date + interval '10 years' then raise exception 'that end date is too far ahead'; end if;
  end if;
  select m.display into v_disp from account_name_map m
   where m.src = 'name' and not m.internal and m.nm = am_norm(btrim(p_account)) limit 1;
  o_known := v_disp is not null;
  o_account := coalesce(v_disp, btrim(p_account));
end $$;
revoke all on function public._reminder_check(text, text, text, date, int, text, date) from public, anon, authenticated;

-- Whom the reminder is for: null / my own name = me; anyone else only for Daniel / Oliver, and only an active salesperson.
create or replace function public._reminder_assignee(p_for text, p_current text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_me text := public.reminder_my_name();
begin
  if v_me is null then raise exception 'your name is not set up on your profile'; end if;
  if nullif(btrim(coalesce(p_for, '')), '') is null then return coalesce(p_current, v_me); end if;
  p_for := btrim(p_for);
  if p_for = v_me then return v_me; end if;
  if p_current is not null and p_for = p_current then return p_current; end if;
  if not public.can_assign_reminders() then raise exception 'only Daniel or Oliver can set reminders for other people'; end if;
  if not exists (select 1 from mail_senders s where s.kind = 'rep' and s.active and s.rep_name = p_for) then raise exception 'unknown team member'; end if;
  return p_for;
end $$;
revoke all on function public._reminder_assignee(text, text) from public, anon, authenticated;

create or replace function public.add_reminder(p_account text, p_kind text, p_note text, p_date date, p_time time default null,
                                               p_for text default null, p_every int default null, p_unit text default null, p_until date default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_chk record; v_to text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_chk from public._reminder_check(p_account, p_kind, p_note, p_date, p_every, p_unit, p_until);
  v_to := public._reminder_assignee(p_for, null);
  insert into contact_reminders (account_name, account_known, kind, note, remind_on, remind_time, anchor_on, repeat_every, repeat_unit, repeat_until,
                                 assigned_to, created_by, created_by_id)
  values (v_chk.o_account, v_chk.o_known, p_kind, nullif(btrim(coalesce(p_note, '')), ''), p_date, p_time, p_date, p_every, p_unit, p_until,
          v_to, public.reminder_my_name(), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.add_reminder(text, text, text, date, time, text, int, text, date) from public, anon;
grant execute on function public.add_reminder(text, text, text, date, time, text, int, text, date) to authenticated;

-- Can the signed-in person change this reminder? Theirs (assigned to or made by them), or Daniel / Oliver.
create or replace function public._reminder_can_touch(r public.contact_reminders) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.can_assign_reminders() or r.created_by_id = auth.uid() or r.assigned_to = public.reminder_my_name()
$$;
revoke all on function public._reminder_can_touch(public.contact_reminders) from public, anon, authenticated;

-- Change an open reminder. Editing a repeating one changes the whole series (its dates restart from the new date).
create or replace function public.update_reminder(p_id uuid, p_account text, p_kind text, p_note text, p_date date, p_time time default null,
                                                  p_for text default null, p_every int default null, p_unit text default null, p_until date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r contact_reminders; v_chk record; v_to text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from contact_reminders where id = p_id for update;
  if not found then raise exception 'reminder not found'; end if;
  if r.status <> 'open' then raise exception 'that reminder is already done'; end if;
  if not public._reminder_can_touch(r) then raise exception 'that reminder belongs to someone else'; end if;
  select * into v_chk from public._reminder_check(p_account, p_kind, p_note, p_date, p_every, p_unit, p_until);
  v_to := public._reminder_assignee(p_for, r.assigned_to);
  update contact_reminders set account_name = v_chk.o_account, account_known = v_chk.o_known, kind = p_kind,
         note = nullif(btrim(coalesce(p_note, '')), ''), remind_on = p_date, remind_time = p_time, anchor_on = p_date,
         repeat_every = p_every, repeat_unit = p_unit, repeat_until = p_until, assigned_to = v_to
   where id = p_id;
end $$;
revoke all on function public.update_reminder(uuid, text, text, text, date, time, text, int, text, date) from public, anon;
grant execute on function public.update_reminder(uuid, text, text, text, date, time, text, int, text, date) to authenticated;

-- Move just the next date (snooze). Keeps the repeat pattern; the series carries on from its original dates afterwards.
create or replace function public.snooze_reminder(p_id uuid, p_date date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r contact_reminders; v_today date := (now() at time zone 'Europe/London')::date;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from contact_reminders where id = p_id for update;
  if not found then raise exception 'reminder not found'; end if;
  if r.status <> 'open' then raise exception 'that reminder is already done'; end if;
  if not public._reminder_can_touch(r) then raise exception 'that reminder belongs to someone else'; end if;
  if p_date is null or p_date < v_today then raise exception 'choose a date from today on'; end if;
  if p_date > v_today + interval '5 years' then raise exception 'that date is too far ahead'; end if;
  update contact_reminders set remind_on = p_date, anchor_on = case when repeat_every is null then p_date else anchor_on end where id = p_id;
end $$;
revoke all on function public.snooze_reminder(uuid, date) from public, anon;
grant execute on function public.snooze_reminder(uuid, date) to authenticated;

-- Tick off. One-off: done. Repeating: moves to the next date after today (anchor + n x interval), or done if that is past the end date.
create or replace function public.complete_reminder(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r contact_reminders; v_today date := (now() at time zone 'Europe/London')::date; v_n int := 0; v_next date; v_int interval;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from contact_reminders where id = p_id for update;
  if not found then raise exception 'reminder not found'; end if;
  if r.status <> 'open' then raise exception 'that reminder is already done'; end if;
  if not public._reminder_can_touch(r) then raise exception 'that reminder belongs to someone else'; end if;
  if r.repeat_every is null then
    update contact_reminders set status = 'done', last_done_at = now(), last_done_by = public.reminder_my_name(), done_count = done_count + 1 where id = p_id;
    return jsonb_build_object('status', 'done');
  end if;
  v_int := (r.repeat_every::text || ' ' || r.repeat_unit)::interval;
  v_next := r.anchor_on;
  while v_next <= v_today and v_n < 5000 loop
    v_n := v_n + 1;
    v_next := (r.anchor_on + v_int * v_n)::date;
  end loop;
  -- never go back to a date earlier than the one just ticked off
  if v_next <= r.remind_on then v_next := (r.remind_on + v_int)::date; end if;
  if r.repeat_until is not null and v_next > r.repeat_until then
    update contact_reminders set status = 'done', last_done_at = now(), last_done_by = public.reminder_my_name(), done_count = done_count + 1 where id = p_id;
    return jsonb_build_object('status', 'done', 'series_ended', true);
  end if;
  update contact_reminders set remind_on = v_next, last_done_at = now(), last_done_by = public.reminder_my_name(), done_count = done_count + 1 where id = p_id;
  return jsonb_build_object('status', 'open', 'next', v_next);
end $$;
revoke all on function public.complete_reminder(uuid) from public, anon;
grant execute on function public.complete_reminder(uuid) to authenticated;

create or replace function public.delete_reminder(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r contact_reminders;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from contact_reminders where id = p_id for update;
  if not found then return; end if;
  if not public._reminder_can_touch(r) then raise exception 'that reminder belongs to someone else'; end if;
  delete from contact_reminders where id = p_id;
end $$;
revoke all on function public.delete_reminder(uuid) from public, anon;
grant execute on function public.delete_reminder(uuid) to authenticated;

-- Names for the "who is it for" list and the account suggestions: known accounts (customer groups), one row each.
create or replace function public.reminder_account_names() returns text[]
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(d order by d), '{}') from (
    select distinct m.display as d from account_name_map m where m.src = 'name' and not m.internal and m.display is not null) x
$$;
revoke all on function public.reminder_account_names() from public, anon;
grant execute on function public.reminder_account_names() to authenticated;
