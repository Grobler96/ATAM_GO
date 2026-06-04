# ATAM GO — Control Centre

A single-page web dashboard for **Atam** (UK uniform supplier) to monitor, trigger, and review automation workflows powered by **n8n Cloud** and **Airtable**.

---

## Overview

ATAM GO Control Centre is a static HTML application — no server, no build step. It acts as mission control for Atam's back-end automations: launch n8n webhooks, view live Airtable data, track run history, and analyse customer reorder behaviour.

**Live:** https://grobler96.github.io/ATAM_GO/

---

## File Structure

```
ATAM_GO/
├── index.html              ← HTML structure only
└── assets/
    ├── style.css           ← All styles & design tokens
    ├── config.js           ← Webhook URLs, step labels, page titles  ← EDIT THIS FIRST
    ├── nav.js              ← Page navigation, sidebar, theme toggle
    ├── runner.js           ← Workflow launcher & progress animation
    ├── table.js            ← Data table render, filter, sort, export
    ├── charts.js           ← Analytics page charts (Chart.js)
    ├── insights.js         ← Insights page charts & risk register
    └── ui.js               ← Toasts, settings save, boot wiring
```

---

## What to Edit & Where

| I want to… | Edit this file |
|---|---|
| Change the webhook URL | `assets/config.js` |
| Add a new workflow step label | `assets/config.js` |
| Change a page name | `assets/config.js` |
| Add a new page / change navigation | `assets/nav.js` + `index.html` |
| Change how the workflow launches | `assets/runner.js` |
| Change how the data table looks | `assets/table.js` |
| Add/remove columns from the table | `assets/table.js` → `PRIORITY_COLS` |
| Change analytics charts | `assets/charts.js` |
| Change insights charts or risk table | `assets/insights.js` |
| Add a toast or settings field | `assets/ui.js` |
| Change colours, fonts, spacing | `assets/style.css` |
| Change page layout / add HTML | `index.html` |

---

## Pages

| Page | Description |
|---|---|
| **Dashboard** | KPI cards + quick launch button |
| **Workflows** | Launch & monitor the Reorder Check automation |
| **Data Viewer** | Live Airtable results — searchable, sortable, CSV export |
| **Analytics** | Chart.js graphs for run count and response time history |
| **Insights** | Customer behaviour analysis, reorder risk, interval distributions |
| **Settings** | Edit the n8n webhook URL |

---

## Workflow: Run Reorder Check

```
POST https://atamcpi.app.n8n.cloud/webhook/68aa00d4-...

Payload:  { "trigger": "reorder_check", "source": "ATAM GO Control Centre", "timestamp": "..." }
Response: JSON array of Airtable records
Est. time: 5–15 seconds
```

To change the URL: go to **Settings** in the app, or edit `webhookUrl` in `assets/config.js`.

---

## Tech Stack

| Tool | Role |
|---|---|
| Vanilla HTML / CSS / JS | Single-file app — no build step |
| n8n Cloud | Webhook-triggered automation backend |
| Airtable | Inventory & customer data source |
| Chart.js v4.4.0 | Analytics & insights charts |
| Lucide Icons | UI icon set |
| Google Fonts (Inter + Space Grotesk) | Typography |

---

## Roadmap

- [ ] Add more workflow cards (invoice automation, order confirmation, etc.)
- [ ] Auth layer for client-facing deployment
- [ ] Persistent settings storage via Airtable config table
- [ ] Webhook response validation + error detail display

---

## Author

Built by Oliver Grobler — AO Webcraft Marketing  
Automation stack: n8n · Make.com · Airtable · AI integrations
