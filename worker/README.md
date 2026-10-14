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
- `focus` ({kind, id}) on a chat request puts DAN in guide mode for one record (sales invoice, supplier invoice, discrepancy): the record, the DecoNetwork / PO checks and an accounts playbook are added to its instructions. Extra actions in guide mode: rebuild a sales invoice, hold it, undo its approval (each needs a yes).
- `/alerts` (no AI) and `/briefing` (written by DAN) feed the chat panel.
- Add a table to the `TABLES` list at the top of the file to let DAN read it.

## Phone (VAPI): ring DAN, and DAN rings Daniel each morning
VAPI is only the ears and mouth. It sends what is said to `/voice`; the same DAN brain answers.

Extra variables and secrets on the worker:
| name | what it is |
|---|---|
| `DAN_VOICE_KEY` (secret) | a long random string. VAPI sends it in an `X-Dan-Key` header; without it `/voice` refuses |
| `DAN_VOICE_EMAIL`, `DAN_VOICE_PASSWORD` (secret) | the login of a dedicated "phone" user in Supabase (Authentication -> Users -> Add user, auto confirm). Then run `sql/dan_voice.sql` so it can see everything |
| `DAN_VOICE_NUMBERS` | numbers allowed to use the phone line, comma separated, e.g. `+447...` (Daniel's) |
| `DAN_VOICE_PASSPHRASE` (secret, optional) | on inbound calls DAN can only act (rebuild, reassign, log...) after the caller says this. Outbound calls we make ourselves need no passphrase |
| `VAPI_API_KEY` (secret), `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` | to place the morning call |
| `DAN_MORNING_NUMBER` | the number to ring each morning (Daniel's) |

Morning call: add two Cron Triggers on the worker (Settings -> Triggers -> Cron): `30 6 * * 1-5` and `30 7 * * 1-5`. Whichever lands on 07:30 UK time makes the call, so it is right in summer and winter.
Test it without ringing: `POST /voice/morning` with header `X-Dan-Key` and body `{"dry":true}` returns the script. Without `dry` it rings now.
`GET /voice/health` shows which settings are present.

Actions by voice: same ones as chat, each after DAN reads it back and gets a yes. Never approving or posting invoices.
