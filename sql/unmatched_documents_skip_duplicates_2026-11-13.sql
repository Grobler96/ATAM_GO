-- Stop the invoice reader failing when it meets a document it has already saved. Re-runnable (the trigger is only created once).
--
-- Problem (13 Nov 2026, failure email "Insert Into Unmatched Documents ... Your request is invalid or could not be processed by the service"): the Prestige Leisure
-- Terms and Conditions (source_ref m365-f1e547ba...-1) were saved in unmatched_documents at 22:18 on 12 Nov. The invoice inbox then read the same email again every
-- 5 minutes (13:13, 13:18, 13:23 ... 15:13 and onwards): each time the workflow tried to save it again, the unique index idx_unmatched_documents_source_ref_unique refused it
-- with a 409, n8n reported that as "request is invalid", the workflow stopped and the email was never moved out of the inbox, so it came round again. The insert asks
-- for "ignore duplicates" but without a conflict column PostgREST only ignores a clash on the primary key (id), not on source_ref.
-- Fix: a before-insert trigger skips a row whose source_ref is already saved, so the insert succeeds (nothing is added) and the workflow can carry on and clear the email.
-- A new document still saves (tested in a rolled-back block: same document again = no error and no extra row; new document = one more row).
-- Still to do in n8n when it is reachable: add on_conflict=source_ref to the URL of "Insert Into Unmatched Documents" (and the same for pending_invoices if it has the same gap),
-- and rename the workflow so it does not name the AI tool.

create or replace function public.skip_duplicate_unmatched_source_ref()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.source_ref is not null and exists (select 1 from public.unmatched_documents d where d.source_ref = new.source_ref) then
    return null;
  end if;
  return new;
end;
$function$;

-- create trigger skip_duplicate_source_ref before insert on public.unmatched_documents for each row execute function public.skip_duplicate_unmatched_source_ref();
-- (applied once on 13 Nov 2026; Postgres has no "create trigger if not exists", so it is left commented here.)
