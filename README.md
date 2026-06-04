# ATAM GO — Control Centre

A single-page web dashboard built for **Atam** (UK uniform supplier) to monitor, trigger, and review automation workflows powered by **n8n Cloud** and **Airtable**.

---

## Overview

ATAM GO Control Centre is a self-contained HTML application that acts as mission control for Atam's back-end automations. It provides a clean, dark-mode-first UI to launch n8n webhooks, view live Airtable data, track run history, and configure workflow settings — all without needing a backend server.

---

## Features

| Section | Description |
|---|---|
| **Dashboard** | KPI cards showing active workflows, runs today, last run time, and Airtable record count |
| **Workflows** | Launch and monitor the *Run Reorder Check* automation with animated progress steps |
| **Data Viewer** | Displays live Airtable records returned by the last workflow run; supports search, sort, and CSV export |
| **Analytics** | Chart.js graphs for daily run count and response time history |
| **Settings** | Editable webhook URL for the n8n integration |

### UI Details
- Dark / light mode toggle (respects system preference by default)
- Animated workflow launch sequence with step-by-step progress indicators
- Toast notifications for success and error states
- Fully responsive — collapses to single-column on mobile (≤768px)
- Sticky sidebar navigation with active state indicators

---

## Tech Stack

| Tool | Role |
|---|---|
| Vanilla HTML/CSS/JS | Single-file app — no build step required |
| [n8n Cloud](https://n8n.io) | Webhook-triggered automation backend |
| [Airtable](https://airtable.com) | Inventory data source |
| [Chart.js](https://www.chartjs.org) v4.4.0 | Analytics charts |
| [Lucide Icons](https://lucide.dev) | UI icon set |
| Google Fonts (Inter + Space Grotesk) | Typography |

---

## Workflow: Run Reorder Check

The primary automation checks inventory levels against reorder thresholds and fetches updated stock data from Airtable.

**Webhook endpoint:**
```
POST https://atamcpi.app.n8n.cloud/webhook/68aa00d4-9b77-42c2-9b0f-6afa8bcadf77
```

**Payload sent on trigger:**
```json
{
  "trigger": "reorder_check",
  "source": "ATAM GO Control Centre",
  "timestamp": "<ISO 8601 datetime>"
}
```

**Expected response:** JSON array of inventory records (or `{ records: [...] }` / `{ data: [...] }` / `{ items: [...] }` formats are all supported). Records are automatically rendered in the Data Viewer table.

**Estimated run time:** 5–15 seconds

---

## File Structure

```
ATAM_GO/
└── index.html   ← Entire application (CSS + JS + HTML in one file)
```

---

## Usage

1. Open `index.html` in any modern browser (or serve via GitHub Pages)
2. Navigate to **Workflows** or use **Quick Launch** on the Dashboard
3. Click **Launch Workflow** to trigger the n8n webhook
4. Watch the animated progress sequence; results auto-populate in **Data Viewer** on completion
5. Use the **Export CSV** button to download the results
6. Update the webhook URL at any time via **Settings → Save Settings**

---

## GitHub Pages

This repo is configured to serve via GitHub Pages. Access the live app at:

```
https://grobler96.github.io/ATAM_GO/
```

---

## Roadmap

- [ ] Add more workflow cards (e.g. invoice automation, order confirmation)
- [ ] Connect Settings save to persistent storage (e.g. Airtable config table)
- [ ] Add authentication layer for client-facing deployment
- [ ] Split into modular JS/CSS files as the app grows
- [ ] Add webhook response validation and error detail display

---

## Author

Built by **Oliver Grobler** — [AO Webcraft Marketing](https://aowebcraft.com)  
Automation stack: n8n · Make.com · Airtable · AI integrations
