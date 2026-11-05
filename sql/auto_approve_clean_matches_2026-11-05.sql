-- NOTE (5 Nov 2026, later the same day): this turned out to be REDUNDANT. The invoice-reading n8n workflow has auto-approved clean matches (high confidence)
-- since 22 Sept 2026, so rows arrive already 'approved' and this trigger never fires for them. It is switched OFF (invoice_auto_settings.enabled = false) and kept only
-- for reference. What actually makes clean matches go to Xero as AUTHORISED is the 'Create Xero Bill' node of 'Post Approved Invoices to Xero'.
-- Clean matches go straight in: approved without a person, and posted to Xero as AUTHORISED instead of DRAFT. Re-runnable.
-- Agreed with Oliver 5 Nov 2026 (Steph has checked these bills for over a week and they were always right). No amount cap.
--
-- A row is auto-approved the moment it is saved with ALL of: waiting for review, match_status clean_match, high extraction confidence,
-- supplier already mapped to a nominal code, nominal code set, invoice number present (and not an MC backing sheet), invoice date present,
-- a matched PO, a total above zero, not snoozed, not already in Xero, and no other approved/posted row with the same supplier and invoice number.
-- It then looks exactly like a person pressed Approve (reviewed_by 'Auto: clean match') and auto_approved = true.
-- The existing n8n workflow "Post Approved Invoices to Xero" posts approved rows (daily at 5pm); for auto_approved rows it sends Status AUTHORISED.
-- Until then a person can still press Undo approve. If Xero refuses it or the supplier cannot be found, the workflow puts the row back to
-- Needs review (auto_approved is cleared, so a person approving it later gets a normal DRAFT).
-- Everything else (variances, mismatches, no PO, duplicates, low confidence, unmapped suppliers) is untouched.
-- Switch: invoice_auto_settings.enabled (set to false to stop at once; rows already approved stay approved and are posted as AUTHORISED unless undone).

create table if not exists public.invoice_auto_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by text
);
insert into public.invoice_auto_settings (id) values (1) on conflict do nothing;
alter table public.invoice_auto_settings enable row level security;
revoke all on public.invoice_auto_settings from anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'invoice_auto_settings' and policyname = 'signed-in read') then
    create policy "signed-in read" on public.invoice_auto_settings for select to authenticated using (true);
  end if;
end $$;
grant select on public.invoice_auto_settings to authenticated;

alter table public.pending_invoices add column if not exists auto_approved boolean not null default false;

create or replace function public.auto_approve_clean_match_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_on boolean;
begin
  -- A row going back to review (undo, or the Xero step failed) is no longer auto-approved.
  if TG_OP = 'UPDATE' and OLD.status = 'approved' and NEW.status <> 'approved' then
    NEW.auto_approved := false;
    return NEW;
  end if;
  -- Only look when something that decides the match changes (or the row is new), so a row put back to review is not approved again.
  if TG_OP = 'UPDATE' and OLD.match_status is not distinct from NEW.match_status
     and OLD.extraction_confidence is not distinct from NEW.extraction_confidence
     and OLD.has_supplier_mapping is not distinct from NEW.has_supplier_mapping then
    return NEW;
  end if;
  select enabled into v_on from invoice_auto_settings where id = 1;
  if not coalesce(v_on, false) then return NEW; end if;
  if NEW.status = 'awaiting_review'
     and NEW.match_status = 'clean_match'
     and NEW.extraction_confidence = 'high'
     and NEW.has_supplier_mapping is true
     and NEW.final_nominal_code is not null
     and NEW.extracted_invoice_number is not null and NEW.extracted_invoice_number !~* '^MC[0-9]+$'
     and NEW.extracted_invoice_date is not null
     and NEW.matched_po_number is not null
     and coalesce(NEW.final_total, NEW.extracted_total) > 0
     and NEW.snoozed_at is null and NEW.xero_bill_id is null
     and coalesce(NEW.extracted_vendor, '') <> ''
     and not exists (
       select 1 from pending_invoices o
        where o.id <> NEW.id and o.status in ('approved', 'posted')
          and o.extracted_invoice_number = NEW.extracted_invoice_number
          and lower(coalesce(o.extracted_vendor, '')) = lower(coalesce(NEW.extracted_vendor, ''))) then
    NEW.status := 'approved';
    NEW.auto_approved := true;
    NEW.reviewed_by := 'Auto: clean match';
    NEW.reviewed_at := now();
    NEW.final_vendor := coalesce(NEW.final_vendor, NEW.extracted_vendor);
    NEW.final_total := coalesce(NEW.final_total, NEW.extracted_total);
    NEW.final_po_reference := coalesce(NEW.final_po_reference, NEW.matched_po_number);
    NEW.review_notes := coalesce(NEW.review_notes, 'Auto-approved: clean match to the purchase order.');
  end if;
  return NEW;
end $$;
revoke all on function public.auto_approve_clean_match_trg() from public, anon, authenticated;

drop trigger if exists auto_approve_clean_match on public.pending_invoices;
create trigger auto_approve_clean_match before insert or update on public.pending_invoices
  for each row execute function public.auto_approve_clean_match_trg();
