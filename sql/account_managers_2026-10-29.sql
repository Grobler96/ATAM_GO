-- Account Managers tab: who owns which customer account, with revenue, quotes and (indicative) margin. Re-runnable.
--
-- An "account" is the same thing the Customers tab calls a customer group (HH Global, PPG, ...), or a single customer when it
-- has no group. Revenue is the Xero invoice revenue in customer_spend_facts, so the numbers agree with the Customers tab.
-- Customers that only appear on quotes (no invoice yet) are accounts too, so no quote is ever left out.
--
-- Ownership: a person can be assigned to an account by hand (account_manager_assignments). Every quote and every pound of
-- revenue on that account then counts for that person, whoever keyed the quote in. Until someone is assigned, the page shows an
-- automatic suggestion (who handled most of the account's invoiced orders over 24 months, else who made most of its quotes),
-- clearly labelled as automatic. Only people in mail_senders (kind rep, active) can be assigned.
--
-- Margin is only a garment margin: invoice lines whose product code matches supplier costs (sku_costs), compared with the
-- average supplier cost of that product. Lines priced more than 12x the cost are left out (job lump sums, not unit prices).
-- It does not include decoration costs, and only a small part of revenue can be costed, so the page shows the coverage with it.
--
-- Applied to the live database on 29 Oct 2026 and tested: assigning (different spellings of one name count as one account), back to
-- automatic, quote-only accounts, and refusal of: signed-out callers, unknown people, unknown or internal accounts, over-long notes.
-- Nothing here changes existing tables or views.

-- 1) Name normaliser used to match quote customer names to accounts (case, punctuation, Ltd/Limited/PLC/The/UK/Co ignored).
create or replace function public.am_norm(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
    nullif(btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(t, '')), '&', ' and ', 'g'),
      '\m(limited|ltd|plc|llp|the|uk|co)\M', ' ', 'g'), '[^a-z0-9]+', ' ', 'g')), ''),
    nullif(lower(btrim(coalesce(t, ''))), ''));
$$;

-- 2) Who owns what, set by hand. One row per account; no row = automatic.
create table if not exists public.account_manager_assignments (
  account_key  text primary key,
  account_name text not null check (char_length(account_name) <= 200),
  manager      text not null,
  note         text check (note is null or char_length(note) <= 300),
  set_by       text,
  set_at       timestamptz not null default now()
);
-- A record of every change (including "back to automatic", where manager is null) so it is clear who moved an account.
create table if not exists public.account_manager_history (
  id           bigint generated always as identity primary key,
  account_key  text not null,
  account_name text not null,
  manager      text,
  note         text,
  changed_by   text,
  changed_at   timestamptz not null default now()
);
create index if not exists account_manager_history_key_idx on public.account_manager_history (account_key, changed_at desc);

alter table public.account_manager_assignments enable row level security;
alter table public.account_manager_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'account_manager_assignments' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.account_manager_assignments for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'account_manager_history' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.account_manager_history for select to authenticated using (true);
  end if;
end $$;
revoke all on public.account_manager_assignments, public.account_manager_history from anon, authenticated;
grant select on public.account_manager_assignments, public.account_manager_history to authenticated;

