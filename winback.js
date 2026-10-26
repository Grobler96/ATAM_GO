// winback.js — "Win-back" tab: the reorder-review pipeline, with quotes woven in.
//
// What it does
//   Customers who have gone past their usual reorder time (public.customer_reorder_alerts) become cards that move through
//   a pipeline: Due soon -> Needs a call -> Contacted, waiting -> Replied, your move -> Quote out -> Won back.
//   Anything that happens is either logged by the team here (calls, emails, WhatsApp... win_back contacts) or picked up
//   automatically from DecoNetwork (quotes and orders).
//
// Where the data comes from (all read through views that only signed-in users can open):
//   - winback_board            one row per customer worth showing: reorder facts, owner, last logged contact, park / lost state
//   - winback_customer_quotes  every DecoNetwork quote matched to a customer (manual link, then email, then company / name)
//   - winback_unmatched_quotes recent quotes that no customer could be matched to, so someone can link them once
//   - winback_contacts         the contact log for the drawer timeline
//   Writes go through three functions: log_winback_contact, set_winback_state, link_quote_customer (see sql/winback_pipeline.sql).
//
// How the stage is decided (stage = where the customer is right now in the current "cycle", the time since their last order):
//   Lost       closed by hand, or the last contact was "not interested" (comes back by itself if they order again)
//   Parked     set aside until a date
//   Won back   they ordered after we contacted them (within 120 days), or approved a quote after we contacted them
//   Quote out  they have a live quote (touched in the last 30 days)
//   Replied    the last contact was "they replied" or "asked for a quote"
//   Waiting    we contacted them since their last order and are waiting to hear back
//   Needs a call / Due soon   overdue / approaching their usual reorder time, and not contacted yet

