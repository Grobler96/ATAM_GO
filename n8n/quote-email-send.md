# n8n: emailing customers from the Quotes tab

The database and website parts are already built (`sql/quote_email_chase.sql`, `quotes.js`). The switch
`EMAIL_SENDING_ENABLED` in `quotes.js` stays `false` until both workflows below are built, tested and published.

## Before building
- Microsoft Entra app "ATAM GO Mailer" with Graph application permissions `Mail.Send` and `Mail.Read`, admin consent
  given, restricted to the sender mailboxes with an Exchange application access policy (or RBAC for Applications).
- An n8n OAuth2 credential (client credentials, scope `https://graph.microsoft.com/.default`, token URL
  `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token`). Secret goes into n8n only, never the repo.
- Rows in `mail_senders` (label, email, kind 'rep' or 'shared', rep_name = the name used in DecoNetwork / `quotes.assigned_to`).

## Workflow A: `quote-email-send` (webhook, POST, called by the browser)
Body: `{ "email_id": 123 }`. Header: `Authorization: Bearer <user's Supabase token>`.
1. **Verify Login**: GET `{supabase}/auth/v1/user` with that token. Stop with 401 if it fails (same as the other webhooks).
2. **Read the email**: select from `quote_emails` where `id = email_id` and `status = 'queued'`. Stop if not found.
   Send exactly what is stored (sender, to, subject, body). Never take content from the request.
3. **Create draft**: POST `https://graph.microsoft.com/v1.0/users/{sender_email}/messages` with subject, body
   (`contentType: Text`, so customer text and quote data cannot inject HTML), `toRecipients`. The response gives `id` and `conversationId`.
4. **Send**: POST `/users/{sender_email}/messages/{id}/send`.
5. **Mark sent**: call `mark_quote_email_sent(p_id, p_graph_id, p_conversation_id)` as the service role. This sets the 3-day
   deadline and logs the chase.
6. On any failure after step 2: call `mark_quote_email_failed(p_id, p_error)` and return `{ ok: false, error: "..." }` (HTTP 200 or 500).
   On success return `{ ok: true }`.
Add retries only on the read/mark steps, never on the Send step (a retry could send twice).

## Workflow B: reply check (every 30 minutes)
1. Select `quote_emails` where `status = 'sent'`, `replied_at is null`, `sent_at` within the last 21 days.
2. For each, GET `/users/{sender_email}/messages?$filter=conversationId eq '{conversation_id}'&$select=from,receivedDateTime`
   (test this filter on the real tenant; if Graph rejects it, filter by `receivedDateTime ge {sent_at}` and match `conversationId` in n8n).
3. If any message is from someone other than the sender mailbox and received after `sent_at`, call `mark_quote_email_replied(p_id, p_at)`.
The Quotes tab also treats a DecoNetwork customer reply newer than the email as a reply, so this is a second source.

## Not built on purpose
- No automatic second chase. At 3 days with no reply the card shows "Chase #2 is due" and a person sends it.
- Nothing here touches Xero or any money action.

## Built (20 Oct 2026) - both workflows exist in n8n but are NOT published
- `Quote email send (Microsoft 365)` (id `iPFyyUkJ3AbQH9iR`, webhook path `quote-email-send`)
- `Quote email reply check (every 30 min)` (id `wnPRUfjJX0qc9kBE`)
Both use the existing "Supabase account 2" credential (must be the service-role key, because the `mark_*` functions are
service-role only) and the shared error alert workflow. Both need a Generic OAuth2 credential named **Microsoft Graph Mailer**
(client credentials, scope `https://graph.microsoft.com/.default`) attached to the Graph nodes: Create Draft, Send Email,
Get Conversation Messages.

Behaviour worth knowing:
- Send Email has no retry (a retry could send twice).
- If Create Draft or Send fails the row is marked failed and nothing is recorded as sent. A leftover draft may sit in the mailbox.
- If the email is sent but Mark Sent fails, the row is NOT marked failed; the browser is told "sent but not recorded, do not send again".
- A reply is any message in the conversation from an address other than the sender mailbox, received after `sent_at`
  (an out-of-office auto-reply would count).
- Tested with pinned data only: reply detection (own address ignored, case-insensitive) and the sent path of the webhook.
  Not tested: real Graph, real Supabase writes, the failure branches, the `$filter` on `conversationId`.
