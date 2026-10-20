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
  // Email chasing goes out through the n8n workflow "quote-email-send" (Microsoft 365). Keep this false until that
  // workflow is built, tested and published, then flip it to true.
  const EMAIL_SENDING_ENABLED = false;
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
    { key: 'team', label: 'Sales team' },
    { key: 'won', label: 'Converted' },
    { key: 'lost', label: 'Lost' },
    { key: 'all', label: 'All quotes' }
  ];

  const state = {
    rows: [], loaded: false, loading: false, error: null,
    tab: 'pipeline', period: '90', rep: '', store: '', q: '',
    sort: { key: 'idle', dir: -1 },
    chart: null, timer: null, openId: null, senders: null, composeOpen: false, animate: true, updatedAt: null
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
    let lastTouch = created;
    [modified, lastTo, lastFrom, lastChase].forEach(d => { if (d && d > lastTouch) lastTouch = d; });
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
      lastTouch, idle, status, stage, closedAt, lostReason, awaitingUs,
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
    renderKpis(); renderControls(); renderBody(); updateNavBadge();
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
    if (!state.rows.length) { el.innerHTML = '<div class="qt-empty">No quotes have been synced yet. The sync runs every 6 hours.</div>'; return; }
    if (state.tab === 'pipeline') el.innerHTML = boardHtml();
    else if (state.tab === 'team') { el.innerHTML = teamHtml(); drawChart(); }
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
    return `<article class="qt-card" data-id="${esc(r.id)}" tabindex="0" style="--c:${st.color};--i:${Math.min(i || 0, 8)}">
      <div class="qt-card-top"><span class="qt-card-cust">${esc(r.customer)}</span><span class="qt-card-val">${gbp(r.value)}</span></div>
      ${r.job ? `<div class="qt-card-job">${esc(r.job)}</div>` : ''}
      <div class="qt-card-mid">${avatar(r.rep)}<span class="qt-card-rep">${esc(repName(r.rep))}</span><span class="qt-card-id">#${esc(r.id)}</span></div>
      ${r.awaitingUs ? '<div class="qt-reply">💬 Customer replied, waiting on you</div>' : ''}
      ${foot}</article>`;
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
    chases: { label: 'Chases', get: r => r.toCount + r.chases, html: r => String(r.toCount + r.chases), right: true }
  };
  const TABLE_COLS = {
    won: ['customer', 'id', 'rep', 'store', 'value', 'raised', 'converted', 'dtc', 'now'],
    lost: ['customer', 'id', 'rep', 'store', 'value', 'raised', 'lostOn', 'reason', 'chases'],
    all: ['customer', 'id', 'rep', 'store', 'value', 'stage', 'raised', 'idle', 'chases']
  };

  function tableHtml(tab) {
    let rows = visible();
    if (tab === 'won') rows = rows.filter(r => r.stage === 'won' && inPeriod(r.approved));
    else if (tab === 'lost') rows = rows.filter(r => r.stage === 'lost' && inPeriod(r.closedAt));
    const defKey = tab === 'won' ? 'converted' : tab === 'lost' ? 'lostOn' : 'idle';
    const key = state.sort.tab === tab ? state.sort.key : defKey;
    const dir = state.sort.tab === tab ? state.sort.dir : -1;
    const col = COLS[key] || COLS[defKey];
    rows = rows.slice().sort((a, b) => { const x = col.get(a), y = col.get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const cols = TABLE_COLS[tab];
    if (!rows.length) return `<div class="qt-empty">${tab === 'won' ? 'No quotes have converted in this period.' : tab === 'lost' ? 'No lost quotes in this period.' : 'No quotes match.'}</div>`;
    const total = rows.reduce((s, r) => s + r.value, 0);
    return `<div class="qt-tablewrap"><table class="qt-table"><thead><tr>${cols.map(c => `<th data-sort="${c}" class="${COLS[c].right ? 'r' : ''}${c === key ? ' sorted' : ''}">${esc(COLS[c].label)}${c === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
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
  }
  function closeDrawer() {
    state.openId = null;
    const d = $('qtDrawer'); if (d) d.classList.remove('open');
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
      ${open ? `<div class="qt-email-wrap">${emailTimerHtml(r)}<button type="button" class="qt-btn qt-primary qt-mailbtn" data-act="compose" data-for="${esc(r.id)}">✉️ ${r.emailNo ? 'Email chase #' + (r.emailNo + 1) : 'Email the customer'}</button><div id="qtCompose"></div></div>` : ''}
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
        if (r.stage === 'lost' && r.closedAt) items.push({ when: r.closedAt, icon: '✖', text: r.lostReason || 'Lost', cls: 'bad' });
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
  function draftEmail(r, sender, no) {
    const hi = firstName(r.contact) ? 'Hi ' + firstName(r.contact) : 'Hello';
    const job = r.job ? ' for ' + r.job : '';
    const me = sender && sender.kind === 'rep' ? firstName(sender.label) : 'The ATAM Workwear team';
    const line = no <= 1
      ? `I just wanted to follow up on the quote we sent${job} (quote #${r.id}). Do you have any questions, or would you like me to go ahead and get it started?`
      : `I'm following up again on the quote${job} (quote #${r.id}). I haven't heard back, so I wanted to check it reached you and see whether you'd like any changes before it expires.`;
    return {
      subject: (no <= 1 ? 'Your quote' : 'Following up on your quote') + ' #' + r.id + (r.job ? ' - ' + r.job : ''),
      body: `${hi},\n\n${line}\n\nKind regards,\n${me}\nATAM Workwear`
    };
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
    const d = draftEmail(r, def, no);
    box.innerHTML = `<form class="qt-compose" id="qtComposeForm" data-id="${esc(r.id)}">
      <h4>Chase #${no} by email</h4>
      <label>From<select id="qtFrom">${list.map(s => `<option value="${esc(s.id)}" data-kind="${esc(s.kind)}" data-label="${esc(s.label)}"${s.id === def.id ? ' selected' : ''}>${esc(s.label)} (${esc(s.email)})</option>`).join('')}</select></label>
      <label>To<input id="qtTo" type="email" value="${esc(r.email)}" placeholder="customer@example.com" required></label>
      <label>Subject<input id="qtSubject" type="text" maxlength="300" value="${esc(d.subject)}" required></label>
      <label>Message<textarea id="qtMsg" rows="9" required>${esc(d.body)}</textarea></label>
      ${def.kind === 'shared' && r.rep ? `<p class="qt-dim" id="qtFromHint">${esc(r.rep)} has no mailbox set up, so this defaults to ${esc(def.label)}.</p>` : '<p class="qt-dim" id="qtFromHint"></p>'}
      <div class="qt-compose-row"><button type="submit" class="qt-btn qt-primary" id="qtSendBtn">Send email</button><button type="button" class="qt-btn" data-act="compose-cancel">Cancel</button></div>
      <p class="qt-dim">Sends straight away from the mailbox above and marks this as chase #${no}. If there is no reply in ${REPLY_DAYS} days this quote shows that chase #${no + 1} is due. Nothing sends until you press Send.</p>
    </form>`;
    const from = $('qtFrom');
    from.addEventListener('change', () => {   // keep the sign-off name in step with the chosen sender
      const o = from.options[from.selectedIndex];
      const me = o.dataset.kind === 'rep' ? firstName(o.dataset.label) : 'The ATAM Workwear team';
      $('qtMsg').value = $('qtMsg').value.replace(/Kind regards,\n[^\n]*\n/, 'Kind regards,\n' + me + '\n');
    });
    $('qtMsg').focus();
  }

  async function sendEmail(form) {
    const id = form.getAttribute('data-id');
    const btn = $('qtSendBtn');
    const from = $('qtFrom');
    const label = from.options[from.selectedIndex].textContent;
    if (!window.confirm('Send this email to ' + $('qtTo').value.trim() + ' from ' + label + '?')) return;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const q = await client().rpc('queue_quote_email', { p_order_id: id, p_sender_id: Number(from.value), p_to: $('qtTo').value, p_subject: $('qtSubject').value, p_body: $('qtMsg').value });
      if (q.error) throw q.error;
      const sess = await client().auth.getSession();
      const token = sess && sess.data && sess.data.session ? sess.data.session.access_token : '';
      const res = await fetch(EMAIL_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ email_id: q.data }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.ok === false) throw new Error(out.error || ('the sending service said ' + res.status));
      toast('Email sent. Chase logged.');
      await load(true);
      const r = state.rows.find(x => x.id === id);
      if (state.openId === id && r) { $('qtSheet').innerHTML = drawerHtml(r, null); loadTimeline(id); }
    } catch (e) {
      console.error('email failed', e);
      toast('Email not sent: ' + ((e && e.message) || 'unknown error'), true);
      btn.disabled = false; btn.textContent = 'Send email';
    }
  }

  let toastTimer = null;
  function toast(msg, bad) {
    const t = $('qtToast'); if (!t) return;
    t.textContent = msg; t.className = 'qt-toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'qt-toast'; }, 3500);
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
@media (prefers-reduced-motion: reduce) { #quotes *, #quotes *::before, #quotes *::after, .qt-drawer .qt-sheet, .qt-drawer .qt-backdrop { animation:none !important; transition:none !important; } }
`;
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
      <div class="qt-toast" id="qtToast" role="status"></div>`;
    anchorPage.parentElement.appendChild(sec);

    const drawer = document.createElement('div');
    drawer.className = 'qt-drawer';
    drawer.id = 'qtDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Quote details');
    drawer.innerHTML = '<div class="qt-backdrop" data-act="close"></div><div class="qt-sheet" id="qtSheet" tabindex="-1"></div>';
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
      if (e.target.closest('[data-quick], [data-email]')) return;
      const item = e.target.closest('.qt-card[data-id], .qt-first-card[data-id], tr[data-id]');
      if (item) { e.preventDefault(); openDrawer(item.dataset.id); return; }
      const repCard = e.target.closest('.qt-rep-card');
      if (repCard) { e.preventDefault(); repCard.click(); }
    });
    $('qtRep').addEventListener('change', e => { state.rep = e.target.value; renderAll(); });
    $('qtStore').addEventListener('change', e => { state.store = e.target.value; renderAll(); });
    $('qtSearch').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderKpis(); renderControls(); renderBody(); });

    drawer.addEventListener('click', e => {
      if (e.target.closest('[data-act="close"]')) closeDrawer();
      const c = e.target.closest('[data-act="compose"]');
      if (c) openCompose(c.dataset.for);
      if (e.target.closest('[data-act="compose-cancel"]')) { const b = $('qtCompose'); if (b) b.innerHTML = ''; }
    });
    drawer.addEventListener('submit', e => {
      if (e.target.id === 'qtChaseForm') { e.preventDefault(); submitChase(e.target); }
      if (e.target.id === 'qtComposeForm') { e.preventDefault(); sendEmail(e.target); }
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
})();
