/* ═══════════════════════════════════════════════
   ATAM GO — Config
   Edit this file to change webhook URLs, workflow
   step labels, and page titles.
   ═══════════════════════════════════════════════ */

'use strict';

// ── Webhook ──────────────────────────────────────
// Change this URL to point to a different n8n webhook
let webhookUrl = 'https://atamcpi.app.n8n.cloud/webhook/68aa00d4-9b77-42c2-9b0f-6afa8bcadf77';

// ── Workflow progress step labels ────────────────
// Add, remove or rename steps here
const STEPS = [
  { label: 'Connecting to n8n…' },
  { label: 'Reaching Airtable…' },
  { label: 'Fetching customer records…' },
  { label: 'Running reorder logic…' },
  { label: 'Compiling results…' },
  { label: 'Finalising report…' },
];

// ── Page title map ───────────────────────────────
// Add new pages here when you create them
const PAGE_TITLES = {
  home:      'Dashboard',
  workflows: 'Workflows',
  data:      'Data Viewer',
  analytics: 'Analytics',
  insights:  'Insights',
  settings:  'Settings',
};