-- 3) Every name an account is known by, one row per normalised name. src 'name' = company / account / Xero contact names;
--    src 'store' = DecoNetwork store names (only used for a quote whose customer name matches nothing).
--    internal = our own companies (CPI / Atam) and placeholders, which the Customers tab also leaves out.
create or replace view public.account_name_map with (security_invoker = true) as
with accts as (
  select ca.id, ca.account_name, ca.is_excluded as internal,
         coalesce(cg.group_name, ca.account_name) as grp
  from customer_accounts ca left join customer_groups cg on cg.id = ca.group_id
), base as (   -- one pass over the invoices
  select group_name, account_name, xero_contact_name, sum(net_gbp) as r_all
  from customer_spend_facts group by 1, 2, 3
), rev as (
  select am_norm(group_name) as k, group_name, sum(r_all) as r_all from base group by 1, 2
), cand as (
  select am_norm(group_name) as nm, am_norm(group_name) as acct_key, group_name as display, false as internal, 'name' as src, 1 as pri from base
  union all select am_norm(account_name), am_norm(group_name), group_name, false, 'name', 2 from base
  union all select am_norm(xero_contact_name), am_norm(group_name), group_name, false, 'name', 3 from base
  union all select am_norm(grp), am_norm(grp), grp, internal, 'name', 1 from accts
  union all select am_norm(account_name), am_norm(grp), grp, internal, 'name', 2 from accts
  union all select am_norm(al.alias_value), am_norm(a.grp), a.grp, a.internal, 'name', 3
    from customer_account_aliases al join accts a on a.id = al.account_id where al.alias_type = 'xero_contact_name'
  union all select am_norm(al.alias_value), am_norm(a.grp), a.grp, a.internal, 'store', 4
    from customer_account_aliases al join accts a on a.id = al.account_id where al.alias_type = 'deco_store_name'
  union all select am_norm(d.xero_contact_name), am_norm(a.grp), a.grp, true, 'name', 3
    from (select distinct xero_contact_id, xero_contact_name from xero_sales_documents) d
    join customer_account_aliases al on al.alias_type = 'xero_contact_id' and al.alias_value = d.xero_contact_id
    join accts a on a.id = al.account_id and a.internal
)
select distinct on (c.src, c.nm) c.nm, c.src, c.acct_key, c.display, c.internal
from cand c left join rev r on r.k = c.acct_key and r.group_name = c.display
where c.nm is not null
order by c.src, c.nm, c.pri, coalesce(r.r_all, 0) desc, c.acct_key;

-- 4) Which account each quote belongs to: customer name first, then the name without a trailing "(branch)" bit,
--    then the DecoNetwork store name. Anything unmatched is its own account (so it still shows and can be assigned).
create or replace view public.account_quote_map with (security_invoker = true) as
with m as (select * from account_name_map)
select q.order_id,
       coalesce(m1.acct_key, m2.acct_key, m3.acct_key, am_norm(q.customer_name), 'unknown customer') as account_key,
       coalesce(m1.display, m2.display, m3.display, nullif(btrim(q.customer_name), ''), 'Unknown customer') as account_name,
       coalesce(m1.internal, m2.internal, m3.internal, false) as internal,
       (coalesce(m1.acct_key, m2.acct_key, m3.acct_key) is not null) as matched
from quotes_board q
left join m m1 on m1.src = 'name' and m1.nm = am_norm(q.customer_name)
left join m m2 on m1.nm is null and m2.src = 'name' and m2.nm = am_norm(regexp_replace(q.customer_name, '\s*\([^)]*\)\s*$', ''))
left join m m3 on m1.nm is null and m2.nm is null and m3.src = 'store' and m3.nm = am_norm(q.store_name);

revoke all on public.account_name_map, public.account_quote_map from anon, public;
grant select on public.account_name_map, public.account_quote_map to authenticated;

