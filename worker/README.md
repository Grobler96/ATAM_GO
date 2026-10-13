# DAN worker (Cloudflare)

`danbotv2.js` is the whole DAN agent. Cloudflare does not deploy it from GitHub; it is pasted in by hand.

## Deploy (about 2 minutes)
1. Cloudflare dashboard -> Workers & Pages -> **danbotv2** -> **Edit code**.
2. Select everything, paste the contents of `danbotv2.js`, press **Deploy**.
3. Settings -> Variables and Secrets. Needed:
   - `ANTHROPIC_API_KEY` (secret, already there)
   - `STOCK_SUPABASE_KEY` (secret, already there; lets DAN read live stock)
   - `DAN_MODEL` (optional text; defaults to `claude-sonnet-5-5`)
   `SUPABASE_URL` and `SUPABASE_KEY` from the old version are no longer used. If `SUPABASE_KEY` is the "service role" key, delete it.
4. Check it: open `https://danbotv2.grobleroliver.workers.dev/health` in a browser. It should show `"version":"v13"` and `anthropic_key_set: true`.
5. Open ATAM GO, signed in, click the robot. You should get a briefing, and alerts above it.

Roll back: Workers & Pages -> danbotv2 -> Deployments -> pick the previous version -> Rollback.

## How it works
- Every request needs the signed-in user's Supabase login token (the page sends it). The worker checks it with Supabase, then reads and writes the database as that user, so the dashboard's row-level security applies to DAN too.
- DAN is a tool-using agent: `business_pulse`, `list_tables`, `query_table` (whitelisted tables, filters, grouping), `query_stock`, `get_customer`, and confirmed actions (`log_winback_contact`, `set_winback_state`, `reassign_order`, `mark_deconetwork_correction_done`).
- `/alerts` (no AI) and `/briefing` (written by DAN) feed the chat panel.
- Add a table to the `TABLES` list at the top of the file to let DAN read it.
