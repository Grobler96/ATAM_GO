-- Credit notes and other documents the invoice reader could not treat as an invoice. Re-runnable.
--
-- When the invoice reader gets a PDF that is not a normal supplier invoice (a credit note, delivery note, statement, terms and conditions...), it files it in
-- `unmatched_documents` instead of Purchase Order Review. Nothing on the site showed that list, so for example Portwest credit note 000804501 (GBP -22.08,
-- received 6 Oct 2026) was never seen. The Purchase Order Review page now has a tab for it.
--   unmatched_documents_board : the table plus a `kind` worked out from the reason text (credit_note, delivery_note, terms, statement, old_supplier, other).
--                               security invoker, so it follows the table's row level security (signed-in users can read).
--   mark_unmatched_reviewed(ids, note) / unmark_unmatched_reviewed(id) : the only ways the page changes a row (signed-in only). Ticking a document as
--                               "dealt with" does nothing else: nothing is posted to Xero and nothing is deleted.
-- The table also gave signed-in users INSERT / UPDATE / DELETE / TRUNCATE rights (row level security blocked all but TRUNCATE, which it does not cover): tightened
-- to read only. n8n writes with the service role and is not affected.

revoke all on public.unmatched_documents from anon, authenticated;
grant select on public.unmatched_documents to authenticated;

create or replace view public.unmatched_documents_board with (security_invoker = true) as
select id, source_ref, vendor_name, document_date, total_amount, pdf_url, reason, reviewed, reviewed_by, reviewed_at, review_notes, created_at,
  case
    when reason ilike '%credit note%' then 'credit_note'
    when reason ilike '%delivery note%' or reason ilike '%returns note%' or reason ilike '%dispatch note%' or reason ilike '%packing%' then 'delivery_note'
    when reason ilike '%terms and conditions%' or reason ilike '%terms & conditions%' then 'terms'
    when reason ilike '%statement%' then 'statement'
    when reason ilike 'vendor_not_in_supplier_mapping%' then 'old_supplier'
    else 'other'
  end as kind
from public.unmatched_documents;
revoke all on public.unmatched_documents_board from anon, authenticated;
grant select on public.unmatched_documents_board to authenticated;

create or replace function public.mark_unmatched_reviewed(p_ids uuid[], p_note text default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; v_by text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 500 then raise exception 'too many at once'; end if;
  v_by := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
  update unmatched_documents
     set reviewed = true, reviewed_by = v_by, reviewed_at = now(),
         review_notes = coalesce(nullif(btrim(left(p_note, 300)), ''), review_notes)
   where id = any(p_ids) and not reviewed;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.mark_unmatched_reviewed(uuid[], text) from public, anon;
grant execute on function public.mark_unmatched_reviewed(uuid[], text) to authenticated;

create or replace function public.unmark_unmatched_reviewed(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update unmatched_documents set reviewed = false, reviewed_by = null, reviewed_at = null where id = p_id;
end $$;
revoke all on function public.unmark_unmatched_reviewed(uuid) from public, anon;
grant execute on function public.unmark_unmatched_reviewed(uuid) to authenticated;
