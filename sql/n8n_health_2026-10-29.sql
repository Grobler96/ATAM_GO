-- Automation health for the Update log tab.
-- Failures are written by the shared n8n error-alert workflow (service role only).
-- The tab reads one function, n8n_health_report(), as the signed-in user.

create table if not exists public.n8n_failure_log (
  id bigserial primary key,
  workflow_id text,
  workflow_name text,
  node_name text,
  message text,
  execution_id text,
  execution_url text,
  created_at timestamptz not null default now()
);
create index if not exists n8n_failure_log_created_idx on public.n8n_failure_log (created_at desc);
create index if not exists n8n_failure_log_wf_idx on public.n8n_failure_log (workflow_id, created_at desc);
alter table public.n8n_failure_log enable row level security;
-- no policies: only the service role (n8n) and the security-definer function below can touch it.

create table if not exists public.n8n_workflow_watch (
  workflow_id text primary key,
  friendly_name text not null,
  what_it_does text,
  how_often text,
  area text,
  sort int not null default 100,
  active boolean not null default true
);
alter table public.n8n_workflow_watch enable row level security;
create policy n8n_workflow_watch_read on public.n8n_workflow_watch for select to authenticated using (true);

create or replace function public.n8n_health_report()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workflows jsonb;
  v_recent jsonb;
  v_fresh jsonb := '{}'::jsonb;
  v_failing int; v_warning int; v_stale int; v_score int; v_label text;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then raise exception 'sign in required'; end if;

  with f as (
    select workflow_id,
           count(*) filter (where created_at > now() - interval '24 hours') as n24,
           max(created_at) as last_at,
           (array_agg(message order by created_at desc))[1] as last_msg,
           (array_agg(node_name order by created_at desc))[1] as last_node
    from n8n_failure_log
    where created_at > now() - interval '7 days'
    group by workflow_id
  ), w as (
    select ww.sort, ww.workflow_id, ww.friendly_name, ww.what_it_does, ww.how_often, ww.area,
           coalesce(f.n24, 0) as failures_24h, f.last_at, f.last_msg, f.last_node,
           case when coalesce(f.n24, 0) >= 3 then 'failing'
                when coalesce(f.n24, 0) >= 1 then 'warning'
                else 'ok' end as status
    from n8n_workflow_watch ww left join f on f.workflow_id = ww.workflow_id
    where ww.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'workflow_id', workflow_id, 'name', friendly_name, 'what', what_it_does, 'how_often', how_often, 'area', area,
           'status', status, 'failures_24h', failures_24h, 'last_failure_at', last_at,
           'last_error', left(coalesce(last_msg, ''), 300), 'failed_at_step', last_node)
           order by (case status when 'failing' then 0 when 'warning' then 1 else 2 end), sort, friendly_name), '[]'::jsonb),
         count(*) filter (where status = 'failing'), count(*) filter (where status = 'warning')
  into v_workflows, v_failing, v_warning from w;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workflow', coalesce(ww.friendly_name, l.workflow_name, l.workflow_id), 'step', l.node_name,
           'message', left(coalesce(l.message, ''), 300), 'at', l.created_at) order by l.created_at desc), '[]'::jsonb)
  into v_recent from (select * from n8n_failure_log order by created_at desc limit 10) l
  left join n8n_workflow_watch ww on ww.workflow_id = l.workflow_id;

  begin v_fresh := public.data_freshness_report()::jsonb; exception when others then v_fresh := '{}'::jsonb; end;
  v_stale := coalesce((v_fresh ->> 'problem_count')::int, 0);

  v_score := greatest(0, 100 - least(60, v_failing * 15) - least(20, v_warning * 5) - least(45, v_stale * 15));
  v_label := case when v_score >= 90 then 'Healthy' when v_score >= 70 then 'Needs a look' else 'Problem' end;

  return jsonb_build_object('score', v_score, 'label', v_label, 'checked_at', now(),
    'failing', v_failing, 'warning', v_warning, 'stale_tables', v_stale,
    'workflows', v_workflows, 'recent_failures', v_recent, 'freshness', v_fresh);
end $$;
revoke all on function public.n8n_health_report() from public, anon;
grant execute on function public.n8n_health_report() to authenticated, service_role;