-- 5) The page's data: one object per account with revenue, owner, margin pieces, monthly bars, child accounts.
--    Reads as the signed-in user (row level security applies). p_fy_start_month 11 = the Customers tab's financial year.
create or replace function public.get_account_managers(p_as_of date default current_date, p_fy_start_month int default 11)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare v_out jsonb;
begin
  with b as (
    select p_as_of as d, (p_as_of - interval '1 year')::date as d1, (p_as_of - interval '2 years')::date as d2,
           make_date(extract(year from p_as_of)::int - case when extract(month from p_as_of) < p_fy_start_month then 1 else 0 end, p_fy_start_month, 1) as fy
  ), b2 as (select b.*, (b.fy - interval '1 year')::date as fy_ly from b),
  f as (
    select am_norm(x.group_name) as k, x.group_name, x.account_name, x.doc_date, x.net_gbp, x.doc_type, x.order_id
    from customer_spend_facts x, b2 where x.doc_date <= b2.d
  ),
  fk as (  -- revenue per account
    select f.k,
      sum(net_gbp) filter (where doc_date > b2.d1) as r12,
      sum(net_gbp) filter (where doc_date > b2.d2 and doc_date <= b2.d1) as rprev,
      sum(net_gbp) filter (where doc_date >= b2.fy) as rfy,
      sum(net_gbp) filter (where doc_date >= b2.fy_ly and doc_date <= b2.d1) as rfy_ly,
      count(*) filter (where doc_type = 'invoice' and doc_date > b2.d1) as inv12,
      min(doc_date) as first_invoice, max(doc_date) filter (where doc_type = 'invoice') as last_invoice
    from f cross join b2 group by f.k
  ),
  disp as (  -- the name shown: the group name with the most revenue under that key
    select distinct on (k) k, group_name from (
      select k, group_name, sum(net_gbp) filter (where doc_date > (select d1 from b2)) as r12, sum(net_gbp) as r_all from f group by k, group_name) z
    order by k, coalesce(r12, 0) desc, r_all desc, group_name
  ),
  months as (select (date_trunc('month', (select d from b2)) - make_interval(months => n))::date as m from generate_series(0, 23) n),
  mon as (
    select fk.k, jsonb_agg(round(coalesce(s.v, 0), 0) order by ms.m) as monthly
    from fk cross join months ms
    left join (select k, date_trunc('month', doc_date)::date as m, sum(net_gbp) as v from f group by 1, 2) s on s.k = fk.k and s.m = ms.m
    group by fk.k
  ),
  kids as (
    select k, jsonb_agg(jsonb_build_object('name', account_name, 'r12', round(r12, 0), 'rprev', round(rprev, 0)) order by r12 desc nulls last, rprev desc nulls last) as children
    from (select f.k, f.account_name,
            sum(net_gbp) filter (where doc_date > b2.d1) as r12,
            sum(net_gbp) filter (where doc_date > b2.d2 and doc_date <= b2.d1) as rprev
          from f cross join b2 group by f.k, f.account_name
          having coalesce(sum(net_gbp) filter (where doc_date > b2.d2), 0) <> 0) c
    group by k
  ),
  reps as (select rep_name from mail_senders where kind = 'rep' and active and rep_name is not null),
  inv_by as (  -- who handled the invoiced orders (the DecoNetwork "assigned to" on the order), last 12 months
    select f.k, coalesce(w.assigned_to, 'Not recorded') as who, sum(f.net_gbp) as v
    from f cross join b2 left join wip_orders w on w.order_id = f.order_id
    where f.doc_date > b2.d1 group by 1, 2
  ),
  handled as (
    select k, jsonb_agg(jsonb_build_object('name', who, 'r12', round(v, 0)) order by v desc) as handled_by
    from inv_by where v > 0 group by k
  ),
  auto_inv as (  -- automatic owner from invoiced orders over 24 months, only counting current reps
    select distinct on (k) k, who from (
      select f.k, w.assigned_to as who, sum(f.net_gbp) as v
      from f cross join b2 join wip_orders w on w.order_id = f.order_id
      where f.doc_date > b2.d2 and w.assigned_to in (select rep_name from reps) group by 1, 2) z
    where v > 0 order by k, v desc, who
  ),
  qm as (select m.account_key, m.account_name, q.assigned_to, q.created_at
         from account_quote_map m join quotes_board q on q.order_id = m.order_id where not m.internal),
  auto_q as (
    select distinct on (account_key) account_key as k, assigned_to as who from (
      select account_key, assigned_to, count(*) as n, max(created_at) as latest from qm
      where assigned_to in (select rep_name from reps) group by 1, 2) z
    order by account_key, n desc, latest desc, assigned_to
  ),
  qdisp as (
    select distinct on (account_key) account_key as k, account_name from (
      select account_key, account_name, count(*) as n, max(created_at) as latest from qm group by 1, 2) z
    order by account_key, n desc, latest desc
  ),
  sku_up as materialized (select upper(sku) as up, split_part(upper(sku), '.', 1) as dot, unit_cost from sku_costs where unit_cost > 0),
  codes as materialized (select distinct upper(item_code) as code from customer_spend_lines
                         where item_code is not null and length(item_code) >= 3 and item_code !~* '^(delivery|storage|00)$'),
  pairs as (   -- a SKU belongs to a product code if it is that code, "CODE.colour.size", or (codes starting with a letter) starts with it
    select c.code, s.up, s.unit_cost from codes c join sku_up s on s.dot = c.code
    union
    select c.code, s.up, s.unit_cost from codes c
      join generate_series(3, 14) g(l) on g.l = length(c.code)
      join sku_up s on left(s.up, g.l) = c.code
      where c.code ~ '^[A-Z]'
  ),
  cc as (select code, avg(unit_cost) as cost from pairs group by code),   -- average supplier cost for each product code
  costed as (
    select am_norm(l.group_name) as k,
      sum(l.net_gbp) filter (where l.doc_date > b2.d1) as c12_rev,
      sum(l.net_gbp - l.quantity * cc.cost) filter (where l.doc_date > b2.d1) as c12_margin,
      sum(l.net_gbp) filter (where l.doc_date >= b2.fy) as cfy_rev,
      sum(l.net_gbp - l.quantity * cc.cost) filter (where l.doc_date >= b2.fy) as cfy_margin
    from customer_spend_lines l cross join b2
    join cc on cc.code = upper(l.item_code)
    where l.doc_date <= b2.d and l.doc_date >= b2.fy_ly and l.counts_as_spend and l.quantity > 0 and l.net_gbp > 0
      and l.product_type <> 'Shipping' and l.net_gbp / l.quantity <= cc.cost * 12
    group by 1
  ),
  keys as (
    select k from fk where coalesce(r12, 0) <> 0 or coalesce(rprev, 0) <> 0 or coalesce(rfy, 0) <> 0 or coalesce(rfy_ly, 0) <> 0
    union select account_key from qm
    union select account_key from account_manager_assignments
  ),
  acc as (
    select ks.k,
      coalesce(d.group_name, qd.account_name, a.account_name, ks.k) as name,
      a.manager as set_owner, a.set_by, a.set_at, a.note,
      coalesce(ai.who, aq.who) as auto_owner,
      case when ai.who is not null then 'orders' when aq.who is not null then 'quotes' end as auto_reason,
      fk.r12, fk.rprev, fk.rfy, fk.rfy_ly, fk.inv12, fk.first_invoice, fk.last_invoice,
      mon.monthly, kids.children, handled.handled_by, costed.c12_rev, costed.c12_margin, costed.cfy_rev, costed.cfy_margin
    from keys ks
    left join fk on fk.k = ks.k left join disp d on d.k = ks.k left join qdisp qd on qd.k = ks.k
    left join account_manager_assignments a on a.account_key = ks.k
    left join auto_inv ai on ai.k = ks.k left join auto_q aq on aq.k = ks.k
    left join mon on mon.k = ks.k left join kids on kids.k = ks.k left join handled on handled.k = ks.k left join costed on costed.k = ks.k
  )
  select jsonb_build_object(
    'as_of', (select d from b2), 'fy_start', (select fy from b2),
    'reps', coalesce((select jsonb_agg(rep_name order by rep_name) from reps), '[]'::jsonb),
    'totals', (select jsonb_build_object('r12', round(coalesce(sum(r12), 0), 2), 'rprev', round(coalesce(sum(rprev), 0), 2),
                 'rfy', round(coalesce(sum(rfy), 0), 2), 'rfy_ly', round(coalesce(sum(rfy_ly), 0), 2)) from fk),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'key', k, 'name', name,
        'owner', coalesce(set_owner, auto_owner),
        'owner_source', case when set_owner is not null then 'set' when auto_owner is not null then 'auto' else 'none' end,
        'auto_owner', auto_owner, 'auto_reason', auto_reason, 'set_by', set_by, 'set_at', set_at, 'note', note,
        'r12', round(coalesce(r12, 0), 2), 'rprev', round(coalesce(rprev, 0), 2), 'rfy', round(coalesce(rfy, 0), 2), 'rfy_ly', round(coalesce(rfy_ly, 0), 2),
        'inv12', coalesce(inv12, 0), 'first_invoice', first_invoice, 'last_invoice', last_invoice,
        'monthly', coalesce(monthly, '[]'::jsonb), 'children', coalesce(children, '[]'::jsonb), 'handled_by', coalesce(handled_by, '[]'::jsonb),
        'c12_rev', round(coalesce(c12_rev, 0), 2), 'c12_margin', round(coalesce(c12_margin, 0), 2),
        'cfy_rev', round(coalesce(cfy_rev, 0), 2), 'cfy_margin', round(coalesce(cfy_margin, 0), 2)
      ) order by coalesce(r12, 0) desc, name) from acc), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.get_account_managers(date, int) from public, anon;
