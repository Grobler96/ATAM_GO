// Account managers tab: every customer account, who owns it, what it earns, its quotes and an indicative margin.
//
// Where the data comes from (all read with the signed-in user's login; nothing here is shared publicly):
//   - get_account_managers()  one object per account: Xero invoice revenue (the same figures as the Customers tab), the owner,
//                             monthly bars, child accounts, and the pieces for the garment margin. sql/account_managers_2026-10-29.sql
//   - quotes_board            every quote. Their stage (hot, needs chasing, going cold, won, lost) is worked out by quotes.js
//                             (window.ATAM_QT.enrich) so this tab and the Quotes tab always agree.
//   - account_quote_map       which account each quote belongs to (matched by customer name).
//   - account_manager_history who moved which account, and when.
// Ownership belongs to the ACCOUNT, not to whoever keyed a quote in: set_account_managers() assigns one or many accounts, and every
// quote and pound of revenue on those accounts then counts for that person. Until someone is assigned, an automatic suggestion
// (who handled most invoiced orders, else who made most quotes) is shown, always labelled "Automatic".
// Adds its own nav button and page (app.js binds the nav once, same as quotes.js / calendar.js).
(function () {
  'use strict';

  const PAGE_ID = 'accountmanagers';
  const REFRESH_MS = 5 * 60 * 1000;
  const DAY = 86400000;
  const NONE = '__none';                 // the "no owner" bucket
  const ROWS_SHOWN = 40;                 // long account tables show this many until "Show all"
  const MIN_COSTED_ACCOUNT = 250;        // margin needs at least this much costed revenue on an account...
  const MIN_COSTED_MANAGER = 2000;       // ...and this much on a manager
  const LOW_COVERAGE = 0.25;             // below this share of sales being costed, the margin is shown dimmed as "low confidence"
  const PREF_KEY = 'atamgo_accountmanagers_prefs_v1';

  const PERIODS = {
    l12m: { label: 'Last 12 months', vs: 'previous 12 months' },
    fytd: { label: 'This financial year', vs: 'same point last year' }
  };

  const state = {
    period: 'l12m', view: 'overview', manager: null, filter: 'all', q: '', sort: { key: 'rev', dir: -1 }, showAll: false,
    selected: new Set(), openKey: null, showAllQuotes: false,
    data: null, quotes: [], qmap: {}, history: [], quotesError: null,
    loaded: false, loading: false, error: null, me: '', updatedAt: null, timer: null,
    saving: false, msg: null, lastFocus: null
  };
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (PERIODS[p.period]) state.period = p.period;
  } catch (e) { /* storage unavailable: defaults are fine */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ period: state.period })); } catch (e) { /* ignore */ } };

  // ───────────────────────── helpers ─────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const gbp = v => { const n = Math.round(num(v)); return (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB'); };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const hue = n => { let h = 0; String(n || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; };
  const avatar = (n, cls) => n === NONE || !n
    ? `<span class="am-av none ${cls || ''}" title="No owner">?</span>`
    : `<span class="am-av ${cls || ''}" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(n)}">${esc(initials(n))}</span>`;
  const mgrLabel = m => m === NONE ? 'Unassigned' : m;
  const fmtDate = v => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const daysAgo = v => { if (!v) return null; const d = new Date(String(v).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : Math.max(0, Math.round((Date.now() - d.getTime()) / DAY)); };
  const agoText = n => n == null ? '—' : n === 0 ? 'today' : n === 1 ? 'yesterday' : n < 60 ? n + ' days ago' : Math.round(n / 30.4) + ' months ago';
  const QT = () => (window.ATAM_QT && window.ATAM_QT.enrich) ? window.ATAM_QT : null;

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }
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

  // ───────────────────────── data ─────────────────────────
  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent && !state.loaded) { state.error = null; render(); }
    try {
      const [acc, quotesRes, mapRes, histRes] = await Promise.all([
        client().rpc('get_account_managers'),
        QT() ? pageAll(() => client().from('quotes_board').select('*').order('order_id', { ascending: false })).then(r => ({ rows: r }), e => ({ error: e })) : Promise.resolve({ error: { message: 'The Quotes tab did not load' } }),
        pageAll(() => client().from('account_quote_map').select('order_id,account_key,internal').order('order_id')).then(r => ({ rows: r }), e => ({ error: e })),
        client().from('account_manager_history').select('*').order('changed_at', { ascending: false }).limit(300)
      ]);
      if (acc.error) throw acc.error;
      state.data = acc.data;
      state.history = (histRes && !histRes.error && histRes.data) || [];
      state.quotesError = null;
      if (quotesRes.error || mapRes.error) {
        state.quotes = []; state.qmap = {};
        state.quotesError = (quotesRes.error || mapRes.error).message || 'Quotes could not be loaded';
      } else {
        const now = new Date(), q = QT();
        state.quotes = quotesRes.rows.map(r => q.enrich(r, now));
        state.qmap = {};
        mapRes.rows.forEach(m => { state.qmap[String(m.order_id)] = { key: m.account_key, internal: !!m.internal }; });
      }
      if (!state.me) {
        try {
          const u = await client().auth.getUser();
          const id = u && u.data && u.data.user && u.data.user.id;
          if (id) {
            const p = await client().from('profiles').select('full_name').eq('id', id).maybeSingle();
            state.me = (p && p.data && p.data.full_name) || '';
          }
        } catch (e) { /* "you" just stays unmarked */ }
      }
      state.loaded = true; state.error = null; state.updatedAt = new Date();
    } catch (e) {
      console.error('account managers load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load account managers';
    } finally { state.loading = false; }
    render();
  }

  // ───────────────────────── numbers ─────────────────────────
  function windowStart() {
    const d = new Date(String(state.data.as_of).slice(0, 10) + 'T00:00:00');
    if (state.period === 'fytd') return new Date(String(state.data.fy_start).slice(0, 10) + 'T00:00:00');
    d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  function quoteStats(rows, start) {
    const open = rows.filter(r => ['fresh', 'chase', 'cold'].includes(r.stage));
    const won = rows.filter(r => r.stage === 'won' && r.approved && r.approved >= start);
    const lost = rows.filter(r => r.stage === 'lost' && r.closedAt && r.closedAt >= start);
    // same rule as the Quotes tab: orders approved within the hour of being keyed in were never really quotes
    const wonQuotes = won.filter(r => !r.instant);
    const decided = wonQuotes.length + lost.length;
    return {
      open, won, lost, wonQuotes, decided,
      openValue: open.reduce((s, r) => s + r.value, 0),
      wonValue: won.reduce((s, r) => s + r.value, 0),
      rate: decided ? wonQuotes.length / decided : null
    };
  }

  // Everything the page shows, worked out once per render from the loaded data and the chosen period.
  function prepare() {
    const d = state.data, start = windowStart(), fy = state.period === 'fytd';
    const quotesByKey = {};
    state.quotes.forEach(r => {
      const m = state.qmap[r.id];
      if (!m || m.internal) return;
      (quotesByKey[m.key] = quotesByKey[m.key] || []).push(r);
    });
    const accounts = d.accounts.map(a => {
      const rows = quotesByKey[a.key] || [];
      const rev = num(fy ? a.rfy : a.r12), prev = num(fy ? a.rfy_ly : a.rprev);
      return Object.assign({}, a, {
        owner: a.owner || NONE, rev, prev,
        change: prev > 0 ? (rev - prev) / prev : null,
        crev: num(fy ? a.cfy_rev : a.c12_rev), cm: num(fy ? a.cfy_margin : a.c12_margin),
        quoteRows: rows, qs: quoteStats(rows, start),
        lastDays: daysAgo(a.last_invoice), isAuto: a.owner_source !== 'set'
      });
    });
    const byKey = {};
    accounts.forEach(a => { byKey[a.key] = a; });

    const names = new Set(d.reps || []);
    accounts.forEach(a => { if (a.owner !== NONE) names.add(a.owner); });
    const managers = {};
    const blank = n => ({ name: n, accounts: [], rev: 0, prev: 0, crev: 0, cm: 0, auto: 0, quoteRows: [] });
    names.forEach(n => { managers[n] = blank(n); });
    managers[NONE] = blank(NONE);
    accounts.forEach(a => {
      const m = managers[a.owner];
      m.accounts.push(a); m.rev += a.rev; m.prev += a.prev; m.crev += a.crev; m.cm += a.cm;
      if (a.isAuto) m.auto++;
      m.quoteRows = m.quoteRows.concat(a.quoteRows);
    });
    Object.values(managers).forEach(m => { m.qs = quoteStats(m.quoteRows, start); m.change = m.prev > 0 ? (m.rev - m.prev) / m.prev : null; });

    const total = { rev: num(fy ? d.totals.rfy : d.totals.r12), prev: num(fy ? d.totals.rfy_ly : d.totals.rprev) };
    return { start, accounts, byKey, managers, total, fy };
  }

  // ───────────────────────── small pieces of HTML ─────────────────────────
  function changeHtml(rev, prev) {
    if (!(prev > 0)) return rev > 0 ? '<span class="am-chg new" title="Nothing in the comparison period">new</span>' : '<span class="am-dim">—</span>';
    const c = (rev - prev) / prev, p = Math.round(Math.abs(c) * 100);
    if (p === 0) return '<span class="am-chg flat" title="About the same as the comparison period">▬ 0%</span>';
    return `<span class="am-chg ${c > 0 ? 'up' : 'down'}" title="${gbp(rev)} against ${gbp(prev)}">${c > 0 ? '▲' : '▼'} ${p}%</span>`;
  }
  const MARGIN_HELP = 'Garment margin (indicative): only invoice lines whose product code we have supplier costs for are counted, sale price less the average supplier cost. It leaves out decoration costs and anything we cannot cost, so it reads higher than the true margin.';
  function marginHtml(crev, cm, rev, minCosted) {
    if (crev < minCosted || !(rev > 0)) return `<span class="am-dim" title="Not enough of this is costed to give a margin. ${esc(MARGIN_HELP)}">n/a</span>`;
    const cov = Math.min(1, crev / rev), pct = Math.round(cm / crev * 100);
    return `<span class="am-margin${cov < LOW_COVERAGE ? ' low' : ''}" title="${esc(MARGIN_HELP)} Based on ${gbp(crev)} costed out of ${gbp(rev)}.">${pct}%<small>from ${Math.max(1, Math.round(cov * 100))}% of sales${cov < LOW_COVERAGE ? ' · low' : ''}</small></span>`;
  }
  const ownerChip = a => a.isAuto
    ? `<span class="am-chip auto" title="${a.owner === NONE ? 'Nobody has handled this account yet' : 'Suggested from ' + (a.auto_reason === 'orders' ? 'who handled most of its invoiced orders' : 'who made most of its quotes') + '. Not confirmed by anyone.'}">${a.owner === NONE ? 'No owner' : 'Automatic'}</span>`
    : `<span class="am-chip set" title="Set by ${esc(a.set_by || 'someone')} on ${esc(fmtDate(a.set_at))}">Confirmed</span>`;
  const stageChip = r => { const q = QT(), s = q && q.STAGES[r.stage]; return s ? `<span class="am-stage" style="--c:${s.color}">${s.icon} ${esc(s.label)}</span>` : ''; };

  // ───────────────────────── overview ─────────────────────────
  function periodBar() {
    return `<div class="am-bar">
      <div class="am-seg" role="group" aria-label="Period">${Object.keys(PERIODS).map(k => `<button type="button" data-period="${k}" class="${state.period === k ? 'on' : ''}" aria-pressed="${state.period === k}">${esc(PERIODS[k].label)}</button>`).join('')}</div>
      <span class="am-dim am-grow">${state.period === 'fytd' ? 'Since ' + esc(fmtDate(state.data.fy_start)) + ', against ' + esc(PERIODS.fytd.vs) : 'Against the ' + esc(PERIODS.l12m.vs)}</span>
      <span class="am-dim">${state.updatedAt ? 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      <button type="button" class="am-btn" data-reload="1"${state.loading ? ' disabled' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button></div>`;
  }

  function summaryTiles(P) {
    const auto = P.accounts.filter(a => a.isAuto && a.owner !== NONE), none = P.accounts.filter(a => a.owner === NONE);
    const autoRev = auto.reduce((s, a) => s + a.rev, 0);
    const allQ = P.accounts.reduce((acc, a) => acc.concat(a.quoteRows), []);
    const qs = quoteStats(allQ, P.start);
    return `<div class="am-tiles">
      <div class="am-tile"><span class="am-k">Revenue</span><b>${gbp(P.total.rev)}</b><span class="am-sub">${changeHtml(P.total.rev, P.total.prev)} <span class="am-dim">${esc(PERIODS[state.period].label.toLowerCase())}, before VAT</span></span></div>
      <div class="am-tile"><span class="am-k">Accounts</span><b>${P.accounts.length}</b><span class="am-sub am-dim">${P.accounts.filter(a => a.rev > 0).length} with revenue in this period</span></div>
      <div class="am-tile"><span class="am-k">Open quotes</span><b>${gbp(qs.openValue)}</b><span class="am-sub am-dim">${plural(qs.open.length, 'quote')} across every account</span></div>
      <div class="am-tile ${auto.length + none.length ? 'warn' : ''}"><span class="am-k">Still to confirm</span><b>${auto.length + none.length}</b><span class="am-sub am-dim">${plural(auto.length, 'account')} on automatic (${gbp(autoRev)}), ${none.length} with no owner</span></div></div>`;
  }

  function managerCard(m, P) {
    const isNone = m.name === NONE, share = P.total.rev > 0 ? Math.max(0, m.rev) / P.total.rev : 0;
    const q = m.qs, me = !isNone && state.me && m.name === state.me;
    const win = q.rate == null ? '<span class="am-dim">—</span>' : `${Math.round(q.rate * 100)}%`;
    return `<button type="button" class="am-card${isNone ? ' none' : ''}${m.accounts.length ? '' : ' empty'}" data-mgr="${esc(m.name)}" aria-label="${esc(mgrLabel(m.name))}: open their accounts">
      <div class="am-card-top">${avatar(m.name, 'big')}<div class="am-card-name"><b>${esc(mgrLabel(m.name))}${me ? ' <small class="am-you">you</small>' : ''}</b>
        <span class="am-dim">${m.accounts.length ? plural(m.accounts.length, 'account') : 'No accounts yet'}${m.auto && !isNone ? ` · <span class="am-warn">${m.auto} on automatic</span>` : ''}</span></div></div>
      <div class="am-card-rev"><b>${gbp(m.rev)}</b> ${changeHtml(m.rev, m.prev)}</div>
      <div class="am-share" title="${Math.round(share * 100)}% of all revenue"><i style="width:${Math.round(share * 100)}%"></i></div>
      <dl class="am-mini">
        <div><dt>Open quotes</dt><dd>${gbp(q.openValue)} <small>${q.open.length}</small></dd></div>
        <div><dt>Quote win rate</dt><dd>${win}${q.decided ? ` <small>${q.decided} decided</small>` : ''}</dd></div>
        <div><dt>Margin <abbr title="${esc(MARGIN_HELP)}">(est.)</abbr></dt><dd>${marginHtml(m.crev, m.cm, m.rev, MIN_COSTED_MANAGER)}</dd></div>
      </dl></button>`;
  }

  function orderedManagers(P) {
    const ordered = Object.values(P.managers).filter(m => m.name !== NONE).sort((a, b) => (b.accounts.length ? 1 : 0) - (a.accounts.length ? 1 : 0) || b.rev - a.rev || a.name.localeCompare(b.name));
    const none = P.managers[NONE];
    if (none.accounts.length) ordered.push(none);
    return ordered;
  }

  // The 3D office above the cards (amoffice.js). The cards stay as the plain, keyboard-friendly way in.
  function officeSlot() { return window.ATAM_OFFICE && window.ATAM_OFFICE.available() ? '<div id="amOfficeSlot" class="am-office"></div>' : ''; }
  function drawOffice(P) {
    const O = window.ATAM_OFFICE, slot = $('amOfficeSlot');
    if (!O) return;
    if (!slot || state.view !== 'overview') { O.detach(); return; }
    const items = orderedManagers(P).map(m => ({ name: m.name, label: mgrLabel(m.name), hue: hue(m.name), rev: m.rev, accounts: m.accounts.length, auto: m.auto,
      openValue: m.qs.openValue, rate: m.qs.rate, you: !!(state.me && m.name === state.me), none: m.name === NONE }));
    O.setData(items, { total: P.total.rev, periodLabel: PERIODS[state.period].label.toLowerCase(), fmt: gbp }, goManager);
    O.attach(slot);
  }

  function overview(P) {
    const ordered = orderedManagers(P);
    const none = P.managers[NONE];
    const counts = { all: P.accounts.length, auto: P.accounts.filter(a => a.isAuto && a.owner !== NONE).length, none: none.accounts.length };
    let list = P.accounts;
    if (state.filter === 'auto') list = list.filter(a => a.isAuto && a.owner !== NONE);
    if (state.filter === 'none') list = list.filter(a => a.owner === NONE);
    return `${periodBar()}${summaryTiles(P)}
      ${officeSlot()}
      <div class="am-cards">${ordered.map(m => managerCard(m, P)).join('')}</div>
      <h3 class="am-h">Find an account</h3>
      <p class="am-note">Every account is listed here, so you can open any of them and choose who owns it. Tick several to move them in one go.</p>
      <div class="am-filters" role="group" aria-label="Which accounts">${[['all', 'All accounts'], ['auto', 'Automatic, to confirm'], ['none', 'No owner']].map(([k, l]) => `<button type="button" class="am-pill${state.filter === k ? ' on' : ''}" data-filter="${k}" aria-pressed="${state.filter === k}">${l} <b>${counts[k]}</b></button>`).join('')}</div>
      <div id="amTable">${accountsTable(P, list, { showOwner: true, bulkFrom: null })}</div>`;
  }

  // ───────────────────────── one manager ─────────────────────────
  function managerView(P) {
    const m = P.managers[state.manager];
    if (!m) { state.view = 'overview'; state.manager = null; return overview(P); }
    const isNone = m.name === NONE, q = m.qs;
    const others = {};   // quotes keyed in by someone else on this manager's accounts
    m.quoteRows.forEach(r => { if (r.rep && r.rep !== m.name) others[r.rep] = (others[r.rep] || 0) + 1; });
    const keyedElsewhere = isNone ? [] : state.quotes.filter(r => {
      const mp = state.qmap[r.id], a = mp && !mp.internal ? P.byKey[mp.key] : null;
      return a && r.rep === m.name && a.owner !== m.name && ['fresh', 'chase', 'cold'].includes(r.stage);
    });
    const byOthers = Object.keys(others).sort((a, b) => others[b] - others[a]);
    const openRows = q.open.slice().sort((a, b) => b.value - a.value);
    const shown = state.showAllQuotes ? openRows : openRows.slice(0, 8);
    const win = q.rate == null ? '—' : Math.round(q.rate * 100) + '%';

    return `<div class="am-crumbs"><button type="button" class="am-link" data-back="1">‹ All account managers</button></div>
      <div class="am-mhead">${avatar(m.name, 'big')}<div><h3>${esc(mgrLabel(m.name))}</h3><span class="am-dim">${isNone ? 'Accounts nobody has handled yet. Give them an owner.' : plural(m.accounts.length, 'account') + (m.auto ? ` · ${m.auto} still on automatic` : ' · all confirmed')}</span></div></div>
      ${periodBar()}
      <div class="am-tiles">
        <div class="am-tile"><span class="am-k">Revenue</span><b>${gbp(m.rev)}</b><span class="am-sub">${changeHtml(m.rev, m.prev)} <span class="am-dim">${P.total.rev > 0 ? '· ' + Math.round(Math.max(0, m.rev) / P.total.rev * 100) + '% of all revenue' : ''}</span></span></div>
        <div class="am-tile"><span class="am-k">Open quotes</span><b>${gbp(q.openValue)}</b><span class="am-sub am-dim">${plural(q.open.length, 'quote')}</span></div>
        <div class="am-tile"><span class="am-k">Quotes won / lost</span><b>${q.wonQuotes.length} / ${q.lost.length}</b><span class="am-sub am-dim">${win} win rate${q.won.length > q.wonQuotes.length ? `, not counting ${plural(q.won.length - q.wonQuotes.length, 'order')} keyed in and approved within the hour` : ''}</span></div>
        <div class="am-tile"><span class="am-k">Margin <abbr title="${esc(MARGIN_HELP)}">(indicative)</abbr></span><b>${marginHtml(m.crev, m.cm, m.rev, MIN_COSTED_MANAGER)}</b><span class="am-sub am-dim">garments only, before decoration costs</span></div></div>
      ${state.quotesError ? `<div class="am-banner">Quotes could not be loaded just now (${esc(state.quotesError)}), so the quote figures are missing. Revenue is fine.</div>` : ''}
      ${!isNone && (byOthers.length || keyedElsewhere.length) ? `<div class="am-cross"><b>Whose hands the quotes went through</b>
        ${byOthers.length ? `<p>On ${esc(m.name)}'s accounts, quotes were keyed in by: ${byOthers.map(n => `${avatar(n)} ${esc(n)} <b>${others[n]}</b>`).join(' &nbsp; ')}. They still count here, because ownership follows the account.</p>` : ''}
        ${keyedElsewhere.length ? `<p>${esc(m.name)} has ${plural(keyedElsewhere.length, 'open quote')} (${gbp(keyedElsewhere.reduce((s, r) => s + r.value, 0))}) on accounts owned by someone else. Those count for the owner.</p>` : ''}</div>` : ''}
      ${openRows.length ? `<h3 class="am-h">Open quotes on ${isNone ? 'these' : 'their'} accounts</h3><div class="am-qlist">${shown.map(r => quoteRow(r, P, true)).join('')}</div>${openRows.length > shown.length ? `<button type="button" class="am-btn" data-toggle-quotes="1">Show all ${openRows.length} open quotes</button>` : ''}` : ''}
      <h3 class="am-h">Accounts</h3>
      <div id="amTable">${accountsTable(P, m.accounts, { showOwner: false, bulkFrom: m.name })}</div>`;
  }

  function quoteRow(r, P, withAccount) {
    const mp = state.qmap[r.id], a = mp ? P.byKey[mp.key] : null;
    const owner = a ? a.owner : NONE;
    const keyedByOther = r.rep && owner !== NONE && r.rep !== owner;
    const q = QT();
    const link = r.decoId && q ? ` <a class="am-ext" href="${esc(q.DECO_ORDER_URL + encodeURIComponent(r.decoId))}" target="_blank" rel="noopener">DecoNetwork ↗</a>` : '';
    const open = ['fresh', 'chase', 'cold'].includes(r.stage);
    return `<div class="am-q">
      <div class="am-q-main"><b>${esc(r.job || ('Quote ' + (r.decoId || r.id)))}</b>${withAccount && a ? ` <button type="button" class="am-link" data-acct="${esc(a.key)}">${esc(a.name)}</button>` : ''}
        <div class="am-dim">#${esc(r.decoId || r.id)} · raised ${esc(fmtDate(r.created))}${open ? ` · quiet for ${r.idle} day${r.idle === 1 ? '' : 's'}` : r.stage === 'won' ? ` · approved ${esc(fmtDate(r.approved))}` : r.closedAt ? ` · closed ${esc(fmtDate(r.closedAt))}` : ''}${link}</div></div>
      <div class="am-q-side">${stageChip(r)}<b>${gbp(r.value)}</b>
        <span class="am-dim">${r.rep ? 'keyed by ' + esc(r.rep) : 'no one recorded'}${keyedByOther ? ` <span class="am-flag" title="Keyed in by someone other than the account owner. It still counts for ${esc(owner)}.">for ${esc(owner)}</span>` : ''}</span></div></div>`;
  }

  // ───────────────────────── accounts table (used for everyone and for one manager) ─────────────────────────
  const COLS = [
    { key: 'name', label: 'Account', get: a => a.name.toLowerCase() },
    { key: 'rev', label: 'Revenue', get: a => a.rev, right: true },
    { key: 'change', label: 'Change', get: a => a.change == null ? (a.rev > 0 ? 1e9 : -1e9) : a.change, right: true },
    { key: 'openq', label: 'Open quotes', get: a => a.qs.openValue, right: true },
    { key: 'last', label: 'Last invoice', get: a => a.lastDays == null ? 1e9 : a.lastDays, right: true },
    { key: 'margin', label: 'Margin (est.)', get: a => a.crev >= MIN_COSTED_ACCOUNT && a.crev > 0 ? a.cm / a.crev : -1e9, right: true }
  ];

  function accountsTable(P, list, opt) {
    let rows = list.slice();
    const q = state.q.trim().toLowerCase();
    if (q) rows = rows.filter(a => a.name.toLowerCase().includes(q) || (a.owner !== NONE && a.owner.toLowerCase().includes(q)));
    const col = COLS.find(c => c.key === state.sort.key) || COLS[1];
    rows.sort((a, b) => { const x = col.get(a), y = col.get(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * state.sort.dir; });
    const total = rows.length, cut = !state.showAll && total > ROWS_SHOWN;
    const shown = cut ? rows.slice(0, ROWS_SHOWN) : rows;
    const allTicked = shown.length > 0 && shown.every(a => state.selected.has(a.key));
    const ncols = COLS.length + 2;   // tick box + the columns + owner / status
    const head = `<tr><th class="am-c"><input type="checkbox" data-checkall="1" aria-label="Select all shown"${allTicked ? ' checked' : ''}></th>${COLS.map(c => `<th class="${c.right ? 'r' : ''}"><button type="button" class="am-th${state.sort.key === c.key ? ' on' : ''}" data-sort="${c.key}" aria-label="Sort by ${esc(c.label)}">${esc(c.label)}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}${opt.showOwner ? '<th>Owner</th>' : '<th>Status</th>'}</tr>`;
    const body = shown.map(a => `<tr class="${state.selected.has(a.key) ? 'sel' : ''}">
        <td class="am-c"><input type="checkbox" data-check="${esc(a.key)}" aria-label="Select ${esc(a.name)}"${state.selected.has(a.key) ? ' checked' : ''}></td>
        <td><button type="button" class="am-name" data-acct="${esc(a.key)}">${esc(a.name)}</button>${a.children.length > 1 ? `<small class="am-dim"> ${a.children.length} accounts</small>` : ''}${a.r12 === 0 && a.rprev === 0 && a.rfy === 0 ? ' <small class="am-dim">quotes only</small>' : ''}</td>
        <td class="r">${gbp(a.rev)}</td><td class="r">${changeHtml(a.rev, a.prev)}</td>
        <td class="r">${a.qs.open.length ? `${gbp(a.qs.openValue)} <small class="am-dim">${a.qs.open.length}</small>` : '<span class="am-dim">—</span>'}</td>
        <td class="r" title="${esc(fmtDate(a.last_invoice))}">${a.lastDays == null ? '<span class="am-dim">—</span>' : esc(agoText(a.lastDays))}</td>
        <td class="r">${marginHtml(a.crev, a.cm, a.rev, MIN_COSTED_ACCOUNT)}</td>
        <td>${opt.showOwner ? `<span class="am-owner">${a.owner === NONE ? '' : avatar(a.owner)} ${a.owner === NONE ? '<span class="am-dim">Nobody</span>' : esc(a.owner)}</span> ` : ''}${ownerChip(a)}</td></tr>`).join('');
    const sel = state.selected.size;
    return `<div class="am-tools"><input type="search" id="amSearch" class="am-search" placeholder="Search accounts${opt.showOwner ? ' or people' : ''}…" value="${esc(state.q)}" aria-label="Search accounts"><span class="am-dim">${plural(total, 'account')}${q ? ' match' + (total === 1 ? 'es' : '') : ''}</span></div>
      ${state.msg && !state.openKey ? `<div class="am-msg ${state.msg.type}" role="status">${esc(state.msg.text)}</div>` : ''}
      ${sel ? bulkBar(P) : ''}
      <div class="am-tablewrap"><table class="am-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${ncols}" class="am-empty">${q ? 'No accounts match that search.' : 'No accounts here.'}</td></tr>`}</tbody></table></div>
      ${cut ? `<button type="button" class="am-btn am-more" data-showall="1">Show all ${total} accounts</button>` : (state.showAll && total > ROWS_SHOWN ? '<button type="button" class="am-btn am-more" data-showall="0">Show fewer</button>' : '')}`;
  }

  function repOptions(P, except, sel) {
    const reps = (state.data.reps || []).slice();
    Object.keys(P.managers).forEach(n => { if (n !== NONE && !reps.includes(n) && P.managers[n].accounts.length) reps.push(n); });
    return reps.filter(n => n !== except).sort().map(n => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }
  function bulkBar(P) {
    const keys = Array.from(state.selected).filter(k => P.byKey[k]);
    if (!keys.length) return '';
    const autos = keys.filter(k => P.byKey[k].isAuto && P.byKey[k].owner !== NONE);
    return `<div class="am-bulk" role="region" aria-label="Selected accounts">
      <b>${plural(keys.length, 'account')} selected</b>
      <label class="am-dim" for="amBulkTo">Move to</label>
      <select id="amBulkTo"><option value="">Choose a person…</option>${repOptions(P, null, '')}</select>
      <button type="button" class="am-btn pri" data-bulk-go="1"${state.saving ? ' disabled' : ''}>Move</button>
      ${autos.length ? `<button type="button" class="am-btn" data-bulk-confirm="1"${state.saving ? ' disabled' : ''} title="Keep the suggested owner, but mark it as confirmed">Confirm the suggested owner on ${autos.length}</button>` : ''}
      <button type="button" class="am-btn" data-bulk-clear="1">Clear</button></div>`;
  }

  // ───────────────────────── account drawer ─────────────────────────
  function barsSvg(a) {
    const m = (a.monthly || []).map(num);
    if (!m.length) return '';
    const max = Math.max(1, ...m.map(Math.abs)), W = 480, H = 74, bw = W / m.length;
    const base = new Date(String(state.data.as_of).slice(0, 10) + 'T00:00:00');
    const label = i => new Date(base.getFullYear(), base.getMonth() - (m.length - 1 - i), 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    return `<svg viewBox="0 0 ${W} ${H + 14}" class="am-bars" role="img" aria-label="Monthly revenue for the last 24 months">${m.map((v, i) => {
      const h = Math.max(v === 0 ? 0 : 2, Math.abs(v) / max * H);
      return `<g><title>${esc(label(i))}: ${esc(gbp(v))}</title><rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="${i >= m.length - 12 ? 'cur' : 'old'}${v < 0 ? ' neg' : ''}"/></g>`;
    }).join('')}<text x="0" y="${H + 12}" class="am-axis">${esc(label(0))}</text><text x="${W}" y="${H + 12}" class="am-axis" text-anchor="end">${esc(label(m.length - 1))}</text></svg>`;
  }

  function drawer(P) {
    const a = state.openKey && P.byKey[state.openKey];
    if (!a) return '';
    const reps = state.data.reps || [];
    const sel = a.isAuto ? '' : a.owner;
    const opts = `<option value="">Automatic${a.auto_owner ? ' (suggested: ' + esc(a.auto_owner) + ')' : ' (no suggestion)'}</option>` +
      reps.concat(!a.isAuto && !reps.includes(a.owner) ? [a.owner] : []).slice().sort().map(n => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const hist = state.history.filter(h => h.account_key === a.key).slice(0, 5);
    const by = {};
    a.quoteRows.forEach(r => { const n = r.rep || 'No one recorded'; const o = by[n] = by[n] || { n: 0, open: 0 }; o.n++; if (['fresh', 'chase', 'cold'].includes(r.stage)) o.open++; });
    const byKeys = Object.keys(by).sort((x, y) => by[y].n - by[x].n);
    const handled = (a.handled_by || []).filter(h => num(h.r12) > 0);
    const hTotal = handled.reduce((s, h) => s + num(h.r12), 0);
    const closed = a.quoteRows.filter(r => !['fresh', 'chase', 'cold'].includes(r.stage)).sort((x, y) => (y.closedAt || y.created) - (x.closedAt || x.created)).slice(0, 6);
    const open = a.quoteRows.filter(r => ['fresh', 'chase', 'cold'].includes(r.stage)).sort((x, y) => y.value - x.value);
    const kids = (a.children || []).filter(c => num(c.r12) !== 0 || num(c.rprev) !== 0);
    const showKids = kids.length > 1 || (kids.length === 1 && kids[0].name.trim().toLowerCase() !== a.name.trim().toLowerCase());

    return `<div class="am-overlay" data-close="1"></div>
    <aside class="am-drawer" role="dialog" aria-modal="true" aria-labelledby="amDrawerTitle">
      <header class="am-d-head"><div><span class="am-k">Account</span><h3 id="amDrawerTitle">${esc(a.name)}</h3>
        <div>${a.owner === NONE ? '<span class="am-dim">No owner yet</span>' : `${avatar(a.owner)} <b>${esc(a.owner)}</b>`} ${ownerChip(a)}</div></div>
        <button type="button" class="am-x" data-close="1" aria-label="Close">✕</button></header>
      <div class="am-d-body">
        <section class="am-own">
          <h4>Who owns this account?</h4>
          <p class="am-dim">${a.isAuto
            ? (a.owner === NONE ? 'Nobody has handled this account yet, so no one is suggested.' : `Not confirmed yet. ${esc(a.owner)} is suggested because ${a.auto_reason === 'orders' ? 'they handled most of its invoiced orders over the last 2 years' : 'they made most of its quotes'}.`)
            : `Set by ${esc(a.set_by || 'someone')} on ${esc(fmtDate(a.set_at))}.${a.note ? ' Note: “' + esc(a.note) + '”' : ''}`}
            Whoever owns the account gets its revenue and all its quotes, whoever keyed them in.</p>
          <div class="am-own-row"><label for="amOwnerSel" class="am-dim">Owner</label><select id="amOwnerSel"${state.saving ? ' disabled' : ''}>${opts}</select></div>
          <div class="am-own-row"><label for="amNote" class="am-dim">Note (optional)</label><input id="amNote" type="text" maxlength="300" placeholder="e.g. Dan looks after this one, Bethan keys the quotes" value="${esc(a.isAuto ? '' : a.note || '')}"${state.saving ? ' disabled' : ''}></div>
          <div class="am-own-actions">
            <button type="button" class="am-btn pri" data-save-owner="${esc(a.key)}"${state.saving ? ' disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
            ${a.isAuto && a.owner !== NONE ? `<button type="button" class="am-btn" data-confirm-owner="${esc(a.key)}"${state.saving ? ' disabled' : ''}>Confirm ${esc(a.owner)}</button>` : ''}
            ${state.msg && state.openKey ? `<span class="am-msg ${state.msg.type}" role="status">${esc(state.msg.text)}</span>` : ''}</div>
          ${hist.length ? `<details class="am-hist"><summary>Change history</summary>${hist.map(h => `<div>${esc(fmtDate(h.changed_at))}: ${h.manager ? 'given to <b>' + esc(h.manager) + '</b>' : 'put back to automatic'} by ${esc(h.changed_by || 'someone')}${h.note ? ' (“' + esc(h.note) + '”)' : ''}</div>`).join('')}</details>` : ''}
        </section>

        <div class="am-tiles small">
          <div class="am-tile"><span class="am-k">Revenue</span><b>${gbp(a.rev)}</b><span class="am-sub">${changeHtml(a.rev, a.prev)}</span></div>
          <div class="am-tile"><span class="am-k">Margin (est.)</span><b>${marginHtml(a.crev, a.cm, a.rev, MIN_COSTED_ACCOUNT)}</b></div>
          <div class="am-tile"><span class="am-k">Invoices, last 12 months</span><b>${num(a.inv12)}</b><span class="am-sub am-dim">last one ${esc(agoText(a.lastDays))}</span></div>
          <div class="am-tile"><span class="am-k">Open quotes</span><b>${gbp(a.qs.openValue)}</b><span class="am-sub am-dim">${plural(a.qs.open.length, 'quote')}</span></div></div>

        <h4>Revenue by month</h4>
        ${barsSvg(a)}<div class="am-dim am-key"><i class="cur"></i> last 12 months <i class="old"></i> the 12 before</div>
        ${showKids ? `<h4>Accounts inside this one</h4><table class="am-mini-table"><thead><tr><th>Account</th><th class="r">Last 12 months</th><th class="r">Before that</th></tr></thead><tbody>${kids.slice(0, 15).map(c => `<tr><td>${esc(c.name)}</td><td class="r">${gbp(c.r12)}</td><td class="r">${gbp(c.rprev)}</td></tr>`).join('')}</tbody></table>${kids.length > 15 ? `<p class="am-dim">and ${kids.length - 15} smaller ones</p>` : ''}` : ''}

        <h4>Who has been working on it</h4>
        ${handled.length ? `<p class="am-dim">Invoiced orders in the last 12 months were handled by (the person on the DecoNetwork order):</p><div class="am-who">${handled.slice(0, 6).map(h => `<span>${avatar(h.name === 'Not recorded' ? null : h.name)} ${esc(h.name)} <b>${hTotal > 0 ? Math.round(num(h.r12) / hTotal * 100) : 0}%</b></span>`).join('')}</div>` : '<p class="am-dim">No invoiced orders in the last 12 months.</p>'}
        ${byKeys.length ? `<p class="am-dim">Quotes were keyed in by:</p><div class="am-who">${byKeys.map(n => `<span>${avatar(n === 'No one recorded' ? null : n)} ${esc(n)} <b>${by[n].n}</b>${by[n].open ? ` <small>(${by[n].open} open)</small>` : ''}</span>`).join('')}</div>` : ''}

        <h4>Quotes</h4>
        ${state.quotesError ? `<div class="am-banner">Quotes could not be loaded just now.</div>` : ''}
        ${open.length || closed.length ? `<div class="am-qlist">${open.map(r => quoteRow(r, P, false)).join('')}${closed.map(r => quoteRow(r, P, false)).join('')}</div>${a.quoteRows.length > open.length + closed.length ? `<p class="am-dim">Showing open quotes and the ${closed.length} most recent finished ones, of ${a.quoteRows.length} in all.</p>` : ''}` : (state.quotesError ? '' : '<p class="am-dim">No quotes on this account.</p>')}
      </div></aside>`;
  }

  // ───────────────────────── render ─────────────────────────
  function render() {
    const el = $('amBody');
    if (!el) return;
    if (state.error) { el.innerHTML = `<div class="am-empty-box">Couldn't load account managers: ${esc(state.error)}<br><button type="button" class="am-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { el.innerHTML = '<div class="am-empty-box">Loading… this can take a few seconds.</div>'; return; }
    const keepScroll = window.scrollY;
    const P = prepare();
    el.innerHTML = (state.view === 'manager' ? managerView(P) : overview(P)) + footnote() + `<div id="amDrawerHost">${drawer(P)}</div>`;
    drawOffice(P);
    const dr = el.querySelector('.am-drawer');
    if (dr && !dr.dataset.focused) { dr.dataset.focused = '1'; const x = dr.querySelector('.am-x'); if (x && !state.saving) x.focus({ preventScroll: true }); }
    if (Math.abs(window.scrollY - keepScroll) > 4) window.scrollTo(0, keepScroll);
  }
  // Re-draw only the accounts table (so typing in the search box keeps its focus)
  function renderTable() {
    const host = $('amTable');
    if (!host || !state.loaded) { render(); return; }
    const P = prepare(), focusSearch = document.activeElement && document.activeElement.id === 'amSearch', pos = focusSearch ? document.activeElement.selectionStart : 0;
    let list, opt;
    if (state.view === 'manager') { list = P.managers[state.manager] ? P.managers[state.manager].accounts : []; opt = { showOwner: false, bulkFrom: state.manager }; }
    else {
      list = P.accounts;
      if (state.filter === 'auto') list = list.filter(a => a.isAuto && a.owner !== NONE);
      if (state.filter === 'none') list = list.filter(a => a.owner === NONE);
      opt = { showOwner: true, bulkFrom: null };
    }
    host.innerHTML = accountsTable(P, list, opt);
    if (focusSearch) { const s = $('amSearch'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }
  }
  function footnote() {
    return `<div class="am-foot"><p><b>How to read this.</b> Revenue is Xero invoice revenue before VAT with credit notes taken off, grouped into accounts exactly as on the Customers tab, so the totals agree with it. An account is owned by one person; that person gets all of its revenue and quotes, whoever raised the quotes. “Automatic” is only a suggestion (who handled most of the account's invoiced orders, else who made most of its quotes) until someone confirms it.</p>
      <p><b>About the margin.</b> It is an indicative <i>garment</i> margin, worked out only on invoice lines where we know the supplier cost of the product, using the average cost across that product's sizes and colours, and leaving out lines that look like job lump sums. It does not include embroidery or print costs, and most revenue (bespoke jobs, promo items, delivery) has no cost on file, so the small “from x% of sales” note says how much it rests on. Treat it as a pointer, not as accounts.</p>
      <p><b>Quotes</b> use the same stages as the Quotes tab. Quotes whose customer name matches no invoiced account appear as their own “quotes only” account so nothing is lost, and quotes for our own companies are left out.</p></div>`;
  }

  // ───────────────────────── actions ─────────────────────────
  function friendly(msg) {
    msg = String(msg || '');
    if (/not signed in/i.test(msg)) return 'You have been signed out. Sign in again and retry.';
    if (/unknown team member/i.test(msg)) return 'That person is not on the account managers list.';
    if (/unknown account/i.test(msg)) return 'That account was not found. Refresh the page and try again.';
    if (/too long/i.test(msg)) return 'The note is too long (300 characters at most).';
    return 'Could not save: ' + msg;
  }
  async function assign(keys, manager, note) {
    if (state.saving || !keys.length) return;
    const P = prepare();
    const names = keys.map(k => P.byKey[k] && P.byKey[k].name).filter(Boolean);
    if (!names.length) return;
    state.saving = true; state.msg = null; render();
    const res = await client().rpc('set_account_managers', { p_account_names: names, p_manager: manager || null, p_note: note || null });
    state.saving = false;
    if (res.error) {
      state.msg = { type: 'err', text: friendly(res.error.message) };
      render();
      return;
    }
    // show the change straight away, then re-read so what is on screen is what was saved
    const now = new Date().toISOString();
    keys.forEach(k => {
      const a = state.data.accounts.find(x => x.key === k);
      if (!a) return;
      if (manager) Object.assign(a, { owner: manager, owner_source: 'set', set_by: state.me || 'you', set_at: now, note: note || null });
      else Object.assign(a, { owner: a.auto_owner || null, owner_source: a.auto_owner ? 'auto' : 'none', set_by: null, set_at: null, note: null });
    });
    state.selected = new Set();
    const n = keys.length;
    state.msg = { type: 'ok', text: manager ? (n === 1 ? 'Saved. ' : n + ' accounts saved. ') + 'Now owned by ' + manager + '.' : (n === 1 ? 'Put back to automatic.' : n + ' accounts put back to automatic.') };
    render();
    load(true);
  }

  function openAccount(key) {
    state.lastFocus = document.activeElement;
    state.openKey = key; state.msg = null; state.showAllQuotes = false;
    render();
  }
  function closeDrawer() {
    if (!state.openKey) return;
    state.openKey = null; state.msg = null;
    render();
    const f = state.lastFocus;
    if (f && document.body.contains(f) && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function goManager(name) {
    state.view = name ? 'manager' : 'overview'; state.manager = name || null;
    state.q = ''; state.showAll = false; state.selected = new Set(); state.msg = null; state.showAllQuotes = false;
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ───────────────────────── styles & page ─────────────────────────
  function injectStyles() {
    if ($('amStyles')) return;
    const s = document.createElement('style');
    s.id = 'amStyles';
    s.textContent = `
#accountmanagers .am-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.14), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(168,85,247,.14), transparent 60%), rgba(15,23,42,.55); }
#accountmanagers .am-headbox h2 { margin:0 0 6px; font-size:28px; }
#accountmanagers .am-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:780px; line-height:1.5; }
#accountmanagers .am-office { margin:0 0 16px; }
#accountmanagers .amo { position:relative; height:500px; border-radius:18px; overflow:hidden; border:1px solid rgba(56,189,248,.28); background:radial-gradient(120% 120% at 50% 0%, rgba(56,189,248,.16), transparent 60%), radial-gradient(90% 90% at 100% 100%, rgba(168,85,247,.14), transparent 60%), #050a1a; }
#accountmanagers .amo-tip { position:absolute; z-index:3; width:200px; padding:9px 11px; border-radius:10px; background:rgba(2,6,23,.92); border:1px solid rgba(56,189,248,.4); color:#e2e8f0; font-size:12px; line-height:1.45; pointer-events:none; }
#accountmanagers .amo-tip b { display:block; font-size:13.5px; color:#fff; }
#accountmanagers .amo-tip span { display:block; color:#cbd5e1; }
#accountmanagers .amo-hint { position:absolute; left:12px; bottom:10px; z-index:2; font-size:11.5px; color:#94a3b8; pointer-events:none; }
@media (max-width:700px) { #accountmanagers .amo { height:340px; } }
#accountmanagers .am-dim { color:#94a3b8; font-size:12.5px; }
#accountmanagers .am-grow { flex:1 1 160px; }
#accountmanagers .am-warn { color:#fbbf24; }
#accountmanagers .am-bar { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin:18px 0 12px; }
#accountmanagers .am-seg { display:inline-flex; border:1px solid rgba(255,255,255,.14); border-radius:10px; overflow:hidden; }
#accountmanagers .am-seg button { background:transparent; border:0; color:#cbd5e1; padding:9px 14px; font-size:13px; cursor:pointer; }
#accountmanagers .am-seg button.on { background:#2563eb; color:#fff; }
#accountmanagers .am-btn { padding:8px 13px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:12.5px; cursor:pointer; }
#accountmanagers .am-btn:hover:not(:disabled) { border-color:#38bdf8; }
#accountmanagers .am-btn:disabled { opacity:.55; cursor:default; }
#accountmanagers .am-btn.pri { background:#2563eb; border-color:#2563eb; color:#fff; }
#accountmanagers .am-btn.pri:hover:not(:disabled) { background:#1d4ed8; }
#accountmanagers .am-link { background:none; border:0; padding:0; color:#7dd3fc; cursor:pointer; font:inherit; text-align:left; }
#accountmanagers .am-link:hover { text-decoration:underline; }
#accountmanagers button:focus-visible, #accountmanagers select:focus-visible, #accountmanagers input:focus-visible, #accountmanagers summary:focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
#accountmanagers select, #accountmanagers input[type=text], #accountmanagers input[type=search] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:13px; max-width:100%; }
#accountmanagers .am-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:12px; margin:0 0 18px; }
#accountmanagers .am-tiles.small { grid-template-columns:repeat(2, 1fr); }
#accountmanagers .am-tile { padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(15,23,42,.65); display:flex; flex-direction:column; gap:4px; min-width:0; }
#accountmanagers .am-tile.warn { border-color:rgba(251,191,36,.45); }
#accountmanagers .am-tile b { font-size:25px; line-height:1.15; }
#accountmanagers .am-k { font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; color:#94a3b8; }
#accountmanagers .am-sub { font-size:12.5px; }
#accountmanagers .am-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(270px, 1fr)); gap:14px; margin-bottom:26px; }
#accountmanagers .am-card { text-align:left; padding:16px 18px; border-radius:16px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.7); color:#e2e8f0; cursor:pointer; font:inherit; display:flex; flex-direction:column; gap:10px; transition:border-color .15s, transform .15s; }
#accountmanagers .am-card:hover { border-color:#38bdf8; transform:translateY(-2px); }
#accountmanagers .am-card.none { border-style:dashed; }
#accountmanagers .am-card.empty { opacity:.75; }
#accountmanagers .am-card-top { display:flex; gap:12px; align-items:center; }
#accountmanagers .am-card-name { display:flex; flex-direction:column; gap:2px; min-width:0; }
#accountmanagers .am-card-name b { font-size:16px; overflow-wrap:anywhere; }
#accountmanagers .am-you { font-weight:600; padding:1px 7px; border-radius:10px; background:rgba(56,189,248,.18); color:#7dd3fc; margin-left:4px; }
#accountmanagers .am-card-rev { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
#accountmanagers .am-card-rev b { font-size:26px; }
#accountmanagers .am-share { height:6px; border-radius:4px; background:rgba(255,255,255,.08); overflow:hidden; }
#accountmanagers .am-share i { display:block; height:100%; background:linear-gradient(90deg,#38bdf8,#a78bfa); }
#accountmanagers .am-mini { margin:0; display:grid; gap:6px; }
#accountmanagers .am-mini div { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
#accountmanagers .am-mini dt { color:#94a3b8; font-size:12.5px; } #accountmanagers .am-mini dd { margin:0; font-size:13.5px; font-weight:600; text-align:right; }
#accountmanagers .am-mini small, #accountmanagers .am-margin small { display:block; font-weight:400; color:#94a3b8; font-size:11px; }
#accountmanagers .am-mini dd small { display:inline; margin-left:3px; }
#accountmanagers .am-av { display:inline-grid; place-items:center; width:24px; height:24px; border-radius:50%; font-size:10.5px; font-weight:700; color:#fff; flex:none; vertical-align:middle; }
#accountmanagers .am-av.big { width:44px; height:44px; font-size:15px; }
#accountmanagers .am-av.none { background:#334155; border:1px dashed #64748b; }
#accountmanagers .am-chg { font-size:12.5px; font-weight:600; white-space:nowrap; }
#accountmanagers .am-chg.up { color:#4ade80; } #accountmanagers .am-chg.down { color:#f87171; } #accountmanagers .am-chg.flat, #accountmanagers .am-chg.new { color:#94a3b8; }
#accountmanagers .am-margin.low { opacity:.65; font-style:italic; }
#accountmanagers abbr { text-decoration:underline dotted; cursor:help; }
#accountmanagers .am-h { margin:26px 0 8px; font-size:18px; }
#accountmanagers .am-note { margin:0 0 12px; color:#94a3b8; font-size:13px; max-width:760px; }
#accountmanagers .am-filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
#accountmanagers .am-pill { padding:7px 13px; border-radius:20px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#cbd5e1; font-size:12.5px; cursor:pointer; }
#accountmanagers .am-pill.on { border-color:#38bdf8; background:rgba(56,189,248,.14); color:#fff; }
#accountmanagers .am-pill b { margin-left:4px; }
#accountmanagers .am-tools { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin-bottom:10px; }
#accountmanagers .am-search { min-width:min(320px, 100%); }
#accountmanagers .am-tablewrap { overflow-x:auto; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(8,12,24,.6); }
#accountmanagers .am-table { width:100%; border-collapse:collapse; font-size:13.5px; min-width:860px; }
#accountmanagers .am-table th { padding:9px 12px; text-align:left; background:rgba(255,255,255,.05); font-size:12px; font-weight:600; color:#94a3b8; white-space:nowrap; }
#accountmanagers .am-table td { padding:9px 12px; border-top:1px solid rgba(255,255,255,.07); vertical-align:middle; }
#accountmanagers .am-table tr.sel td { background:rgba(56,189,248,.08); }
#accountmanagers .am-table .r { text-align:right; } #accountmanagers .am-table .am-c { width:34px; padding-right:0; }
#accountmanagers .am-th { background:none; border:0; color:inherit; font:inherit; cursor:pointer; padding:0; }
#accountmanagers .am-th.on { color:#7dd3fc; }
#accountmanagers .am-name { background:none; border:0; color:#e2e8f0; font:inherit; font-weight:600; cursor:pointer; padding:0; text-align:left; overflow-wrap:anywhere; }
#accountmanagers .am-name:hover { color:#7dd3fc; text-decoration:underline; }
#accountmanagers .am-owner { display:inline-flex; gap:6px; align-items:center; margin-right:6px; }
#accountmanagers .am-chip { display:inline-block; padding:2px 9px; border-radius:12px; font-size:11.5px; font-weight:600; }
#accountmanagers .am-chip.auto { border:1px dashed #fbbf24; color:#fbbf24; }
#accountmanagers .am-chip.set { background:rgba(34,197,94,.16); color:#4ade80; }
#accountmanagers .am-empty { text-align:center; color:#94a3b8; padding:26px !important; }
#accountmanagers .am-empty-box { padding:34px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:12px; margin-top:18px; }
#accountmanagers .am-more { margin-top:10px; }
#accountmanagers .am-bulk { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:10px 14px; margin-bottom:10px; border-radius:12px; border:1px solid #38bdf8; background:rgba(56,189,248,.1); position:sticky; top:8px; z-index:5; }
#accountmanagers .am-msg { font-size:12.5px; font-weight:600; } #accountmanagers .am-msg.ok { color:#4ade80; } #accountmanagers .am-msg.err { color:#f87171; }
#accountmanagers .am-banner { margin:0 0 14px; padding:10px 14px; border-radius:10px; border:1px solid rgba(251,191,36,.5); background:rgba(251,191,36,.08); color:#fde68a; font-size:13px; }
#accountmanagers .am-crumbs { margin:16px 0 4px; }
#accountmanagers .am-mhead { display:flex; gap:14px; align-items:center; margin-bottom:4px; } #accountmanagers .am-mhead h3 { margin:0; font-size:24px; }
#accountmanagers .am-cross { margin:0 0 6px; padding:12px 16px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.55); font-size:13px; line-height:1.6; }
#accountmanagers .am-cross p { margin:6px 0 0; color:#cbd5e1; }
#accountmanagers .am-qlist { display:grid; gap:8px; margin-bottom:10px; }
#accountmanagers .am-q { display:flex; flex-wrap:wrap; gap:6px 16px; justify-content:space-between; padding:10px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.08); background:rgba(15,23,42,.65); }
#accountmanagers .am-q-main { flex:1 1 260px; min-width:0; overflow-wrap:anywhere; }
#accountmanagers .am-q-side { display:flex; flex-direction:column; align-items:flex-end; gap:2px; text-align:right; }
#accountmanagers .am-stage { font-size:12px; font-weight:600; padding:2px 9px; border-radius:12px; color:var(--c); background:color-mix(in srgb, var(--c) 16%, #0b1222); border:1px solid color-mix(in srgb, var(--c) 40%, transparent); }
#accountmanagers .am-flag { padding:1px 7px; border-radius:10px; background:rgba(168,85,247,.2); color:#d8b4fe; font-size:11.5px; font-weight:600; }
#accountmanagers .am-ext { color:#7dd3fc; margin-left:8px; }
#accountmanagers .am-foot { margin-top:30px; color:#7d8da6; font-size:12.5px; max-width:820px; line-height:1.55; }
#accountmanagers .am-overlay { position:fixed; inset:0; background:rgba(2,6,23,.62); z-index:1499; }
#accountmanagers .am-drawer { position:fixed; top:0; right:0; bottom:0; width:min(620px, 100vw); z-index:1500; background:#0b1222; border-left:1px solid rgba(255,255,255,.14); display:flex; flex-direction:column; box-shadow:-18px 0 50px rgba(0,0,0,.45); }
#accountmanagers .am-d-head { display:flex; justify-content:space-between; gap:12px; padding:18px 22px 14px; border-bottom:1px solid rgba(255,255,255,.1); }
#accountmanagers .am-d-head h3 { margin:2px 0 6px; font-size:22px; overflow-wrap:anywhere; }
#accountmanagers .am-x { background:none; border:1px solid rgba(255,255,255,.16); color:#e2e8f0; width:36px; height:36px; border-radius:8px; cursor:pointer; flex:none; }
#accountmanagers .am-d-body { overflow-y:auto; padding:18px 22px 40px; }
#accountmanagers .am-d-body h4 { margin:22px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; }
#accountmanagers .am-own { padding:14px 16px; border-radius:14px; border:1px solid rgba(56,189,248,.35); background:rgba(56,189,248,.06); margin-bottom:16px; }
#accountmanagers .am-own h4 { margin:0 0 6px; color:#e2e8f0; text-transform:none; font-size:16px; letter-spacing:0; }
#accountmanagers .am-own p { margin:0 0 10px; line-height:1.5; }
#accountmanagers .am-own-row { display:grid; grid-template-columns:110px 1fr; gap:8px; align-items:center; margin-bottom:8px; }
#accountmanagers .am-own-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:4px; }
#accountmanagers .am-hist { margin-top:10px; font-size:12.5px; color:#94a3b8; } #accountmanagers .am-hist div { padding:3px 0; } #accountmanagers .am-hist summary { cursor:pointer; }
#accountmanagers .am-bars { width:100%; height:auto; display:block; }
#accountmanagers .am-bars rect.cur { fill:#38bdf8; } #accountmanagers .am-bars rect.old { fill:#475569; } #accountmanagers .am-bars rect.neg { fill:#f87171; }
#accountmanagers .am-axis { fill:#94a3b8; font-size:10px; }
#accountmanagers .am-key i { display:inline-block; width:10px; height:10px; border-radius:2px; margin:0 4px 0 10px; vertical-align:-1px; }
#accountmanagers .am-key i.cur { background:#38bdf8; } #accountmanagers .am-key i.old { background:#475569; }
#accountmanagers .am-mini-table { width:100%; border-collapse:collapse; font-size:13px; } #accountmanagers .am-mini-table th { text-align:left; color:#94a3b8; font-weight:600; font-size:12px; padding:4px 6px; }
#accountmanagers .am-mini-table td { padding:5px 6px; border-top:1px solid rgba(255,255,255,.07); } #accountmanagers .am-mini-table .r { text-align:right; }
#accountmanagers .am-who { display:flex; flex-wrap:wrap; gap:8px 14px; margin-bottom:10px; font-size:13px; }
#accountmanagers .am-who span { display:inline-flex; gap:6px; align-items:center; }
@media (max-width: 760px) {
  #accountmanagers .am-headbox { padding:16px; } #accountmanagers .am-tiles.small { grid-template-columns:1fr; }
  #accountmanagers .am-own-row { grid-template-columns:1fr; } #accountmanagers .am-d-head, #accountmanagers .am-d-body { padding-left:14px; padding-right:14px; }
}
@media (prefers-reduced-motion: reduce) { #accountmanagers .am-card { transition:none; } #accountmanagers .am-card:hover { transform:none; } }
`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const calBtn = document.querySelector('.nav-link[data-page="calendar"]');
    const anchorBtn = calBtn || document.querySelector('.nav-link[data-page="newcustomers"]') || document.querySelector('.nav-link[data-page="quotes"]');
    const anchorPage = $('calendar') || $('newcustomers') || $('quotes');
    if (!anchorBtn || !anchorPage) return false;
    if (!calBtn && boot.tries < 30) return false;   // give the Calendar tab a moment to appear first, so this sits beside it

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>👥 Account managers</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="am-headbox"><p class="eyebrow">Sales</p><h2>Account managers</h2>
      <p>Each customer account has one owner. Open a person to see their accounts, what they bring in, their open quotes and an indicative margin, and open an account to change who owns it. Quotes follow the account, so it does not matter who keyed them in.</p></div>
      <div id="amBody"><div class="am-empty-box">Loading…</div></div>`;
    anchorPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden && !state.saving && !state.openKey) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); state.openKey = null; }
    }, true);

    sec.addEventListener('click', e => {
      const t = e.target;
      const per = t.closest('[data-period]');
      if (per) { state.period = per.dataset.period; savePrefs(); render(); return; }
      if (t.closest('[data-reload]')) { load(); return; }
      const mg = t.closest('[data-mgr]');
      if (mg) { goManager(mg.dataset.mgr); return; }
      if (t.closest('[data-back]')) { goManager(null); return; }
      const ac = t.closest('[data-acct]');
      if (ac) { openAccount(ac.dataset.acct); return; }
      if (t.closest('[data-close]')) { closeDrawer(); return; }
      const fl = t.closest('[data-filter]');
      if (fl) { state.filter = fl.dataset.filter; state.showAll = false; state.selected = new Set(); render(); return; }
      const so = t.closest('[data-sort]');
      if (so) { const k = so.dataset.sort; state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'name' ? 1 : -1 }; renderTable(); return; }
      const sa = t.closest('[data-showall]');
      if (sa) { state.showAll = sa.dataset.showall === '1'; renderTable(); return; }
      if (t.closest('[data-toggle-quotes]')) { state.showAllQuotes = true; render(); return; }
      if (t.closest('[data-bulk-clear]')) { state.selected = new Set(); state.msg = null; render(); return; }
      if (t.closest('[data-bulk-go]')) {
        const to = $('amBulkTo') && $('amBulkTo').value;
        if (!to) { state.msg = { type: 'err', text: 'Choose who to move them to first.' }; render(); return; }
        const n = state.selected.size;
        if (n > 1 && !window.confirm('Move ' + n + ' accounts to ' + to + '? Anyone previously set as their owner will be replaced (the change history keeps a record).')) return;
        assign(Array.from(state.selected), to, null); return;
      }
      if (t.closest('[data-bulk-confirm]')) {
        if (state.selected.size > 1 && !window.confirm('Confirm the suggested owner on the selected accounts?')) return;
        const P = prepare(), groups = {};
        Array.from(state.selected).forEach(k => { const a = P.byKey[k]; if (a && a.isAuto && a.owner !== NONE) (groups[a.owner] = groups[a.owner] || []).push(k); });
        (async () => {
          let done = 0;
          for (const who of Object.keys(groups)) {
            await assign(groups[who], who, null);
            if (state.msg && state.msg.type === 'err') return;
            done += groups[who].length;
          }
          state.msg = { type: 'ok', text: plural(done, 'account') + ' confirmed with their suggested owner.' };
          render();
        })();
        return;
      }
      const sv = t.closest('[data-save-owner]');
      if (sv) { const sel = $('amOwnerSel'), note = $('amNote'); assign([sv.dataset.saveOwner], sel ? sel.value : '', note ? note.value.trim() : ''); return; }
      const cf = t.closest('[data-confirm-owner]');
      if (cf) { const a = state.data.accounts.find(x => x.key === cf.dataset.confirmOwner); if (a && a.owner) assign([a.key], a.owner, ($('amNote') && $('amNote').value.trim()) || ''); return; }
    });
    sec.addEventListener('change', e => {
      const t = e.target;
      if (t.matches && t.matches('[data-check]')) {
        if (t.checked) state.selected.add(t.dataset.check); else state.selected.delete(t.dataset.check);
        state.msg = null; renderTable(); return;
      }
      if (t.matches && t.matches('[data-checkall]')) {
        const rows = sec.querySelectorAll('[data-check]');
        rows.forEach(c => { if (t.checked) state.selected.add(c.dataset.check); else state.selected.delete(c.dataset.check); });
        state.msg = null; renderTable();
      }
    });
    sec.addEventListener('input', e => { if (e.target.id === 'amSearch') { state.q = e.target.value; state.showAll = false; renderTable(); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sec.classList.contains('active') && state.openKey) closeDrawer(); });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.AccountManagersPage = { reload: () => load(), state };
})();
