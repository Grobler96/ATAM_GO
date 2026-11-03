# Monday morning report to Daniel

n8n workflow id `cd1i642bn9N30yFK`. Built 3 Nov 2026, **unpublished** (nothing sends until it is published).

- Schedule: cron `30 6-8 * * 1` (Mondays, UTC), then the node "Only at 07:30 London time" lets through only the run where the London hour is 7, once per date (workflow static data `lastRun`), so it sends at 07:30 in both summer and winter time.
- "Get Monday Report" calls the database function `monday_report()` (`sql/monday_report_2026-11-03.sql`) with the Supabase credential "Supabase account 2". It returns one JSON object: last full week against the week before (orders approved, quotes raised, invoiced, pieces embroidered and printed), open quotes (count, value, expected to win, quiet 3+ days), late orders, overdue invoices (up to 90 days, and over 90), per salesperson figures, and the five open quotes worth the most.
- "Write the Report Email" builds the HTML (recipient is the constant `TO` at the top of that node: daniel.spooner@atam.co.uk).
- "Send Email From Support Mailbox" sends it with Graph `sendMail` from support@atam.co.uk (credential "Microsoft Graph Mailer"). This step is deliberately not retried, so the email cannot go twice.
- Error workflow: the shared one (`VXZ5k3Gs17uVoJBS`).
- To send a test to someone else: change `TO` in "Write the Report Email" and run the workflow once by hand from n8n, then change it back. A manual run goes through the 07:30 gate only if started from the Schedule node: start from "Get Monday Report" instead.
- When published, add a row for it in `n8n_workflow_watch` (see the Automation health note in CLAUDE.md).
- Not tested end to end: the database function and the email layout were tested separately (the email was built from real data and looked at as a picture); the Graph send and the schedule have not run.
