// Cash tab: money expected in over the next 8 weeks, supplier bills due out, and the overdue invoices to chase (with a draft chasing email for each customer).
// Data: the read-only database function cash_forecast() (sql/cash_forecast_2026-11-03.sql). Read the note on the page and in that file for how the estimate is made.
// Nothing is sent or posted from here. A chasing draft is text for a person to copy or open in their own email program: money actions stay human.
// Adds its own nav button (after Team board) and page, like quotes.js / calendar.js.
(function () {
  'use strict';

  const PAGE_ID = 'cash';
  const REFRESH_MS = 10 * 60 * 1000;

  const state = { data: null, me: '', loaded: false, loading: false, error: null, timer: null, open: new Set(), chart: null, showAll: false };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v) || 0;
  const gbp = n => '£' + Math.round(num(n)).toLocaleString('en-GB');
  const gbp2 = n => '£' + num(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dShort = s => { const p = String(s).slice(0, 10).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

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
      const res = await client().rpc('cash_forecast');
      if (res.error) throw res.error;
      state.data = res.data;
      if (!state.me) {
        try {
          const u = await client().auth.getUser();
          const id = u && u.data && u.data.user && u.data.user.id;
          if (id) { const p = await client().from('profiles').select('full_name').eq('id', id).maybeSingle(); state.me = (p && p.data && p.data.full_name) || ''; }
        } catch (e) { /* the draft just ends with a blank name to fill in */ }
      }
      state.loaded = true; state.error = null; state.updatedAt = new Date();
    } catch (e) {
      console.error('cash forecast failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the cash forecast';
    } finally { state.loading = false; }
    render();
  }

  // ---- the chasing draft (fixed wording, filled with the invoices; never promises anything, never includes bank details) ----
  function draftFor(c) {
    const inv = (c.invoices || []);
    const oldest = num(c.oldest);
    const shown = inv.slice(0, 15);
    const lines = shown.map(i => '  - ' + i.doc + ': due ' + dShort(i.due) + ', ' + gbp2(i.amount) + ' (' + num(i.days) + ' day' + (num(i.days) === 1 ? '' : 's') + ' overdue)').join('\n');
    const more = inv.length > shown.length ? '\n  ...and ' + (inv.length - shown.length) + ' more' : '';
    const total = gbp2(c.total);
    let subject, intro, ask;
    if (oldest <= 14) {
      subject = 'Reminder: invoices now due';
      intro = 'I hope you are well. This is a friendly reminder that the following invoices have just passed their due date:';
      ask = 'Could you let me know when we can expect payment? If it is already on its way, thank you, and please ignore this message.';
    } else if (oldest <= 45) {
      subject = 'Overdue invoices: please can you look at these';
      intro = 'I am writing because the following invoices are now overdue:';
      ask = 'Please could you arrange payment, or let me know the date it will be made. If anything is wrong with an invoice, tell me and I will sort it out straight away. If you have already paid, please tell me the date so we can match it up.';
    } else {
      subject = 'Final reminder: overdue invoices';
      intro = 'The following invoices are now well past their due date, and we have not yet received payment:';
      ask = 'Please could you let me know today when payment will be made. If there is a problem with any invoice, or you have already paid, please tell me so we can put it right.';
    }
    const body = 'Hello,\n\n' + intro + '\n\n' + lines + more + '\n\nTotal overdue: ' + total + '\n\n' + ask + '\n\nKind regards,\n' + (state.me || '[your name]') + '\nATAM Workwear';
    return { subject, body };
  }

  function openDraft(idx) {
    const c = (state.data.chase || [])[idx]; if (!c) return;
    const d = draftFor(c);
    closeDraft();
    const m = document.createElement('div');
    m.id = 'csModal'; m.className = 'cs-modal';
    m.innerHTML = `<div class="cs-modal-box" role="dialog" aria-modal="true" aria-labelledby="csDTitle">
      <h3 id="csDTitle">Draft chasing email: ${esc(c.customer)}</h3>
      <p class="cs-dim">This is only a draft. Nothing is sent from here: copy it, or open it in your own email program, add the person's address, check it and send it yourself. It lists the invoices as Xero has them and never includes bank details.</p>
      <label class="cs-lab">Subject<input type="text" id="csSubj" value="${esc(d.subject)}"></label>
      <label class="cs-lab">Message<textarea id="csText" rows="14">${esc(d.body)}</textarea></label>
      <div class="cs-btns"><span class="cs-msg" id="csMsg" role="status"></span><button type="button" class="cs-btn" id="csClose">Close</button><button type="button" class="cs-btn" id="csCopy">Copy message</button><a class="cs-btn cs-primary" id="csMail" href="#">Open in my email</a></div></div>`;
    document.body.appendChild(m);
    document.addEventListener('keydown', draftKeys, true);
    const sync = () => { $('csMail').href = 'mailto:?subject=' + encodeURIComponent($('csSubj').value) + '&body=' + encodeURIComponent($('csText').value); };
    sync();
    $('csSubj').addEventListener('input', sync); $('csText').addEventListener('input', sync);
    m.addEventListener('click', e => { if (e.target === m) closeDraft(); });
    $('csClose').addEventListener('click', closeDraft);
    $('csCopy').addEventListener('click', async () => {
      const text = 'Subject: ' + $('csSubj').value + '\n\n' + $('csText').value;
      try { await navigator.clipboard.writeText(text); $('csMsg').textContent = 'Copied.'; }
      catch (e) { $('csText').select(); $('csMsg').textContent = 'Press Ctrl+C (or Cmd+C) to copy.'; }
    });
    $('csText').focus();
  }
  function closeDraft() { const m = $('csModal'); if (m) m.remove(); document.removeEventListener('keydown', draftKeys, true); }
  function draftKeys(e) { if (e.key === 'Escape') { e.stopPropagation(); closeDraft(); } }

  // ---- drawing ----
  function drawChart() {
    const canvas = $('csChart');
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    if (!canvas || typeof Chart === 'undefined' || !state.data) return;
    const w = state.data.weeks || [];
    state.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: w.map(x => 'w/c ' + dShort(x.start)),
        datasets: [
          { label: 'Expected in', data: w.map(x => num(x.in)), backgroundColor: '#22c55e', borderRadius: 4 },
          { label: 'Supplier bills due', data: w.map(x => num(x.out)), backgroundColor: '#f87171', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1' } }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + gbp(c.parsed.y) } } },
        scales: { x: { ticks: { color: '#94a3b8' }, grid: { display: false } }, y: { ticks: { color: '#94a3b8', callback: v => '£' + Number(v).toLocaleString('en-GB') }, grid: { color: 'rgba(255,255,255,.07)' } } }
      }
    });
  }

  function render() {
    const body = $('csBody'); if (!body) return;
    if (state.error) { body.innerHTML = `<div class="cs-empty">Couldn't load the cash forecast: ${esc(state.error)}<br><button type="button" class="cs-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { body.innerHTML = '<div class="cs-empty">Working it out… (this takes a few seconds)</div>'; return; }
    const d = state.data, t = d.totals || {}, ps = d.pay_stats || {};
    const w = d.weeks || [];
    const inSum = w.reduce((s, x) => s + num(x.in), 0), outSum = w.reduce((s, x) => s + num(x.out), 0);
    const chase = d.chase || [];
    const list = state.showAll ? chase : chase.slice(0, 15);
    body.innerHTML = `
      <div class="cs-bar"><span class="cs-spacer"></span><span class="cs-dim">${state.updatedAt ? 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span><button type="button" class="cs-btn" data-reload="1">${state.loading ? '…' : '⟳ Refresh'}</button></div>
      <div class="cs-kpis">
        <div class="cs-kpi"><b>${gbp(t.open_v)}</b><span>Unpaid invoices</span><i>${num(t.open_n)} invoices</i></div>
        <div class="cs-kpi warn"><b>${gbp(t.over_v)}</b><span>Overdue (up to 3 months)</span><i>${num(t.over_n)} invoices</i></div>
        <div class="cs-kpi"><b>${gbp(t.due7_v)}</b><span>Falls due in the next 7 days</span></div>
        <div class="cs-kpi good"><b>${gbp(inSum)}</b><span>Expected in, next 8 weeks</span><i>an estimate</i></div>
        <div class="cs-kpi"><b>${gbp(outSum)}</b><span>Supplier bills due, next 8 weeks</span><i>partial view</i></div>
      </div>
      <section class="cs-card"><h3>Next 8 weeks <span class="cs-dim">money expected in against supplier bills due</span></h3><div class="cs-chart"><canvas id="csChart" role="img" aria-label="Weekly expected money in and supplier bills due"></canvas></div></section>
      <section class="cs-card"><h3>Overdue invoices to chase <span class="cs-dim">${chase.length} customer${chase.length === 1 ? '' : 's'}, biggest first</span></h3>
        ${chase.length ? `<div class="cs-tablewrap"><table class="cs-table"><thead><tr><th>Customer</th><th class="r">Invoices</th><th class="r">Total overdue</th><th class="r">Oldest</th><th></th></tr></thead><tbody>${list.map((c, i) => {
          const isOpen = state.open.has(c.customer);
          return `<tr class="cs-row" data-toggle="${esc(c.customer)}" tabindex="0"><td><b>${esc(c.customer)}</b></td><td class="r">${num(c.n)}</td><td class="r">${gbp(c.total)}</td><td class="r"><span class="cs-age ${num(c.oldest) > 45 ? 'bad' : num(c.oldest) > 14 ? 'mid' : ''}">${num(c.oldest)} days</span></td><td class="r"><button type="button" class="cs-btn" data-draft="${chase.indexOf(c)}">✉️ Draft chase</button></td></tr>` +
            (isOpen ? `<tr class="cs-sub"><td colspan="5"><table class="cs-inner">${(c.invoices || []).map(x => `<tr><td>${esc(x.doc)}</td><td>due ${esc(dShort(x.due))}</td><td class="r">${esc(gbp2(x.amount))}</td><td class="r">${num(x.days)} days overdue</td></tr>`).join('')}</table></td></tr>` : '');
        }).join('')}</tbody></table></div>${chase.length > 15 ? `<button type="button" class="cs-btn cs-more" data-more="1">${state.showAll ? 'Show fewer' : 'Show all ' + chase.length}</button>` : ''}` : '<div class="cs-empty">Nothing overdue. 🎉</div>'}
        ${num(t.old_n) ? `<p class="cs-note">${num(t.old_n)} more invoices worth ${gbp(t.old_v)} are over 3 months overdue. They are left out of the list and the forecast: some may be old records. Worth a review in Xero.</p>` : ''}
      </section>
      <details class="cs-how"><summary>How this is worked out</summary>
        <p><b>Money in.</b> Each unpaid invoice is spread over the pattern of how invoices have really been paid over the last 12 months (${num(ps.n).toLocaleString('en-GB')} paid invoices: about ${num(ps.on_time)}% were paid by the due date, the middle one was paid ${num(ps.med)} day${num(ps.med) === 1 ? '' : 's'} after it). An invoice that is already overdue only uses invoices that were also still unpaid at that point. A bigger invoice with a 40% chance of being paid in a week adds 40% of its value to that week. The pay date is taken from when Xero last changed the invoice to paid, which is close to the real payment date.</p>
        <p><b>Supplier bills.</b> Only bills posted to Xero from ATAM GO since mid August whose due date is ahead. We cannot see whether a bill has already been paid, and there are no wages, rent, VAT or bank balance in here, so this is a partial picture of money going out, not a bank forecast.</p>
        <p><b>Chasing.</b> The draft wording gets firmer the older the oldest invoice is. Nothing is sent from this page.</p></details>`;
    drawChart();
  }

  function injectStyles() {
    if ($('csStyles')) return;
    const s = document.createElement('style');
    s.id = 'csStyles';
    s.textContent = `
#cash .cs-headbox { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(234,179,8,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(34,197,94,.13), transparent 60%), rgba(15,23,42,.55); }
#cash .cs-headbox h2 { margin:0 0 6px; font-size:28px; }
#cash .cs-headbox p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#cash .cs-bar { display:flex; gap:10px; align-items:center; margin:16px 0 10px; }
#cash .cs-spacer { flex:1; }
#cash .cs-dim, .cs-modal .cs-dim { color:#94a3b8; font-weight:400; font-size:12.5px; }
#cash .cs-btn, .cs-modal .cs-btn { display:inline-block; padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:600; border:1px solid rgba(255,255,255,.16); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; text-decoration:none; }
#cash .cs-btn:hover, .cs-modal .cs-btn:hover { background:rgba(255,255,255,.07); }
.cs-modal .cs-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#cash .cs-kpis { display:grid; grid-template-columns:repeat(5,1fr); border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.82); overflow:hidden; margin-bottom:16px; }
#cash .cs-kpi { padding:14px 16px; border-right:1px solid rgba(255,255,255,.08); display:grid; gap:2px; }
#cash .cs-kpi:last-child { border-right:none; }
#cash .cs-kpi b { font-size:24px; font-variant-numeric:tabular-nums; }
#cash .cs-kpi span { color:#cbd5e1; font-size:12.5px; }
#cash .cs-kpi i { color:#64748b; font-size:11.5px; font-style:normal; }
#cash .cs-kpi.warn b { color:#fbbf24; } #cash .cs-kpi.good b { color:#4ade80; }
#cash .cs-card { padding:16px 18px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(15,23,42,.6); margin-bottom:16px; }
#cash .cs-card h3 { margin:0 0 10px; font-size:16px; }
#cash .cs-chart { height:280px; }
#cash .cs-tablewrap { overflow-x:auto; }
#cash .cs-table { width:100%; border-collapse:collapse; font-size:13.5px; }
#cash .cs-table th { text-align:left; padding:8px 10px; font-size:11.5px; color:#94a3b8; text-transform:uppercase; letter-spacing:.4px; border-bottom:1px solid rgba(255,255,255,.12); }
#cash .cs-table td { padding:9px 10px; border-bottom:1px solid rgba(255,255,255,.06); }
#cash .cs-table .r { text-align:right; font-variant-numeric:tabular-nums; }
#cash .cs-row { cursor:pointer; } #cash .cs-row:hover { background:rgba(255,255,255,.04); }
#cash .cs-sub td { background:rgba(255,255,255,.03); }
#cash .cs-inner { width:100%; font-size:12.5px; color:#cbd5e1; } #cash .cs-inner td { border:none; padding:3px 10px; }
#cash .cs-age { padding:2px 8px; border-radius:999px; background:rgba(148,163,184,.15); font-size:12px; }
#cash .cs-age.mid { background:rgba(245,158,11,.2); color:#fcd34d; } #cash .cs-age.bad { background:rgba(248,113,113,.2); color:#fca5a5; }
#cash .cs-more { margin-top:10px; }
#cash .cs-note { margin:12px 0 0; color:#94a3b8; font-size:12.5px; }
#cash .cs-empty { padding:36px 12px; text-align:center; color:#94a3b8; }
#cash .cs-how { color:#94a3b8; font-size:13px; } #cash .cs-how summary { cursor:pointer; } #cash .cs-how p { line-height:1.55; max-width:800px; }
.cs-modal { position:fixed; inset:0; z-index:10050; background:rgba(2,6,23,.7); display:flex; align-items:center; justify-content:center; padding:16px; }
.cs-modal-box { width:min(620px,100%); max-height:92vh; overflow:auto; background:#0f172a; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); border-radius:14px; padding:18px 20px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
.cs-modal-box h3 { margin:0 0 6px; font-size:17px; } .cs-modal-box p { margin:4px 0 12px; line-height:1.5; }
.cs-lab { display:grid; gap:4px; font-size:12.5px; margin-bottom:10px; }
.cs-lab input, .cs-lab textarea { padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#020617; color:#e2e8f0; font-size:13.5px; font-family:inherit; }
.cs-btns { display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap; margin-top:6px; }
.cs-msg { flex:1; color:#94a3b8; font-size:12.5px; }
@media (max-width:900px) { #cash .cs-kpis { grid-template-columns:repeat(2,1fr); } #cash .cs-kpi { border-bottom:1px solid rgba(255,255,255,.08); } }`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchor = document.querySelector('.nav-link[data-page="teamboard"]') || document.querySelector('.nav-link[data-page="today"]') || document.querySelector('.nav-link');
    const anyPage = document.querySelector('.dashboard-page');
    if (!anchor || !anyPage) return false;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'nav-link'; btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>💷 Cash</span>';
    anchor.insertAdjacentElement(document.querySelector('.nav-link[data-page="teamboard"], .nav-link[data-page="today"]') ? 'afterend' : 'beforebegin', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID; sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="cs-headbox"><p class="eyebrow">Money</p><h2>Cash</h2>
      <p>What is owed to us, when it is likely to arrive over the next 8 weeks, which supplier bills are due, and the overdue invoices to chase, with a draft email for each customer. Nothing is sent or posted from here.</p></div>
      <div id="csBody"><div class="cs-empty">Working it out…</div></div>`;
    anyPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active'); sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      load(state.loaded);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      const dr = e.target.closest('[data-draft]');
      if (dr) { e.stopPropagation(); openDraft(Number(dr.dataset.draft)); return; }
      if (e.target.closest('[data-more]')) { state.showAll = !state.showAll; render(); return; }
      if (e.target.closest('[data-reload]')) { load(); return; }
      const tg = e.target.closest('[data-toggle]');
      if (tg) { const k = tg.dataset.toggle; if (state.open.has(k)) state.open.delete(k); else state.open.add(k); render(); }
    });
    sec.addEventListener('keydown', e => { const r = e.target.closest && e.target.closest('[data-toggle]'); if (r && (e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); r.click(); } });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage() && boot.tries < 100) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.CashPage = { reload: () => load(), state };
})();
