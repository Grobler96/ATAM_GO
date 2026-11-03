// Team board tab: each salesperson's orders approved this month against their target, ranked, with a wall-screen mode for the office.
// Data: the database function team_board(month) and the sales_targets table (sql/sales_targets_2026-11-03.sql).
// "Sales" here means orders approved in the month (the value of the order, quotes.approved_at), including orders keyed straight in.
// A target applies from the month it is set until a newer one is set. Only Daniel and Oliver can set targets: the database enforces it
// (can_set_sales_targets), and this page just hides the button from everyone else.
// Adds its own nav button (after Today) and page, like quotes.js / calendar.js.
(function () {
  'use strict';

  const PAGE_ID = 'teamboard';
  const REFRESH_MS = 5 * 60 * 1000;
  const WALL_REFRESH_MS = 60 * 1000;

  const state = { month: null, data: null, canSet: false, loaded: false, loading: false, error: null, wall: false, timer: null };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gbp = n => '£' + Math.round(Number(n) || 0).toLocaleString('en-GB');
  const pad = n => String(n).padStart(2, '0');
  const monthKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01';
  const parseMonth = k => { const p = String(k).slice(0, 10).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, 1); };
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const hue = n => { let h = 0; String(n || '').split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; };
  const avatar = n => `<span class="tb-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(n)}">${esc(initials(n))}</span>`;
  const monthName = d => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  // Working days (Monday to Friday) in a month, and how many of them have passed by today (counting today as half done is overkill: count it as done).
  function workingDays(monthStart) {
    const y = monthStart.getFullYear(), m = monthStart.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const now = new Date();
    let total = 0, done = 0;
    for (let d = 1; d <= last; d++) {
      const dt = new Date(y, m, d), dow = dt.getDay();
      if (dow === 0 || dow === 6) continue;
      total++;
      if (dt <= now) done++;
    }
    return { total, done };
  }
  function monthPhase(monthStart) {
    const now = new Date(), cur = new Date(now.getFullYear(), now.getMonth(), 1);
    return monthStart < cur ? 'past' : monthStart > cur ? 'future' : 'current';
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; render(); }
    try {
      if (!state.month) state.month = monthKey(new Date());
      const [bd, cs] = await Promise.all([
        client().rpc('team_board', { p_month: state.month }),
        client().rpc('can_set_sales_targets')
      ]);
      if (bd.error) throw bd.error;
      state.data = bd.data;
      state.canSet = !cs.error && cs.data === true;
      state.loaded = true; state.error = null; state.updatedAt = new Date();
    } catch (e) {
      console.error('team board load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the team board';
    } finally { state.loading = false; }
    render();
  }

  function paceInfo(rep, ms, phase, wd) {
    const target = rep.target == null ? null : Number(rep.target);
    const got = Number(rep.approved_v) || 0;
    if (target == null || target <= 0) return { target: null, pct: null, status: 'none' };
    const pct = got / target * 100;
    if (phase === 'past') return { target, pct, status: got >= target ? 'hit' : 'missed' };
    if (phase === 'future') return { target, pct, status: 'future', pace: 0 };
    const pace = target * (wd.total ? wd.done / wd.total : 0);
    const status = got >= target ? 'hit' : got >= pace * 1.05 ? 'ahead' : got >= pace * 0.85 ? 'on' : 'behind';
    return { target, pct, status, pace };
  }
  const STATUS = {
    hit:    { label: 'Target hit 🎉', color: '#22c55e' },
    ahead:  { label: 'Ahead of pace', color: '#22c55e' },
    on:     { label: 'On pace', color: '#38bdf8' },
    behind: { label: 'Behind pace', color: '#f59e0b' },
    missed: { label: 'Missed', color: '#f87171' },
    future: { label: 'Not started', color: '#94a3b8' },
    none:   { label: 'No target set', color: '#64748b' }
  };
  const MEDAL = ['🥇', '🥈', '🥉'];

  function chgChip(cur, prev) {
    cur = Number(cur) || 0; prev = Number(prev) || 0;
    if (!prev && !cur) return '';
    if (!prev) return '<span class="tb-chg up">new this month</span>';
    const p = Math.round((cur - prev) / prev * 100);
    if (p === 0) return '<span class="tb-chg">same as last month</span>';
    return `<span class="tb-chg ${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% on last month</span>`;
  }

  function barHtml(pct, pace, target, color) {
    const w = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    const marker = pace != null && target ? Math.max(0, Math.min(100, pace / target * 100)) : null;
    return `<div class="tb-bar" role="progressbar" aria-valuenow="${Math.round(w)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${w}%;background:${color}"></i>${marker != null ? `<b class="tb-pace" style="left:${marker}%" title="Where they would be by today to hit the target"></b>` : ''}</div>`;
  }

  function cardHtml(rep, rank, ms, phase, wd) {
    const p = paceInfo(rep, ms, phase, wd);
    const st = STATUS[p.status];
    const medal = rank < 3 && Number(rep.approved_v) > 0 ? MEDAL[rank] : '';
    const reach = p.target && (Number(rep.expected) > 0) && phase !== 'past'
      ? `<div class="tb-reach">If the open quotes land as expected: <b>${gbp(Number(rep.approved_v) + Number(rep.expected))}</b> (${Math.round((Number(rep.approved_v) + Number(rep.expected)) / p.target * 100)}% of target)</div>` : '';
    return `<article class="tb-card" style="--c:${st.color}">
      <header>${avatar(rep.rep)}<div class="tb-who"><b>${esc(rep.rep)} ${medal}</b><span style="color:${st.color}">${esc(st.label)}</span></div><div class="tb-rank">#${rank + 1}</div></header>
      <div class="tb-big">${gbp(rep.approved_v)}<small>${Number(rep.approved_n)} order${Number(rep.approved_n) === 1 ? '' : 's'} approved</small></div>
      ${p.target ? barHtml(p.pct, p.pace, p.target, st.color) + `<div class="tb-tline"><span>${Math.round(p.pct)}% of ${gbp(p.target)}</span>${p.status === 'hit' ? '' : `<span>${gbp(Math.max(0, p.target - Number(rep.approved_v)))} to go</span>`}</div>` : '<div class="tb-tline tb-dim"><span>No target set yet</span></div>'}
      ${chgChip(rep.approved_v, rep.prev_v)}
      <div class="tb-foot"><span>${Number(rep.open_n)} open quote${Number(rep.open_n) === 1 ? '' : 's'} · ${gbp(rep.open_v)}</span><span>${Number(rep.raised_n)} raised this month</span></div>
      ${reach}</article>`;
  }

  function render() {
    const body = $('tbBody'); if (!body) return;
    const sec = $(PAGE_ID);
    if (sec) sec.classList.toggle('tb-wall', state.wall);
    if (state.error) { body.innerHTML = `<div class="tb-empty">Couldn't load the team board: ${esc(state.error)}<br><button type="button" class="tb-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { body.innerHTML = '<div class="tb-empty">Loading…</div>'; return; }
    const ms = parseMonth(state.month), phase = monthPhase(ms), wd = workingDays(ms);
    const reps = (state.data.reps || []).slice().sort((a, b) => Number(b.approved_v) - Number(a.approved_v) || String(a.rep).localeCompare(String(b.rep)));
    const team = state.data.team || {};
    const teamTarget = team.target == null ? null : Number(team.target);
    // The team bar only counts people who have a target, so it compares like with like.
    const tGot = reps.filter(r => r.target != null).reduce((t, r) => t + Number(r.approved_v), 0);
    const tPct = teamTarget ? tGot / teamTarget * 100 : null;
    const tPace = teamTarget && phase === 'current' ? teamTarget * (wd.total ? wd.done / wd.total : 0) : null;
    const tStatus = !teamTarget ? 'none' : phase === 'past' ? (tGot >= teamTarget ? 'hit' : 'missed') : phase === 'future' ? 'future'
      : tGot >= teamTarget ? 'hit' : tGot >= tPace * 1.05 ? 'ahead' : tGot >= tPace * 0.85 ? 'on' : 'behind';
    const ts = STATUS[tStatus];
    const nowMonth = monthKey(new Date());
    body.innerHTML = `
      <div class="tb-bar-top">
        <div class="tb-month"><button type="button" class="tb-btn" data-step="-1" aria-label="Previous month">◀</button><b>${esc(monthName(ms))}</b><button type="button" class="tb-btn" data-step="1" aria-label="Next month"${state.month >= nowMonth ? ' disabled' : ''}>▶</button>${state.month !== nowMonth ? '<button type="button" class="tb-btn" data-thismonth="1">This month</button>' : ''}</div>
        <span class="tb-spacer"></span>
        ${state.canSet ? '<button type="button" class="tb-btn" data-targets="1">🎯 Set targets</button>' : ''}
        <button type="button" class="tb-btn tb-primary" data-wall="1">${state.wall ? '✕ Leave wall screen' : '🖥 Wall screen'}</button>
        <button type="button" class="tb-btn" data-reload="1" title="Refresh">${state.loading ? '…' : '⟳'}</button>
      </div>
      <section class="tb-team" style="--c:${ts.color}">
        <div><span class="tb-lbl">Whole team · ${esc(monthName(ms))}</span><div class="tb-teambig">${gbp(team.approved_v)}<small>${Number(team.approved_n)} orders approved${phase === 'current' ? ` · working day ${wd.done} of ${wd.total}` : ''}</small></div></div>
        <div class="tb-teamright">${teamTarget ? barHtml(tPct, tPace, teamTarget, ts.color) + `<div class="tb-tline"><span style="color:${ts.color}">${esc(ts.label)} · ${Math.round(tPct)}% of ${gbp(teamTarget)}</span>${tStatus === 'hit' ? '' : `<span>${gbp(Math.max(0, teamTarget - tGot))} to go</span>`}</div><div class="tb-tline tb-dim"><span>Target progress counts the people who have a target: ${gbp(tGot)} of ${gbp(teamTarget)}</span></div>` : '<div class="tb-tline tb-dim"><span>No targets set yet' + (state.canSet ? '. Press Set targets.' : '.') + '</span></div>'}
          ${chgChip(team.approved_v, team.prev_v)}</div>
      </section>
      <div class="tb-grid">${reps.map((r, i) => cardHtml(r, i, ms, phase, wd)).join('')}</div>
      <p class="tb-note">Sales means orders approved in the month, including orders keyed straight in. The small marker on a bar is where they would be by today to hit the target at an even pace across working days (Monday to Friday). ${state.updatedAt ? 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '.' : ''}</p>`;
  }

  // ---- setting targets (Daniel and Oliver) ----
  function closeTargets() { const m = $('tbModal'); if (m) m.remove(); document.removeEventListener('keydown', tgKeys, true); }
  function tgKeys(e) { if (e.key === 'Escape') { e.stopPropagation(); closeTargets(); } }
  function openTargets() {
    closeTargets();
    const ms = parseMonth(state.month);
    const reps = (state.data.reps || []).slice().sort((a, b) => String(a.rep).localeCompare(String(b.rep)));
    const m = document.createElement('div');
    m.id = 'tbModal'; m.className = 'tb-modal';
    m.innerHTML = `<div class="tb-modal-box" role="dialog" aria-modal="true" aria-labelledby="tbTgTitle">
      <h3 id="tbTgTitle">Targets from ${esc(monthName(ms))}</h3>
      <p class="tb-dim">A monthly target for orders approved. It applies from ${esc(monthName(ms))} until you set a new one, so there is no need to re-enter it every month. Leave a box empty to have no target from this month.</p>
      <form id="tbTgForm">${reps.map(r => `<label class="tb-row"><span>${esc(r.rep)}</span><span class="tb-pound">£<input type="number" min="0" max="10000000" step="50" inputmode="numeric" data-rep="${esc(r.rep)}" data-was="${r.target == null ? '' : Number(r.target)}" value="${r.target == null ? '' : Number(r.target)}" placeholder="no target"></span></label>`).join('')}
        <div class="tb-err" id="tbTgErr" role="alert" hidden></div>
        <div class="tb-btns"><span style="flex:1"></span><button type="button" class="tb-btn" id="tbTgCancel">Cancel</button><button type="submit" class="tb-btn tb-primary" id="tbTgGo">Save targets</button></div>
      </form></div>`;
    document.body.appendChild(m);
    document.addEventListener('keydown', tgKeys, true);
    m.addEventListener('click', e => { if (e.target === m) closeTargets(); });
    $('tbTgCancel').addEventListener('click', closeTargets);
    $('tbTgForm').addEventListener('submit', async e => {
      e.preventDefault();
      const go = $('tbTgGo'), err = $('tbTgErr');
      go.disabled = true; err.hidden = true;
      try {
        const inputs = Array.from(m.querySelectorAll('input[data-rep]'));
        for (const inp of inputs) {
          const was = inp.dataset.was, now = inp.value.trim();
          if (was === now) continue;
          const val = now === '' ? null : Number(now);
          if (val != null && (!isFinite(val) || val < 0)) throw new Error('Please enter a number for ' + inp.dataset.rep);
          const { error } = await client().rpc('set_sales_target', { p_rep: inp.dataset.rep, p_month: state.month, p_value: val });
          if (error) throw error;
        }
        closeTargets();
        await load(true);
      } catch (ex) {
        err.textContent = (ex && ex.message) || 'Could not save';
        err.hidden = false; go.disabled = false;
      }
    });
    const first = m.querySelector('input'); if (first) first.focus();
  }

  // ---- wall screen ----
  function setWall(on) {
    state.wall = on;
    const sec = $(PAGE_ID);
    if (on) { try { if (sec && sec.requestFullscreen) sec.requestFullscreen().catch(() => {}); } catch (e) { /* the overlay still works */ } }
    else if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
    schedule();
    render();
  }
  function schedule() {
    clearInterval(state.timer);
    const sec = $(PAGE_ID);
    state.timer = setInterval(() => { if (sec && sec.classList.contains('active') && !document.hidden) load(true); }, state.wall ? WALL_REFRESH_MS : REFRESH_MS);
  }

  function injectStyles() {
    if ($('tbStyles')) return;
    const s = document.createElement('style');
    s.id = 'tbStyles';
    s.textContent = `
#teamboard .tb-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(234,179,8,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(34,197,94,.13), transparent 60%), rgba(15,23,42,.55); }
#teamboard .tb-headbox h2 { margin:0 0 6px; font-size:28px; }
#teamboard .tb-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#teamboard .tb-bar-top { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:18px 0 14px; }
#teamboard .tb-month { display:flex; gap:8px; align-items:center; font-size:16px; }
#teamboard .tb-spacer { flex:1; }
#teamboard .tb-btn, .tb-modal .tb-btn { padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#teamboard .tb-btn:hover, .tb-modal .tb-btn:hover { background:rgba(255,255,255,.07); }
#teamboard .tb-btn:disabled, .tb-modal .tb-btn:disabled { opacity:.4; cursor:default; }
#teamboard .tb-primary, .tb-modal .tb-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#teamboard .tb-team { display:grid; grid-template-columns:minmax(220px,1fr) 2fr; gap:22px; align-items:center; padding:18px 22px; border-radius:16px; border:1px solid rgba(255,255,255,.1); border-left:5px solid var(--c); background:rgba(15,23,42,.6); margin-bottom:16px; }
#teamboard .tb-lbl { color:#94a3b8; font-size:13px; }
#teamboard .tb-teambig { font-size:38px; font-weight:800; line-height:1.1; font-variant-numeric:tabular-nums; }
#teamboard .tb-teambig small, #teamboard .tb-big small { display:block; font-size:13px; font-weight:500; color:#94a3b8; margin-top:2px; }
#teamboard .tb-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:14px; }
#teamboard .tb-card { padding:16px 18px; border-radius:16px; border:1px solid rgba(255,255,255,.09); border-top:4px solid var(--c); background:rgba(15,23,42,.6); display:grid; gap:10px; align-content:start; }
#teamboard .tb-card header { display:flex; align-items:center; gap:10px; }
#teamboard .tb-who { flex:1; min-width:0; display:grid; }
#teamboard .tb-who b { font-size:16px; }
#teamboard .tb-who span { font-size:12.5px; font-weight:600; }
#teamboard .tb-rank { color:#64748b; font-weight:700; font-size:13px; }
#teamboard .tb-av { flex:none; width:36px; height:36px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; color:#fff; }
#teamboard .tb-big { font-size:30px; font-weight:800; font-variant-numeric:tabular-nums; }
#teamboard .tb-bar { position:relative; height:12px; border-radius:999px; background:rgba(255,255,255,.1); overflow:visible; }
#teamboard .tb-bar i { display:block; height:100%; border-radius:999px; transition:width .6s ease; }
#teamboard .tb-pace { position:absolute; top:-4px; width:3px; height:20px; border-radius:2px; background:#e2e8f0; opacity:.85; transform:translateX(-1px); }
#teamboard .tb-tline { display:flex; justify-content:space-between; gap:8px; font-size:13px; color:#cbd5e1; }
#teamboard .tb-dim { color:#64748b; }
#teamboard .tb-chg { font-size:12px; color:#94a3b8; }
#teamboard .tb-chg.up { color:#4ade80; } #teamboard .tb-chg.down { color:#f87171; }
#teamboard .tb-foot { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:#94a3b8; padding-top:8px; border-top:1px solid rgba(255,255,255,.07); }
#teamboard .tb-reach { font-size:12px; color:#94a3b8; }
#teamboard .tb-reach b { color:#e2e8f0; }
#teamboard .tb-note { margin:16px 0 0; color:#64748b; font-size:12.5px; line-height:1.5; max-width:760px; }
#teamboard .tb-empty { padding:40px 12px; text-align:center; color:#94a3b8; }
#teamboard.tb-wall { position:fixed; inset:0; z-index:9000; overflow:auto; background:#050a18; padding:22px 30px; }
#teamboard.tb-wall .tb-headbox { display:none; }
#teamboard.tb-wall .tb-teambig { font-size:64px; }
#teamboard.tb-wall .tb-lbl { font-size:18px; }
#teamboard.tb-wall .tb-grid { grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:20px; }
#teamboard.tb-wall .tb-big { font-size:48px; }
#teamboard.tb-wall .tb-who b { font-size:24px; } #teamboard.tb-wall .tb-who span { font-size:16px; }
#teamboard.tb-wall .tb-av { width:52px; height:52px; font-size:18px; }
#teamboard.tb-wall .tb-tline, #teamboard.tb-wall .tb-foot, #teamboard.tb-wall .tb-chg, #teamboard.tb-wall .tb-reach { font-size:16px; }
#teamboard.tb-wall .tb-bar { height:18px; } #teamboard.tb-wall .tb-pace { height:28px; top:-5px; }
#teamboard.tb-wall .tb-note { display:none; }
#teamboard.tb-wall [data-targets], #teamboard.tb-wall [data-reload] { display:none; }
.tb-modal { position:fixed; inset:0; z-index:10050; background:rgba(2,6,23,.7); display:flex; align-items:center; justify-content:center; padding:16px; }
.tb-modal-box { width:min(460px,100%); max-height:92vh; overflow:auto; background:#0f172a; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); border-radius:14px; padding:18px 20px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
.tb-modal-box h3 { margin:0 0 4px; font-size:17px; }
.tb-modal-box p { margin:4px 0 10px; font-size:12.5px; line-height:1.5; }
.tb-modal-box .tb-dim { color:#94a3b8; }
.tb-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 0; font-size:14px; }
.tb-pound { display:flex; align-items:center; gap:4px; }
.tb-row input { width:130px; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#020617; color:#e2e8f0; font-size:14px; text-align:right; }
.tb-err { margin-top:8px; color:#fca5a5; font-size:12.5px; } .tb-err[hidden] { display:none; }
.tb-btns { display:flex; gap:8px; margin-top:14px; align-items:center; }
@media (max-width:720px) { #teamboard .tb-team { grid-template-columns:1fr; gap:12px; } #teamboard .tb-teambig { font-size:30px; } }`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchor = document.querySelector('.nav-link[data-page="today"]') || document.querySelector('.nav-link');
    const anyPage = document.querySelector('.dashboard-page');
    if (!anchor || !anyPage) return false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>🏆 Team board</span>';
    anchor.insertAdjacentElement(document.querySelector('.nav-link[data-page="today"]') ? 'afterend' : 'beforebegin', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="tb-headbox"><p class="eyebrow">Sales</p><h2>Team board</h2>
      <p>Orders approved this month for each salesperson against their target, ranked, with where they should be by today. Press Wall screen to put it on the office TV.</p></div>
      <div id="tbBody"><div class="tb-empty">Loading…</div></div>`;
    anyPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      state.month = monthKey(new Date());
      load(state.loaded);
      schedule();
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); state.wall = false; clearInterval(state.timer); sec.classList.remove('tb-wall'); }
    }, true);
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.wall) { state.wall = false; schedule(); render(); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.wall && !$('tbModal')) { setWall(false); } });

    sec.addEventListener('click', e => {
      const st = e.target.closest('[data-step]');
      if (st) { const d = parseMonth(state.month); d.setMonth(d.getMonth() + Number(st.dataset.step)); state.month = monthKey(d); load(); return; }
      if (e.target.closest('[data-thismonth]')) { state.month = monthKey(new Date()); load(); return; }
      if (e.target.closest('[data-targets]')) { openTargets(); return; }
      if (e.target.closest('[data-wall]')) { setWall(!state.wall); return; }
      if (e.target.closest('[data-reload]')) { load(); return; }
    });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage() && boot.tries < 100) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.TeamBoardPage = { reload: () => load(), state };
})();
