-- Notes on overdue orders (19 Nov 2026, v95). Re-runnable (no DROP: the Supabase tool hangs on it).
-- Request (Daniel / the team): a short note on an overdue order that says why it is late, shown on the Overdue Orders page under the "Overdue by N days" bar.
-- One note per order, kept in its own table so the hourly DecoNetwork refresh (which rewrites upcoming_orders) can never wipe it.
-- Anyone signed in can read notes; writes only through set_order_note (signed in; records who and when; an empty note clears it; 300 characters at most).
create table if not exists public.order_notes (
  order_id text primary key,
  note text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.order_notes enable row level security;
do $p$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_notes' and policyname = 'order_notes_read') then
    create policy order_notes_read on public.order_notes for select to authenticated using (true);
  end if;
end $p$;
revoke all on public.order_notes from anon, authenticated;
grant select on public.order_notes to authenticated;

create or replace function public.set_order_note(p_order_id text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_who text; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_row public.order_notes;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if nullif(btrim(coalesce(p_order_id, '')), '') is null then raise exception 'an order number is needed'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'the note is too long (300 characters at most)'; end if;
  if v_note is null then
    delete from public.order_notes where order_id = p_order_id;
    return jsonb_build_object('order_id', p_order_id, 'note', null);
  end if;
  select coalesce(nullif(full_name, ''), email) into v_who from public.profiles where id = auth.uid();
  insert into public.order_notes (order_id, note, updated_by, updated_at) values (p_order_id, v_note, v_who, now())
  on conflict (order_id) do update set note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('order_id', v_row.order_id, 'note', v_row.note, 'updated_by', v_row.updated_by, 'updated_at', v_row.updated_at);
end $$;
revoke all on function public.set_order_note(text, text) from public, anon;
grant execute on function public.set_order_note(text, text) to authenticated;