grant execute on function public.get_account_managers(date, int) to authenticated;

-- 6) Assign accounts (one or many) to an account manager, or put them back to automatic (manager empty).
--    Signed-in users only; the manager must be an active rep in mail_senders; the account must really exist
--    (invoiced, or on a quote). Writes a history row for each change. Quotes need no change: they follow the account.
create or replace function public.set_account_managers(p_account_names text[], p_manager text, p_note text default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mgr text := nullif(btrim(p_manager), '');
  v_note text := nullif(btrim(p_note), '');
  v_by text; v_name text; v_key text; v_n integer := 0; v_seen text[] := '{}';
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_account_names is null or coalesce(array_length(p_account_names, 1), 0) = 0 then raise exception 'no accounts given'; end if;
  if array_length(p_account_names, 1) > 100 then raise exception 'too many accounts at once (100 at most)'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'note too long (300 characters at most)'; end if;
  if v_mgr is not null and not exists (select 1 from mail_senders where kind = 'rep' and active and rep_name = v_mgr) then
    raise exception 'unknown team member';
  end if;
  select coalesce(full_name, email) into v_by from profiles where id = auth.uid();

  foreach v_name in array p_account_names loop
    v_name := btrim(v_name);
    if v_name is null or v_name = '' or char_length(v_name) > 200 then raise exception 'bad account name'; end if;
    v_key := am_norm(v_name);
    if v_key = any (v_seen) then continue; end if;
    v_seen := v_seen || v_key;
    if not (exists (select 1 from customer_spend_facts where am_norm(group_name) = v_key)
         or exists (select 1 from account_quote_map where account_key = v_key and not internal)
         or exists (select 1 from account_manager_assignments where account_key = v_key)) then
      raise exception 'unknown account: %', v_name;
    end if;
    if v_mgr is null then
      delete from account_manager_assignments where account_key = v_key;
    else
      insert into account_manager_assignments (account_key, account_name, manager, note, set_by, set_at)
      values (v_key, v_name, v_mgr, v_note, v_by, now())
      on conflict (account_key) do update set account_name = excluded.account_name, manager = excluded.manager,
        note = excluded.note, set_by = excluded.set_by, set_at = now();
    end if;
    insert into account_manager_history (account_key, account_name, manager, note, changed_by) values (v_key, v_name, v_mgr, v_note, v_by);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.set_account_managers(text[], text, text) from public, anon;
grant execute on function public.set_account_managers(text[], text, text) to authenticated;
