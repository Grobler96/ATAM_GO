// Calendar tab: everything that is due on a date, across Win-back, Quotes and New customers, for the whole team or one person.
// Data: the read-only view calendar_actions (sql/calendar_actions_2026-10-26.sql). Nothing is written from here: to deal with an
// item you open it in its own tab, so the calendar can never double-book or lose anything.
// Adds its own nav button and page (app.js binds the nav once, same as quotes.js / winback.js).
(function () {
  'use strict';

  const PAGE_ID = 'calendar';
  const REFRESH_MS = 5 * 60 * 1000;

  const KINDS = {
    winback_followup: { icon: '📞', label: 'Chase again', color: '#f97316', page: 'winback', where: 'Win-back' },
    winback_reply:    { icon: '✉️', label: 'Email: no reply yet', color: '#f59e0b', page: 'winback', where: 'Win-back' },
    quote_reply:      { icon: '🧾', label: 'Quote email: no reply yet', color: '#38bdf8', page: 'quotes', where: 'Quotes' },
    nc_followup:      { icon: '🌱', label: 'New customer: follow up', color: '#22c55e', page: 'newcustomers', where: 'New customers' },
    nc_reply:         { icon: '✉️', label: 'New customer email: no reply yet', color: '#a78bfa', page: 'newcustomers', where: 'New customers' }
  };
  const OUTCOME_TEXT = { left_message: 'last time: left a message', no_answer: 'last time: no answer', spoke: 'last time: spoke to them', ring_back: 'they asked us to ring back', replied: 'they replied', quote_requested: 'they asked for a quote' };
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const state = { view: 'month', sel: null, anchor: null, owner: '', items: [], loaded: false, loading: false, error: null, me: '', timer: null };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromIso = s => { const p = String(s).slice(0, 10).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; };
  const startOfWeek = d => addDays(d, -((d.getDay() + 6) % 7));
  const todayIso = () => iso(new Date());
  const longDay = d => DOW[(d.getDay() + 6) % 7] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const hue = n => { let h = 0; String(n || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; };
  const avatar = n => `<span class="cal-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(n)}">${esc(initials(n))}</span>`;

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

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; render(); }
    try {
      const rows = await pageAll(() => client().from('calendar_actions').select('*').order('item_date'));
      state.items = rows.filter(r => r.item_date && KINDS[r.kind]).map(r => ({ date: String(r.item_date).slice(0, 10), kind: r.kind, owner: r.owner || 'Unassigned', label: r.label || '', ref: String(r.ref_id || ''), detail: r.detail || '' }));
      if (!state.me) {
        try {
          const u = await client().auth.getUser();
          const id = u && u.data && u.data.user && u.data.user.id;
          if (id) {
            const p = await client().from('profiles').select('full_name').eq('id', id).maybeSingle();
            state.me = (p && p.data && p.data.full_name) || '';
            if (!state.loaded && state.me && state.items.some(i => i.owner === state.me)) state.owner = state.me;
          }
        } catch (e) { /* "Me" just stays unavailable */ }
      }
      state.loaded = true; state.error = null;
    } catch (e) {
      console.error('calendar load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the calendar';
    } finally { state.loading = false; }
    render();
  }

  const visible = () => state.items.filter(i => !state.owner || i.owner === state.owner);
  const onDay = (list, d) => list.filter(i => i.date === d);

  function detailText(i) {
    if (i.kind === 'winback_followup' || i.kind === 'nc_followup') return OUTCOME_TEXT[i.detail] || '';
    return i.detail ? i.detail.replace(/^email (\d+)$/, 'email #$1').replace(/^quote (.+) email (\d+)$/, 'quote #$1, email #$2') : '';
  }
  function itemHtml(i, today, showOwner) {
    const k = KINDS[i.kind];
    const late = i.date < today;
    const lateDays = late ? Math.round((fromIso(today) - fromIso(i.date)) / 86400000) : 0;
    const dt = detailText(i);
    return `<div class="cal-item${late ? ' late' : ''}" style="--c:${k.color}">
      <span class="cal-ic">${k.icon}</span>
      <div class="cal-main"><b>${esc(i.label)}</b>
        <div class="cal-sub">${esc(k.label)}${dt ? ' · ' + esc(dt) : ''}${late ? ` · <span class="cal-late">${lateDays} day${lateDays === 1 ? '' : 's'} late</span>` : ''}</div></div>
      ${showOwner ? avatar(i.owner) : ''}
      <button type="button" class="cal-btn" data-open="${esc(i.kind)}" data-ref="${esc(i.ref)}">Open in ${esc(k.where)}</button></div>`;
  }
  const chip = (i, today) => `<div class="cal-chip${i.date < today ? ' late' : ''}" style="--c:${KINDS[i.kind].color}" title="${esc(KINDS[i.kind].label)} · ${esc(i.owner)}" data-open="${esc(i.kind)}" data-ref="${esc(i.ref)}">${KINDS[i.kind].icon} ${esc(i.label)}</div>`;

  function head() {
    const a = state.anchor;
    let title = '';
    if (state.view === 'day') title = (iso(a) === todayIso() ? 'Today · ' : '') + longDay(a) + ' ' + a.getFullYear();
    else if (state.view === 'week') { const s = startOfWeek(a), e = addDays(s, 6); title = longDay(s) + ' to ' + longDay(e); }
    else title = MONTHS[a.getMonth()] + ' ' + a.getFullYear();
    const owners = Array.from(new Set(state.items.map(i => i.owner).concat(state.me ? [state.me] : []))).sort();
    return `<div class="cal-bar">
      <div class="cal-seg" role="group" aria-label="View">${['day', 'week', 'month'].map(v => `<button type="button" data-view="${v}" class="${state.view === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <div class="cal-nav"><button type="button" class="cal-btn" data-step="-1" aria-label="Previous">‹</button><button type="button" class="cal-btn" data-today="1">Today</button><button type="button" class="cal-btn" data-step="1" aria-label="Next">›</button></div>
      <h3 class="cal-title">${esc(title)}</h3>
      <select id="calOwner" aria-label="Whose actions"><option value="">Everyone</option>${owners.map(o => `<option value="${esc(o)}"${o === state.owner ? ' selected' : ''}>${esc(o === state.me ? o + ' (me)' : o)}</option>`).join('')}</select>
      <button type="button" class="cal-btn" data-reload="1">Refresh</button></div>`;
  }

  function teamStrip(list, today) {
    const by = {};
    list.forEach(i => { const o = by[i.owner] = by[i.owner] || { n: 0, late: 0 }; if (i.date <= today) { o.n++; if (i.date < today) o.late++; } });
    const names = Object.keys(by).filter(n => by[n].n).sort((a, b) => by[b].n - by[a].n);
    if (!names.length) return '';
    return `<div class="cal-team"><span class="cal-dim">Due today or late:</span>${names.map(n => `<button type="button" class="cal-person${n === state.owner ? ' on' : ''}" data-person="${esc(n)}">${avatar(n)} ${esc(n)} <b>${by[n].n}</b>${by[n].late ? `<span class="cal-late"> (${by[n].late} late)</span>` : ''}</button>`).join('')}</div>`;
  }

  function dayView(list, today) {
    const d = iso(state.anchor);
    const dayItems = onDay(list, d);
    const late = d === today ? list.filter(i => i.date < today).sort((a, b) => a.date.localeCompare(b.date)) : [];
    const everyone = !state.owner;
    const group = items => {
      if (!everyone) return items.map(i => itemHtml(i, today, false)).join('');
      const by = {};
      items.forEach(i => { (by[i.owner] = by[i.owner] || []).push(i); });
      return Object.keys(by).sort().map(o => `<div class="cal-group"><h4>${avatar(o)} ${esc(o)} <span class="cal-dim">${by[o].length}</span></h4>${by[o].map(i => itemHtml(i, today, false)).join('')}</div>`).join('');
    };
    let out = '';
    if (late.length) out += `<h4 class="cal-h late">Late (${late.length})</h4>${group(late)}`;
    out += `<h4 class="cal-h">${d === today ? 'Today' : esc(longDay(state.anchor))} (${dayItems.length})</h4>`;
    out += dayItems.length ? group(dayItems) : '<div class="cal-empty">Nothing due. ' + (state.owner ? 'Try Everyone, or another day.' : 'A clear day.') + '</div>';
    return out;
  }
  function weekView(list, today) {
    const s = startOfWeek(state.anchor);
    return '<div class="cal-week">' + Array.from({ length: 7 }, (_, n) => {
      const d = addDays(s, n), id = iso(d), its = onDay(list, id);
      const lateHere = id === today ? list.filter(i => i.date < today) : [];
      const all = lateHere.concat(its);
      return `<div class="cal-col${id === today ? ' today' : ''}"><button type="button" class="cal-colhead" data-goday="${id}">${esc(DOW[n])} ${d.getDate()}<span>${all.length || ''}</span></button>
        ${all.slice(0, 10).map(i => chip(i, today)).join('')}${all.length > 10 ? `<button type="button" class="cal-more" data-goday="${id}">+${all.length - 10} more</button>` : ''}</div>`;
    }).join('') + '</div>';
  }
  function legendHtml() {
    return '<div class="cal-legend">' + Object.keys(KINDS).filter((k, i, a) => a.findIndex(x => KINDS[x].label === KINDS[k].label) === i).map(k => `<span style="--c:${KINDS[k].color}"><i></i>${KINDS[k].icon} ${esc(KINDS[k].label)}</span>`).join('') + '<span class="cal-lg-late"><i></i>Late</span></div>';
  }
  function monthView(list, today) {
    const a = state.anchor, first = new Date(a.getFullYear(), a.getMonth(), 1);
    const s = startOfWeek(first);
    if (!state.sel || fromIso(state.sel).getMonth() !== a.getMonth() || fromIso(state.sel).getFullYear() !== a.getFullYear()) {
      const t = fromIso(today);
      state.sel = (t.getMonth() === a.getMonth() && t.getFullYear() === a.getFullYear()) ? today : iso(first);
    }
    const cells = [];
    for (let n = 0; n < 42; n++) {
      const d = addDays(s, n), id = iso(d);
      if (n >= 35 && d.getMonth() !== a.getMonth()) break;
      const its = onDay(list, id);
      const dow = (d.getDay() + 6) % 7;
      const cls = 'cal-cell' + (d.getMonth() !== a.getMonth() ? ' other' : '') + (id === today ? ' today' : '') + (id === state.sel ? ' sel' : '') + (dow >= 5 ? ' wkend' : '') + (its.length ? ' has' : '');
      cells.push(`<div class="${cls}" data-selday="${id}" role="button" tabindex="0" aria-label="${esc(longDay(d))}, ${its.length} to do">
        <div class="cal-top"><span class="cal-d">${d.getDate()}</span>${its.length ? `<span class="cal-count">${its.length}</span>` : ''}</div>
        <div class="cal-chips">${its.slice(0, 3).map(i => `<span class="cal-mini${i.date < today ? ' late' : ''}" style="--c:${KINDS[i.kind].color}">${KINDS[i.kind].icon} ${esc(i.label)}</span>`).join('')}${its.length > 3 ? `<span class="cal-more-n">+${its.length - 3} more</span>` : ''}</div>
        <div class="cal-dots">${its.slice(0, 5).map(i => `<i style="background:${KINDS[i.kind].color}"></i>`).join('')}</div></div>`);
    }
    const selDate = fromIso(state.sel), selItems = onDay(list, state.sel);
    const panel = `<div class="cal-daypanel"><h4>${state.sel === today ? 'Today · ' : ''}${esc(longDay(selDate))} <span class="cal-dim">${selItems.length ? selItems.length + ' to do' : 'nothing due'}</span></h4>` +
      (selItems.length ? selItems.map(i => itemHtml(i, today, !state.owner)).join('') : '<div class="cal-empty">Nothing due on this day.</div>') + '</div>';
    return `<div class="cal-month"><div class="cal-dows">${DOW.map((x, n) => `<span class="${n >= 5 ? 'wk' : ''}">${x}</span>`).join('')}</div><div class="cal-grid">${cells.join('')}</div></div>${legendHtml()}${panel}`;
  }

  function render() {
    const el = $('calBody');
    if (!el) return;
    if (!state.anchor) state.anchor = new Date();
    if (state.error) { el.innerHTML = `<div class="cal-empty">Couldn't load the calendar: ${esc(state.error)}<br><button type="button" class="cal-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { el.innerHTML = '<div class="cal-empty">Loading…</div>'; return; }
    const today = todayIso(), list = visible();
    el.innerHTML = head() + teamStrip(state.items, today) +
      '<div class="cal-view">' + (state.view === 'day' ? dayView(list, today) : state.view === 'week' ? weekView(list, today) : monthView(list, today)) + '</div>' +
      '<p class="cal-foot">This calendar shows the dates people have set (“chase again on…”) and the end of the 3-day wait after an email we sent. It is read-only: open an item to deal with it, and it disappears from here once it is done. Nothing is added to Outlook.</p>';
  }

  function step(n) {
    const a = state.anchor;
    state.anchor = state.view === 'day' ? addDays(a, n) : state.view === 'week' ? addDays(a, 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1);
    if (state.view === 'month') state.sel = null;
    render();
  }

  function go(kind, ref) {
    const k = KINDS[kind]; if (!k) return;
    const btn = document.querySelector('.nav-link[data-page="' + k.page + '"]');
    if (!btn) return;
    btn.click();
    if (k.page === 'winback') {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const W = window.WinbackPage;
        if (W && W.open && W.state && W.state.loaded && W.state.rows.some(r => r.id === ref)) { clearInterval(t); W.open(ref); }
        else if (tries > 40) clearInterval(t);
      }, 150);
    }
  }

  function injectStyles() {
    if ($('calStyles')) return;
    const s = document.createElement('style');
    s.id = 'calStyles';
    s.textContent = `
#calendar .cal-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(34,197,94,.14), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(99,102,241,.14), transparent 60%), rgba(15,23,42,.55); }
#calendar .cal-headbox h2 { margin:0 0 6px; font-size:28px; }
#calendar .cal-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#calendar .cal-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:18px 0 10px; }
#calendar .cal-title { margin:0; font-size:18px; flex:1 1 200px; }
#calendar .cal-seg { display:inline-flex; border:1px solid rgba(255,255,255,.14); border-radius:10px; overflow:hidden; }
#calendar .cal-seg button { background:transparent; border:0; color:#cbd5e1; padding:8px 14px; font-size:13px; cursor:pointer; }
#calendar .cal-seg button.on { background:#2563eb; color:#fff; }
#calendar .cal-nav { display:inline-flex; gap:6px; }
#calendar .cal-btn { padding:7px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:12.5px; cursor:pointer; }
#calendar .cal-btn:hover { border-color:#38bdf8; }
#calendar select { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font-size:13px; }
#calendar .cal-team { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:6px 0 14px; }
#calendar .cal-person { display:inline-flex; gap:6px; align-items:center; padding:5px 10px 5px 6px; border-radius:20px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font-size:12.5px; cursor:pointer; }
#calendar .cal-person.on { border-color:#38bdf8; background:rgba(56,189,248,.12); }
#calendar .cal-av { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:50%; font-size:10px; font-weight:700; color:#fff; flex:none; }
#calendar .cal-dim { color:#64748b; font-size:12px; }
#calendar .cal-late { color:#fb923c; font-weight:600; }
#calendar .cal-h { margin:18px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; }
#calendar .cal-h.late { color:#fb923c; }
#calendar .cal-group { margin-bottom:12px; }
#calendar .cal-group h4 { display:flex; gap:8px; align-items:center; margin:10px 0 6px; font-size:14px; }
#calendar .cal-item { display:flex; gap:12px; align-items:center; padding:10px 12px; margin-bottom:6px; border-radius:12px; border:1px solid rgba(255,255,255,.08); border-left:4px solid var(--c); background:rgba(15,23,42,.7); }
#calendar .cal-item.late { background:rgba(251,146,60,.07); }
#calendar .cal-ic { font-size:18px; }
#calendar .cal-main { flex:1; min-width:0; }
#calendar .cal-main b { overflow-wrap:anywhere; }
#calendar .cal-sub { color:#94a3b8; font-size:12.5px; margin-top:2px; }
#calendar .cal-empty { padding:30px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:12px; }
#calendar .cal-week { display:grid; grid-template-columns:repeat(7, minmax(120px, 1fr)); gap:8px; overflow-x:auto; }
#calendar .cal-col { min-width:120px; border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:6px; background:rgba(15,23,42,.55); }
#calendar .cal-col.today { border-color:#38bdf8; }
#calendar .cal-colhead { display:flex; justify-content:space-between; width:100%; background:transparent; border:0; color:#e2e8f0; font-weight:600; font-size:13px; padding:4px; cursor:pointer; }
#calendar .cal-chip { margin:4px 0; padding:5px 7px; border-radius:8px; border-left:3px solid var(--c); background:#0f172a; font-size:12px; cursor:pointer; overflow-wrap:anywhere; }
#calendar .cal-chip.late { background:rgba(251,146,60,.1); }
#calendar .cal-more { background:transparent; border:0; color:#7dd3fc; font-size:12px; cursor:pointer; }
#calendar .cal-month { border:1px solid rgba(255,255,255,.12); border-radius:14px; overflow:hidden; background:rgba(8,12,24,.85); }
#calendar .cal-dows { display:grid; grid-template-columns:repeat(7,1fr); background:rgba(255,255,255,.06); color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:.06em; text-align:center; }
#calendar .cal-dows span { padding:9px 0; } #calendar .cal-dows span.wk { color:#64748b; }
#calendar .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); }
#calendar .cal-cell { min-height:116px; padding:6px 7px; border-top:1px solid rgba(255,255,255,.08); border-left:1px solid rgba(255,255,255,.08); background:transparent; color:#e2e8f0; cursor:pointer; display:flex; flex-direction:column; gap:4px; overflow:hidden; text-align:left; }
#calendar .cal-cell:nth-child(7n+1) { border-left:0; }
#calendar .cal-cell.wkend { background:rgba(255,255,255,.025); }
#calendar .cal-cell.other { opacity:.4; }
#calendar .cal-cell:hover { background:rgba(56,189,248,.07); }
#calendar .cal-cell.sel { outline:2px solid #38bdf8; outline-offset:-2px; background:rgba(56,189,248,.1); }
#calendar .cal-top { display:flex; justify-content:space-between; align-items:center; }
#calendar .cal-d { font-size:13px; font-weight:600; width:24px; height:24px; display:inline-grid; place-items:center; border-radius:50%; }
#calendar .cal-cell.today .cal-d { background:#2563eb; color:#fff; }
#calendar .cal-count { font-size:11px; padding:1px 7px; border-radius:10px; background:rgba(255,255,255,.1); color:#cbd5e1; }
#calendar .cal-chips { display:flex; flex-direction:column; gap:3px; min-width:0; }
#calendar .cal-mini { font-size:11.5px; padding:2px 6px; border-radius:6px; border-left:3px solid var(--c); background:color-mix(in srgb, var(--c) 16%, #0b1222); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#calendar .cal-mini.late { box-shadow:inset 0 0 0 1px rgba(251,146,60,.6); }
#calendar .cal-more-n { font-size:11px; color:#7dd3fc; }
#calendar .cal-dots { display:none; gap:3px; flex-wrap:wrap; } #calendar .cal-dots i { width:7px; height:7px; border-radius:50%; }
#calendar .cal-legend { display:flex; flex-wrap:wrap; gap:14px; margin:12px 2px; font-size:12px; color:#94a3b8; }
#calendar .cal-legend span { display:inline-flex; align-items:center; gap:6px; } #calendar .cal-legend i { width:10px; height:10px; border-radius:3px; background:var(--c); }
#calendar .cal-legend .cal-lg-late i { background:transparent; box-shadow:inset 0 0 0 2px rgba(251,146,60,.8); }
#calendar .cal-daypanel { margin-top:6px; padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.6); }
#calendar .cal-daypanel h4 { margin:0 0 10px; font-size:15px; }
@media (max-width: 760px) { #calendar .cal-cell { min-height:56px; padding:4px; } #calendar .cal-chips { display:none; } #calendar .cal-dots { display:flex; } #calendar .cal-count { display:none; } }
#calendar .cal-foot { margin-top:18px; color:#64748b; font-size:12px; max-width:760px; line-height:1.5; }
@media (max-width: 760px) { `;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="newcustomers"]') || document.querySelector('.nav-link[data-page="winback"]');
    const anchorPage = $('newcustomers') || $('winback');
    if (!anchorBtn || !anchorPage) return false;
    if (!document.querySelector('.nav-link[data-page="newcustomers"]') && boot.tries < 25) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>📅 Calendar</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="cal-headbox"><p class="eyebrow">Sales</p><h2>Calendar</h2>
      <p>Everything the team has to chase, on one page: Win-back chase dates, quote emails still waiting for a reply, and new customers to follow up. Pick Day, Week or Month, and Everyone or one person.</p></div>
      <div id="calBody"><div class="cal-empty">Loading…</div></div>`;
    anchorPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      state.anchor = new Date(); state.sel = null;
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      const v = e.target.closest('[data-view]');
      if (v) { state.view = v.dataset.view; render(); return; }
      const st = e.target.closest('[data-step]');
      if (st) { step(Number(st.dataset.step)); return; }
      if (e.target.closest('[data-today]')) { state.anchor = new Date(); state.sel = null; render(); return; }
      if (e.target.closest('[data-reload]')) { load(); return; }
      const sd = e.target.closest('[data-selday]');
      if (sd) { state.sel = sd.dataset.selday; render(); return; }
      const gd = e.target.closest('[data-goday]');
      if (gd) { state.anchor = fromIso(gd.dataset.goday); state.view = 'day'; render(); return; }
      const pe = e.target.closest('[data-person]');
      if (pe) { state.owner = state.owner === pe.dataset.person ? '' : pe.dataset.person; render(); return; }
      const op = e.target.closest('[data-open]');
      if (op) { go(op.dataset.open, op.dataset.ref); return; }
    });
    sec.addEventListener('keydown', e => { const c = e.target.closest && e.target.closest('[data-selday]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } });
    sec.addEventListener('change', e => { if (e.target.id === 'calOwner') { state.owner = e.target.value; render(); } });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.CalendarPage = { reload: () => load(), state };
})();
