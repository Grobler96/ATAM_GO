-- Save a review note on a supplier invoice without approving, rejecting or moving it (19 Nov 2026, v97).
-- Steph: the Review notes box did not keep what she typed: the note was only saved by Approve, Reject or Move to In Review.
-- Signed-in users only. Only touches review_notes, only while the invoice is awaiting review. An empty note clears a person's note
-- but never wipes the poster's own AUTO-POST bounce text.
create or replace function public.save_invoice_note(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_note text; v_old text;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authenticated'; end if;
  v_note := nullif(btrim(left(coalesce(p_note, ''), 1000)), '');
  select review_notes into v_old from pending_invoices where id = p_id and status = 'awaiting_review';
  if not found then
    raise exception 'Invoice not found or no longer awaiting review.';
  end if;
  if v_note is null and v_old like 'AUTO-POST%' then return; end if;
  update pending_invoices set review_notes = v_note where id = p_id and status = 'awaiting_review';
end;
$$;
revoke execute on function public.save_invoice_note(uuid, text) from public, anon;
grant execute on function public.save_invoice_note(uuid, text) to authenticated, service_role;
