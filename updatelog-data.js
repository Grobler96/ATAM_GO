// The Update log: every change made to ATAM GO, and what is planned. Shown on the Update log tab (updatelog.js).
// HOW TO ADD AN UPDATE (done with every change, in the same pull request):
//   1. Add a new entry at the TOP of ATAM_UPDATES with the next version number (v43, v44...).
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
    v: 'v51', date: '2026-10-30', status: 'built', areas: ['Site'],
    title: 'Overview numbers fixed, plus graphs, change figures and a late-orders badge',
    summary: 'The Overview totals are now complete for busy months, the six Overview cards show a graph and how they compare with last week or last month, and the Dispatch button shows how many orders are late.',
    changes: ['Fixed: the database only hands back 1,000 records at a time, and this month already has more than that, so the Overview totals could stop counting part-way. It now reads all of them (and reads them once instead of five times, so it should also load a little quicker).', 'Fixed: after switching dates (for example Month to Today) a card could stay stuck on the old number. The cards now always end on the right figure.', 'The six Overview cards now show a small graph of the figure day by day for the dates you picked, and a change figure such as \u201c\u2193 3% vs last week\u201d. This week is compared with the same days last week, this month with the same days of last month, and a single day with the same day last week. The graph needs at least two days, and the change figure is left out if there is nothing to compare with.', 'Other pages no longer show an empty dash under their cards.', 'The Dispatch button now has a red number for late or at-risk orders (it shows 50+ at 50 or more, since the page loads the 50 most urgent).', 'Removed the extra red dot on the DAN button. It was always there, and DAN already has its own badge for real alerts.', 'Left out on purpose: a red count on the Customers button (it would permanently say 99+) and the pulsing border on the At Risk card (it would pulse all the time).'],
    watch: 'If a total on the Overview looks different from before, that is the fix: it was previously missing records on busy months. If a change figure looks odd, hover over it to see the two numbers it compares. If a card still shows the wrong number after changing dates, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and tell Oliver.'
  },
  {
    v: 'v50', date: '2026-10-30', status: 'live', pr: 47, timeTaken: '45 m', areas: ['Site'],
    title: 'Tidier header across the top of the dashboard',
    summary: 'The strips across the top of every page have been tidied into one clean header that matches the rest of the dashboard, and the animated heartbeat line has been removed.',
    changes: ['The four live numbers (Decorated, Due Today, Late / At Risk, Ready to Ship) are now larger tiles instead of a thin strip of tiny text.', 'They now actually show the numbers. Before, they always showed dashes because of a fault that stopped them reading the page\u2019s data.', 'The first tile now says which dates it covers (Decorated This Week, Today and so on) because it follows the date buttons, rather than always saying Today. Late and Ready to Ship show 50+ when there are 50 or more, as the page only loads the 50 most urgent.', 'The heartbeat line is gone. A small Live chip with the time sits at the right of the tiles instead.', 'Today, Yesterday, This Week, This Month and Custom are now one neat control rather than five separate buttons, lined up with the filters and Refresh.', 'The ATAM WORKWEAR title now has a slow light sweep across the letters and a softly glowing bar beside it. It stays still for anyone whose device is set to reduce motion.', 'Works on phones too: the tiles go two across and the date control scrolls sideways.'],
    watch: 'If the top of the page looks unchanged or odd, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac). The filters work as before. If a tile still shows a dash after the page has finished loading, tell Oliver which one.'
  },
  {
    v: 'v49', date: '2026-10-30', status: 'live', pr: 46, timeTaken: '30 m', areas: ['Account managers'],
    title: 'Account managers tab put back to how it was before the 3D office',
    summary: 'The 3D office has been taken off the Account managers tab because the page was not loading properly and was buggy. The tab is back to the cards and the account list.',
    changes: ['Everything else on the tab is the same as before: the manager cards, the account drawers, changing who owns an account, and the revenue, quote and margin figures.', 'Nothing about who owns which account has changed or been lost.'],
    watch: 'If the tab still does not load, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and tell Oliver what you see.'
  },
  {
    v: 'v48', date: '2026-10-30', status: 'live', pr: 45, timeTaken: '1 h', areas: ['Quotes', 'Win-back'],
    title: 'Customer history chart shows the two years in different colours',
    summary: 'The Spend by month chart in the customer history panel (Quotes and Win-back) now shows the last 12 months in bright blue and the 12 before in grey, so you can tell the years apart.',
    changes: ['Same two colours as the Account managers chart, with a small key under it.', 'The first month and each January now show the year.'],
    watch: 'If the chart is still all one colour, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac).'
  },
  {
    v: 'v47', date: '2026-10-30', status: 'live', pr: 44, timeTaken: '4 h 30 m', areas: ['Quotes', 'Database'],
    title: 'Expired quotes tab and Re-ignite button',
    summary: 'The Quotes tab now has an Expired tab listing quotes that went quiet for 30 days, with a Re-ignite button, so a customer who comes back late can be picked up from ATAM GO.',
    changes: ['New Expired tab on Quotes: quotes quiet for 30 days that were never approved or cancelled, newest first, with who quoted them. A flag shows when the customer wrote last and nobody answered.', 'Re-ignite puts the quote back in the Pipeline as Hot, restarts its 30 day clock, shows who re-ignited it and when, and opens the quote in DecoNetwork. Undo puts it back to Expired.', 'DecoNetwork cannot be changed from ATAM GO, so the quote still has to be reopened there by hand. Re-ignite takes you straight to it.', 'You can email the customer from an expired quote, with wording that offers to refresh it (no prices or dates promised). Sending also puts the quote back in the Pipeline.', 'Everyone signed in can use it. Cancelled quotes are not listed.'],
    watch: 'If a quote you re-ignited is back in Expired after a month, it simply went quiet again for 30 days. If the customer link in a re-ignite email does not work, the quote was not reopened in DecoNetwork first.'
  },
  {
    v: 'v46', date: '2026-10-29', status: 'rolled_back', pr: null, areas: ['Account managers'],
    title: '3D office on the Account managers tab',
    summary: 'The Account managers tab now opens on a little 3D office with one person at a desk for each account manager.',
    changes: ['Click a person to open them, the same as clicking their card. Hover over one to see their revenue, accounts and open quotes. Drag to turn the office around.', 'The meeting table in the middle has a glowing bar for each person showing their revenue, and the screen on the wall shows the total for the period you have chosen.', 'Accounts with no owner sit at an empty desk called Unassigned.', 'The cards and the account table are unchanged underneath, and still work if the 3D view cannot load on someone\u2019s device.'],
    watch: 'Taken out again in v49 because the tab would not load properly and was buggy.'
  },
  {
    v: 'v45', date: '2026-10-29', status: 'live', pr: null, areas: ['Update log'],
    title: 'Copy details button removed from the Update log',
    summary: 'The Copy details button on each update card has been taken away.',
    changes: ['Opening an update still shows what changed and what to check if something goes wrong. Only the button that copied that text to the clipboard is gone.'],
    watch: 'Nothing else should be affected. If you miss it, say and it can come back.'
  },
  {
    v: 'v44', date: '2026-10-29', status: 'live', pr: 41, areas: ['Invoices'],
    title: 'Stopped an edited order being invoiced twice',
    summary: 'Order 636616 was invoiced twice for the same 10 vests. The cause is fixed so it cannot happen again this way.',
    changes: ['When an order is edited in DecoNetwork after it has been invoiced, an item can come back with a new internal number. The system then thought it had not been invoiced and billed it again. It now remembers what was invoiced for the same product, size and colour even when that number changes.', 'Every posted and approved sales invoice was checked for the same problem. Only order 636616 was affected: invoice 636616-2 (\u00a390.72) repeats the 10 Large already on 636616. The extra draft needs deleting in Xero by hand.', 'Nothing else changed: the list of orders waiting to be invoiced is identical before and after.'],
    watch: 'If a genuine second delivery of the same size on an order is not offered for invoicing, tell Oliver. Edited orders are the thing to check first.'
  },
  {
    v: 'v43', date: '2026-10-29', status: 'live', pr: 41, areas: ['Actions', 'Update log'], timeTaken: '7 h',
    title: 'Actions tab buttons connected, and an automation health check',
    summary: 'Every button on the Actions tab now does something, there are four new ones, and the Update log has a health check that shows whether the automations are running properly, with a Report to Oliver button.',
    changes: [
      'Send Daily Summary now emails the production summary to whoever pressed it. The nightly 11pm email to Daniel had quietly stopped on 13 October when data was locked down; it is switched off on purpose and is not sent to Daniel.',
      'Recount Selected Range now picks up any production records missed in the dates chosen on the dashboard (up to 31 days back). It only adds missing records and runs in the background.',
      'Send Manager Alert emails each account manager their own urgent orders: due today, due tomorrow and overdue by up to a week, plus orders ready to ship. Older overdue orders are left out because many of them look stale.',
      'The Ready to ship and At risk buttons on the Orders page now send the same style of email.',
      'New buttons: Send Me My Win-back List, Refresh Quotes Now, Refresh Xero Sales Now and Check Invoice Mailbox Now.',
      'New Automation health box at the top of the Update log: a score out of 100, which automations have failed in the last day, data that has stopped updating, and the latest failures. A Report to Oliver button emails Oliver the same picture and who pressed it.'
    ],
    watch: 'If a button says it worked but no email arrives, check the spam folder first. The health check only counts failures from 29 October onwards, so a quiet score on the first day does not yet prove everything is fine. Push-style buttons were not tested from a real signed-in session before release.'
  },
  {
    v: 'v42', date: '2026-10-29', status: 'live', pr: 42, timeTaken: '3 h 30 m', areas: ['Account managers', 'Database'],
    title: 'New Account managers tab',
    summary: 'A new tab shows each account manager as a card. Open one to see their accounts, revenue, open quotes and an indicative margin, and open any account to choose who owns it.',
    changes: ['Every customer account has one owner. Whoever owns it gets all of its revenue and all of its quotes, even if someone else keyed the quotes in. Daniel can own an account that Bethan quotes for.', 'Revenue uses the same figures and account groupings as the Customers tab (before VAT, credit notes taken off), for the last 12 months or this financial year, against the period before.', 'Quotes show on each account and on each person, with the same stages as the Quotes tab, who keyed each one in, and the win rate.', 'Owners can be set one account at a time, or several at once by ticking them. Each change is recorded with who made it and when, and an account can be put back to automatic.', 'Until someone confirms an account, it shows an automatic suggestion (who handled most of its invoiced orders, else who made most of its quotes), clearly marked Automatic.', 'Margin is only an indicative garment margin on the invoice lines we have supplier costs for, and the page shows how much of the sales it rests on. It leaves out embroidery and print costs.'],
    watch: 'Nobody is confirmed yet, so every account starts on Automatic and the first job is to confirm or change them (use the Automatic, to confirm filter). If the margin looks too high, that is expected: it is before decoration costs and only covers a small share of sales. If a quote sits under the wrong account, its customer name did not match an invoiced account; it shows as its own quotes only account.'
  },
  {
    v: 'v41', date: '2026-10-29', status: 'live', pr: 40, areas: ['Site'],
    title: 'Refreshing the dashboard keeps you on the same page',
    summary: 'When you refresh the dashboard you now stay on the page you were on, instead of going back to the Overview.',
    changes: ['It remembers the last menu page you opened, including the newer ones like Quotes, Win-back and Calendar.', 'On Purchase Order Review it also remembers which tab you were on.', 'It only remembers while that browser tab is open. Opening the dashboard fresh still starts on the Overview.'],
    watch: 'If a refresh still lands on the Overview, do a hard refresh once (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) so the browser picks up the update. It does not remember how far down the page you had scrolled.'
  },
  {
    v: 'v40', date: '2026-10-28', status: 'live', pr: 39, areas: ['Invoices'],
    title: 'Supplier invoices now arrive through the shared Microsoft 365 mailbox',
    summary: 'Supplier invoices are now picked up from the shared invoice mailbox instead of the old Gmail inbox, and appear in Purchase Order Review within minutes.',
    changes: ['Every 5 minutes the invoice mailbox is checked. Each PDF goes through the same checking and matching as before, and the email is then moved to a Processed folder so the Inbox stays clear.', 'If an email is still sitting in the Inbox after a day, an email goes to Daniel and Oliver listing it.', 'The old Gmail pick-up is switched off, so forwarding an invoice to Gmail by hand no longer does anything.'],
    watch: 'If invoices stop appearing, check the shared invoice mailbox first: emails still in its Inbox have not been picked up. Emails with no PDF stay there on purpose.'
  },
  {
    v: 'v39', date: '2026-10-28', status: 'live', pr: 38, areas: ['Update log'],
    title: 'Morning email with new update suggestions',
    summary: 'New suggestions from the Update log now arrive in one email each weekday morning, so nobody has to keep checking the tab.',
    changes: ['The email lists each new suggestion with who sent it, the part of ATAM GO it is about, and its current points.', 'It is only sent when there is something new, and Monday\u2019s email covers the weekend.'],
    watch: 'If you expect a suggestion and no email came, check the Update log tab: it always shows every suggestion.'
  },
  {
    v: 'v38', date: '2026-10-28', status: 'live', pr: 37, areas: ['Purchase Order Review'],
    title: 'Posted to Xero tab on Purchase Order Review',
    summary: 'Purchase Order Review now has a Posted to Xero tab, like Sales Invoices, so you can see what has already gone through.',
    changes: ['New tab at the end of the row, with a count of everything posted so far.', 'Shows the newest 50: supplier, invoice number, amount, PO number, when it was posted, and whether it was auto-approved or approved by a person.', 'It is a look-back list only. Nothing on it can be changed or undone here.'],
    watch: 'If the tab shows fewer than you expect, only the latest 50 are listed. The number on the tab is the full count.'
  },
  {
    v: 'v37', date: '2026-10-28', status: 'live', pr: 36, areas: ['Purchase Order Review'],
    title: 'Purchase Order Review now has tabs across the top',
    summary: 'Purchase Order Review now works like Sales Invoices: one page with tabs across the top instead of three separate menu items.',
    changes: ['Tabs: Needs review, In review, Approved (waiting to post) and Rejected, each with a count. Needs review lights up amber when something is waiting.', 'The separate Approved Invoices and Rejected Invoices menu items are gone; everything is on this one page.', 'Nothing about how invoices are checked, approved, rejected or posted has changed. Undo approval and undo reject work as before.'],
    watch: 'If a tab looks empty when you expect invoices, press the browser refresh and check the number next to the tab. The Approved and Rejected lists show the 50 most recent.'
  },
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
  { title: 'Replace the old shared token on the invoice webhook', areas: ['Security'], detail: 'The invoice checker still accepts an old shared token, and only the Microsoft 365 invoice intake sends it now that Gmail is switched off. Replace it with a proper stored credential on both sides together.' },
  { title: 'Guided steps for Quotes and New customers', areas: ['Quotes', 'New customers'], detail: 'The same "Your move" help that Win-back now has, with wording agreed with Daniel and Steph.' },
  { title: 'Outlook diary entries for chase dates', areas: ['Calendar'], detail: 'Needs calendar permission from IT for the ATAM GO Mailer app. Not started.' },
  { title: 'Move stored secrets out of the automations', areas: ['Security'], detail: 'The DecoNetwork password and the Xero client secret are stored in plain text in several automations. Create proper credentials, rewire the automations, then rotate the secrets.' },
  { title: 'Supabase sign-in hardening', areas: ['Security', 'Access'], detail: 'Turn on leaked-password protection and change Daniel Spooner\'s password.' },
  { title: 'Tidy-ups', areas: ['Database', 'DAN'], detail: 'Run sql/cleanup_old_quote_tracking.sql and check and delete the old "danbot" Cloudflare worker. Retries were looked at and the main automations already have them.' },
  { title: 'Rejected quotes', areas: ['Quotes'], detail: 'DecoNetwork has a Rejected status but its API data does not show it, so a rejected quote still ages to Lost after 30 days on its own. Quotes you know are dead can be removed by hand with the Remove button.' },
  { title: 'Terms and conditions link in the quote email footer', areas: ['Quotes'], detail: 'Waiting for the standard terms link to be supplied.' }
];
