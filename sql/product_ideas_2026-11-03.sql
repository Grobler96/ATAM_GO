-- Product ideas for a customer: what similar customers buy that this one does not. Re-runnable.
--
-- customer_product_ideas(p_name) finds the customer's account (the same name matching the Account managers tab uses), then:
--   1. lists the garment types it has bought in the last 24 months (invoiced, at least GBP 50 net in the type), from customer_spend_lines;
--   2. finds "similar" accounts: others that buy at least two of the same garment types (one, if this account only buys one type);
--      a peer counts in proportion to how alike the two ranges are (shared types / all types either buys);
--   3. for each garment type this account does NOT buy, works out the share of peers (weighted) that do, how many peers that is, and what those
--      peers typically spend a year on it (median, 24 months halved).
-- Ideas are shown only when there are at least 8 similar accounts, at least 3 of them buy the type and the weighted share is 35% or more; at most 4, biggest share first.
-- The garment types are a fixed list (not shipping, storage, promo or "other"). Internal accounts are left out. Read only (security invoker).
-- It is a prompt for a conversation ("customers like you also use hoodies"), not a prediction: there are only about 50 active accounts.

create or replace function public.customer_product_ideas(p_name text)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_key text; v_display text; v_out jsonb;
  v_types text[] := array['Polos', 'Jackets & softshells', 'Sweatshirts & hoodies', 'Fleeces', 'Shirts', 'T-shirts', 'Bodywarmers & gilets',
                          'Trousers & shorts', 'Headwear', 'Hi-vis', 'PPE', 'Aprons & tabards', 'Footwear'];
begin
  select m.acct_key, m.display into v_key, v_display
    from account_name_map m where m.nm = am_norm(p_name) and not m.internal
   order by (m.src = 'name') desc, m.src limit 1;
  if v_key is null then return jsonb_build_object('found', false); end if;

  with
  internal_keys as (select distinct acct_key from account_name_map where internal),
  buy as (
    select am_norm(l.group_name) as k, l.product_type, sum(l.net_gbp) as rev
      from customer_spend_lines l
     where l.doc_date >= current_date - interval '24 months' and l.counts_as_spend and l.group_name is not null
       and l.product_type = any (v_types)
     group by 1, 2
    having sum(l.net_gbp) >= 50),
  mine as (select product_type from buy where k = v_key),
  na as (select count(*)::int as n from mine),
  sim as (
    select b.k, count(*) filter (where b.product_type in (select product_type from mine)) as inter, count(*) as nb
      from buy b where b.k <> v_key and b.k not in (select acct_key from internal_keys) group by b.k),
  peers as (
    select s.k, s.inter::numeric / (s.nb + na.n - s.inter) as w
      from sim s, na where s.inter > 0 and s.inter >= least(2, na.n)),
  tot as (select count(*)::int as n_peers, coalesce(sum(w), 0) as w_total from peers),
  cand as (
    select b.product_type, count(distinct p.k)::int as n_with, sum(p.w) as w_with,
           percentile_cont(0.5) within group (order by b.rev / 2.0) as typical
      from buy b join peers p on p.k = b.k
     where b.product_type not in (select product_type from mine)
     group by b.product_type),
  picked as (
    select c.product_type, round(100 * c.w_with / nullif(t.w_total, 0))::int as share_pct, c.n_with, round(c.typical)::int as typical_year
      from cand c, tot t
     where c.n_with >= 3 and t.n_peers >= 8 and t.w_total > 0 and c.w_with / t.w_total >= 0.35
     order by c.w_with / t.w_total desc, c.product_type limit 4)
  select jsonb_build_object(
    'found', true, 'account', v_display,
    'bought', coalesce((select jsonb_agg(product_type order by product_type) from mine), '[]'::jsonb),
    'peers', (select n_peers from tot),
    'ideas', coalesce((select jsonb_agg(to_jsonb(picked) order by picked.share_pct desc, picked.product_type) from picked), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.customer_product_ideas(text) from public, anon;
grant execute on function public.customer_product_ideas(text) to authenticated, service_role;
