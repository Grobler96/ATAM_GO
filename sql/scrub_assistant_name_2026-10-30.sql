-- Keep the AI assistant's name out of stored records that people can see. Re-runnable.
--
-- Oliver does not want the assistant's name shown anywhere in ATAM GO. Old records were reworded by hand on 30 Oct 2026. This rule stops it
-- coming back: whenever one of the fields below is saved, the name (and "<name> Code" / "<name> AI") is replaced by "the system"
-- ("The system" at the start of a sentence or after an opening bracket). Examples: "Voided by Claude on 1 Oct" -> "Voided by the system on 1 Oct",
-- "Claude (audit)" -> "The system (audit)".
--
-- Only fields that automation or an assistant writes are covered (who reviewed / set / parked it, and system-written notes). Free-text fields that
-- people type (chase notes, reasons, review notes) are left alone on purpose, so a real person or customer called Claude is never rewritten.

create or replace function public.scrub_assistant_name(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when t is null or t !~* 'claude' then t else
    regexp_replace(
      regexp_replace(t, '\mClaude\M([[:space:]]+(Code|AI)\M)?', 'the system', 'gi'),
      '(^|[.!?][[:space:]]+|\([[:space:]]*)the system', '\1The system', 'g')
  end
$$;

-- One trigger function for every table: the column names to clean are passed as the trigger's arguments.
create or replace function public.scrub_assistant_name_trg() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v jsonb; c text; s text; changed boolean := false;
begin
  v := to_jsonb(NEW);
  foreach c in array TG_ARGV loop
    s := v ->> c;
    if s is not null and s ~* 'claude' then
      v := jsonb_set(v, array[c], to_jsonb(public.scrub_assistant_name(s)));
      changed := true;
    end if;
  end loop;
  if changed then NEW := jsonb_populate_record(NEW, v); end if;
  return NEW;
end $$;

create or replace trigger scrub_assistant_name before insert or update on public.pending_invoices
  for each row execute function public.scrub_assistant_name_trg('extraction_notes', 'reviewed_by', 'snoozed_by');
create or replace trigger scrub_assistant_name before insert or update on public.pending_sales_invoices
  for each row execute function public.scrub_assistant_name_trg('reviewed_by', 'snoozed_by');
create or replace trigger scrub_assistant_name before insert or update on public.sales_invoice_log
  for each row execute function public.scrub_assistant_name_trg('notes');
create or replace trigger scrub_assistant_name before insert or update on public.vendor_xero_contact_override
  for each row execute function public.scrub_assistant_name_trg('set_by', 'notes');
create or replace trigger scrub_assistant_name before insert or update on public.invoice_discrepancies
  for each row execute function public.scrub_assistant_name_trg('resolved_by', 'deconetwork_corrected_by');
create or replace trigger scrub_assistant_name before insert or update on public.unmatched_documents
  for each row execute function public.scrub_assistant_name_trg('reason', 'reviewed_by');
create or replace trigger scrub_assistant_name before insert or update on public.quote_parked
  for each row execute function public.scrub_assistant_name_trg('parked_by');
create or replace trigger scrub_assistant_name before insert or update on public.quote_removed
  for each row execute function public.scrub_assistant_name_trg('removed_by');
create or replace trigger scrub_assistant_name before insert or update on public.quote_revived
  for each row execute function public.scrub_assistant_name_trg('revived_by');
create or replace trigger scrub_assistant_name before insert or update on public.quote_chases
  for each row execute function public.scrub_assistant_name_trg('chased_by');
create or replace trigger scrub_assistant_name before insert or update on public.account_manager_assignments
  for each row execute function public.scrub_assistant_name_trg('set_by');
create or replace trigger scrub_assistant_name before insert or update on public.account_manager_history
  for each row execute function public.scrub_assistant_name_trg('changed_by');
create or replace trigger scrub_assistant_name before insert or update on public.winback_contacts
  for each row execute function public.scrub_assistant_name_trg('contacted_by');
