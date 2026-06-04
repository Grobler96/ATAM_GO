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
| [Airtable](https://airtable.com) | Inventory & customer data source |
| [Chart.js](https://www.chartjs.org) v4.4.0 | Analytics charts |
| [Lucide Icons](https://lucide.dev) | UI icon set |
| Google Fonts (Inter + Space Grotesk) | Typography |

---

## Airtable Data Source

The app reads from the **DecoNetwork Reorder Monitor** Airtable base. The primary table (`Customers`) tracks reorder behaviour for all active customers.

### Live Data Snapshot *(as of June 2026)*

| Metric | Value |
|---|---|
| Total tracked customers | 80+ |
| Eligible for frequency check | ~25 |
| Currently overdue | 5 |
| High priority (overdue) | 3 |
| Medium priority (overdue) | 2 |

### Priority Breakdown

| Priority | Criteria | Example Customer |
|---|---|---|
| **High** | Overdue by >50 days | David Bond (167 days overdue, Bill Plant) |
| **High** | Overdue by >50 days | Joyce Napolitano (54 days overdue, HH Associates) |
| **High** | Overdue by >50 days | Marian Janse-Bierens (85 days overdue, Synthomer) |
| **Medium** | Overdue by 1–50 days | Support Team (21 days, Atam internal) |
| **Medium** | Overdue by 1–50 days | Jo Hayhurst (16 days, Total Fitness) |
| **Not overdue** | Within threshold | Shaun Fitzgerald (Stockeld Park — 22 orders, avg 26-day cycle) |

### Key Fields Per Customer Record

| Field | Description |
|---|---|
| `Name` / `Email` | Customer identity |
| `Company` | Organisation (e.g. Bill Plant, PPG Whitford, Farmstar) |
| `Total orders` | Lifetime order count |
| `Mean reorder days` | Average days between orders (frequency-eligible only) |
| `Last order date` | Date of most recent order |
| `Days since last order` | Live counter used for overdue logic |
| `Overdue threshold days` | 1.25× mean reorder days — triggers overdue status |
| `Overdue by days` | How many days past threshold |
| `Priority` | `High` / `Medium` / `Not overdue` |
| `Eligible for frequency check` | `Yes` if ≥2 grouped order events |
| `Notify now` | `Yes` flags the record for email alert dispatch |
| `Last alerted at` | Date the customer was last notified |

### Notable Customers (Most Active)

| Customer | Company | Orders | Avg Cycle |
|---|---|---|---|
| Lorraine Wakefield | Farmstar Ltd | 31 | 13 days |
| Shaun Fitzgerald | Stockeld Park | 22 | 26 days |
| David Bond | Bill Plant | 18 | 12 days |
| Christine Ball | Atam Workwear | 14 | 37 days |
| Catherine Jenkins | PPG Whitford | 13 | 36 days |

---

## Workflow: Run Reorder Check

The primary automation checks each customer's `Days since last order` against their `Overdue threshold days`, updates `Priority` and `Notify now` flags in Airtable, and (optionally) dispatches reorder reminder emails.

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

**Expected response:** JSON array of customer records. Formats `{ records: [...] }`, `{ data: [...] }`, and `{ items: [...] }` are all handled. Records auto-render in the Data Viewer table.

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
- [ ] Trigger email alerts directly from the Control Centre UI

---

## Author

Built by **Oliver Grobler** — [AO Webcraft Marketing](https://aowebcraft.com)  
Automation stack: n8n · Make.com · Airtable · AI integrations
