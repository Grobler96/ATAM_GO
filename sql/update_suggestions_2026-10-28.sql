-- Update log: team suggestions for new updates, ranked by importance. Re-runnable.
-- Applied to the live database on 28 Oct 2026 and tested (suggest, rate, change a rating, withdraw, blocked direct writes).
--
-- Anyone signed in can suggest an update and give every suggestion a rating from 1 (nice to have) to 5 (needed now).
-- One rating per person per suggestion; changing it replaces the old one. The board ranks by points (all ratings added up).
-- Signed-in users can read everything and write only through the functions below. Anonymous users get nothing.
-- Status (open / planned / built / declined) is changed by whoever builds the updates, with plain SQL, not from the page:
--   update public.update_suggestions set status = 'planned' where id = '...';

create table if not exists public.update_suggestions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  detail text check (detail is null or char_length(detail) <= 1000),
  area text check (area is null or char_length(area) <= 40),
  suggested_by uuid not null,
  suggested_by_name text,
  status text not null default 'open' check (status in ('open', 'planned', 'built', 'declined')),
  created_at timestamptz not null default now()
);

create table if not exists public.update_suggestion_ratings (
  suggestion_id uuid not null references public.update_suggestions(id) on delete cascade,
  user_id uuid not null,
  importance int not null check (importance between 1 and 5),
  rated_at timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);

alter table public.update_suggestions enable row level security;
alter table public.update_suggestion_ratings enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'update_suggestions' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.update_suggestions for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'update_suggestion_ratings' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.update_suggestion_ratings for select to authenticated using (true);
  end if;
end $$;

revoke all on public.update_suggestions, public.update_suggestion_ratings from anon, authenticated;
grant select on public.update_suggestions, public.update_suggestion_ratings to authenticated;

-- The board the page reads: each suggestion with its points, average, number of ratings and the signed-in person's own rating.
create or replace view public.update_suggestions_board with (security_invoker = true) as
select s.id, s.title, s.detail, s.area, s.suggested_by_name, s.status, s.created_at,
       (s.suggested_by = auth.uid()) as mine,
       count(r.user_id)::int as votes,
       coalesce(sum(r.importance), 0)::int as points,
       round(avg(r.importance)::numeric, 1) as avg_importance,
       max(r.importance) filter (where r.user_id = auth.uid()) as my_rating
from public.update_suggestions s
left join public.update_suggestion_ratings r on r.suggestion_id = s.id
group by s.id;
revoke all on public.update_suggestions_board from anon, authenticated;
grant select on public.update_suggestions_board to authenticated;

-- Add a suggestion. The person's own rating goes in with it.
create or replace function public.suggest_update(p_title text, p_detail text, p_area text, p_importance int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_name text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_importance is null or p_importance not between 1 and 5 then raise exception 'importance must be 1 to 5'; end if;
  select coalesce(full_name, email) into v_name from profiles where id = auth.uid();
  insert into update_suggestions (title, detail, area, suggested_by, suggested_by_name)
  values (btrim(p_title), nullif(btrim(p_detail), ''), nullif(btrim(p_area), ''), auth.uid(), v_name)
  returning id into v_id;
  insert into update_suggestion_ratings (suggestion_id, user_id, importance) values (v_id, auth.uid(), p_importance);
  return v_id;
end $$;

-- Rate (or change your rating of) a suggestion. A null rating takes your rating back.
create or replace function public.rate_update_suggestion(p_id uuid, p_importance int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from update_suggestions where id = p_id) then raise exception 'suggestion not found'; end if;
  if p_importance is null then
    delete from update_suggestion_ratings where suggestion_id = p_id and user_id = auth.uid();
  else
    if p_importance not between 1 and 5 then raise exception 'importance must be 1 to 5'; end if;
    insert into update_suggestion_ratings (suggestion_id, user_id, importance) values (p_id, auth.uid(), p_importance)
    on conflict (suggestion_id, user_id) do update set importance = excluded.importance, rated_at = now();
  end if;
end $$;

-- Take back your own suggestion, while it is still open.
create or replace function public.withdraw_update_suggestion(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from update_suggestions where id = p_id and suggested_by = auth.uid() and status = 'open';
end $$;

revoke all on function public.suggest_update(text, text, text, int) from public, anon;
revoke all on function public.rate_update_suggestion(uuid, int) from public, anon;
revoke all on function public.withdraw_update_suggestion(uuid) from public, anon;
grant execute on function public.suggest_update(text, text, text, int) to authenticated;
grant execute on function public.rate_update_suggestion(uuid, int) to authenticated;
grant execute on function public.withdraw_update_suggestion(uuid) to authenticated;
