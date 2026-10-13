-- An earlier version of the Quotes tab guessed that "quote = order status 1" and tracked status changes with a trigger
-- on wip_orders. That was wrong (status-1 orders are already approved), so it was replaced by the DecoNetwork sync
-- (see quote_tracking.sql). The trigger function was turned into a no-op, but the pieces below are still in the database.
-- They are unused and safe to remove. Run this in the Supabase SQL editor.

drop trigger if exists wip_orders_quote_ins on public.wip_orders;
drop trigger if exists wip_orders_quote_upd on public.wip_orders;
drop function if exists public.trg_wip_orders_quote_track();
drop view if exists public.quotes_pipeline;
drop table if exists public.quote_tracker;
drop table if exists public.quote_events;
