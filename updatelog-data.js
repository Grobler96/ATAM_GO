// The Update log: every change made to ATAM GO, and what is planned. Shown on the Update log tab (updatelog.js).
// HOW TO ADD AN UPDATE (done with every change, in the same pull request):
//   1. Add a new entry at the TOP of ATAM_UPDATES with the next version number (v28, v29...).
//   2. status: 'in_progress' (being worked on; add progress: 0-100 for the bar), 'built' (finished, waiting to go live),
//      'partly' (some parts are live, some wait for a merge or publish), 'live' (working now), 'rolled_back' (undone).
//   3. When something goes live, change its status and add timeTaken (e.g. '2 h 30 m'). Oliver is asked what time to put
//      and exactly what he says is written; no time is shown on an entry until he has given one.
//      Never delete an entry: the point is to look back.
//   NOTE: the site only changes when a pull request is merged, so an in_progress bar is only visible on the site if a small
//   "started" update was merged first. Otherwise an update appears as built / live when its own pull request is merged.
// touches: where the change lives, so a problem can be traced. t is one of site | database | n8n | worker | access | docs.
// Planned work goes in ATAM_PLANNED (no version number until it is built).
window.ATAM_UPDATES = [
  {
    v: 'v27', date: '2026-10-26', status: 'live', pr: 26, areas: ['Site'],
    title: 'Update log tab',
    summary: 'This page. A running record of every update, with what it touched and what to check if something goes wrong.',
    changes: ['New Update log tab with a timeline of every version, search, filters and a "something broke" finder.', 'Each update can show a progress bar (in progress, finished and waiting, or completed) and the time taken, which is the figure Oliver gives for each one.', 'Every future update gets an entry here as part of the same change.'],
    touches: [{ t: 'site', n: 'updatelog.js' }, { t: 'site', n: 'updatelog-data.js' }, { t: 'site', n: 'index.html' }],
    watch: 'If the Update log tab does not appear, or the menu looks wrong after this one: it is the only page that changed.'
  },
  {
    v: 'v26', date: '2026-10-26', status: 'live', pr: 26, areas: ['Win-back'],
    title: 'Win-back guided steps: "How it works" and "Your move"',
    summary: 'Plain step-by-step help inside Win-back, so a new starter knows what to do next.',
    changes: ['A "How Win-back works" box at the top of the page explains each stage, what it means and what to do.', 'Every customer opens with a "Your move" box for their stage, with buttons (Spoke to them, Left a message, No answer, Email them).', 'The buttons only fill in the log form. Nothing is saved until Save contact is pressed.', 'The wording is a first draft to be checked with Daniel and Steph.'],
    touches: [{ t: 'site', n: 'winback.js' }],
    watch: 'If the Win-back drawer looks broken or a customer will not open, check this change and v24 first (both edited the drawer).'
  },
  {
    v: 'v25', date: '2026-10-26', status: 'live', pr: 26, areas: ['Calendar', 'Database'],
    title: 'Calendar tab',
    summary: 'One calendar of everything the team has to chase, by day, week or month, for everyone or one person.',
    changes: ['Shows Win-back chase dates, quote / Win-back / New customer emails still waiting for a reply after 3 days, and New customer follow-ups.', 'Late items show first on Today. Read-only: Open in... jumps to the item.', 'Live: the read-only database view and the tab.'],
    touches: [{ t: 'site', n: 'calendar.js' }, { t: 'site', n: 'index.html' }, { t: 'database', n: 'view calendar_actions (sql/calendar_actions_2026-10-26.sql)' }],
    watch: 'Calendar empty or wrong: check the calendar_actions view, and that emails are being marked sent / replied (see v17 and v20).'
  },
  {
    v: 'v24', date: '2026-10-26', status: 'partly', pr: 26, areas: ['Win-back', 'Database', 'n8n'],
    title: 'Win-back: change the owner, and a morning email to each owner',
    summary: 'Owners can be changed by hand, and each owner gets a weekday 7:45 email with their own list.',
    changes: ['Owner dropdown in the Win-back customer drawer. A hand-picked owner beats the automatic one; "Back to automatic" undoes it.', 'Weekday 7:45 (UK) email per owner: customers who just became due, and contacts whose chase date has arrived. Sent from support@. No-owner customers go to Daniel.', 'Owner dropdown and database parts are live. The morning email still needs its n8n workflow published.'],
    touches: [{ t: 'site', n: 'winback.js' }, { t: 'database', n: 'winback_owner_override, winback_status_seen, set_winback_owner, winback_owner_digest, winback_board (sql/winback_owner_and_digest_2026-10-26.sql)' }, { t: 'n8n', n: 'Win-back morning email to each owner (re1LEKh6qzaxwhsy), unpublished' }],
    watch: 'Win-back board shows the wrong owner: check winback_owner_override. Emails not arriving: check the n8n workflow is published and its runs.'
  },
  {
    v: 'v23', date: '2026-10-26', status: 'built', pr: 26, areas: ['Invoices', 'n8n'],
    title: 'Supplier invoice intake from Microsoft 365 (built, not switched on)',
    summary: 'Two n8n workflows to read supplier invoices from the new InvoicePOProcessing@ shared mailbox instead of Gmail.',
    changes: ['Intake workflow: every 5 minutes, sends PDFs into the existing extraction pipeline and moves finished emails to a Processed folder.', 'Stuck-email alert: emails Daniel and Oliver about anything left in the Inbox over a day.', 'Both are unpublished. The Gmail workflow is untouched and still the live one.', 'Not yet tested against the real mailbox.'],
    touches: [{ t: 'n8n', n: 'Invoice Inbox (Microsoft 365) → Extraction Pipeline (wR1tq3DVJCyHFCgL)' }, { t: 'n8n', n: 'Invoice mailbox stuck-email alert (90c4Hay5EBwxUHn4)' }, { t: 'docs', n: 'n8n/invoice-inbox-m365.md' }],
    watch: 'When switched on: duplicate invoices mean both Gmail and Microsoft intakes got the same email. Missing invoices: check the Inbox of the shared mailbox.'
  },
  {
    v: 'v22', date: '2026-10-26', status: 'live', pr: null, areas: ['Access'],
    title: 'New login for Julie Sheehan',
    summary: 'Julie Sheehan can now sign in to ATAM GO.',
    changes: ['Account created in Supabase with a temporary password, and given the same access as the rest of the team.'],
    touches: [{ t: 'access', n: 'Supabase user julie.sheehan@atam.co.uk, profiles row' }],
    watch: 'If Julie cannot sign in, reset her password in Supabase (Authentication, Users).'
  },
  {
    v: 'v21', date: '2026-10-23', status: 'live', pr: 25, areas: ['DAN'],
    title: 'DAN v16: knows New customers and can email new and win-back customers',
    summary: 'DAN reads the New customers list and can prepare and send emails to new and overdue customers.',
    changes: ['New customers section in the morning briefing and alerts.', 'DAN can email overdue Win-back and New customers (only when email sending is on, and only to the address on file by phone).'],
    touches: [{ t: 'worker', n: 'worker/danbotv2.js (pasted into Cloudflare by hand)' }],
    watch: 'DAN not answering or odd answers after this: check which worker version is pasted into Cloudflare.'
  },
  {
    v: 'v20', date: '2026-10-23', status: 'live', pr: 24, areas: ['Win-back', 'New customers', 'Database', 'n8n'],
    title: 'Win-back email, fixed reorder data, and the New customers tab',
    summary: 'Email from Win-back cards, a nightly refresh of the reorder data that had stopped in June, and a new tab for nurturing new customers.',
    changes: ['Win-back cards can email the customer, with reply tracking that moves the card to Replied.', 'The reorder table (customer_reorder_metrics) had not refreshed since 30 June 2026. It now rebuilds every night at 03:00 from the last 60 days of DecoNetwork orders.', 'New customers tab: stages, checklist, "what they want" form, summary for quoting, add / import / check DecoNetwork.', 'Customer history panel also shown in Win-back.'],
    touches: [{ t: 'site', n: 'winback.js, newcustomers.js, quotes.js' }, { t: 'database', n: 'winback_emails, nc_* tables, rebuild_customer_reorder_metrics (sql/winback_email_2026-10-22.sql, new_customers_2026-10-23.sql, customer_reorder_rebuild_2026-10-23.sql)' }, { t: 'n8n', n: 'Sync customer reorder metrics (nightly, dxAUfb7RiwDPGk7X); Quote email reply check' }],
    watch: 'Win-back lists look stale: check the nightly sync ran at 03:00. Replies not detected: check the reply-check workflow (every 30 minutes).'
  },
  {
    v: 'v19', date: '2026-10-22', status: 'live', pr: 23, areas: ['Quotes', 'DAN'],
    title: 'Quote emails: quote link box, tone rewrite, footer and banner',
    summary: 'More control over the email, and a proper company footer.',
    changes: ['Optional Quote link box (internal DecoNetwork links are refused).', 'If the text was edited by hand, a tone button asks DAN to rewrite it in that tone, with Undo.', 'One generic footer for everyone, and the atam banner.'],
    touches: [{ t: 'site', n: 'quotes.js, assets/email-banner.jpg' }, { t: 'worker', n: 'worker/danbotv2.js (v15, /rewrite route)' }, { t: 'n8n', n: 'Quote email send (Microsoft 365), node Build Email HTML' }],
    watch: 'Emails missing the banner or footer: check the n8n send workflow. Rewrite button failing: check the worker version.'
  },
  {
    v: 'v18', date: '2026-10-21', status: 'live', pr: 20, areas: ['Quotes'],
    title: 'Friendlier quote email wording, and win rate change',
    summary: 'Warmer wording for chase emails and a win-rate change figure for each person and the team.',
    changes: ['Friendlier wording for the quote emails.', 'Sales team tab shows win rate change for Week, Month and Year against the period before.'],
    touches: [{ t: 'site', n: 'quotes.js' }],
    watch: 'Odd win-rate numbers: Year shows a dash until there is a year of data; a dashed chip means fewer than 5 decided quotes.'
  },
  {
    v: 'v17', date: '2026-10-21', status: 'live', pr: 19, areas: ['Quotes', 'DAN', 'Database'],
    title: 'Quote emails switched on',
    summary: 'Sending chase emails from the quote card is live, from each person\'s own mailbox.',
    changes: ['Sender mailboxes set up (each account manager, plus Customer Support as fallback). Chris Spooner\'s mailbox added.', 'Tone buttons in the email box. Sending switched on. DAN email sending switched on.', 'Also covers pull requests 18 and 21.'],
    touches: [{ t: 'site', n: 'quotes.js' }, { t: 'database', n: 'mail_senders (sql/mail_senders_seed_2026-10-21.sql, mail_senders_add_chris_2026-10-21.sql)' }, { t: 'n8n', n: 'Quote email send (Microsoft 365)' }, { t: 'worker', n: 'DAN_EMAIL_SENDING = on' }],
    watch: 'Emails not sending: check the n8n send workflow, the mailbox is on IT\'s allowed list, and EMAIL_SENDING_ENABLED in quotes.js. To stop sending: set it to false and unpublish the workflow.'
  },
  {
    v: 'v16', date: '2026-10-20', status: 'live', pr: 17, areas: ['Security', 'Database'],
    title: 'Row level security on ten more tables',
    summary: 'The Xero sales and customer account tables are now locked so only signed-in users can read them.',
    changes: ['Row level security switched on for the last ten tables. n8n writes with the service role.'],
    touches: [{ t: 'database', n: 'sql/security_rls_xero_customer_tables_2026-10-20.sql' }],
    watch: 'Customer spend or Xero sales data suddenly empty or a sync failing with permission errors: start here.'
  },
  {
    v: 'v15', date: '2026-10-20', status: 'live', pr: 16, areas: ['Quotes', 'Database'],
    title: 'Customer history panel beside the quote drawer',
    summary: 'Opening a quote shows the customer\'s history to the left (wide screens).',
    changes: ['Order history, spend trends, money owed, last order lines, what they buy, other quotes and Win-back records.'],
    touches: [{ t: 'site', n: 'quotes.js' }, { t: 'database', n: 'quote_customer_history (sql/quote_customer_history.sql)' }],
    watch: 'History panel blank: check the database function and that the customer name matches.'
  },
  {
    v: 'v14', date: '2026-10-20', status: 'live', pr: 15, areas: ['DAN'],
    title: 'DAN v14: write and send quote chase emails',
    summary: 'DAN can write and send quote chase emails, in chat and by phone.',
    changes: ['New prepare / send quote email tools, on only when DAN_EMAIL_SENDING is on.'],
    touches: [{ t: 'worker', n: 'worker/danbotv2.js (pasted into Cloudflare by hand)' }],
    watch: 'DAN sending unexpected emails: set DAN_EMAIL_SENDING to off in Cloudflare.'
  },
  {
    v: 'v13', date: '2026-10-20', status: 'live', pr: 14, areas: ['Quotes', 'n8n', 'Database'],
    title: 'Email chasing from the quote card: built',
    summary: 'The email box on quote cards and the n8n workflows behind it (switched on later, in v17).',
    changes: ['Email customer button, reply countdown, sending through Microsoft 365, reply check every 30 minutes.', 'Also covers pull request 13.'],
    touches: [{ t: 'site', n: 'quotes.js' }, { t: 'database', n: 'sql/quote_email_chase.sql' }, { t: 'n8n', n: 'Quote email send (Microsoft 365); Quote email reply check' }, { t: 'docs', n: 'n8n/quote-email-send.md' }],
    watch: 'Quote emails stuck as queued: check the n8n send workflow.'
  },
  {
    v: 'v12', date: '2026-10-16', status: 'live', pr: 12, areas: ['Invoices'],
    title: 'Purchase Order Review: compact "other invoices in same email" box',
    summary: 'A tidier box when one email carried several invoices.',
    changes: ['Smaller box for the other documents in the same email.'],
    touches: [{ t: 'site', n: 'pending_invoices_review.js' }],
    watch: 'Staff confused about whether the other items are attachments or separate invoices: see the planned wording fix.'
  },
  {
    v: 'v11', date: '2026-10-16', status: 'live', pr: 11, areas: ['Site'],
    title: 'Customer Spend: treemap with grouped small customers',
    summary: 'The Customer Spend view groups small customers, with a threshold dropdown including £3,000.',
    changes: ['Treemap with small customers grouped, threshold dropdown, £3,000 option added.', 'Covers pull requests 10 and 11.'],
    touches: [{ t: 'site', n: 'customer_spend.js' }],
    watch: 'Customer Spend looks wrong: it is the only page changed in this version.'
  },
  {
    v: 'v10', date: '2026-10-15', status: 'live', pr: 9, areas: ['Docs'],
    title: 'Handover notes',
    summary: 'Standing notes so a new chat has the background without the history. No site change.',
    changes: ['Handover notes file added to the repository.'],
    touches: [{ t: 'docs', n: 'Handover notes (repository root)' }],
    watch: 'Nothing to break: documentation only.'
  },
  {
    v: 'v9', date: '2026-10-14', status: 'partly', pr: 8, areas: ['DAN', 'Database'],
    title: 'DAN phone line (not finished)',
    summary: 'The VAPI phone side of DAN: inbound calls, a spoken passphrase before actions, and a 07:30 weekday call to Daniel.',
    changes: ['Phone endpoint guarded by a shared key and an approved-numbers list.', 'Still needs a "phone" Supabase user, the Cloudflare settings and Cron Triggers, and one test call.'],
    touches: [{ t: 'worker', n: 'worker/danbotv2.js' }, { t: 'database', n: 'sql/dan_voice.sql (to run once the phone user exists)' }],
    watch: 'Not live yet, so nothing should depend on it.'
  },
  {
    v: 'v8', date: '2026-10-14', status: 'live', pr: 7, areas: ['DAN', 'Database'],
    title: 'DAN v13: a real assistant with sign-in, briefing and alerts',
    summary: 'DAN became a tool-using assistant that reads and acts as the signed-in person.',
    changes: ['Morning briefing, alert list, badge on the robot button.', 'Ask DAN buttons on Sales invoices, Purchase Order Review and Discrepancies.'],
    touches: [{ t: 'worker', n: 'worker/danbotv2.js' }, { t: 'database', n: 'sql/dan_agent.sql' }, { t: 'site', n: 'discrepancies.js, pending_invoices_review.js, sales_invoices_view.js' }],
    watch: 'DAN says it is not signed in or cannot see data: check the sign-in token and row level security.'
  },
  {
    v: 'v7', date: '2026-10-13', status: 'live', pr: 6, areas: ['Win-back', 'Database'],
    title: 'Win-back tab',
    summary: 'Customers past their usual reorder time move from first call to first order, with quotes matched in.',
    changes: ['Stages: Due soon, Needs a call, Contacted waiting, Replied, Quote out, Won back (plus Parked and Lost).'],
    touches: [{ t: 'site', n: 'winback.js' }, { t: 'database', n: 'sql/winback_pipeline.sql' }],
    watch: 'Win-back empty or stale: look at the reorder data refresh (see v20).'
  },
  {
    v: 'v6', date: '2026-10-13', status: 'live', pr: 5, areas: ['Invoices', 'Database'],
    title: 'Fix over-invoiced orders, and Rebuild from DecoNetwork',
    summary: 'Fixed sales invoices that showed too much for edited orders, and added a rebuild button.',
    changes: ['Stale order-line rows from edited DecoNetwork orders are ignored.', 'Rebuild from DecoNetwork button on the Sales invoices card (discards edits and rebuilds the draft).'],
    touches: [{ t: 'site', n: 'sales_invoices_view.js' }, { t: 'database', n: 'sql/fix_stale_sales_order_lines_2026-10-13.sql' }],
    watch: 'A sales invoice with the wrong lines or total: check this fix and the Rebuild button.'
  },
  {
    v: 'v5', date: '2026-10-13', status: 'live', pr: 4, areas: ['Security', 'Site'],
    title: 'Security: escape database text in older tabs',
    summary: 'Text coming from the database is made safe before it is shown, across the older tabs.',
    changes: ['Safe display of database text everywhere it goes into the page.', 'Export libraries pinned with integrity hashes.'],
    touches: [{ t: 'site', n: 'app.js, atamgo-auth.js, discrepancies.js, dispatch.js, overdue.html, payments.js, pending_invoices_review.js, revenue.js, sales_invoices_view.js' }],
    watch: 'A table or card showing odd characters or blank text on an older tab: start here.'
  },
  {
    v: 'v4', date: '2026-10-13', status: 'live', pr: 3, areas: ['Security'],
    title: 'Security: shared webhook token removed (step 3 of 3)',
    summary: 'The old shared password for the n8n buttons is gone; the login is used instead.',
    changes: ['Removed the shared webhook token from the site code.'],
    touches: [{ t: 'site', n: 'atamgo-auth.js' }],
    watch: 'A site button that suddenly says unauthorised: it should be using the signed-in login.'
  },
  {
    v: 'v3', date: '2026-10-13', status: 'live', pr: 2, areas: ['Security', 'Database', 'n8n'],
    title: 'Security lockdown: signed-out users get nothing',
    summary: 'Signed-out users can no longer read any data, and n8n buttons check the login.',
    changes: ['Anonymous access to data removed. The browser sends the signed-in user\'s token.', 'n8n webhooks check the login (Verify Login step). Scripts pinned.'],
    touches: [{ t: 'site', n: 'app.js, atamgo-auth.js, dispatch.js, login.html, overdue.html, index.html and the invoice tabs' }, { t: 'database', n: 'sql/security_hardening_2026-10-13.sql' }, { t: 'n8n', n: 'webhook workflows (Verify Login step)' }],
    watch: 'Anything that worked before 13 Oct and now shows empty, or buttons failing: very likely started here. Check sign-in and the token.'
  },
  {
    v: 'v2', date: '2026-10-13', status: 'live', pr: 1, areas: ['Quotes', 'n8n', 'Database'],
    title: 'Quotes tab',
    summary: 'The sales pipeline of DecoNetwork quotes, with per-salesperson stats.',
    changes: ['Stages: hot, needs chasing, going cold, lost, converted.', 'Data from the quotes table, filled by n8n every 6 hours.'],
    touches: [{ t: 'site', n: 'quotes.js' }, { t: 'database', n: 'sql/quote_tracking.sql' }, { t: 'n8n', n: 'WF7 quotes sync' }],
    watch: 'Quotes tab empty or out of date: check the n8n quotes sync (every 6 hours).'
  },
  {
    v: 'v1', date: '2026-10-12', status: 'live', pr: null, areas: ['Site', 'Invoices'],
    title: 'Baseline: the dashboard as it was before this log began',
    summary: 'Everything built up to 12 October 2026. Not itemised here; the repository history has the detail.',
    changes: ['Purchase Order Review (supplier invoices), Sales invoices view, Customer Spend and the other original tabs.', 'Changes between 16 September and 12 October were small edits to those tabs.'],
    touches: [{ t: 'site', n: 'pending_invoices_review.js, sales_invoices_view.js, customer_spend.js, weekly-targets.js, index.html, styles.css' }],
    watch: 'If something broke before v2, it is in this baseline or in the n8n workflows, which are not tracked here.'
  }
];

