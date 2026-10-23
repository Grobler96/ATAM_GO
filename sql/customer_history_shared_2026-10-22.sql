-- Customer history, shared by the Quotes tab and the Win-back tab (22 Oct 2026; applied to Supabase project aobosyvlhgkxhjxkfzlz).
-- customer_history_by_name(name) holds the whole history query (it used to live inside quote_customer_history).
-- quote_customer_history(order_id) and winback_customer_history(customer_id) just work out the customer's name and call it.
-- All three run as the signed-in user (security invoker), so row level security applies. Signed-out users get nothing.
-- See sql/quote_customer_history.sql (2026-10-20) for what the history contains and how the customer is matched.

create or replace function public.customer_history_by_name(p_name text)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_name text; v_key text; v_last text;
  st jsonb; v_gap numeric; v_open jsonb; v_recent jsonb; v_month jsonb; v_reps jsonb; v_proc jsonb;
  v_mix jsonb; v_lines jsonb; v_lines_src text; v_lastrow jsonb; v_fin jsonb; v_pay numeric; v_wb jsonb; v_log jsonb;
begin
  v_name := nullif(btrim(p_name), '');
  if v_name is null then return jsonb_build_object('found', false); end if;
  v_key := lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'));

  -- order totals (completed = shipped, status 3; cancelled = status 4)
  select jsonb_build_object(
    'orders', count(*) filter (where order_status = 3),
    'spend', coalesce(sum(order_value) filter (where order_status = 3), 0),
    'avg_order', coalesce(round(avg(order_value) filter (where order_status = 3 and order_value > 0), 2), 0),
    'largest', coalesce(max(order_value) filter (where order_status = 3), 0),
    'garments', coalesce(sum(garment_qty) filter (where order_status = 3), 0),
    'first_shipped', min(date_shipped) filter (where order_status = 3),
    'last_shipped', max(date_shipped) filter (where order_status = 3),
    'orders_12m', count(*) filter (where order_status = 3 and date_shipped >= now() - interval '12 months'),
    'spend_12m', coalesce(sum(order_value) filter (where order_status = 3 and date_shipped >= now() - interval '12 months'), 0),
    'orders_prev_12m', count(*) filter (where order_status = 3 and date_shipped >= now() - interval '24 months' and date_shipped < now() - interval '12 months'),
    'spend_prev_12m', coalesce(sum(order_value) filter (where order_status = 3 and date_shipped >= now() - interval '24 months' and date_shipped < now() - interval '12 months'), 0),
    'cancelled', count(*) filter (where order_status = 4),
    'free_or_zero_orders', count(*) filter (where order_status = 3 and order_value = 0)
  ) into st
  from wip_orders where lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')) = v_key;

  -- typical gap between order days
  select round(avg(gap)) into v_gap from (
    select d - lag(d) over (order by d) as gap
    from (select distinct date_shipped::date d from wip_orders
          where lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')) = v_key and order_status = 3 and date_shipped is not null) x
  ) g where gap is not null;

  -- orders still on the go, with what is owed on them
  select coalesce(jsonb_agg(jsonb_build_object('order_id', w.order_id, 'value', w.order_value, 'qty', w.garment_qty, 'status', w.order_status,
           'due', w.date_due, 'processes', w.processes, 'rep', w.assigned_to, 'payment_status', u.payment_status, 'outstanding', u.outstanding_balance)
           order by w.date_due nulls last), '[]'::jsonb) into v_open
  from wip_orders w left join upcoming_orders u on u.order_id = w.order_id
  where lower(regexp_replace(btrim(w.customer_name), '\s+', ' ', 'g')) = v_key and w.order_status in (1, 2, 5, 6, 8, 9);

  -- last 15 completed orders, each with its Xero invoice
  select coalesce(jsonb_agg(o order by (o->>'shipped') desc), '[]'::jsonb) into v_recent from (
    select jsonb_build_object('order_id', w.order_id, 'value', w.order_value, 'qty', w.garment_qty, 'shipped', w.date_shipped,
             'processes', w.processes, 'rep', w.assigned_to, 'invoice', x.doc_number, 'invoice_status', x.status, 'invoice_due', x.amount_due) o
    from wip_orders w
    left join lateral (select d.doc_number, d.status, d.amount_due from xero_sales_documents d
                       where d.order_id = w.order_id and d.doc_type = 'invoice' and d.status not in ('VOIDED', 'DELETED')
                       order by d.doc_date desc limit 1) x on true
    where lower(regexp_replace(btrim(w.customer_name), '\s+', ' ', 'g')) = v_key and w.order_status = 3
    order by w.date_shipped desc nulls last limit 15
  ) t;

  -- spend by month, last 24 months
  select jsonb_agg(jsonb_build_object('m', to_char(m, 'YYYY-MM'), 'v', coalesce(s.v, 0), 'n', coalesce(s.n, 0)) order by m) into v_month
  from generate_series(date_trunc('month', now()) - interval '23 months', date_trunc('month', now()), interval '1 month') m
  left join (select date_trunc('month', date_shipped) mm, sum(order_value) v, count(*) n from wip_orders
             where lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')) = v_key and order_status = 3 and date_shipped is not null group by 1) s on s.mm = m;

  -- who handles them, and what decoration they use
  select coalesce(jsonb_agg(jsonb_build_object('rep', coalesce(rep, 'Unassigned'), 'orders', n, 'spend', v) order by v desc), '[]'::jsonb) into v_reps
  from (select assigned_to rep, count(*) n, sum(order_value) v from wip_orders
        where lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')) = v_key and order_status = 3 group by 1) r;
  select coalesce(jsonb_agg(jsonb_build_object('process', p, 'orders', n) order by n desc), '[]'::jsonb) into v_proc
  from (select p, count(*) n from (select unnest(processes) p from wip_orders
        where lower(regexp_replace(btrim(customer_name), '\s+', ' ', 'g')) = v_key and order_status = 3) a group by p) b;

  -- what they buy (invoice lines, shipping and fees left out)
  select coalesce(jsonb_agg(jsonb_build_object('type', t, 'qty', q, 'value', v) order by v desc), '[]'::jsonb) into v_mix from (
    select coalesce(l.product_type, 'Other') t, round(sum(l.quantity)) q, round(sum(l.net_amount), 2) v
    from xero_sales_line_items l join xero_sales_documents d on d.xero_id = l.xero_id
    where d.doc_type = 'invoice' and d.status in ('AUTHORISED', 'PAID')
      and lower(regexp_replace(btrim(d.xero_contact_name), '\s+', ' ', 'g')) = v_key
      and coalesce(l.product_type, '') not in ('Shipping', 'Fees & adjustments')
    group by 1 order by 3 desc limit 10
  ) m;

    select w.order_id, to_jsonb(w) - 'customer_name' - 'store_name' - 'synced_at' into v_last, v_lastrow
  from wip_orders w where lower(regexp_replace(btrim(w.customer_name), '\s+', ' ', 'g')) = v_key and w.order_status = 3
  order by (w.order_value > 0) desc, w.date_shipped desc nulls last limit 1;   -- latest chargeable order (a £0 re-do is not "the last order")
  if v_last is not null then
    select jsonb_agg(jsonb_build_object('desc', description, 'qty', quantity, 'unit', unit_amount, 'net', net_amount, 'type', product_type) order by line_no)
      into v_lines from (
        select l.description, l.quantity, l.unit_amount, l.net_amount, l.product_type, l.line_no
        from xero_sales_line_items l join xero_sales_documents d on d.xero_id = l.xero_id
        where d.order_id = v_last and d.doc_type = 'invoice' and d.status in ('AUTHORISED', 'PAID') order by l.line_no limit 60) z;
    v_lines_src := 'invoice';
    if v_lines is null then
      select jsonb_agg(jsonb_build_object('desc', concat_ws(' ', product_name, nullif(option_name, ''), nullif(size, '')), 'qty', coalesce(qty_required, line_qty), 'unit', unit_price, 'net', round(coalesce(qty_required, line_qty) * unit_price, 2), 'type', null) order by line_id)
        into v_lines from (select * from sales_order_lines where order_id = v_last
                and synced_at >= (select max(synced_at) from sales_order_lines where order_id = v_last) - interval '5 minutes'   -- ignore stale rows left by order edits
              order by line_id, workflow_item_id limit 60) s;
      v_lines_src := 'order';
    end if;
    if v_lines is null then v_lines_src := null; end if;
  end if;

  -- money
  select jsonb_build_object(
    'invoiced', coalesce(sum(sub_total) filter (where doc_type = 'invoice' and status in ('AUTHORISED', 'PAID')), 0),
    'credited', coalesce(sum(sub_total) filter (where doc_type = 'credit_note' and status in ('AUTHORISED', 'PAID')), 0),
    'unpaid', coalesce(sum(amount_due) filter (where doc_type = 'invoice' and status = 'AUTHORISED'), 0),
    'unpaid_count', count(*) filter (where doc_type = 'invoice' and status = 'AUTHORISED' and amount_due > 0),
    'overdue', coalesce(sum(amount_due) filter (where doc_type = 'invoice' and status = 'AUTHORISED' and due_date < current_date), 0),
    'oldest_overdue_days', max(current_date - due_date) filter (where doc_type = 'invoice' and status = 'AUTHORISED' and amount_due > 0 and due_date < current_date)
  ) into v_fin
  from xero_sales_documents where lower(regexp_replace(btrim(xero_contact_name), '\s+', ' ', 'g')) = v_key;
  select round(avg(p.paid::date - w.date_shipped::date)) into v_pay
  from wip_orders w join (select order_id, max(date_paid) paid from wip_payments group by 1) p on p.order_id = w.order_id
  where lower(regexp_replace(btrim(w.customer_name), '\s+', ' ', 'g')) = v_key and w.order_status = 3
    and w.date_shipped >= now() - interval '24 months' and p.paid is not null;

  -- people at the customer, reorder pattern and Win-back history
  select coalesce(jsonb_agg(jsonb_build_object('customer_id', customer_id, 'name', name, 'email', email, 'total_orders', total_orders,
           'last_order_date', last_order_date, 'mean_reorder_days', mean_reorder_days, 'reorder_status', reorder_status,
           'overdue_by_days', overdue_by_days, 'owner', owner, 'last_contact_at', last_contact_at, 'last_contact_outcome', last_contact_outcome,
           'follow_up_on', follow_up_on) order by last_order_date desc nulls last), '[]'::jsonb) into v_wb
  from (select * from winback_board where lower(regexp_replace(btrim(company), '\s+', ' ', 'g')) = v_key order by last_order_date desc nulls last limit 20) b;
  select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'by', contacted_by, 'method', method, 'outcome', outcome, 'note', note, 'follow_up_on', follow_up_on) order by created_at desc), '[]'::jsonb) into v_log
  from (select c.* from winback_contacts c where c.customer_id in (select customer_id from winback_board where lower(regexp_replace(btrim(company), '\s+', ' ', 'g')) = v_key)
        order by c.created_at desc limit 10) c;

  return jsonb_build_object('found', true, 'customer', v_name, 'stats', st, 'avg_gap_days', v_gap, 'open_orders', v_open, 'recent_orders', v_recent,
    'monthly', v_month, 'reps', v_reps, 'processes', v_proc, 'product_mix', v_mix, 'last_order', v_lastrow, 'last_order_lines', v_lines,
    'last_order_lines_from', v_lines_src, 'money', v_fin, 'avg_days_to_pay', v_pay, 'people', v_wb, 'contact_log', v_log);
end $$;

revoke all on function public.customer_history_by_name(text) from public, anon;
grant execute on function public.customer_history_by_name(text) to authenticated;

create or replace function public.quote_customer_history(p_order_id text)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v_name text;
begin
  select customer_name into v_name from quotes where order_id = p_order_id;
  return customer_history_by_name(v_name);
end $$;
revoke all on function public.quote_customer_history(text) from public, anon;
grant execute on function public.quote_customer_history(text) to authenticated;

create or replace function public.winback_customer_history(p_customer_id text)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v_name text;
begin
  select coalesce(nullif(btrim(company), ''), nullif(btrim(name), '')) into v_name from customer_reorder_alerts where customer_id = p_customer_id;
  return customer_history_by_name(v_name);
end $$;
revoke all on function public.winback_customer_history(text) from public, anon;
grant execute on function public.winback_customer_history(text) to authenticated;
