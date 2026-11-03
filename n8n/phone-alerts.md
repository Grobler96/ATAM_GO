# Phone alerts sender

n8n workflow `gGEjFHe4O7h66AqN` "Phone alerts sender", published 3 Nov 2026. Every 2 hours at 20 past.

1. `push_scan()` queues new alerts (customer replied to a quote; an order became late).
2. `push_claim()` takes the pending alerts and the devices to send each to, and marks them taken so they cannot go twice.
3. "Get Push Keys" reads `push_config` (the VAPID key pair). Skipped when there is nothing to send.
4. "Send the alerts" (Code node) encrypts each message for each device (aes128gcm) and POSTs it to the device's push service with a signed VAPID header.
5. `push_report()` records the results; devices that answer 404 or 410 are switched off.

- Run data is not saved on purpose: the keys pass through this workflow.
- Backslashes inside Code node strings are dropped by the workflow builder: avoid regex escapes there. The Code node has no global `URL`.
- To send queued alerts now (for example a "Send me a test"): open the workflow in n8n and press Execute workflow.
- To stop alerts: unpublish the workflow. To remove a device: the person turns alerts off on the Today tab.
- The key pair was made once by a throwaway workflow and stored in `push_config`. To rotate it, delete the row and make a new one: every device has to turn alerts on again.
