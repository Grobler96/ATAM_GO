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
    v: 'v74', date: '2026-11-05', status: 'live', pr: 66, areas: ['Purchase orders'],
    title: 'Credit notes and other documents now show on Purchase Order Review',
    summary: 'When the invoice reader gets a PDF that is not a normal invoice (a credit note, delivery note, statement, terms and conditions) it never put it in front of anyone. Those documents now have their own tab on Purchase Order Review.',
    changes: ['The new tab is called Credit notes and other documents. Credit notes are listed first, with the supplier, amount, date and a button to open the PDF. Statements and anything unusual come next.', 'Delivery notes, terms and conditions and 68 old invoices from June (held back because the supplier was not set up then) are tucked away below, each with a button to tick them all off at once.', 'Press Dealt with once you have dealt with one; Put back undoes it. This only ticks it off. Nothing is posted to Xero, nothing is deleted, and credit notes are still not applied automatically: they must be entered in Xero by hand.', 'There are four credit notes waiting, including Portwest 000804501 (-£22.08, received 6 October), which is the one Steph asked about. Please check those four in Xero.', 'The page notes now say that clean matches go into Xero as Authorised.'],
    watch: 'This shows what was already being held; it does not change what the invoice reader does with a document. If a real invoice has been filed here by mistake, tell Oliver.'
  },
  {
    v: 'v73', date: '2026-11-05', status: 'live', areas: ['Automation'],
    title: 'DecoNetwork login stored in one place',
    summary: 'The login the automations use to read DecoNetwork was typed into each automation. It is now one saved login, so it can be changed in one place.',
    changes: ['Eight automations now use the saved login: the production capture, upcoming orders, order revenue, quotes, purchase orders, stock levels, working stock and the nightly customer data. Each was test-run and brought back orders as before.', 'Next step for Oliver: change the DecoNetwork password for that user, then update the saved login. The old password is still in the history of those automations until it is changed.'],
    watch: 'If orders, quotes, stock or purchase orders stop updating after a password change, the saved login probably has the wrong password. The Automation health box on this tab shows which data has stopped.'
  },
  {
    v: 'v72', date: '2026-11-05', status: 'live', areas: ['Purchase orders', 'Xero'],
    title: 'Clean-match supplier bills go into Xero as Authorised (corrects v71)',
    summary: 'Supplier bills that match their purchase order cleanly have been approved automatically since 22 September, and went into Xero as Draft. They now go in as Authorised, so nobody has to approve them in Xero. v71 described the automatic approval as new; it was not, only the Authorised part is new.',
    changes: ['Applies to a clean match with high confidence from a supplier that is already set up. There is no amount limit.', 'Everything else is unchanged: price differences, supplier mismatches, no purchase order, suspected duplicates, lower confidence and new suppliers still wait in Needs review, and bills a person approves still go in as Draft.', 'Bills go in at the 5pm run. Until then they show on the Approved tab and can be undone.', 'If Xero refuses one or the supplier cannot be found, it goes back to Needs review.'],
    watch: 'The first Authorised bills go in at 5pm on 5 November: check them in Xero. If one is wrong, void it in Xero and tell Oliver; it can be switched back to Draft.'
  },
  {
    v: 'v71', date: '2026-11-05', status: 'live', pr: 60, areas: ['Purchase orders', 'Xero'],
    title: 'Clean matches go straight into Xero as Authorised',
    summary: 'Supplier bills that match their purchase order cleanly no longer wait for someone to check them. They are approved automatically and go into Xero as Authorised instead of Draft. Steph asked for this after checking them for over a week and finding them always right.',
    changes: ['Only a clean match qualifies: high confidence, supplier already set up with its nominal code, an invoice number and date, a matched purchase order, a total above zero, and not already approved or posted before. There is no amount limit.', 'Everything else still waits in Needs review: price differences, supplier mismatches, no purchase order, suspected duplicates, lower confidence and new suppliers.', 'They are marked "Auto: clean match" on the Approved and Posted tabs. They post at the usual 5pm run, so there is still time to press Undo approve before then.', 'If Xero refuses one or the supplier cannot be found, it goes back to Needs review and a person approves it as normal (as a Draft).'],
    watch: 'This is the first time bills reach Xero without a person approving them. If one is wrong, void it in Xero and tell Oliver. The automatic approval can be switched off in one place without changing the site.'
  },
  {
    v: 'v70', date: '2026-11-05', status: 'live', pr: 60, areas: ['Purchase orders'],
    title: 'Backing sheets no longer clutter Purchase Order Review',
    summary: 'WCMA emails carry the real invoice and a "Monthly Calloff Archive" summary (a number like MC0276). The summary was turning up as a second item to check. It is now sent straight to Rejected.',
    changes: ['When an email has a real invoice and a backing sheet with an MC number, the backing sheet goes to Rejected with a note saying why. It works whichever of the two is read first.', 'If an MC document arrives with no real invoice in the same email, it stays in Needs review so nothing is lost.', 'The three backing sheets already waiting (MC0276, MC0340, MC0023) were cleared. Nothing is approved or posted to Xero.'],
    watch: 'If a real invoice is missing from Needs review, check the Rejected tab for an item marked as a backing sheet. Tell Oliver if one was wrongly rejected; it can be put back.'
  },
  {
    v: 'v69', date: '2026-11-03', status: 'live', pr: 60, areas: ['Customers', 'Overview', 'Automation'],
    title: 'Job profit: what each job really made',
    summary: 'A new Job profit tab shows, for jobs that have shipped, the price charged, what the garments cost, and an estimate of how long the decoration took from its stitch count and number of items. It uses the order data already coming from DecoNetwork.',
    changes: ['The data (price, quantity, each size\u2019s garment cost and each design\u2019s stitch count) is now saved with every order the production capture reads, and about four months of past orders were filled in.', 'Top figures for the last 30, 60 or 90 days: jobs shipped, revenue, garment cost, profit after garments, estimated production hours and stitches.', 'Every job is listed lowest margin first, so loss-making jobs stand out. A question mark means a garment had no cost in DecoNetwork, so that job\u2019s profit is overstated. There are also tables by salesperson and for the biggest customers.', 'Production time uses 3 minutes per item (Daniel\u2019s rough guide) plus stitches at 700 a minute. Daniel or Oliver can change these and enter the cost of an hour of production. Until a cost per hour is entered the page only shows profit after garments and does not guess a production cost.'],
    watch: 'Revenue and garment costs come from DecoNetwork, so they are only as good as the costs set up there; about one job in six currently has a garment with no cost. Time is worked out one machine at a time. If the page looks wrong or empty, tell Oliver. The Automation health box shows whether the order capture is running.'
  },
  {
    v: 'v68', date: '2026-11-03', status: 'live', pr: 60, areas: ['Stock'],
    title: 'Suggested reorder list on the Stock tab',
    summary: 'The Stock tab now has a Suggested reorder section: the garments we keep in stock that are out or running low, how many to buy to get back to about six weeks of cover, and a rough cost. It is a draft for Steph to check. Nothing is ordered from it.',
    changes: ['It only looks at garments we really keep in stock. ATAM mostly buys garments for each job, so most items used on orders are not stocked and are not suggested.', 'Usage comes from the last ten weeks of orders. Each line shows what is on hand, how many were used and on how many orders, and anything already set aside for open jobs.', 'There is a Copy the list button to paste the list into an email or a supplier order.', 'It does not know supplier minimums, pack sizes or prices, or what is already on order, so check it before ordering.'],
    watch: 'If a suggestion looks silly (an item we have stopped stocking, or a one-off big job pushing the numbers up), tell Oliver which item. Because the pace comes from only ten weeks of orders, one large order can make an item look busier than it is.'
  },
  {
    v: 'v67', date: '2026-11-04', status: 'live', pr: 64, areas: ['Quotes'],
    title: 'Quotes: move a quote by hand, say what is happening, and more reasons for losing one',
    summary: 'Every open quote card now has two dropdowns: one to move it to another stage by hand, and one to say what is happening with it. Lost quotes have more reasons, and a quote that was replaced by a new one can be linked to the new quote, so we can start to see why quotes are lost.',
    changes: ['Stage dropdown on each open quote (and in the quote\u2019s side panel): Hot, Needs chasing, Going cold, or Lost. A quote you move stays there, marked \u201cMoved by hand\u201d, until something new happens on it: the customer replies, we email or chase them, or the quote is edited. Then it goes back to working itself out. You can also choose Back to automatic.', 'Choosing Lost asks why, then moves the quote to the Lost tab. Converted cannot be chosen by hand: that only happens when the customer approves the quote.', 'What is happening dropdown: Waiting on customer to decide, Customer asked for changes (revising), Waiting on artwork or logo, Waiting on budget approval, Waiting on a sample, Comparing prices, Customer put it on hold, Ready to order. The side panel also has a short note. Above the board, a row of buttons counts the open quotes in each status and filters the board when pressed.', 'Four new reasons for losing a quote: Price too high, Project cancelled or no longer needed, Lead time too long, Customer went quiet. They sit alongside Converted on another quote, Customer bought elsewhere, Budget and Other.', 'Converted on another quote now asks for the new quote number (optional). The lost quote shows a link to the new one, with its value and whether it has been approved, and the report on the Lost tab counts how many were replaced and what the new quotes are worth.', 'The Lost tab report now includes the new reasons automatically, by reason and by salesperson.'],
    watch: 'Quotes moved by hand only affect the Quotes tab, Today and Account managers. The Monday report, the Team board and DAN work out stages on their own and ignore a hand-set stage. Statuses and notes stay until someone changes them. If a quote jumps back to its old stage, check whether the customer replied or someone emailed them since it was moved.'
  },
  {
    v: 'v66', date: '2026-11-04', status: 'live', pr: 63, areas: ['DAN', 'Calendar'],
    title: 'DAN can set reminders',
    summary: 'You can now ask DAN, by typing or on the phone, to set a reminder or appointment to contact someone, tick it off, or move it to another date. It does the same as the Calendar tab.',
    changes: ['For example: \u201cRemind me to ring Alloy Bodies for a catch-up on Friday\u201d or \u201cvisit Smith Builders on the 20th at 2:30, then every 3 months\u201d. DAN works out the date, reads back the customer, what, date, time and repeat, and only saves it after you say yes.', 'It is a reminder for you unless you ask for someone else, and only Daniel and Oliver can set one for another person. If anyone else asks, DAN says so and offers to set it for them instead.', 'DAN can also tick a reminder off or snooze it, and can tell you what reminders are already set.', 'On the phone, DAN only does this after the call has been verified with the passphrase, the same as its other actions.', 'It is for general reminders. Quote chases and Win-back follow-ups still have their own places.'],
    watch: 'If DAN says it cannot set reminders, the newest version of DAN may not be on Cloudflare (Oliver puts it there by hand; the health page should say v17). If DAN sets the wrong date, say the date back to it in full, or fix it on the Calendar tab with Edit.'
  },
  {
    v: 'v65', date: '2026-11-04', status: 'live', pr: 62, areas: ['Calendar', 'Customers', 'Overview'],
    title: 'Reminders and appointments on the Calendar',
    summary: 'You can now set your own reminders to contact a customer (or anyone else) on a date, for a general catch-up, a visit or an appointment, with nothing to do with a quote or Win-back. They show on the Calendar, on Today when they are due, and on the account itself.',
    changes: ['On the Calendar press Add reminder (or Add a reminder on this day under a day). Type or pick a customer, or type any name for someone who is not an account yet, such as a prospect. Choose Call, Visit, Meeting / appointment, Email or Other, a date, an optional time and a note.', 'Repeating: every week, 2 weeks, month, 3 months, 6 months or year, or a custom pattern (every 1 to 60 days, weeks, months or years), with an optional date to stop. Tick a repeating reminder off and it moves to its next date by itself.', 'Each reminder has Done, Snooze (tomorrow, 3 days, next week, 2 weeks, a month), Edit and Delete. Reminders that are due or late appear on the Today tab with a Mark done button.', 'On the Account managers tab, open an account to see its reminders and add one with Remind us to contact them.', 'Everyone can set reminders for themselves. Only Daniel and Oliver can set a reminder for someone else (the For box). Everyone signed in can see everyone\u2019s reminders on the Calendar. You can change or delete your own; Daniel and Oliver can change anyone\u2019s.', 'Nothing goes into Outlook diaries (that needs permission from IT), and nothing is emailed or sent to phones yet.'],
    watch: 'If Add reminder says only Daniel or Oliver can do something, check the For box is set to yourself. A repeating reminder only shows its next date, not every future date. If a reminder will not save, tell Oliver what you typed and what the message said.'
  },
  {
    v: 'v64', date: '2026-11-03', status: 'live', pr: 59, areas: ['Invoices', 'Overview'],
    title: 'Cash tab: money coming in, bills going out, and who to chase',
    summary: 'A new Cash tab shows what is owed to us, when it is likely to arrive over the next eight weeks, which supplier bills fall due, and the overdue invoices to chase, with a draft chasing email for each customer. Nothing is sent or posted from it.',
    changes: ['Top figures: unpaid invoices, overdue (up to three months), falling due in the next seven days, expected in over eight weeks, and supplier bills due.', 'A week-by-week chart of money expected in against supplier bills due.', 'Expected money in is worked out from how our customers really pay: about 46% pay by the due date, and the middle one pays a day after it. Bigger and older invoices are weighted by how often invoices like them got paid.', 'Overdue invoices are grouped by customer, biggest first, with the oldest invoice shown. Press Draft chase to get a ready-written email (friendly, firmer or final, depending on how late it is) to copy or open in your own email program. It never includes bank details and nothing is sent from the page.', 'Invoices more than three months overdue are left out and shown as a note, because many look like old records worth reviewing in Xero.'],
    watch: 'The supplier side is only partial: it shows bills posted from ATAM GO since mid August and cannot tell whether one has already been paid, and there are no wages, rent, VAT or bank balance. Treat it as a guide, not a bank forecast. If a figure looks wrong, tell Oliver which one.'
  },
  {
    v: 'v63', date: '2026-11-03', status: 'live', pr: 58, areas: ['Quotes', 'Win-back', 'Customers'],
    title: 'Ideas to offer each customer',
    summary: 'The customer history panel (on Quotes and Win-back) now has an Ideas to offer card: the garment types that customers like this one buy, but this customer does not.',
    changes: ['For example: \u201cSweatshirts & hoodies: 63% of similar customers buy it (34 of 52), spending about \u00a3307 a year on it.\u201d', 'Similar customers are other customers who buy some of the same garment types over the last 24 months, weighted by how alike their ranges are.', 'It only suggests something when there are at least eight similar customers, at least three of them buy it, and the share is 35% or more. Otherwise the card says why there is nothing to suggest.', 'The card also lists what the customer already buys, so you can see at a glance what is missing.', 'It is a conversation starter, not a prediction. It looks at product types, not colours, sizes or logos.'],
    watch: 'It takes about a second to appear when you open a customer. Very large customers buy almost everything, so they usually have no ideas. If a suggestion looks wrong for a customer you know well, tell Oliver which customer.'
  },
  {
    v: 'v62', date: '2026-11-03', status: 'partly', pr: 57, areas: ['Overview', 'Site', 'Automation'],
    title: 'Phone alerts',
    summary: 'People can switch on alerts on their phone from the Today tab. They then get a message when a customer replies to one of their quotes, or one of their orders becomes late. Built and checked as far as possible without a real phone.',
    changes: ['A Phone alerts box at the top of the Today tab: Turn on alerts, Send me a test, Turn off. Each person chooses for themselves, on each device.', 'Alerts go to the salesperson the quote or order belongs to. Tapping an alert opens ATAM GO on the right page.', 'It checks every two hours, so an alert can arrive up to two hours after the news reaches ATAM GO, which itself refreshes every few hours.', 'On an iPhone or iPad, first tap Share and Add to Home Screen, then open ATAM GO from that icon. Apple only allows alerts that way.', 'The first time it runs it only notes what already exists, so switching it on does not send a flood of old alerts.'],
    watch: 'The first real test needs a phone. If Send me a test never arrives, or alerts stop, tell Oliver. The Automation health box shows whether the alert sender failed.'
  },
  {
    v: 'v61', date: '2026-11-03', status: 'live', pr: 56, areas: ['Quotes', 'Overview'],
    title: 'Team board: targets, leaderboard and wall screen',
    summary: 'A new Team board tab shows each salesperson\u2019s orders approved this month against their target, ranked, with where they should be by today. A Wall screen button fills the screen with big figures for the office TV.',
    changes: ['Each person has a card: orders approved and their value, progress to target, whether they are ahead of pace, on pace or behind, how they compare with last month, and what they could reach if their open quotes land as expected.', 'The whole team has a bar at the top. It only counts people who have a target, so the comparison is fair.', 'Daniel and Oliver can set targets with the Set targets button. A target applies from the month you set it until you set a new one, so there is nothing to re-enter every month. Nobody else can change them.', 'Use the arrows to look at earlier months and see who hit their target.', 'Wall screen refreshes itself every minute. Press Esc or the Leave button to come out of it.'],
    watch: 'No targets exist yet, so every card says No target set until Daniel or Oliver add them. \u201cSales\u201d means orders approved in the month, including orders keyed straight in. Early in the month the pace marker moves a lot, because only a few working days have passed.'
  },
  {
    v: 'v60', date: '2026-11-03', status: 'built', pr: 55, areas: ['Overview', 'Quotes', 'Automation'],
    title: 'Monday morning report for Daniel',
    summary: 'A one-page email for Daniel every Monday at 7:30: last week against the week before, where the open quotes stand, and what needs attention. Built and checked, but not switched on yet.',
    changes: ['Last week against the week before: orders approved, quotes raised, invoiced, and pieces embroidered and printed, with the change in percent.', 'Open quotes right now: how many, how much, what they are expected to win, and how many have gone quiet.', 'The five open quotes worth the most, late orders, overdue invoices (invoices more than three months overdue are shown separately), and a small table for each salesperson.', 'It will come from the support mailbox and goes to Daniel only. It is switched off until Oliver says to start it.'],
    watch: 'Once it is switched on, if no email arrives on a Monday morning, tell Oliver. The Automation health box on this tab shows whether it failed.'
  },
  {
    v: 'v59', date: '2026-11-03', status: 'live', pr: 54, areas: ['Quotes', 'Overview'],
    title: 'Sales forecast: what the open quotes are worth',
    summary: 'The Quotes tab now shows an Expected to win figure: every open quote\u2019s value multiplied by its chance to win, added up. Each salesperson\u2019s card shows their own.',
    changes: ['A new tile at the top of the Quotes tab, next to Open quotes, with the percentage it works out to.', 'Each salesperson card on the Sales team tab has an expected-to-win figure for their open quotes.', 'It follows the salesperson, store and search filters, so you can see it for one person or the whole team.', 'It uses the chance-to-win figures, so it is only as good as those: a guide to what the open quotes are worth, not a promise.'],
    watch: 'If the figure looks far too high or too low compared with what usually comes in, tell Oliver. The chance-to-win figures behind it can be tuned.'
  },
  {
    v: 'v58', date: '2026-11-03', status: 'live', pr: 54, areas: ['Quotes', 'Database'],
    title: 'Chance to win on every open quote',
    summary: 'Open quotes on the Quotes tab now show a chance to win, such as \u201c72% to win\u201d, worked out from how our own quotes have turned out. It helps decide who to chase first.',
    changes: ['It looks at quotes raised since June that have since been won or lost. For a quote of the same size and the same age that was still open, it takes the share that ended up approved.', 'Quotes get less likely the longer they sit: for small quotes the figure drops from about 80% on day one to about 25% after ten days.', 'Hover over the figure (or open the quote) to see how many quotes it is based on. It only looks at age and size, so it does not know the customer or whether they replied. Treat it as a starting point, not a promise.', 'The figure is refreshed every time the page loads, so it keeps learning as more quotes are won and lost.'],
    watch: 'If a figure looks wrong for a quote you know well, tell Oliver which quote. Quotes older than about a month have very few comparisons, so their figures are rough.'
  },
  {
    v: 'v57', date: '2026-11-03', status: 'in_progress', progress: 35, areas: ['Overview', 'Quotes', 'Win-back', 'New customers'],
    title: 'Today screen: your day on one page',
    summary: 'A new first tab called Today. It lists what each person should do next, most important first, so nobody has to check five tabs to plan the morning. This is the first of the bigger upgrades planned for ATAM GO.',
    changes: ['Pulls together quotes that need you (customer replied and waiting, email with no reply after 3 days, back from parking, gone quiet), Win-back and New customer chase dates that have arrived, late orders and overdue invoices.', 'Defaults to your own list, with a picker to see anyone else\u2019s or everyone\u2019s. Each line shows the money involved and has a button that takes you straight to it (for a quote it opens the quote, with the email box ready).', 'A tick hides a line for the rest of the day on that device. Invoices more than 3 months overdue are grouped into one line, as there are too many to be useful one by one.', 'Still to do: more one-press actions on each line, and phone alerts (a separate upgrade).'],
    watch: 'The ranking is a simple points system explained at the bottom of the tab. If something important is missing or something unimportant is at the top, tell Oliver what you expected to see.'
  },
  {
    v: 'v56', date: '2026-11-03', status: 'live', pr: 52, timeTaken: '3 h', areas: ['Quotes', 'Database'],
    title: 'Reason for closing a quote',
    summary: 'Removing a quote now asks why (converted on another quote, customer bought elsewhere, budget or other), and lost or expired quotes can be given a reason too. The Lost tab has a new report of why quotes are being lost. This was Daniel\u2019s suggestion.',
    changes: ['Remove now opens a small box to pick a reason. \u201cOther\u201d needs a few words.', 'There is a \u201cNeeds more time\u201d choice that takes you to Park instead, because that is what it really means.', 'Lost and Expired quotes show a Why closed column, and a lost quote\u2019s card and details have a button to add or change the reason.', 'The Lost tab starts with a report: how many quotes and how much money for each reason, and a table by salesperson. It follows the date, salesperson and search filters at the top. Quotes with no reason are counted too, so you can see how many are still unexplained.', 'The Removed quotes list at the bottom now shows the reason.'],
    watch: 'Quotes that were lost before this update have no reason, so the report starts mostly as \u201cNo reason given\u201d until people fill them in. If the reason box will not save, tell Oliver what it said.'
  },
  {
    v: 'v55', date: '2026-10-30', status: 'live', pr: 51, areas: ['Database'],
    title: 'Behind-the-scenes names tidied automatically',
    summary: 'Notes and “done by” fields that the system fills in now always say “the system” instead of the name of the tool that made the change, and this happens by itself for anything saved from now on.',
    changes: ['The old entries were already reworded; this stops the old wording coming back.', 'It only touches the “done by” fields and system-written notes. Anything typed by hand, such as chase notes, is never changed, so a real person or customer with that name is safe.'],
    watch: 'If a “done by” field shows “the system” where you expected a person, tell Oliver which page and which record.'
  },
  {
    v: 'v54', date: '2026-10-30', status: 'live', pr: 50, areas: ['Quotes', 'Calendar', 'Database'],
    title: 'Park a quote until a later date',
    summary: 'When a customer says \u201cnot yet\u201d, a quote can now be parked until a date you choose. It drops out of the chasing and the win rate, then comes back by itself on that day.',
    changes: ['New 💤 Park button on every open or expired quote (on the card and in the side panel). Pick a date (1 week, 2 weeks, 1 month, 3 months, early January, or any date) and write why, so whoever sees it later knows.', 'While parked the quote is out of the Pipeline, the chase lists, the counts, the win rate and DAN, so nobody chases a customer who has asked to wait, and it is not marked as lost.', 'New Parked tab on Quotes listing everything parked, when it comes back and why. You can change the date or bring one back early.', 'On the return day it comes back by itself as Hot, marked \u201cBack from parking\u201d with the reason, and a note to check that the quote has not expired in DecoNetwork. It also shows on the Calendar that day.', 'A parked quote that the customer approves in DecoNetwork is never hidden, so no sale is missed.', 'Quotes already approved or cancelled cannot be parked. The date must be after today and within about 13 months.'],
    watch: 'DecoNetwork cannot be changed from here, so if a quote has expired in DecoNetwork by the time it comes back, reopen it there as before. While a quote is parked it is not counted in Quotes raised, since it is hidden from the board. If a parked quote has gone missing, look on the Parked tab.'
  },
  {
    v: 'v53', date: '2026-10-30', status: 'live', pr: 50, areas: ['Customers'],
    title: 'Push to GHL button removed',
    summary: 'The Push to GHL button on the Customer Watchlist has been removed, along with the empty Action column it sat in.',
    changes: ['The button never did anything, because nothing was ever connected to it.', 'The Customer Watchlist now ends at the Last Value column. Nothing else about it has changed.'],
    watch: 'If you still see the button after this goes live, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac).'
  },
  {
    v: 'v52', date: '2026-10-30', status: 'live', pr: 49, timeTaken: '45 m', areas: ['DAN'],
    title: 'DAN chat panel tidied up: no more overlaps',
    summary: 'The DAN panel is now shorter and neater. The alerts no longer cover the chat, and the floating robot button no longer sits on top of the mic and send buttons.',
    changes: ['Alerts are now short one-line rows, most urgent first. The top three show, with a \u201cShow all\u201d link for the rest. Hover over a row to read the whole alert, and tap it to ask DAN about it as before.', 'The alert area can never take more than a third of the panel, so there is always room for the conversation (before, six alerts could take most of it and push the first message under them).', 'The floating robot button now hides while the panel is open, because it was sitting on top of the mic and send buttons. Use the \u2715 at the top of the panel to close it; the button comes back when it is closed.', 'The quick-question buttons under a message now sit on one line that you can swipe sideways, instead of taking up three lines.', 'Also fixed: the backup alerts DAN shows when the server list is unavailable were always empty because of the same data fault as the header tiles.'],
    watch: 'If an alert looks cut off, that is deliberate: hover over it (or tap it and ask DAN) to see the whole thing. If the DAN panel still looks cramped, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and tell Oliver your screen size.'
  },
  {
    v: 'v51', date: '2026-10-30', status: 'live', pr: 48, timeTaken: '1 h', areas: ['Site'],
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
  { title: 'Production capacity warnings', areas: ['Dispatch'], detail: 'Compare the next two weeks of booked work against machine capacity and flag promised dates that are unrealistic.' },
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
