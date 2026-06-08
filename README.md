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

## Workflow triggers

Add n8n production webhook URLs in `config.js` under `WEBHOOKS`.