window.ATAM_PLANNED = [
  { title: 'Finish the DAN phone line', areas: ['DAN'], detail: 'Create the "phone" Supabase user, run sql/dan_voice.sql, set the Cloudflare settings and Cron Triggers, check the VAPI inbound assistant is "Danbot Live", then one test call to Daniel.' },
  { title: 'Switch supplier invoice intake from Gmail to Microsoft 365', areas: ['Invoices', 'n8n'], detail: 'Publish the new workflows, test with one invoice sent straight to the shared mailbox, ask IT to point the Accounts@ forwarding at it (and stop it going to Gmail), let Gmail finish, then unpublish the Gmail workflow.' },
  { title: 'Replace the old shared token on the invoice webhook', areas: ['Security', 'n8n'], detail: 'The extraction webhook still checks an old shared token that both invoice intake workflows send. Replace it in both places together when Gmail is retired.' },
  { title: 'Guided steps for Quotes and New customers', areas: ['Quotes', 'New customers'], detail: 'The same "Your move" help that Win-back now has, with wording agreed with Daniel and Steph.' },
  { title: 'Outlook diary entries for chase dates', areas: ['Calendar'], detail: 'Needs calendar permission from IT for the ATAM GO Mailer app. Not started.' },
  { title: 'Move secrets out of n8n workflows', areas: ['Security', 'n8n'], detail: 'The DecoNetwork password and the Xero client secret are stored in plain text in several workflows. Create n8n credentials, rewire the workflows, then rotate the secrets.' },
  { title: 'Supabase sign-in hardening', areas: ['Security', 'Access'], detail: 'Turn on leaked-password protection and change Daniel Spooner\'s password.' },
  { title: 'Tidy-ups', areas: ['Database', 'DAN'], detail: 'Run sql/cleanup_old_quote_tracking.sql; check and delete the old "danbot" Cloudflare worker; add retries to the other webhook workflows.' },
  { title: 'Reword the "other invoices in the same email" box', areas: ['Invoices'], detail: 'Steph read it as "1 invoice with attachments" when there were three separate invoices. Reword it to say each is its own invoice.' },
  { title: 'Rejected quotes', areas: ['Quotes'], detail: 'DecoNetwork has a Rejected status but its API data does not show it, so a rejected quote currently just ages to Lost after 30 days.' },
  { title: 'Terms and conditions link in the quote email footer', areas: ['Quotes'], detail: 'Waiting for the standard terms link to be supplied.' }
];
