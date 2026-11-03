// Today tab: one ranked list of what each person should do next, pulled from the rest of ATAM GO.
// Sources (all read only, nothing is written from here except a "done for today" tick that is kept on this device):
//   Quotes            quotes_board, with the same stage rules as the Quotes tab (window.ATAM_QT.enrich): customer replied and waiting, email
//                     with no reply after 3 days, back from parking, needs chasing / going cold.
//   Win-back, New customers   calendar_actions: chase dates that have arrived or passed, and emails with no reply.
//   Orders and money  today_work (sql/today_work_2026-11-03.sql): open orders that are late, and overdue Xero invoices.
// Ranking is a plain points score (shown in the "How this is ranked" note): what needs a person soonest, then how much money is involved.
// Adds its own nav button (first in the menu) and page, like quotes.js / calendar.js.
(function () {
  'use strict';

  const PAGE_ID = 'today';
  const REFRESH_MS = 5 * 60 * 1000;
  const SHOW_FIRST = 12;
  const DAY = 86400000;

  const GROUPS = {
    quotes:       { label: 'Quotes', icon: '🎯' },
    winback:      { label: 'Win-back', icon: '📞' },
    newcustomers: { label: 'New customers', icon: '🌱' },
    orders:       { label: 'Orders', icon: '📦' },
    money:        { label: 'Money owed', icon: '💷' }
  };
  const state = { owner: '', group: '', showAll: false, items: [], me: '', team: [], loaded: false, loading: false, error: null, timer: null, done: new Set(), showDone: false };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gbp = n => '£' + Math.round(Number(n) || 0).toLocaleString('en-GB');
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromYmd = s => { const p = String(s).slice(0, 10).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const hue = n => { let h = 0; String(n || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; };
  const avatar = n => `<span class="td-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(n)}">${esc(initials(n))}</span>`;
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const bonus = (value, per) => Math.min(40, (Number(value) || 0) / per);

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

  // ---- "done for today" ticks, kept on this device only and cleared by the date in the key ----
  const doneKey = () => 'atamgo_today_done_' + ymd(new Date());
  function loadDone() {
    try { state.done = new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]')); } catch (e) { state.done = new Set(); }
  }
  function saveDone() { try { localStorage.setItem(doneKey(), JSON.stringify(Array.from(state.done))); } catch (e) { /* ticks just will not be remembered */ } }

  // ---- building the list ----
  function quoteItems(rows, now) {
    const QT = window.ATAM_QT;
    const out = [];
    rows.forEach(raw => {
      const r = QT.enrich(raw, now);
      if (!['fresh', 'chase', 'cold'].includes(r.stage)) return;
      let why = '', score = 0;
      const base = { key: 'quote:' + r.id, group: 'quotes', icon: '🎯', color: '#38bdf8', owner: r.rep || 'Unassigned', label: r.customer, sub: (r.job ? r.job + ' · ' : '') + '#' + r.id, value: r.value, action: { type: 'quote', id: r.id } };
      const backFromParking = r.parkReturnAt && (now - r.parkReturnAt) < 7 * DAY && r.stage === 'fresh';
      if (r.awaitingUs) { score = 100; why = 'Customer replied ' + QT.ago(r.lastFrom) + '. Waiting on you.'; base.color = '#22c55e'; base.cta = 'Reply'; }
      else if (backFromParking) { score = 85; why = 'Back from parking' + (r.parkReason ? ': ' + r.parkReason : '') + '.'; base.color = '#a78bfa'; base.cta = 'Email'; }
      else if (r.emailDue) { score = 70; why = 'Emailed (chase #' + r.emailNo + '), no reply after 3 days.'; base.color = '#f59e0b'; base.cta = 'Chase again'; }
      else if (r.stage === 'chase' || r.stage === 'cold') { score = 45 + Math.min(r.idle, 29); why = 'Quiet for ' + plural(r.idle, 'day') + (r.stage === 'cold' ? ', going cold.' : '.'); base.color = r.stage === 'cold' ? '#38bdf8' : '#f59e0b'; base.cta = 'Email'; }
      else return;
      out.push(Object.assign(base, { why, score: score + bonus(r.value, 50) }));
    });
    return out;
  }

  function calendarItems(rows, today) {
    const out = [];
    rows.forEach(r => {
      const date = String(r.item_date || '').slice(0, 10);
      if (!date || date > today) return;
      const lateDays = Math.round((fromYmd(today) - fromYmd(date)) / DAY);
      const k = r.kind;
      if (k === 'winback_followup') out.push({ key: k + ':' + r.ref_id + ':' + date, group: 'winback', icon: '📞', color: '#f97316', owner: r.owner || 'Unassigned', label: r.label, sub: '', why: 'Chase date ' + (lateDays ? plural(lateDays, 'day') + ' ago' : 'is today') + '.', value: 0, score: 80 + Math.min(lateDays, 20) * 2, action: { type: 'winback', id: r.ref_id }, cta: 'Open customer' });
      else if (k === 'winback_reply') out.push({ key: k + ':' + r.ref_id + ':' + date, group: 'winback', icon: '✉️', color: '#f59e0b', owner: r.owner || 'Unassigned', label: r.label, sub: '', why: 'Emailed, no reply yet. Time to follow up.', value: 0, score: 55 + Math.min(lateDays, 20), action: { type: 'winback', id: r.ref_id }, cta: 'Open customer' });
      else if (k === 'nc_followup') out.push({ key: k + ':' + r.ref_id + ':' + date, group: 'newcustomers', icon: '🌱', color: '#22c55e', owner: r.owner || 'Unassigned', label: r.label, sub: '', why: 'New customer follow-up ' + (lateDays ? plural(lateDays, 'day') + ' overdue' : 'due today') + '.', value: 0, score: 75 + Math.min(lateDays, 20) * 2, action: { type: 'page', id: 'newcustomers' }, cta: 'Open New customers' });
      else if (k === 'nc_reply') out.push({ key: k + ':' + r.ref_id + ':' + date, group: 'newcustomers', icon: '✉️', color: '#a78bfa', owner: r.owner || 'Unassigned', label: r.label, sub: '', why: 'Emailed, no reply yet. Time to follow up.', value: 0, score: 50 + Math.min(lateDays, 20), action: { type: 'page', id: 'newcustomers' }, cta: 'Open New customers' });
    });
    return out;
  }

  function workItems(rows) {
    const out = [];
    const old = new Map();   // invoices more than 90 days overdue are rolled up per person: too many to be useful one by one
    rows.forEach(r => {
      const days = Number(r.days_late) || 0, value = Number(r.value) || 0, owner = r.owner || 'Unassigned';
      if (r.kind === 'order_late') {
        out.push({ key: 'order:' + r.ref_id, group: 'orders', icon: '📦', color: '#ef4444', owner, label: r.label, sub: 'Order #' + r.doc_ref, why: (days <= 0 ? 'Due today' : 'Due ' + plural(days, 'day') + ' ago') + ', not shipped yet.', value, score: 60 + Math.min(days, 14) * 2 + bonus(value, 100), action: { type: 'page', id: 'production' }, cta: 'Open Production' });
      } else if (r.kind === 'invoice_overdue') {
        if (days > 90) { const o = old.get(owner) || { n: 0, v: 0 }; o.n++; o.v += value; old.set(owner, o); return; }
        out.push({ key: 'inv:' + r.ref_id, group: 'money', icon: '💷', color: '#eab308', owner, label: r.label, sub: 'Invoice ' + r.doc_ref, why: plural(days, 'day') + ' overdue.', value, score: 50 + days / 3 + bonus(value, 100), action: null });
      }
    });
    old.forEach((o, owner) => out.push({ key: 'invold:' + owner, group: 'money', icon: '🗂', color: '#94a3b8', owner, label: plural(o.n, 'invoice') + ' over 3 months overdue', sub: '', why: 'Worth a review in Xero: some of these may be old records that can be written off or chased properly.', value: o.v, score: 35, action: null }));
    return out;
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; render(); }
    try {
      const now = new Date(), today = ymd(now);
      const QT = window.ATAM_QT;
      const jobs = [
        QT && QT.enrich ? pageAll(() => client().from('quotes_board').select('*').order('order_id', { ascending: false })).then(r => quoteItems(r, now)) : Promise.resolve([]),
        pageAll(() => client().from('calendar_actions').select('*').order('item_date')).then(r => calendarItems(r, today)),
        pageAll(() => client().from('today_work').select('*').order('ref_id')).then(workItems)
      ];
      const parts = await Promise.allSettled(jobs);
      const failed = parts.filter(p => p.status === 'rejected');
      if (failed.length === parts.length) throw failed[0].reason;
      state.partial = failed.length ? failed.length : 0;
      state.items = parts.filter(p => p.status === 'fulfilled').flatMap(p => p.value).sort((a, b) => b.score - a.score);
      if (!state.me) {
        try {
          const u = await client().auth.getUser();
          const id = u && u.data && u.data.user && u.data.user.id;
          if (id) {
            const p = await client().from('profiles').select('full_name').eq('id', id).maybeSingle();
            state.me = (p && p.data && p.data.full_name) || '';
          }
        } catch (e) { /* "Me" just stays unavailable */ }
      }
      if (!state.team.length) {
        try {
          const t = await client().from('mail_senders').select('rep_name').eq('kind', 'rep').eq('active', true);
          state.team = ((t && t.data) || []).map(r => r.rep_name).filter(Boolean);
        } catch (e) { /* the picker then only has people with something to do */ }
      }
      if (!state.loaded && state.me && state.items.some(i => i.owner === state.me)) state.owner = state.me;
      state.loaded = true; state.error = null; state.updatedAt = new Date();
    } catch (e) {
      console.error('today load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load your list';
    } finally { state.loading = false; }
    render();
  }

  // ---- drawing ----
  const mine = () => state.items.filter(i => !state.owner || i.owner === state.owner);
  function dayTitle() {
    const d = new Date();
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function rowHtml(i, rank, showOwner) {
    const isDone = state.done.has(i.key);
    const btn = !i.action ? '' : `<button type="button" class="td-btn td-go" data-go="${esc(i.key)}">${esc(i.cta || 'Open')}</button>`;
    return `<li class="td-row${isDone ? ' done' : ''}" style="--c:${i.color}">
      <span class="td-rank">${rank}</span>
      <span class="td-ic" aria-hidden="true">${i.icon}</span>
      <div class="td-main"><b>${esc(i.label)}</b>${i.sub ? ` <span class="td-sub">${esc(i.sub)}</span>` : ''}<div class="td-why">${esc(i.why)}</div></div>
      ${i.value ? `<span class="td-val">${gbp(i.value)}</span>` : '<span class="td-val"></span>'}
      ${showOwner ? avatar(i.owner) : ''}
      <span class="td-acts">${btn}<button type="button" class="td-btn td-tick" data-tick="${esc(i.key)}" title="${isDone ? 'Put it back on the list' : 'Done for today: hides it on this device until tomorrow'}" aria-pressed="${isDone}">${isDone ? '↩' : '✓'}</button></span></li>`;
  }

  function render() {
    const body = $('tdBody'); if (!body) return;
    if (state.error) { body.innerHTML = `<div class="td-empty">Couldn't load your list: ${esc(state.error)}<br><button type="button" class="td-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { body.innerHTML = '<div class="td-empty">Working out your day…</div>'; return; }
    const all = mine();
    const open = all.filter(i => !state.done.has(i.key));
    const doneN = all.length - open.length;
    const counts = {}; open.forEach(i => { counts[i.group] = (counts[i.group] || 0) + 1; });
    const shown = open.filter(i => !state.group || i.group === state.group);
    const list = state.showAll ? shown : shown.slice(0, SHOW_FIRST);
    const inPlay = open.filter(i => i.group === 'quotes').reduce((s, i) => s + i.value, 0);
    const owed = open.filter(i => i.group === 'money').reduce((s, i) => s + i.value, 0);
    const people = Array.from(new Set(state.team.concat(state.items.map(i => i.owner)))).filter(Boolean).sort();
    const first = (state.owner || '').split(' ')[0];
    body.innerHTML = `
      <div class="td-bar">
        <label class="td-who">Showing <select id="tdOwner" aria-label="Whose list"><option value="">Everyone</option>${people.map(p => `<option value="${esc(p)}"${p === state.owner ? ' selected' : ''}>${esc(p)}${p === state.me ? ' (me)' : ''}</option>`).join('')}</select></label>
        <button type="button" class="td-btn" data-reload="1" title="Refresh">${state.loading ? '…' : '⟳ Refresh'}</button>
        <span class="td-dim">${state.updatedAt ? 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div class="td-hero"><h3>${esc(greeting())}${first ? ', ' + esc(first) : ''}.</h3>
        <p>${open.length ? `You have <b>${plural(open.length, 'thing')}</b> to do${doneN ? ` (${doneN} already ticked off)` : ''}. ${inPlay ? `<b>${gbp(inPlay)}</b> of quotes need you` : ''}${inPlay && owed ? ' and ' : ''}${owed ? `<b>${gbp(owed)}</b> is overdue in invoices` : ''}${inPlay || owed ? '.' : ''}` : (doneN ? 'Everything is ticked off. Nice work.' : 'Nothing needs you right now.')}</p></div>
      ${state.partial ? '<div class="td-warn">Part of the list could not be loaded, so it may be missing some things. Press Refresh to try again.</div>' : ''}
      <div class="td-chips" role="group" aria-label="Filter by area"><button type="button" class="td-chip${state.group ? '' : ' on'}" data-group="">Everything <span>${open.length}</span></button>${Object.keys(GROUPS).filter(g => counts[g]).map(g => `<button type="button" class="td-chip${state.group === g ? ' on' : ''}" data-group="${g}">${GROUPS[g].icon} ${esc(GROUPS[g].label)} <span>${counts[g]}</span></button>`).join('')}</div>
      ${list.length ? `<ol class="td-list">${list.map((i, k) => rowHtml(i, k + 1, !state.owner)).join('')}</ol>` : '<div class="td-empty">Nothing here. 🎉</div>'}
      ${shown.length > SHOW_FIRST ? `<button type="button" class="td-btn td-more" data-more="1">${state.showAll ? 'Show fewer' : 'Show all ' + shown.length}</button>` : ''}
      ${doneN ? `<div class="td-donebox"><button type="button" class="td-btn" data-showdone="1">${state.showDone ? 'Hide' : 'Show'} ticked off (${doneN})</button>${state.showDone ? `<ol class="td-list">${all.filter(i => state.done.has(i.key)).map((i, k) => rowHtml(i, k + 1, !state.owner)).join('')}</ol>` : ''}</div>` : ''}
      <details class="td-how"><summary>How this is ranked</summary><p>Each item gets points. Biggest first: a customer who has replied and is waiting (100), a Win-back chase date that has arrived (80), a quote back from parking (85), a new customer follow-up (75), a quote email with no reply after 3 days (70), a late order (60 and up), a quote that has gone quiet (45 and up, more the longer it is quiet), an overdue invoice (50 and up). Money adds extra points so bigger quotes and invoices rise. Invoices more than 3 months overdue are grouped into one line. Ticking something off hides it on this device until tomorrow; it does not change anything in ATAM GO.</p></details>`;
  }

  function go(key) {
    const i = state.items.find(x => x.key === key);
    if (!i || !i.action) return;
    const a = i.action;
    if (a.type === 'quote') {
      if (window.ATAM_QT && window.ATAM_QT.openQuote) window.ATAM_QT.openQuote(a.id, i.cta === 'Email' || i.cta === 'Chase again' || i.cta === 'Reply');
      return;
    }
    const pageId = a.type === 'winback' ? 'winback' : a.id;
    const btn = document.querySelector('.nav-link[data-page="' + pageId + '"]');
    if (!btn) return;
    btn.click();
    if (a.type === 'winback') {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const W = window.WinbackPage;
        if (W && W.open && W.state && W.state.loaded && W.state.rows.some(r => r.id === a.id)) { clearInterval(t); W.open(a.id); }
        else if (tries > 40) clearInterval(t);
      }, 150);
    }
  }

  function injectStyles() {
    if ($('tdStyles')) return;
    const s = document.createElement('style');
    s.id = 'tdStyles';
    s.textContent = `
#today .td-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(249,115,22,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(56,189,248,.14), transparent 60%), rgba(15,23,42,.55); }
#today .td-headbox h2 { margin:0 0 6px; font-size:28px; }
#today .td-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#today .td-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:18px 0 10px; }
#today .td-who { display:flex; gap:8px; align-items:center; font-size:13px; color:#94a3b8; }
#today select { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:13px; }
#today .td-dim { color:#64748b; font-size:12px; }
#today .td-hero { margin:6px 0 14px; }
#today .td-hero h3 { margin:0 0 4px; font-size:22px; }
#today .td-hero p { margin:0; color:#cbd5e1; font-size:14.5px; line-height:1.5; }
#today .td-warn { margin:0 0 12px; padding:9px 12px; border-radius:10px; background:rgba(245,158,11,.14); color:#fde68a; font-size:13px; }
#today .td-chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 14px; }
#today .td-chip { padding:7px 13px; border-radius:999px; border:1px solid rgba(255,255,255,.14); background:transparent; color:#cbd5e1; font-size:13px; cursor:pointer; }
#today .td-chip span { margin-left:4px; padding:1px 7px; border-radius:999px; background:rgba(255,255,255,.1); font-size:11.5px; }
#today .td-chip.on { background:rgba(56,189,248,.16); border-color:#38bdf8; color:#fff; }
#today .td-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
#today .td-row { display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.09); border-left:4px solid var(--c); background:rgba(15,23,42,.55); }
#today .td-row.done { opacity:.5; }
#today .td-rank { width:22px; text-align:center; color:#64748b; font-size:12.5px; font-weight:700; flex:none; }
#today .td-ic { font-size:20px; flex:none; }
#today .td-main { flex:1 1 auto; min-width:0; }
#today .td-main b { font-size:15px; }
#today .td-sub { color:#64748b; font-size:12px; }
#today .td-why { color:#94a3b8; font-size:13px; margin-top:2px; line-height:1.4; }
#today .td-val { flex:none; min-width:64px; text-align:right; font-weight:700; font-size:14px; color:#e2e8f0; }
#today .td-av { flex:none; width:26px; height:26px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10.5px; font-weight:700; color:#fff; }
#today .td-acts { flex:none; display:flex; gap:6px; }
#today .td-btn { padding:7px 12px; border-radius:8px; font-size:12.5px; font-weight:600; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#today .td-btn:hover { background:rgba(255,255,255,.07); }
#today .td-go { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#today .td-go:hover { opacity:.9; background:linear-gradient(135deg,#38bdf8,#6366f1); }
#today .td-tick { min-width:34px; }
#today .td-more { margin:12px 0 0; }
#today .td-donebox { margin-top:18px; }
#today .td-donebox .td-list { margin-top:10px; }
#today .td-empty { padding:36px 12px; text-align:center; color:#94a3b8; }
#today .td-how { margin-top:20px; color:#94a3b8; font-size:13px; }
#today .td-how summary { cursor:pointer; }
#today .td-how p { line-height:1.55; max-width:760px; }
@media (max-width:720px) {
  #today .td-row { flex-wrap:wrap; gap:8px 10px; }
  #today .td-main { flex-basis:calc(100% - 80px); }
  #today .td-acts { margin-left:auto; }
  #today .td-val { order:3; }
}`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const first = document.querySelector('.nav-link');
    const anyPage = document.querySelector('.dashboard-page');
    if (!first || !anyPage) return false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>⚡ Today</span>';
    first.parentElement.insertBefore(btn, first);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="td-headbox"><p class="eyebrow">Your day</p><h2>Today — <span id="tdDate">${esc(dayTitle())}</span></h2>
      <p>One list of what to do next, most important first: customers waiting on a reply, chase dates that have arrived, late orders and overdue invoices. Pick a person to see their list.</p></div>
      <div id="tdBody"><div class="td-empty">Working out your day…</div></div>`;
    anyPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      loadDone();
      const d = $('tdDate'); if (d) d.textContent = dayTitle();
      load(state.loaded);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      const g = e.target.closest('[data-go]');
      if (g) { go(g.dataset.go); return; }
      const t = e.target.closest('[data-tick]');
      if (t) { const k = t.dataset.tick; if (state.done.has(k)) state.done.delete(k); else state.done.add(k); saveDone(); render(); return; }
      const grp = e.target.closest('[data-group]');
      if (grp) { state.group = grp.dataset.group; state.showAll = false; render(); return; }
      if (e.target.closest('[data-more]')) { state.showAll = !state.showAll; render(); return; }
      if (e.target.closest('[data-showdone]')) { state.showDone = !state.showDone; render(); return; }
      if (e.target.closest('[data-reload]')) { load(); return; }
    });
    sec.addEventListener('change', e => { if (e.target.id === 'tdOwner') { state.owner = e.target.value; state.showAll = false; render(); } });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage() && boot.tries < 100) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.TodayPage = { reload: () => load(), state };
})();
