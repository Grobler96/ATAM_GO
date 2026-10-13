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

## Workflow triggers

Add n8n production webhook URLs in `config.js` under `WEBHOOKS`.
Last deployment triggered: 12 October 2026
