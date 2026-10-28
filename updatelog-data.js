// The Update log: every change made to ATAM GO, and what is planned. Shown on the Update log tab (updatelog.js).
// HOW TO ADD AN UPDATE (done with every change, in the same pull request):
//   1. Add a new entry at the TOP of ATAM_UPDATES with the next version number (v34, v35...).
//   2. status: 'in_progress' (being worked on; add progress: 0-100 for the bar), 'built' (finished, waiting to go live),
//      'partly' (some parts are live, some wait for a merge or publish), 'live' (working now), 'rolled_back' (undone).
//   3. When something goes live, change its status and add timeTaken (e.g. '2 h 30 m').
//      No time is shown on an entry until one is added.
//      Never delete an entry: the point is to look back.
//   NOTE: the site only changes when a pull request is merged, so an in_progress bar is only visible on the site if a small
//   "started" update was merged first. Otherwise an update appears as built / live when its own pull request is merged.
// Planned work goes in ATAM_PLANNED (no version number until it is built).
window.ATAM_UPDATES = [
  {
    v: 'v36', date: '2026-10-28', status: 'live', pr: 34, timeTaken: '1 h', areas: ['Quotes', 'Database'],
    title: 'Remove old quotes from the Quotes tab',
    summary: 'Old quotes that are never going to happen can now be taken off the list completely, and put back if you change your mind.',
    changes: ['Every quote card (except approved ones) has a small Remove link, and the quote\u2019s side panel has a Remove button.', 'A removed quote disappears from the board, the counts and the Lost / Going cold numbers, and DAN stops seeing it too.', 'Nothing is deleted from DecoNetwork. Removed quotes are listed at the bottom of the Quotes tab with who removed them, and a Put back button brings one back.', 'Approved quotes cannot be removed, so the conversion rate stays honest.'],
    watch: 'If a quote you needed has vanished, open Removed quotes at the bottom of the Quotes tab and press Put back. Quotes removed here can still show in a customer\u2019s history panel.'
  },
  {
    v: 'v35', date: '2026-10-28', status: 'live', pr: 34, timeTaken: '1 h 30 m', areas: ['Update log', 'Database'],
    title: 'Suggest updates and vote on what comes next',
    summary: 'The Update log tab now has a place for the whole team to suggest new updates and rate how important each one is.',
    changes: ['Anyone signed in can add a suggestion with a title, a bit of detail, which part of ATAM GO it is about, and how important it is from 1 (nice to have) to 5 (needed now).', 'Everyone can rate every suggestion from 1 to 5. You get one rating each and can change it or take it back.', 'The list is ranked by points, which is everyone\u2019s ratings added up. Each one also shows the average and how many people rated it.', 'You can take back your own suggestion. Once something is planned, built or turned down, it moves into an Already decided list.'],
    watch: 'If the suggestions will not load or save, the rest of the Update log still works. Tell us what you saw. Changing a suggestion to planned, built or not doing is done by whoever builds the updates, not on the page.'
  },
  {
    v: 'v34', date: '2026-10-28', status: 'live', pr: 33, timeTaken: '9 h', areas: ['Site'],
    title: 'Dark glass look and smoother motion',
    summary: 'The whole dashboard now has frosted dark glass cards over a softly moving glow, and everything moves more smoothly.',
    changes: ['Cards, the side menu and the top bar are frosted glass, and a soft light follows your cursor across them.', 'Changing tab blurs and fades the old page out and floats the new cards up one after another.', 'A glass highlight glides between the menu tabs instead of jumping.', 'The big numbers count up to their value, and charts draw in with smoother curves.', 'The old tilting 3D cards and orange dots are switched off so they do not clash.'],
    watch: 'If anything looks wrong or slow, tell us which tab. It can be switched off for one browser by running localStorage.setItem(\'atam-glass\',\'off\') in the console, or removed by taking out the two glass lines in index.html.'
  },
  {
    v: 'v33', date: '2026-10-27', status: 'live', pr: null, areas: ['Stock', 'Database'],
    title: 'Supplier costs brought up to date (stock values)',
    summary: 'The costs behind the stock value were stuck at 3 July. They now follow the latest purchase orders and refresh every 3 hours.',
    changes: ['About 220 items took a newer price and over 1,000 items that had no cost on file now have one.', 'Total stock value moved from about \u00a38,870 to about \u00a39,105. Items still showing no cost fell from 179 to 154; those have never been on a purchase order.', 'A copy of the old cost list was kept in case anything needs to be compared.'],
    watch: 'If a stock value looks wrong, check the latest purchase order price for that item. If costs stop moving, check the 3-hourly cost refresh is running.'
  },
  {
    v: 'v32', date: '2026-10-27', status: 'live', pr: null, areas: ['Stock', 'Database'],
    title: 'Monthly purchasing figures repaired (Projections)',
    summary: 'The monthly purchase spend behind the Projections page had stopped updating in July. It now updates every 3 hours again.',
    changes: ['August, September and October added, and July completed, from the purchase orders already held. The older months were checked and are unchanged.', 'The next-month projection and the Projections page now use the latest months.', 'Daily stock value history still has a gap from 10 July to 30 August; that cannot be rebuilt because DecoNetwork only gives us current stock.'],
    watch: 'If Projections stops moving again, check the 3-hourly purchase order refresh is running.'
  },
  {
    v: 'v31', date: '2026-10-27', status: 'live', pr: null, areas: ['Stock', 'Site'],
    title: 'New Stock tab (a copy of the old stock page, inside ATAM GO)',
    summary: 'The stock ledger, value calendar and projections, rebuilt inside ATAM GO after the separate ATAM Stock page stopped working.',
    changes: ['Same layout as the old page: key numbers, critically low, working stock and missing cost lists, product cards with a colour by size grid, and category tabs.', 'The Value Calendar tab shows the stock value for every day recorded, and clicking a day shows its breakdown.', 'The Projections view (Projections button, top right) has the slider, the charts and the monthly table.', 'Everything uses the normal sign-in and refreshes from DecoNetwork every 3 hours.'],
    watch: 'If the Stock tab is empty, check the DecoNetwork stock refresh is still running. The old standalone page is no longer needed.'
  },
  {
    v: 'v30', date: '2026-10-27', status: 'live', pr: null, areas: ['Calendar'],
    title: 'Calendar: everyone on the team in the people list',
    summary: 'The people dropdown on the Calendar now lists the whole team, not just people with something due.',
    changes: ['Daniel, Bethan, Emma, Julie, Christine and Francesca can all be picked, even when their day is clear.'],
    watch: 'Only the Calendar tab changed.'
  },
  {
    v: 'v29', date: '2026-10-27', status: 'live', pr: null, areas: ['Calendar'],
    title: 'Calendar now opens as a proper month calendar',
    summary: 'The Calendar tab opens on a full month grid, like a wall calendar, instead of a list.',
    changes: ['Month grid with the weekday headings, today circled, weekends shaded, and each day showing who or what is due in colour.', 'Click any day to see its list underneath, with an Open button for each item. Day and Week views are still there.', 'Colour key under the calendar, and small dots on phones.'],
    watch: 'Only the Calendar tab changed.'
  },
  {
    v: 'v28', date: '2026-10-27', status: 'live', pr: null, areas: ['Site'],
    title: 'Update log: simpler view',
    summary: 'Each update now shows just what changed and what to check if it goes wrong.',
    changes: ['Removed the technical details from each entry so the page is quicker to read.'],
    watch: 'Only the Update log tab changed.'
  },
  {
    v: 'v27', date: '2026-10-26', status: 'live', pr: 26, areas: ['Site'],
    title: 'Update log tab',
    summary: 'This page. A running record of every update, with what it touched and what to check if something goes wrong.',
    changes: ['New Update log tab with a timeline of every version, search, filters and a "something broke" finder.', 'Each update can show a progress bar (in progress, finished and waiting, or completed) and the time taken.', 'Every future update gets an entry here as part of the same change.'],
    watch: 'If the Update log tab does not appear, or the menu looks wrong after this one: it is the only page that changed.'
  },
  {
    v: 'v26', date: '2026-10-26', status: 'live', pr: 26, areas: ['Win-back'],
    title: 'Win-back guided steps: "How it works" and "Your move"',
    summary: 'Plain step-by-step help inside Win-back, so a new starter knows what to do next.',
    changes: ['A "How Win-back works" box at the top of the page explains each stage, what it means and what to do.', 'Every customer opens with a "Your move" box for their stage, with buttons (Spoke to them, Left a message, No answer, Email them).', 'The buttons only fill in the log form. Nothing is saved until Save contact is pressed.', 'The wording is a first draft to be checked with Daniel and Steph.'],
    watch: 'If the Win-back drawer looks broken or a customer will not open, check this change and v24 first (both edited the drawer).'
  },
  {
    v: 'v25', date: '2026-10-26', status: 'live', pr: 26, areas: ['Calendar', 'Database'],
    title: 'Calendar tab',
    summary: 'One calendar of everything the team has to chase, by day, week or month, for everyone or one person.',
    changes: ['Shows Win-back chase dates, quote / Win-back / New customer emails still waiting for a reply after 3 days, and New customer follow-ups.', 'Late items show first on Today. Read-only: Open in... jumps to the item.', 'Live: the read-only database view and the tab.'],
    watch: 'Calendar empty or wrong: check the calendar_actions view, and that emails are being marked sent / replied (see v17 and v20).'
  },
  {
    v: 'v24', date: '2026-10-26', status: 'partly', pr: 26, areas: ['Win-back', 'Database'],
    title: 'Win-back: change the owner, and a morning email to each owner',
    summary: 'Owners can be changed by hand, and each owner gets a weekday 7:45 email with their own list.',
    changes: ['Owner dropdown in the Win-back customer drawer. A hand-picked owner beats the automatic one; "Back to automatic" undoes it.', 'Weekday 7:45 (UK) email per owner: customers who just became due, and contacts whose chase date has arrived. Sent from support@. No-owner customers go to Daniel.', 'Owner dropdown and database parts are live. The morning email still needs switching on.'],
    watch: 'Win-back board shows the wrong owner: check winback_owner_override. Emails not arriving: check the morning email has been switched on.'
  },
  {
    v: 'v23', date: '2026-10-26', status: 'built', pr: 26, areas: ['Invoices'],
    title: 'Supplier invoice intake from Microsoft 365 (built, not switched on)',
    summary: 'Two automations to read supplier invoices from the new InvoicePOProcessing@ shared mailbox instead of Gmail.',
    changes: ['Intake automation: every 5 minutes, sends PDFs into the existing extraction pipeline and moves finished emails to a Processed folder.', 'Stuck-email alert: emails Daniel and Oliver about anything left in the Inbox over a day.', 'Both are unpublished. The Gmail workflow is untouched and still the live one.', 'Not yet tested against the real mailbox.'],
    watch: 'When switched on: duplicate invoices mean both Gmail and Microsoft intakes got the same email. Missing invoices: check the Inbox of the shared mailbox.'
  },
  {
    v: 'v22', date: '2026-10-26', status: 'live', pr: null, areas: ['Access'],
    title: 'New login for Julie Sheehan',
    summary: 'Julie Sheehan can now sign in to ATAM GO.',
    changes: ['Account created in Supabase with a temporary password, and given the same access as the rest of the team.'],
    watch: 'If Julie cannot sign in, reset her password in Supabase (Authentication, Users).'
  },
  {
    v: 'v21', date: '2026-10-23', status: 'live', pr: 25, areas: ['DAN'],
    title: 'DAN v16: knows New customers and can email new and win-back customers',
    summary: 'DAN reads the New customers list and can prepare and send emails to new and overdue customers.',
    changes: ['New customers section in the morning briefing and alerts.', 'DAN can email overdue Win-back and New customers (only when email sending is on, and only to the address on file by phone).'],
    watch: 'DAN not answering or odd answers after this: check which worker version is pasted into Cloudflare.'
  },
  {
    v: 'v20', date: '2026-10-23', status: 'live', pr: 24, areas: ['Win-back', 'New customers', 'Database'],
    title: 'Win-back email, fixed reorder data, and the New customers tab',
    summary: 'Email from Win-back cards, a nightly refresh of the reorder data that had stopped in June, and a new tab for nurturing new customers.',
    changes: ['Win-back cards can email the customer, with reply tracking that moves the card to Replied.', 'The reorder table (customer_reorder_metrics) had not refreshed since 30 June 2026. It now rebuilds every night at 03:00 from the last 60 days of DecoNetwork orders.', 'New customers tab: stages, checklist, "what they want" form, summary for quoting, add / import / check DecoNetwork.', 'Customer history panel also shown in Win-back.'],
    watch: 'Win-back lists look stale: check the nightly sync ran at 03:00. Replies not detected: check the reply checking (every 30 minutes).'
  },
  {
    v: 'v19', date: '2026-10-22', status: 'live', pr: 23, areas: ['Quotes', 'DAN'],
    title: 'Quote emails: quote link box, tone rewrite, footer and banner',
    summary: 'More control over the email, and a proper company footer.',
    changes: ['Optional Quote link box (internal DecoNetwork links are refused).', 'If the text was edited by hand, a tone button asks DAN to rewrite it in that tone, with Undo.', 'One generic footer for everyone, and the atam banner.'],
    watch: 'Emails missing the banner or footer: check the email sending. Rewrite button failing: check the worker version.'
  },
  {
    v: 'v18', date: '2026-10-21', status: 'live', pr: 20, areas: ['Quotes'],
    title: 'Friendlier quote email wording, and win rate change',
    summary: 'Warmer wording for chase emails and a win-rate change figure for each person and the team.',
    changes: ['Friendlier wording for the quote emails.', 'Sales team tab shows win rate change for Week, Month and Year against the period before.'],
    watch: 'Odd win-rate numbers: Year shows a dash until there is a year of data; a dashed chip means fewer than 5 decided quotes.'
  },
  {
    v: 'v17', date: '2026-10-21', status: 'live', pr: 19, areas: ['Quotes', 'DAN', 'Database'],
    title: 'Quote emails switched on',
    summary: 'Sending chase emails from the quote card is live, from each person\'s own mailbox.',
    changes: ['Sender mailboxes set up (each account manager, plus Customer Support as fallback). Chris Spooner\'s mailbox added.', 'Tone buttons in the email box. Sending switched on. DAN email sending switched on.', 'Also covers pull requests 18 and 21.'],
    watch: 'Emails not sending: check the email sending, the mailbox is on IT\'s allowed list, and EMAIL_SENDING_ENABLED in quotes.js. To stop sending: set it to false and switch off the sending automation.'
  },
  {
    v: 'v16', date: '2026-10-20', status: 'live', pr: 17, areas: ['Security', 'Database'],
    title: 'Row level security on ten more tables',
    summary: 'The Xero sales and customer account tables are now locked so only signed-in users can read them.',
    changes: ['Row level security switched on for the last ten tables. The automations write with a separate, restricted account.'],
    watch: 'Customer spend or Xero sales data suddenly empty or a sync failing with permission errors: start here.'
  },
  {
    v: 'v15', date: '2026-10-20', status: 'live', pr: 16, areas: ['Quotes', 'Database'],
    title: 'Customer history panel beside the quote drawer',
    summary: 'Opening a quote shows the customer\'s history to the left (wide screens).',
    changes: ['Order history, spend trends, money owed, last order lines, what they buy, other quotes and Win-back records.'],
    watch: 'History panel blank: check the database function and that the customer name matches.'
  },
  {
    v: 'v14', date: '2026-10-20', status: 'live', pr: 15, areas: ['DAN'],
    title: 'DAN v14: write and send quote chase emails',
    summary: 'DAN can write and send quote chase emails, in chat and by phone.',
    changes: ['New prepare / send quote email tools, on only when DAN_EMAIL_SENDING is on.'],
    watch: 'DAN sending unexpected emails: set DAN_EMAIL_SENDING to off in Cloudflare.'
  },
  {
    v: 'v13', date: '2026-10-20', status: 'live', pr: 14, areas: ['Quotes', 'Database'],
    title: 'Email chasing from the quote card: built',
    summary: 'The email box on quote cards and the automations behind it (switched on later, in v17).',
    changes: ['Email customer button, reply countdown, sending through Microsoft 365, reply check every 30 minutes.', 'Also covers pull request 13.'],
    watch: 'Quote emails stuck as queued: check the email sending.'
  },
  {
    v: 'v12', date: '2026-10-16', status: 'live', pr: 12, areas: ['Invoices'],
    title: 'Purchase Order Review: compact "other invoices in same email" box',
    summary: 'A tidier box when one email carried several invoices.',
    changes: ['Smaller box for the other documents in the same email.'],
    watch: 'Staff confused about whether the other items are attachments or separate invoices: see the planned wording fix.'
  },
  {
    v: 'v11', date: '2026-10-16', status: 'live', pr: 11, areas: ['Site'],
    title: 'Customer Spend: treemap with grouped small customers',
    summary: 'The Customer Spend view groups small customers, with a threshold dropdown including £3,000.',
    changes: ['Treemap with small customers grouped, threshold dropdown, £3,000 option added.', 'Covers pull requests 10 and 11.'],
    watch: 'Customer Spend looks wrong: it is the only page changed in this version.'
  },
  {
    v: 'v10', date: '2026-10-15', status: 'live', pr: 9, areas: ['Docs'],
    title: 'Handover notes',
    summary: 'Standing notes so a new chat has the background without the history. No site change.',
    changes: ['Handover notes file added to the repository.'],
    watch: 'Nothing to break: documentation only.'
  },
  {
    v: 'v9', date: '2026-10-14', status: 'partly', pr: 8, areas: ['DAN', 'Database'],
    title: 'DAN phone line (not finished)',
    summary: 'The VAPI phone side of DAN: inbound calls, a spoken passphrase before actions, and a 07:30 weekday call to Daniel.',
    changes: ['Phone endpoint guarded by a shared key and an approved-numbers list.', 'Still needs a "phone" Supabase user, the Cloudflare settings and Cron Triggers, and one test call.'],
    watch: 'Not live yet, so nothing should depend on it.'
  },
  {
    v: 'v8', date: '2026-10-14', status: 'live', pr: 7, areas: ['DAN', 'Database'],
    title: 'DAN v13: a real assistant with sign-in, briefing and alerts',
    summary: 'DAN became a tool-using assistant that reads and acts as the signed-in person.',
    changes: ['Morning briefing, alert list, badge on the robot button.', 'Ask DAN buttons on Sales invoices, Purchase Order Review and Discrepancies.'],
    watch: 'DAN says it is not signed in or cannot see data: check the sign-in token and row level security.'
  },
  {
    v: 'v7', date: '2026-10-13', status: 'live', pr: 6, areas: ['Win-back', 'Database'],
    title: 'Win-back tab',
    summary: 'Customers past their usual reorder time move from first call to first order, with quotes matched in.',
    changes: ['Stages: Due soon, Needs a call, Contacted waiting, Replied, Quote out, Won back (plus Parked and Lost).'],
    watch: 'Win-back empty or stale: look at the reorder data refresh (see v20).'
  },
  {
    v: 'v6', date: '2026-10-13', status: 'live', pr: 5, areas: ['Invoices', 'Database'],
    title: 'Fix over-invoiced orders, and Rebuild from DecoNetwork',
    summary: 'Fixed sales invoices that showed too much for edited orders, and added a rebuild button.',
    changes: ['Stale order-line rows from edited DecoNetwork orders are ignored.', 'Rebuild from DecoNetwork button on the Sales invoices card (discards edits and rebuilds the draft).'],
    watch: 'A sales invoice with the wrong lines or total: check this fix and the Rebuild button.'
  },
  {
    v: 'v5', date: '2026-10-13', status: 'live', pr: 4, areas: ['Security', 'Site'],
    title: 'Security: escape database text in older tabs',
    summary: 'Text coming from the database is made safe before it is shown, across the older tabs.',
    changes: ['Safe display of database text everywhere it goes into the page.', 'Export libraries pinned with integrity hashes.'],
    watch: 'A table or card showing odd characters or blank text on an older tab: start here.'
  },
  {
    v: 'v4', date: '2026-10-13', status: 'live', pr: 3, areas: ['Security'],
    title: 'Security: shared webhook token removed (step 3 of 3)',
    summary: 'The old shared password for the dashboard buttons is gone; the login is used instead.',
    changes: ['Removed the shared webhook token from the site code.'],
    watch: 'A site button that suddenly says unauthorised: it should be using the signed-in login.'
  },
  {
    v: 'v3', date: '2026-10-13', status: 'live', pr: 2, areas: ['Security', 'Database'],
    title: 'Security lockdown: signed-out users get nothing',
    summary: 'Signed-out users can no longer read any data, and the dashboard buttons check the login.',
    changes: ['Anonymous access to data removed. The browser sends the signed-in user\'s token.', 'The automations behind the buttons check the login. Scripts pinned.'],
    watch: 'Anything that worked before 13 Oct and now shows empty, or buttons failing: very likely started here. Check sign-in and the token.'
  },
  {
    v: 'v2', date: '2026-10-13', status: 'live', pr: 1, areas: ['Quotes', 'Database'],
    title: 'Quotes tab',
    summary: 'The sales pipeline of DecoNetwork quotes, with per-salesperson stats.',
    changes: ['Stages: hot, needs chasing, going cold, lost, converted.', 'Data from the quotes table, filled automatically every 6 hours.'],
    watch: 'Quotes tab empty or out of date: check the quotes sync (every 6 hours).'
  },
  {
    v: 'v1', date: '2026-10-12', status: 'live', pr: null, areas: ['Site', 'Invoices'],
    title: 'Baseline: the dashboard as it was before this log began',
    summary: 'Everything built up to 12 October 2026. Not itemised here; the repository history has the detail.',
    changes: ['Purchase Order Review (supplier invoices), Sales invoices view, Customer Spend and the other original tabs.', 'Changes between 16 September and 12 October were small edits to those tabs.'],
    watch: 'If something broke before v2, it is in this baseline or in the automations, which are not tracked here.'
  }
];

