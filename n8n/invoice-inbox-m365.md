# Invoice inbox from Microsoft 365 (built 26 Oct 2026, NOT switched on)

Replaces the Gmail intake ("Invoice Inbox → Extraction Pipeline", id `x1CJVoFZ9cwioqIT`) with a Microsoft 365 shared mailbox. The Gmail workflow is untouched and still running. Extraction, matching and review (`/webhook/new-invoice` and everything after it) are unchanged.

## Pieces (all in n8n, both unpublished)
- **Invoice Inbox (Microsoft 365) → Extraction Pipeline**, id `wR1tq3DVJCyHFCgL`, every 5 minutes.
  1. Finds the mailbox folder "Processed" (creates it if missing). If it exists, it renames it to "Processed" (no change), which is a harmless write test: if the app has no write permission this step fails and nothing else runs.
  2. Reads Inbox emails that have attachments (20 at a time).
  3. For each: lists attachments, keeps PDFs, saves each PDF to Supabase storage `invoice-pdfs`, posts it to `/webhook/new-invoice` (same body as the Gmail one).
  4. Moves an email to "Processed" only if every PDF in it was accepted by the extraction webhook. Emails with no PDF, or where a send failed, stay in the Inbox for a person (and for the alert).
- **Invoice mailbox stuck-email alert (every 2 hours)**, id `90c4Hay5EBwxUHn4`. Lists Inbox emails older than a day and emails Daniel and Oliver. Same list is re-sent at most every 12 hours.

## Details worth knowing
- Mailbox: `InvoicePOProcessing@atam.co.uk`. Credential: "Microsoft Graph Mailer" (`MTItUM9t4dz5IIht`, Entra app "ATAM GO Mailer"). Needs Mail.Read **and** Mail.ReadWrite on this mailbox (ReadWrite to move mail).
- Invoice ids are `m365-<immutable message id>-<pdf number>`. Graph is asked for immutable ids (`Prefer: IdType="ImmutableId"`) because normal ids change when an email is moved.
- Duplicates: the invoice table refuses a repeat of the same id, but the Gmail and Microsoft ids differ (`gmail-…` vs `m365-…`). If the same supplier email reaches both mailboxes, you get two invoices. Do not run both on real traffic: switch the Gmail forward off at cutover.
- The extraction webhook still checks the old shared token header; this workflow sends it exactly as the Gmail one does. It must be replaced in both places together (a login-style check on the webhook) when the Gmail workflow is retired.
- No clean-up of old Processed mail is built. Suggest IT sets a retention rule on the mailbox (e.g. 18 months).

## Not tested (mailbox did not exist / permissions pending when built)
Nothing has run against the real mailbox. First run checklist: publish the alert workflow second; publish the intake workflow, send one test invoice to the mailbox, confirm it appears in Pending invoices (Purchase Order Review), the email moves to Processed, and the stuck alert stays quiet.
