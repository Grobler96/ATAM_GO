-- Quotes: a "chance to win" for every open quote, worked out from what has actually happened to our own quotes. Re-runnable.
--
-- How it is worked out (plain version, also shown on the page):
--   History = quotes raised since 1 June 2026 (the earliest date from which unconverted quotes were kept) that are settled:
--     won  = approved more than an hour after they were raised (orders keyed straight in are not quotes that were won over),
--     lost = not approved, not cancelled, and quiet for 30 days.
--   For an open quote that is N days old, we look at the settled quotes in the same value band (under 300, 300 to 999, 1000 and over)
--   that were STILL OPEN at N days old (won later, or lost later), and take the share that were won. Smoothed a little (+1 / +2) so a
--   tiny sample cannot say 0% or 100%. If a band has fewer than 25 comparable quotes it falls back to all bands.
--   A lost quote counts as still open until 30 days after its last activity, the same rule the Quotes tab uses.
-- This looks at age and size only. It does not know who the customer is, whether they replied, or what was said, so it is a starting
-- point for deciding who to chase, not a promise. basis_n says how many quotes the figure rests on.
-- Read only, signed-in only (security_invoker view over the quotes table).

create or replace view public.quote_win_chance with (security_invoker = true) as
with hist as (
  select q.order_id,
         case when q.quote_value < 300 then 1 when q.quote_value < 1000 then 2 else 3 end as band,
         (q.approved_at is not null) as won,
         case when q.approved_at is not null
              then greatest(0, floor(extract(epoch from (q.approved_at - q.created_at)) / 86400))::int
              else greatest(0, floor(extract(epoch from (coalesce(q.modified_at, q.created_at) - q.created_at)) / 86400))::int + 30
         end as end_age
    from public.quotes q
   where q.created_at >= timestamptz '2026-06-01'
     and ( (q.approved_at is not null and q.approved_at - q.created_at > interval '1 hour')
        or (q.approved_at is null and q.order_status is distinct from 4
            and coalesce(q.modified_at, q.created_at) < now() - interval '30 days') )
), ages as (select generate_series(0, 40) as age), bands as (select generate_series(1, 3) as band),
curve as (
  select a.age, b.band,
         count(*) filter (where h.won and h.band = b.band and h.end_age >= a.age) as w_b,
         count(*) filter (where not h.won and h.band = b.band and h.end_age >= a.age) as l_b,
         count(*) filter (where h.won and h.end_age >= a.age) as w_all,
         count(*) filter (where not h.won and h.end_age >= a.age) as l_all
    from ages a cross join bands b cross join hist h
   group by a.age, b.band
), pick as (
  select age, band,
         case when w_b + l_b >= 25 then w_b else w_all end as w,
         case when w_b + l_b >= 25 then l_b else l_all end as l
    from curve
)
select q.order_id,
       round(100.0 * (p.w + 1) / (p.w + p.l + 2))::int as win_pct,
       (p.w + p.l)::int as basis_n,
       (q.created_at is not null) as has_age,
       least(40, greatest(0, floor(extract(epoch from (now() - q.created_at)) / 86400))::int) as age_days,
       p.band
  from public.quotes q
  join pick p on p.age = least(40, greatest(0, floor(extract(epoch from (now() - q.created_at)) / 86400))::int)
             and p.band = case when q.quote_value < 300 then 1 when q.quote_value < 1000 then 2 else 3 end
 where q.approved_at is null and q.order_status is distinct from 4 and q.created_at is not null;

revoke all on public.quote_win_chance from anon, public;
grant select on public.quote_win_chance to authenticated;
