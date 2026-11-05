// Job profit tab: revenue, garment cost and estimated production time for orders shipped in a period, from DecoNetwork's own order data.
// Data: database function job_profit(from, to) over job_orders / job_lines (sql/job_profit_2026-11-03.sql), filled by the production capture workflow (WF1).
//   Revenue        order item amount, ex VAT, garments plus decoration (shipping left out).
//   Garment cost   each size's cost as set in DecoNetwork times the quantity. Lines DecoNetwork has no cost for are counted as zero and flagged with a "?".
//   Production     pieces x minutes per item + stitches / stitches per minute (settings). Turned into money only once a cost per hour is entered by Daniel or Oliver.
// Nothing is guessed that is not shown: until a cost per hour is set the page shows profit after garments only.
// Adds its own nav button (after Cash) and page, like quotes.js / calendar.js.
(function () {
  'use strict';

  const PAGE_ID = 'jobprofit';
  const RANGES = [{ key: '30', label: 'Last 30 days', days: 30 }, { key: '60', label: 'Last 60 days', days: 60 }, { key: '90', label: 'Last 90 days', days: 90 }];
  const state = { range: '30', data: null, canSet: false, loaded: false, loading: false, error: null, sort: { key: 'pct', dir: 1 }, showAll: false, editing: false };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v) || 0;
  const gbp = n => (num(n) < 0 ? '-' : '') + '£' + Math.abs(Math.round(num(n))).toLocaleString('en-GB');
  const pct = (a, b) => (num(b) > 0 ? Math.round(num(a) / num(b) * 100) + '%' : '—');
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dShort = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  const hours = mins => (num(mins) / 60).toLocaleString('en-GB', { maximumFractionDigits: 1 });

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; render(); }
    try {
      const days = (RANGES.find(r => r.key === state.range) || RANGES[0]).days;
      const to = new Date(), from = new Date(Date.now() - (days - 1) * 86400000);
      const [jp, cs] = await Promise.all([client().rpc('job_profit', { p_from: ymd(from), p_to: ymd(to) }), client().rpc('can_set_sales_targets')]);
      if (jp.error) throw jp.error;
      state.data = jp.data; state.canSet = !cs.error && cs.data === true;
      state.loaded = true; state.error = null;
    } catch (e) {
      console.error('job profit failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load job profit';
    } finally { state.loading = false; }
    render();
  }

  function enrich(j, costPerHour) {
    const rev = num(j.revenue), gc = num(j.garment_cost);
    const mg = rev - gc;
    const prod = costPerHour == null ? null : num(j.prod_cost);
    const mp = prod == null ? null : mg - prod;
    return Object.assign({}, j, { rev, gc, mg, mgPct: rev > 0 ? mg / rev : null, prod, mp, mpPct: mp == null || rev <= 0 ? null : mp / rev, noCost: num(j.lines_no_cost) > 0 });
  }

  function group(jobs, keyFn, label) {
    const m = new Map();
    jobs.forEach(j => { const k = keyFn(j) || label; const g = m.get(k) || { k, n: 0, rev: 0, gc: 0, prod: 0, mins: 0, hasProd: false }; g.n++; g.rev += j.rev; g.gc += j.gc; g.mins += num(j.prod_minutes); if (j.prod != null) { g.prod += j.prod; g.hasProd = true; } m.set(k, g); });
    return Array.from(m.values());
  }

  function render() {
    const body = $('jpBody'); if (!body) return;
    if (state.error) { body.innerHTML = `<div class="jp-empty">Couldn't load job profit: ${esc(state.error)}<br><button type="button" class="jp-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { body.innerHTML = '<div class="jp-empty">Working it out…</div>'; return; }
    const d = state.data, st = d.settings || {}, cph = st.cost_per_hour == null ? null : num(st.cost_per_hour);
    const jobs = (d.jobs || []).map(j => enrich(j, cph));
    const cov = d.coverage || {};
    const tot = jobs.reduce((t, j) => { t.rev += j.rev; t.gc += j.gc; t.stitches += num(j.stitches); t.mins += num(j.prod_minutes); t.pieces += num(j.pieces); if (j.prod != null) t.prod += j.prod; return t; }, { rev: 0, gc: 0, stitches: 0, mins: 0, pieces: 0, prod: 0 });
    const mg = tot.rev - tot.gc, mp = cph == null ? null : mg - tot.prod;
    const k = state.sort.key, dir = state.sort.dir;
    const val = j => k === 'rev' ? j.rev : k === 'mg' ? j.mg : k === 'stitches' ? num(j.stitches) : k === 'date' ? new Date(j.shipped).getTime() : k === 'cust' ? String(j.customer || '') : (cph == null ? (j.mgPct == null ? 9 : j.mgPct) : (j.mpPct == null ? 9 : j.mpPct));
    const sorted = jobs.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const shown = state.showAll ? sorted : sorted.slice(0, 25);
    const byRep = group(jobs, j => j.rep, 'Unassigned').sort((a, b) => b.rev - a.rev);
    const byCust = group(jobs, j => j.customer, 'Unknown').sort((a, b) => b.rev - a.rev).slice(0, 10);
    const th = (key, label, right) => `<th data-sort="${key}" class="${right ? 'r' : ''}${state.sort.key === key ? ' sorted' : ''}">${esc(label)}${state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const marginCell = (m, p) => `<span class="${m < 0 ? 'jp-neg' : p != null && p < 0.2 ? 'jp-low' : ''}">${esc(gbp(m))}${p != null ? ` <i>${Math.round(p * 100)}%</i>` : ''}</span>`;
    const groupTable = (title, rows) => `<div class="jp-half"><h4>${esc(title)}</h4><table class="jp-table"><thead><tr><th></th><th class="r">Jobs</th><th class="r">Revenue</th><th class="r">After garments</th>${cph == null ? '' : '<th class="r">After production</th>'}</tr></thead><tbody>${rows.map(g => { const m1 = g.rev - g.gc, m2 = m1 - g.prod; return `<tr><td>${esc(g.k)}</td><td class="r">${g.n}</td><td class="r">${esc(gbp(g.rev))}</td><td class="r">${marginCell(m1, g.rev > 0 ? m1 / g.rev : null)}</td>${cph == null ? '' : `<td class="r">${marginCell(m2, g.rev > 0 ? m2 / g.rev : null)}</td>`}</tr>`; }).join('')}</tbody></table></div>`;

    body.innerHTML = `
      <div class="jp-bar"><div class="jp-seg">${RANGES.map(r => `<button type="button" data-range="${r.key}" class="${r.key === state.range ? 'on' : ''}">${esc(r.label)}</button>`).join('')}</div><span class="jp-spacer"></span>
        <button type="button" class="jp-btn" data-edit="1">⚙ Assumptions</button><button type="button" class="jp-btn" data-reload="1">${state.loading ? '…' : '⟳'}</button></div>
      ${state.editing ? settingsHtml(st) : ''}
      <div class="jp-kpis">
        <div class="jp-kpi"><b>${jobs.length}</b><span>Jobs shipped</span><i>${tot.pieces.toLocaleString('en-GB')} pieces</i></div>
        <div class="jp-kpi"><b>${esc(gbp(tot.rev))}</b><span>Revenue (ex VAT)</span></div>
        <div class="jp-kpi"><b>${esc(gbp(tot.gc))}</b><span>Garment cost</span></div>
        <div class="jp-kpi good"><b>${esc(gbp(mg))}</b><span>Profit after garments</span><i>${esc(pct(mg, tot.rev))} of revenue</i></div>
        <div class="jp-kpi"><b>${hours(tot.mins)} h</b><span>Estimated production time</span><i>${tot.stitches.toLocaleString('en-GB')} stitches</i></div>
        <div class="jp-kpi ${cph == null ? 'na' : 'good'}">${cph == null ? '<b>—</b><span>Profit after production</span><i>set a cost per hour first</i>' : `<b>${esc(gbp(mp))}</b><span>Profit after production</span><i>${esc(pct(mp, tot.rev))} at ${esc(gbp(cph))} an hour</i>`}</div>
      </div>
      <p class="jp-note">${num(cov.orders_with_lines)} of ${num(cov.orders_shipped_in_range)} shipped orders in this period have order data${cov.first_order_synced ? ' (the data starts ' + esc(dShort(cov.first_order_synced)) + ')' : ''}. Revenue and garment costs come from DecoNetwork, so they are only as good as the costs set there. A <b>?</b> means a garment had no cost in DecoNetwork and counted as zero. Production time is an estimate: ${esc(st.minutes_per_item)} min per item plus stitches at ${esc(st.stitches_per_minute)} a minute.</p>
      <section class="jp-card"><h3>Jobs <span class="jp-dim">${state.sort.key === 'pct' && state.sort.dir > 0 ? 'lowest margin first' : 'sorted'} · click a heading to sort</span></h3>
        ${jobs.length ? `<div class="jp-tablewrap"><table class="jp-table"><thead><tr>${th('date', 'Shipped')}<th>Order</th>${th('cust', 'Customer')}<th>Rep</th>${th('rev', 'Revenue', true)}<th class="r">Garments</th>${th('mg', 'After garments', true)}${th('stitches', 'Stitches', true)}<th class="r">Est. hours</th>${cph == null ? '' : th('pct', 'After production', true)}</tr></thead><tbody>${shown.map(j => `<tr><td>${esc(dShort(j.shipped))}</td><td>#${esc(j.order_id)}</td><td>${esc(j.customer || '')}</td><td>${esc(j.rep || '')}</td><td class="r">${esc(gbp(j.rev))}</td><td class="r">${esc(gbp(j.gc))}${j.noCost ? ' <b title="Some garments have no cost in DecoNetwork">?</b>' : ''}</td><td class="r">${marginCell(j.mg, j.mgPct)}</td><td class="r">${num(j.stitches) ? num(j.stitches).toLocaleString('en-GB') : '—'}</td><td class="r">${hours(j.prod_minutes)}</td>${cph == null ? '' : `<td class="r">${marginCell(j.mp, j.mpPct)}</td>`}</tr>`).join('')}</tbody></table></div>${sorted.length > 25 ? `<button type="button" class="jp-btn jp-more" data-more="1">${state.showAll ? 'Show fewer' : 'Show all ' + sorted.length}</button>` : ''}` : '<div class="jp-empty">No shipped jobs with order data in this period yet.</div>'}</section>
      ${jobs.length ? `<div class="jp-halves">${groupTable('By salesperson', byRep)}${groupTable('Biggest customers', byCust)}</div>` : ''}`;
  }

  function settingsHtml(st) {
    return `<section class="jp-card jp-settings"><h3>Assumptions for production time</h3>
      <p class="jp-dim">These turn stitch counts and item counts into time, and time into money. Daniel's guide was "roughly a few minutes per item", so handling time starts at 3 minutes. Until a cost per hour is entered the page does not put a money figure on production. The time is worked out one machine at a time, so the cost per hour should be the cost of one hour of one machine and the person running it (a multi-head machine decorating several garments at once makes the real time shorter, so adjust the stitches per minute to suit).</p>
      <div class="jp-form"><label>Minutes per item<input type="number" id="jpMin" min="0" max="120" step="0.5" value="${esc(st.minutes_per_item)}"></label>
        <label>Stitches per minute<input type="number" id="jpSpm" min="50" max="5000" step="50" value="${esc(st.stitches_per_minute)}"></label>
        <label>Cost of an hour of production (£)<input type="number" id="jpCph" min="0" max="500" step="0.5" value="${st.cost_per_hour == null ? '' : esc(st.cost_per_hour)}" placeholder="not set"></label></div>
      ${state.canSet ? '<div class="jp-btns"><span class="jp-msg" id="jpMsg" role="status"></span><button type="button" class="jp-btn jp-primary" data-save="1">Save</button></div>' : '<p class="jp-dim">Only Daniel or Oliver can change these.</p>'}
      ${st.set_by ? `<p class="jp-dim">Last changed by ${esc(st.set_by)}.</p>` : ''}</section>`;
  }

  async function saveSettings() {
    const msg = $('jpMsg'); const cph = $('jpCph').value.trim();
    try {
      const r = await client().rpc('set_job_settings', { p_minutes: Number($('jpMin').value), p_stitches: Number($('jpSpm').value), p_cost_per_hour: cph === '' ? null : Number(cph) });
      if (r.error) throw r.error;
      state.editing = false; await load(true);
    } catch (e) { if (msg) msg.textContent = (e && e.message) || 'Could not save'; }
  }

  function injectStyles() {
    if ($('jpStyles')) return;
    const s = document.createElement('style');
    s.id = 'jpStyles';
    s.textContent = `
#jobprofit .jp-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(34,197,94,.15), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(56,189,248,.13), transparent 60%), rgba(15,23,42,.55); }
#jobprofit .jp-headbox h2 { margin:0 0 6px; font-size:28px; } #jobprofit .jp-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:780px; line-height:1.5; }
#jobprofit .jp-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:16px 0 12px; } #jobprofit .jp-spacer { flex:1; }
#jobprofit .jp-seg { display:inline-flex; border:1px solid rgba(255,255,255,.14); border-radius:10px; overflow:hidden; }
#jobprofit .jp-seg button { padding:8px 14px; background:transparent; border:none; color:#cbd5e1; font-size:13px; cursor:pointer; border-right:1px solid rgba(255,255,255,.1); }
#jobprofit .jp-seg button.on { background:rgba(56,189,248,.18); color:#fff; font-weight:700; }
#jobprofit .jp-btn { padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:600; border:1px solid rgba(255,255,255,.16); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#jobprofit .jp-btn:hover { background:rgba(255,255,255,.07); } #jobprofit .jp-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#jobprofit .jp-kpis { display:grid; grid-template-columns:repeat(6,1fr); border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.82); overflow:hidden; margin-bottom:10px; }
#jobprofit .jp-kpi { padding:14px 16px; border-right:1px solid rgba(255,255,255,.08); display:grid; gap:2px; align-content:start; } #jobprofit .jp-kpi:last-child { border-right:none; }
#jobprofit .jp-kpi b { font-size:22px; font-variant-numeric:tabular-nums; } #jobprofit .jp-kpi span { color:#cbd5e1; font-size:12.5px; } #jobprofit .jp-kpi i { color:#64748b; font-size:11.5px; font-style:normal; }
#jobprofit .jp-kpi.good b { color:#4ade80; } #jobprofit .jp-kpi.na b { color:#64748b; }
#jobprofit .jp-note { margin:0 0 14px; color:#94a3b8; font-size:12.5px; line-height:1.55; max-width:900px; }
#jobprofit .jp-card { padding:16px 18px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(15,23,42,.6); margin-bottom:16px; }
#jobprofit .jp-card h3, #jobprofit .jp-half h4 { margin:0 0 10px; font-size:16px; } #jobprofit .jp-dim { color:#94a3b8; font-weight:400; font-size:12.5px; }
#jobprofit .jp-tablewrap { overflow-x:auto; } #jobprofit .jp-table { width:100%; border-collapse:collapse; font-size:13px; }
#jobprofit .jp-table th { text-align:left; padding:8px 9px; font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:.4px; border-bottom:1px solid rgba(255,255,255,.12); white-space:nowrap; }
#jobprofit .jp-table th[data-sort] { cursor:pointer; } #jobprofit .jp-table th.sorted { color:#38bdf8; }
#jobprofit .jp-table td { padding:8px 9px; border-bottom:1px solid rgba(255,255,255,.06); } #jobprofit .jp-table .r { text-align:right; font-variant-numeric:tabular-nums; }
#jobprofit .jp-table td i { color:#94a3b8; font-style:normal; font-size:11.5px; }
#jobprofit .jp-neg { color:#fca5a5; font-weight:700; } #jobprofit .jp-low { color:#fcd34d; }
#jobprofit .jp-halves { display:grid; grid-template-columns:1fr 1fr; gap:16px; } #jobprofit .jp-half { padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(15,23,42,.6); overflow-x:auto; }
#jobprofit .jp-more { margin-top:10px; } #jobprofit .jp-empty { padding:36px 12px; text-align:center; color:#94a3b8; }
#jobprofit .jp-form { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:10px 0; } #jobprofit .jp-form label { display:grid; gap:4px; font-size:12.5px; color:#cbd5e1; }
#jobprofit .jp-form input { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#020617; color:#e2e8f0; font-size:14px; }
#jobprofit .jp-btns { display:flex; gap:10px; align-items:center; justify-content:flex-end; } #jobprofit .jp-msg { flex:1; color:#fca5a5; font-size:12.5px; }
@media (max-width:1000px) { #jobprofit .jp-kpis { grid-template-columns:repeat(2,1fr); } #jobprofit .jp-kpi { border-bottom:1px solid rgba(255,255,255,.08); } #jobprofit .jp-halves, #jobprofit .jp-form { grid-template-columns:1fr; } }`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchor = document.querySelector('.nav-link[data-page="cash"]') || document.querySelector('.nav-link[data-page="teamboard"]') || document.querySelector('.nav-link');
    const anyPage = document.querySelector('.dashboard-page');
    if (!anchor || !anyPage) return false;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'nav-link'; btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>🧵 Job profit</span>';
    anchor.insertAdjacentElement(document.querySelector('.nav-link[data-page="cash"], .nav-link[data-page="teamboard"]') ? 'afterend' : 'beforebegin', btn);
    const sec = document.createElement('section');
    sec.id = PAGE_ID; sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="jp-headbox"><p class="eyebrow">Money</p><h2>Job profit</h2>
      <p>What each shipped job really made: the price charged, the garments it cost, and how long the decoration should have taken from its stitch count and number of items. Taken straight from DecoNetwork's orders.</p></div>
      <div id="jpBody"><div class="jp-empty">Working it out…</div></div>`;
    anyPage.parentElement.appendChild(sec);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active'); sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      load(state.loaded);
    });
    document.addEventListener('click', e => { const other = e.target.closest('.nav-link'); if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); } }, true);
    sec.addEventListener('click', e => {
      const r = e.target.closest('[data-range]'); if (r) { state.range = r.dataset.range; load(); return; }
      const so = e.target.closest('[data-sort]'); if (so) { const k = so.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'pct' || k === 'cust' ? 1 : -1) }; render(); return; }
      if (e.target.closest('[data-edit]')) { state.editing = !state.editing; render(); return; }
      if (e.target.closest('[data-save]')) { saveSettings(); return; }
      if (e.target.closest('[data-more]')) { state.showAll = !state.showAll; render(); return; }
      if (e.target.closest('[data-reload]')) { load(); }
    });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage() && boot.tries < 100) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.JobProfitPage = { reload: () => load(), state };
})();
