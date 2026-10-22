# n8n: emailing customers from the Quotes tab

The database and website parts are already built (`sql/quote_email_chase.sql`, `quotes.js`). The switch
`EMAIL_SENDING_ENABLED` in `quotes.js` stays `false` until both workflows below are built, tested and published.

## Before building
- Microsoft Entra app "ATAM GO Mailer" with Graph application permissions `Mail.Send` and `Mail.Read` (NOT Mail.ReadWrite: the flow is built so it is not needed), admin consent
  given, restricted to the sender mailboxes with an Exchange application access policy (or RBAC for Applications).
- An n8n OAuth2 credential (client credentials, scope `https://graph.microsoft.com/.default`, token URL
  `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token`). Secret goes into n8n only, never the repo.
- Rows in `mail_senders` (label, email, kind 'rep' or 'shared', rep_name = the name used in DecoNetwork / `quotes.assigned_to`).

## Workflow A: `quote-email-send` (webhook, POST, called by the browser)
Body: `{ "email_id": 123 }`. Header: `Authorization: Bearer <user's Supabase token>`.
1. **Verify Login**: GET `{supabase}/auth/v1/user` with that token. Stop with 401 if it fails (same as the other webhooks).
2. **Read the email**: select from `quote_emails` where `id = email_id` and `status = 'queued'`. Stop if not found.
   Send exactly what is stored (sender, to, subject, body). Never take content from the request.
3. **Send**: POST `/users/{sender_email}/sendMail` with the stored subject, body (`contentType: Text`, so customer text and quote data
   cannot inject HTML) and recipient, `saveToSentItems: true`. Microsoft answers 202 with no body. Anything else = not sent.
4. **Find the sent message**: wait about 6 seconds, then GET `/users/{sender_email}/mailFolders/sentitems/messages` (newest 15) and
   match the stored subject + recipient sent in the last 5 minutes. This gives the message `id` and `conversationId`.
5. **Mark sent**: call `mark_quote_email_sent(p_id, p_graph_id, p_conversation_id)` as the service role. This sets the 3-day
   deadline and logs the chase. If the lookup in step 4 finds nothing the email is still marked sent (never mark an email failed
   once Microsoft accepted it); it just has no conversation id, so its replies will not be picked up automatically.
6. If Microsoft refuses the send: call `mark_quote_email_failed(p_id, p_error)` and return `{ ok: false, error: "..." }`.
   On success return `{ ok: true }`.
Add retries only on the read/mark steps, never on the Send step (a retry could send twice).

## Workflow B: reply check (every 30 minutes)
1. Select `quote_emails` where `status = 'sent'`, `replied_at is null`, `sent_at` within the last 21 days.
2. For each, GET `/users/{sender_email}/messages?$filter=conversationId eq '{conversation_id}'&$select=from,receivedDateTime`
   (test this filter on the real tenant; if Graph rejects it, filter by `receivedDateTime ge {sent_at}` and match `conversationId` in n8n).
3. If any message is from an outside email address (not the sender mailbox) and received after `sent_at`, call `mark_quote_email_replied(p_id, p_at)`.
   Gotcha found in testing: Microsoft reports our own and colleagues' mailboxes as an Exchange path (`/O=EXCHANGELABS/...`), not an email
   address, so only an address containing `@` counts as a customer reply. The `conversationId` filter works on the real tenant.
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

## Tested on 21 Oct 2026 (real tenant, real send)
- Credential `Microsoft Graph Mailer` reads the support inbox. Creating a draft is refused (no Mail.ReadWrite), which is why the flow sends directly.
- A real test email sent from support@atam.co.uk reached grobleroliver@gmail.com (main inbox), was found in Sent Items, and was recorded as sent with the 3-day deadline.
- The reply query by conversationId works; the reply logic was checked with pinned data for: our own message only, a real customer reply, an old outside message.
- Not tested: a real customer reply arriving, the website button (login token needed), phone/DAN sending.

## HTML and footer (22 Oct 2026)
The send workflow has a Code node "Build Email HTML" between "Email Found?" and "Send Email". It HTML-escapes the stored plain-text body, turns https links into links, and appends one generic footer (landline, website, address, company number, confidentiality line). Graph `sendMail` then uses `contentType: "HTML"`. The stored `quote_emails.body` stays plain text, and Sent Items matching (subject + recipient) is unchanged. The footer is previewed in `quotes.js` (`FOOTER_HTML`); keep the two in step. Not tested against a live send at the time of writing.
The banner (`assets/email-banner.jpg`, served from `https://grobler96.github.io/ATAM_GO/assets/email-banner.jpg`) is fetched in "Build Email HTML" and attached as an inline `fileAttachment` (contentId `atambanner`). If the fetch fails the email is sent without the banner. Not tested against a live send.

## Win-back emails (22 Oct 2026)
The same send workflow also sends emails from the Win-back tab. The browser posts `{ email_id, kind: "winback" }` (kind missing or anything else = a quote email). "Read Queued Email" reads `winback_emails` instead of `quote_emails`, and "Mark Sent" / "Mark Failed" call `mark_winback_email_sent` / `mark_winback_email_failed` instead of the quote versions. Everything else (login check, HTML footer, banner, Sent Items lookup) is shared. The reply-check workflow has a second chain (Get Win-back Emails Waiting, Get Win-back Conversation, Find Win-back Replies, Mark Win-back Replied) for `winback_emails`. Not tested against a live send at the time of writing; the reply-check workflow was run once by hand with nothing waiting (ran clean).
