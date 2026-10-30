// quotes.js — "Quotes" tab: sales pipeline + salesperson performance.
//
// Where the data comes from (all straight from DecoNetwork, via the WF7_Quotes_Sync n8n workflow (every 6 hours) -> public.quotes):
//   - A quote is an order with order_type 2 and no date_ordered yet. When the customer approves it, DecoNetwork sets
//     date_ordered and the order becomes order_type 3. So: created = date_started, converted = date_ordered.
//   - Notes of type to_customer / from_customer are emails sent to / received from the customer. They count as chases
//     and replies without anyone having to log anything.
//   - Chases made by phone etc. can be logged here: log_quote_chase() writes to quote_chases.
//   - This page reads the quotes_board view (authenticated read only).
//
// Stages (open quotes are measured from the last time anyone touched them: edit, email either way, or logged chase):
//   Hot  quiet < 3 days      Needs chasing  3-13 days      Going cold  14-29 days
//   Lost 30+ days quiet, or cancelled        Converted  approved by the customer

(function () {
  'use strict';

  const PAGE_ID = 'quotes';
  const FRESH_DAYS = 3;     // quiet for fewer than this = hot
  const COLD_DAYS = 14;     // quiet this long = going cold
  const LOST_DAYS = 30;     // quiet this long = lost
  const DAY = 86400000;
  const HOUR = 3600000;
  const REFRESH_MS = 5 * 60 * 1000;
  const REPLY_DAYS = 3;     // after emailing, wait this long for an answer before the next chase is due
  // Email chasing goes out through the n8n workflow "quote-email-send" (Microsoft 365). Switched on 21 Oct 2026 after a real
  // test send. If sending ever has to be stopped, set this to false (and unpublish the workflow).
  const EMAIL_SENDING_ENABLED = true;
  const EMAIL_WEBHOOK = 'https://atamcpi.app.n8n.cloud/webhook/quote-email-send';
  const DECO_ORDER_URL = 'https://atamworkwear.co.uk/bh/orders?p=2&id=';

  const STATUS = {
    1: 'New order', 2: 'Production Complete', 3: 'Shipped', 4: 'Cancelled', 5: 'On Hold',
    6: 'Awaiting Stock', 7: 'Quote', 8: 'In Production', 9: 'Awaiting Payment'
  };

  const STAGES = {
    fresh: { label: 'Hot', icon: '🔥', color: '#f97316', blurb: 'touched in the last 3 days' },
    chase: { label: 'Needs chasing', icon: '⏰', color: '#f59e0b', blurb: '3 to 13 days quiet' },
    cold:  { label: 'Going cold', icon: '🧊', color: '#38bdf8', blurb: '14 to 29 days quiet' },
    won:   { label: 'Converted', icon: '✅', color: '#22c55e', blurb: 'approved by the customer' },
    lost:  { label: 'Lost', icon: '✖', color: '#94a3b8', blurb: 'cancelled or 30 days quiet' }
  };

  const PERIODS = [
    { key: '7', label: '7 days', days: 7 },
    { key: '30', label: '30 days', days: 30 },
    { key: '90', label: '90 days', days: 90 },
    { key: 'all', label: 'All synced', days: null }
  ];

  const TABS = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'expired', label: 'Expired' },
    { key: 'parked', label: 'Parked' },
    { key: 'team', label: 'Sales team' },
    { key: 'won', label: 'Converted' },
    { key: 'lost', label: 'Lost' },
    { key: 'all', label: 'All quotes' }
  ];

  const state = {
    rows: [], loaded: false, loading: false, error: null,
    tab: 'pipeline', period: '90', rep: '', store: '', q: '',
    sort: { key: 'idle', dir: -1 },
    chart: null, timer: null, openId: null, senders: null, composeOpen: false, animate: true, updatedAt: null,
    removed: [], showRemoved: false, removing: false, reigniting: false, parked: [], parking: false
  };

  // remember the last tab / period / salesperson / store on this device
  const PREF_KEY = 'atamgo_quotes_prefs_v2';
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (TABS.some(t => t.key === p.tab)) state.tab = p.tab;
    if (PERIODS.some(x => x.key === p.period)) state.period = p.period;
    if (typeof p.rep === 'string') state.rep = p.rep;
    if (typeof p.store === 'string') state.store = p.store;
  } catch (e) { /* storage unavailable: defaults are fine */ }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: state.tab, period: state.period, rep: state.rep, store: state.store })); } catch (e) { /* ignore */ }
  }

  // ───────────────────────── helpers ─────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const gbp = (v, dec) => '£' + num(v).toLocaleString('en-GB', { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0 });
  const fmtDate = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtDateTime = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
  const days = (a, b) => Math.floor((b - a) / DAY);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const quiet = d => d <= 0 ? 'today' : d === 1 ? '1 day' : d + ' days';
  const repName = r => r || 'Unassigned';
  const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const avatar = n => `<span class="qt-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(repName(n))}">${esc(initials(n))}</span>`;
  const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
  const fmtDays = d => d == null ? '—' : d < 1 ? '<1d' : Math.round(d) + 'd';

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  // ───────────────────────── data ─────────────────────────
  async function fetchAll() {
    const PAGE = 1000;
    let all = [], from = 0;
    for (;;) {
      const res = await client().from('quotes_board').select('*').order('order_id', { ascending: false }).range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      all = all.concat(res.data || []);
      if (!res.data || res.data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  function enrich(r, now) {
    const modified = toDate(r.modified_at);
    const created = toDate(r.created_at) || modified || now;
    const approved = toDate(r.approved_at);
    const lastTo = toDate(r.last_to_customer_at);
    const lastFrom = toDate(r.last_from_customer_at);
    const lastChase = toDate(r.last_chase_at);
    const parkReturnAt = toDate(r.park_returned_at);   // the day a parked quote came back: counts as a touch, so it returns as Hot
    const revivedAt = toDate(r.revived_at);   // someone pressed Re-ignite: counts as a touch, so the quote is Hot again and the 30 day clock restarts
    let lastTouch = created;
    [modified, lastTo, lastFrom, lastChase, revivedAt, parkReturnAt].forEach(d => { if (d && d > lastTouch) lastTouch = d; });
    const idle = Math.max(0, days(lastTouch, now));
    const status = r.order_status == null ? null : Number(r.order_status);
    let stage, closedAt = null, lostReason = null;
    if (status === 4) { stage = 'lost'; closedAt = modified || lastTouch; lostReason = approved ? 'Order cancelled after approval' : 'Quote cancelled'; }
    else if (approved) { stage = 'won'; closedAt = approved; }
    else if (idle >= LOST_DAYS) { stage = 'lost'; closedAt = new Date(lastTouch.getTime() + LOST_DAYS * DAY); lostReason = 'No activity for ' + LOST_DAYS + ' days'; }
    else if (idle >= COLD_DAYS) stage = 'cold';
    else if (idle >= FRESH_DAYS) stage = 'chase';
    else stage = 'fresh';
    // the customer wrote last and nobody has answered yet
    const awaitingUs = !approved && stage !== 'lost' && !!lastFrom && (!lastTo || lastFrom > lastTo) && (!lastChase || lastFrom > lastChase);
    const toClose = approved ? (approved - created) : null;
    // emails sent from ATAM GO: has the customer answered, and is the next chase due?
    const emailSentAt = toDate(r.email_sent_at), emailDueAt = toDate(r.email_due_at), emailRepliedAt = toDate(r.email_replied_at);
    const emailReplied = !!emailSentAt && (!!emailRepliedAt || (!!lastFrom && lastFrom > emailSentAt));
    const open = !approved && stage !== 'lost';
    // Expired = went quiet for 30 days (not cancelled, not approved). These are the ones a customer can come back to.
    const expired = stage === 'lost' && status !== 4 && !approved;
    const customerLastWord = !!lastFrom && (!lastTo || lastFrom > lastTo);
    const emailWaiting = open && !!emailSentAt && !emailReplied;
    const emailDue = emailWaiting && !!emailDueAt && now >= emailDueAt;
    return {
      emailNo: num(r.email_chase_no), emailSentAt, emailDueAt, emailReplied, emailWaiting, emailDue, emailSender: r.email_sender || '',
      id: String(r.order_id), decoId: r.deco_id, job: r.job_name || '', customer: r.customer_name || 'Unknown customer',
      contact: r.contact_name || '', email: r.contact_email || '', po: r.customer_po || '',
      store: r.store_name || '', rep: r.assigned_to || '',
      value: num(r.quote_value), qty: r.garment_qty, processes: r.processes || [],
      created, approved, modified, dueDate: toDate(r.date_due), shippedAt: toDate(r.date_shipped),
      lastTo, lastFrom, toCount: num(r.to_customer_count), fromCount: num(r.from_customer_count), notes: num(r.notes_count),
      lastTouch, idle, status, stage, closedAt, lostReason, awaitingUs, expired, customerLastWord,
      revivedAt, revivedBy: r.revived_by || '', revivedTimes: num(r.revived_times),
      parkReturnAt, parkReason: r.park_reason || '', parkedBy: r.parked_by || '',
      chases: num(r.chase_count), lastChaseAt: lastChase, lastChaseBy: r.last_chase_by, lastChaseNote: r.last_chase_note,
      daysToClose: toClose == null ? null : Math.max(0, toClose / DAY),
      instant: toClose != null && toClose < HOUR,
      search: [r.customer_name, r.order_id, r.assigned_to, r.job_name, r.contact_name, r.store_name, r.customer_po].join(' ').toLowerCase()
    };
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; renderBody(); }
    try {
      const now = new Date();
      state.rows = (await fetchAll()).map(r => enrich(r, now));
      try {   // quotes taken off the list by hand (shown at the bottom so they can be brought back)
        const rr = await client().from('quotes_removed_board').select('*').order('removed_at', { ascending: false });
        state.removed = rr.error ? [] : (rr.data || []);
      } catch (e) { state.removed = []; }
      try {   // quotes parked until a later date (hidden from the board until then)
        const pp = await client().from('quotes_parked_board').select('*').order('parked_until', { ascending: true });
        state.parked = pp.error ? [] : (pp.data || []);
      } catch (e) { state.parked = []; }
      state.loaded = true; state.error = null; state.updatedAt = new Date();
      if (state.rep && !state.rows.some(r => (r.rep || '__none') === state.rep)) state.rep = '';
      if (state.store && !state.rows.some(r => r.store === state.store)) state.store = '';
    } catch (e) {
      console.error('quotes load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load quotes';
    } finally {
      state.loading = false;
    }
    renderAll();
  }

  // ───────────────────────── filtering & stats ─────────────────────────
  const periodDays = () => (PERIODS.find(p => p.key === state.period) || {}).days;
  function inPeriod(d) {
    if (!d) return false;
    const n = periodDays();
    return n == null || d >= new Date(Date.now() - n * DAY);
  }
  function visibleParked() {
    return (state.parked || []).filter(p => (!state.rep || (p.assigned_to || '__none') === state.rep) && (!state.store || (p.store_name || '') === state.store)
      && (!state.q || [p.customer_name, p.order_id, p.assigned_to, p.job_name, p.contact_name, p.store_name, p.parked_by, p.reason].join(' ').toLowerCase().includes(state.q)));
  }
  function visible() {
    return state.rows.filter(r => (!state.rep || (r.rep || '__none') === state.rep) && (!state.store || r.store === state.store) && (!state.q || r.search.includes(state.q)));
  }

  function statsFor(rows) {
    const open = rows.filter(r => ['fresh', 'chase', 'cold'].includes(r.stage));
    const won = rows.filter(r => r.stage === 'won' && inPeriod(r.approved));
    const lost = rows.filter(r => r.stage === 'lost' && inPeriod(r.closedAt));
    const raised = rows.filter(r => inPeriod(r.created));
    const closed = won.length + lost.length;
    const wonValue = won.reduce((s, r) => s + r.value, 0);
    const lostValue = lost.reduce((s, r) => s + r.value, 0);
    // Orders the team keyed in and approved within the hour of creating them were never really quotes a customer
    // weighed up, so they are left out of the conversion rate and of the average time to approve.
    const wonQuotes = won.filter(r => !r.instant);
    const wonQuotesValue = wonQuotes.reduce((s, r) => s + r.value, 0);
    const decided = wonQuotes.length + lost.length;
    const slow = wonQuotes.filter(r => r.daysToClose != null);
    return {
      open, won, lost, raised, closed: decided, wonValue, lostValue, wonQuotes,
      openValue: open.reduce((s, r) => s + r.value, 0),
      raisedValue: raised.reduce((s, r) => s + r.value, 0),
      rate: decided ? wonQuotes.length / decided : null,
      valueRate: (wonQuotesValue + lostValue) ? wonQuotesValue / (wonQuotesValue + lostValue) : null,
      avgDays: slow.length ? slow.reduce((s, r) => s + r.daysToClose, 0) / slow.length : null,
      instant: won.filter(r => r.instant).length,
      chase: rows.filter(r => r.stage === 'chase'),
      cold: rows.filter(r => r.stage === 'cold'),
      waiting: open.filter(r => r.awaitingUs),
      lastRaised: rows.length ? rows.reduce((m, r) => r.created > m ? r.created : m, rows[0].created) : null
    };
  }

  // week buckets built with setDate so they stay aligned across clock changes
  const weekStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  function weekly(rows, n) {
    const cur = new Date(weekStart(new Date()));
    const weeks = Array.from({ length: n }, (_, i) => { const d = new Date(cur); d.setDate(d.getDate() - 7 * (n - 1 - i)); return d.getTime(); });
    const raised = weeks.map(() => 0), conv = weeks.map(() => 0);
    rows.forEach(r => {
      let i = weeks.indexOf(weekStart(r.created)); if (i >= 0) raised[i]++;
      if (r.approved) { i = weeks.indexOf(weekStart(r.approved)); if (i >= 0) conv[i]++; }
    });
    return { weeks, raised, conv };
  }

  function spark(vals, color, w, h) {
    w = w || 90; h = h || 26;
    const max = Math.max(1, ...vals), step = vals.length > 1 ? w / (vals.length - 1) : w;
    const pts = vals.map((v, i) => [i * step, h - 2 - (v / max) * (h - 6)]);
    const line = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    return `<svg class="qt-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${line} L${w} ${h} L0 ${h} Z" fill="${color}" opacity=".16"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function countUp(el) {
    if (!state.animate || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    el.querySelectorAll('[data-to]').forEach(n => {
      const to = Number(n.dataset.to); if (!to) return;
      const t0 = performance.now();
      (function f(t) { const p = Math.min(1, (t - t0) / 700); n.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(f); })(t0);
    });
  }

  // ───────────────────────── render ─────────────────────────
  function renderAll() {
    renderKpis(); renderControls(); renderBody(); renderRemoved(); updateNavBadge();
    const u = $('qtUpdated');
    if (u && state.updatedAt) u.textContent = 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    state.animate = false;
    if (state.openId) refreshDrawerHead();
  }

  function updateNavBadge() {
    const btn = document.querySelector('.nav-link[data-page="' + PAGE_ID + '"]');
    if (!btn) return;
    const n = state.rows.filter(r => r.stage === 'chase' || r.stage === 'cold' || r.awaitingUs).length;
    let b = btn.querySelector('.qt-nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'qt-nav-badge'; btn.appendChild(b); }
    b.textContent = n;
    b.title = n + ' quotes need chasing';
  }

  function renderKpis() {
    const el = $('qtKpis'); if (!el) return;
    const rows = visible();
    const s = statsFor(rows);
    const w = weekly(rows, 8);
    const per = (PERIODS.find(p => p.key === state.period) || {}).label.toLowerCase();
    const needs = s.chase.concat(s.cold);
    const tiles = [
      { n: s.open.length, label: 'Open quotes', sub: gbp(s.openValue) + ' on the table' },
      { n: needs.length, label: 'Need chasing', sub: s.waiting.length ? plural(s.waiting.length, 'customer') + ' waiting on a reply' : gbp(needs.reduce((t, r) => t + r.value, 0)) + ' at risk', cls: 'qt-kpi-attn' },
      { n: s.raised.length, label: 'Quotes raised', sub: gbp(s.raisedValue) + ' · ' + per, spark: spark(w.raised, '#38bdf8') },
      { n: s.won.length, label: 'Converted', sub: gbp(s.wonValue) + ' · ' + per, cls: 'qt-kpi-good', spark: spark(w.conv, '#22c55e') },
      { txt: s.rate == null ? '—' : Math.round(s.rate * 100) + '%', label: 'Conversion rate', sub: s.closed ? `${s.wonQuotes.length} won of ${s.closed} decided` + (s.instant ? ' · excl. ' + s.instant + ' keyed straight in' : '') : 'nothing decided yet' },
      { txt: fmtDays(s.avgDays), label: 'Avg days to convert', sub: 'quote → approved, excl. same-hour' }
    ];
    el.innerHTML = tiles.map((t, i) => `<div class="qt-kpi ${t.cls || ''}" style="--i:${i}">
      <div class="qt-kpi-n"${t.n != null ? ` data-to="${t.n}"` : ''}>${t.n != null ? t.n : esc(t.txt)}</div>
      <div class="qt-kpi-l">${esc(t.label)}</div><div class="qt-kpi-s">${esc(t.sub)}</div>${t.spark || ''}</div>`).join('');
    countUp(el);
  }

  function renderControls() {
    savePrefs();
    const reps = Array.from(new Set(state.rows.map(r => r.rep || '__none'))).sort((a, b) => repName(a === '__none' ? '' : a).localeCompare(repName(b === '__none' ? '' : b)));
    const sel = $('qtRep');
    if (sel) sel.innerHTML = '<option value="">Everyone</option>' + reps.map(r => `<option value="${esc(r)}"${r === state.rep ? ' selected' : ''}>${esc(r === '__none' ? 'Unassigned' : r)}</option>`).join('');
    const stores = Array.from(new Set(state.rows.map(r => r.store).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const ss = $('qtStore');
    if (ss) ss.innerHTML = '<option value="">All stores</option>' + stores.map(r => `<option value="${esc(r)}"${r === state.store ? ' selected' : ''}>${esc(r)}</option>`).join('');
    const per = $('qtPeriod');
    if (per) per.innerHTML = PERIODS.map(p => `<button type="button" data-period="${p.key}" class="${p.key === state.period ? 'on' : ''}">${esc(p.label)}</button>`).join('');
    const tabs = $('qtTabs');
    if (tabs) {
      const rows = visible();
      const count = k => k === 'pipeline' ? rows.filter(r => ['fresh', 'chase', 'cold'].includes(r.stage)).length
        : k === 'won' ? rows.filter(r => r.stage === 'won' && inPeriod(r.approved)).length
        : k === 'lost' ? rows.filter(r => r.stage === 'lost' && inPeriod(r.closedAt)).length
        : k === 'expired' ? rows.filter(r => r.expired && inPeriod(r.closedAt)).length
        : k === 'parked' ? visibleParked().length
        : k === 'all' ? rows.length : null;
      tabs.innerHTML = TABS.map(t => `<button type="button" role="tab" data-tab="${t.key}" class="qt-tab${t.key === state.tab ? ' active' : ''}">${esc(t.label)}${count(t.key) != null ? `<span class="qt-tab-n">${count(t.key)}</span>` : ''}</button>`).join('');
    }
  }

  function renderBody() {
    const el = $('qtBody'); if (!el) return;
    if (state.error) { el.innerHTML = `<div class="qt-empty">Couldn't load quotes: ${esc(state.error)}<br><button type="button" class="qt-btn" data-act="reload">Try again</button></div>`; return; }
    if (!state.loaded) {
      el.innerHTML = '<div class="qt-board" aria-busy="true">' + [0, 1, 2, 3, 4].map(() => '<section class="qt-col"><header class="qt-col-h"><div class="qt-sk" style="width:55%;height:14px"></div></header><div class="qt-col-b">' + [0, 1, 2].map(() => '<div class="qt-sk" style="height:88px"></div>').join('') + '</div></section>').join('') + '</div>';
      return;
    }
    destroyChart();
    if (!state.rows.length && !(state.parked || []).length) { el.innerHTML = '<div class="qt-empty">No quotes have been synced yet. The sync runs every 6 hours.</div>'; return; }
    if (state.tab === 'pipeline') el.innerHTML = boardHtml();
    else if (state.tab === 'team') { el.innerHTML = teamHtml(); drawChart(); }
    else if (state.tab === 'parked') el.innerHTML = parkedHtml();
    else el.innerHTML = tableHtml(state.tab);
  }

  // ----- email chase timer -----
  function leftText(ms) {
    const h = Math.max(0, Math.floor(ms / HOUR));
    return h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h >= 1 ? h + 'h' : 'under an hour';
  }
  function emailTimerHtml(r) {
    if (!r.emailSentAt || ['won', 'lost'].includes(r.stage)) return '';
    if (r.emailReplied) return `<div class="qt-timer qt-timer-ok">✉️ Chase #${r.emailNo} emailed. The customer has replied</div>`;
    if (r.emailDue) return `<div class="qt-timer qt-timer-due">⏰ Chase #${r.emailNo + 1} is due. No reply to chase #${r.emailNo}</div>`;
    const left = r.emailDueAt ? r.emailDueAt - Date.now() : REPLY_DAYS * DAY;
    return `<div class="qt-timer" title="Emailed ${esc(fmtDateTime(r.emailSentAt))} from ${esc(r.emailSender)}">✉️ Chase #${r.emailNo} emailed. Waiting for a reply: ${esc(leftText(left))} left</div>`;
  }

  // ----- pipeline board -----
  function cardHtml(r, i) {
    const open = ['fresh', 'chase', 'cold'].includes(r.stage);
    const st = STAGES[r.stage];
    const pct = Math.min(100, Math.round(r.idle / LOST_DAYS * 100));
    const needsChase = r.stage === 'chase' || r.stage === 'cold';
    let foot;
    if (open) foot = `<div class="qt-bar" title="${r.idle} of ${LOST_DAYS} days before this is treated as lost"><i style="width:${pct}%;background:${st.color}"></i></div>
      <div class="qt-card-foot"><span>Quiet ${esc(quiet(r.idle))}</span><span>${r.toCount + r.chases ? plural(r.toCount + r.chases, 'chase') : 'not chased'}</span></div>
      ${emailTimerHtml(r)}
      ${needsChase ? `<div class="qt-quick-row"><button type="button" class="qt-quick qt-mail" data-email="${esc(r.id)}" title="Write and send a chase email">✉️ ${r.emailNo ? 'Email chase #' + (r.emailNo + 1) : 'Email customer'}</button><button type="button" class="qt-quick" data-quick="${esc(r.id)}" title="Log a phone chase now">📞 Mark chased</button></div>` : ''}`;
    else if (r.stage === 'won') foot = `<div class="qt-card-foot"><span>Approved ${esc(fmtDate(r.approved))}</span><span>${r.daysToClose != null ? (r.instant ? 'same hour' : r.daysToClose < 1 ? 'same day' : Math.round(r.daysToClose) + 'd to close') : ''}</span></div>`;
    else foot = `<div class="qt-card-foot"><span>${esc(r.lostReason || 'Lost')}</span><span>${esc(fmtDate(r.closedAt))}</span></div>`;
    const parkable = !r.approved && r.status !== 4;
    const removeBtn = r.approved ? '' : `<div class="qt-remove-row">${parkable ? `<button type="button" class="qt-remove qt-parkbtn" data-park="${esc(r.id)}" title="Customer wants to wait? Hide this quote until a date you choose">💤 Park</button>` : ''}<button type="button" class="qt-remove" data-remove="${esc(r.id)}" title="Take this old quote off the list completely">🗑 Remove</button></div>`;
    return `<article class="qt-card" data-id="${esc(r.id)}" tabindex="0" style="--c:${st.color};--i:${Math.min(i || 0, 8)}">
      <div class="qt-card-top"><span class="qt-card-cust">${esc(r.customer)}</span><span class="qt-card-val">${gbp(r.value)}</span></div>
      ${r.job ? `<div class="qt-card-job">${esc(r.job)}</div>` : ''}
      <div class="qt-card-mid">${avatar(r.rep)}<span class="qt-card-rep">${esc(repName(r.rep))}</span><span class="qt-card-id">#${esc(r.id)}</span></div>
      ${r.awaitingUs ? '<div class="qt-reply">💬 Customer replied, waiting on you</div>' : ''}
      ${backFromParking(r) ? `<div class="qt-revived-tag" title="${esc(r.parkReason || 'Came back from parking')}">💤 Back from parking${r.parkReason ? ': ' + esc(r.parkReason.length > 40 ? r.parkReason.slice(0, 40) + '…' : r.parkReason) : ''}</div>` : ''}
      ${r.revivedAt && open ? `<div class="qt-revived-tag" title="Re-ignited from Expired">🔥 Re-ignited ${esc(fmtDate(r.revivedAt))}${r.revivedBy ? ' by ' + esc(r.revivedBy) : ''}</div>` : ''}
      ${foot}${removeBtn}</article>`;
  }

  function boardHtml() {
    const rows = visible();
    const recent = r => !r.closedAt || r.closedAt >= new Date(Date.now() - 30 * DAY);
    const cols = ['fresh', 'chase', 'cold', 'won', 'lost'].map(k => {
      let items = rows.filter(r => r.stage === k);
      if (k === 'won' || k === 'lost') items = items.filter(recent);
      items.sort(k === 'fresh' ? (a, b) => a.idle - b.idle || b.value - a.value
        : (k === 'won' || k === 'lost') ? (a, b) => (b.closedAt || 0) - (a.closedAt || 0)
        : (a, b) => b.idle - a.idle || b.value - a.value);
      return { k, items, total: items.reduce((s, r) => s + r.value, 0) };
    });

    // where the open money is sitting
    const openCols = cols.slice(0, 3);
    const openTotal = openCols.reduce((s, c) => s + c.total, 0);
    const funnel = openTotal > 0 ? `<div class="qt-funnel-box">
        <div class="qt-funnel" role="img" aria-label="Open quote value by stage">${openCols.filter(c => c.total > 0).map(c => `<div class="qt-fseg" style="flex:${Math.max(c.total, openTotal * 0.05)};--c:${STAGES[c.k].color}" title="${esc(STAGES[c.k].label)}: ${gbp(c.total)}"><span>${gbp(c.total)}</span></div>`).join('')}</div>
        <div class="qt-flegend">${openCols.map(c => `<span style="--c:${STAGES[c.k].color}"><i></i>${esc(STAGES[c.k].label)} · ${plural(c.items.length, 'quote')}</span>`).join('')}</div></div>` : '';

    // the quotes most worth a phone call today: customers waiting on us first, then the biggest that have gone quiet
    const urgent = rows.filter(r => r.awaitingUs || r.stage === 'chase' || r.stage === 'cold')
      .sort((a, b) => (b.awaitingUs - a.awaitingUs) || (b.value * (1 + b.idle / 14) - a.value * (1 + a.idle / 14))).slice(0, 4);
    const first = urgent.length ? `<section class="qt-first"><div class="qt-first-h"><h3>⚡ Chase these first</h3><span class="qt-dim">customers waiting on a reply, then the biggest quotes that have gone quiet</span></div>
      <div class="qt-first-row">${urgent.map((r, i) => `<article class="qt-first-card" data-id="${esc(r.id)}" tabindex="0" style="--c:${STAGES[r.stage].color};--i:${i}">
        <div class="qt-first-val">${gbp(r.value)}</div><div class="qt-first-cust">${esc(r.customer)}</div>
        ${r.awaitingUs ? '<div class="qt-reply">💬 Customer replied</div>' : ''}
        <div class="qt-first-meta">${avatar(r.rep)}<span>${esc(repName(r.rep))}</span><b>${esc(quiet(r.idle))} quiet</b></div>
        <button type="button" class="qt-quick" data-quick="${esc(r.id)}">📞 Mark chased</button></article>`).join('')}</div></section>` : '';

    return first + funnel + `<div class="qt-board">${cols.map(c => {
      const st = STAGES[c.k];
      return `<section class="qt-col" style="--c:${st.color}">
        <header class="qt-col-h"><div><span class="qt-col-t">${st.icon} ${esc(st.label)}</span><span class="qt-col-n">${c.items.length}</span></div>
          <div class="qt-col-s">${gbp(c.total)} · ${esc(c.k === 'won' || c.k === 'lost' ? 'last 30 days' : st.blurb)}</div></header>
        <div class="qt-col-b">${c.items.length ? c.items.map(cardHtml).join('') : '<div class="qt-col-empty">Nothing here</div>'}</div>
      </section>`;
    }).join('')}</div>`;
  }

  // ----- tables -----
  const COLS = {
    customer: { label: 'Customer', get: r => r.customer.toLowerCase(), html: r => `<b>${esc(r.customer)}</b>${r.job ? `<div class="qt-dim">${esc(r.job)}</div>` : ''}` },
    id: { label: 'Order', get: r => Number(r.id) || 0, html: r => '#' + esc(r.id) },
    rep: { label: 'Salesperson', get: r => repName(r.rep).toLowerCase(), html: r => `<span class="qt-rep">${avatar(r.rep)}${esc(repName(r.rep))}</span>` },
    store: { label: 'Store', get: r => r.store.toLowerCase(), html: r => esc(r.store || '—') },
    value: { label: 'Quoted', get: r => r.value, html: r => gbp(r.value, true), right: true },
    raised: { label: 'Raised', get: r => r.created.getTime(), html: r => esc(fmtDate(r.created)) },
    converted: { label: 'Approved', get: r => (r.approved || 0), html: r => esc(fmtDateTime(r.approved)) },
    lostOn: { label: 'Lost on', get: r => (r.closedAt || 0), html: r => esc(fmtDate(r.closedAt)) },
    reason: { label: 'Reason', get: r => r.lostReason || '', html: r => esc(r.lostReason || '—') },
    dtc: { label: 'Days to approve', get: r => r.daysToClose == null ? -1 : r.daysToClose, html: r => r.daysToClose == null ? '—' : r.instant ? 'Same hour' : r.daysToClose < 1 ? 'Same day' : Math.round(r.daysToClose) + 'd', right: true },
    now: { label: 'Order now', get: r => r.status || 0, html: r => esc(STATUS[r.status] || (r.status == null ? '—' : 'Status ' + r.status)) },
    stage: { label: 'Stage', get: r => Object.keys(STAGES).indexOf(r.stage), html: r => `<span class="qt-chip" style="--c:${STAGES[r.stage].color}">${STAGES[r.stage].icon} ${esc(STAGES[r.stage].label)}</span>${r.awaitingUs ? ' <span title="Customer replied, waiting on you">💬</span>' : ''}` },
    idle: { label: 'Quiet for', get: r => ['won', 'lost'].includes(r.stage) ? -1 : r.idle, html: r => ['won', 'lost'].includes(r.stage) ? '—' : esc(quiet(r.idle)), right: true },
    chases: { label: 'Chases', get: r => r.toCount + r.chases, html: r => String(r.toCount + r.chases), right: true },
    expiredOn: { label: 'Expired', get: r => (r.closedAt || 0), html: r => `${esc(fmtDate(r.closedAt))}<div class="qt-dim">${esc(ago(r.closedAt))}</div>` },
    signal: { label: 'Worth a call?', get: r => (r.customerLastWord ? 2 : 0) + (r.emailReplied ? 1 : 0), html: r => r.customerLastWord ? '<span class="qt-signal" title="The customer wrote last and nobody answered before it expired">💬 Customer replied, never answered</span>' : r.emailReplied ? '<span class="qt-signal" title="They replied to an email sent from ATAM GO">💬 Replied to our email</span>' : '<span class="qt-dim">—</span>' },
    actions: { label: '', get: () => 0, html: r => `<span class="qt-acts"><button type="button" class="qt-quick qt-fire" data-reignite="${esc(r.id)}" title="Put this quote back in the pipeline and open it in DecoNetwork so it can be reopened there">🔥 Re-ignite</button><button type="button" class="qt-quick qt-mail" data-email="${esc(r.id)}" title="Write to the customer about this expired quote">✉️ Email</button>${r.decoId ? `<a class="qt-quick" href="${DECO_ORDER_URL}${encodeURIComponent(r.decoId)}" target="_blank" rel="noopener" title="Open in DecoNetwork">↗</a>` : ''}</span>` }
  };
  const TABLE_COLS = {
    won: ['customer', 'id', 'rep', 'store', 'value', 'raised', 'converted', 'dtc', 'now'],
    lost: ['customer', 'id', 'rep', 'store', 'value', 'raised', 'lostOn', 'reason', 'chases'],
    expired: ['customer', 'id', 'rep', 'value', 'raised', 'expiredOn', 'signal', 'actions'],
    all: ['customer', 'id', 'rep', 'store', 'value', 'stage', 'raised', 'idle', 'chases']
  };

  function tableHtml(tab) {
    let rows = visible();
    if (tab === 'won') rows = rows.filter(r => r.stage === 'won' && inPeriod(r.approved));
    else if (tab === 'lost') rows = rows.filter(r => r.stage === 'lost' && inPeriod(r.closedAt));
    else if (tab === 'expired') rows = rows.filter(r => r.expired && inPeriod(r.closedAt));
    const defKey = tab === 'won' ? 'converted' : tab === 'lost' ? 'lostOn' : tab === 'expired' ? 'expiredOn' : 'idle';
    const key = state.sort.tab === tab ? state.sort.key : defKey;
    const dir = state.sort.tab === tab ? state.sort.dir : -1;
    const col = COLS[key] || COLS[defKey];
    rows = rows.slice().sort((a, b) => { const x = col.get(a), y = col.get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const cols = TABLE_COLS[tab];
    const intro = tab === 'expired' ? `<div class="qt-note qt-expired-intro"><b>Expired quotes.</b> These went quiet for ${LOST_DAYS} days, which is when DecoNetwork expires them. If a customer comes back, press <b>🔥 Re-ignite</b>: it goes back into the Pipeline as Hot and the quote opens in DecoNetwork, where it still has to be reopened (DecoNetwork cannot be changed from here). <b>✉️ Email</b> lets you write to the customer first, and sending also puts the quote back in the Pipeline.</div>` : '';
    if (!rows.length) return `${intro}<div class="qt-empty">${tab === 'won' ? 'No quotes have converted in this period.' : tab === 'lost' ? 'No lost quotes in this period.' : tab === 'expired' ? 'No expired quotes in this period. Try a longer period above.' : 'No quotes match.'}</div>`;
    const total = rows.reduce((s, r) => s + r.value, 0);
    return `${intro}<div class="qt-tablewrap"><table class="qt-table"><thead><tr>${cols.map(c => `<th data-sort="${c}" class="${COLS[c].right ? 'r' : ''}${c === key ? ' sorted' : ''}">${esc(COLS[c].label)}${c === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr data-id="${esc(r.id)}" tabindex="0">${cols.map(c => `<td class="${COLS[c].right ? 'r' : ''}">${COLS[c].html(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="qt-tfoot">${plural(rows.length, 'quote')} · ${gbp(total)} quoted</div>`;
  }

  // ----- sales team -----
  function teamStats() {
    const groups = new Map();
    state.rows.filter(r => (!state.store || r.store === state.store) && (!state.q || r.search.includes(state.q))).forEach(r => {
      const k = r.rep || '__none';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    return Array.from(groups, ([k, rows]) => ({ key: k, name: k === '__none' ? '' : k, rows, s: statsFor(rows) }))
      .sort((a, b) => b.s.raisedValue - a.s.raisedValue || b.rows.length - a.rows.length);
  }

  // Win-rate trend: the same win rate as the ring (won, not counting orders keyed straight in, divided by quotes decided, by the
  // date each was decided), for the last 7 days / 30 days / 12 months against the equal stretch just before. Shown as a change
  // in percentage points between the two rounded figures, so the numbers on screen always add up.
  const TREND_WINDOWS = [
    { key: 'week', label: 'Week', days: 7, cur: 'the last 7 days', prev: 'the 7 days before', min: 1 },
    { key: 'month', label: 'Month', days: 30, cur: 'the last 30 days', prev: 'the 30 days before', min: 1 },
    { key: 'year', label: 'Year', days: 365, cur: 'the last 12 months', prev: 'the 12 months before', min: 10 }
  ];
  function rateBetween(rows, from, to) {
    let won = 0, lost = 0;
    rows.forEach(r => {
      if (r.stage === 'won' && r.approved && r.approved >= from && r.approved < to && !r.instant) won++;
      else if (r.stage === 'lost' && r.closedAt && r.closedAt >= from && r.closedAt < to) lost++;
    });
    const n = won + lost;
    return { won, n, pct: n ? Math.round(won / n * 100) : null };
  }
  function trendHtml(rows) {
    const now = Date.now();
    return `<div class="qt-trend" aria-label="Win rate compared with the period before">${TREND_WINDOWS.map(w => {
      const len = w.days * DAY;
      const cur = rateBetween(rows, new Date(now - len), new Date(now));
      const prev = rateBetween(rows, new Date(now - 2 * len), new Date(now - len));
      const lbl = `Win rate in ${w.cur}: ${cur.pct == null ? 'nothing decided' : cur.pct + '% (' + cur.won + ' won of ' + cur.n + ' decided)'}. In ${w.prev}: ${prev.pct == null ? 'nothing decided' : prev.pct + '% (' + prev.won + ' won of ' + prev.n + ' decided)'}.`;
      if (cur.n < w.min || prev.n < w.min || cur.pct == null || prev.pct == null) {
        const why = w.key === 'year' ? 'Not enough history for a fair year-on-year yet: reliable quote data only starts around June 2026.' : 'Not enough decided quotes in one of the two periods to compare.';
        return `<span class="qt-tr qt-tr-na" title="${esc(why + ' ' + lbl)}"><b>${w.label}</b><em>—</em></span>`;
      }
      const d = cur.pct - prev.pct;
      const weak = cur.n < 5 || prev.n < 5;
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      const txt = d === 0 ? 'no change' : (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + ' pt' + (Math.abs(d) === 1 ? '' : 's');
      return `<span class="qt-tr qt-tr-${cls}${weak ? ' qt-tr-weak' : ''}" title="${esc(lbl + (weak ? ' Small numbers, so treat this change with care.' : ''))}"><b>${w.label}</b><em>${txt}</em><small>${cur.pct}% vs ${prev.pct}%${weak ? ' · few quotes' : ''}</small></span>`;
    }).join('')}</div>`;
  }

  function ringHtml(rate) {
    const pct = rate == null ? 0 : Math.round(rate * 100);
    return `<div class="qt-ring" style="--p:${pct}" title="Quotes won out of quotes decided. Orders approved within an hour of being created are left out."><div><b>${rate == null ? '—' : pct + '%'}</b><span>win rate</span></div></div>`;
  }

  function teamHtml() {
    const team = teamStats();
    if (!team.length) return '<div class="qt-empty">No quotes yet.</div>';
    const per = (PERIODS.find(p => p.key === state.period) || {}).label.toLowerCase();
    const ranked = team.filter(t => t.key !== '__none' && t.s.won.length).sort((a, b) => b.s.wonValue - a.s.wonValue).map(t => t.key);
    const medal = k => { const i = ranked.indexOf(k); return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''; };
    return `<div class="qt-chartbox"><div class="qt-chart-h"><h3>Weekly activity</h3><span class="qt-dim">quotes raised vs approved, last 12 weeks</span></div>
        <div class="qt-chart"><canvas id="qtChart" role="img" aria-label="Quotes raised and approved per week"></canvas></div></div>
      <div class="qt-team-h"><h3>Salespeople</h3><span class="qt-dim">figures for ${esc(per)} · click a card to filter the pipeline to that person</span></div>
      <div class="qt-team-trend"><span>Whole team win rate vs the period before</span>${trendHtml(state.rows.filter(r => (!state.store || r.store === state.store) && (!state.q || r.search.includes(state.q))))}</div>
      <div class="qt-team">${team.map((t, idx) => {
        const s = t.s;
        const since = s.lastRaised ? days(s.lastRaised, new Date()) : null;
        const quietFlag = since != null && since >= 7;
        const chases = t.rows.reduce((n, r) => n + r.chases + r.toCount, 0);
        const wk = weekly(t.rows, 12);
        const tot = s.won.length + s.open.length + s.lost.length;
        const m = medal(t.key);
        return `<article class="qt-rep-card${state.rep === t.key ? ' sel' : ''}" data-rep="${esc(t.key)}" tabindex="0" style="--h:${hue(t.name)};--i:${Math.min(idx, 8)}">
          <header><div class="qt-rep-id">${avatar(t.name)}<div><div class="qt-rep-name">${esc(repName(t.name))}${m ? ` <span class="qt-medal" title="Rank by converted value">${m}</span>` : ''}</div>
            <div class="qt-rep-sub${quietFlag ? ' warn' : ''}">${since == null ? 'No quotes' : 'Last quote ' + (since <= 0 ? 'today' : since === 1 ? 'yesterday' : since + ' days ago')}${quietFlag ? ' ⚠' : ''}</div></div></div>
            ${ringHtml(s.rate)}</header>
          <div class="qt-rep-grid">
            <div><b>${s.raised.length}</b><span>quotes raised</span></div>
            <div><b>${gbp(s.raisedValue)}</b><span>value quoted</span></div>
            <div><b>${s.won.length}</b><span>converted</span></div>
            <div><b>${gbp(s.wonValue)}</b><span>won value</span></div>
            <div><b>${s.open.length}</b><span>open now</span></div>
            <div class="${s.chase.length + s.cold.length ? 'warn' : ''}"><b>${s.chase.length + s.cold.length}</b><span>need chasing</span></div>
            <div><b>${s.lost.length}</b><span>lost</span></div>
            <div><b>${fmtDays(s.avgDays)}</b><span>avg to approve</span></div>
          </div>
          ${tot ? `<div class="qt-split" title="${s.won.length} converted · ${s.open.length} open · ${s.lost.length} lost">
            ${s.won.length ? `<i style="flex:${s.won.length};background:#22c55e"></i>` : ''}${s.open.length ? `<i style="flex:${s.open.length};background:#38bdf8"></i>` : ''}${s.lost.length ? `<i style="flex:${s.lost.length};background:#64748b"></i>` : ''}</div>` : ''}
          ${trendHtml(t.rows)}
          <div class="qt-spark-row">${spark(wk.raised, 'hsl(' + hue(t.name) + ' 70% 62%)', 150, 30)}<span>quotes raised per week</span></div>
          <footer><span>${s.valueRate == null ? 'No decided quotes yet' : 'By value: ' + Math.round(s.valueRate * 100) + '% won'}</span><span>${plural(chases, 'chase')} sent</span></footer>
        </article>`;
      }).join('')}</div>`;
  }

  function destroyChart() { if (state.chart) { state.chart.destroy(); state.chart = null; } }
  function drawChart() {
    const cv = $('qtChart');
    if (!cv || typeof Chart === 'undefined') return;
    const w = weekly(state.rows.filter(r => (!state.store || r.store === state.store) && (!state.q || r.search.includes(state.q))), 12);
    state.chart = new Chart(cv, {
      type: 'bar',
      data: {
        labels: w.weeks.map(x => new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
        datasets: [
          { label: 'Raised', data: w.raised, backgroundColor: 'rgba(56,189,248,.75)', borderRadius: 4 },
          { label: 'Approved', data: w.conv, backgroundColor: 'rgba(34,197,94,.85)', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 10 } } },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: '#94a3b8', precision: 0 }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
  }

  // ───────────────────────── actions: quick chase + export ─────────────────────────
  async function quickChase(id, btn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { error } = await client().rpc('log_quote_chase', { p_order_id: id, p_method: 'call', p_note: '' });
      if (error) throw error;
      toast('Chase logged. Back to Hot.');
      await load(true);
    } catch (e) {
      console.error('quick chase failed', e);
      toast('Couldn\'t log the chase: ' + ((e && e.message) || 'unknown error'), true);
      btn.disabled = false; btn.textContent = old;
    }
  }

  // ───────────────────────── removing old quotes ─────────────────────────
  // A removed quote is only hidden: its order id goes in quote_removed and the quotes_board view leaves it out (so the board, the
  // counts and DAN all stop seeing it). Nothing is deleted from DecoNetwork, and it can be brought back from the list below the board.
  // Approved quotes cannot be removed. Database: sql/quote_remove_2026-10-28.sql.
  async function removeQuote(id) {
    const r = state.rows.find(x => x.id === id);
    if (!r || state.removing) return;
    if (!window.confirm('Remove this quote from the list?\n\n' + r.customer + (r.job ? ' · ' + r.job : '') + ' · #' + r.id + ' · ' + gbp(r.value) +
      '\n\nIt will disappear from the board, the counts and DAN. It is not deleted from DecoNetwork, and you can bring it back from "Removed quotes" at the bottom of this page.')) return;
    state.removing = true;
    try {
      const { error } = await client().rpc('remove_quote', { p_order_id: id, p_reason: '' });
      if (error) throw error;
      state.rows = state.rows.filter(x => x.id !== id);
      if (state.openId === id) closeDrawer();
      renderAll();
      toast('Quote removed. You can bring it back from "Removed quotes" at the bottom.');
      await load(true);
    } catch (e) {
      console.error('remove quote failed', e);
      toast('Couldn\'t remove it: ' + ((e && e.message) || 'unknown error'), true);
    }
    state.removing = false;
  }

  // ───────────────────────── re-igniting expired quotes ─────────────────────────
  // DecoNetwork expires a quote after 30 days and its API cannot reopen one, so the quote still has to be reopened in DecoNetwork
  // by hand. Re-ignite does the part we can do: it records who re-ignited it (quote_revived), which makes the quote Hot again and
  // restarts its 30 day clock, and it opens the quote in DecoNetwork. Database: sql/quote_reignite_2026-10-29.sql.
  async function reigniteQuote(id) {
    const r = state.rows.find(x => x.id === id);
    if (!r || state.reigniting) return;
    state.reigniting = true;
    if (r.decoId) window.open(DECO_ORDER_URL + encodeURIComponent(r.decoId), '_blank', 'noopener');   // before any await, so pop-up blockers allow it
    try {
      const { error } = await client().rpc('reignite_quote', { p_order_id: id });
      if (error) throw error;
      toast('🔥 Re-ignited. It is back in the Pipeline as Hot. Now reopen it in DecoNetwork so the customer\'s link works.', false, 7000);
      await load(true);
      if (state.openId === id) { const r2 = state.rows.find(x => x.id === id); if (r2) { $('qtSheet').innerHTML = drawerHtml(r2, null); loadTimeline(id); } }
    } catch (e) {
      console.error('re-ignite failed', e);
      toast('Couldn\'t re-ignite it: ' + ((e && e.message) || 'unknown error'), true);
    }
    state.reigniting = false;
  }
  async function undoReignite(id) {
    if (state.reigniting) return;
    state.reigniting = true;
    try {
      const { error } = await client().rpc('undo_reignite_quote', { p_order_id: id });
      if (error) throw error;
      toast('Undone. If it is still quiet it goes back to Expired.');
      await load(true);
      if (state.openId === id) { const r2 = state.rows.find(x => x.id === id); if (r2) { $('qtSheet').innerHTML = drawerHtml(r2, null); loadTimeline(id); } }
    } catch (e) {
      console.error('undo re-ignite failed', e);
      toast('Couldn\'t undo it: ' + ((e && e.message) || 'unknown error'), true);
    }
    state.reigniting = false;
  }

  // ───────────────────────── parking quotes ─────────────────────────
  // "Park until a date" is for a customer who says "not yet". The quote leaves the Pipeline, the chase lists, the counts, the win rate and
  // DAN until that date, is listed on the Parked tab and on the Calendar, and comes back by itself on the day as Hot, with the reason.
  // A quote approved in DecoNetwork while parked is never hidden. Database: sql/quote_park_2026-10-30.sql.
  function backFromParking(r, days) {
    return !!r.parkReturnAt && ['fresh', 'chase', 'cold'].includes(r.stage) && (Date.now() - r.parkReturnAt.getTime()) < (days || 21) * DAY;
  }
  const ymdLocal = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDaysLocal = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  const fmtYmd = t => { const p = String(t).slice(0, 10).split('-'); return fmtDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12)); };
  const daysUntil = t => { const p = String(t).slice(0, 10).split('-'); const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12); const n = new Date(); n.setHours(12, 0, 0, 0); return Math.round((d - n) / DAY); };
  function nextJan5() { const n = new Date(); const y = (n.getMonth() === 0 && n.getDate() < 5) ? n.getFullYear() : n.getFullYear() + 1; return new Date(y, 0, 5, 12); }

  function parkFormHtml(r) {
    const tomorrow = ymdLocal(addDaysLocal(1)), max = ymdLocal(addDaysLocal(400));
    const jan = nextJan5();
    const chip = (label, d) => `<button type="button" class="qt-tone" data-park-in="${ymdLocal(d)}">${esc(label)}</button>`;
    return `<div class="qt-park-box">
      <button type="button" class="qt-btn" data-act="park-toggle" aria-expanded="false" title="Customer wants to wait? Hide this quote until a date you choose">💤 Park until a date…</button>
      <form id="qtParkForm" data-id="${esc(r.id)}" hidden>
        <p class="qt-dim">For a customer who says <b>not yet</b>. The quote leaves the Pipeline, the chase lists and the win rate, and comes back as Hot on the day you choose (it also shows on the Calendar).</p>
        <div class="qt-tones" role="group" aria-label="Quick dates"><span class="qt-dim">Bring it back in:</span>${chip('1 week', addDaysLocal(7))}${chip('2 weeks', addDaysLocal(14))}${chip('1 month', addDaysLocal(30))}${chip('3 months', addDaysLocal(91))}${chip(fmtDate(jan), jan)}</div>
        <label>Bring it back on<input id="qtParkDate" type="date" min="${tomorrow}" max="${max}" required></label>
        <label>Why? (so whoever sees it later knows)<input id="qtParkNote" type="text" maxlength="300" placeholder="e.g. Customer wants to wait until January"></label>
        <div class="qt-compose-row"><button type="submit" class="qt-btn qt-primary" id="qtParkBtn">Park this quote</button><button type="button" class="qt-btn" data-act="park-toggle">Cancel</button></div>
      </form></div>`;
  }

  async function parkQuote(form) {
    if (state.parking) return;
    const id = form.getAttribute('data-id'), until = $('qtParkDate').value, note = ($('qtParkNote').value || '').trim();
    if (!until) { toast('Choose the date to bring it back.', true); return; }
    state.parking = true;
    const btn = $('qtParkBtn'); btn.disabled = true; btn.textContent = 'Parking…';
    try {
      const { error } = await client().rpc('park_quote', { p_order_id: id, p_until: until, p_reason: note || null });
      if (error) throw error;
      toast('💤 Parked until ' + fmtYmd(until) + '. It comes back by itself that day.', false, 5000);
      closeDrawer();
      await load(true);
    } catch (e) {
      console.error('park failed', e);
      toast('Couldn\'t park it: ' + ((e && e.message) || 'unknown error'), true);
      btn.disabled = false; btn.textContent = 'Park this quote';
    }
    state.parking = false;
  }
  async function moveParked(id, until) {
    const p = (state.parked || []).find(x => x.order_id === id);
    if (!p || state.parking) return;
    if (!until) { toast('Choose a date first.', true); return; }
    state.parking = true;
    try {
      const { error } = await client().rpc('park_quote', { p_order_id: id, p_until: until, p_reason: p.reason || null });
      if (error) throw error;
      toast('Moved. It now comes back on ' + fmtYmd(until) + '.');
      await load(true);
    } catch (e) { console.error('move parked failed', e); toast('Couldn\'t change the date: ' + ((e && e.message) || 'unknown error'), true); }
    state.parking = false;
  }
  async function unparkQuote(id) {
    if (state.parking) return;
    state.parking = true;
    try {
      const { error } = await client().rpc('unpark_quote', { p_order_id: id });
      if (error) throw error;
      toast('Brought back. It is in the Pipeline again as Hot.');
      await load(true);
    } catch (e) { console.error('unpark failed', e); toast('Couldn\'t bring it back: ' + ((e && e.message) || 'unknown error'), true); }
    state.parking = false;
  }

  function parkedHtml() {
    const rows = visibleParked();
    const intro = `<div class="qt-note qt-expired-intro"><b>Parked quotes.</b> Customers who said <b>not yet</b>. They are out of the Pipeline, the chase lists, the win rate and DAN until the date shown, then they come back by themselves as Hot. To park one, open the quote and press <b>💤 Park until a date…</b>.</div>`;
    if (!rows.length) return intro + '<div class="qt-empty">Nothing is parked.</div>';
    const tomorrow = ymdLocal(addDaysLocal(1)), max = ymdLocal(addDaysLocal(400));
    const total = rows.reduce((t, p) => t + num(p.quote_value), 0);
    return `${intro}<div class="qt-tablewrap"><table class="qt-table"><thead><tr><th>Customer</th><th>Order</th><th>Salesperson</th><th class="r">Quoted</th><th>Parked</th><th>Comes back</th><th>Why</th><th></th></tr></thead><tbody>${rows.map(p => {
      const n = daysUntil(p.parked_until);
      return `<tr><td><b>${esc(p.customer_name || 'Unknown customer')}</b>${p.job_name ? `<div class="qt-dim">${esc(p.job_name)}</div>` : ''}</td>
        <td>#${esc(p.order_id)}</td>
        <td><span class="qt-rep">${avatar(p.assigned_to)}${esc(repName(p.assigned_to))}</span></td>
        <td class="r">${gbp(num(p.quote_value), true)}</td>
        <td>${esc(fmtDate(toDate(p.parked_at)))}<div class="qt-dim">${esc(p.parked_by || '')}</div></td>
        <td><b>${esc(fmtYmd(p.parked_until))}</b><div class="qt-dim">${n <= 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'}</div></td>
        <td>${p.reason ? esc(p.reason) : '<span class="qt-dim">—</span>'}</td>
        <td><span class="qt-acts qt-acts-park"><input type="date" class="qt-park-date" min="${tomorrow}" max="${max}" value="${esc(String(p.parked_until).slice(0, 10))}" aria-label="New date" data-date-for="${esc(p.order_id)}"><button type="button" class="qt-quick" data-park-move="${esc(p.order_id)}">Change date</button><button type="button" class="qt-quick qt-fire" data-unpark="${esc(p.order_id)}" title="Put it back in the Pipeline now">Bring back now</button></span></td></tr>`;
    }).join('')}</tbody></table></div><div class="qt-tfoot">${plural(rows.length, 'parked quote')} · ${gbp(total)} quoted</div>`;
  }

  async function restoreQuote(id) {
    if (state.removing) return;
    state.removing = true;
    try {
      const { error } = await client().rpc('restore_quote', { p_order_id: id });
      if (error) throw error;
      toast('Quote put back on the list.');
      await load(true);
    } catch (e) {
      console.error('restore quote failed', e);
      toast('Couldn\'t put it back: ' + ((e && e.message) || 'unknown error'), true);
    }
    state.removing = false;
  }

  function renderRemoved() {
    const el = $('qtRemoved'); if (!el) return;
    const list = state.removed || [];
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<section class="qt-removed"><button type="button" class="qt-btn" data-act="removed-toggle" aria-expanded="${state.showRemoved}">${state.showRemoved ? '−' : '+'} Removed quotes (${list.length})</button>` +
      (state.showRemoved ? `<div class="qt-tablewrap"><table class="qt-table"><thead><tr><th>Customer</th><th>Job</th><th>Quote</th><th class="r">Value</th><th>Raised</th><th>Removed by</th><th></th></tr></thead><tbody>${list.map(q =>
        `<tr><td>${esc(q.customer_name || 'Unknown customer')}</td><td>${esc(q.job_name || '')}</td><td>#${esc(q.order_id)}</td><td class="r">${gbp(Number(q.quote_value) || 0)}</td><td>${esc(fmtDate(toDate(q.created_at)))}</td>` +
        `<td>${esc(q.removed_by || '')}<div class="qt-dim">${esc(fmtDate(toDate(q.removed_at)))}</div></td><td><button type="button" class="qt-btn" data-restore="${esc(q.order_id)}">Put back</button></td></tr>`).join('')}</tbody></table></div>` : '') + '</section>';
  }

  function exportCsv() {
    const rows = visible();
    const cell = v => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const iso = d => d ? d.toISOString().slice(0, 10) : '';
    const head = ['Order', 'Customer', 'Job', 'Contact', 'Store', 'Salesperson', 'Stage', 'Quoted value (GBP)', 'Raised', 'Approved', 'Closed / lost', 'Days to approve', 'Quiet days', 'Emails sent', 'Customer replies', 'Chases logged', 'Order status now'];
    const lines = [head.map(cell).join(',')].concat(rows.map(r => [
      r.id, r.customer, r.job, r.contact, r.store, repName(r.rep), STAGES[r.stage].label, r.value.toFixed(2), iso(r.created), iso(r.approved), iso(r.stage === 'lost' ? r.closedAt : null),
      r.daysToClose == null ? '' : r.daysToClose.toFixed(1), ['won', 'lost'].includes(r.stage) ? '' : r.idle, r.toCount, r.fromCount, r.chases, STATUS[r.status] || r.status
    ].map(cell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quotes-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Exported ' + plural(rows.length, 'quote'));
  }

  // ───────────────────────── detail drawer ─────────────────────────
  function openDrawer(id) {
    const r = state.rows.find(x => x.id === id);
    if (!r) return;
    state.openId = id;
    const d = $('qtDrawer');
    d.classList.add('open');
    document.body.classList.add('qt-lock');
    $('qtSheet').innerHTML = drawerHtml(r, null);
    $('qtSheet').focus();
    loadTimeline(id);
    loadHistory(id);
  }
  function closeDrawer() {
    state.openId = null;
    const d = $('qtDrawer'); if (d) d.classList.remove('open');
    setHist('');
    document.body.classList.remove('qt-lock');
  }
  function refreshDrawerHead() {
    const r = state.rows.find(x => x.id === state.openId);
    if (!r) return;
    const tl = $('qtTimeline') ? $('qtTimeline').innerHTML : null;
    const form = { m: ($('qtMethod') || {}).value, n: ($('qtChaseNote') || {}).value };
    $('qtSheet').innerHTML = drawerHtml(r, tl);
    if ($('qtMethod') && form.m) $('qtMethod').value = form.m;
    if ($('qtChaseNote') && form.n) $('qtChaseNote').value = form.n;
  }

  function drawerHtml(r, timelineHtml) {
    const st = STAGES[r.stage];
    const open = ['fresh', 'chase', 'cold'].includes(r.stage);
    const fact = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    const link = r.decoId ? `<a class="qt-deco" href="${DECO_ORDER_URL}${encodeURIComponent(r.decoId)}" target="_blank" rel="noopener">Open in DecoNetwork ↗</a>` : '';
    return `<div class="qt-d-top" style="--c:${st.color}">
        <div><div class="qt-d-eyebrow">Quote #${esc(r.id)}${r.po ? ' · PO ' + esc(r.po) : ''}</div><h3>${esc(r.customer)}</h3>
          ${r.job ? `<div class="qt-d-job">${esc(r.job)}</div>` : ''}
          <span class="qt-chip" style="--c:${st.color}">${st.icon} ${esc(st.label)}</span>${r.lostReason ? ` <span class="qt-dim">${esc(r.lostReason)}</span>` : ''}</div>
        <button type="button" class="qt-x" data-act="close" aria-label="Close">×</button></div>
      <div class="qt-d-val">${gbp(r.value, true)}<span>quoted, ex VAT</span></div>
      ${r.awaitingUs ? '<div class="qt-reply qt-reply-lg">💬 The customer replied and nobody has answered yet</div>' : ''}
      ${link}
      ${r.expired ? `<div class="qt-expired-box"><b>⌛ This quote has expired</b>
        <p>It went quiet ${esc(quiet(r.idle))} ago${r.closedAt ? ' (expired ' + esc(fmtDate(r.closedAt)) + ')' : ''}. If the customer wants to go ahead, re-ignite it: it goes back into the Pipeline as Hot, and the quote opens in DecoNetwork where it still has to be reopened.</p>
        ${r.customerLastWord ? '<p class="qt-signal">💬 The customer wrote last and nobody answered before it expired. Worth a call.</p>' : r.emailReplied ? '<p class="qt-signal">💬 They replied to an email sent from ATAM GO.</p>' : ''}
        <button type="button" class="qt-btn qt-primary qt-fire-btn" data-reignite="${esc(r.id)}">🔥 Re-ignite and open in DecoNetwork</button></div>` : ''}
      ${backFromParking(r, 60) ? `<div class="qt-revived-box">💤 Back from parking on ${esc(fmtDate(r.parkReturnAt))}${r.parkedBy ? ' (parked by ' + esc(r.parkedBy) + ')' : ''}.${r.parkReason ? ' Reason: “' + esc(r.parkReason) + '”.' : ''} It was parked for a while, so check in DecoNetwork that the quote has not expired.</div>` : ''}
      ${r.revivedAt && open ? `<div class="qt-revived-box">🔥 Re-ignited ${esc(fmtDateTime(r.revivedAt))}${r.revivedBy ? ' by ' + esc(r.revivedBy) : ''}${r.revivedTimes > 1 ? ' (' + r.revivedTimes + ' times)' : ''}. Make sure it has been reopened in DecoNetwork so the customer's link works.
        <button type="button" class="qt-btn" data-undo-reignite="${esc(r.id)}" title="Put it back to Expired">Undo</button></div>` : ''}
      <div class="qt-facts">
        ${fact('Salesperson', `<span class="qt-rep">${avatar(r.rep)}${esc(repName(r.rep))}</span>`)}
        ${fact('Store', esc(r.store || '—'))}
        ${fact('Contact', r.contact || r.email ? esc(r.contact || '') + (r.email ? `<div class="qt-dim"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>` : '') : '—')}
        ${fact('Order status now', esc(STATUS[r.status] || (r.status == null ? '—' : 'Status ' + r.status)))}
        ${fact('Raised', esc(fmtDateTime(r.created)))}
        ${r.approved ? fact('Approved', esc(fmtDateTime(r.approved))) : fact('Quiet for', esc(quiet(r.idle)))}
        ${r.daysToClose != null ? fact('Time to approve', r.instant ? 'Within the hour' : r.daysToClose < 1 ? 'Same day' : Math.round(r.daysToClose) + ' days') : ''}
        ${fact('Garments', r.qty != null ? esc(r.qty) : '—')}
        ${fact('Decoration', r.processes.length ? esc(r.processes.join(', ')) : '—')}
        ${fact('Due', esc(fmtDate(r.dueDate)))}
        ${fact('Emails sent', String(r.toCount))}
        ${fact('Customer replies', String(r.fromCount))}
        ${fact('Chases logged', String(r.chases))}
      </div>
      ${(open || r.expired) ? parkFormHtml(r) : ''}
      ${r.approved ? '' : `<div class="qt-remove-row lg"><button type="button" class="qt-btn qt-danger" data-remove="${esc(r.id)}">🗑 Remove this quote from the list</button><span class="qt-dim">For old quotes that are never going to happen. You can bring it back later.</span></div>`}
      ${open || r.expired ? `<div class="qt-email-wrap">${emailTimerHtml(r)}<button type="button" class="qt-btn ${r.expired ? '' : 'qt-primary '}qt-mailbtn" data-act="compose" data-for="${esc(r.id)}">✉️ ${r.expired ? 'Email the customer about this expired quote' : r.emailNo ? 'Email chase #' + (r.emailNo + 1) : 'Email the customer'}</button><div id="qtCompose"></div></div>` : ''}
      ${open ? `<form class="qt-chase" id="qtChaseForm" data-id="${esc(r.id)}">
        <h4>Log a chase</h4>
        <div class="qt-chase-row">
          <select id="qtMethod" aria-label="How did you chase?"><option value="call">Phone call</option><option value="email">Email</option><option value="visit">Visit</option><option value="other">Other</option></select>
          <input id="qtChaseNote" type="text" maxlength="300" placeholder="What did they say? (optional)" aria-label="Chase note">
          <button type="submit" class="qt-btn qt-primary" id="qtChaseBtn">Log chase</button>
        </div>
        <p class="qt-dim">Emails sent from DecoNetwork count automatically. Log phone calls and visits here. Any chase resets the quiet clock.</p></form>` : ''}
      <h4 class="qt-d-h">Timeline</h4>
      <ol class="qt-timeline" id="qtTimeline">${timelineHtml != null ? timelineHtml : '<li class="qt-dim">Loading…</li>'}</ol>`;
  }

  async function loadTimeline(id) {
    const r = state.rows.find(x => x.id === id);
    let html;
    try {
      const ch = await client().from('quote_chases').select('*').eq('order_id', id).order('created_at', { ascending: true });
      if (ch.error) throw ch.error;
      const em = await client().from('quote_emails').select('chase_no,sender_email,to_email,subject,status,error,sent_at,created_at,sent_by,replied_at').eq('order_id', id);
      const items = [];
      if (r) {
        items.push({ when: r.created, icon: '📝', text: 'Quote created', cls: '' });
        if (r.lastTo) items.push({ when: r.lastTo, icon: '✉️', text: 'Last email sent to the customer' + (r.toCount > 1 ? ' (' + r.toCount + ' sent in total)' : ''), cls: '' });
        if (r.lastFrom) items.push({ when: r.lastFrom, icon: '💬', text: 'Customer last replied' + (r.fromCount > 1 ? ' (' + r.fromCount + ' replies in total)' : ''), cls: 'good' });
        if (r.modified && !r.approved) items.push({ when: r.modified, icon: '✏️', text: 'Quote last edited', cls: '' });
        if (r.approved) items.push({ when: r.approved, icon: '✅', text: 'Approved and converted into an order', cls: 'good' });
        if (r.stage === 'lost' && r.closedAt) items.push({ when: r.closedAt, icon: r.expired ? '⌛' : '✖', text: r.expired ? 'Expired (quiet for ' + LOST_DAYS + ' days)' : (r.lostReason || 'Lost'), cls: 'bad' });
        if (r.parkReturnAt) items.push({ when: r.parkReturnAt, icon: '💤', text: 'Came back from parking' + (r.parkedBy ? ' (parked by ' + r.parkedBy + ')' : '') + (r.parkReason ? ': \u201c' + r.parkReason + '\u201d' : ''), cls: 'good' });
        if (r.revivedAt) items.push({ when: r.revivedAt, icon: '🔥', text: 'Re-ignited' + (r.revivedBy ? ' by ' + r.revivedBy : ''), cls: 'good' });
      }
      ((em && em.data) || []).forEach(m => {
        if (m.status === 'sent') items.push({ when: new Date(m.sent_at), icon: '✉️', text: 'Chase #' + m.chase_no + ' emailed to ' + m.to_email + ' from ' + m.sender_email + (m.sent_by ? ' (sent by ' + m.sent_by + ')' : '') + ' — “' + m.subject + '”', cls: '' });
        else if (m.status === 'failed') items.push({ when: new Date(m.created_at), icon: '⚠️', text: 'Email to ' + m.to_email + ' did not send: ' + (m.error || 'unknown error'), cls: 'bad' });
        if (m.replied_at) items.push({ when: new Date(m.replied_at), icon: '💬', text: 'Customer replied to chase #' + m.chase_no, cls: 'good' });
      });
      (ch.data || []).filter(c => !(c.method === 'email' && /^Emailed via ATAM GO/.test(c.note || ''))).forEach(c => items.push({
        when: new Date(c.created_at), icon: c.method === 'email' ? '✉️' : c.method === 'visit' ? '🚗' : c.method === 'call' ? '📞' : '💬',
        text: 'Chased' + (c.method ? ' by ' + c.method : '') + (c.chased_by ? ' · ' + c.chased_by : '') + (c.note ? ' — “' + c.note + '”' : ''), cls: ''
      }));
      items.sort((a, b) => b.when - a.when);
      html = items.map(i => `<li class="${i.cls}"><span class="qt-tl-i">${i.icon}</span><div><div>${esc(i.text)}</div><div class="qt-dim">${esc(fmtDateTime(i.when))}</div></div></li>`).join('');
    } catch (e) {
      console.error('timeline failed', e);
      html = '<li class="qt-dim">Couldn\'t load the timeline.</li>';
    }
    if (state.openId === id && $('qtTimeline')) $('qtTimeline').innerHTML = html;
  }

  async function submitChase(form) {
    const id = form.getAttribute('data-id');
    const btn = $('qtChaseBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { error } = await client().rpc('log_quote_chase', { p_order_id: id, p_method: $('qtMethod').value, p_note: $('qtChaseNote').value });
      if (error) throw error;
      toast('Chase logged');
      await load(true);
      if (state.openId === id) { const r = state.rows.find(x => x.id === id); if (r) { $('qtSheet').innerHTML = drawerHtml(r, null); loadTimeline(id); } }
    } catch (e) {
      console.error('chase failed', e);
      toast('Couldn\'t log the chase: ' + ((e && e.message) || 'unknown error'), true);
      btn.disabled = false; btn.textContent = 'Log chase';
    }
  }

  // ───────────────────────── customer history panel ─────────────────────────
  // Fills the space beside the quote drawer with everything we know about the customer: orders, spend, money owed, what
  // they buy, their last order, other quotes, and Win-back history. Orders / invoices come from the read-only database
  // function quote_customer_history() (sql/quote_customer_history.sql), matched by company name. Quote figures come from
  // the quotes already loaded on this page.
  const HIST_TTL = 5 * 60 * 1000;
  const histCache = new Map();   // customer key -> { at, data } (every quote of one customer shares it)
  const custKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const pctChange = (a, b) => b > 0 ? Math.round((num(a) - num(b)) / num(b) * 100) : null;
  const ago = d => { if (!d) return '—'; const n = days(d, new Date()); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 60 ? n + ' days ago' : Math.round(n / 30.4) + ' months ago'; };
  const setHist = html => { const el = $('qtHist'); if (el) el.innerHTML = html; };

  async function loadHistory(id) {
    const row = state.rows.find(x => x.id === id);
    const ck = row ? custKey(row.customer) : id;
    const hit = histCache.get(ck);
    if (hit && Date.now() - hit.at < HIST_TTL) { renderHistory(id, hit.data); return; }
    setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide">Loading customer history…</div></div>');
    try {
      const res = await client().rpc('quote_customer_history', { p_order_id: id });
      if (res.error) throw res.error;
      histCache.set(ck, { at: Date.now(), data: res.data });
      renderHistory(id, res.data);
    } catch (e) {
      console.error('customer history failed', e);
      if (state.openId === id) setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide"><b>Couldn\'t load the customer history.</b> <button type="button" class="qt-btn" data-act="hist-retry">Try again</button></div></div>');
    }
  }
  function renderHistory(id, h) {
    if (state.openId !== id) return;
    const r = state.rows.find(x => x.id === id);
    if (!r) return;
    setHist(histHtml(r, h || { found: false }));
  }

  function monthChart(months) {
    const m = Array.isArray(months) ? months : [];
    if (!m.length) return '';
    const max = Math.max(1, ...m.map(x => num(x.v)));
    const W = 1000, H = 150, bw = W / m.length;
    const bars = m.map((x, i) => {
      const hh = Math.round(num(x.v) / max * (H - 30));
      const d = new Date(x.m + '-01T12:00:00');
      const name = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      // the last 12 months in bright blue and the 12 before in a muted blue-grey, so the two years can be told apart (same as the Account managers tab)
      const recent = i >= m.length - 12;
      const showYear = i === 0 || d.getMonth() === 0;
      const lab = i % 3 === 0 || i === m.length - 1 ? `<text x="${i * bw + bw / 2}" y="${H - 3}" text-anchor="middle" font-size="11" fill="#94a3b8">${esc(d.toLocaleDateString('en-GB', showYear ? { month: 'short', year: '2-digit' } : { month: 'short' }))}</text>` : '';
      return `<g><title>${esc(name)}: ${esc(gbp(x.v))} from ${plural(num(x.n), 'order')}</title><rect x="${i * bw + 3}" y="${H - 16 - hh}" width="${bw - 6}" height="${Math.max(hh, num(x.v) > 0 ? 2 : 0)}" rx="3" fill="${num(x.v) > 0 ? (recent ? '#38bdf8' : '#475569') : 'rgba(148,163,184,.25)'}"/>${lab}</g>`;
    }).join('');
    const key = '<div class="qt-dim" style="display:flex;gap:16px;margin-top:4px;font-size:12px"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#38bdf8;margin-right:5px"></i>last 12 months</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#475569;margin-right:5px"></i>the 12 before</span></div>';
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Spend by month for the last 24 months, the last 12 months in bright blue and the 12 before in grey">${bars}</svg>${key}`;
  }

  // opts (used by the Win-back tab): quotes = the customer's quotes in the shape of state.rows, noOpen = do not make quote rows clickable,
  // points = extra talking points (html) put first, top = extra card (html) put under the talking points, noun = what to call the record.
  function histHtml(r, h, opts) {
    opts = opts || {};
    if (!h.found) return `<div class="qt-hgrid"><div class="qt-hc qt-hc-wide">No customer history to show for this ${esc(opts.noun || 'quote')}.</div></div>`;
    const st = h.stats || {}, mo = h.money || {};
    const orders = num(st.orders), first = toDate(st.first_shipped), last = toDate(st.last_shipped);
    const openOrders = h.open_orders || [], recent = h.recent_orders || [], people = h.people || [], log = h.contact_log || [];
    const mine = opts.quotes || state.rows.filter(x => custKey(x.customer) === custKey(r.customer));
    const others = mine.filter(x => x.id !== r.id).sort((a, b) => b.created - a.created);
    const closed = mine.filter(x => (x.stage === 'won' && !x.instant) || x.stage === 'lost');
    const won = closed.filter(x => x.stage === 'won').length;
    const quotedTotal = mine.reduce((t, x) => t + x.value, 0);
    const openValue = openOrders.reduce((t, o) => t + num(o.value), 0), openOwed = openOrders.reduce((t, o) => t + num(o.outstanding), 0);
    const change = pctChange(st.spend_12m, st.spend_prev_12m);
    const isNew = orders === 0 && num(mo.invoiced) === 0 && !openOrders.length;

    // talking points in plain English
    const tp = (opts.points || []).slice();
    if (isNew) tp.push('🆕 <b>New customer.</b> No previous orders or invoices found under this company name.' + (others.length ? ' They have ' + plural(others.length, 'other quote') + ' with us.' : ''));
    else {
      tp.push(`🤝 <b>${esc(h.customer)}</b> has ordered ${plural(orders, 'time')} since ${esc(fmtDate(first))}, worth <b>${esc(gbp(st.spend))}</b> in total. Last order ${esc(ago(last))}.`);
      if (change != null && num(st.spend_prev_12m) > 0) tp.push(`${change >= 0 ? '📈' : '📉'} Spend in the last 12 months is <b>${esc(gbp(st.spend_12m))}</b>, ${change >= 0 ? 'up' : 'down'} <b>${Math.abs(change)}%</b> on the 12 months before (${esc(gbp(st.spend_prev_12m))}).`);
      else if (num(st.spend_12m) > 0 && !num(st.spend_prev_12m)) tp.push(`📈 All of their spend (<b>${esc(gbp(st.spend_12m))}</b>) is from the last 12 months, so they are fairly new or restarted recently.`);
      else if (!num(st.spend_12m)) tp.push('😴 <b>No orders in the last 12 months.</b> This could be a win-back.');
      if (h.avg_gap_days != null && orders > 3) tp.push(`🔁 They usually order every <b>${esc(h.avg_gap_days)}</b> day${num(h.avg_gap_days) === 1 ? '' : 's'} (between days they ordered).`);
      if ((h.reps || []).length) tp.push(`👤 Mostly handled by <b>${esc(h.reps[0].rep)}</b> (${plural(num(h.reps[0].orders), 'order')}, ${esc(gbp(h.reps[0].spend))}).`);
    }
    if (num(mo.overdue) > 0) tp.push(`⚠️ <b>${esc(gbp(mo.overdue))} is overdue</b> on invoices${mo.oldest_overdue_days ? ', the oldest by ' + esc(mo.oldest_overdue_days) + ' days' : ''}. Worth knowing before chasing a new quote.`);
    else if (num(mo.unpaid) > 0) tp.push(`💷 ${esc(gbp(mo.unpaid))} unpaid across ${plural(num(mo.unpaid_count), 'invoice')}, none overdue.`);
    else if (!isNew) tp.push('✅ Nothing owed. All invoices paid.');
    if (h.avg_days_to_pay != null) tp.push(`⏱ They typically pay about <b>${esc(h.avg_days_to_pay)} days</b> after the order ships.`);
    if (openOrders.length) tp.push(`🏭 ${plural(openOrders.length, 'order')} on the go right now, worth ${esc(gbp(openValue))}.`);
    if (closed.length >= 2) tp.push(`🎯 Of ${closed.length} earlier quotes decided, <b>${won}</b> ${won === 1 ? 'was' : 'were'} won (${Math.round(won / closed.length * 100)}%).`);

    const kpi = (label, value, sub, tone) => `<div class="qt-hk${tone ? ' ' + tone : ''}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<i>${sub}</i>` : ''}</div>`;
    const kpis = [
      kpi('Lifetime spend', esc(gbp(st.spend)), plural(orders, 'order') + (first ? ' since ' + esc(fmtDate(first)) : '')),
      kpi('Last 12 months', esc(gbp(st.spend_12m)), change != null ? (change >= 0 ? '▲ ' : '▼ ') + Math.abs(change) + '% on the year before' : 'no spend the year before', change != null ? (change >= 0 ? 'good' : 'bad') : ''),
      kpi('Orders, last 12 months', String(num(st.orders_12m)), num(st.orders_prev_12m) + ' the year before'),
      kpi('Average order', esc(gbp(st.avg_order)), 'largest ' + esc(gbp(st.largest))),
      kpi('Garments supplied', num(st.garments).toLocaleString('en-GB'), 'across all orders'),
      kpi('Last order', esc(ago(last)), esc(fmtDate(last))),
      kpi('Orders every', h.avg_gap_days != null ? esc(h.avg_gap_days) + ' days' : '—', 'typical gap between order days'),
      kpi('Owed now', esc(gbp(mo.unpaid)), plural(num(mo.unpaid_count), 'unpaid invoice'), num(mo.unpaid) > 0 ? 'warn' : ''),
      kpi('Overdue', esc(gbp(mo.overdue)), mo.oldest_overdue_days ? 'oldest ' + esc(mo.oldest_overdue_days) + ' days late' : 'nothing late', num(mo.overdue) > 0 ? 'bad' : ''),
      kpi('Usually pays in', h.avg_days_to_pay != null ? esc(h.avg_days_to_pay) + ' days' : '—', 'after the order ships'),
      kpi('Invoiced in total', esc(gbp(mo.invoiced)), 'ex VAT, from Xero'),
      kpi('Credit notes', esc(gbp(mo.credited)), 'ex VAT'),
      kpi('On the go now', plural(openOrders.length, 'order'), openOrders.length ? esc(gbp(openValue)) + ' ex VAT' + (openOwed > 0 ? ', ' + esc(gbp(openOwed)) + ' still to pay' : '') : 'none open'),
      kpi('No-charge orders', String(num(st.free_or_zero_orders)), 're-dos and samples at £0'),
      kpi('Cancelled orders', String(num(st.cancelled)), '')
    ].join('');

    const payChip = o => o.invoice_status === 'PAID' ? '<span class="qt-hpill good">Paid</span>' : o.invoice_status ? `<span class="qt-hpill warn">${num(o.invoice_due) > 0 ? esc(gbp(o.invoice_due, true)) + ' due' : esc(o.invoice_status)}</span>` : '<span class="qt-dim">—</span>';
    const proc = p => (p || []).length ? (p || []).join(', ') : '—';

    // last order
    const lo = h.last_order;
    let lastCard = '';
    if (lo) {
      const lines = h.last_order_lines || [];
      lastCard = `<section class="qt-hc qt-hc-wide"><h4>Last order <span class="qt-dim">(latest one with a charge)</span></h4>
        <div class="qt-hfacts">
          <div><span>Order</span><b>#${esc(lo.order_id)}</b></div><div><span>Shipped</span><b>${esc(fmtDate(toDate(lo.date_shipped)))}</b><i>${esc(ago(toDate(lo.date_shipped)))}</i></div>
          <div><span>Value ex VAT</span><b>${esc(gbp(lo.order_value, true))}</b></div><div><span>Garments</span><b>${esc(lo.garment_qty != null ? lo.garment_qty : '—')}</b></div>
          <div><span>Decoration</span><b>${esc(proc(lo.processes))}</b></div><div><span>Handled by</span><b>${esc(lo.assigned_to || '—')}</b></div>
          <div><span>Delivery</span><b>${esc(lo.shipping_method || '—')}</b></div><div><span>Invoiced</span><b>${esc(fmtDate(toDate(lo.date_invoiced)))}</b></div>
        </div>
        ${lines.length ? `<table class="qt-ht"><thead><tr><th>What was ordered</th><th class="r">Qty</th><th class="r">Each</th><th class="r">Line total</th></tr></thead><tbody>${lines.map(l => `<tr><td>${esc(l.desc || '')}${l.type ? ` <span class="qt-dim">${esc(l.type)}</span>` : ''}</td><td class="r">${l.qty != null ? esc(Math.round(num(l.qty) * 100) / 100) : ''}</td><td class="r">${l.unit != null ? esc(gbp(l.unit, true)) : ''}</td><td class="r">${l.net != null ? esc(gbp(l.net, true)) : ''}</td></tr>`).join('')}</tbody></table>
        <p class="qt-dim">${h.last_order_lines_from === 'invoice' ? 'Lines are from the Xero invoice for this order (ex VAT).' : 'Lines are from the DecoNetwork order (ex VAT).'}</p>` : '<p class="qt-dim">No line detail is stored for this order.</p>'}</section>`;
    }

    const openCard = openOrders.length ? `<section class="qt-hc qt-hc-wide"><h4>Orders on the go (${openOrders.length})</h4>
      <table class="qt-ht"><thead><tr><th>Order</th><th>Status</th><th>Due</th><th>Decoration</th><th>Handled by</th><th class="r">Qty</th><th class="r">Value</th><th class="r">To pay</th></tr></thead><tbody>
      ${openOrders.map(o => `<tr><td>#${esc(o.order_id)}</td><td>${esc(STATUS[o.status] || 'Status ' + o.status)}</td><td>${esc(fmtDate(toDate(o.due)))}</td><td>${esc(proc(o.processes))}</td><td>${esc(o.rep || '—')}</td><td class="r">${esc(o.qty != null ? o.qty : '—')}</td><td class="r">${esc(gbp(o.value, true))}</td><td class="r">${num(o.outstanding) > 0 ? esc(gbp(o.outstanding, true)) : '<span class="qt-dim">paid</span>'}</td></tr>`).join('')}</tbody></table>
      <p class="qt-dim">Values are ex VAT; “to pay” includes VAT.</p></section>` : '';

    const recentCard = recent.length ? `<section class="qt-hc qt-hc-wide"><h4>Recent orders <span class="qt-dim">(latest ${recent.length})</span></h4>
      <table class="qt-ht"><thead><tr><th>Shipped</th><th>Order</th><th>Decoration</th><th>Handled by</th><th class="r">Qty</th><th class="r">Value</th><th>Invoice</th><th>Payment</th></tr></thead><tbody>
      ${recent.map(o => `<tr><td>${esc(fmtDate(toDate(o.shipped)))}</td><td>#${esc(o.order_id)}</td><td>${esc(proc(o.processes))}</td><td>${esc(o.rep || '—')}</td><td class="r">${esc(o.qty != null ? o.qty : '—')}</td><td class="r">${num(o.value) > 0 ? esc(gbp(o.value, true)) : '<span class="qt-dim">£0</span>'}</td><td>${esc(o.invoice || '—')}</td><td>${payChip(o)}</td></tr>`).join('')}</tbody></table></section>` : '';

    const mix = h.product_mix || [], mixMax = Math.max(1, ...mix.map(x => num(x.value)));
    const bar = (label, val, text, w) => `<div class="qt-hbar"><span>${esc(label)}</span><div><i style="width:${Math.max(2, Math.round(w * 100))}%"></i></div><em>${text}</em></div>`;
    const buyCard = (mix.length || (h.processes || []).length || (h.reps || []).length) ? `<section class="qt-hc"><h4>What they buy and who looks after them</h4>
      ${mix.length ? `<div class="qt-hsub">Products (invoiced, ex VAT)</div>${mix.map(x => bar(x.type, 0, esc(gbp(x.value)) + ' · ' + esc(num(x.qty).toLocaleString('en-GB')) + ' pcs', num(x.value) / mixMax)).join('')}` : ''}
      ${(h.processes || []).length ? `<div class="qt-hsub">Decoration (orders)</div><div class="qt-hchips">${h.processes.map(p => `<span class="qt-hpill">${esc(p.process)} · ${num(p.orders)}</span>`).join('')}</div>` : ''}
      ${(h.reps || []).length ? `<div class="qt-hsub">Handled by (completed orders)</div>${h.reps.map(x => `<div class="qt-hrep">${avatar(x.rep)}<span>${esc(x.rep)}</span><em>${plural(num(x.orders), 'order')} · ${esc(gbp(x.spend))}</em></div>`).join('')}` : ''}</section>` : '';

    const stageChip = x => `<span class="qt-chip" style="--c:${STAGES[x.stage].color}">${STAGES[x.stage].icon} ${esc(STAGES[x.stage].label)}</span>`;
    const quotesCard = `<section class="qt-hc"><h4>Quotes with us (${mine.length})</h4>
      <div class="qt-hfacts qt-hfacts-3"><div><span>Total quoted</span><b>${esc(gbp(quotedTotal))}</b></div><div><span>Won</span><b>${won} of ${closed.length}</b><i>${closed.length ? Math.round(won / closed.length * 100) + '% of decided quotes' : 'none decided yet'}</i></div><div><span>Average quote</span><b>${esc(gbp(mine.length ? quotedTotal / mine.length : 0))}</b></div></div>
      ${others.length ? `<table class="qt-ht"><thead><tr><th>Quote</th><th>Job</th><th>Stage</th><th class="r">Value</th><th>Raised</th></tr></thead><tbody>${others.slice(0, 12).map(x => `<tr${opts.noOpen ? '' : ` class="qt-hlink" data-hist-open="${esc(x.id)}" tabindex="0" role="button" title="Open this quote"`}><td>#${esc(x.id)}</td><td>${esc(x.job || '—')}</td><td>${stageChip(x)}</td><td class="r">${esc(gbp(x.value, true))}</td><td>${esc(fmtDate(x.created))}</td></tr>`).join('')}</tbody></table>${others.length > 12 ? `<p class="qt-dim">Showing the latest 12 of ${others.length}.</p>` : ''}` : '<p class="qt-dim">This is their only quote in the synced period.</p>'}</section>`;

    // people: contacts on quotes + Win-back records
    const contactMap = new Map();
    mine.forEach(x => { const k = (x.email || x.contact || '').toLowerCase(); if (!k) return; const c = contactMap.get(k) || { name: x.contact, email: x.email, n: 0 }; c.n++; contactMap.set(k, c); });
    const contacts = [...contactMap.values()].sort((a, b) => b.n - a.n);
    const peopleCard = `<section class="qt-hc qt-hc-wide"><h4>People and Win-back</h4>
      ${contacts.length ? `<div class="qt-hsub">Contacts we have quoted</div><div class="qt-hchips">${contacts.map(c => `<span class="qt-hpill">${esc(c.name || '')}${c.email ? ` <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''} · ${plural(c.n, 'quote')}</span>`).join('')}</div>` : ''}
      ${people.length ? `<div class="qt-hsub">Customer records (reorder pattern)</div><table class="qt-ht"><thead><tr><th>Name</th><th class="r">Orders</th><th>Last order</th><th class="r">Usual gap</th><th>Status</th><th>Owner</th><th>Last contact</th></tr></thead><tbody>
        ${people.map(p => `<tr><td>${esc(p.name || '')}${p.email ? `<div class="qt-dim">${esc(p.email)}</div>` : ''}</td><td class="r">${esc(num(p.total_orders))}</td><td>${esc(fmtDate(toDate(p.last_order_date)))}</td><td class="r">${p.mean_reorder_days != null ? Math.round(num(p.mean_reorder_days)) + 'd' : '—'}</td><td>${esc(String(p.reorder_status || '—').replace(/_/g, ' '))}${num(p.overdue_by_days) > 0 ? `<div class="qt-dim">${Math.round(num(p.overdue_by_days))}d overdue</div>` : ''}</td><td>${esc(p.owner || '—')}</td><td>${p.last_contact_at ? esc(fmtDate(toDate(p.last_contact_at))) + (p.last_contact_outcome ? `<div class="qt-dim">${esc(String(p.last_contact_outcome).replace(/_/g, ' '))}</div>` : '') : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="qt-dim">No reorder record for this customer yet.</p>'}
      ${log.length ? `<div class="qt-hsub">Win-back contact log</div><ul class="qt-hlog">${log.map(l => `<li><b>${esc(fmtDate(toDate(l.at)))}</b> ${esc(l.method || '')} · ${esc(String(l.outcome || '').replace(/_/g, ' '))}${l.by ? ' · ' + esc(l.by) : ''}${l.note ? ' — “' + esc(l.note) + '”' : ''}${l.follow_up_on ? ' <span class="qt-dim">follow up ' + esc(fmtDate(toDate(l.follow_up_on))) + '</span>' : ''}</li>`).join('')}</ul>` : ''}</section>`;

    return `<div class="qt-hgrid">
      <section class="qt-hc qt-hc-wide qt-hhead"><div><div class="qt-d-eyebrow">Customer history</div><h3>${esc(h.customer)}</h3></div>${isNew ? '<span class="qt-hpill good">New customer</span>' : `<span class="qt-hpill">${first ? 'Customer since ' + esc(fmtDate(first)) : 'Existing customer'}</span>`}</section>
      <section class="qt-hc qt-hc-wide"><h4>Talking points</h4><ul class="qt-htp">${tp.map(t => `<li>${t}</li>`).join('')}</ul></section>
      ${opts.top || ''}
      <section class="qt-hc qt-hc-wide"><h4>Key numbers</h4><div class="qt-hkpis">${kpis}</div></section>
      <section class="qt-hc qt-hc-wide"><h4>Spend by month <span class="qt-dim">(last 24 months, ex VAT, by ship date)</span></h4>${monthChart(h.monthly)}</section>
      ${lastCard}${openCard}${recentCard}${buyCard}${quotesCard}${peopleCard}
      <p class="qt-dim qt-hnote">Orders and invoices are matched to this customer by company name, so a customer trading under two names may be split. Figures exclude VAT unless it says otherwise.</p></div>`;
  }

  // ───────────────────────── email the customer ─────────────────────────
  async function loadSenders() {
    if (state.senders) return state.senders;
    const res = await client().from('mail_senders').select('*').eq('active', true).order('kind').order('label');
    if (res.error) throw res.error;
    state.senders = res.data || [];
    return state.senders;
  }
  const firstName = n => (String(n || '').trim().split(/\s+/)[0] || '');
  function pickSender(list, rep) {
    return list.find(s => s.kind === 'rep' && s.rep_name && s.rep_name === rep) || list.find(s => s.kind === 'shared') || list[0];
  }
  // Ready-made wordings for the chase email. Fixed templates (no AI), filled only with facts from the quote. They never
  // promise prices, dates or expiry. Every one ends "Kind regards,\n<name>\nATAM Workwear" so the sign-off follows the From box.
  const TONES = [
    { key: 'friendly', label: 'Friendly', hint: 'warm and chatty' },
    { key: 'short', label: 'Short and direct', hint: 'two lines' },
    { key: 'formal', label: 'Formal', hint: 'polite and professional' },
    { key: 'gentle', label: 'Gentle nudge', hint: 'no pressure' },
    { key: 'helpful', label: 'Helpful', hint: 'offers changes' },
    { key: 'ready', label: 'Ready to go', hint: 'makes saying yes easy' }
  ];
  // DecoNetwork job titles are often internal notes ("E03688213 - 4002D ATR RG150 Men's black shell", "Samples for Andrew",
  // "T-shirts and Hoodies for Wetherby District Explorers Morocco Expedition 2027"), which read badly in a customer email.
  // So the job is only mentioned when its first short part clearly names a product ("T-shirts and Hoodies"); anything with a
  // code, a person's name or an internal word is left out and the email just uses the quote number.
  const JOB_WORDS = /\b(t-?shirts?|tees?|polos?|polo-?shirts?|shirts?|hoodies?|sweat(?:shirt)?s?|fleeces?|jackets?|coats?|gilets?|gillets?|bodywarmers?|softshells?|shells?|trousers?|shorts|hi[- ]?vis|caps?|hats?|beanies?|aprons?|lanyards?|helmets?|boots?|workwear|overalls?|tabards?|vests?|gloves?|bags?|towels?|mugs?|banners?|badges?)\b/i;
  const JOB_BAD = /\b(samples?|induction|quote|back ?order|ref|po|starter|replacement|re-?do|repeat|trial|test)\b/i;
  function shortJob(job) {
    const full = String(job || '').replace(/\s+/g, ' ').trim().replace(/\s+x\s*\d+$/i, '');
    let part = full.split(/\s+(?:for|-|–|—|at|on|with)\s+|[:(,/]/i)[0].trim();
    if (part.length < 3 || part.length > 34 || /\d{3,}/.test(part) || JOB_BAD.test(part) || !JOB_WORDS.test(part)) return '';
    if (part === part.toUpperCase()) part = part.toLowerCase();
    return part;
  }
  // The customer link to a quote ("…/user/quote/<code>?token=…") is made by DecoNetwork when a quote is sent, and we cannot build it,
  // so the sender pastes it in. DecoNetwork's internal links (back office "/bh/", PDF downloads, anything with a private "key=")
  // carry the system's own login key and must never go to a customer, so those are refused.
  function checkQuoteLink(raw) {
    const s = String(raw || '').replace(/\s+/g, '');
    if (!s) return { empty: true };
    let u; try { u = new URL(s); } catch (e) { return { error: 'That does not look like a web link.' }; }
    if (u.protocol !== 'https:') return { error: 'The link must start with https://' };
    if (/\/bh\/|download_|[?&]key=|user\[id\]/i.test(s)) return { error: 'That is an internal DecoNetwork link (it contains a private key), so it must not be sent to a customer. Copy the customer link from the quote instead.' };
    return { url: s, warn: /\/user\/quote\//i.test(u.pathname) ? '' : 'This does not look like a DecoNetwork customer quote link (they usually contain /user/quote/). Check it opens the quote for the customer.' };
  }
  // Shown under the message so people can see what is added when it is sent. The real footer is built in the n8n workflow
  // "Quote email send (Microsoft 365)", node "Build Email HTML": if you change the wording here, change it there too.
  const FOOTER_HTML = '<div>T: 0330 159 6344</div><div>W: www.atam.co.uk</div><div class="banner"><img src="assets/email-banner.jpg" width="450" height="150" alt="atam: all that and more, a CPI company"></div><div class="gap">All That And More, 1 First Avenue, Sherburn Industrial Park, Sherburn, Leeds, LS25 6PD</div><div>Company Registration Number: 4242875. Registered in England</div><div class="gap small">This email and any attachments may contain confidential information. If you are not the intended recipient, please let us know and delete it. All orders are subject to our standard terms and conditions.</div>';
  const DAN_REWRITE_URL = 'https://danbotv2.grobleroliver.workers.dev/rewrite';
  // A rewrite must keep the quote number, every web link and the sign-off. Returns what went missing ('' when all is kept).
  function rewriteLost(before, after) {
    const urls = before.match(/https?:\/\/\S+/g) || [];
    for (const u of urls) if (!after.includes(u)) return 'the quote link';
    const nos = before.match(/\b\d{5,}\b/g) || [];
    for (const n of nos) if (!after.includes(n)) return 'the quote number';
    const sign = before.match(/Kind regards,\n[^\n]*\nATAM Workwear\s*$/) || before.match(/Kind regards,\n[^\n]*\nCustomer Support\s*$/);
    if (sign && !after.includes(sign[0].trim())) return 'the sign-off';
    return '';
  }
  const LINK_LINE = { friendly: 'You can view the quote here:', short: 'Quote:', formal: 'You may view the quote at the following link:', gentle: "In case it helps, here's the link to the quote:", helpful: 'You can view the quote here:', ready: 'You can review the quote here:' };
  function draftEmail(r, sender, no, tone, link, expired) {
    tone = TONES.some(t => t.key === tone) ? tone : 'friendly';
    const fn = firstName(r.contact);
    const hi = fn ? 'Hi ' + fn : 'Hello';
    const sj = shortJob(r.job);
    const job = sj ? ' for ' + sj : '';
    const items = r.qty ? ` (${r.qty} item${num(r.qty) === 1 ? '' : 's'})` : '';
    const me = sender && sender.kind === 'rep' ? firstName(sender.label) : 'Customer Support';
    const first = no <= 1;
    const q = `quote #${r.id}`;
    const L = {
      friendly: first
        ? `I just wanted to follow up on the quote we sent${job} (${q}). Do you have any questions, or would you like me to go ahead and get it started?`
        : `I'm following up again on the quote${job} (${q}). I haven't heard back, so I wanted to check it reached you and see whether you'd like any changes.`,
      short: first
        ? `Just checking you received ${q}${job}. Happy to answer any questions, or to get it started when you're ready.`
        : `A quick follow-up on ${q}${job}. Is this still something you'd like to go ahead with?`,
      formal: first
        ? `${fn ? 'Dear ' + fn : 'Good day'},\n\nI am writing to follow up on ${q}${job}${items}, which we sent to you recently. Please let me know if you have any questions or would like any amendments, or if you wish to proceed.`
        : `${fn ? 'Dear ' + fn : 'Good day'},\n\nFurther to my previous email, I am following up on ${q}${job}. I would be grateful if you could let me know whether you wish to proceed, or if there is anything you would like us to revise.`,
      gentle: first
        ? `No rush at all, I just wanted to make sure ${q}${job} didn't get lost in your inbox. Whenever you've had a chance to look, I'm happy to answer any questions.`
        : `I know things get busy, so I'm just popping ${q}${job} back to the top of your inbox. If now isn't the right time, just let me know and I'll leave it with you.`,
      helpful: first
        ? `I'm following up on ${q}${job}${items}. If anything needs changing, such as quantities, colours, logo placement or sizes, just tell me and I'll update the quote for you.`
        : `I'm following up on ${q}${job}. If it isn't quite right, I'm happy to adjust it, whether that's quantities, colours, logo placement or something else. Just let me know what would help.`,
      ready: first
        ? `I'm following up on ${q}${job}${items}. If you're happy with it, just reply "yes" to this email and I'll get it started.`
        : `Just a quick reminder about ${q}${job}. If you're happy to go ahead, reply "yes" to this email and I'll get it moving.`
    };
    if (expired) {   // the quote has timed out: offer to refresh it. Still no prices, dates or promises.
      Object.assign(L, {
        friendly: `I wanted to check in about ${q}${job}. It's been a little while, so the quote has timed out on our system, but I'm very happy to refresh it for you so it's all up to date. Are you still interested in going ahead?`,
        short: `${q}${job} has timed out, but I can refresh it quickly if you'd still like to go ahead. Shall I?`,
        formal: `${fn ? 'Dear ' + fn : 'Good day'},\n\nI am writing regarding ${q}${job}${items}. As some time has passed, the quote has now expired. I would be pleased to refresh it for you if you are still considering going ahead, and would be grateful if you could let me know.`,
        gentle: `No pressure at all, but ${q}${job} is still something we'd be happy to help with. The quote has timed out, so if you'd like to pick it back up, just say and I'll refresh it.`,
        helpful: `I'm following up on ${q}${job}${items}. The quote has timed out, so I'd be glad to refresh it, and it's a good moment to change anything, such as quantities, colours, logo placement or sizes. Just tell me what would help.`,
        ready: `${q}${job}${items} has timed out, but I can refresh it straight away. If you'd like to go ahead, just reply "yes" and I'll get it reopened and moving.`
      });
    }
    const formal = tone === 'formal';
    const lk = link ? `\n\n${LINK_LINE[tone]}\n${link}` : '';
    const body = formal ? `${L.formal}${lk}\n\nKind regards,\n${me}\nATAM Workwear` : `${hi},\n\n${L[tone]}${lk}\n\nKind regards,\n${me}\nATAM Workwear`;
    const subjects = {
      friendly: (first ? 'Your quote' : 'Following up on your quote') + ' #' + r.id + (sj ? ' - ' + sj : ''),
      short: 'Quote #' + r.id + (sj ? ' - ' + sj : ''),
      formal: 'Quote #' + r.id + (sj ? ' - ' + sj : '') + (first ? '' : ' - follow-up'),
      gentle: (first ? 'Checking in on your quote' : 'Just checking in') + ' #' + r.id,
      helpful: 'Your quote' + ' #' + r.id + (sj ? ' - ' + sj : '') + ' - happy to adjust',
      ready: 'Ready when you are - quote #' + r.id + (sj ? ' - ' + sj : '')
    };
    if (expired) Object.assign(subjects, {
      friendly: 'Your quote #' + r.id + (sj ? ' - ' + sj : '') + ' - happy to refresh it',
      short: 'Quote #' + r.id + ' - still interested?',
      formal: 'Quote #' + r.id + (sj ? ' - ' + sj : '') + ' - would you like it refreshed?',
      gentle: 'Checking in on quote #' + r.id,
      helpful: 'Your quote #' + r.id + (sj ? ' - ' + sj : '') + ' - happy to update it',
      ready: 'Ready when you are - quote #' + r.id + (sj ? ' - ' + sj : '')
    });
    return { subject: subjects[tone], body };
  }

  async function openCompose(id) {
    const r = state.rows.find(x => x.id === id);
    const box = $('qtCompose');
    if (!r || !box) return;
    if (!EMAIL_SENDING_ENABLED) { box.innerHTML = '<div class="qt-note">Email sending is not switched on yet. It is waiting for the Microsoft 365 connection to be set up.</div>'; return; }
    box.innerHTML = '<div class="qt-dim">Loading…</div>';
    let list;
    try { list = await loadSenders(); } catch (e) { console.error('senders failed', e); box.innerHTML = '<div class="qt-note qt-note-bad">Couldn\'t load the sender list.</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="qt-note">No sender mailboxes have been set up yet.</div>'; return; }
    const def = pickSender(list, r.rep);
    const no = r.emailNo + 1;
    const exp = !!r.expired;
    mountCompose(box, {
      senders: list, def, to: r.email, no, kind: 'quote', linkEnabled: true, rep: r.rep,
      heading: exp ? 'Email about this expired quote' : `Chase #${no} by email`,
      footnote: exp
        ? `Sends straight away from the mailbox above. It counts as a chase, so sending also puts this quote back in the Pipeline as Hot. Nothing sends until you press Send.`
        : `Sends straight away from the mailbox above and marks this as chase #${no}. If there is no reply in ${REPLY_DAYS} days this quote shows that chase #${no + 1} is due. Nothing sends until you press Send.`,
      linkHint: exp ? 'The old customer link will not work. Reopen the quote in DecoNetwork first, then copy the new link the customer gets and paste it here.' : '',
      draft: (sender, tone, link) => draftEmail(r, sender, no, tone, link, exp),
      queue: p => client().rpc('queue_quote_email', { p_order_id: id, p_sender_id: p.senderId, p_to: p.to, p_subject: p.subject, p_body: p.body }),
      toast,
      after: async () => {
        await load(true);
        const r2 = state.rows.find(x => x.id === id);
        if (state.openId === id && r2) { $('qtSheet').innerHTML = drawerHtml(r2, null); loadTimeline(id); }
      }
    });
  }

  // The compose box. Shared with the Win-back tab (window.ATAM_QT.mountCompose), so everything that differs is in cfg:
  //   senders, def (default sender), to, no, rep, heading, footnote, linkEnabled, kind ('quote' | 'winback'),
  //   draft(sender, tone, link) -> { subject, body }, queue({ senderId, to, subject, body }) -> rpc promise,
  //   toast(msg, bad), after() -> runs once the email has been sent.
  function mountCompose(box, cfg) {
    const list = cfg.senders, def = cfg.def, no = cfg.no;
    const d = cfg.draft(def, 'friendly', '');
    const linkRow = cfg.linkEnabled ? `
      <label>Quote link (optional)<input id="qtLink" type="text" inputmode="url" autocomplete="off" placeholder="Paste the customer link copied from DecoNetwork"></label>
      <p class="qt-dim qt-linkhint" id="qtLinkHint">${esc(cfg.linkHint || 'In DecoNetwork, open the quote and copy the link the customer gets, then paste it here and it is added to the message.')}</p>` : '';
    box.innerHTML = `<form class="qt-compose" id="qtComposeForm">
      <h4>${esc(cfg.heading)}</h4>
      <div class="qt-tones" role="group" aria-label="Choose a tone for this email"><span class="qt-dim">Tone:</span>${TONES.map(t => `<button type="button" class="qt-tone${t.key === 'friendly' ? ' on' : ''}" data-tone="${esc(t.key)}" title="${esc(t.hint)}" aria-pressed="${t.key === 'friendly'}">${esc(t.label)}</button>`).join('')}<button type="button" class="qt-tone" id="qtUndo" hidden title="Put back the wording from before the last rewrite">Undo rewrite</button></div>
      <label>From<select id="qtFrom">${list.map(s => `<option value="${esc(s.id)}" data-kind="${esc(s.kind)}" data-label="${esc(s.label)}"${s.id === def.id ? ' selected' : ''}>${esc(s.label)} (${esc(s.email)})</option>`).join('')}</select></label>
      <label>To<input id="qtTo" type="email" value="${esc(cfg.to)}" placeholder="customer@example.com" required></label>
      <label>Subject<input id="qtSubject" type="text" maxlength="300" value="${esc(d.subject)}" required></label>${linkRow}
      <label>Message<textarea id="qtMsg" rows="9" required>${esc(d.body)}</textarea></label>
      <div class="qt-footer" aria-label="Footer added automatically when the email is sent"><span class="qt-dim">Added automatically under your message:</span>${FOOTER_HTML}</div>
      ${def.kind === 'shared' && cfg.rep ? `<p class="qt-dim" id="qtFromHint">${esc(cfg.rep)} has no mailbox set up, so this defaults to ${esc(def.label)}.</p>` : '<p class="qt-dim" id="qtFromHint"></p>'}
      <div class="qt-compose-row"><button type="submit" class="qt-btn qt-primary" id="qtSendBtn">Send email</button><button type="button" class="qt-btn" id="qtComposeCancel">Cancel</button></div>
      <p class="qt-dim">${esc(cfg.footnote)}</p>
    </form>`;
    const from = $('qtFrom');
    let lastGen = { subject: d.subject, body: d.body };   // what the tone buttons last wrote, so we can tell if someone has edited it
    let tone = 'friendly', shownLink = '';                // the tone in use, and the link currently written into the message
    const curLink = () => { if (!cfg.linkEnabled) return ''; const c = checkQuoteLink($('qtLink').value); return c.url || ''; };
    const senderNow = () => { const o = from.options[from.selectedIndex]; return { kind: o.dataset.kind, label: o.dataset.label }; };
    if (cfg.linkEnabled) {
      $('qtLink').addEventListener('input', () => {
        const c = checkQuoteLink($('qtLink').value), hint = $('qtLinkHint');
        hint.className = 'qt-dim qt-linkhint' + (c.error ? ' bad' : c.warn ? ' warn' : c.url ? ' ok' : '');
        hint.textContent = c.error ? c.error : c.warn ? c.warn : c.url ? 'Link added to the message.' : (cfg.linkHint || 'In DecoNetwork, open the quote and copy the link the customer gets, then paste it here and it is added to the message.');
        const next = c.url || '';
        if (next === shownLink) return;
        const msg = $('qtMsg');
        if (msg.value === lastGen.body) {            // untouched wording: write it again with the new link
          const nd = cfg.draft(senderNow(), tone, next);
          msg.value = nd.body; lastGen = { subject: $('qtSubject').value, body: nd.body };
        } else if (shownLink && msg.value.includes(shownLink)) {   // edited wording: just swap or drop our link
          msg.value = next ? msg.value.split(shownLink).join(next) : msg.value.replace(new RegExp('\\n\\n[^\\n]*\\n' + shownLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
        } else if (next) {                           // edited wording, no link yet: put it above the sign-off
          const blk = `\n\n${LINK_LINE[tone]}\n${next}`, at = msg.value.indexOf('\n\nKind regards,');
          msg.value = at >= 0 ? msg.value.slice(0, at) + blk + msg.value.slice(at) : msg.value + blk;
        }
        shownLink = next;
      });
    }
    let undo = null;   // the wording before the last AI rewrite, so it can be put back
    const setTone = b => { tone = b.dataset.tone; box.querySelectorAll('[data-tone]').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); };
    const undoBtn = () => $('qtUndo');
    box.querySelector('.qt-tones').addEventListener('click', async e => {
      const b = e.target.closest('[data-tone]'); if (!b) return;
      const msg = $('qtMsg');
      const edited = msg.value !== lastGen.body;
      if (!edited) {   // untouched template: use the fixed wording for this tone
        setTone(b); shownLink = curLink(); undo = null; undoBtn().hidden = true;
        const nd = cfg.draft(senderNow(), tone, shownLink);
        $('qtSubject').value = nd.subject; msg.value = nd.body; lastGen = { subject: nd.subject, body: nd.body };
        return;
      }
      // edited wording: ask DAN to rewrite THEIR words in this tone
      const before = msg.value, prevTone = tone, btns = box.querySelectorAll('[data-tone]');
      btns.forEach(x => { x.disabled = true; }); b.textContent = 'Rewriting…';
      const label = (TONES.find(t => t.key === b.dataset.tone) || {}).label || b.dataset.tone;
      try {
        const sess = await client().auth.getSession();
        const token = sess && sess.data && sess.data.session ? sess.data.session.access_token : '';
        const res = await fetch(DAN_REWRITE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: before, tone: b.dataset.tone }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.text) throw new Error(out.error || ('DAN said ' + res.status));
        const missing = rewriteLost(before, out.text);
        if (missing) throw new Error('the rewrite dropped ' + missing + ', so it was not used');
        undo = { text: before, tone: prevTone }; msg.value = out.text; setTone(b); shownLink = curLink();
        undoBtn().hidden = false;
      } catch (err) {
        console.error('rewrite failed', err);
        cfg.toast('Could not rewrite it, your wording is unchanged: ' + ((err && err.message) || 'unknown error'), true);
      } finally {
        btns.forEach(x => { x.disabled = false; }); b.textContent = label;
      }
    });
    $('qtUndo').addEventListener('click', () => {
      if (!undo) return;
      $('qtMsg').value = undo.text;
      const pb = box.querySelector('[data-tone="' + undo.tone + '"]'); if (pb) setTone(pb);
      shownLink = curLink(); undo = null; $('qtUndo').hidden = true;
    });
    from.addEventListener('change', () => {   // keep the sign-off name in step with the chosen sender
      const o = from.options[from.selectedIndex];
      const me = o.dataset.kind === 'rep' ? firstName(o.dataset.label) : 'Customer Support';
      $('qtMsg').value = $('qtMsg').value.replace(/Kind regards,\n[^\n]*\n/, 'Kind regards,\n' + me + '\n');
      lastGen = { subject: lastGen.subject, body: lastGen.body.replace(/Kind regards,\n[^\n]*\n/, 'Kind regards,\n' + me + '\n') };   // a sender change is not an edit
    });
    $('qtComposeCancel').addEventListener('click', () => { box.innerHTML = ''; });
    $('qtComposeForm').addEventListener('submit', e => { e.preventDefault(); send(); });
    $('qtMsg').focus();

    async function send() {
      const btn = $('qtSendBtn');
      const label = from.options[from.selectedIndex].textContent;
      if (cfg.linkEnabled) {
        const lc = checkQuoteLink(($('qtLink') || {}).value);
        if (lc.error) { cfg.toast('Not sent: ' + lc.error, true); return; }
        if (lc.url && !$('qtMsg').value.includes(lc.url) && !window.confirm('The quote link you pasted is no longer in the message. Send without it?')) return;
      }
      if (!window.confirm('Send this email to ' + $('qtTo').value.trim() + ' from ' + label + '?')) return;
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const q = await cfg.queue({ senderId: Number(from.value), to: $('qtTo').value, subject: $('qtSubject').value, body: $('qtMsg').value });
        if (q.error) throw q.error;
        const sess = await client().auth.getSession();
        const token = sess && sess.data && sess.data.session ? sess.data.session.access_token : '';
        const res = await fetch(EMAIL_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ email_id: q.data, kind: cfg.kind }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.ok === false) throw new Error(out.error || ('the sending service said ' + res.status));
        cfg.toast(cfg.kind === 'winback' ? 'Email sent. Contact logged.' : 'Email sent. Chase logged.');
        await cfg.after();
      } catch (e) {
        console.error('email failed', e);
        cfg.toast('Email not sent: ' + ((e && e.message) || 'unknown error'), true);
        btn.disabled = false; btn.textContent = 'Send email';
      }
    }
  }

  let toastTimer = null;
  function toast(msg, bad, ms) {
    const t = $('qtToast'); if (!t) return;
    t.textContent = msg; t.className = 'qt-toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'qt-toast'; }, ms || 3500);
  }

  // ───────────────────────── page shell ─────────────────────────
  function injectStyles() {
    if ($('qtStyles')) return;
    const s = document.createElement('style');
    s.id = 'qtStyles';
    s.textContent = `
#quotes .qt-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(99,102,241,.14), transparent 60%), rgba(15,23,42,.55); }
#quotes .qt-head h2 { margin:0 0 6px; font-size:28px; }
#quotes .qt-head p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#quotes .qt-head .eyebrow { margin-bottom:4px; }
#quotes .qt-updated { font-size:11.5px; color:#64748b; white-space:nowrap; padding-top:6px; }
#quotes .qt-kpis { display:grid; grid-template-columns:repeat(6,1fr); margin:22px 0 14px; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.82); overflow:hidden; }
#quotes .qt-kpi { position:relative; padding:16px 18px; border-right:1px solid rgba(255,255,255,.08); min-width:0; animation:qtUp .5s both; animation-delay:calc(var(--i,0) * 60ms); }
#quotes .qt-kpi:last-child { border-right:none; }
#quotes .qt-kpi .qt-spark { position:absolute; right:14px; top:16px; }
#quotes .qt-kpi-n { font-size:28px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
#quotes .qt-kpi-attn .qt-kpi-n { color:#fbbf24; }
#quotes .qt-kpi-good .qt-kpi-n { color:#4ade80; }
#quotes .qt-kpi-l { font-size:12.5px; color:#cbd5e1; margin-top:8px; }
#quotes .qt-kpi-s { font-size:11px; color:#64748b; margin-top:2px; }
@keyframes qtUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
#quotes .qt-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:12px; }
#quotes .qt-tabs { display:flex; gap:6px; flex-wrap:wrap; flex:1; min-width:260px; }
#quotes .qt-tab { padding:8px 14px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background:transparent; color:#94a3b8; font-size:12.5px; font-weight:600; cursor:pointer; }
#quotes .qt-tab:hover { color:#e2e8f0; border-color:rgba(255,255,255,.25); }
#quotes .qt-tab.active { background:rgba(56,189,248,.14); border-color:rgba(56,189,248,.5); color:#e0f2fe; }
#quotes .qt-tab-n { display:inline-block; min-width:18px; margin-left:6px; padding:1px 6px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; text-align:center; font-variant-numeric:tabular-nums; }
#quotes .qt-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
#quotes .qt-seg { display:inline-flex; border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
#quotes .qt-seg button { padding:7px 12px; background:transparent; border:none; border-right:1px solid rgba(255,255,255,.1); color:#94a3b8; font-size:12px; font-weight:600; cursor:pointer; }
#quotes .qt-seg button:last-child { border-right:none; }
#quotes .qt-seg button.on { background:rgba(56,189,248,.16); color:#e0f2fe; }
#quotes select, #quotes input[type=search] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:rgba(15,23,42,.9); color:#e2e8f0; font-size:12.5px; max-width:230px; }
#quotes input[type=search] { min-width:200px; }
#quotes .qt-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#quotes .qt-btn:hover { background:rgba(255,255,255,.06); }
#quotes .qt-btn:disabled { opacity:.5; cursor:default; }
#quotes .qt-primary, .qt-drawer .qt-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#quotes .qt-primary:hover, .qt-drawer .qt-primary:hover { background:linear-gradient(135deg,#38bdf8,#6366f1); opacity:.9; }
#quotes :focus-visible, .qt-drawer :focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
#quotes .qt-empty { padding:50px 20px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:14px; line-height:2; }
#quotes .qt-dim { color:#64748b; font-size:12px; }
#quotes .qt-first { margin-bottom:18px; padding:16px 18px; border-radius:16px; border:1px solid rgba(245,158,11,.28); background:linear-gradient(135deg, rgba(245,158,11,.1), rgba(15,23,42,.6) 55%); }
#quotes .qt-first-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:12px; }
#quotes .qt-first-h h3 { margin:0; font-size:15px; }
#quotes .qt-first-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
#quotes .qt-first-card { padding:13px 14px; border-radius:12px; background:rgba(2,6,23,.55); border:1px solid rgba(255,255,255,.08); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s; animation:qtUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#quotes .qt-first-card:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.25); border-left-color:var(--c); }
#quotes .qt-first-val { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
#quotes .qt-first-cust { font-size:13px; font-weight:600; margin:2px 0 8px; overflow-wrap:anywhere; }
#quotes .qt-first-meta { display:flex; align-items:center; gap:7px; font-size:11.5px; color:#94a3b8; }
#quotes .qt-first-meta > span:not(.qt-av) { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#quotes .qt-first-meta b { color:var(--c); font-weight:600; white-space:nowrap; }
#quotes .qt-reply { display:inline-block; margin:0 0 8px; padding:3px 9px; border-radius:7px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; font-size:11px; font-weight:600; }
.qt-drawer .qt-reply-lg { display:block; margin:0 0 14px; padding:9px 12px; font-size:12.5px; border-radius:10px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; }
#quotes .qt-funnel-box { margin-bottom:18px; }
#quotes .qt-funnel { display:flex; gap:4px; height:34px; }
#quotes .qt-fseg { display:flex; align-items:center; padding:0 12px; min-width:0; border-radius:8px; background:linear-gradient(90deg, color-mix(in srgb, var(--c) 70%, #020617), color-mix(in srgb, var(--c) 45%, #020617)); font-size:12px; font-weight:700; overflow:hidden; white-space:nowrap; animation:qtGrow .7s both; transform-origin:left; }
@keyframes qtGrow { from { transform:scaleX(0); opacity:0; } to { transform:none; opacity:1; } }
#quotes .qt-flegend { display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; font-size:11.5px; color:#94a3b8; }
#quotes .qt-flegend i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:6px; background:var(--c); }
#quotes .qt-board { width:0; min-width:100%; display:grid; grid-template-columns:repeat(5,minmax(205px,1fr)); gap:12px; overflow-x:auto; padding-bottom:10px; align-items:start; }
#quotes .qt-col { background:rgba(15,23,42,.6); border:1px solid rgba(255,255,255,.08); border-top:3px solid var(--c); border-radius:14px; min-width:205px; }
#quotes .qt-col-h { padding:12px 14px 10px; border-bottom:1px solid rgba(255,255,255,.06); background:linear-gradient(180deg, color-mix(in srgb, var(--c) 10%, transparent), transparent); border-radius:12px 12px 0 0; }
#quotes .qt-col-t { font-weight:700; font-size:13.5px; }
#quotes .qt-col-n { margin-left:8px; padding:1px 8px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; font-variant-numeric:tabular-nums; }
#quotes .qt-col-s { font-size:11px; color:#64748b; margin-top:4px; }
#quotes .qt-col-b { padding:10px; display:flex; flex-direction:column; gap:8px; max-height:68vh; overflow-y:auto; }
#quotes .qt-col-empty { padding:24px 0; text-align:center; color:#475569; font-size:12px; }
#quotes .qt-card { padding:11px 12px; border-radius:11px; background:rgba(30,41,59,.7); border:1px solid rgba(255,255,255,.07); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s, background .15s, box-shadow .15s; animation:qtUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#quotes .qt-card:hover { transform:translateY(-2px); background:rgba(51,65,85,.7); border-color:rgba(255,255,255,.18); border-left-color:var(--c); box-shadow:0 10px 30px rgba(0,0,0,.35), 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent); }
#quotes .qt-card-top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
#quotes .qt-card-cust { font-weight:600; font-size:13px; line-height:1.3; overflow-wrap:anywhere; }
#quotes .qt-card-job { margin-top:3px; font-size:11.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#quotes .qt-card-val { font-weight:700; font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
#quotes .qt-card-mid { display:flex; align-items:center; gap:7px; margin:8px 0; font-size:11.5px; color:#94a3b8; }
#quotes .qt-card-rep { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#quotes .qt-card-id { color:#64748b; font-variant-numeric:tabular-nums; }
#quotes .qt-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.08); overflow:hidden; }
#quotes .qt-bar i { display:block; height:100%; border-radius:2px; }
#quotes .qt-card-foot { display:flex; justify-content:space-between; gap:8px; margin-top:7px; font-size:11px; color:#94a3b8; }
#quotes .qt-quick { margin-top:9px; width:100%; padding:6px 10px; border-radius:8px; border:1px solid color-mix(in srgb, var(--c, #38bdf8) 55%, transparent); background:color-mix(in srgb, var(--c, #38bdf8) 12%, transparent); color:#f1f5f9; font-size:11.5px; font-weight:600; cursor:pointer; }
#quotes .qt-quick:hover { background:color-mix(in srgb, var(--c, #38bdf8) 26%, transparent); }
#quotes .qt-quick:disabled { opacity:.6; cursor:default; }
.qt-av { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; font-size:10px; font-weight:700; color:#fff; flex:none; }
#quotes .qt-rep { display:inline-flex; align-items:center; gap:8px; }
.qt-chip { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:600; color:var(--c); background:color-mix(in srgb, var(--c) 14%, transparent); border:1px solid color-mix(in srgb, var(--c) 40%, transparent); }
#quotes .qt-tablewrap { width:0; min-width:100%; overflow-x:auto; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); }
#quotes .qt-table { width:100%; border-collapse:collapse; font-size:13px; }
#quotes .qt-table th { text-align:left; padding:11px 14px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,.1); cursor:pointer; white-space:nowrap; user-select:none; }
#quotes .qt-table th.sorted { color:#e0f2fe; }
#quotes .qt-table td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,.05); white-space:nowrap; }
#quotes .qt-table .r, #quotes .qt-table th.r { text-align:right; font-variant-numeric:tabular-nums; }
#quotes .qt-table tbody tr { cursor:pointer; }
#quotes .qt-table tbody tr:hover { background:rgba(56,189,248,.07); }
#quotes .qt-tfoot { margin-top:10px; font-size:12px; color:#94a3b8; text-align:right; }
#quotes .qt-chartbox { border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); padding:16px 18px; margin-bottom:22px; }
#quotes .qt-chart-h, #quotes .qt-team-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:10px; }
#quotes .qt-chart-h h3, #quotes .qt-team-h h3 { margin:0; font-size:15px; }
#quotes .qt-chart { position:relative; height:220px; }
#quotes .qt-team { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
#quotes .qt-rep-card { padding:16px; border-radius:16px; border:1px solid rgba(255,255,255,.1); border-top:3px solid hsl(var(--h,200) 65% 55%); background:linear-gradient(180deg, hsl(var(--h,200) 60% 50% / .07), rgba(15,23,42,.85) 40%); cursor:pointer; transition:border-color .15s, transform .15s; animation:qtUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#quotes .qt-rep-card:hover { border-color:rgba(56,189,248,.5); transform:translateY(-2px); }
#quotes .qt-rep-card.sel { border-color:#38bdf8; box-shadow:0 0 0 1px #38bdf8 inset; }
#quotes .qt-rep-card header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
#quotes .qt-rep-id { display:flex; align-items:center; gap:10px; min-width:0; }
#quotes .qt-rep-id .qt-av { width:38px; height:38px; font-size:14px; }
#quotes .qt-rep-name { font-weight:700; font-size:15px; }
#quotes .qt-medal { font-size:15px; }
#quotes .qt-rep-sub { font-size:11.5px; color:#94a3b8; margin-top:2px; }
#quotes .qt-rep-sub.warn, #quotes .qt-rep-grid .warn b { color:#fbbf24; }
#quotes .qt-ring { --p:0; width:68px; height:68px; border-radius:50%; flex:none; display:grid; place-items:center; background:conic-gradient(#22c55e calc(var(--p) * 1%), rgba(255,255,255,.09) 0); }
#quotes .qt-ring > div { width:54px; height:54px; border-radius:50%; background:#0f172a; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.1; }
#quotes .qt-ring b { font-size:15px; }
#quotes .qt-ring span { font-size:8px; color:#94a3b8; text-transform:uppercase; letter-spacing:.04em; }
#quotes .qt-rep-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px 8px; }
#quotes .qt-rep-grid b { display:block; font-size:15px; font-variant-numeric:tabular-nums; }
#quotes .qt-rep-grid span { font-size:10.5px; color:#64748b; }
#quotes .qt-split { display:flex; gap:2px; height:6px; border-radius:3px; overflow:hidden; margin-top:14px; }
#quotes .qt-split i { display:block; }
#quotes .qt-trend { display:flex; gap:6px; margin-top:12px; }
#quotes .qt-tr { flex:1; min-width:0; padding:6px 8px; border-radius:9px; background:rgba(148,163,184,.1); border:1px solid rgba(148,163,184,.2); display:grid; gap:1px; line-height:1.25; }
#quotes .qt-tr b { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#94a3b8; font-weight:600; }
#quotes .qt-tr em { font-style:normal; font-size:12.5px; font-weight:700; color:#cbd5e1; font-variant-numeric:tabular-nums; }
#quotes .qt-tr small { font-size:10.5px; color:#94a3b8; font-variant-numeric:tabular-nums; }
#quotes .qt-tr-up { background:rgba(34,197,94,.12); border-color:rgba(34,197,94,.4); } #quotes .qt-tr-up em { color:#86efac; }
#quotes .qt-tr-down { background:rgba(244,63,94,.12); border-color:rgba(244,63,94,.4); } #quotes .qt-tr-down em { color:#fda4af; }
#quotes .qt-tr-weak { opacity:.75; border-style:dashed; }
#quotes .qt-tr-na em { color:#64748b; }
#quotes .qt-team-trend { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin:0 0 14px; padding:10px 14px; border-radius:12px; background:rgba(15,23,42,.6); border:1px solid rgba(255,255,255,.08); font-size:12.5px; color:#94a3b8; }
#quotes .qt-team-trend .qt-trend { margin:0; flex:1; min-width:260px; max-width:460px; }
#quotes .qt-spark-row { display:flex; align-items:center; gap:10px; margin-top:12px; font-size:11px; color:#64748b; }
#quotes .qt-spark-row .qt-spark { flex:none; }
#quotes .qt-rep-card footer { display:flex; justify-content:space-between; gap:8px; margin-top:14px; padding-top:11px; border-top:1px solid rgba(255,255,255,.07); font-size:11.5px; color:#94a3b8; }
#quotes .qt-sk { border-radius:10px; background:linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.1), rgba(255,255,255,.04)); background-size:200% 100%; animation:qtShim 1.3s infinite linear; }
@keyframes qtShim { from { background-position:200% 0; } to { background-position:-200% 0; } }
#quotes .qt-toast, .qt-toast { position:fixed; left:50%; bottom:26px; transform:translate(-50%,20px); opacity:0; pointer-events:none; padding:11px 18px; border-radius:10px; background:#0f172a; border:1px solid rgba(34,197,94,.5); color:#dcfce7; font-size:13px; z-index:2000; transition:all .2s; }
.qt-toast.show { opacity:1; transform:translate(-50%,0); }
.qt-toast.bad { border-color:rgba(248,113,113,.6); color:#fecaca; }
.qt-nav-badge { margin-left:8px; padding:1px 8px; border-radius:9px; background:#fbbf24; color:#1e293b; font-size:11px; font-weight:700; }
body.qt-lock { overflow:hidden; }
.qt-drawer { position:fixed; inset:0; z-index:1500; visibility:hidden; }
.qt-drawer.open { visibility:visible; }
.qt-drawer .qt-backdrop { position:absolute; inset:0; background:rgba(2,6,23,.65); backdrop-filter:blur(3px); opacity:0; transition:opacity .2s; }
.qt-drawer.open .qt-backdrop { opacity:1; }
.qt-drawer .qt-sheet { position:absolute; top:0; right:0; bottom:0; width:min(480px,100%); background:#0b1220; border-left:1px solid rgba(255,255,255,.12); padding:22px; overflow-y:auto; transform:translateX(100%); transition:transform .25s ease; outline:none; color:#f8fafc; }
.qt-drawer.open .qt-sheet { transform:none; }
.qt-drawer .qt-d-top { display:flex; justify-content:space-between; gap:12px; border-top:3px solid var(--c); margin:-22px -22px 0; padding:18px 22px 0; }
.qt-drawer .qt-d-eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#64748b; }
.qt-drawer h3 { margin:4px 0 6px; font-size:21px; line-height:1.25; overflow-wrap:anywhere; }
.qt-drawer .qt-d-job { margin:0 0 10px; font-size:13px; color:#94a3b8; }
.qt-drawer .qt-x { width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; font-size:20px; cursor:pointer; flex:none; }
.qt-drawer .qt-d-val { margin:16px 0 14px; font-size:32px; font-weight:700; font-variant-numeric:tabular-nums; }
.qt-drawer .qt-d-val span { margin-left:10px; font-size:12px; color:#94a3b8; font-weight:400; }
.qt-drawer .qt-deco { display:inline-block; margin:0 0 16px; padding:7px 12px; border-radius:8px; border:1px solid rgba(56,189,248,.45); color:#bae6fd; font-size:12.5px; font-weight:600; text-decoration:none; }
.qt-drawer .qt-deco:hover { background:rgba(56,189,248,.12); }
.qt-drawer .qt-facts { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.07); border-radius:12px; overflow:hidden; }
.qt-drawer .qt-facts > div { background:#0f172a; padding:11px 13px; min-width:0; }
.qt-drawer .qt-facts > div > span { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin-bottom:3px; }
.qt-drawer .qt-facts b { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.qt-drawer .qt-facts a { color:#7dd3fc; font-weight:400; }
.qt-drawer .qt-rep { display:inline-flex; align-items:center; gap:8px; }
.qt-drawer .qt-chase { margin-top:20px; padding:14px; border-radius:12px; background:rgba(56,189,248,.07); border:1px solid rgba(56,189,248,.25); }
.qt-drawer .qt-chase h4, .qt-drawer .qt-d-h { margin:0 0 10px; font-size:13px; }
.qt-drawer .qt-d-h { margin:22px 0 10px; }
.qt-drawer .qt-chase-row { display:flex; gap:8px; flex-wrap:wrap; }
.qt-drawer .qt-chase select, .qt-drawer .qt-chase input { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font-size:13px; }
.qt-drawer .qt-chase input { flex:1; min-width:140px; }
.qt-drawer .qt-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); background:transparent; }
.qt-drawer .qt-btn:disabled { opacity:.5; }
.qt-drawer .qt-dim { color:#64748b; font-size:12px; }
.qt-drawer .qt-chase p { margin:10px 0 0; }
.qt-drawer .qt-remove-row.lg { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:14px 0; }
.qt-drawer .qt-danger { border-color:rgba(239,68,68,.45); color:#fecaca; }
.qt-drawer .qt-danger:hover { background:rgba(239,68,68,.14); }
#quotes .qt-expired-intro { margin:0 0 12px; }
#quotes .qt-remove-row { gap:6px; }
#quotes .qt-acts-park { flex-wrap:wrap; white-space:normal; max-width:250px; justify-content:flex-end; }
#quotes .qt-parkbtn:hover, #quotes .qt-parkbtn:focus-visible { color:#c4b5fd; border-color:rgba(167,139,250,.5); background:rgba(167,139,250,.08); }
#quotes .qt-park-date, .qt-drawer #qtParkDate { padding:5px 8px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:12.5px; }
.qt-drawer .qt-park-box { margin:0 0 14px; }
.qt-drawer #qtParkForm { margin-top:10px; padding:12px 14px; border-radius:12px; border:1px solid rgba(167,139,250,.4); background:rgba(167,139,250,.07); display:grid; gap:10px; }
.qt-drawer #qtParkForm label { display:grid; gap:4px; font-size:12.5px; color:#cbd5e1; }
.qt-drawer #qtParkForm input[type=text], .qt-drawer #qtParkForm input[type=date] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:13px; }
.qt-drawer #qtParkForm p { margin:0; }
.qt-drawer #qtParkForm[hidden] { display:none; }
#quotes .qt-acts { display:inline-flex; gap:6px; align-items:center; white-space:nowrap; }
#quotes .qt-acts .qt-quick { text-decoration:none; }
#quotes .qt-fire { border-color:rgba(249,115,22,.6); color:#fdba74; }
#quotes .qt-fire:hover { background:rgba(249,115,22,.14); }
#quotes .qt-signal { color:#86efac; font-size:12px; }
#quotes .qt-revived-tag { margin-top:6px; font-size:11.5px; color:#fdba74; }
.qt-drawer .qt-expired-box, .qt-drawer .qt-revived-box { margin:0 0 14px; padding:12px 14px; border-radius:12px; font-size:13px; line-height:1.5; }
.qt-drawer .qt-expired-box { border:1px solid rgba(249,115,22,.5); background:rgba(249,115,22,.08); }
.qt-drawer .qt-expired-box p { margin:6px 0 10px; color:#cbd5e1; }
.qt-drawer .qt-expired-box .qt-signal, .qt-drawer .qt-signal { color:#86efac; }
.qt-drawer .qt-revived-box { border:1px solid rgba(34,197,94,.45); background:rgba(34,197,94,.08); color:#bbf7d0; display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; }
#quotes .qt-remove-row { display:flex; justify-content:flex-end; margin-top:6px; }
#quotes .qt-remove-row.lg { justify-content:flex-start; align-items:center; gap:10px; flex-wrap:wrap; margin:14px 0; }
#quotes .qt-remove { background:none; border:1px solid transparent; border-radius:7px; padding:2px 7px; color:#64748b; font-size:11px; cursor:pointer; transition:color .15s, border-color .15s, background .15s; }
#quotes .qt-remove:hover, #quotes .qt-remove:focus-visible { color:#fca5a5; border-color:rgba(239,68,68,.5); background:rgba(239,68,68,.08); }
#quotes .qt-danger { border-color:rgba(239,68,68,.45); color:#fecaca; }
#quotes .qt-danger:hover { background:rgba(239,68,68,.14); }
#quotes .qt-removed { margin-top:22px; padding-top:14px; border-top:1px dashed rgba(255,255,255,.12); }
#quotes .qt-removed .qt-tablewrap { margin-top:12px; }
#quotes .qt-quick-row { display:flex; gap:6px; }
#quotes .qt-quick-row .qt-quick { flex:1; width:auto; }
#quotes .qt-quick.qt-mail { --c:#f97316; }
#quotes .qt-timer { margin-top:8px; padding:6px 9px; border-radius:8px; font-size:11.5px; line-height:1.4; background:rgba(148,163,184,.12); color:#cbd5e1; }
#quotes .qt-timer-due { background:rgba(244,63,94,.16); color:#fecdd3; font-weight:600; }
#quotes .qt-timer-ok { background:rgba(34,197,94,.14); color:#bbf7d0; }
.qt-drawer .qt-email-wrap { margin-top:18px; }
.qt-drawer .qt-email-wrap .qt-timer { margin:0 0 10px; padding:8px 11px; border-radius:8px; font-size:12.5px; background:rgba(148,163,184,.12); color:#cbd5e1; }
.qt-drawer .qt-email-wrap .qt-timer-due { background:rgba(244,63,94,.16); color:#fecdd3; font-weight:600; }
.qt-drawer .qt-email-wrap .qt-timer-ok { background:rgba(34,197,94,.14); color:#bbf7d0; }
.qt-drawer .qt-mailbtn { width:100%; }
.qt-drawer .qt-note { margin-top:10px; padding:10px 12px; border-radius:10px; font-size:12.5px; line-height:1.5; background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.3); color:#fde68a; }
.qt-drawer .qt-note-bad { background:rgba(244,63,94,.1); border-color:rgba(244,63,94,.3); color:#fecdd3; }
.qt-drawer .qt-compose { margin-top:12px; padding:14px; border-radius:12px; background:rgba(249,115,22,.07); border:1px solid rgba(249,115,22,.3); display:grid; gap:10px; }
.qt-drawer .qt-compose h4 { margin:0; font-size:13px; }
.qt-drawer .qt-compose label { display:grid; gap:4px; font-size:12px; color:#94a3b8; }
.qt-drawer .qt-compose select, .qt-drawer .qt-compose input, .qt-drawer .qt-compose textarea { padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font:inherit; font-size:13px; width:100%; box-sizing:border-box; }
.qt-drawer .qt-compose textarea { resize:vertical; line-height:1.5; min-height:150px; }
.qt-drawer .qt-compose p { margin:0; }
.qt-drawer .qt-footer { font-size:11px; line-height:1.5; color:#94a3b8; border-left:2px solid rgba(255,255,255,.15); padding:2px 0 2px 10px; } .qt-drawer .qt-footer .banner img { display:block; max-width:100%; height:auto; margin:4px 0 8px; border-radius:2px; } .qt-drawer .qt-footer .gap { margin-top:6px; } .qt-drawer .qt-footer .small { font-size:10px; opacity:.85; }
.qt-drawer .qt-linkhint { margin:-4px 0 0; } .qt-drawer .qt-linkhint.bad { color:#fda4af; } .qt-drawer .qt-linkhint.warn { color:#fde68a; } .qt-drawer .qt-linkhint.ok { color:#86efac; }
.qt-drawer .qt-tones { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.qt-drawer .qt-tone { padding:5px 11px; border-radius:999px; font-size:12px; font-weight:600; cursor:pointer; color:#cbd5e1; border:1px solid rgba(255,255,255,.18); background:transparent; }
.qt-drawer .qt-tone:hover { background:rgba(249,115,22,.12); }
.qt-drawer .qt-tone.on { color:#fff; background:rgba(249,115,22,.28); border-color:rgba(249,115,22,.7); }
.qt-drawer .qt-compose-row { display:flex; gap:8px; }
.qt-drawer .qt-timeline { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px; }
.qt-drawer .qt-timeline li { display:flex; gap:11px; font-size:13px; line-height:1.4; }
.qt-drawer .qt-timeline li.good { color:#86efac; } .qt-drawer .qt-timeline li.bad { color:#fca5a5; }
.qt-drawer .qt-tl-i { width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,.07); display:grid; place-items:center; font-size:12px; flex:none; }
@media (max-width: 1100px) { #quotes .qt-kpis { grid-template-columns:repeat(3,1fr); } #quotes .qt-kpi:nth-child(3n) { border-right:none; } #quotes .qt-kpi:nth-child(-n+3) { border-bottom:1px solid rgba(255,255,255,.08); } }
@media (max-width: 640px) { #quotes .qt-head { padding:16px; flex-direction:column; } #quotes .qt-kpi .qt-spark { display:none; }
  #quotes .qt-kpis { grid-template-columns:repeat(2,1fr); } #quotes .qt-kpi:nth-child(3n) { border-right:1px solid rgba(255,255,255,.08); } #quotes .qt-kpi:nth-child(2n) { border-right:none; } #quotes .qt-kpi { border-bottom:1px solid rgba(255,255,255,.08); }
  #quotes .qt-board { grid-template-columns:repeat(5,82vw); scroll-snap-type:x mandatory; } #quotes .qt-col { scroll-snap-align:start; }
  #quotes input[type=search] { min-width:0; flex:1; } .qt-drawer .qt-facts { grid-template-columns:1fr; } }
/* customer history panel: fills the space left of the quote drawer on wide screens */
.qt-drawer .qt-hist { display:none; position:absolute; top:0; bottom:0; left:0; right:calc(min(480px,100%) + 44px); padding:22px 26px 22px 22px; overflow-y:auto; pointer-events:none; opacity:0; transform:translateX(24px); transition:opacity .25s .05s, transform .25s .05s; color:#f8fafc; }
.qt-drawer.open .qt-hist { opacity:1; transform:none; }
@media (min-width: 1180px) { .qt-drawer .qt-hist { display:block; } }
.qt-hist .qt-hgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:14px; max-width:1100px; margin-left:auto; align-items:start; }
.qt-hist .qt-hc { pointer-events:auto; background:rgba(11,18,32,.94); border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:16px 18px; min-width:0; box-shadow:0 8px 28px rgba(0,0,0,.35); }
.qt-hist .qt-hc-wide { grid-column:1/-1; }
.qt-hist h3 { margin:2px 0 0; font-size:22px; overflow-wrap:anywhere; }
.qt-hist h4 { margin:0 0 12px; font-size:13.5px; }
.qt-hist .qt-d-eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#64748b; }
.qt-hist .qt-dim { color:#64748b; font-size:12px; font-weight:400; }
.qt-hist .qt-hhead { display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:3px solid #38bdf8; }
.qt-hist .qt-hpill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:600; background:rgba(148,163,184,.14); border:1px solid rgba(148,163,184,.3); color:#cbd5e1; margin:0 6px 6px 0; }
.qt-hist .qt-hpill.good { background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.4); color:#bbf7d0; }
.qt-hist .qt-hpill.warn { background:rgba(245,158,11,.14); border-color:rgba(245,158,11,.4); color:#fde68a; }
.qt-hist .qt-hpill a { color:#7dd3fc; }
.qt-hist .qt-htp { margin:0; padding:0; list-style:none; display:grid; gap:9px; font-size:13.5px; line-height:1.5; color:#e2e8f0; }
.qt-hist .qt-hkpis { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; }
.qt-hist .qt-hk { background:#0f172a; border:1px solid rgba(255,255,255,.07); border-radius:10px; padding:11px 13px; min-width:0; }
.qt-hist .qt-hk span, .qt-hist .qt-hfacts span { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin-bottom:3px; }
.qt-hist .qt-hk b { display:block; font-size:19px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.qt-hist .qt-hk i, .qt-hist .qt-hfacts i { display:block; font-style:normal; font-size:11.5px; color:#94a3b8; margin-top:2px; }
.qt-hist .qt-hk.good b { color:#86efac; } .qt-hist .qt-hk.bad b { color:#fca5a5; } .qt-hist .qt-hk.warn b { color:#fde68a; }
.qt-hist .qt-hfacts { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
.qt-hist .qt-hfacts-3 { grid-template-columns:repeat(3,1fr); }
.qt-hist .qt-hfacts > div { background:#0f172a; border:1px solid rgba(255,255,255,.07); border-radius:10px; padding:10px 12px; min-width:0; }
.qt-hist .qt-hfacts b { font-size:13.5px; overflow-wrap:anywhere; }
.qt-hist .qt-ht { width:100%; border-collapse:collapse; font-size:12.5px; }
.qt-hist .qt-ht th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; font-weight:600; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.1); }
.qt-hist .qt-ht td { padding:7px 8px; border-bottom:1px solid rgba(255,255,255,.06); vertical-align:top; }
.qt-hist .qt-ht .r { text-align:right; font-variant-numeric:tabular-nums; }
.qt-hist .qt-hlink { cursor:pointer; } .qt-hist .qt-hlink:hover td, .qt-hist .qt-hlink:focus-visible td { background:rgba(56,189,248,.1); }
.qt-hist .qt-hsub { margin:14px 0 8px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#64748b; }
.qt-hist .qt-hsub:first-of-type { margin-top:0; }
.qt-hist .qt-hbar { display:grid; grid-template-columns:130px 1fr auto; gap:10px; align-items:center; font-size:12.5px; margin-bottom:6px; }
.qt-hist .qt-hbar > div { height:8px; background:rgba(255,255,255,.07); border-radius:4px; overflow:hidden; } .qt-hist .qt-hbar i { display:block; height:100%; background:linear-gradient(90deg,#38bdf8,#6366f1); }
.qt-hist .qt-hbar em { font-style:normal; color:#94a3b8; font-size:12px; white-space:nowrap; }
.qt-hist .qt-hrep { display:flex; align-items:center; gap:8px; font-size:12.5px; margin-bottom:6px; } .qt-hist .qt-hrep em { margin-left:auto; font-style:normal; color:#94a3b8; }
.qt-hist .qt-hlog { margin:0; padding-left:18px; font-size:12.5px; line-height:1.55; color:#cbd5e1; }
.qt-hist .qt-hnote { grid-column:1/-1; margin:0; pointer-events:none; }
.qt-hist .qt-btn { padding:6px 12px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); background:transparent; margin-left:8px; }
.qt-hist .qt-hc:focus-within, .qt-hist :focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
@media (prefers-reduced-motion: reduce) { .qt-drawer .qt-hist { transition:none !important; } }
@media (prefers-reduced-motion: reduce) { #quotes *, #quotes *::before, #quotes *::after, .qt-drawer .qt-sheet, .qt-drawer .qt-backdrop { animation:none !important; transition:none !important; } }
`;
    // The email box is also used inside the Win-back and New customers drawers (.wb-drawer, .nc-drawer), so give it the same styling there.
    const boxRules = s.textContent.split('\n').filter(l => /^\.qt-drawer \.qt-(compose|tone|footer|linkhint|note|btn|dim|email-wrap|mailbtn)/.test(l));
    ['.wb-drawer', '.nc-drawer'].forEach(d => {
      s.textContent += '\n' + boxRules.map(l => l.replace(/\.qt-drawer /g, d + ' ')).join('\n');
      s.textContent += '\n' + d + ' .qt-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }';
    });
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="salesinvoices"]') || document.querySelector('.nav-link[data-page]');
    const anchorPage = $('salesinvoices') || document.querySelector('.dashboard-page');
    if (!anchorBtn || !anchorPage) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>🎯 Quotes</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `
      <div class="qt-head">
        <div>
          <p class="eyebrow">Sales</p>
          <h2>Quotes</h2>
          <p>Every DecoNetwork quote from the day it is created to the day the customer approves it. Anything quiet for 3 days needs chasing, and a quote with no activity for 30 days is treated as lost. Emails sent from DecoNetwork count as chases automatically. Synced every 6 hours.</p>
        </div>
        <div class="qt-updated" id="qtUpdated" aria-live="polite"></div>
      </div>
      <div class="qt-kpis" id="qtKpis"></div>
      <div class="qt-toolbar"><div class="qt-tabs" id="qtTabs" role="tablist"></div></div>
      <div class="qt-tools">
        <div class="qt-seg" id="qtPeriod" role="group" aria-label="Period"></div>
        <select id="qtRep" aria-label="Salesperson"><option value="">Everyone</option></select>
        <select id="qtStore" aria-label="Store"><option value="">All stores</option></select>
        <input type="search" id="qtSearch" placeholder="Search customer, order, job or salesperson" aria-label="Search quotes">
        <button type="button" class="qt-btn" data-act="reload">Refresh</button>
        <button type="button" class="qt-btn" data-act="export">⬇ Export CSV</button>
      </div>
      <div id="qtBody"><div class="qt-empty">Loading quotes…</div></div>
      <div id="qtRemoved"></div>
      <div class="qt-toast" id="qtToast" role="status"></div>`;
    anchorPage.parentElement.appendChild(sec);

    const drawer = document.createElement('div');
    drawer.className = 'qt-drawer';
    drawer.id = 'qtDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Quote details');
    drawer.innerHTML = '<div class="qt-backdrop" data-act="close"></div><aside class="qt-hist" id="qtHist" aria-label="Customer history"></aside><div class="qt-sheet" id="qtSheet" tabindex="-1"></div>';
    document.body.appendChild(drawer);

    // app.js binds its nav buttons once at startup, so it does not know about this page.
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      state.animate = true;
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); closeDrawer(); clearInterval(state.timer); }
    }, true);

    // page events
    sec.addEventListener('click', e => {
      const fire = e.target.closest('[data-reignite]');
      if (fire) { e.stopPropagation(); reigniteQuote(fire.dataset.reignite); return; }
      const prk = e.target.closest('[data-park]');
      if (prk) { e.stopPropagation(); openDrawer(prk.dataset.park); setTimeout(() => { const t = document.querySelector('#qtSheet [data-act="park-toggle"]'); if (t) t.click(); }, 0); return; }
      const unp = e.target.closest('[data-unpark]');
      if (unp) { e.stopPropagation(); unparkQuote(unp.dataset.unpark); return; }
      const mvp = e.target.closest('[data-park-move]');
      if (mvp) { e.stopPropagation(); const inp = mvp.parentElement.querySelector('.qt-park-date'); moveParked(mvp.dataset.parkMove, inp && inp.value); return; }
      if (e.target.closest('input.qt-park-date')) { e.stopPropagation(); return; }
      if (e.target.closest('a.qt-quick')) { e.stopPropagation(); return; }
      const rmv = e.target.closest('[data-remove]');
      if (rmv) { e.stopPropagation(); removeQuote(rmv.dataset.remove); return; }
      const rst = e.target.closest('[data-restore]');
      if (rst) { e.stopPropagation(); restoreQuote(rst.dataset.restore); return; }
      if (e.target.closest('[data-act="removed-toggle"]')) { state.showRemoved = !state.showRemoved; renderRemoved(); return; }
      const quick = e.target.closest('[data-quick]');
      if (quick) { e.stopPropagation(); quickChase(quick.dataset.quick, quick); return; }
      const mail = e.target.closest('[data-email]');
      if (mail) { e.stopPropagation(); openDrawer(mail.dataset.email); setTimeout(() => { const b = document.querySelector('[data-act="compose"]'); if (b) b.click(); }, 0); return; }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'reload') { load(); return; }
      if (act && act.dataset.act === 'export') { exportCsv(); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; renderControls(); renderBody(); return; }
      const per = e.target.closest('[data-period]');
      if (per) { state.period = per.dataset.period; renderAll(); return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        state.sort = { tab: state.tab, key: k, dir: state.sort.tab === state.tab && state.sort.key === k ? -state.sort.dir : (k === 'customer' || k === 'rep' || k === 'store' ? 1 : -1) };
        renderBody(); return;
      }
      const repCard = e.target.closest('[data-rep]');
      if (repCard) { const k = repCard.dataset.rep; state.rep = state.rep === k ? '' : k; if (state.rep) state.tab = 'pipeline'; renderAll(); return; }
      const item = e.target.closest('[data-id]');
      if (item) openDrawer(item.dataset.id);
    });
    sec.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('[data-quick], [data-email], [data-remove], [data-restore], [data-reignite], [data-park], [data-unpark], [data-park-move], input')) return;
      const item = e.target.closest('.qt-card[data-id], .qt-first-card[data-id], tr[data-id]');
      if (item) { e.preventDefault(); openDrawer(item.dataset.id); return; }
      const repCard = e.target.closest('.qt-rep-card');
      if (repCard) { e.preventDefault(); repCard.click(); }
    });
    $('qtRep').addEventListener('change', e => { state.rep = e.target.value; renderAll(); });
    $('qtStore').addEventListener('change', e => { state.store = e.target.value; renderAll(); });
    $('qtSearch').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderKpis(); renderControls(); renderBody(); });

    drawer.addEventListener('click', e => {
      const fire = e.target.closest('[data-reignite]');
      if (fire) { reigniteQuote(fire.dataset.reignite); return; }
      const und = e.target.closest('[data-undo-reignite]');
      if (und) { undoReignite(und.dataset.undoReignite); return; }
      const ptg = e.target.closest('[data-act="park-toggle"]');
      if (ptg) {
        const f = $('qtParkForm'); if (!f) return;
        f.hidden = !f.hidden;
        const tb = document.querySelector('#qtSheet .qt-park-box > [data-act="park-toggle"]'); if (tb) tb.setAttribute('aria-expanded', String(!f.hidden));
        if (!f.hidden) { f.scrollIntoView({ block: 'nearest' }); const d = $('qtParkDate'); if (d) d.focus(); }
        return;
      }
      const pin = e.target.closest('[data-park-in]');
      if (pin) { const d = $('qtParkDate'); if (d) { d.value = pin.dataset.parkIn; d.focus(); } return; }
      const rmv = e.target.closest('[data-remove]');
      if (rmv) { removeQuote(rmv.dataset.remove); return; }
      if (e.target.closest('[data-act="close"]')) closeDrawer();
      const c = e.target.closest('[data-act="compose"]');
      if (c) openCompose(c.dataset.for);
      const ho = e.target.closest('[data-hist-open]');
      if (ho) openDrawer(ho.dataset.histOpen);
      if (e.target.closest('[data-act="hist-retry"]') && state.openId) { const rr = state.rows.find(x => x.id === state.openId); if (rr) histCache.delete(custKey(rr.customer)); loadHistory(state.openId); }
    });
    drawer.addEventListener('keydown', e => {
      const ho = e.target.closest && e.target.closest('[data-hist-open]');
      if (ho && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(ho.dataset.histOpen); }
    });
    drawer.addEventListener('submit', e => {
      if (e.target.id === 'qtChaseForm') { e.preventDefault(); submitChase(e.target); }
      if (e.target.id === 'qtParkForm') { e.preventDefault(); parkQuote(e.target); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.openId) closeDrawer(); });

    renderControls();
    return true;
  }

  function boot() {
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.QuotesPage = { reload: () => load(), state };
  // shared with the Win-back tab
  // (enrich + STAGES are also used by the Account managers tab so quote stages are worked out in one place)
  window.ATAM_QT = { mountCompose, loadSenders, pickSender, firstName, TONES, JOB_WORDS, histHtml, ago, enrich, STAGES, DECO_ORDER_URL, emailEnabled: () => EMAIL_SENDING_ENABLED };
})();
