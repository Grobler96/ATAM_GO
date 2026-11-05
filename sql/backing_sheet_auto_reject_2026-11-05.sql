-- Backing sheets (WCMA "Monthly Calloff Archive", numbers like MC0276) arrive as a second PDF in the same email as the real invoice
-- and were showing up in Purchase Order Review as if they were invoices. Re-runnable.
--
-- Rule: a row waiting for review whose invoice number is MC followed by digits (or whose notes call it a Monthly Calloff Archive)
-- goes straight to Rejected, with a note, IF the same email also produced a real invoice (a sibling row whose number is not MC...).
-- Emails are matched by source_email_id with the trailing -<n> removed. The check runs whichever of the two rows is saved last.
-- If no real invoice came with it, the row is left alone for a person to look at. Nothing is approved or posted.

create or replace function public.reject_backing_sheet_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_base text := regexp_replace(new.source_email_id, '-[0-9]+$', '');
begin
  if new.source_email_id is null then return new; end if;
  if new.extracted_invoice_number ~* '^MC[0-9]+$' then
    -- this row is the backing sheet: reject it if a real invoice from the same email exists
    if new.status = 'awaiting_review' and exists (
      select 1 from pending_invoices s
       where s.id <> new.id and regexp_replace(s.source_email_id, '-[0-9]+$', '') = v_base
         and coalesce(s.extracted_invoice_number, '') !~* '^MC[0-9]+$' and s.extracted_invoice_number is not null) then
      update pending_invoices set status = 'rejected', reviewed_by = 'Auto: backing sheet', reviewed_at = now(),
             review_notes = 'Backing sheet (Monthly Calloff Archive), not an invoice. The real invoice came in the same email.'
       where id = new.id and status = 'awaiting_review';
    end if;
  elsif new.extracted_invoice_number is not null then
    -- this row is a real invoice: reject any backing sheet already waiting from the same email
    update pending_invoices set status = 'rejected', reviewed_by = 'Auto: backing sheet', reviewed_at = now(),
           review_notes = 'Backing sheet (Monthly Calloff Archive), not an invoice. The real invoice came in the same email.'
     where id <> new.id and status = 'awaiting_review' and extracted_invoice_number ~* '^MC[0-9]+$'
       and regexp_replace(source_email_id, '-[0-9]+$', '') = v_base;
  end if;
  return null;
end $$;
revoke all on function public.reject_backing_sheet_trg() from public, anon, authenticated;

drop trigger if exists reject_backing_sheet on public.pending_invoices;
create trigger reject_backing_sheet after insert or update of extracted_invoice_number, source_email_id on public.pending_invoices
  for each row execute function public.reject_backing_sheet_trg();

-- One-off: clear the ones already waiting.
update public.pending_invoices p set status = 'rejected', reviewed_by = 'Auto: backing sheet', reviewed_at = now(),
       review_notes = 'Backing sheet (Monthly Calloff Archive), not an invoice. The real invoice came in the same email.'
 where p.status = 'awaiting_review' and p.extracted_invoice_number ~* '^MC[0-9]+$'
   and exists (select 1 from pending_invoices s where s.id <> p.id
                and regexp_replace(s.source_email_id, '-[0-9]+$', '') = regexp_replace(p.source_email_id, '-[0-9]+$', '')
                and s.extracted_invoice_number is not null and s.extracted_invoice_number !~* '^MC[0-9]+$');
