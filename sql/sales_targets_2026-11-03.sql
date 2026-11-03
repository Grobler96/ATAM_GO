-- Sales targets and the team board. Re-runnable.
--
-- A target is a monthly amount of orders approved (quotes.approved_at, the value of the order) for one salesperson. A target applies from
-- the month it is set and carries forward until a newer one is set, so nobody has to re-enter it every month. Only Daniel and Oliver can
-- set or clear a target (checked in the function, by sign-in email); everyone signed in can read them. Salespeople are the active reps in mail_senders.
-- team_board(p_month) returns, for that month, each salesperson's target, orders approved so far (count and value), the month before, quotes raised,
-- open quotes and what they are expected to win, plus the team total. Read only.

create table if not exists public.sales_targets (
  id        uuid primary key default gen_random_uuid(),
  rep_name  text not null,
  month     date not null check (month = date_trunc('month', month)::date),
  target_value numeric not null check (target_value >= 0 and target_value <= 10000000),
  set_by    text,
  set_at    timestamptz not null default now(),
  unique (rep_name, month)
);
alter table public.sales_targets enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sales_targets' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.sales_targets for select to authenticated using (true);
  end if;
end $$;
revoke all on public.sales_targets from anon, authenticated;
grant select on public.sales_targets to authenticated;

create or replace trigger scrub_assistant_name before insert or update on public.sales_targets
  for each row execute function public.scrub_assistant_name_trg('set_by');

-- Who may set targets. One place to change it.
create or replace function public.can_set_sales_targets() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles p where p.id = auth.uid()
                 and lower(p.email) in ('daniel.spooner@atam.co.uk', 'grobleroliver@gmail.com'))
$$;
revoke all on function public.can_set_sales_targets() from public, anon;
grant execute on function public.can_set_sales_targets() to authenticated;

-- Set (or, with a null value, clear) a salesperson's target from a month onwards.
create or replace function public.set_sales_target(p_rep text, p_month date, p_value numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_month date; v_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.can_set_sales_targets() then raise exception 'only Daniel or Oliver can set targets'; end if;
  if not exists (select 1 from mail_senders where kind = 'rep' and active and rep_name = p_rep) then raise exception 'unknown salesperson'; end if;
  if p_month is null then raise exception 'choose a month'; end if;
  v_month := date_trunc('month', p_month)::date;
  if p_value is null then
    delete from sales_targets where rep_name = p_rep and month = v_month;
    return;
  end if;
  if p_value < 0 or p_value > 10000000 then raise exception 'that target looks wrong'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into sales_targets (rep_name, month, target_value, set_by, set_at) values (p_rep, v_month, p_value, v_name, now())
  on conflict (rep_name, month) do update set target_value = excluded.target_value, set_by = excluded.set_by, set_at = now();
end $$;
revoke all on function public.set_sales_target(text, date, numeric) from public, anon;
grant execute on function public.set_sales_target(text, date, numeric) to authenticated;

create or replace function public.team_board(p_month date default (now() at time zone 'Europe/London')::date)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_pstart date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_out jsonb;
begin
  with
  reps as (select distinct rep_name from public.mail_senders where kind = 'rep' and active and rep_name is not null),
  q as (select q.*, (q.approved_at at time zone 'Europe/London')::date as a_day, (q.created_at at time zone 'Europe/London')::date as c_day from public.quotes q),
  cur as (select assigned_to as rep, count(*) n, coalesce(sum(quote_value), 0) v from q where approved_at is not null and a_day >= v_start and a_day < v_end group by 1),
  prev as (select assigned_to as rep, count(*) n, coalesce(sum(quote_value), 0) v from q where approved_at is not null and a_day >= v_pstart and a_day < v_start group by 1),
  rais as (select assigned_to as rep, count(*) n, coalesce(sum(quote_value), 0) v from q where c_day >= v_start and c_day < v_end group by 1),
  opn as (
    select b.assigned_to as rep, count(*) n, coalesce(sum(b.quote_value), 0) v, coalesce(sum(b.quote_value * coalesce(w.win_pct, 0) / 100.0), 0) expected
      from public.quotes_board b left join public.quote_win_chance w on w.order_id = b.order_id
     where b.approved_at is null and b.order_status is distinct from 4
       and greatest(coalesce(b.modified_at, b.created_at), b.created_at, b.last_to_customer_at, b.last_from_customer_at, b.last_chase_at, b.email_sent_at) >= now() - interval '30 days'
     group by 1),
  tg as (select distinct on (rep_name) rep_name, target_value from public.sales_targets where month <= v_start order by rep_name, month desc),
  rows_ as (
    select r.rep_name as rep, tg.target_value as target,
           coalesce(cur.n, 0) as approved_n, coalesce(cur.v, 0) as approved_v,
           coalesce(prev.n, 0) as prev_n, coalesce(prev.v, 0) as prev_v,
           coalesce(rais.n, 0) as raised_n, coalesce(rais.v, 0) as raised_v,
           coalesce(opn.n, 0) as open_n, coalesce(opn.v, 0) as open_v, coalesce(opn.expected, 0) as expected
      from reps r
      left join tg on tg.rep_name = r.rep_name
      left join cur on cur.rep = r.rep_name left join prev on prev.rep = r.rep_name
      left join rais on rais.rep = r.rep_name left join opn on opn.rep = r.rep_name)
  select jsonb_build_object(
    'month', v_start,
    'reps', coalesce((select jsonb_agg(to_jsonb(rows_) order by rows_.approved_v desc, rows_.rep) from rows_), '[]'::jsonb),
    'team', jsonb_build_object(
      'approved_n', (select coalesce(sum(n), 0) from cur), 'approved_v', (select coalesce(sum(v), 0) from cur),
      'prev_v', (select coalesce(sum(v), 0) from prev), 'prev_n', (select coalesce(sum(n), 0) from prev),
      'target', (select sum(target) from rows_ where target is not null))
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.team_board(date) from public, anon;
grant execute on function public.team_board(date) to authenticated, service_role;
