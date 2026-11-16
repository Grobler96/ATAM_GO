-- Own Xero account for people who pay up front: two more shops (16 Nov 2026, v89). Re-runnable.
-- Steph asked (reply of 16 Nov) for Soroptimist and the main Atam Workwear shop to work like the AWR and Bill Plant shops (v77, sql/sales_invoice_own_account_2026-11-11.sql):
-- a paid order (no outstanding balance) whose Xero contact does not already carry the buyer's email waits in Needs review as "Own account needed".
-- "Atam Workwear Order Portal" is NOT included: in the last 60 days only 6 of its 52 invoices were paid up front, the rest are on account.
insert into public.own_account_stores (store_name, note) values
  ('ATAM - Soroptimist Uniform Shop', 'Soroptimist: individuals pay when they order (added 16 Nov 2026 at Steph''s request)'),
  ('Atam Workwear', 'Main Atam Workwear shop: paid orders get their own Xero account unless the contact already has the buyer''s email (added 16 Nov 2026 at Steph''s request)')
on conflict (store_name) do nothing;