window.ATAM_PLANNED = [
  { title: 'Finish the DAN phone line', areas: ['DAN'], detail: 'Create the "phone" Supabase user, run sql/dan_voice.sql, set the Cloudflare settings and Cron Triggers, check the VAPI inbound assistant is "Danbot Live", then one test call to Daniel.' },
  { title: 'Switch supplier invoice intake from Gmail to Microsoft 365', areas: ['Invoices'], detail: 'Switch on the new automations, test with one invoice sent straight to the shared mailbox, ask IT to point the Accounts@ forwarding at it (and stop it going to Gmail), let Gmail finish, then unpublish the Gmail workflow.' },
  { title: 'Replace the old shared token on the invoice webhook', areas: ['Security'], detail: 'The extraction webhook still checks an old shared token that both invoice intake automations send. Replace it in both places together when Gmail is retired.' },
  { title: 'Guided steps for Quotes and New customers', areas: ['Quotes', 'New customers'], detail: 'The same "Your move" help that Win-back now has, with wording agreed with Daniel and Steph.' },
  { title: 'Outlook diary entries for chase dates', areas: ['Calendar'], detail: 'Needs calendar permission from IT for the ATAM GO Mailer app. Not started.' },
  { title: 'Move stored secrets out of the automations', areas: ['Security'], detail: 'The DecoNetwork password and the Xero client secret are stored in plain text in several automations. Create proper credentials, rewire the automations, then rotate the secrets.' },
  { title: 'Supabase sign-in hardening', areas: ['Security', 'Access'], detail: 'Turn on leaked-password protection and change Daniel Spooner\'s password.' },
  { title: 'Tidy-ups', areas: ['Database', 'DAN'], detail: 'Run sql/cleanup_old_quote_tracking.sql; check and delete the old "danbot" Cloudflare worker; add retries to the other automations.' },
  { title: 'Reword the "other invoices in the same email" box', areas: ['Invoices'], detail: 'Steph read it as "1 invoice with attachments" when there were three separate invoices. Reword it to say each is its own invoice.' },
  { title: 'Rejected quotes', areas: ['Quotes'], detail: 'DecoNetwork has a Rejected status but its API data does not show it, so a rejected quote currently just ages to Lost after 30 days.' },
  { title: 'Terms and conditions link in the quote email footer', areas: ['Quotes'], detail: 'Waiting for the standard terms link to be supplied.' }
];
