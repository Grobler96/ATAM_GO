-- DAN agent (Cloudflare worker v13): one action that was missing for a signed-in user.
-- reassign_order used to be done by the worker with the public key; the lockdown rightly blocks that, so it is now a
-- signed-in-only function. Names must be one of the team.
create or replace function public.dan_reassign_order(p_order_id text, p_assigned_to text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_assigned_to not in ('Daniel Spooner', 'Bethan Kaye', 'Emma Harman', 'Julie Sheehan', 'Francesca Spooner', 'Christine Ball') then
    raise exception 'not a recognised team member';
  end if;
  update upcoming_orders set assigned_to = p_assigned_to where order_id = p_order_id and date_shipped is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'no open order % found', p_order_id; end if;
  return 'Order ' || p_order_id || ' is now with ' || p_assigned_to;
end $$;
revoke all on function public.dan_reassign_order(text, text) from public, anon;
grant execute on function public.dan_reassign_order(text, text) to authenticated;
