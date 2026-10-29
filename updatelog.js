// Update log tab: a timeline of every change made to ATAM GO (v1, v2, ...) and what is planned.
// The content lives in updatelog-data.js (window.ATAM_UPDATES / window.ATAM_PLANNED), so there is no database and nothing to load.
// Adds its own nav button and page (app.js binds the nav once, same as quotes.js / winback.js / calendar.js).
(function () {
  'use strict';

  const PAGE_ID = 'updatelog';
  const STATUS = {
    in_progress: { label: 'In progress',             color: '#e879f9' },
    live:        { label: 'Live',                    color: '#22c55e' },
    partly:      { label: 'Partly live',             color: '#f59e0b' },
    built:       { label: 'Built, waiting to go live', color: '#38bdf8' },
    rolled_back: { label: 'Rolled back',             color: '#ef4444' },
    planned:     { label: 'Planned',                 color: '#a78bfa' }
  };
  const SUSPECT_DAYS = 3;

  const state = { q: '', status: '', area: '', newest: true, around: '', open: {} };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = s => { const p = String(s).split('-'); return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0]; };
  const ms = s => { const p = String(s).split('-'); return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const updates = () => Array.isArray(window.ATAM_UPDATES) ? window.ATAM_UPDATES : [];
  const planned = () => Array.isArray(window.ATAM_PLANNED) ? window.ATAM_PLANNED : [];
  const vnum = u => Number(String(u.v).replace(/\D/g, '')) || 0;

  function isSuspect(u) {
    if (!state.around) return false;
    if (u.status === 'built' || u.status === 'planned' || u.status === 'in_progress') return false;
    const d = ms(u.date), a = ms(state.around);
    return d <= a && a - d <= SUSPECT_DAYS * 86400000;
  }
  function matches(u) {
    if (state.status && u.status !== state.status) return false;
    if (state.area && !(u.areas || []).includes(state.area)) return false;
    if (state.around && !isSuspect(u)) return false;
    if (state.q) {
      const hay = [u.v, u.title, u.summary, (u.areas || []).join(' '), (u.changes || []).join(' '), u.date].join(' ').toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  }

  function statsHtml() {
    const all = updates();
    const n = s => all.filter(u => u.status === s).length;
    const latest = all.slice().sort((a, b) => ms(b.date) - ms(a.date) || vnum(b) - vnum(a))[0];
    const tile = (num, label, color) => `<div class="ul-stat" style="--c:${color}"><b>${num}</b><span>${esc(label)}</span></div>`;
    return `<div class="ul-stats">${tile(all.length, 'Versions', '#e2e8f0')}${tile(n('in_progress'), 'In progress', STATUS.in_progress.color)}${tile(n('live'), 'Live', STATUS.live.color)}${tile(n('partly') + n('built'), 'Waiting to go live', STATUS.built.color)}${tile(planned().length, 'Planned', STATUS.planned.color)}${tile(latest ? latest.v : '–', latest ? 'Latest · ' + day(latest.date) : 'Latest', '#7dd3fc')}</div>`;
  }

  function controlsHtml() {
    const areas = Array.from(new Set(updates().concat(planned()).flatMap(u => u.areas || []))).sort();
    const chip = (k, v, label, on) => `<button type="button" class="ul-chip${on ? ' on' : ''}" data-${k}="${esc(v)}">${esc(label)}</button>`;
    return `<div class="ul-controls">
      <input type="search" id="ulSearch" value="${esc(state.q)}" placeholder="Search updates (e.g. quotes, security, invoices, v14)" aria-label="Search updates">
      <div class="ul-chips" aria-label="Status">${chip('status', '', 'All', !state.status)}${['in_progress', 'live', 'partly', 'built'].map(s => chip('status', s, STATUS[s].label, state.status === s)).join('')}</div>
      <div class="ul-chips" aria-label="Area">${chip('area', '', 'Every area', !state.area)}${areas.map(a => chip('area', a, a, state.area === a)).join('')}</div>
      <div class="ul-row"><button type="button" class="ul-chip" data-sort="1">${state.newest ? '↓ Newest first' : '↑ Oldest first'}</button>
        <label class="ul-find">🔎 Something broke? It started failing around <input type="date" id="ulAround" value="${esc(state.around)}"></label>
        ${state.around ? '<button type="button" class="ul-chip" data-clear-around="1">Clear</button>' : ''}</div>
      ${state.around ? '<p class="ul-note" id="ulFinder"></p>' : ''}</div>`;
  }

  // Progress bar and time taken. in_progress: a bar at u.progress %. built: a full blue bar (finished, waiting to go live).
  // live / partly: a full green "Completed" bar, with the time taken only if u.timeTaken was filled in.
  function progressHtml(u) {
    if (u.status === 'in_progress') {
      const p = Math.max(0, Math.min(100, Number(u.progress) || 0));
      return `<div class="ul-prog" style="--c:${STATUS.in_progress.color}"><div class="ul-bar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i class="ul-fill running" style="width:${p}%"></i></div><span>In progress · ${p}%</span></div>`;
    }
    if (u.status === 'built') return `<div class="ul-prog" style="--c:${STATUS.built.color}"><div class="ul-bar"><i class="ul-fill" style="width:100%"></i></div><span>Finished · waiting to go live</span></div>`;
    if ((u.status === 'live' || u.status === 'partly') && u.timeTaken) {
      return `<div class="ul-prog" style="--c:${STATUS.live.color}"><div class="ul-bar"><i class="ul-fill" style="width:100%"></i></div><span>${u.status === 'live' ? 'Completed' : 'Completed (part still to go live)'} · time taken <b>${esc(u.timeTaken)}</b></span></div>`;
    }
    return '';
  }

  function entryHtml(u, i) {
    const st = STATUS[u.status] || STATUS.live;
    const sus = isSuspect(u);
    const open = state.open[u.v] != null ? state.open[u.v] : (i === 0 && !state.around && !state.q && !state.status && !state.area && state.newest);
    return `<article class="ul-entry${sus ? ' suspect' : ''}" style="--c:${st.color};--d:${Math.min(i, 12) * 40}ms">
      <div class="ul-node"></div>
      <div class="ul-card">
        <header class="ul-head" data-toggle="${esc(u.v)}" role="button" tabindex="0" aria-expanded="${open}">
          <span class="ul-ver">${esc(u.v)}</span>
          <div class="ul-title"><b>${esc(u.title)}</b><span>${esc(day(u.date))}${sus ? ' · <em>possible cause</em>' : ''}</span></div>
          <span class="ul-status" style="--c:${st.color}">${esc(st.label)}</span>
          <span class="ul-caret" aria-hidden="true">${open ? '−' : '+'}</span>
        </header>
        <p class="ul-sum">${esc(u.summary)}</p>
        ${progressHtml(u)}
        <div class="ul-tags">${(u.areas || []).map(a => `<span class="ul-tag">${esc(a)}</span>`).join('')}</div>
        ${open ? `<div class="ul-body">
          <h5>What changed</h5><ul>${(u.changes || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul>
          ${u.watch ? `<h5>If something goes wrong</h5><p class="ul-watch">${esc(u.watch)}</p>` : ''}
        </div>` : ''}
      </div></article>`;
  }

  function plannedHtml() {
    const list = planned().filter(p => (!state.area || (p.areas || []).includes(state.area)) &&
      (!state.q || (p.title + ' ' + p.detail + ' ' + (p.areas || []).join(' ')).toLowerCase().includes(state.q)));
    if (state.status && state.status !== 'planned') return '';
    if (state.around || !list.length) return '';
    return `<section class="ul-planned"><h3>🛰 Coming up <span>${list.length}</span></h3><div class="ul-pgrid">${list.map(p => `<div class="ul-pitem"><b>${esc(p.title)}</b><p>${esc(p.detail)}</p><div class="ul-tags">${(p.areas || []).map(a => `<span class="ul-tag">${esc(a)}</span>`).join('')}</div></div>`).join('')}</div></section>`;
  }

  function render() {
    const el = $('ulBody');
    if (!el) return;
    let list = updates().filter(matches).sort((a, b) => (ms(b.date) - ms(a.date)) || (vnum(b) - vnum(a)));
    if (!state.newest) list = list.reverse();
    const keepSearch = document.activeElement && document.activeElement.id === 'ulSearch';
    el.innerHTML = statsHtml() + controlsHtml() + plannedHtml() +
      `<h3 class="ul-h">Timeline <span>${list.length} of ${updates().length}</span></h3>` +
      (list.length ? `<div class="ul-line">${list.map(entryHtml).join('')}</div>` : '<div class="ul-empty">No updates match. Clear a filter or the search.</div>') +
      '<p class="ul-foot">Every change to ATAM GO is added here as part of the same update. Changes made directly inside Xero, DecoNetwork or other systems by someone else are not tracked here.</p>';
    if (state.around) {
      const f = $('ulFinder');
      const sus = updates().filter(isSuspect).sort((a, b) => vnum(b) - vnum(a));
      if (f) f.innerHTML = sus.length
        ? `Updates that went live in the ${SUSPECT_DAYS} days up to ${esc(day(state.around))}: ${sus.map(u => '<b>' + esc(u.v) + '</b> ' + esc(u.title)).join(' · ')}. These are the first places to look, not proof.`
        : `Nothing from this log went live in the ${SUSPECT_DAYS} days up to ${esc(day(state.around))}, so the cause is probably outside it (Xero, DecoNetwork or the supplier).`;
    }
    if (keepSearch) { const s = $('ulSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  }



  // ───────────────────────── Automation health ─────────────────────────
  // Reads n8n_health_report() (sql/n8n_health_2026-10-29.sql) with the signed-in user's login. Failures come from the shared error
  // workflow (table n8n_failure_log); data freshness from data_freshness_report(). "Report to Oliver" posts to the Actions router
  // (action reportHealth), which emails Oliver the same picture and who pressed it.
  const hl = { data: null, loading: false, error: '', open: false, sending: false, sentAt: 0 };
  const hlWhen = d => { try { return new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  const hlClean = s => String(s == null ? '' : s).replace(/\s*\([^)]*(WF\d|sync|poster)[^)]*\)/g, '');

  async function loadHealth() {
    if (hl.loading) return;
    hl.loading = true;
    try {
      const r = await client().rpc('n8n_health_report');
      if (r.error) throw r.error;
      hl.data = r.data; hl.error = '';
    } catch (e) {
      console.error('health load failed', e);
      if (!hl.data) hl.error = 'Could not load the health check. Try again in a moment.';
    }
    hl.loading = false;
    renderHealth();
  }

  function healthHtml() {
    if (hl.error) return `<div class="ul-empty">${esc(hl.error)} <button type="button" class="ul-chip" data-hl="refresh">Try again</button></div>`;
    const d = hl.data;
    if (!d) return '<div class="ul-empty">Checking the automations…</div>';
    const score = Number(d.score) || 0;
    const tone = score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'bad';
    const wfs = Array.isArray(d.workflows) ? d.workflows : [];
    const bad = wfs.filter(w => w.status !== 'ok');
    const probs = (d.freshness && Array.isArray(d.freshness.problems)) ? d.freshness.problems : [];
    const recent = Array.isArray(d.recent_failures) ? d.recent_failures : [];
    const needs = score < 90 || bad.length || probs.length;
    const cool = Date.now() - hl.sentAt < 60000;
    const pill = w => `<li class="ul-hl-row ul-hl-${w.status}"><span class="ul-hl-dot"></span><div><b>${esc(w.name)}</b> <small>${esc(w.how_often || '')}</small><div class="ul-hl-what">${esc(w.what || '')}</div>${w.status !== 'ok' ? `<div class="ul-hl-err">${esc(w.failures_24h)} failure${Number(w.failures_24h) === 1 ? '' : 's'} in the last 24 hours. Last: ${esc(hlWhen(w.last_failure_at))}${w.failed_at_step ? ' at "' + esc(w.failed_at_step) + '"' : ''}. ${esc(w.last_error || '')}</div>` : ''}</div></li>`;
    return `<div class="ul-hl-top">
        <div class="ul-hl-score ul-hl-${tone}"><b>${score}</b><span>/100</span></div>
        <div class="ul-hl-sum"><h3>${esc(d.label || '')}</h3>
          <p>${bad.length ? esc(bad.length) + ' of ' + wfs.length + ' automations had a failure in the last 24 hours. ' : 'No automation has failed in the last 24 hours. '}${probs.length ? esc(probs.length) + ' data set' + (probs.length === 1 ? ' is' : 's are') + ' not updating when it should.' : 'All data sets are updating on time.'}</p>
          <p class="ul-hl-note">Checked ${esc(hlWhen(d.checked_at))}. Failures are counted from 29 Oct 2026, when this check started.</p></div>
        <div class="ul-hl-act">
          <button type="button" class="ul-chip" data-hl="refresh">Check again</button>
          <button type="button" class="ul-hl-report ${needs ? 'ul-hl-needs' : ''}" data-hl="report" ${hl.sending || cool ? 'disabled' : ''}>${hl.sending ? 'Sending…' : cool ? 'Sent to Oliver' : 'Report to Oliver'}</button>
        </div></div>
      ${probs.length ? `<div class="ul-hl-block"><h4>Data not updating</h4><ul class="ul-hl-list">${probs.map(p => `<li><b>${esc(p.what)}</b><div class="ul-hl-err">${esc(hlClean(p.detail))}</div></li>`).join('')}</ul></div>` : ''}
      ${recent.length ? `<div class="ul-hl-block"><h4>Latest failures</h4><ul class="ul-hl-list">${recent.map(f => `<li><b>${esc(f.workflow)}</b> <small>${esc(hlWhen(f.at))}</small><div class="ul-hl-err">${esc(f.step ? f.step + ': ' : '')}${esc(f.message)}</div></li>`).join('')}</ul></div>` : ''}
      <button type="button" class="ul-chip" data-hl="toggle">${hl.open ? '−' : '+'} All ${wfs.length} automations</button>
      ${hl.open ? `<ul class="ul-hl-list ul-hl-all">${wfs.slice().sort((a, b) => (a.status === 'ok') - (b.status === 'ok')).map(pill).join('')}</ul>` : ''}`;
  }

  const renderHealth = () => { const el = $('ulHealth'); if (el) el.innerHTML = healthHtml(); };

  async function reportHealth() {
    if (hl.sending) return;
    hl.sending = true; renderHealth();
    try {
      const url = (window.ATAM_GO_CONFIG && window.ATAM_GO_CONFIG.WEBHOOKS || {}).reportHealth;
      if (!url) throw new Error('not set up');
      const res = await fetch(url, { method: 'POST', headers: await window.atamGoWebhookHeaders(), body: JSON.stringify({ action: 'reportHealth', source: 'ATAM GO' }) });
      if (!res.ok) throw new Error('failed ' + res.status);
      hl.sentAt = Date.now();
      toast('Sent to Oliver.');
      setTimeout(renderHealth, 61000);
    } catch (e) {
      console.error('report failed', e);
      toast('Could not send that. Please try again, or tell Oliver directly.');
    }
    hl.sending = false; renderHealth();
  }

  // ───────────────────────── Suggestions ─────────────────────────
  // Anyone signed in can suggest an update and rate every suggestion from 1 (nice to have) to 5 (needed now).
  // Ranked by points: everyone's ratings added up. Data: view update_suggestions_board; writes only through the functions
  // suggest_update / rate_update_suggestion / withdraw_update_suggestion (sql/update_suggestions_2026-10-28.sql).
  // Whether a suggestion is open, planned, built or declined is changed by whoever builds the updates, in the database.
  const RATING = { 1: 'Nice to have', 2: 'Would help', 3: 'Important', 4: 'Very important', 5: 'Needed now' };
  const SG_STATUS = { planned: { label: 'Planned', color: '#a78bfa' }, built: { label: 'Built', color: '#22c55e' }, declined: { label: 'Not doing', color: '#94a3b8' } };
  const emptyDraft = () => ({ title: '', detail: '', area: '', importance: 0 });
  const sug = { rows: [], loaded: false, loading: false, error: '', formOpen: false, showDecided: false, busy: false, draft: emptyDraft() };

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  async function loadSug() {
    if (sug.loading) return;
    sug.loading = true;
    try {
      const res = await client().from('update_suggestions_board').select('*');
      if (res.error) throw res.error;
      sug.rows = res.data || []; sug.loaded = true; sug.error = '';
    } catch (e) {
      console.error('suggestions load failed', e);
      if (!sug.loaded) sug.error = 'Could not load the suggestions. Try again in a moment.';
    }
    sug.loading = false;
    renderSgList();
  }

  const sgOrder = (a, b) => b.points - a.points || Number(b.avg_importance || 0) - Number(a.avg_importance || 0) || String(b.created_at).localeCompare(String(a.created_at));

  function sgTopHtml() {
    const d = sug.draft;
    const areas = Array.from(new Set(updates().concat(planned()).flatMap(u => u.areas || []))).sort().concat(['Other']);
    const form = sug.formOpen ? `<div class="ul-sg-form">
        <label>What should we build or change?<input type="text" id="ulSgTitle" maxlength="120" value="${esc(d.title)}" placeholder="A short title, e.g. Show quote value on the Calendar"></label>
        <label>More detail (optional)<textarea id="ulSgDetail" maxlength="1000" rows="3" placeholder="What is the problem, and how would it help?">${esc(d.detail)}</textarea></label>
        <label>Which part of ATAM GO?<select id="ulSgArea"><option value="">Not sure</option>${areas.map(a => `<option value="${esc(a)}"${d.area === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
        <div class="ul-sg-imp"><span>How important is it?</span>
          <div class="ul-sg-rate big" role="group" aria-label="Importance">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="ul-sg-n${d.importance === n ? ' on' : ''}" data-sgimp="${n}" aria-pressed="${d.importance === n}">${n}</button>`).join('')}</div>
          <small>${d.importance ? esc(d.importance + ' · ' + RATING[d.importance]) : '1 is nice to have, 5 is needed now'}</small></div>
        <div class="ul-actions"><button type="button" class="ul-btn ul-sg-go" data-sg="submit"${sug.busy ? ' disabled' : ''}>${sug.busy ? 'Saving…' : 'Add to the list'}</button><button type="button" class="ul-btn" data-sg="close">Cancel</button></div>
      </div>` : '';
    return `<div class="ul-sg-head"><div><h3>💡 Suggest an update <span>and vote on what comes next</span></h3>
        <p>Add your idea, then rate every idea from 1 (nice to have) to 5 (needed now). The list is ranked by points, which is everyone's ratings added up.</p></div>
      ${sug.formOpen ? '' : '<button type="button" class="ul-btn ul-sg-go" data-sg="open">+ Suggest an update</button>'}</div>${form}`;
  }

  function rateButtons(s) {
    return `<div class="ul-sg-rate" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="ul-sg-n${s.my_rating === n ? ' on' : ''}" data-rate="${esc(s.id)}" data-n="${n}" title="${esc(RATING[n])}" aria-pressed="${s.my_rating === n}">${n}</button>`).join('')}</div>`;
  }

  function sgCardHtml(s, rank, decided) {
    const st = SG_STATUS[s.status];
    return `<article class="ul-sg-card${decided ? ' decided' : ''}">
      ${decided ? '' : `<div class="ul-sg-rank">#${rank}</div>`}
      <div class="ul-sg-main"><b>${esc(s.title)}</b>${st ? ` <span class="ul-status" style="--c:${st.color}">${esc(st.label)}</span>` : ''}
        ${s.detail ? `<p>${esc(s.detail)}</p>` : ''}
        <div class="ul-tags">${s.area ? `<span class="ul-tag">${esc(s.area)}</span>` : ''}<span class="ul-sg-by">Suggested by ${esc(s.suggested_by_name || 'someone')} · ${esc(day(String(s.created_at).slice(0, 10)))}</span></div></div>
      <div class="ul-sg-score"><b>${esc(s.points)}</b><span>points</span><small>${s.votes ? 'avg ' + esc(Number(s.avg_importance).toFixed(1)) + ' · ' + esc(s.votes) + ' rated' : 'not rated yet'}</small></div>
      ${decided ? '' : `<div class="ul-sg-vote"><span>${s.my_rating ? 'Your rating: ' + esc(RATING[s.my_rating]) : 'Your rating'}</span>${rateButtons(s)}
        ${s.mine ? `<button type="button" class="ul-sg-link" data-withdraw="${esc(s.id)}">Take my suggestion back</button>` : ''}</div>`}
    </article>`;
  }

  function sgListHtml() {
    if (sug.error) return `<div class="ul-empty">${esc(sug.error)}</div>`;
    if (!sug.loaded) return '<div class="ul-empty">Loading suggestions…</div>';
    const open = sug.rows.filter(r => r.status === 'open').sort(sgOrder);
    const decided = sug.rows.filter(r => r.status !== 'open').sort(sgOrder);
    return (open.length ? open.map((r, i) => sgCardHtml(r, i + 1, false)).join('') : '<div class="ul-empty">No suggestions yet. Be the first to add one.</div>') +
      (decided.length ? `<button type="button" class="ul-chip ul-sg-dtoggle" data-sg="decided">${sug.showDecided ? '−' : '+'} Already decided (${decided.length})</button>${sug.showDecided ? decided.map(r => sgCardHtml(r, 0, true)).join('') : ''}` : '');
  }

  const renderSgTop = () => { const el = $('ulSgTop'); if (el) el.innerHTML = sgTopHtml(); };
  const renderSgList = () => { const el = $('ulSgList'); if (el) el.innerHTML = sgListHtml(); };

  async function submitSug() {
    const d = sug.draft, title = d.title.trim();
    if (title.length < 3) { toast('Give the suggestion a short title first.'); return; }
    if (!d.importance) { toast('Choose how important it is, from 1 to 5.'); return; }
    if (sug.busy) return;
    sug.busy = true; renderSgTop();
    try {
      const r = await client().rpc('suggest_update', { p_title: title, p_detail: d.detail.trim(), p_area: d.area, p_importance: d.importance });
      if (r.error) throw r.error;
      sug.draft = emptyDraft(); sug.formOpen = false;
      toast('Thanks, your suggestion is on the list.');
    } catch (e) {
      console.error('suggest failed', e);
      toast('Could not save that. Please try again.');
    }
    sug.busy = false; renderSgTop(); loadSug();
  }

  async function rateSug(id, n) {
    const row = sug.rows.find(r => r.id === id);
    if (!row || sug.busy) return;
    const val = row.my_rating === n ? null : n;
    const old = row.my_rating || 0;
    row.points += (val || 0) - old; row.votes += (val ? 1 : 0) - (old ? 1 : 0); row.my_rating = val;
    row.avg_importance = row.votes ? row.points / row.votes : null;
    renderSgList();
    sug.busy = true;
    try {
      const r = await client().rpc('rate_update_suggestion', { p_id: id, p_importance: val });
      if (r.error) throw r.error;
    } catch (e) {
      console.error('rate failed', e);
      toast('Could not save your rating. Please try again.');
    }
    sug.busy = false; loadSug();
  }

  async function withdrawSug(id) {
    if (sug.busy || !window.confirm('Take this suggestion back? It will be removed from the list.')) return;
    sug.busy = true;
    try {
      const r = await client().rpc('withdraw_update_suggestion', { p_id: id });
      if (r.error) throw r.error;
      toast('Your suggestion has been removed.');
    } catch (e) {
      console.error('withdraw failed', e);
      toast('Could not remove it. Please try again.');
    }
    sug.busy = false; loadSug();
  }

  function injectStyles() {
    if ($('ulStyles')) return;
    const s = document.createElement('style');
    s.id = 'ulStyles';
    s.textContent = `
#updatelog { --ul-line: rgba(255,255,255,.1); color:#e2e8f0; }
#updatelog .ul-hero { position:relative; overflow:hidden; padding:26px 26px; border-radius:18px; border:1px solid rgba(125,211,252,.25); background:radial-gradient(120% 160% at 0% 0%, rgba(56,189,248,.2), transparent 55%), radial-gradient(90% 140% at 100% 0%, rgba(167,139,250,.2), transparent 60%), rgba(8,12,24,.8); }
#updatelog .ul-hero::after { content:""; position:absolute; inset:0; background:repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 4px); pointer-events:none; }
#updatelog .ul-hero h2 { margin:0 0 6px; font-size:30px; letter-spacing:.01em; }
#updatelog .ul-hero p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#updatelog .ul-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:18px 0; }
#updatelog .ul-stat { padding:14px 16px; border-radius:14px; border:1px solid color-mix(in srgb, var(--c) 40%, transparent); background:linear-gradient(160deg, color-mix(in srgb, var(--c) 14%, #0b1222), #0b1222); box-shadow:0 0 22px -12px var(--c); }
#updatelog .ul-stat b { display:block; font-size:26px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--c); }
#updatelog .ul-stat span { font-size:12px; color:#94a3b8; }
#updatelog .ul-controls { display:flex; flex-direction:column; gap:10px; margin-bottom:18px; }
#updatelog input[type=search], #updatelog input[type=date] { padding:9px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:#0b1222; color:#e2e8f0; font-size:13.5px; }
#updatelog .ul-chips, #updatelog .ul-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
#updatelog .ul-chip { padding:6px 12px; border-radius:20px; border:1px solid rgba(255,255,255,.14); background:#0b1222; color:#cbd5e1; font-size:12.5px; cursor:pointer; }
#updatelog .ul-chip.on { border-color:#38bdf8; background:rgba(56,189,248,.16); color:#e0f2fe; }
#updatelog .ul-find { display:inline-flex; gap:8px; align-items:center; color:#cbd5e1; font-size:13px; flex-wrap:wrap; }
#updatelog .ul-note { margin:0; padding:10px 14px; border-radius:10px; border:1px solid rgba(251,146,60,.4); background:rgba(251,146,60,.08); color:#fed7aa; font-size:13px; line-height:1.5; }
#updatelog .ul-h { margin:22px 0 12px; font-size:15px; letter-spacing:.06em; text-transform:uppercase; color:#94a3b8; }
#updatelog .ul-h span, #updatelog .ul-planned h3 span { margin-left:8px; font-size:12px; padding:2px 8px; border-radius:10px; background:rgba(255,255,255,.08); color:#cbd5e1; text-transform:none; letter-spacing:0; }
#updatelog .ul-planned { margin:6px 0 10px; padding:16px; border-radius:16px; border:1px dashed rgba(167,139,250,.5); background:rgba(167,139,250,.05); }
#updatelog .ul-planned h3 { margin:0 0 12px; font-size:15px; color:#ddd6fe; }
#updatelog .ul-pgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:10px; }
#updatelog .ul-pitem { padding:12px 14px; border-radius:12px; background:#0b1222; border:1px solid rgba(167,139,250,.25); }
#updatelog .ul-pitem b { font-size:13.5px; }
#updatelog .ul-pitem p { margin:6px 0 8px; font-size:12.5px; color:#94a3b8; line-height:1.45; }
#updatelog .ul-line { position:relative; padding-left:34px; }
#updatelog .ul-line::before { content:""; position:absolute; left:11px; top:6px; bottom:6px; width:2px; background:linear-gradient(180deg, #38bdf8, #a78bfa 60%, rgba(167,139,250,.1)); box-shadow:0 0 10px rgba(56,189,248,.5); }
#updatelog .ul-entry { position:relative; margin-bottom:14px; animation:ulIn .45s both; animation-delay:var(--d,0ms); }
@keyframes ulIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) { #updatelog .ul-entry { animation:none; } #updatelog .ul-entry.suspect .ul-card { animation:none; } }
#updatelog .ul-node { position:absolute; left:-30px; top:18px; width:14px; height:14px; border-radius:50%; background:var(--c); box-shadow:0 0 0 4px rgba(11,18,34,.9), 0 0 14px var(--c); }
#updatelog .ul-card { padding:14px 16px; border-radius:14px; border:1px solid color-mix(in srgb, var(--c) 30%, rgba(255,255,255,.08)); background:linear-gradient(160deg, rgba(15,23,42,.92), rgba(8,12,24,.92)); }
#updatelog .ul-entry.suspect .ul-card { border-color:#fb923c; animation:ulPulse 2s ease-in-out infinite; }
@keyframes ulPulse { 0%,100% { box-shadow:0 0 0 0 rgba(251,146,60,.0); } 50% { box-shadow:0 0 22px 2px rgba(251,146,60,.35); } }
#updatelog .ul-head { display:flex; align-items:center; gap:12px; cursor:pointer; flex-wrap:wrap; }
#updatelog .ul-ver { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:700; font-size:15px; padding:4px 10px; border-radius:8px; background:color-mix(in srgb, var(--c) 18%, #0b1222); border:1px solid color-mix(in srgb, var(--c) 55%, transparent); color:var(--c); }
#updatelog .ul-title { flex:1 1 220px; min-width:0; }
#updatelog .ul-title b { display:block; font-size:15px; overflow-wrap:anywhere; }
#updatelog .ul-title span { font-size:12px; color:#94a3b8; }
#updatelog .ul-title em { color:#fb923c; font-style:normal; font-weight:600; }
#updatelog .ul-status { padding:3px 10px; border-radius:12px; font-size:11.5px; color:var(--c); border:1px solid color-mix(in srgb, var(--c) 55%, transparent); background:color-mix(in srgb, var(--c) 12%, transparent); white-space:nowrap; }
#updatelog .ul-caret { color:#64748b; font-size:18px; width:18px; text-align:center; }
#updatelog .ul-sum { margin:10px 0 8px; color:#cbd5e1; font-size:13.5px; line-height:1.5; }
#updatelog .ul-prog { display:flex; align-items:center; gap:12px; margin:0 0 10px; flex-wrap:wrap; }
#updatelog .ul-prog span { font-size:12px; color:#cbd5e1; } #updatelog .ul-prog b { color:var(--c); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
#updatelog .ul-bar { flex:1 1 180px; height:8px; border-radius:6px; background:rgba(255,255,255,.08); overflow:hidden; }
#updatelog .ul-fill { display:block; height:100%; border-radius:6px; background:linear-gradient(90deg, color-mix(in srgb, var(--c) 60%, #0b1222), var(--c)); box-shadow:0 0 10px var(--c); }
#updatelog .ul-fill.running { background-size:200% 100%; animation:ulRun 1.6s linear infinite; background-image:linear-gradient(90deg, var(--c), #fff3, var(--c)); }
@keyframes ulRun { from { background-position:200% 0; } to { background-position:0 0; } }
@media (prefers-reduced-motion: reduce) { #updatelog .ul-fill.running { animation:none; } }
#updatelog .ul-tags { display:flex; flex-wrap:wrap; gap:6px; }
#updatelog .ul-tag { padding:2px 9px; border-radius:10px; font-size:11px; color:#94a3b8; border:1px solid rgba(255,255,255,.12); }
#updatelog .ul-body { margin-top:12px; padding-top:10px; border-top:1px solid var(--ul-line); }
#updatelog .ul-body h5 { margin:12px 0 6px; font-size:11.5px; letter-spacing:.07em; text-transform:uppercase; color:#7dd3fc; }
#updatelog .ul-body ul { margin:0; padding-left:20px; color:#cbd5e1; font-size:13px; line-height:1.55; }
#updatelog .ul-watch { margin:0; padding:10px 12px; border-radius:10px; background:rgba(251,146,60,.08); border-left:3px solid #fb923c; color:#fed7aa; font-size:13px; line-height:1.5; }
#updatelog .ul-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
#updatelog .ul-btn { padding:7px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0b1222; color:#e2e8f0; font-size:12.5px; cursor:pointer; text-decoration:none; }
#updatelog .ul-btn:hover { border-color:#38bdf8; }
#updatelog .ul-empty { padding:30px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:12px; }
#updatelog .ul-foot { margin-top:20px; color:#64748b; font-size:12px; max-width:760px; line-height:1.5; }
#updatelog .ul-hl-wrap { margin:18px 0 6px; padding:18px; border-radius:16px; border:1px solid rgba(56,189,248,.3); background:rgba(8,12,24,.6); }
#updatelog .ul-hl-wrap > h3 { margin:0 0 10px; font-size:16px; }
#updatelog .ul-hl-top { display:flex; gap:18px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
#updatelog .ul-hl-score { min-width:96px; text-align:center; padding:10px 12px; border-radius:14px; border:2px solid; }
#updatelog .ul-hl-score b { font-size:34px; line-height:1; } #updatelog .ul-hl-score span { color:#94a3b8; font-size:13px; }
#updatelog .ul-hl-score.ul-hl-ok { border-color:#22c55e; color:#22c55e; } #updatelog .ul-hl-score.ul-hl-warn { border-color:#f59e0b; color:#f59e0b; } #updatelog .ul-hl-score.ul-hl-bad { border-color:#ef4444; color:#ef4444; }
#updatelog .ul-hl-sum { flex:1 1 260px; } #updatelog .ul-hl-sum h3 { margin:0 0 4px; } #updatelog .ul-hl-sum p { margin:0 0 4px; color:#cbd5e1; font-size:13.5px; } #updatelog .ul-hl-sum .ul-hl-note { color:#94a3b8; font-size:12px; }
#updatelog .ul-hl-act { display:flex; gap:8px; flex-wrap:wrap; }
#updatelog .ul-hl-report { padding:9px 16px; border-radius:10px; border:1px solid rgba(148,163,184,.4); background:rgba(148,163,184,.12); color:#e2e8f0; font-weight:600; cursor:pointer; }
#updatelog .ul-hl-report.ul-hl-needs { background:#ef4444; border-color:#ef4444; color:#fff; }
#updatelog .ul-hl-report:disabled { opacity:.6; cursor:default; }
#updatelog .ul-hl-block h4 { margin:10px 0 4px; font-size:13px; color:#fbbf24; }
#updatelog .ul-hl-list { list-style:none; margin:6px 0; padding:0; display:grid; gap:6px; font-size:13px; }
#updatelog .ul-hl-list small { color:#94a3b8; } #updatelog .ul-hl-err { color:#fca5a5; font-size:12.5px; margin-top:2px; word-break:break-word; } #updatelog .ul-hl-what { color:#94a3b8; font-size:12.5px; }
#updatelog .ul-hl-row { display:flex; gap:10px; align-items:flex-start; } #updatelog .ul-hl-dot { width:10px; height:10px; border-radius:50%; margin-top:5px; background:#22c55e; flex:none; }
#updatelog .ul-hl-row.ul-hl-warning .ul-hl-dot { background:#f59e0b; } #updatelog .ul-hl-row.ul-hl-failing .ul-hl-dot { background:#ef4444; }
#updatelog .ul-sg-wrap { margin:18px 0 6px; padding:18px; border-radius:16px; border:1px solid rgba(251,146,60,.35); background:linear-gradient(160deg, rgba(251,146,60,.07), rgba(56,189,248,.05)); }
#updatelog .ul-sg-head { display:flex; gap:14px; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; }
#updatelog .ul-sg-head h3 { margin:0 0 4px; font-size:16px; color:#fed7aa; }
#updatelog .ul-sg-head h3 span { font-size:12.5px; font-weight:400; color:#94a3b8; margin-left:6px; }
#updatelog .ul-sg-head p { margin:0; color:#94a3b8; font-size:13px; line-height:1.5; max-width:640px; }
#updatelog .ul-sg-go { border-color:#fb923c; background:rgba(251,146,60,.14); color:#ffedd5; }
#updatelog .ul-sg-go:disabled { opacity:.6; cursor:default; }
#updatelog .ul-sg-form { display:grid; gap:12px; margin-top:14px; padding:16px; border-radius:12px; background:rgba(8,12,24,.7); border:1px solid rgba(255,255,255,.1); }
#updatelog .ul-sg-form label { display:grid; gap:5px; font-size:12.5px; color:#cbd5e1; }
#updatelog .ul-sg-form input, #updatelog .ul-sg-form textarea, #updatelog .ul-sg-form select { padding:9px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:#0b1222; color:#e2e8f0; font-size:13.5px; font-family:inherit; }
#updatelog .ul-sg-form textarea { resize:vertical; }
#updatelog .ul-sg-imp { display:flex; gap:12px; align-items:center; flex-wrap:wrap; font-size:12.5px; color:#cbd5e1; }
#updatelog .ul-sg-imp small, #updatelog .ul-sg-vote small { color:#94a3b8; font-size:12px; }
#updatelog .ul-sg-rate { display:flex; gap:5px; }
#updatelog .ul-sg-n { width:30px; height:30px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0b1222; color:#cbd5e1; font-size:13px; cursor:pointer; transition:transform .25s cubic-bezier(.34,1.3,.64,1), background .2s, border-color .2s; }
#updatelog .ul-sg-rate.big .ul-sg-n { width:38px; height:38px; font-size:15px; }
#updatelog .ul-sg-n:hover { border-color:#fb923c; transform:translateY(-2px); }
#updatelog .ul-sg-n.on { background:rgba(251,146,60,.25); border-color:#fb923c; color:#fff; font-weight:700; }
#updatelog #ulSgList { display:grid; gap:10px; margin-top:14px; }
#updatelog .ul-sg-card { display:grid; grid-template-columns:44px 1fr auto auto; gap:14px; align-items:center; padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:linear-gradient(160deg, rgba(15,23,42,.92), rgba(8,12,24,.92)); }
#updatelog .ul-sg-card.decided { opacity:.75; grid-template-columns:1fr auto; }
#updatelog .ul-sg-rank { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:18px; font-weight:700; color:#fb923c; }
#updatelog .ul-sg-main b { font-size:14.5px; overflow-wrap:anywhere; }
#updatelog .ul-sg-main p { margin:5px 0 8px; color:#94a3b8; font-size:13px; line-height:1.45; overflow-wrap:anywhere; white-space:pre-line; }
#updatelog .ul-sg-by { font-size:11.5px; color:#64748b; align-self:center; }
#updatelog .ul-sg-score { text-align:center; min-width:84px; }
#updatelog .ul-sg-score b { display:block; font-size:24px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:#fed7aa; line-height:1.1; }
#updatelog .ul-sg-score span { font-size:11px; color:#94a3b8; display:block; }
#updatelog .ul-sg-score small { font-size:11px; color:#64748b; }
#updatelog .ul-sg-vote { display:grid; gap:6px; justify-items:start; font-size:12px; color:#94a3b8; }
#updatelog .ul-sg-link { background:none; border:none; padding:0; color:#64748b; font-size:11.5px; text-decoration:underline; cursor:pointer; }
#updatelog .ul-sg-dtoggle { justify-self:start; }
@media (max-width: 760px) { #updatelog .ul-sg-card { grid-template-columns:36px 1fr; } #updatelog .ul-sg-score, #updatelog .ul-sg-vote { grid-column:2; justify-items:start; text-align:left; } #updatelog .ul-sg-card.decided { grid-template-columns:1fr; } }
.ul-toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); padding:10px 16px; border-radius:10px; background:#0f172a; border:1px solid rgba(34,197,94,.5); color:#dcfce7; font-size:13px; z-index:2000; }
@media (max-width: 640px) { #updatelog .ul-line { padding-left:28px; } #updatelog .ul-node { left:-26px; } #updatelog .ul-hero h2 { font-size:24px; } }
`;
    document.head.appendChild(s);
  }

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'ul-toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }
  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="calendar"]') || document.querySelector('.nav-link[data-page="newcustomers"]') || document.querySelector('.nav-link[data-page="winback"]');
    const anchorPage = $('calendar') || $('newcustomers') || $('winback');
    if (!anchorBtn || !anchorPage) return false;
    if (!document.querySelector('.nav-link[data-page="calendar"]') && boot.tries < 30) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>🛰 Update log</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="ul-hero"><p class="eyebrow">ATAM GO</p><h2>Update log</h2>
      <p>Every change we have made, in order, and what is coming next. If something stops working, find roughly when it started and look at what changed just before. You can also suggest what we build next and vote on it.</p></div>
      <section class="ul-hl-wrap" aria-label="Automation health"><h3>🩺 Automation health</h3><div id="ulHealth"></div></section>
      <section class="ul-sg-wrap" aria-label="Suggestions"><div id="ulSgTop"></div><div id="ulSgList"></div></section><div id="ulBody"></div>`;
    anchorPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
      renderSgTop(); renderSgList(); loadSug();
      renderHealth(); loadHealth();
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); }
    }, true);

    sec.addEventListener('click', e => {
      const hb = e.target.closest('[data-hl]');
      if (hb) { const a = hb.dataset.hl; if (a === 'refresh') { hl.error = ''; loadHealth(); } else if (a === 'report') reportHealth(); else if (a === 'toggle') { hl.open = !hl.open; renderHealth(); } return; }
      const sg = e.target.closest('[data-sg]');
      if (sg) {
        const a = sg.dataset.sg;
        if (a === 'open') { sug.formOpen = true; renderSgTop(); const t = $('ulSgTitle'); if (t) t.focus(); }
        else if (a === 'close') { sug.formOpen = false; renderSgTop(); }
        else if (a === 'submit') submitSug();
        else if (a === 'decided') { sug.showDecided = !sug.showDecided; renderSgList(); }
        return;
      }
      const imp = e.target.closest('[data-sgimp]'); if (imp) { sug.draft.importance = Number(imp.dataset.sgimp); renderSgTop(); return; }
      const rt = e.target.closest('[data-rate]'); if (rt) { rateSug(rt.dataset.rate, Number(rt.dataset.n)); return; }
      const wd = e.target.closest('[data-withdraw]'); if (wd) { withdrawSug(wd.dataset.withdraw); return; }
      const st = e.target.closest('[data-status]'); if (st) { state.status = st.dataset.status; render(); return; }
      const ar = e.target.closest('[data-area]'); if (ar) { state.area = ar.dataset.area; render(); return; }
      if (e.target.closest('[data-sort]')) { state.newest = !state.newest; render(); return; }
      if (e.target.closest('[data-clear-around]')) { state.around = ''; render(); return; }
      const tg = e.target.closest('[data-toggle]');
      if (tg) { const v = tg.dataset.toggle; const cur = tg.getAttribute('aria-expanded') === 'true'; state.open[v] = !cur; render(); }
    });
    sec.addEventListener('keydown', e => {
      const tg = e.target.closest && e.target.closest('[data-toggle]');
      if (tg && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tg.click(); }
    });
    sec.addEventListener('input', e => {
      if (e.target.id === 'ulSearch') { state.q = e.target.value.trim().toLowerCase(); render(); }
      else if (e.target.id === 'ulSgTitle') sug.draft.title = e.target.value;
      else if (e.target.id === 'ulSgDetail') sug.draft.detail = e.target.value;
    });
    sec.addEventListener('change', e => {
      if (e.target.id === 'ulAround') { state.around = e.target.value; render(); }
      else if (e.target.id === 'ulSgArea') sug.draft.area = e.target.value;
    });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.UpdateLogPage = { render, state };
})();