(function () {
  'use strict';

  const PAGE_ID = 'winback';
  const DAY = 86400000;
  const WON_DAYS = 30;        // a win stays on the board this long
  const QUOTE_COLD = 14;      // quote quiet this long = going cold
  const QUOTE_LOST = 30;      // quote quiet this long = lost
  const NUDGE_DAYS = 7;       // contacted this long ago with no follow-up date = time to nudge
  const WAIT_BAR = 14;
  const DORMANT_DAYS = 365;   // overdue by more than a year
  const COL_CAP = 30;
  const REFRESH_MS = 5 * 60 * 1000;
  const DECO_ORDER_URL = 'https://atamworkwear.co.uk/bh/orders?p=2&id=';

  const STAGES = {
    soon:    { label: 'Due soon', icon: '🔔', color: '#38bdf8', blurb: 'close to their usual reorder time' },
    todo:    { label: 'Needs a call', icon: '📞', color: '#f97316', blurb: 'overdue and not contacted yet' },
    waiting: { label: 'Contacted, waiting', icon: '⏳', color: '#f59e0b', blurb: 'we reached out, waiting to hear' },
    replied: { label: 'Replied, your move', icon: '💬', color: '#a78bfa', blurb: 'they came back to us' },
    quote:   { label: 'Quote out', icon: '🧾', color: '#22d3ee', blurb: 'a live quote is with them' },
    won:     { label: 'Won back', icon: '✅', color: '#22c55e', blurb: 'ordered after we got in touch' },
    parked:  { label: 'Parked', icon: '🕒', color: '#64748b', blurb: 'set aside until a date' },
    lost:    { label: 'Lost', icon: '✖', color: '#94a3b8', blurb: 'not coming back' }
  };
  const BOARD = ['soon', 'todo', 'waiting', 'replied', 'quote', 'won'];

  const METHODS = [['call', '📞 Phone call'], ['email', '✉️ Email'], ['whatsapp', '💬 WhatsApp / text'], ['visit', '🚗 Visit'], ['other', 'Other']];
  const OUTCOMES = [
    ['left_message', 'Left a message'], ['no_answer', 'No answer'], ['spoke', 'Spoke to them'], ['ring_back', 'Asked us to ring back'],
    ['replied', 'They replied'], ['quote_requested', 'Asked for a quote'], ['ordered', "They've ordered"], ['not_interested', 'Not interested']
  ];
  const OUTCOME_LABEL = Object.fromEntries(OUTCOMES);
  const METHOD_LABEL = Object.fromEntries(METHODS.map(m => [m[0], m[1].replace(/^\S+\s/, '')]));
  const FOLLOW_UP = { left_message: 3, no_answer: 3, spoke: 7, ring_back: 7 };

  const PERIODS = [
    { key: '7', label: '7 days', days: 7 },
    { key: '30', label: '30 days', days: 30 },
    { key: '90', label: '90 days', days: 90 },
    { key: 'all', label: 'All time', days: null }
  ];
  const TABS = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'team', label: 'Team' },
    { key: 'won', label: 'Won back' },
    { key: 'parked', label: 'Parked & lost' },
    { key: 'all', label: 'All customers' },
    { key: 'unmatched', label: 'Unmatched quotes' }
  ];

  const state = {
    rows: [], unmatched: [], custList: null, loaded: false, loading: false, error: null,
    tab: 'pipeline', period: '30', owner: '', q: '', hideDormant: false,
    sort: { tab: '', key: 'value', dir: -1 }, expanded: {}, timer: null, openId: null, animate: true, updatedAt: null, focusForm: false
  };

  const PREF_KEY = 'atamgo_winback_prefs_v1';
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (TABS.some(t => t.key === p.tab)) state.tab = p.tab;
    if (PERIODS.some(x => x.key === p.period)) state.period = p.period;
    if (typeof p.owner === 'string') state.owner = p.owner;
    if (p.hideDormant === true) state.hideDormant = true;
  } catch (e) { /* storage unavailable: defaults are fine */ }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: state.tab, period: state.period, owner: state.owner, hideDormant: state.hideDormant })); } catch (e) { /* ignore */ }
  }

  // ───────────────────────── helpers ─────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const gbp = v => '£' + num(v).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const fmtDate = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtShort = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
  const fmtDateTime = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
  const days = (a, b) => Math.floor((b - a) / DAY);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ago = d => d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  const ownerName = r => r || 'Unassigned';
  const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const avatar = n => `<span class="wb-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(ownerName(n))}">${esc(initials(n))}</span>`;
  const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
  // 'YYYY-MM-DD' columns: local midnight, so day maths is not shifted by the time zone
  const dayDate = v => { if (!v) return null; const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v); return isNaN(d) ? null : d; };
  const isoDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDays = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  const key = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  // ───────────────────────── data ─────────────────────────
  async function pageAll(build) {
    const PAGE = 1000;
    let all = [], from = 0;
    for (;;) {
      const res = await build().range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      all = all.concat(res.data || []);
      if (!res.data || res.data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }
  const since = new Date(Date.now() - 400 * DAY).toISOString();
  async function fetchAll() {
    const sb = client();
    const [board, quotes, unmatched] = await Promise.all([
      pageAll(() => sb.from('winback_board').select('*').order('customer_id')),
      pageAll(() => sb.from('winback_customer_quotes').select('*').gte('created_at', since).order('order_id', { ascending: false })),
      pageAll(() => sb.from('winback_unmatched_quotes').select('*').order('latest_at', { ascending: false }))
    ]);
    return { board, quotes, unmatched };
  }

  // a matched quote, in the same terms as the Quotes tab
  function enrichQuote(q, now) {
    const created = toDate(q.created_at), modified = toDate(q.modified_at), approved = toDate(q.approved_at);
    const lastTo = toDate(q.last_to_customer_at), lastFrom = toDate(q.last_from_customer_at), lastChase = toDate(q.last_chase_at);
    let touch = created || modified || now;
    [modified, lastTo, lastFrom, lastChase].forEach(d => { if (d && d > touch) touch = d; });
    const idle = Math.max(0, days(touch, now));
    const status = q.order_status == null ? null : Number(q.order_status);
    let st;
    if (status === 4) st = 'lost';
    else if (approved) st = 'won';
    else if (idle >= QUOTE_LOST) st = 'lost';
    else if (idle >= QUOTE_COLD) st = 'cold';
    else st = idle >= 3 ? 'chase' : 'fresh';
    const awaitingUs = !approved && st !== 'lost' && !!lastFrom && (!lastTo || lastFrom > lastTo) && (!lastChase || lastFrom > lastChase);
    return {
      id: String(q.order_id), decoId: q.deco_id, job: q.job_name || '', value: num(q.quote_value), rep: q.assigned_to || '',
      created, approved, idle, st, status, awaitingUs, cancelled: status === 4, touch,
      open: !approved && status !== 4 && idle < QUOTE_LOST, match: q.match_kind
    };
  }

  function enrich(r, qs, now) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const lastOrder = dayDate(r.last_order_date);
    const lastContact = toDate(r.last_contact_at);
    const attributed = toDate(r.attributed_contact_at);
    const closedAt = toDate(r.closed_at);
    const parkedUntil = dayDate(r.parked_until);
    const followUp = dayDate(r.follow_up_on);
    const status = r.reorder_status || '';
    const overdue = status === 'At Risk' || status === 'Due Soon';
    const label = r.company || r.name || 'Unknown customer';
    const contactName = r.company && r.name && key(r.name) !== key(r.company) ? r.name : '';
    const dsl = r.days_since_last_order == null ? null : num(r.days_since_last_order);
    const overdueBy = r.overdue_by_days == null ? null : num(r.overdue_by_days);
    const threshold = r.overdue_threshold_days == null ? null : num(r.overdue_threshold_days);
    const value = num(r.last_order_value);

    const openQuotes = qs.filter(q => q.open).sort((a, b) => b.touch - a.touch);
    const quoteValue = openQuotes.reduce((t, q) => t + q.value, 0);
    const awaitingUs = openQuotes.some(q => q.awaitingUs);
    // a quote that was sent after their last order and then went quiet = the best excuse to ring
    const coldQuote = !openQuotes.length ? qs.filter(q => !q.approved && !q.cancelled && q.idle >= QUOTE_COLD && q.idle <= 150 && (!lastOrder || q.created > lastOrder)).sort((a, b) => b.created - a.created)[0] || null : null;

    const lastQuote = qs.length ? qs.reduce((a, q) => (q.created && (!a || q.created > a.created) ? q : a), null) : null;
    const emailSentAt = toDate(r.email_sent_at), emailRepliedAt = toDate(r.email_replied_at), emailDueAt = toDate(r.email_due_at);
    const emailCycle = !!emailSentAt && (!lastOrder || emailSentAt >= lastOrder);   // an email sent since their last order
    const cycleContact = !!(overdue && lastContact && (!lastOrder || lastContact >= lastOrder));
    const outcome = r.last_contact_outcome || '';

    // wins
    let won = null;
    if (attributed && lastOrder && days(lastOrder, now) <= 400) won = { at: lastOrder, via: 'order', value: value, by: r.attributed_contact_by || '' };
    if (!won && lastContact) {
      const q = qs.filter(x => x.approved && days(x.approved, now) <= WON_DAYS * 3 && x.approved >= new Date(lastContact.getTime() - DAY) && x.approved - lastContact <= 120 * DAY).sort((a, b) => b.approved - a.approved)[0];
      if (q) won = { at: q.approved, via: 'quote', value: q.value, by: r.last_contact_by || '', quote: q };
    }
    if (!won && cycleContact && outcome === 'ordered') won = { at: lastContact, via: 'told', value: value, by: r.last_contact_by || '' };
    const wonRecent = !!won && days(won.at, now) <= WON_DAYS;

    const lost = !!closedAt && (!lastOrder || lastOrder <= closedAt) || (cycleContact && outcome === 'not_interested');
    const parked = !lost && !!parkedUntil && parkedUntil >= today;

    let stage = 'none', lostReason = '';
    if (lost) { stage = 'lost'; lostReason = closedAt && (!lastOrder || lastOrder <= closedAt) ? (r.closed_reason || 'Closed') : (r.last_contact_note || 'Not interested'); }
    else if (parked) stage = 'parked';
    else if (won) stage = 'won';
    else if (openQuotes.length) stage = 'quote';
    else if (cycleContact) stage = outcome === 'replied' || outcome === 'quote_requested' ? 'replied' : 'waiting';
    else if (status === 'At Risk') stage = 'todo';
    else if (status === 'Due Soon') stage = 'soon';

    const contactDays = lastContact ? Math.max(0, days(lastContact, now)) : null;
    const followUpDue = stage === 'waiting' || stage === 'replied' ? (followUp ? followUp <= today : (stage === 'waiting' && contactDays != null && contactDays >= NUDGE_DAYS)) : false;
    const dormant = overdueBy != null && overdueBy > DORMANT_DAYS;

    return {
      id: String(r.customer_id), label, contactName, person: r.name || '', email: r.email || '',
      lastQuote, emailCycle, emailNo: emailCycle ? num(r.email_no) : 0, emailSentAt, emailDueAt, emailRepliedAt, emailSender: r.email_sender || '', owner: r.owner || '', ownerManual: !!r.owner_manual, notes: r.notes || '',
      totalOrders: num(r.total_orders), firstOrder: dayDate(r.first_order_date), lastOrder, lastOrderId: r.last_order_id || '', lastOrderSummary: r.last_order_summary || '',
      value, mean: r.mean_reorder_days == null ? null : num(r.mean_reorder_days), threshold, dsl, overdueBy, status, overdue, dormant,
      lastContact, contactBy: r.last_contact_by || '', contactMethod: r.last_contact_method || '', outcome, contactNote: r.last_contact_note || '',
      contactCount: num(r.contact_count), followUp, followUpDue, contactDays, cycleContact,
      parkedUntil, closedAt, lostReason, quotes: qs, openQuotes, quoteValue, awaitingUs, coldQuote, won, wonRecent, stage,
      contactAt: won ? attributed || lastContact : (cycleContact ? lastContact : null),
      emailWaiting: emailCycle && !emailRepliedAt && ['waiting', 'todo', 'soon'].includes(stage),
      emailDue: emailCycle && !emailRepliedAt && !!emailDueAt && now >= emailDueAt && ['waiting', 'todo', 'soon'].includes(stage)
    };
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; renderBody(); }
    try {
      const now = new Date();
      const d = await fetchAll();
      const byCust = {};
      d.quotes.forEach(q => { (byCust[String(q.customer_id)] = byCust[String(q.customer_id)] || []).push(enrichQuote(q, now)); });
      state.rows = d.board.map(r => enrich(r, (byCust[String(r.customer_id)] || []).sort((a, b) => (b.created || 0) - (a.created || 0)), now));
      state.unmatched = d.unmatched;
      state.loaded = true; state.error = null; state.updatedAt = new Date();
      if (state.owner && !state.rows.some(r => (r.owner || '__none') === state.owner)) state.owner = '';
    } catch (e) {
      console.error('winback load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the win-back list';
    } finally {
      state.loading = false;
    }
    renderAll();
  }

  // ───────────────────────── filtering & stats ─────────────────────────
  const periodDays = () => (PERIODS.find(p => p.key === state.period) || {}).days;
  function inPeriod(d) {
    const n = periodDays();
    if (!d) return false;
    return n == null || d >= new Date(Date.now() - n * DAY);
  }
  function matches(r) {
    if (state.owner && (r.owner || '__none') !== state.owner) return false;
    if (state.hideDormant && r.dormant) return false;
    if (state.q) {
      const hay = [r.label, r.contactName, r.email, r.owner, r.lastOrderId, r.lastOrderSummary].concat(r.quotes.map(q => q.id + ' ' + q.job)).join(' ').toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  }
  const visible = () => state.rows.filter(r => r.stage !== 'none' && matches(r));

  function stats(rows) {
    const by = k => rows.filter(r => r.stage === k);
    const todo = by('todo'), waiting = by('waiting'), replied = by('replied'), quote = by('quote'), soon = by('soon');
    const won = rows.filter(r => r.stage === 'won' && inPeriod(r.won.at));
    const contacted = rows.filter(r => r.contactAt && inPeriod(r.contactAt));
    const lostN = rows.filter(r => r.stage === 'lost' && r.closedAt && inPeriod(r.closedAt)).length;
    return {
      todo, waiting, replied, quote, soon, won, contacted, lostN,
      todoValue: todo.reduce((t, r) => t + r.value, 0),
      nudge: waiting.filter(r => r.followUpDue),
      quoteValue: quote.reduce((t, r) => t + r.quoteValue, 0),
      wonValue: won.reduce((t, r) => t + num(r.won.value), 0),
      rate: contacted.length ? won.filter(r => r.contactAt && inPeriod(r.contactAt)).length / contacted.length : null
    };
  }

  function spark(vals, color) {
    const w = 64, h = 22, max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => (i * (w / Math.max(1, vals.length - 1))).toFixed(1) + ',' + (h - 2 - (v / max) * (h - 4)).toFixed(1)).join(' ');
    return `<svg class="wb-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const weekStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  function weekly(dates, n) {
    const base = weekStart(new Date());
    const out = new Array(n).fill(0);
    dates.forEach(d => { if (!d) return; const i = n - 1 - Math.round((base - weekStart(d)) / (7 * DAY)); if (i >= 0 && i < n) out[i]++; });
    return out;
  }

  function countUp(el) {
    if (!state.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.querySelectorAll('[data-to]').forEach(n => {
      const to = Number(n.dataset.to), t0 = performance.now();
      const tick = t => { const p = Math.min(1, (t - t0) / 600); n.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  // ───────────────────────── rendering ─────────────────────────
  function renderAll() {
    renderHead(); renderKpis(); renderControls(); renderBody(); updateNavBadge();
    const u = $('wbUpdated');
    if (u && state.updatedAt) u.textContent = 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    state.animate = false;
    if (state.openId) refreshDrawer();
  }

  function updateNavBadge() {
    const btn = document.querySelector('.nav-link[data-page="' + PAGE_ID + '"]');
    if (!btn) return;
    const n = state.rows.filter(r => r.stage === 'replied' || r.followUpDue || r.emailDue || (r.stage === 'quote' && r.awaitingUs)).length;
    let b = btn.querySelector('.wb-nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'wb-nav-badge'; btn.appendChild(b); }
    b.textContent = n;
    b.title = n + ' customers need your attention';
  }

  function renderHead() {
    const el = $('wbValue'); if (!el || !state.loaded) return;
    const s = stats(state.rows.filter(r => r.stage !== 'none'));
    const open = s.todo.length + s.waiting.length + s.replied.length + s.soon.length;
    el.innerHTML = `<b>${gbp(s.todoValue)}</b> of repeat business is overdue across ${plural(s.todo.length, 'customer')}` +
      (s.quote.length ? ` · <b>${gbp(s.quoteValue)}</b> in live quotes to overdue customers` : '') +
      (open ? '' : ' · nothing waiting');
  }

  function renderKpis() {
    const el = $('wbKpis'); if (!el) return;
    const rows = visible();
    const s = stats(rows);
    const per = (PERIODS.find(p => p.key === state.period) || {}).label.toLowerCase();
    const w = weekly(rows.filter(r => r.stage === 'won').map(r => r.won.at), 8);
    const c = weekly(rows.filter(r => r.contactAt).map(r => r.contactAt), 8);
    const tiles = [
      { n: s.todo.length, label: 'Need a call', sub: gbp(s.todoValue) + ' of last-order value', cls: 'wb-kpi-attn' },
      { n: s.waiting.length, label: 'Contacted, waiting', sub: s.nudge.length ? plural(s.nudge.length, 'customer') + ' due a nudge' : 'nobody due a nudge', spark: spark(c, '#f59e0b') },
      { n: s.replied.length, label: 'Replied, your move', sub: s.replied.length ? 'waiting on us' : 'all answered', cls: s.replied.length ? 'wb-kpi-attn' : '' },
      { n: s.quote.length, label: 'Quote out', sub: gbp(s.quoteValue) + ' on the table' },
      { n: s.won.length, label: 'Won back', sub: gbp(s.wonValue) + ' · ' + per, cls: 'wb-kpi-good', spark: spark(w, '#22c55e') },
      { txt: s.rate == null ? '—' : Math.round(s.rate * 100) + '%', label: 'Contacted → won back', sub: s.contacted.length ? `${s.contacted.length} contacted · ${per}` : 'nobody contacted yet' }
    ];
    el.innerHTML = tiles.map((t, i) => `<div class="wb-kpi ${t.cls || ''}" style="--i:${i}">
      <div class="wb-kpi-n"${t.n != null ? ` data-to="${t.n}"` : ''}>${t.n != null ? t.n : esc(t.txt)}</div>
      <div class="wb-kpi-l">${esc(t.label)}</div><div class="wb-kpi-s">${esc(t.sub)}</div>${t.spark || ''}</div>`).join('');
    countUp(el);
  }

  function renderControls() {
    savePrefs();
    const owners = Array.from(new Set(state.rows.map(r => r.owner || '__none'))).sort((a, b) => ownerName(a === '__none' ? '' : a).localeCompare(ownerName(b === '__none' ? '' : b)));
    const sel = $('wbOwner');
    if (sel) sel.innerHTML = '<option value="">Everyone</option>' + owners.map(r => `<option value="${esc(r)}"${r === state.owner ? ' selected' : ''}>${esc(r === '__none' ? 'Unassigned' : r)}</option>`).join('');
    const per = $('wbPeriod');
    if (per) per.innerHTML = PERIODS.map(p => `<button type="button" data-period="${p.key}" class="${p.key === state.period ? 'on' : ''}">${esc(p.label)}</button>`).join('');
    const dorm = $('wbDormant'); if (dorm) dorm.checked = state.hideDormant;
    const tabs = $('wbTabs');
    if (tabs) {
      const rows = visible();
      const count = k => k === 'pipeline' ? rows.filter(r => BOARD.includes(r.stage) && r.stage !== 'won').length
        : k === 'won' ? rows.filter(r => r.stage === 'won' && inPeriod(r.won.at)).length
        : k === 'parked' ? rows.filter(r => r.stage === 'parked' || r.stage === 'lost').length
        : k === 'all' ? state.rows.filter(matches).length
        : k === 'unmatched' ? state.unmatched.length : null;
      tabs.innerHTML = TABS.map(t => `<button type="button" role="tab" data-tab="${t.key}" class="wb-tab${t.key === state.tab ? ' active' : ''}">${esc(t.label)}${count(t.key) != null ? `<span class="wb-tab-n">${count(t.key)}</span>` : ''}</button>`).join('');
    }
  }

  function renderBody() {
    const el = $('wbBody'); if (!el) return;
    if (state.error) { el.innerHTML = `<div class="wb-empty">Couldn't load the win-back list: ${esc(state.error)}<br><button type="button" class="wb-btn" data-act="reload">Try again</button></div>`; return; }
    if (!state.loaded) {
      el.innerHTML = '<div class="wb-board" aria-busy="true">' + BOARD.map(() => '<section class="wb-col"><header class="wb-col-h"><div class="wb-sk" style="width:55%;height:14px"></div></header><div class="wb-col-b">' + [0, 1, 2].map(() => '<div class="wb-sk" style="height:96px"></div>').join('') + '</div></section>').join('') + '</div>';
      return;
    }
    if (state.tab === 'pipeline') el.innerHTML = boardHtml();
    else if (state.tab === 'team') el.innerHTML = teamHtml();
    else if (state.tab === 'unmatched') { el.innerHTML = unmatchedHtml(); ensureCustomers(); }
    else el.innerHTML = tableHtml(state.tab);
  }

  // ----- pipeline -----
  function quoteChips(r) {
    let out = '';
    r.openQuotes.slice(0, 2).forEach(q => {
      out += `<div class="wb-qchip" title="${esc(q.job || 'Quote #' + q.id)}"><span>🧾 ${esc(q.job || 'Quote #' + q.id)}</span><b>${gbp(q.value)}</b></div>`;
    });
    if (r.openQuotes.length > 2) out += `<div class="wb-hint" style="margin:-2px 0 7px">+ ${r.openQuotes.length - 2} more quotes</div>`;
    if (!r.openQuotes.length && r.coldQuote) out += `<div class="wb-qchip cold" title="${esc(r.coldQuote.job || '')}"><span>🧊 Quoted, then went quiet ${esc(ago(r.coldQuote.idle))}</span><b>${gbp(r.coldQuote.value)}</b></div>`;
    return out;
  }

  function cardHtml(r, i) {
    const st = STAGES[r.stage];
    const flags = [];
    if (r.awaitingUs) flags.push('<span class="wb-flag purple">💬 Replied to the quote</span>');
    if (r.followUpDue) flags.push('<span class="wb-flag hot">' + (r.followUp ? '⏰ Follow-up due' : '⏰ Time to nudge') + '</span>');
    else if ((r.stage === 'waiting' || r.stage === 'replied') && r.followUp) flags.push(`<span class="wb-flag cool">Follow up ${esc(fmtShort(r.followUp))}</span>`);
    if (r.emailDue) flags.push(`<span class="wb-flag hot" title="Emailed ${esc(fmtDateTime(r.emailSentAt))} from ${esc(r.emailSender)}">✉️ No reply to email #${r.emailNo}</span>`);
    else if (r.emailWaiting) flags.push(`<span class="wb-flag cool" title="Emailed ${esc(fmtDateTime(r.emailSentAt))} from ${esc(r.emailSender)}">✉️ Emailed ${esc(ago(Math.max(0, days(r.emailSentAt, new Date()))))}</span>`);
    else if (r.emailRepliedAt && r.emailCycle) flags.push('<span class="wb-flag good">✉️ Replied to our email</span>');
    if (r.stage === 'todo' || r.stage === 'soon') flags.push(`<span class="wb-flag dim" title="Quotes are only on file from mid 2026">${r.lastQuote ? 'Last quote ' + esc(fmtShort(r.lastQuote.created)) : 'No quote on file'}</span>`);
    if (r.dormant) flags.push('<span class="wb-flag dim">Dormant 12m+</span>');
    if (r.stage === 'todo' && r.contactCount) flags.push(`<span class="wb-flag dim">${plural(r.contactCount, 'earlier contact')}</span>`);

    let foot = '';
    if (r.stage === 'todo' || r.stage === 'soon') {
      const pct = r.threshold ? Math.min(100, Math.round((r.dsl || 0) / r.threshold * 100)) : 0;
      const over = r.threshold && (r.dsl || 0) > r.threshold;
      foot = `<div class="wb-bar" title="${r.dsl == null ? '' : r.dsl} days since the last order, usually reorders every ${r.threshold == null ? '?' : r.threshold}"><i class="${over ? 'over' : ''}" style="width:${pct || 100}%;background:${st.color}"></i></div>
        <div class="wb-card-foot"><span>${r.overdueBy != null && r.overdueBy > 0 ? 'Overdue ' + r.overdueBy + 'd' : r.overdueBy != null ? 'Due in ' + Math.abs(r.overdueBy) + 'd' : '—'}</span><span>Last order ${esc(fmtShort(r.lastOrder))}</span></div>`;
    } else if (r.stage === 'waiting' || r.stage === 'replied') {
      const pct = Math.min(100, Math.round((r.contactDays || 0) / WAIT_BAR * 100));
      foot = `<div class="wb-bar"><i style="width:${pct}%;background:${st.color}"></i></div>
        <div class="wb-card-foot"><span>${esc(OUTCOME_LABEL[r.outcome] || 'Contacted')} · ${esc(ago(r.contactDays || 0))}</span><span>${esc(r.contactBy ? r.contactBy.split(' ')[0] : '')}</span></div>`;
    } else if (r.stage === 'quote') {
      const q = r.openQuotes[0];
      foot = `<div class="wb-card-foot"><span>Quote quiet ${q.idle <= 0 ? 'today' : q.idle + 'd'}</span><span>${plural(r.openQuotes.length, 'quote')}</span></div>`;
    } else if (r.stage === 'won') {
      const via = r.won.via === 'quote' ? 'approved a quote' : r.won.via === 'told' ? 'told us they ordered' : 'reordered';
      foot = `<div class="wb-card-foot"><span>${esc(fmtShort(r.won.at))} · ${esc(via)}</span><span>${r.won.by ? 'after ' + esc(r.won.by.split(' ')[0]) : ''}</span></div>`;
    }
    const quick = r.stage === 'todo' || r.stage === 'soon' || r.stage === 'waiting' || r.stage === 'replied'
      ? `<div class="wb-quickrow"><button type="button" class="wb-quick" data-log="${esc(r.id)}">📞 Log contact</button>${r.email && mailOn() ? `<button type="button" class="wb-quick alt" data-mail="${esc(r.id)}" title="Write and send an email">✉️ Email</button>` : ''}${r.stage !== 'replied' ? `<button type="button" class="wb-quick alt" data-noanswer="${esc(r.id)}" title="Log a call with no answer and chase again in 3 days">No answer</button>` : ''}</div>` : '';
    const worth = r.stage === 'quote' ? r.quoteValue : r.stage === 'won' ? num(r.won.value) : r.value;
    return `<article class="wb-card" data-id="${esc(r.id)}" tabindex="0" style="--c:${st.color};--i:${Math.min(i || 0, 8)}">
      <div class="wb-card-top"><span class="wb-card-cust">${esc(r.label)}</span><span class="wb-card-val">${gbp(worth)}<small>${r.stage === 'quote' ? 'in quotes' : r.stage === 'won' ? 'won back' : 'last order'}</small></span></div>
      <div class="wb-card-mid">${avatar(r.owner)}<span class="wb-card-rep">${esc(ownerName(r.owner))}${r.contactName ? ' · ' + esc(r.contactName) : ''}</span></div>
      ${flags.length ? `<div class="wb-flags">${flags.join('')}</div>` : ''}
      ${quoteChips(r)}
      ${foot}${quick}</article>`;
  }

  function sortFor(k) {
    const dormant = r => r.dormant ? 1 : 0;
    switch (k) {
      case 'soon': return (a, b) => b.value - a.value;
      case 'todo': return (a, b) => dormant(a) - dormant(b) || (b.coldQuote ? 1 : 0) - (a.coldQuote ? 1 : 0) || b.value - a.value;
      case 'waiting': return (a, b) => (b.followUpDue ? 1 : 0) - (a.followUpDue ? 1 : 0) || (b.contactDays || 0) - (a.contactDays || 0);
      case 'replied': return (a, b) => (b.contactDays || 0) - (a.contactDays || 0);
      case 'quote': return (a, b) => (b.awaitingUs ? 1 : 0) - (a.awaitingUs ? 1 : 0) || b.quoteValue - a.quoteValue;
      default: return (a, b) => b.won.at - a.won.at;
    }
  }

  function callFirst(rows) {
    const cand = [];
    rows.forEach(r => {
      if (r.stage === 'replied') cand.push({ r, p: 0, why: 'They replied · waiting on you' });
      else if (r.stage === 'quote' && r.awaitingUs) cand.push({ r, p: 0, why: 'Replied to their quote' });
      else if (r.followUpDue) cand.push({ r, p: 1, why: r.followUp ? 'Follow-up due' : 'Contacted ' + r.contactDays + 'd ago' });
      else if (r.stage === 'todo' && r.coldQuote && !r.dormant) cand.push({ r, p: 2, why: 'Quoted ' + gbp(r.coldQuote.value) + ', then went quiet' });
    });
    const todo = rows.filter(r => r.stage === 'todo' && !r.dormant && !cand.some(c => c.r === r)).sort((a, b) => b.value - a.value).slice(0, 3);
    todo.forEach(r => cand.push({ r, p: 3, why: 'Biggest overdue · ' + (r.overdueBy > 0 ? r.overdueBy + 'd late' : 'due') }));
    return cand.sort((a, b) => a.p - b.p || b.r.value - a.r.value).slice(0, 6);
  }

  function boardHtml() {
    const rows = visible();
    const s = stats(rows);
    if (!rows.length) return '<div class="wb-empty">Nobody to chase. Everyone is within their usual reorder time.</div>';
    const first = callFirst(rows);
    const firstHtml = first.length ? `<div class="wb-first wb-first-box"><div class="wb-first-h"><h3>Do these first</h3><span class="wb-dim">replies, follow-ups that are due, and quotes that went quiet</span></div><div class="wb-first-row">${first.map((c, i) => {
      const st = STAGES[c.r.stage];
      return `<div class="wb-first-card" data-id="${esc(c.r.id)}" tabindex="0" style="--c:${st.color};animation-delay:${i * 50}ms"><div class="wb-first-val">${gbp(c.r.stage === 'quote' ? c.r.quoteValue : c.r.value)}</div><div class="wb-first-cust">${esc(c.r.label)}</div><div class="wb-first-meta">${avatar(c.r.owner)}<span>${esc(ownerName(c.r.owner))}</span><b>${esc(c.why)}</b></div></div>`;
    }).join('')}</div></div>` : '';
    const counts = BOARD.map(k => ({ k, n: k === 'won' ? s.won.filter(r => r.wonRecent).length : rows.filter(r => r.stage === k).length }));
    const total = counts.reduce((t, c) => t + c.n, 0) || 1;
    const funnel = `<div class="wb-funnel-box"><div class="wb-funnel">${counts.filter(c => c.n).map(c => `<div class="wb-fseg" style="--c:${STAGES[c.k].color};flex:${c.n} 1 0" title="${esc(STAGES[c.k].label)}: ${c.n}"><span>${c.n}</span></div>`).join('')}</div>
      <div class="wb-flegend">${counts.map(c => `<span><i style="--c:${STAGES[c.k].color}"></i>${esc(STAGES[c.k].label)} ${c.n}</span>`).join('')}</div></div>`;
    const cols = BOARD.map(k => {
      let items = rows.filter(r => r.stage === k);
      if (k === 'won') items = items.filter(r => r.wonRecent);
      items.sort(sortFor(k));
      const st = STAGES[k];
      const cap = state.expanded[k] ? items.length : COL_CAP;
      const sum = k === 'quote' ? items.reduce((t, r) => t + r.quoteValue, 0) : k === 'won' ? items.reduce((t, r) => t + num(r.won.value), 0) : items.reduce((t, r) => t + r.value, 0);
      return `<section class="wb-col" style="--c:${st.color}"><header class="wb-col-h"><div><span class="wb-col-t">${st.icon} ${esc(st.label)}</span><span class="wb-col-n">${items.length}</span></div>
        <div class="wb-col-s">${esc(st.blurb)}${items.length ? ' · ' + gbp(sum) : ''}</div></header>
        <div class="wb-col-b">${items.length ? items.slice(0, cap).map((r, i) => cardHtml(r, i)).join('') + (items.length > cap ? `<button type="button" class="wb-more" data-more="${k}">Show all ${items.length}</button>` : '') : '<div class="wb-col-empty">Nobody here</div>'}</div></section>`;
    }).join('');
    return firstHtml + funnel + `<div class="wb-board">${cols}</div>`;
  }

  // ----- tables -----
  const COLS = [
    { k: 'label', l: 'Customer', v: r => r.label.toLowerCase() },
    { k: 'stage', l: 'Stage', v: r => Object.keys(STAGES).indexOf(r.stage) },
    { k: 'owner', l: 'Owner', v: r => (r.owner || 'zzz').toLowerCase() },
    { k: 'lastOrder', l: 'Last order', v: r => r.lastOrder ? r.lastOrder.getTime() : 0 },
    { k: 'overdue', l: 'Overdue by', v: r => r.overdueBy == null ? -9999 : r.overdueBy, r: true },
    { k: 'value', l: 'Last order £', v: r => r.value, r: true },
    { k: 'contact', l: 'Last contact', v: r => r.lastContact ? r.lastContact.getTime() : 0 },
    { k: 'quote', l: 'Open quotes £', v: r => r.quoteValue, r: true }
  ];
  function tableHtml(tab) {
    let rows = tab === 'all' ? state.rows.filter(matches)
      : tab === 'won' ? visible().filter(r => r.stage === 'won' && inPeriod(r.won.at))
      : visible().filter(r => r.stage === 'parked' || r.stage === 'lost');
    if (!rows.length) return `<div class="wb-empty">${tab === 'won' ? 'Nobody has been won back in this period yet. Log your calls and they will show up here.' : tab === 'parked' ? 'Nothing parked or lost.' : 'Nothing matches.'}</div>`;
    if (state.sort.tab !== tab) state.sort = { tab, key: tab === 'won' ? 'lastOrder' : 'value', dir: -1 };
    const col = COLS.find(c => c.k === state.sort.key) || COLS[5];
    rows = rows.slice().sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir; });
    const head = COLS.map(c => `<th data-sort="${c.k}" class="${c.r ? 'r ' : ''}${c.k === state.sort.key ? 'sorted' : ''}">${esc(c.l)}${c.k === state.sort.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows.slice(0, 400).map(r => {
      const st = STAGES[r.stage] || { label: 'Active', color: '#64748b', icon: '' };
      const extra = r.stage === 'parked' ? ' until ' + fmtShort(r.parkedUntil) : r.stage === 'won' ? ' · ' + fmtShort(r.won.at) : '';
      return `<tr data-id="${esc(r.id)}" tabindex="0"><td><b>${esc(r.label)}</b>${r.contactName ? `<div class="wb-dim">${esc(r.contactName)}</div>` : ''}</td>
        <td><span class="wb-chip" style="--c:${st.color}">${esc(st.label)}${esc(extra)}</span></td>
        <td><span class="wb-rep">${avatar(r.owner)}${esc(ownerName(r.owner))}</span></td>
        <td>${esc(fmtDate(r.lastOrder))}</td><td class="r">${r.overdueBy == null ? '—' : r.overdueBy > 0 ? r.overdueBy + 'd' : 'in ' + Math.abs(r.overdueBy) + 'd'}</td>
        <td class="r">${gbp(r.value)}</td><td>${r.lastContact ? esc(fmtShort(r.lastContact)) + ' · ' + esc(OUTCOME_LABEL[r.outcome] || '') : '—'}</td>
        <td class="r">${r.quoteValue ? gbp(r.quoteValue) : '—'}</td></tr>`;
    }).join('');
    return `<div class="wb-tablewrap"><table class="wb-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="wb-tfoot">${plural(rows.length, 'customer')}${rows.length > 400 ? ' (first 400 shown, use the search to narrow)' : ''}</div>`;
  }

  // ----- team -----
  function teamHtml() {
    const rows = state.rows.filter(r => r.stage !== 'none' && (!state.hideDormant || !r.dormant));
    const people = {};
    const P = n => { const k = key(n) || '__none'; return people[k] = people[k] || { name: n || '', owned: [], contacts: [], wins: [], lastAt: null }; };
    rows.forEach(r => {
      P(r.owner).owned.push(r);
      if (r.contactAt && inPeriod(r.contactAt) && r.contactBy) { const p = P((r.won && r.won.by) || r.contactBy); p.contacts.push(r); }
      if (r.stage === 'won' && inPeriod(r.won.at) && r.won.by) P(r.won.by).wins.push(r);
      if (r.lastContact && r.contactBy) { const p = P(r.contactBy); if (!p.lastAt || r.lastContact > p.lastAt) p.lastAt = r.lastContact; }
    });
    const list = Object.values(people).filter(p => p.name || p.owned.length).map(p => {
      const contacted = new Set(p.contacts.map(r => r.id)).size;
      const won = p.wins.length;
      return { p, contacted, won, wonValue: p.wins.reduce((t, r) => t + num(r.won.value), 0), rate: contacted ? Math.min(1, won / contacted) : null,
        todo: p.owned.filter(r => r.stage === 'todo').length, waiting: p.owned.filter(r => r.stage === 'waiting').length,
        replied: p.owned.filter(r => r.stage === 'replied').length, quote: p.owned.filter(r => r.stage === 'quote').length,
        overdueValue: p.owned.filter(r => r.stage === 'todo').reduce((t, r) => t + r.value, 0) };
    }).sort((a, b) => b.wonValue - a.wonValue || b.contacted - a.contacted || b.overdueValue - a.overdueValue);
    if (!list.length) return '<div class="wb-empty">No people to show yet.</div>';
    const medal = ['🥇', '🥈', '🥉'];
    const per = (PERIODS.find(p => p.key === state.period) || {}).label.toLowerCase();
    return `<div class="wb-team-h"><h3>Win-back by person</h3><span class="wb-dim">Customers are owned by whoever had their last order. Contacts and wins are credited to whoever logged the contact · ${esc(per)}</span></div>
      <div class="wb-team">${list.map((t, i) => {
        const name = t.p.name || 'Unassigned';
        const k = t.p.name ? key(t.p.name) : '__none';
        const total = t.p.owned.length || 1;
        const split = ['todo', 'waiting', 'replied', 'quote', 'won'].map(s => ({ s, n: t.p.owned.filter(r => r.stage === s).length })).filter(x => x.n);
        return `<article class="wb-rep-card${state.owner && key(state.owner) === k ? ' sel' : ''}" data-owner="${esc(t.p.name || '__none')}" tabindex="0" style="--h:${hue(name)}">
          <header><div class="wb-rep-id">${avatar(t.p.name)}<div><div class="wb-rep-name">${i < 3 && t.won ? `<span class="wb-medal">${medal[i]}</span> ` : ''}${esc(name)}</div>
          <div class="wb-rep-sub">${plural(t.p.owned.length, 'customer')} on the board</div></div></div>
          <div class="wb-ring" style="--p:${t.rate == null ? 0 : Math.round(t.rate * 100)}"><div><b>${t.rate == null ? '—' : Math.round(t.rate * 100) + '%'}</b><span>won back</span></div></div></header>
          <div class="wb-rep-grid"><div><b>${t.contacted}</b><span>Contacted</span></div><div><b>${t.won}</b><span>Won back</span></div><div><b>${gbp(t.wonValue)}</b><span>Value won</span></div><div class="${t.todo ? 'warn' : ''}"><b>${t.todo}</b><span>Need a call</span></div></div>
          <div class="wb-split">${split.map(x => `<i style="flex:${x.n};background:${STAGES[x.s].color}" title="${esc(STAGES[x.s].label)}: ${x.n}"></i>`).join('')}</div>
          <footer><span>${t.replied ? '💬 ' + t.replied + ' replied · ' : ''}${t.waiting} waiting · ${t.quote} quote${t.quote === 1 ? '' : 's'} out</span><span>Last logged ${t.p.lastAt ? esc(ago(days(t.p.lastAt, new Date()))) : 'never'}</span></footer></article>`;
      }).join('')}</div>`;
  }

  // ----- unmatched quotes -----
  async function ensureCustomers() {
    if (state.custList) return;
    try {
      const res = await client().from('customer_reorder_alerts').select('customer_id,name,company,email').order('company').limit(1000);
      if (res.error) throw res.error;
      state.custList = (res.data || []).map(c => {
        const label = (c.company || c.name || 'Unknown') + (c.company && c.name && key(c.name) !== key(c.company) ? ' · ' + c.name : '') + ' · #' + c.customer_id;
        return { id: String(c.customer_id), label };
      });
      const dl = $('wbCustList');
      if (dl) dl.innerHTML = state.custList.map(c => `<option value="${esc(c.label)}"></option>`).join('');
    } catch (e) { console.error('customers load failed', e); }
  }
  function unmatchedHtml() {
    if (!state.unmatched.length) return '<div class="wb-empty">Every recent quote is matched to a customer.</div>';
    const rows = state.unmatched.map(u => `<tr class="wb-linkrow" data-qk="${esc(u.customer_name)}">
      <td><b>${esc(u.customer_name)}</b><div class="wb-dim">${esc(u.contact_name || '')} ${u.contact_email ? '· ' + esc(u.contact_email) : ''}</div></td>
      <td class="r">${gbp(u.value)}<div class="wb-dim">${plural(u.quotes, 'quote')}</div></td>
      <td>${esc(u.latest_job || '')}<div class="wb-dim">#${esc(u.latest_order_id)} · ${esc(fmtShort(toDate(u.latest_at)))}</div></td>
      <td><span class="wb-rep">${avatar(u.assigned_to)}${esc(ownerName(u.assigned_to))}</span></td>
      <td><input type="text" list="wbCustList" placeholder="Find the customer…" aria-label="Customer to link ${esc(u.customer_name)} to" data-link-input>
        <button type="button" class="wb-btn wb-primary" data-link="${esc(u.customer_name)}">Link</button>
        <button type="button" class="wb-btn" data-notcust="${esc(u.customer_name)}" title="A new prospect, not an existing customer">Not a customer</button></td></tr>`).join('');
    return `<p class="wb-note">These quotes could not be matched to anyone in the reorder list by email or company name. Most are new prospects. If one is an existing customer under a different name, link it once and it is remembered, and their quote will show on their card.</p>
      <datalist id="wbCustList">${(state.custList || []).map(c => `<option value="${esc(c.label)}"></option>`).join('')}</datalist>
      <div class="wb-tablewrap"><table class="wb-table"><thead><tr><th>Quote customer</th><th class="r">Value</th><th>Latest quote</th><th>Salesperson</th><th>Link to</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  async function linkQuote(name, customerId, btn) {
    if (btn) btn.disabled = true;
    try {
      const { error } = await client().rpc('link_quote_customer', { p_quote_name: name, p_customer_id: customerId });
      if (error) throw error;
      toast(customerId === '_none' ? 'Marked as not an existing customer.' : 'Linked. Their quotes now show on the customer.');
      await load(true);
    } catch (e) {
      toast('Could not save: ' + ((e && e.message) || 'try again'), true);
      if (btn) btn.disabled = false;
    }
  }

  // ----- csv -----
  function exportCsv() {
    const rows = state.rows.filter(matches);
    const guard = v => { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    const q = v => '"' + guard(v).replace(/"/g, '""') + '"';
    const head = ['Customer', 'Contact', 'Email', 'Owner', 'Stage', 'Last order', 'Days since', 'Usual reorder (days)', 'Overdue by (days)', 'Last order value', 'Last contact', 'Last contact by', 'Outcome', 'Follow up', 'Open quotes', 'Open quote value'];
    const lines = [head.map(q).join(',')].concat(rows.map(r => [r.label, r.contactName, r.email, r.owner, (STAGES[r.stage] || { label: 'Active' }).label, r.lastOrder ? isoDay(r.lastOrder) : '', r.dsl, r.threshold, r.overdueBy, r.value,
      r.lastContact ? isoDay(r.lastContact) : '', r.contactBy, OUTCOME_LABEL[r.outcome] || '', r.followUp ? isoDay(r.followUp) : '', r.openQuotes.length, r.quoteValue].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'win-back-' + isoDay(new Date()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ----- writes -----
  async function logContact(id, method, outcome, note, followUp, btn) {
    if (btn) btn.disabled = true;
    try {
      const { error } = await client().rpc('log_winback_contact', { p_customer_id: id, p_method: method, p_outcome: outcome, p_note: note || null, p_follow_up: followUp || null });
      if (error) throw error;
      toast('Logged. ' + (OUTCOME_LABEL[outcome] || '') + (followUp ? ' · follow up ' + fmtShort(dayDate(followUp)) : ''));
      await load(true);
      return true;
    } catch (e) {
      toast('Could not save: ' + ((e && e.message) || 'try again'), true);
      return false;
    } finally { if (btn) btn.disabled = false; }
  }
  async function setState(id, action, until, reason, btn) {
    if (btn) btn.disabled = true;
    try {
      const { error } = await client().rpc('set_winback_state', { p_customer_id: id, p_action: action, p_until: until || null, p_reason: reason || null });
      if (error) throw error;
      toast(action === 'park' ? 'Parked until ' + fmtShort(dayDate(until)) + '.' : action === 'lost' ? 'Marked as lost.' : 'Back on the board.');
      await load(true);
    } catch (e) {
      toast('Could not save: ' + ((e && e.message) || 'try again'), true);
    } finally { if (btn) btn.disabled = false; }
  }

  // ----- drawer -----
  function openDrawer(id, focusForm) {
    const r = state.rows.find(x => x.id === id);
    if (!r) return;
    state.openId = id; state.focusForm = !!focusForm;
    const d = $('wbDrawer');
    d.classList.add('open');
    document.body.classList.add('wb-lock');
    $('wbSheet').innerHTML = drawerHtml(r, null);
    if (focusForm && $('wbOutcome')) $('wbOutcome').focus(); else $('wbSheet').focus();
    loadTimeline(id);
    loadHistory(id);
    loadReps();
  }
  function closeDrawer() {
    state.openId = null;
    const d = $('wbDrawer'); if (d) d.classList.remove('open');
    setHist('');
    document.body.classList.remove('wb-lock');
  }
  function refreshDrawer() {
    const r = state.rows.find(x => x.id === state.openId);
    if (!r) return;
    const form = { m: ($('wbMethod') || {}).value, o: ($('wbOutcome') || {}).value, n: ($('wbNote') || {}).value, f: ($('wbFollow') || {}).value, t: ($('wbFollow') || {}).dataset ? ($('wbFollow') || {}).dataset.touched : '' };
    const mail = $('qtCompose') && $('qtCompose').firstChild ? $('qtCompose') : null;   // an email being written must survive a refresh
    $('wbSheet').innerHTML = drawerHtml(r, null);
    if (mail && $('qtCompose')) $('qtCompose').replaceWith(mail);
    if (form.m && $('wbMethod')) $('wbMethod').value = form.m;
    if (form.o && $('wbOutcome')) $('wbOutcome').value = form.o;
    if ($('wbNote') && form.n) $('wbNote').value = form.n;
    if ($('wbFollow') && form.f) { $('wbFollow').value = form.f; if (form.t) $('wbFollow').dataset.touched = '1'; }
    loadTimeline(r.id);
  }

  function qStage(q) {
    if (q.approved) return { l: 'Approved ' + fmtShort(q.approved), c: '#22c55e' };
    if (q.cancelled) return { l: 'Cancelled', c: '#94a3b8' };
    if (q.st === 'lost') return { l: 'Lost · quiet ' + q.idle + 'd', c: '#94a3b8' };
    if (q.st === 'cold') return { l: 'Going cold · quiet ' + q.idle + 'd', c: '#38bdf8' };
    if (q.st === 'chase') return { l: 'Needs chasing · quiet ' + q.idle + 'd', c: '#f59e0b' };
    return { l: 'Hot · quiet ' + (q.idle <= 0 ? 'today' : q.idle + 'd'), c: '#f97316' };
  }

  // ----- "Your move": plain steps for each stage, with buttons that fill in the log form (nothing is saved until Save contact) -----
  const GUIDE = {
    soon: {
      say: 'They usually reorder around now, so get in first. A friendly check-in is enough.',
      steps: ['Send a short email or give them a ring.', 'Say what happened below and pick a chase date.'],
      moves: [{ t: '✉️ Email them', mail: true }, { t: '📞 Rang, left a message', m: 'call', o: 'left_message' }, { t: '📞 Spoke to them', m: 'call', o: 'spoke' }]
    },
    todo: {
      say: 'They are overdue and nobody has been in touch yet. This one needs a phone call.',
      steps: ['Ring them (the number is on their last order in DecoNetwork).', 'No answer? Leave a message or send an email.', 'Press the button for what happened, then Save contact.'],
      moves: [{ t: '📞 Spoke to them', m: 'call', o: 'spoke' }, { t: '📞 Left a message', m: 'call', o: 'left_message' }, { t: '📞 No answer', m: 'call', o: 'no_answer' }, { t: '✉️ Email them', mail: true }]
    },
    waiting: {
      say: 'We have been in touch and are waiting to hear. Nothing to do until the chase date, then try again.',
      steps: ['If the chase date has arrived, try a different way (email if you rang, ring if you emailed).', 'Still nothing after three tries? Set them aside with “Park” or “Mark lost” further down.'],
      moves: [{ t: '✉️ Chase by email', mail: true }, { t: '📞 Rang again, no answer', m: 'call', o: 'no_answer' }, { t: '💬 They replied', m: 'email', o: 'replied' }]
    },
    replied: {
      say: 'They came back to us. It is our move, so answer them today.',
      steps: ['Reply or ring them back.', 'If they want prices, raise the quote in DecoNetwork.', 'Log what they asked for.'],
      moves: [{ t: '🧾 Asked for a quote', m: 'call', o: 'quote_requested' }, { t: '📞 Spoke to them', m: 'call', o: 'spoke' }, { t: '✅ They’ve ordered', m: 'call', o: 'ordered' }]
    },
    quote: {
      say: 'A quote is out with them. If it has gone quiet, a short nudge usually does it.',
      steps: ['Open the quote in DecoNetwork below to check what we sent.', 'Ring or email to ask if they have any questions.'],
      moves: [{ t: '📞 Rang about the quote', m: 'call', o: 'spoke' }, { t: '📞 Left a message', m: 'call', o: 'left_message' }, { t: '✅ They’ve ordered', m: 'call', o: 'ordered' }]
    },
    won: { say: 'They ordered after we got in touch. Nothing to do, well done.', steps: [], moves: [] },
    parked: { say: 'Set aside until the date shown. It comes back by itself.', steps: ['Want them back sooner? Use Reopen further down.'], moves: [] },
    lost: { say: 'Marked as not coming back. If they order again, they reappear by themselves.', steps: [], moves: [] }
  };
  function moveHtml(r) {
    const g = GUIDE[r.stage]; if (!g) return '';
    const canMail = mailOn() && r.email;
    const moves = g.moves.filter(x => !x.mail || canMail).map(x => x.mail
      ? `<button type="button" class="wb-btn wb-primary" data-mv-mail="1">${esc(x.t)}</button>`
      : `<button type="button" class="wb-btn" data-mv-m="${x.m}" data-mv-o="${x.o}">${esc(x.t)}</button>`).join('');
    return `<div class="wb-move"><h4>Your move</h4><p>${esc(g.say)}</p>
      ${g.steps.length ? '<ol>' + g.steps.map(s => `<li>${esc(s)}</li>`).join('') + '</ol>' : ''}
      ${moves ? `<div class="wb-chase-row">${moves}</div><p class="wb-dim" style="margin:6px 0 0">The buttons fill in the form below. Nothing is saved until you press Save contact.</p>` : ''}</div>`;
  }
  function useMove(btn) {
    if (btn.dataset.mvMail) { if (state.openId) openCompose(state.openId); return; }
    const m = $('wbMethod'), o = $('wbOutcome'), f = $('wbFollow');
    if (!m || !o) { toast('Nothing to log for this customer.', true); return; }
    m.value = btn.dataset.mvM; o.value = btn.dataset.mvO;
    if (f && !f.dataset.touched) { const n = FOLLOW_UP[o.value]; f.value = n ? isoDay(addDays(n)) : ''; }
    const form = $('wbLogForm');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if ($('wbNote')) $('wbNote').focus({ preventScroll: true });
    toast('Filled in. Add a note if you like, then press Save contact.');
  }

  // Change who owns the customer. The team list is the people who can send mail (mail_senders, kind 'rep'). "Automatic" removes the hand-picked owner.
  function ownerPickHtml(r) {
    const reps = state.reps || [];
    if (!reps.length) return '';
    const names = reps;
    return `<select id="wbOwnerPick" aria-label="Change owner" style="margin-top:6px;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:12px">
      <option value="">Change owner…</option>
      ${r.ownerManual ? '<option value="__auto">Back to automatic</option>' : ''}
      ${names.map(n => `<option value="${esc(n)}"${n === r.owner && r.ownerManual ? ' disabled' : ''}>${esc(n)}${n === r.owner ? ' (current)' : ''}</option>`).join('')}
    </select>${r.ownerManual ? '<div class="wb-dim">Picked by hand</div>' : '<div class="wb-dim">Worked out from the last order</div>'}`;
  }
  async function setOwner(id, owner, sel) {
    if (sel) sel.disabled = true;
    try {
      const { error } = await client().rpc('set_winback_owner', { p_customer_id: id, p_owner: owner || null });
      if (error) throw error;
      toast(owner ? 'Owner changed to ' + owner + '.' : 'Owner is back to automatic.');
      await load(true);
    } catch (e) {
      toast('Could not save: ' + ((e && e.message) || 'try again'), true);
      if (sel) { sel.disabled = false; sel.value = ''; }
    }
  }
  function loadReps() {
    const A = window.ATAM_QT;
    if (state.reps || state.repsLoading || !A || !A.loadSenders) return;
    state.repsLoading = true;
    A.loadSenders().then(list => {
      state.reps = (list || []).filter(s => s.kind === 'rep' && s.rep_name).map(s => s.rep_name);
      if (state.openId) refreshDrawer();
    }).catch(() => { /* the owner box just stays hidden */ }).finally(() => { state.repsLoading = false; });
  }

  function drawerHtml(r, timelineHtml) {
    const st = STAGES[r.stage] || { label: 'Active', icon: '', color: '#64748b' };
    const fact = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    let banner = '';
    if (r.stage === 'replied') banner = `<span class="wb-banner purple">💬 ${esc(OUTCOME_LABEL[r.outcome] || 'They replied')} ${esc(ago(r.contactDays || 0))}. The ball is with us.</span>`;
    else if (r.awaitingUs) banner = '<span class="wb-banner purple">💬 They replied to the quote and nobody has answered yet.</span>';
    else if (r.stage === 'won') banner = `<span class="wb-banner good">✅ Won back on ${esc(fmtDate(r.won.at))} (${r.won.via === 'quote' ? 'approved a quote' : r.won.via === 'told' ? 'told us they had ordered' : 'placed a new order'}), worth ${esc(gbp(r.won.value))}${r.won.by ? ' after ' + esc(r.won.by) + "'s contact" : ''}.</span>`;
    else if (r.followUpDue) banner = `<span class="wb-banner warn">⏰ ${r.followUp ? 'Follow-up was due ' + esc(fmtShort(r.followUp)) : 'Contacted ' + esc(ago(r.contactDays || 0)) + ' with no follow-up date'}.</span>`;
    else if (r.stage === 'lost') banner = `<span class="wb-banner">✖ Marked as lost: ${esc(r.lostReason)}. This reopens by itself if they order again.</span>`;
    else if (r.stage === 'parked') banner = `<span class="wb-banner">🕒 Parked until ${esc(fmtDate(r.parkedUntil))}.</span>`;
    else if (r.coldQuote) banner = `<span class="wb-banner warn">🧊 Quoted ${esc(gbp(r.coldQuote.value))} ${esc(ago(r.coldQuote.idle))} (#${esc(r.coldQuote.id)}), then it went quiet. A good reason to ring.</span>`;

    const quotes = r.quotes.slice(0, 12).map(q => {
      const s = qStage(q);
      return `<div class="wb-dq"><div class="wb-dq-top"><span>${esc(q.job || 'Quote #' + q.id)}</span><span>${gbp(q.value)}</span></div>
        <div class="wb-dq-sub"><span class="wb-chip" style="--c:${s.c}">${esc(s.l)}</span> #${esc(q.id)} · ${esc(fmtShort(q.created))}${q.rep ? ' · ' + esc(q.rep) : ''}${q.decoId ? ` · <a href="${DECO_ORDER_URL}${encodeURIComponent(q.decoId)}" target="_blank" rel="noopener">Open in DecoNetwork ↗</a>` : ''}</div></div>`;
    }).join('');

    const today = isoDay(new Date());
    const canAct = r.stage !== 'won';
    const closed = r.stage === 'lost' || r.stage === 'parked';
    return `<div class="wb-d-top" style="--c:${st.color}"><div><div class="wb-d-eyebrow">${esc(st.icon)} ${esc(st.label)}</div><h3>${esc(r.label)}</h3>
      <p class="wb-d-job">${r.contactName ? esc(r.contactName) : ''}${r.email ? (r.contactName ? ' · ' : '') + `<a href="mailto:${esc(r.email)}" style="color:#7dd3fc">${esc(r.email)}</a>` : ''}</p></div>
      <button type="button" class="wb-x" data-act="close" aria-label="Close">×</button></div>
      <div class="wb-d-val">${gbp(r.value)}<span>last order ${esc(r.lastOrderId ? '#' + r.lastOrderId : '')}</span></div>
      <div class="wb-facts">
        ${fact('Last order', esc(fmtDate(r.lastOrder)) + (r.dsl != null ? `<div class="wb-dim">${r.dsl} days ago</div>` : ''))}
        ${fact('Usually reorders every', r.mean ? '~' + r.mean + ' days' : '—')}
        ${fact('Status', r.overdueBy == null ? esc(r.status || '—') : r.overdueBy > 0 ? `<span style="color:#fb923c">Overdue by ${r.overdueBy} days</span>` : 'Due in ' + Math.abs(r.overdueBy) + ' days')}
        ${fact('Orders', r.totalOrders + (r.firstOrder ? `<div class="wb-dim">since ${esc(fmtDate(r.firstOrder))}</div>` : ''))}
        ${fact('Owner', `<span class="wb-rep">${avatar(r.owner)}${esc(ownerName(r.owner))}</span>${ownerPickHtml(r)}`)}
        ${fact('Last contact', r.lastContact ? esc(fmtShort(r.lastContact)) + `<div class="wb-dim">${esc(OUTCOME_LABEL[r.outcome] || '')}${r.contactBy ? ' · ' + esc(r.contactBy) : ''}</div>` : 'Never')}
      </div>
      ${r.lastOrderSummary ? `<p class="wb-dim" style="margin:10px 0 0">${esc(r.lastOrderSummary)}</p>` : ''}
      ${banner}
      ${moveHtml(r)}
      ${canAct ? emailSectionHtml(r) : ''}
      ${canAct ? `<form class="wb-chase" id="wbLogForm" autocomplete="off"><h4>Log a contact</h4>
        <div class="wb-chase-row"><div class="wb-field"><label for="wbMethod">How</label><select id="wbMethod">${METHODS.map(m => `<option value="${m[0]}">${esc(m[1])}</option>`).join('')}</select></div>
        <div class="wb-field"><label for="wbOutcome">What happened</label><select id="wbOutcome">${OUTCOMES.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('')}</select></div></div>
        <div style="margin-top:8px"><label for="wbFollow">Chase again on</label><input type="date" id="wbFollow" min="${today}" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px">
          <div class="wb-chips"><button type="button" data-fu="3">3 days</button><button type="button" data-fu="7">1 week</button><button type="button" data-fu="14">2 weeks</button><button type="button" data-fu="30">1 month</button><button type="button" data-fu="0">None</button></div></div>
        <textarea id="wbNote" placeholder="What did they say? (optional)" maxlength="1000" aria-label="Note"></textarea>
        <button class="wb-btn wb-primary wb-submit" type="submit">Save contact</button></form>` : ''}
      <div class="wb-other"><h4>${closed ? 'Put back on the board' : 'Set aside'}</h4>
        ${closed ? '<div class="wb-chase-row"><button type="button" class="wb-btn wb-primary" data-state="reopen">Reopen</button></div>'
          : r.stage === 'won' ? '<span class="wb-dim">Nothing to do. They have ordered.</span>' : `<div class="wb-chase-row"><input type="date" id="wbParkDate" min="${isoDay(addDays(1))}" value="${isoDay(addDays(30))}" aria-label="Park until" style="padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px">
          <button type="button" class="wb-btn" data-state="park">🕒 Park until then</button></div>
          <div class="wb-chase-row" style="margin-top:8px"><input type="text" id="wbLostWhy" placeholder="Why? (closed down, switched supplier…)" maxlength="200" aria-label="Reason" style="flex:1;min-width:150px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px"><button type="button" class="wb-btn" data-state="lost">✖ Mark lost</button></div>`}
      </div>
      <h4 class="wb-d-h">Quotes${r.quotes.length ? ' (' + r.quotes.length + ')' : ''}</h4>${quotes || '<div class="wb-dim">No quotes found for this customer.</div>'}
      <h4 class="wb-d-h">History</h4><ul class="wb-timeline" id="wbTimeline">${timelineHtml || '<li class="wb-dim">Loading…</li>'}</ul>`;
  }

  async function loadTimeline(id) {
    const el = $('wbTimeline'); if (!el) return;
    const r = state.rows.find(x => x.id === id);
    try {
      const res = await client().from('winback_contacts').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(60);
      if (res.error) throw res.error;
      if (state.openId !== id) return;
      const ev = (res.data || []).map(c => ({ at: toDate(c.created_at), icon: c.method === 'email' ? '✉️' : c.method === 'whatsapp' ? '💬' : c.method === 'visit' ? '🚗' : '📞',
        text: `<b>${esc(OUTCOME_LABEL[c.outcome] || c.outcome)}</b> · ${esc(METHOD_LABEL[c.method] || c.method)}${c.contacted_by ? ' · ' + esc(c.contacted_by) : ''}${c.follow_up_on ? ' · chase ' + esc(fmtShort(dayDate(c.follow_up_on))) : ''}${c.note ? `<div class="wb-dim">${esc(c.note)}</div>` : ''}`, cls: '' }));
      (r ? r.quotes : []).forEach(q => {
        if (q.created) ev.push({ at: q.created, icon: '🧾', text: `Quote #${esc(q.id)} raised · ${esc(gbp(q.value))}${q.job ? ' · ' + esc(q.job) : ''}`, cls: '' });
        if (q.approved) ev.push({ at: q.approved, icon: '✅', text: `Quote #${esc(q.id)} approved · ${esc(gbp(q.value))}`, cls: 'good' });
      });
      if (r && r.lastOrder) ev.push({ at: r.lastOrder, icon: '📦', text: `Last order${r.lastOrderId ? ' #' + esc(r.lastOrderId) : ''} · ${esc(gbp(r.value))}`, cls: '' });
      ev.sort((a, b) => b.at - a.at);
      el.innerHTML = ev.length ? ev.slice(0, 40).map(e => `<li class="${e.cls}"><span class="wb-tl-i">${e.icon}</span><div><div>${e.text}</div><div class="wb-dim">${esc(fmtDateTime(e.at))}</div></div></li>`).join('') : '<li class="wb-dim">Nothing yet.</li>';
    } catch (e) { if ($('wbTimeline')) $('wbTimeline').innerHTML = '<li class="wb-dim">Could not load the history.</li>'; }
  }

  // ----- email the customer (same box as the Quotes tab: window.ATAM_QT.mountCompose, sent by the same n8n workflow) -----
  const mailOn = () => !!(window.ATAM_QT && window.ATAM_QT.emailEnabled());
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function whenText(d) {
    if (!d) return '';
    const n = days(d, new Date()), now = new Date();
    if (n < 60) return ' a little while ago';
    const y = d.getFullYear();
    return ' back in ' + MONTH_NAMES[d.getMonth()] + (y === now.getFullYear() ? '' : y === now.getFullYear() - 1 ? ' last year' : ' ' + y);
  }
  // "polos" or "polos and gilets" from the last order's lines (the product word at the end of each line). Nothing if unsure.
  function productText(summary) {
    const A = window.ATAM_QT;
    if (!A) return '';
    const re = new RegExp(A.JOB_WORDS.source, 'gi'), out = [];
    String(summary || '').split(/,\s+/).slice(0, 3).forEach(item => {
      const name = item.replace(/^\d+\s*x\s*/i, '').replace(/\s*\+\d+ more\s*$/i, '');
      const hits = name.match(re);
      if (!hits) return;
      let w = hits[hits.length - 1].toLowerCase();
      if (!/(workwear|hi[- ]?vis|shorts|trousers|overalls|s)$/.test(w)) w += 's';
      if (!out.includes(w)) out.push(w);
    });
    return out.length && out.length <= 2 ? out.join(' and ') : '';
  }
  // Fixed wordings (no AI) using only facts we hold. They never mention prices, dates or offers.
  function draftReorder(r, sender, no, tone) {
    const A = window.ATAM_QT;
    tone = A.TONES.some(t => t.key === tone) ? tone : 'friendly';
    let fn = A.firstName(r.person);
    if (fn && fn === fn.toLowerCase()) fn = fn.charAt(0).toUpperCase() + fn.slice(1);
    const hi = fn ? 'Hi ' + fn : 'Hello';
    const me = sender && sender.kind === 'rep' ? A.firstName(sender.label) : 'Customer Support';
    const when = whenText(r.lastOrder), prod = productText(r.lastOrderSummary);
    const first = no <= 1;
    const L = {
      friendly: first
        ? `It's been a little while since your last order${when}, so I just wanted to check in and see how everything is going. Is there anything you need, or anything coming up that we can help with?`
        : `I'm following up on my last email to see how things are going. If you need anything${prod ? ', such as more ' + prod : ''}, just let me know.`,
      short: first
        ? `Quick check-in. Do you need any more ${prod || 'workwear'} at the moment? Happy to help.`
        : `Just a quick follow-up. Is there anything you need${prod ? ' in the way of ' + prod : ''}?`,
      formal: first
        ? `${fn ? 'Dear ' + fn : 'Good day'},\n\nI am writing to follow up on your last order with us${when}. Please let me know if you would like to place a further order, or if there is anything we can assist with.`
        : `${fn ? 'Dear ' + fn : 'Good day'},\n\nFurther to my previous email, I would be grateful if you could let me know whether you require anything further from us.`,
      gentle: first
        ? `No pressure at all. I realised it's been a while since your last order${when}, so I thought I'd say hello. If you need anything, just let me know.`
        : `I know things get busy, so I'm just popping my last email back to the top of your inbox. If now isn't the right time, that's fine, and I'll leave it with you.`,
      helpful: first
        ? `It's been a while since your last order${when}. If you need more ${prod || 'of the same'}, new starters kitted out, or something different, tell me what you need and I'll put a quote together for you.`
        : `I'm following up in case it helps. If you need more ${prod || 'of the same'} or something different, just tell me what you need and I'll sort a quote for you.`,
      ready: first
        ? `It's been a while since your last order${when}. If you'd like the same again, just reply with what you need and I'll get it set up.`
        : `Just a quick reminder. If you'd like to reorder, reply with what you need and I'll get it moving.`
    };
    const body = tone === 'formal' ? `${L.formal}\n\nKind regards,\n${me}\nATAM Workwear` : `${hi},\n\n${L[tone]}\n\nKind regards,\n${me}\nATAM Workwear`;
    const subjects = {
      friendly: first ? 'Just checking in' : 'Following up',
      short: 'Quick check-in',
      formal: first ? 'Following up on your last order' : 'Following up on my previous email',
      gentle: first ? 'Just saying hello' : 'Just checking in again',
      helpful: 'Anything you need?',
      ready: 'Ready when you are'
    };
    return { subject: subjects[tone], body };
  }

  function emailSectionHtml(r) {
    if (!mailOn()) return '';
    if (!r.email) return '<div class="qt-email-wrap"><div class="qt-note">No email address is on file for this customer, so this one needs a phone call.</div></div>';
    let timer = '';
    if (r.emailCycle && r.emailSentAt) {
      const left = r.emailDueAt ? r.emailDueAt - Date.now() : 0;
      if (r.emailRepliedAt) timer = `<div class="qt-timer qt-timer-ok">✉️ Email #${r.emailNo} sent. The customer has replied</div>`;
      else if (r.emailDue) timer = `<div class="qt-timer qt-timer-due">⏰ No reply to email #${r.emailNo} (sent ${esc(fmtDateTime(r.emailSentAt))}). Time to follow up</div>`;
      else timer = `<div class="qt-timer" title="Sent from ${esc(r.emailSender)}">✉️ Email #${r.emailNo} sent ${esc(fmtDateTime(r.emailSentAt))}. Waiting for a reply: ${left > DAY ? Math.ceil(left / DAY) + ' days' : Math.max(1, Math.ceil(left / 3600000)) + ' hours'} left</div>`;
    }
    const nextNo = r.emailCycle ? r.emailNo + 1 : 1;
    return `<div class="qt-email-wrap">${timer}<button type="button" class="qt-btn qt-primary qt-mailbtn" data-act="mail" data-for="${esc(r.id)}">✉️ ${nextNo > 1 ? 'Email #' + nextNo : 'Email the customer'}</button><div id="qtCompose"></div></div>`;
  }

  async function openCompose(id) {
    const r = state.rows.find(x => x.id === id);
    const box = $('qtCompose');
    const A = window.ATAM_QT;
    if (!r || !box) return;
    if (!A) { box.innerHTML = '<div class="qt-note qt-note-bad">The email box is not loaded yet. Refresh the page and try again.</div>'; return; }
    box.innerHTML = '<div class="qt-dim">Loading…</div>';
    let list;
    try { list = await A.loadSenders(); } catch (e) { console.error('senders failed', e); box.innerHTML = '<div class="qt-note qt-note-bad">Couldn\'t load the sender list.</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="qt-note">No sender mailboxes have been set up yet.</div>'; return; }
    const def = A.pickSender(list, r.owner);
    const no = r.emailCycle ? r.emailNo + 1 : 1;
    A.mountCompose(box, {
      senders: list, def, to: r.email, no, kind: 'winback', linkEnabled: false, rep: r.owner,
      heading: no > 1 ? `Email #${no} to this customer` : 'Email this customer',
      footnote: `Sends straight away from the mailbox above and logs it as a contact on this customer. If there is no reply in 3 days it shows as due a follow-up, and a reply in that mailbox moves the card to "Replied, your move" by itself. Nothing sends until you press Send.`,
      draft: (sender, tone) => draftReorder(r, sender, no, tone),
      queue: p => client().rpc('queue_winback_email', { p_customer_id: id, p_sender_id: p.senderId, p_to: p.to, p_subject: p.subject, p_body: p.body }),
      toast,
      after: async () => { const b = $('qtCompose'); if (b) b.innerHTML = ''; await load(true); }
    });
  }

  // ----- customer history panel (same panel as the Quotes tab, built by window.ATAM_QT.histHtml) -----
  const histCache = new Map();
  const HIST_TTL = 5 * 60 * 1000;
  const setHist = html => { const el = $('wbHist'); if (el) el.innerHTML = html; };
  async function loadHistory(id) {
    const hit = histCache.get(id);
    if (hit && Date.now() - hit.at < HIST_TTL) { renderHistory(id, hit.data, hit.emails); return; }
    setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide">Loading customer history…</div></div>');
    try {
      const [h, em] = await Promise.all([
        client().rpc('winback_customer_history', { p_customer_id: id }),
        client().from('winback_emails').select('chase_no,sender_email,subject,status,sent_at,replied_at,sent_by,created_at').eq('customer_id', id).order('created_at', { ascending: false }).limit(10)
      ]);
      if (h.error) throw h.error;
      const emails = em.error ? [] : (em.data || []);
      histCache.set(id, { at: Date.now(), data: h.data, emails });
      renderHistory(id, h.data, emails);
    } catch (e) {
      console.error('customer history failed', e);
      if (state.openId === id) setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide"><b>Couldn\'t load the customer history.</b> <button type="button" class="qt-btn" data-act="hist-retry">Try again</button></div></div>');
    }
  }
  function renderHistory(id, h, emails) {
    if (state.openId !== id) return;
    const r = state.rows.find(x => x.id === id);
    if (!r || !window.ATAM_QT) return;
    // this customer's quotes, in the shape the Quotes tab history expects
    const quotes = r.quotes.map(q => ({
      id: q.id, customer: r.label, job: q.job, value: q.value, created: q.created, email: r.email, contact: r.contactName,
      stage: q.approved ? 'won' : q.cancelled || q.st === 'lost' ? 'lost' : q.st === 'cold' ? 'cold' : q.st === 'chase' ? 'chase' : 'fresh', instant: false
    }));
    const pts = [];
    if (r.overdueBy != null && r.mean) pts.push(`⏰ Usually reorders every <b>about ${r.mean} days</b>. It has been <b>${r.dsl != null ? r.dsl : '?'} days</b> since their last order, so they are ${r.overdueBy > 0 ? '<b>' + r.overdueBy + ' days overdue</b>' : 'due in ' + Math.abs(r.overdueBy) + ' days'}.`);
    if (r.lastQuote) pts.push(`🧾 Last quote was ${esc(fmtDate(r.lastQuote.created))} (${esc(gbp(r.lastQuote.value))}${r.lastQuote.job ? ', ' + esc(r.lastQuote.job) : ''})${r.lastQuote.approved ? ', and they approved it' : r.lastOrder && r.lastQuote.created < r.lastOrder ? ', before their last order' : ', and it was not approved'}.`);
    else pts.push('🧾 No quote on file for this customer (quotes are only kept from mid 2026).');
    if (r.coldQuote) pts.push(`🧊 They were quoted ${esc(gbp(r.coldQuote.value))} and it went quiet. A good reason to get back in touch.`);
    if (r.emailCycle && r.emailSentAt) pts.push(r.emailRepliedAt ? `✉️ They replied to our email of ${esc(fmtDate(r.emailSentAt))}.` : `✉️ We emailed them on ${esc(fmtDate(r.emailSentAt))} from ${esc(r.emailSender)} and have not had a reply yet.`);
    const sent = (emails || []).filter(e => e.status === 'sent');
    const top = sent.length ? `<section class="qt-hc qt-hc-wide"><h4>Emails sent from ATAM GO</h4>
      <table class="qt-ht"><thead><tr><th>Sent</th><th>Subject</th><th>From</th><th>Sent by</th><th>Reply</th></tr></thead><tbody>
      ${sent.map(e => `<tr><td>${esc(fmtDateTime(toDate(e.sent_at)))}</td><td>${esc(e.subject)}</td><td>${esc(e.sender_email)}</td><td>${esc(e.sent_by || '—')}</td><td>${e.replied_at ? '<span class="qt-hpill good">Replied ' + esc(fmtShort(toDate(e.replied_at))) + '</span>' : '<span class="qt-dim">none yet</span>'}</td></tr>`).join('')}</tbody></table></section>` : '';
    setHist(window.ATAM_QT.histHtml({ id: r.id, customer: r.label }, h || { found: false }, { quotes, noOpen: true, noun: 'customer', points: pts, top }));
  }

  function toast(msg, bad) {
    const t = $('wbToast'); if (!t) return;
    t.textContent = msg; t.className = 'wb-toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = 'wb-toast'; }, 3500);
  }

  // ───────────────────────── styles ─────────────────────────
  function injectStyles() {
    if ($('wbStyles')) return;
    const s = document.createElement('style');
    s.id = 'wbStyles';
    s.textContent = `
#winback .wb-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(99,102,241,.14), transparent 60%), rgba(15,23,42,.55); }
#winback .wb-head h2 { margin:0 0 6px; font-size:28px; }
#winback .wb-head p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#winback .wb-head .eyebrow { margin-bottom:4px; }
#winback .wb-how { margin:14px 0 0; padding:12px 16px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.6); }
#winback .wb-how summary { cursor:pointer; font-weight:600; color:#7dd3fc; }
#winback .wb-how p, #winback .wb-how li { color:#cbd5e1; font-size:13.5px; line-height:1.5; }
#winback .wb-how-steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; margin:10px 0; }
#winback .wb-how-steps > div { border-left:4px solid var(--c); padding:8px 10px; background:#0f172a; border-radius:8px; display:flex; flex-direction:column; gap:4px; }
#winback .wb-how-steps span { color:#94a3b8; font-size:12.5px; }
#winback .wb-how-steps em { font-style:normal; color:#e2e8f0; font-size:12.5px; }
.wb-drawer .wb-move { margin:14px 0 0; padding:12px 14px; border-radius:12px; border:1px solid rgba(56,189,248,.35); background:rgba(56,189,248,.07); }
.wb-drawer .wb-move h4 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#7dd3fc; }
.wb-drawer .wb-move p { margin:0 0 6px; font-size:13.5px; line-height:1.45; }
.wb-drawer .wb-move ol { margin:0 0 10px; padding-left:20px; color:#cbd5e1; font-size:13px; line-height:1.5; }
#winback .wb-updated { font-size:11.5px; color:#64748b; white-space:nowrap; padding-top:6px; }
#winback .wb-kpis { display:grid; grid-template-columns:repeat(6,1fr); margin:22px 0 14px; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.82); overflow:hidden; }
#winback .wb-kpi { position:relative; padding:16px 18px; border-right:1px solid rgba(255,255,255,.08); min-width:0; animation:wbUp .5s both; animation-delay:calc(var(--i,0) * 60ms); }
#winback .wb-kpi:last-child { border-right:none; }
#winback .wb-kpi .wb-spark { position:absolute; right:14px; top:16px; }
#winback .wb-kpi-n { font-size:28px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
#winback .wb-kpi-attn .wb-kpi-n { color:#fbbf24; }
#winback .wb-kpi-good .wb-kpi-n { color:#4ade80; }
#winback .wb-kpi-l { font-size:12.5px; color:#cbd5e1; margin-top:8px; }
#winback .wb-kpi-s { font-size:11px; color:#64748b; margin-top:2px; }
@keyframes wbUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
#winback .wb-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:12px; }
#winback .wb-tabs { display:flex; gap:6px; flex-wrap:wrap; flex:1; min-width:260px; }
#winback .wb-tab { padding:8px 14px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background:transparent; color:#94a3b8; font-size:12.5px; font-weight:600; cursor:pointer; }
#winback .wb-tab:hover { color:#e2e8f0; border-color:rgba(255,255,255,.25); }
#winback .wb-tab.active { background:rgba(56,189,248,.14); border-color:rgba(56,189,248,.5); color:#e0f2fe; }
#winback .wb-tab-n { display:inline-block; min-width:18px; margin-left:6px; padding:1px 6px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; text-align:center; font-variant-numeric:tabular-nums; }
#winback .wb-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
#winback .wb-seg { display:inline-flex; border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
#winback .wb-seg button { padding:7px 12px; background:transparent; border:none; border-right:1px solid rgba(255,255,255,.1); color:#94a3b8; font-size:12px; font-weight:600; cursor:pointer; }
#winback .wb-seg button:last-child { border-right:none; }
#winback .wb-seg button.on { background:rgba(56,189,248,.16); color:#e0f2fe; }
#winback select, #winback input[type=search] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:rgba(15,23,42,.9); color:#e2e8f0; font-size:12.5px; max-width:230px; }
#winback input[type=search] { min-width:200px; }
#winback .wb-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#winback .wb-btn:hover { background:rgba(255,255,255,.06); }
#winback .wb-btn:disabled { opacity:.5; cursor:default; }
#winback .wb-primary, .wb-drawer .wb-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#winback .wb-primary:hover, .wb-drawer .wb-primary:hover { background:linear-gradient(135deg,#38bdf8,#6366f1); opacity:.9; }
#winback :focus-visible, .wb-drawer :focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
#winback .wb-empty { padding:50px 20px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:14px; line-height:2; }
#winback .wb-dim { color:#64748b; font-size:12px; }
#winback .wb-first { margin-bottom:18px; padding:16px 18px; border-radius:16px; border:1px solid rgba(245,158,11,.28); background:linear-gradient(135deg, rgba(245,158,11,.1), rgba(15,23,42,.6) 55%); }
#winback .wb-first-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:12px; }
#winback .wb-first-h h3 { margin:0; font-size:15px; }
#winback .wb-first-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
#winback .wb-first-card { padding:13px 14px; border-radius:12px; background:rgba(2,6,23,.55); border:1px solid rgba(255,255,255,.08); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s; animation:wbUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#winback .wb-first-card:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.25); border-left-color:var(--c); }
#winback .wb-first-val { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
#winback .wb-first-cust { font-size:13px; font-weight:600; margin:2px 0 8px; overflow-wrap:anywhere; }
#winback .wb-first-meta { display:flex; align-items:center; gap:7px; font-size:11.5px; color:#94a3b8; }
#winback .wb-first-meta > span:not(.wb-av) { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#winback .wb-first-meta b { color:var(--c); font-weight:600; white-space:nowrap; }
#winback .wb-reply { display:inline-block; margin:0 0 8px; padding:3px 9px; border-radius:7px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; font-size:11px; font-weight:600; }
.wb-drawer .wb-reply-lg { display:block; margin:0 0 14px; padding:9px 12px; font-size:12.5px; border-radius:10px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; }
#winback .wb-funnel-box { margin-bottom:18px; }
#winback .wb-funnel { display:flex; gap:4px; height:34px; }
#winback .wb-fseg { display:flex; align-items:center; padding:0 12px; min-width:0; border-radius:8px; background:linear-gradient(90deg, color-mix(in srgb, var(--c) 70%, #020617), color-mix(in srgb, var(--c) 45%, #020617)); font-size:12px; font-weight:700; overflow:hidden; white-space:nowrap; animation:wbGrow .7s both; transform-origin:left; }
@keyframes wbGrow { from { transform:scaleX(0); opacity:0; } to { transform:none; opacity:1; } }
#winback .wb-flegend { display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; font-size:11.5px; color:#94a3b8; }
#winback .wb-flegend i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:6px; background:var(--c); }
#winback .wb-board { width:0; min-width:100%; display:grid; grid-template-columns:repeat(5,minmax(205px,1fr)); gap:12px; overflow-x:auto; padding-bottom:10px; align-items:start; }
#winback .wb-col { background:rgba(15,23,42,.6); border:1px solid rgba(255,255,255,.08); border-top:3px solid var(--c); border-radius:14px; min-width:205px; }
#winback .wb-col-h { padding:12px 14px 10px; border-bottom:1px solid rgba(255,255,255,.06); background:linear-gradient(180deg, color-mix(in srgb, var(--c) 10%, transparent), transparent); border-radius:12px 12px 0 0; }
#winback .wb-col-t { font-weight:700; font-size:13.5px; }
#winback .wb-col-n { margin-left:8px; padding:1px 8px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; font-variant-numeric:tabular-nums; }
#winback .wb-col-s { font-size:11px; color:#64748b; margin-top:4px; }
#winback .wb-col-b { padding:10px; display:flex; flex-direction:column; gap:8px; max-height:68vh; overflow-y:auto; }
#winback .wb-col-empty { padding:24px 0; text-align:center; color:#475569; font-size:12px; }
#winback .wb-card { padding:11px 12px; border-radius:11px; background:rgba(30,41,59,.7); border:1px solid rgba(255,255,255,.07); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s, background .15s, box-shadow .15s; animation:wbUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#winback .wb-card:hover { transform:translateY(-2px); background:rgba(51,65,85,.7); border-color:rgba(255,255,255,.18); border-left-color:var(--c); box-shadow:0 10px 30px rgba(0,0,0,.35), 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent); }
#winback .wb-card-top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
#winback .wb-card-cust { font-weight:600; font-size:13px; line-height:1.3; overflow-wrap:anywhere; }
#winback .wb-card-job { margin-top:3px; font-size:11.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#winback .wb-card-val { font-weight:700; font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
#winback .wb-card-mid { display:flex; align-items:center; gap:7px; margin:8px 0; font-size:11.5px; color:#94a3b8; }
#winback .wb-card-rep { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#winback .wb-card-id { color:#64748b; font-variant-numeric:tabular-nums; }
#winback .wb-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.08); overflow:hidden; }
#winback .wb-bar i { display:block; height:100%; border-radius:2px; }
#winback .wb-card-foot { display:flex; justify-content:space-between; gap:8px; margin-top:7px; font-size:11px; color:#94a3b8; }
#winback .wb-quick { margin-top:9px; width:100%; padding:6px 10px; border-radius:8px; border:1px solid color-mix(in srgb, var(--c, #38bdf8) 55%, transparent); background:color-mix(in srgb, var(--c, #38bdf8) 12%, transparent); color:#f1f5f9; font-size:11.5px; font-weight:600; cursor:pointer; }
#winback .wb-quick:hover { background:color-mix(in srgb, var(--c, #38bdf8) 26%, transparent); }
#winback .wb-quick:disabled { opacity:.6; cursor:default; }
.wb-av { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; font-size:10px; font-weight:700; color:#fff; flex:none; }
#winback .wb-rep { display:inline-flex; align-items:center; gap:8px; }
.wb-chip { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:600; color:var(--c); background:color-mix(in srgb, var(--c) 14%, transparent); border:1px solid color-mix(in srgb, var(--c) 40%, transparent); }
#winback .wb-tablewrap { width:0; min-width:100%; overflow-x:auto; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); }
#winback .wb-table { width:100%; border-collapse:collapse; font-size:13px; }
#winback .wb-table th { text-align:left; padding:11px 14px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,.1); cursor:pointer; white-space:nowrap; user-select:none; }
#winback .wb-table th.sorted { color:#e0f2fe; }
#winback .wb-table td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,.05); white-space:nowrap; }
#winback .wb-table .r, #winback .wb-table th.r { text-align:right; font-variant-numeric:tabular-nums; }
#winback .wb-table tbody tr { cursor:pointer; }
#winback .wb-table tbody tr:hover { background:rgba(56,189,248,.07); }
#winback .wb-tfoot { margin-top:10px; font-size:12px; color:#94a3b8; text-align:right; }
#winback .wb-chartbox { border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); padding:16px 18px; margin-bottom:22px; }
#winback .wb-chart-h, #winback .wb-team-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:10px; }
#winback .wb-chart-h h3, #winback .wb-team-h h3 { margin:0; font-size:15px; }
#winback .wb-chart { position:relative; height:220px; }
#winback .wb-team { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
#winback .wb-rep-card { padding:16px; border-radius:16px; border:1px solid rgba(255,255,255,.1); border-top:3px solid hsl(var(--h,200) 65% 55%); background:linear-gradient(180deg, hsl(var(--h,200) 60% 50% / .07), rgba(15,23,42,.85) 40%); cursor:pointer; transition:border-color .15s, transform .15s; animation:wbUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#winback .wb-rep-card:hover { border-color:rgba(56,189,248,.5); transform:translateY(-2px); }
#winback .wb-rep-card.sel { border-color:#38bdf8; box-shadow:0 0 0 1px #38bdf8 inset; }
#winback .wb-rep-card header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
#winback .wb-rep-id { display:flex; align-items:center; gap:10px; min-width:0; }
#winback .wb-rep-id .wb-av { width:38px; height:38px; font-size:14px; }
#winback .wb-rep-name { font-weight:700; font-size:15px; }
#winback .wb-medal { font-size:15px; }
#winback .wb-rep-sub { font-size:11.5px; color:#94a3b8; margin-top:2px; }
#winback .wb-rep-sub.warn, #winback .wb-rep-grid .warn b { color:#fbbf24; }
#winback .wb-ring { --p:0; width:68px; height:68px; border-radius:50%; flex:none; display:grid; place-items:center; background:conic-gradient(#22c55e calc(var(--p) * 1%), rgba(255,255,255,.09) 0); }
#winback .wb-ring > div { width:54px; height:54px; border-radius:50%; background:#0f172a; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.1; }
#winback .wb-ring b { font-size:15px; }
#winback .wb-ring span { font-size:8px; color:#94a3b8; text-transform:uppercase; letter-spacing:.04em; }
#winback .wb-rep-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px 8px; }
#winback .wb-rep-grid b { display:block; font-size:15px; font-variant-numeric:tabular-nums; }
#winback .wb-rep-grid span { font-size:10.5px; color:#64748b; }
#winback .wb-split { display:flex; gap:2px; height:6px; border-radius:3px; overflow:hidden; margin-top:14px; }
#winback .wb-split i { display:block; }
#winback .wb-spark-row { display:flex; align-items:center; gap:10px; margin-top:12px; font-size:11px; color:#64748b; }
#winback .wb-spark-row .wb-spark { flex:none; }
#winback .wb-rep-card footer { display:flex; justify-content:space-between; gap:8px; margin-top:14px; padding-top:11px; border-top:1px solid rgba(255,255,255,.07); font-size:11.5px; color:#94a3b8; }
#winback .wb-sk { border-radius:10px; background:linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.1), rgba(255,255,255,.04)); background-size:200% 100%; animation:wbShim 1.3s infinite linear; }
@keyframes wbShim { from { background-position:200% 0; } to { background-position:-200% 0; } }
#winback .wb-toast, .wb-toast { position:fixed; left:50%; bottom:26px; transform:translate(-50%,20px); opacity:0; pointer-events:none; padding:11px 18px; border-radius:10px; background:#0f172a; border:1px solid rgba(34,197,94,.5); color:#dcfce7; font-size:13px; z-index:2000; transition:all .2s; }
.wb-toast.show { opacity:1; transform:translate(-50%,0); }
.wb-toast.bad { border-color:rgba(248,113,113,.6); color:#fecaca; }
.wb-nav-badge { margin-left:8px; padding:1px 8px; border-radius:9px; background:#fbbf24; color:#1e293b; font-size:11px; font-weight:700; }
body.wb-lock { overflow:hidden; }
.wb-drawer { position:fixed; inset:0; z-index:1500; visibility:hidden; }
.wb-drawer.open { visibility:visible; }
.wb-drawer .wb-backdrop { position:absolute; inset:0; background:rgba(2,6,23,.65); backdrop-filter:blur(3px); opacity:0; transition:opacity .2s; }
.wb-drawer.open .wb-backdrop { opacity:1; }
.wb-drawer .wb-sheet { position:absolute; top:0; right:0; bottom:0; width:min(480px,100%); background:#0b1220; border-left:1px solid rgba(255,255,255,.12); padding:22px; overflow-y:auto; transform:translateX(100%); transition:transform .25s ease; outline:none; color:#f8fafc; }
.wb-drawer.open .wb-sheet { transform:none; }
.wb-drawer .wb-d-top { display:flex; justify-content:space-between; gap:12px; border-top:3px solid var(--c); margin:-22px -22px 0; padding:18px 22px 0; }
.wb-drawer .wb-d-eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#64748b; }
.wb-drawer h3 { margin:4px 0 6px; font-size:21px; line-height:1.25; overflow-wrap:anywhere; }
.wb-drawer .wb-d-job { margin:0 0 10px; font-size:13px; color:#94a3b8; }
.wb-drawer .wb-x { width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; font-size:20px; cursor:pointer; flex:none; }
.wb-drawer .wb-d-val { margin:16px 0 14px; font-size:32px; font-weight:700; font-variant-numeric:tabular-nums; }
.wb-drawer .wb-d-val span { margin-left:10px; font-size:12px; color:#94a3b8; font-weight:400; }
.wb-drawer .wb-deco { display:inline-block; margin:0 0 16px; padding:7px 12px; border-radius:8px; border:1px solid rgba(56,189,248,.45); color:#bae6fd; font-size:12.5px; font-weight:600; text-decoration:none; }
.wb-drawer .wb-deco:hover { background:rgba(56,189,248,.12); }
.wb-drawer .wb-facts { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.07); border-radius:12px; overflow:hidden; }
.wb-drawer .wb-facts > div { background:#0f172a; padding:11px 13px; min-width:0; }
.wb-drawer .wb-facts > div > span { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin-bottom:3px; }
.wb-drawer .wb-facts b { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.wb-drawer .wb-facts a { color:#7dd3fc; font-weight:400; }
.wb-drawer .wb-rep { display:inline-flex; align-items:center; gap:8px; }
.wb-drawer .wb-chase { margin-top:20px; padding:14px; border-radius:12px; background:rgba(56,189,248,.07); border:1px solid rgba(56,189,248,.25); }
.wb-drawer .wb-chase h4, .wb-drawer .wb-d-h { margin:0 0 10px; font-size:13px; }
.wb-drawer .wb-d-h { margin:22px 0 10px; }
.wb-drawer .wb-chase-row { display:flex; gap:8px; flex-wrap:wrap; }
.wb-drawer .wb-chase select, .wb-drawer .wb-chase input { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font-size:13px; }
.wb-drawer .wb-chase input { flex:1; min-width:140px; }
.wb-drawer .wb-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); background:transparent; }
.wb-drawer .wb-btn:disabled { opacity:.5; }
.wb-drawer .wb-dim { color:#64748b; font-size:12px; }
.wb-drawer .wb-chase p { margin:10px 0 0; }
.wb-drawer .wb-timeline { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px; }
.wb-drawer .wb-timeline li { display:flex; gap:11px; font-size:13px; line-height:1.4; }
.wb-drawer .wb-hist { display:none; position:absolute; top:0; bottom:0; left:0; right:calc(min(480px,100%) + 44px); padding:22px 26px 22px 22px; overflow-y:auto; pointer-events:none; opacity:0; transform:translateX(24px); transition:opacity .25s .05s, transform .25s .05s; color:#f8fafc; }
.wb-drawer.open .wb-hist { opacity:1; transform:none; }
@media (min-width: 1180px) { .wb-drawer .wb-hist { display:block; } }
@media (prefers-reduced-motion: reduce) { .wb-drawer .wb-hist { transition:none !important; } }
.wb-drawer .wb-timeline li.good { color:#86efac; } .wb-drawer .wb-timeline li.bad { color:#fca5a5; }
.wb-drawer .wb-tl-i { width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,.07); display:grid; place-items:center; font-size:12px; flex:none; }
@media (max-width: 1100px) { #winback .wb-kpis { grid-template-columns:repeat(3,1fr); } #winback .wb-kpi:nth-child(3n) { border-right:none; } #winback .wb-kpi:nth-child(-n+3) { border-bottom:1px solid rgba(255,255,255,.08); } }
@media (max-width: 640px) { #winback .wb-head { padding:16px; flex-direction:column; } #winback .wb-kpi .wb-spark { display:none; }
  #winback .wb-kpis { grid-template-columns:repeat(2,1fr); } #winback .wb-kpi:nth-child(3n) { border-right:1px solid rgba(255,255,255,.08); } #winback .wb-kpi:nth-child(2n) { border-right:none; } #winback .wb-kpi { border-bottom:1px solid rgba(255,255,255,.08); }
  #winback .wb-board { grid-template-columns:repeat(5,82vw); scroll-snap-type:x mandatory; } #winback .wb-col { scroll-snap-align:start; }
  #winback input[type=search] { min-width:0; flex:1; } .wb-drawer .wb-facts { grid-template-columns:1fr; } }
@media (prefers-reduced-motion: reduce) { #winback *, #winback *::before, #winback *::after, .wb-drawer .wb-sheet, .wb-drawer .wb-backdrop { animation:none !important; transition:none !important; } }

#winback .wb-head { background:radial-gradient(120% 140% at 0% 0%, rgba(249,115,22,.18), transparent 60%), radial-gradient(90% 120% at 100% 0%, rgba(139,92,246,.14), transparent 55%), rgba(15,23,42,.85); }
#winback .wb-tab.active { background:rgba(249,115,22,.14); border-color:rgba(249,115,22,.55); color:#ffedd5; }
#winback .wb-seg button.on { background:rgba(249,115,22,.16); color:#ffedd5; }
#winback .wb-primary, .wb-drawer .wb-primary { background:linear-gradient(135deg,#f97316,#ec4899); }
#winback .wb-primary:hover, .wb-drawer .wb-primary:hover { background:linear-gradient(135deg,#f97316,#ec4899); }
#winback :focus-visible, .wb-drawer :focus-visible { outline-color:#fb923c; }
#winback .wb-board { grid-template-columns:repeat(6,minmax(215px,1fr)); }
#winback .wb-col { min-width:215px; }
#winback .wb-value-line { margin:0 0 14px; font-size:13px; color:#cbd5e1; }
#winback .wb-value-line b { color:#fdba74; font-size:15px; }
#winback .wb-card-sub { margin-top:3px; font-size:11.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#winback .wb-card-val small { display:block; font-size:9.5px; font-weight:500; color:#64748b; text-align:right; }
#winback .wb-flags { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 8px; }
#winback .wb-flag { display:inline-block; padding:2px 8px; border-radius:7px; font-size:10.5px; font-weight:600; border:1px solid rgba(255,255,255,.16); color:#cbd5e1; background:rgba(255,255,255,.05); }
#winback .wb-flag.hot { border-color:rgba(251,191,36,.5); color:#fde68a; background:rgba(251,191,36,.12); }
#winback .wb-flag.good { border-color:rgba(34,197,94,.45); color:#bbf7d0; background:rgba(34,197,94,.12); }
#winback .wb-flag.cool { border-color:rgba(56,189,248,.45); color:#bae6fd; background:rgba(56,189,248,.1); }
#winback .wb-flag.purple { border-color:rgba(167,139,250,.5); color:#ddd6fe; background:rgba(167,139,250,.12); }
#winback .wb-flag.dim { color:#94a3b8; }
#winback .wb-qchip { display:flex; justify-content:space-between; gap:8px; align-items:center; margin:0 0 7px; padding:6px 9px; border-radius:9px; background:rgba(34,211,238,.08); border:1px solid rgba(34,211,238,.28); font-size:11.5px; color:#cffafe; }
#winback .wb-qchip.cold { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.3); color:#cbd5e1; }
#winback .wb-qchip b { font-variant-numeric:tabular-nums; }
#winback .wb-qchip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
#winback .wb-quickrow { display:flex; gap:6px; margin-top:9px; }
#winback .wb-quickrow .wb-quick { margin-top:0; }
#winback .wb-quickrow .wb-quick.alt { width:auto; flex:none; background:transparent; border-color:rgba(255,255,255,.16); color:#cbd5e1; }
#winback .wb-bar i.over { background:repeating-linear-gradient(45deg,#ef4444,#ef4444 6px,#f97316 6px,#f97316 12px) !important; }
#winback .wb-more { width:100%; padding:8px; border-radius:9px; border:1px dashed rgba(255,255,255,.2); background:transparent; color:#94a3b8; font-size:12px; cursor:pointer; }
#winback .wb-more:hover { color:#e2e8f0; border-color:rgba(255,255,255,.4); }
#winback .wb-first { border-color:rgba(249,115,22,.3); background:linear-gradient(135deg, rgba(249,115,22,.1), rgba(15,23,42,.6) 55%); }
#winback .wb-hint { font-size:12px; color:#94a3b8; }
#winback .wb-check { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#94a3b8; cursor:pointer; }
#winback .wb-linkrow input[type=text] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:rgba(15,23,42,.9); color:#e2e8f0; font-size:12.5px; width:min(340px,100%); }
#winback .wb-linkrow td { white-space:normal; }
#winback .wb-linkrow .wb-btn { margin-right:6px; }
#winback .wb-note { margin:0 0 14px; padding:12px 14px; border-radius:12px; background:rgba(56,189,248,.07); border:1px solid rgba(56,189,248,.25); font-size:12.5px; color:#cbd5e1; line-height:1.5; }
.wb-drawer .wb-chase { background:rgba(249,115,22,.07); border-color:rgba(249,115,22,.28); }
.wb-drawer .wb-chase label { display:block; margin:0 0 4px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
.wb-drawer .wb-field { flex:1; min-width:130px; }
.wb-drawer .wb-field select, .wb-drawer .wb-field input, .wb-drawer textarea { width:100%; box-sizing:border-box; }
.wb-drawer textarea { margin-top:8px; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font:inherit; font-size:13px; min-height:60px; resize:vertical; }
.wb-drawer .wb-chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.wb-drawer .wb-chips button { padding:3px 9px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:transparent; color:#cbd5e1; font-size:11px; cursor:pointer; }
.wb-drawer .wb-chips button:hover { background:rgba(255,255,255,.08); }
.wb-drawer .wb-submit { margin-top:10px; width:100%; padding:10px; }
.wb-drawer .wb-other { margin-top:16px; padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.03); }
.wb-drawer .wb-other h4 { margin:0 0 8px; font-size:12.5px; }
.wb-drawer .wb-other .wb-chase-row { align-items:center; }
.wb-drawer .wb-dq { display:block; margin:0 0 8px; padding:9px 11px; border-radius:10px; background:#0f172a; border:1px solid rgba(255,255,255,.08); font-size:12.5px; }
.wb-drawer .wb-dq-top { display:flex; justify-content:space-between; gap:8px; font-weight:600; }
.wb-drawer .wb-dq-sub { margin-top:3px; color:#94a3b8; font-size:11.5px; }
.wb-drawer .wb-dq a { color:#7dd3fc; font-weight:600; font-size:11.5px; }
.wb-drawer .wb-banner { display:block; margin:14px 0 0; padding:9px 12px; font-size:12.5px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05); color:#e2e8f0; }
.wb-drawer .wb-banner.good { background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.4); color:#bbf7d0; }
.wb-drawer .wb-banner.warn { background:rgba(251,191,36,.12); border-color:rgba(251,191,36,.4); color:#fde68a; }
.wb-drawer .wb-banner.purple { background:rgba(167,139,250,.12); border-color:rgba(167,139,250,.4); color:#ddd6fe; }
.wb-drawer .wb-d-val { font-size:26px; }
@media (max-width: 640px) { #winback .wb-board { grid-template-columns:repeat(6,82vw); } }
#winback .wb-quick { white-space:nowrap; padding:6px 8px; font-size:11.5px; }
#winback .wb-quickrow .wb-quick:not(.alt) { flex:1; min-width:0; }
#winback .wb-first-meta { flex-wrap:wrap; }
#winback .wb-first-meta b { white-space:normal; }
#winback .wb-first-meta > span:not(.wb-av) { flex:0 1 auto; max-width:50%; }
#winback .wb-board { grid-template-columns:repeat(6,minmax(200px,1fr)); }
#winback .wb-col { min-width:200px; }
#winback .wb-rep-card footer { flex-wrap:wrap; }
@media (max-width: 640px) { #winback .wb-board { grid-template-columns:repeat(6,82vw); } }
#winback .wb-quickrow { flex-wrap:wrap; }
#winback .wb-quickrow .wb-quick, #winback .wb-quickrow .wb-quick.alt, #winback .wb-quickrow .wb-quick:not(.alt) { width:auto; flex:1 1 auto; min-width:max-content; }
`;
    document.head.appendChild(s);
  }

  // ───────────────────────── page ─────────────────────────
  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="quotes"]') || document.querySelector('.nav-link[data-page="salesinvoices"]') || document.querySelector('.nav-link[data-page]');
    const anchorPage = $('quotes') || $('salesinvoices') || document.querySelector('.dashboard-page');
    if (!anchorBtn || !anchorPage) return false;
    if (!document.querySelector('.nav-link[data-page="quotes"]') && boot.tries < 12) return false;   // give the Quotes tab a moment to appear first

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>📞 Win-back</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `
      <div class="wb-head">
        <div>
          <p class="eyebrow">Sales</p>
          <h2>Win-back</h2>
          <p>Customers who have gone past their usual reorder time, from first call to first order. Log what happens and the card moves along. Quotes raised in DecoNetwork are matched to the customer automatically, so a customer with a live quote moves to Quote out by itself.</p>
        </div>
        <div class="wb-updated" id="wbUpdated" aria-live="polite"></div>
      </div>
      <details class="wb-how" id="wbHow"><summary>New here? How Win-back works (a two-minute read)</summary>
        <p>A customer appears here when they have gone past their usual reorder time. Each one sits in a column. <b>Open a customer, read “Your move”, do it, then log what happened.</b> The card moves along by itself.</p>
        <div class="wb-how-steps">${BOARD.map(k => `<div style="--c:${STAGES[k].color}"><b>${STAGES[k].icon} ${esc(STAGES[k].label)}</b><span>${esc(STAGES[k].blurb)}</span><em>${esc(GUIDE[k].say)}</em></div>`).join('')}</div>
        <ul><li><b>Always log what happened</b> (even “no answer”), so the next person knows.</li><li><b>Always pick a “chase again” date.</b> It then appears in the Calendar tab and in the morning email.</li><li>Asked to be left alone, or closed down? Use Park or Mark lost, and add the reason.</li><li>Stuck on anything? Ask DAN (the robot button).</li></ul></details>
      <p class="wb-value-line" id="wbValue"></p>
      <div class="wb-kpis" id="wbKpis"></div>
      <div class="wb-toolbar"><div class="wb-tabs" id="wbTabs" role="tablist"></div></div>
      <div class="wb-tools">
        <div class="wb-seg" id="wbPeriod" role="group" aria-label="Period"></div>
        <select id="wbOwner" aria-label="Owner"><option value="">Everyone</option></select>
        <input type="search" id="wbSearch" placeholder="Search customer, contact or order" aria-label="Search customers">
        <label class="wb-check"><input type="checkbox" id="wbDormant"> Hide dormant (12m+)</label>
        <button type="button" class="wb-btn" data-act="reload">Refresh</button>
        <button type="button" class="wb-btn" data-act="export">⬇ Export CSV</button>
      </div>
      <div id="wbBody"><div class="wb-empty">Loading…</div></div>
      <div class="wb-toast" id="wbToast" role="status"></div>`;
    anchorPage.parentElement.appendChild(sec);

    const drawer = document.createElement('div');
    drawer.className = 'wb-drawer';
    drawer.id = 'wbDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Customer details');
    drawer.innerHTML = '<div class="wb-backdrop" data-act="close"></div><aside class="qt-hist wb-hist" id="wbHist" aria-label="Customer history"></aside><div class="wb-sheet" id="wbSheet" tabindex="-1"></div>';
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

    sec.addEventListener('click', e => {
      const log = e.target.closest('[data-log]');
      if (log) { e.stopPropagation(); openDrawer(log.dataset.log, true); return; }
      const ml = e.target.closest('[data-mail]');
      if (ml) { e.stopPropagation(); openDrawer(ml.dataset.mail); setTimeout(() => openCompose(ml.dataset.mail), 0); return; }
      const na = e.target.closest('[data-noanswer]');
      if (na) { e.stopPropagation(); logContact(na.dataset.noanswer, 'call', 'no_answer', '', isoDay(addDays(3)), na); return; }
      const more = e.target.closest('[data-more]');
      if (more) { state.expanded[more.dataset.more] = true; renderBody(); return; }
      const lk = e.target.closest('[data-link]');
      if (lk) {
        const row = lk.closest('tr'); const val = (row.querySelector('[data-link-input]') || {}).value || '';
        const c = (state.custList || []).find(x => x.label === val);
        if (!c) { toast('Pick a customer from the list first.', true); return; }
        linkQuote(lk.dataset.link, c.id, lk); return;
      }
      const nc = e.target.closest('[data-notcust]');
      if (nc) { linkQuote(nc.dataset.notcust, '_none', nc); return; }
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
        state.sort = { tab: state.tab, key: k, dir: state.sort.tab === state.tab && state.sort.key === k ? -state.sort.dir : (k === 'label' || k === 'owner' ? 1 : -1) };
        renderBody(); return;
      }
      const card = e.target.closest('[data-owner]');
      if (card) { const k = card.dataset.owner; state.owner = state.owner === k ? '' : k; if (state.owner) state.tab = 'pipeline'; renderAll(); return; }
      const item = e.target.closest('[data-id]');
      if (item) openDrawer(item.dataset.id);
    });
    sec.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button, input, select, a')) return;
      const item = e.target.closest('.wb-card[data-id], .wb-first-card[data-id], tr[data-id]');
      if (item) { e.preventDefault(); openDrawer(item.dataset.id); return; }
      const card = e.target.closest('.wb-rep-card');
      if (card) { e.preventDefault(); card.click(); }
    });
    $('wbOwner').addEventListener('change', e => { state.owner = e.target.value; renderAll(); });
    $('wbDormant').addEventListener('change', e => { state.hideDormant = e.target.checked; renderAll(); });
    $('wbSearch').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderHead(); renderKpis(); renderControls(); renderBody(); });

    drawer.addEventListener('click', e => {
      if (e.target.closest('[data-act="close"]')) { closeDrawer(); return; }
      const mb = e.target.closest('[data-act="mail"]');
      if (mb) { openCompose(mb.dataset.for); return; }
      if (e.target.closest('[data-act="hist-retry"]') && state.openId) { histCache.delete(state.openId); loadHistory(state.openId); return; }
      const mv = e.target.closest('[data-mv-m],[data-mv-mail]');
      if (mv) { useMove(mv); return; }
      const fu = e.target.closest('[data-fu]');
      if (fu) { const n = Number(fu.dataset.fu); const f = $('wbFollow'); f.value = n ? isoDay(addDays(n)) : ''; f.dataset.touched = '1'; return; }
      const stt = e.target.closest('[data-state]');
      if (stt && state.openId) {
        const a = stt.dataset.state;
        if (a === 'park') { const v = ($('wbParkDate') || {}).value; if (!v) { toast('Pick a date first.', true); return; } setState(state.openId, 'park', v, null, stt); }
        else if (a === 'lost') setState(state.openId, 'lost', null, ($('wbLostWhy') || {}).value, stt);
        else setState(state.openId, 'reopen', null, null, stt);
      }
    });
    drawer.addEventListener('change', e => {
      if (e.target.id === 'wbOwnerPick') {
        const row = state.rows.find(x => x.id === state.openId);
        if (!row) return;
        if (!e.target.value) return;
        setOwner(row.id, e.target.value === '__auto' ? '' : e.target.value, e.target);
        return;
      }
      if (e.target.id === 'wbOutcome') {
        const f = $('wbFollow');
        if (f && !f.dataset.touched) { const n = FOLLOW_UP[e.target.value]; f.value = n ? isoDay(addDays(n)) : ''; }
      }
      if (e.target.id === 'wbFollow') e.target.dataset.touched = '1';
    });
    drawer.addEventListener('submit', async e => {
      if (e.target.id !== 'wbLogForm') return;
      e.preventDefault();
      const id = state.openId; if (!id) return;
      const btnS = e.target.querySelector('[type=submit]');
      const ok = await logContact(id, $('wbMethod').value, $('wbOutcome').value, $('wbNote').value, $('wbFollow').value, btnS);
      if (ok && $('wbNote')) { $('wbNote').value = ''; }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.openId) closeDrawer(); });

    // sensible default follow-up for the first outcome shown
    renderControls();
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.WinbackPage = { reload: () => load(), state, open: id => openDrawer(String(id)) };
})();