-- Plain-English list of what is watched (edit here to add or rename).
insert into public.n8n_workflow_watch (workflow_id, friendly_name, what_it_does, how_often, area, sort) values
 ('8SP7xxQMJixzS5Ao','Supplier invoice pick-up','Reads the shared invoice mailbox and sends each invoice for checking','Every 5 minutes','Invoices',10),
 ('GpZTT3iz2lsQUqjf','Stuck invoice email alert','Warns if an invoice email sits unprocessed for a day','Every 2 hours','Invoices',11),
 ('UbL4DkXUAaeQjcPv','Invoice reading and matching','Reads each invoice and matches it to the purchase order','When an invoice arrives','Invoices',12),
 ('epZnToAuVLXDdUFF','Retry purchase order match','The Retry Match button on Purchase Order Review','When pressed','Invoices',13),
 ('OhK2EuB9ZwXzngsD','Post approved invoices to Xero','Sends approved supplier invoices to Xero as drafts','Daily at 5pm','Invoices',14),
 ('Iucsd3mqhBS09em0','Create Xero supplier','Creates a new supplier in Xero from the review page','When pressed','Invoices',15),
 ('PuIT1ap0n839C7FD','Sales invoices','Builds and posts sales invoices to Xero','Every 20 to 30 minutes','Sales invoices',20),
 ('cok0vzJlX0mvENQ4','Refresh sales invoices from Xero','Brings Xero sales invoice status back into ATAM GO','Daily','Sales invoices',21),
 ('2nu3chdK7IAdvYzn','Xero sales sync','Copies Xero sales, credit notes and payments for customer spend','Daily','Sales invoices',22),
 ('eETnQFhI5y5lBt0g','Production counting','Records finished decoration work from DecoNetwork','Every 2 hours','Production',30),
 ('tgGXabnIS10Fi5Rz','Dispatch confirm','The Mark Dispatched button','When pressed','Production',31),
 ('5oK8u0HSPJgrd7pa','Upcoming orders','Pulls orders due in the next 14 days','Every 30 minutes','Production',32),
 ('73Z2ZiwaVEyiKvjM','Order value sync','Keeps work in progress and revenue figures up to date','Every 30 minutes','Revenue',33),
 ('JuhKhMdIb0KgxUyS','Daily production report','The daily production summary','Daily and on the Actions tab','Production',34),
 ('ndvdmSXMPmP02hJw','Actions tab buttons','Runs the buttons on the Actions tab','When pressed','Site',35),
 ('9Cv22HZCq4j7VGuB','Quotes sync','Brings DecoNetwork quotes into the Quotes tab','Every 6 hours','Quotes',40),
 ('iPFyyUkJ3AbQH9iR','Quote and customer emails','Sends the emails written in Quotes, Win-back and New customers','When pressed','Quotes',41),
 ('wnPRUfjJX0qc9kBE','Reply check','Spots customer replies to emails sent from ATAM GO','Every 30 minutes','Quotes',42),
 ('dxAUfb7RiwDPGk7X','Customer reorder data','Rebuilds who is overdue to reorder, and finds new customers','Nightly','Customers',50),
 ('TSAdczE2ZD3aao3z','Stock levels','Pulls stock on hand from DecoNetwork','Every 3 hours','Stock',60),
 ('HiGWYM6mBFfpj1lo','Working stock','Pulls stock committed to orders in progress','Every 3 hours','Stock',61),
 ('urol3WAfR909odVQ','Supplier costs','Updates supplier costs and monthly purchase spend','Every 3 hours','Stock',62),
 ('BOc4YPbNy6iCdcca','Stock value','Works out the value of stock each day','Every 3 hours','Stock',63),
 ('HW0marEPYbMvIqzR','Purchase orders','Copies purchase orders from DecoNetwork','Every 3 hours','Stock',64),
 ('YQrdOeip87jXXHyw','Ralawise stock','Supplier stock levels','Daily','Stock',65),
 ('XUToBw5yiqTUx1c1','Portwest stock','Supplier stock levels','Daily','Stock',66),
 ('GU1NQgG0hVuifqre','New suggestions email','Emails new Update log suggestions','Weekday mornings','Update log',70),
 ('uAyQiatTWkw7p8JV','Data freshness check','Warns if key figures stop updating','Hourly','Health',80)
on conflict (workflow_id) do update set friendly_name = excluded.friendly_name, what_it_does = excluded.what_it_does,
  how_often = excluded.how_often, area = excluded.area, sort = excluded.sort;
