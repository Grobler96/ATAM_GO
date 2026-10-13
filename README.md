# ATAM GO

Interactive Supabase-powered production dashboard for ATAM Workwear.

## Setup

1. Copy `config.example.js` to `config.js`.
2. Add your Supabase Project URL and anon/public key.
3. Do not use your Supabase service role key in the frontend.
4. Open `index.html`, or deploy to GitHub Pages / Netlify / Vercel.

## Supabase views used

- daily_dashboard_overview
- daily_decoration_summary
- daily_customer_summary
- daily_process_code_summary
- daily_store_summary
- ready_to_ship_orders
- late_or_at_risk_orders
- recent_decoration_activity

## Quotes tab

`quotes.js` powers the Quotes tab (pipeline board, salesperson performance, converted/lost lists, chase log).
Data comes straight from DecoNetwork: the n8n workflow `WF7_Quotes_Sync` (every 6 hours, plus a manual 150-day backfill)
copies quotes (order type 2) and approved quotes (order type 3) into `public.quotes`. The tab reads the `quotes_board`
view and writes phone/visit chases through `log_quote_chase()`. SQL is in `sql/quote_tracking.sql`.

## Win-back tab

`winback.js` is the reorder-review pipeline: customers past their usual reorder time move through Due soon, Needs a call,
Contacted waiting, Replied, Quote out and Won back. The team logs calls and emails on each customer (a drawer opens from the card);
quotes from DecoNetwork are matched to customers automatically (manual link, then email, then company or name) and move the card to
Quote out by themselves. Quotes that cannot be matched are listed under Unmatched quotes so they can be linked once.
Database objects and functions are in `sql/winback_pipeline.sql`.

## DAN (chat assistant)

DAN is a tool-using agent that runs as a Cloudflare worker (`worker/danbotv2.js`, see `worker/README.md` for how to deploy it).
The chat panel sends the signed-in user's login with every question, so DAN sees exactly what that person can see. On opening the panel
it shows a morning briefing and a list of alerts (late orders, replies waiting, quotes going cold, invoices above the DecoNetwork total...).

## Security notes

- Any text that comes from the database (customer, vendor, notes, PO numbers...) must go through the file's escape helper
  (`esc`, `escHtml`, or the shared `atamEsc` from `atamgo-auth.js`) before it is put into `innerHTML`.
- The browser talks to n8n webhooks by sending the signed-in user's Supabase login token (`atamgo-auth.js`). Each webhook
  verifies it with Supabase (`/auth/v1/user`) and answers 401 otherwise. There is no shared secret in this repo.
- Database permissions: see `sql/security_hardening_2026-10-13.sql`.
- The old shared `X-Atam-Go-Token` is still visible in git history but no longer works anywhere.

## Workflow triggers

Add n8n production webhook URLs in `config.js` under `WEBHOOKS`.
Last deployment triggered: 12 October 2026
