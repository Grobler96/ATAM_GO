// customer_spend.js
// "Customer Spend" tab for ATAM GO. Self-installing: adds its own nav button
// and page, so index.html only needs  <script src="customer_spend.js"></script>
// after sales_invoices_view.js.
//
// Data: Supabase RPCs built 29 Sept 2026 over Xero sales invoices
// (synced daily 05:30 by n8n "Sync Xero Sales v2"):
//   get_customer_spend_summary, get_customer_spend_matrix,
//   get_customer_spend_monthly, get_customer_spend_alerts,
//   get_customer_product_mix
// All are granted to logged-in users only (not the public anon role).
// Read-only - nothing on this page writes anywhere.

(function () {
  'use strict';

  const PAGE_ID = 'customerspend';
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js';
  const FORECAST_MONTHS = 6;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const C = {
    orange: '#FF7A1A', orangeSoft: 'rgba(255,122,26,0.18)',
    silver: '#B8C4D2', silverDim: 'rgba(184,196,210,0.35)',
    red: '#F43F5E', amber: '#F5B83D', green: '#34D399',
    text: '#F8FAFC', muted: '#94A3B8', line: 'rgba(255,255,255,0.08)'
  };
  const STATUS = {
    gone_quiet: { label: 'Gone quiet', color: C.red },
    under: { label: 'Under usual spend', color: C.amber },
    watch: { label: 'Worth a watch', color: '#FDE68A' }
  };

  const state = {
    loaded: false, level: 'group', sort: 'spend', search: '', showAll: false,
    summary: {}, matrix: {}, alerts: {}, charts: [], drillStack: []
  };

  // ───────────────────────── helpers ─────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => Number(v) || 0;
  const sum = a => a.reduce((s, v) => s + num(v), 0);
  const mean = a => a.length ? sum(a) / a.length : 0;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function money(n, compact) {
    n = num(n);
    if (compact && Math.abs(n) >= 1000) {
      const k = Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'm' : (n / 1e3).toFixed(Math.abs(n) >= 1e5 ? 0 : 1) + 'k';
      return (n < 0 ? '-£' : '£') + k.replace('-', '');
    }
    return (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }
  function pctChange(cur, prev) {
    cur = num(cur); prev = num(prev);
    if (prev <= 0) return cur > 0 ? null : 0;
    return (cur - prev) / prev * 100;
  }
  function deltaHtml(cur, prev, suffix) {
    const p = pctChange(cur, prev);
    if (p === null) return `<span class="cs-delta cs-new">new ${suffix || ''}</span>`;
    const cls = p >= 3 ? 'cs-up' : p <= -3 ? 'cs-down' : 'cs-flat';
    const arrow = p >= 3 ? '▲' : p <= -3 ? '▼' : '●';
    return `<span class="cs-delta ${cls}">${arrow} ${Math.abs(p).toFixed(0)}% ${suffix || ''}</span>`;
  }
  function monthLabel(ym, withYear) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-GB', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  function addMonths(ym, k) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + k, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function daysAgo(n) {
    if (n == null) return 'never';
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    return n + ' days ago';
  }

  async function sb() {
    if (window._atamSb) return window._atamSb;
    window._atamSb = supabase.createClient('https://aobosyvlhgkxhjxkfzlz.supabase.co', 'sb_publishable_4Ii8Z8bGgQ5OrSKB2at_GA_GubBsWC1');
    return window._atamSb;
  }
  async function rpc(fn, args) {
    const client = await sb();
    const { data, error } = await client.rpc(fn, args || {});
    if (error) throw new Error(fn + ': ' + error.message);
    return data;
  }

  // ───────────────────────── forecasting ─────────────────────────
  // Recent 12-month average x damped year-on-year growth x the customer's own
  // seasonal pattern (shrunk towards 1, since there are only ~2 years of data).
  // Every forecast is backtested one month ahead over the last 6 real months;
  // that error (WAPE) sets the confidence band and the confidence label.
  // Candidate methods. Each customer gets whichever would have predicted
  // their own last 6 months best (lumpy buyers usually suit a flat average,
  // steady seasonal buyers suit the seasonal model).
  const MODELS = {
    seasonal: (h, m, t, a) => predictSeasonal(h, m, t, a),
    avg12: (h) => Math.max(0, mean(h.slice(-12))),
    avg6: (h) => Math.max(0, mean(h.slice(-6))),
    blend: (h, m, t, a) => 0.5 * predictSeasonal(h, m, t, a) + 0.5 * Math.max(0, mean(h.slice(-12)))
  };
  const MODEL_LABEL = { seasonal: 'seasonal pattern + trend', avg12: '12-month average', avg6: '6-month average', blend: 'blend of seasonal and average' };

  function backtest(hist, months, model) {
    const L = hist.length;
    let e1 = 0, a1 = 0, e3 = 0, a3 = 0, n1 = 0, n3 = 0;
    for (let t = Math.max(6, L - 6); t < L; t++) {           // 1 month ahead
      const p = MODELS[model](hist.slice(0, t), months.slice(0, t), months[t], 1);
      e1 += Math.abs(hist[t] - p); a1 += Math.abs(hist[t]); n1++;
    }
    for (let t = Math.max(6, L - 9); t + 3 <= L; t++) {      // next 3 months as a total
      let p = 0;
      for (let k = 0; k < 3; k++) p += MODELS[model](hist.slice(0, t), months.slice(0, t), months[t + k], 1 + k);
      const act = sum(hist.slice(t, t + 3));
      e3 += Math.abs(act - p); a3 += Math.abs(act); n3++;
    }
    return { wape: a1 > 0 ? e1 / a1 : 1, wape3: a3 > 0 ? e3 / a3 : 1, n1, n3 };
  }

  function predictSeasonal(hist, histMonthNos, targetMonthNo, ahead) {
    const L = hist.length;
    if (L === 0) return 0;
    const last12 = hist.slice(-12);
    const base = mean(last12);
    let growth = 1;
    if (L >= 24) {
      const prev = sum(hist.slice(-24, -12)), cur = sum(last12);
      if (prev > 0 && cur > 0) growth = clamp(Math.sqrt(cur / prev), 0.75, 1.3);
    }
    let si = 1;
    if (L >= 18) {
      const ratios = [];
      for (let i = 0; i < L; i++) {
        if (histMonthNos[i] !== targetMonthNo) continue;
        const w = hist.slice(Math.max(0, i - 6), Math.min(L, i + 7));
        const wm = mean(w);
        if (wm > 0) ratios.push(hist[i] / wm);
      }
      if (ratios.length) si = clamp(1 + 0.6 * (mean(ratios) - 1), 0.4, 2.2);
    }
    // base sits ~6 months behind the end of history, so project growth from there
    return Math.max(0, base * Math.pow(growth, (ahead + 5.5) / 12) * si);
  }

  // first month that looks like real trading (ignores stray pennies before a customer properly starts)
  function firstMeaningful(v) {
    const pos = v.filter(x => x > 0);
    if (!pos.length) return v.length;
    const thr = 0.1 * mean(pos);
    const i = v.findIndex(x => x >= thr);
    return i < 0 ? v.length : i;
  }

  function buildForecast(vals, monthKeys) {
    const n = vals.length;
    const complete = vals.slice(0, n - 1).map(num);
    const start = firstMeaningful(complete);
    const hist = complete.slice(start);
    const histMonthNos = monthKeys.slice(start, n - 1).map(k => +k.slice(5, 7));
    const L = hist.length;

    // backtest every method on this customer's own history; keep the best on 3-month totals
    let model = 'avg12', bt = { wape: 1, wape3: 1, n1: 0, n3: 0 };
    if (L >= 9) {
      let best = null;
      for (const m of Object.keys(MODELS)) {
        const r = backtest(hist, histMonthNos, m);
        const score = r.wape3 * 0.7 + r.wape * 0.3;
        if (!best || score < best.score) best = { m, r, score };
      }
      model = best.m; bt = best.r;
    }
    const wape = bt.wape, wape3 = bt.wape3, tested = bt.n1;
    const band = clamp(wape, 0.1, 1.2);

    const curKey = monthKeys[n - 1];
    const out = [];
    for (let k = 0; k <= FORECAST_MONTHS; k++) {
      const key = addMonths(curKey, k);
      const p = L ? MODELS[model](hist, histMonthNos, +key.slice(5, 7), 1 + k) : 0;
      const spread = band * Math.sqrt(1 + k) * 0.85;
      out.push({ key, pred: p, lo: Math.max(0, p * (1 - spread)), hi: p * (1 + spread) });
    }

    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const frac = clamp(now.getDate() / dim, 0, 1);
    const mtd = num(vals[n - 1]);
    const monthEnd = mtd + out[0].pred * (1 - frac);

    const next6 = sum(out.slice(1).map(o => o.pred));
    const ly6 = sum(out.slice(1).map((o, i) => { const idx = n - 1 - 12 + (i + 1); return idx >= 0 ? num(vals[idx]) : 0; }));

    // confidence is judged on 3-month totals: that's what the projection is used for
    let confidence, confText;
    if (L < 12) { confidence = 'low'; confText = 'Low: under a year of history'; }
    else if (wape3 < 0.15) { confidence = 'high'; confText = 'High'; }
    else if (wape3 < 0.3) { confidence = 'medium'; confText = 'Medium'; }
    else { confidence = 'low'; confText = 'Low: this customer orders in lumps'; }

    return { months: out, wape, wape3, tested, model, modelLabel: MODEL_LABEL[model], historyMonths: L, confidence, confText, mtd, monthEnd, frac, next6, ly6 };
  }

  // ───────────────────────── styles ─────────────────────────
  function injectStyles() {
    if (document.getElementById('cs-styles')) return;
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&display=swap';
    document.head.appendChild(font);

    const s = document.createElement('style');
    s.id = 'cs-styles';
    s.textContent = `
#customerspend { --cs-display: 'Big Shoulders Display', 'Arial Narrow', Impact, sans-serif; }
#customerspend .cs-num, #customerspend .cs-display { font-family: var(--cs-display); letter-spacing: 0.01em; font-variant-numeric: tabular-nums; }
#customerspend h2.cs-title { font-family: var(--cs-display); font-weight: 800; font-size: clamp(34px, 5vw, 52px); line-height: 0.95; margin: 0 0 8px; }
#customerspend .cs-sub { color: ${C.muted}; max-width: 62ch; font-size: 14px; line-height: 1.55; margin: 0; }
#customerspend .cs-head { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-end; justify-content: space-between; margin-bottom: 22px; }
#customerspend .cs-totals { display: flex; gap: 28px; flex-wrap: wrap; }
#customerspend .cs-total .cs-num { font-size: 34px; font-weight: 700; line-height: 1; }
#customerspend .cs-total .cs-k { font-size: 12px; color: ${C.muted}; margin-top: 4px; }

#customerspend .cs-stage { position: relative; border-radius: 22px; overflow: hidden; border: 1px solid ${C.line};
  background: radial-gradient(120% 90% at 50% 0%, rgba(255,122,26,0.10), transparent 60%), rgba(2,6,23,0.9); height: 440px; margin-bottom: 26px; }
#customerspend .cs-stage canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: pan-y; }
#customerspend .cs-stage canvas:active { cursor: grabbing; }
#customerspend .cs-stage-cap { position: absolute; left: 20px; bottom: 16px; font-size: 12px; color: ${C.muted}; line-height: 1.5; pointer-events: none; max-width: 46ch; }
#customerspend .cs-stage-cap b { color: ${C.text}; font-weight: 600; }
#customerspend .cs-key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 5px; }
#customerspend .cs-tip { position: absolute; pointer-events: none; background: rgba(15,23,42,0.96); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 10px; padding: 9px 12px; font-size: 12px; line-height: 1.45; transform: translate(-50%, calc(-100% - 14px)); display: none; white-space: nowrap; z-index: 3; }
#customerspend .cs-tip .cs-num { font-size: 20px; }
#customerspend .cs-stage-fallback { display: flex; align-items: center; justify-content: center; height: 100%; color: ${C.muted}; font-size: 13px; }

#customerspend .cs-section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
#customerspend .cs-section-h h3 { font-family: var(--cs-display); font-weight: 700; font-size: 26px; margin: 0; }
#customerspend .cs-section-h p { margin: 0; color: ${C.muted}; font-size: 13px; }

#customerspend .cs-alerts { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 30px; scroll-snap-type: x mandatory; }
#customerspend .cs-alert { flex: 0 0 260px; scroll-snap-align: start; text-align: left; cursor: pointer; color: inherit; font: inherit;
  background: rgba(15,23,42,0.82); border: 1px solid ${C.line}; border-left: 4px solid var(--st); border-radius: 14px; padding: 14px 16px; }
#customerspend .cs-alert:hover, #customerspend .cs-alert:focus-visible { border-color: var(--st); outline: none; }
#customerspend .cs-alert .cs-a-name { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
#customerspend .cs-alert .cs-a-parent { font-size: 11.5px; color: ${C.muted}; margin-bottom: 8px; }
#customerspend .cs-alert .cs-a-why { font-size: 12.5px; line-height: 1.45; color: #CBD5E1; }
#customerspend .cs-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--st); margin-bottom: 6px; }
#customerspend .cs-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--st); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st) 25%, transparent); }

#customerspend .cs-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }
#customerspend .cs-seg { display: inline-flex; background: rgba(15,23,42,0.82); border: 1px solid ${C.line}; border-radius: 10px; padding: 3px; }
#customerspend .cs-seg button { border: 0; background: transparent; color: ${C.muted}; font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 7px; cursor: pointer; }
#customerspend .cs-seg button.on { background: rgba(255,122,26,0.16); color: ${C.text}; }
#customerspend .cs-search { flex: 1 1 200px; max-width: 320px; background: rgba(15,23,42,0.82); border: 1px solid ${C.line}; color: ${C.text};
  border-radius: 10px; padding: 9px 12px; font: inherit; font-size: 13px; }
#customerspend button:focus-visible, #customerspend input:focus-visible { outline: 2px solid ${C.orange}; outline-offset: 2px; }

#customerspend .cs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
#customerspend .cs-card { position: relative; text-align: left; color: inherit; font: inherit; cursor: pointer;
  background: rgba(15,23,42,0.82); border: 1px solid ${C.line}; border-radius: 16px; padding: 16px 16px 12px; transition: border-color .15s, background .15s; }
#customerspend .cs-card:hover { border-color: rgba(255,122,26,0.5); background: rgba(22,32,54,0.9); }
#customerspend .cs-card .cs-c-name { font-weight: 600; font-size: 14px; line-height: 1.3; padding-right: 18px; min-height: 36px; }
#customerspend .cs-card .cs-c-dot { position: absolute; top: 18px; right: 16px; width: 9px; height: 9px; border-radius: 50%; }
#customerspend .cs-card .cs-num { font-size: 32px; font-weight: 700; line-height: 1; margin-top: 8px; }
#customerspend .cs-card .cs-c-k { font-size: 11.5px; color: ${C.muted}; margin-top: 3px; }
#customerspend .cs-card svg { display: block; width: 100%; height: 46px; margin: 10px 0 8px; }
#customerspend .cs-card .cs-c-foot { display: flex; justify-content: space-between; font-size: 11.5px; color: ${C.muted}; gap: 8px; }
#customerspend .cs-delta { font-size: 12px; font-weight: 600; margin-left: 6px; }
#customerspend .cs-up { color: ${C.green}; } #customerspend .cs-down { color: ${C.red}; } #customerspend .cs-flat, #customerspend .cs-new { color: ${C.muted}; }
#customerspend .cs-more { display: block; margin: 18px auto 0; }
#customerspend .cs-btn { background: rgba(15,23,42,0.82); border: 1px solid ${C.line}; color: ${C.text}; font: inherit; font-size: 13px; border-radius: 10px; padding: 9px 16px; cursor: pointer; }
#customerspend .cs-btn:hover { border-color: rgba(255,122,26,0.5); }
#customerspend .cs-empty, #customerspend .cs-error { color: ${C.muted}; padding: 40px 0; text-align: center; font-size: 13px; }
#customerspend .cs-error { color: #FDA4AF; }

/* drill-down sheet */
.cs-drill { position: fixed; inset: 0; z-index: 9000; display: none; }
.cs-drill.open { display: block; }
.cs-drill .cs-backdrop { position: absolute; inset: 0; background: rgba(2,6,23,0.72); backdrop-filter: blur(6px); opacity: 0; transition: opacity .25s; }
.cs-drill.open .cs-backdrop { opacity: 1; }
.cs-drill .cs-sheet { position: absolute; left: 50%; top: 3vh; bottom: 0; width: min(1180px, 100%); transform: translate(-50%, 40px); opacity: 0;
  transition: transform .35s cubic-bezier(.2,.8,.2,1), opacity .25s; background: #07102A; border: 1px solid rgba(255,255,255,0.1);
  border-radius: 22px 22px 0 0; overflow-y: auto; padding: 26px clamp(16px, 3vw, 36px) 60px; color: ${C.text};
  font-family: Inter, ui-sans-serif, system-ui, sans-serif; --cs-display: 'Big Shoulders Display', 'Arial Narrow', Impact, sans-serif; }
.cs-drill.open .cs-sheet { transform: translate(-50%, 0); opacity: 1; }
.cs-sheet .cs-num, .cs-sheet .cs-display { font-family: var(--cs-display); font-variant-numeric: tabular-nums; }
.cs-sheet .cs-close { position: sticky; top: 0; float: right; z-index: 2; background: rgba(15,23,42,0.95); border: 1px solid rgba(255,255,255,0.12); color: ${C.text};
  width: 38px; height: 38px; border-radius: 50%; font-size: 20px; cursor: pointer; }
.cs-sheet .cs-crumbs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12.5px; color: ${C.muted}; margin-bottom: 8px; }
.cs-sheet .cs-crumbs button { background: none; border: 0; color: ${C.silver}; font: inherit; cursor: pointer; padding: 2px 0; text-decoration: underline; text-underline-offset: 3px; }
.cs-sheet h2 { font-family: var(--cs-display); font-weight: 800; font-size: clamp(30px, 5vw, 48px); line-height: 0.95; margin: 0 0 10px; padding-right: 50px; }
.cs-sheet .cs-d-status { font-size: 13px; line-height: 1.5; padding: 10px 14px; border-radius: 10px; border-left: 3px solid var(--st);
  background: color-mix(in srgb, var(--st) 10%, transparent); margin: 10px 0 20px; max-width: 72ch; }
.cs-sheet .cs-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
.cs-sheet .cs-kpi { background: rgba(15,23,42,0.8); border: 1px solid ${C.line}; border-radius: 14px; padding: 14px 16px; }
.cs-sheet .cs-kpi .cs-k { font-size: 12px; color: ${C.muted}; }
.cs-sheet .cs-kpi .cs-num { font-size: 30px; font-weight: 700; line-height: 1.05; margin-top: 4px; }
.cs-sheet .cs-kpi .cs-ly { font-size: 12px; color: ${C.muted}; margin-top: 2px; }
.cs-sheet .cs-panel { background: rgba(15,23,42,0.6); border: 1px solid ${C.line}; border-radius: 18px; padding: 18px 18px 14px; margin-bottom: 18px; }
.cs-sheet .cs-panel h3 { font-family: var(--cs-display); font-weight: 700; font-size: 24px; margin: 0 0 4px; }
.cs-sheet .cs-panel .cs-p-sub { font-size: 12.5px; color: ${C.muted}; margin: 0 0 14px; line-height: 1.5; max-width: 80ch; }
.cs-sheet .cs-chart { position: relative; height: 320px; }
.cs-sheet .cs-chart.short { height: 260px; }
.cs-sheet .cs-two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.cs-sheet .cs-fc { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 14px; }
.cs-sheet .cs-fc div { font-size: 12px; color: ${C.muted}; }
.cs-sheet .cs-fc .cs-num { font-size: 24px; color: ${C.text}; display: block; margin-top: 2px; }
.cs-sheet .cs-conf-high { color: ${C.green}; } .cs-sheet .cs-conf-medium { color: ${C.amber}; } .cs-sheet .cs-conf-low { color: ${C.red}; }
.cs-sheet .cs-heat { display: grid; gap: 3px; font-size: 11px; overflow-x: auto; }
.cs-sheet .cs-heat .cs-h-row { display: grid; grid-template-columns: 150px repeat(12, minmax(34px, 1fr)); gap: 3px; align-items: center; }
.cs-sheet .cs-heat .cs-h-lab { color: #CBD5E1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
.cs-sheet .cs-heat .cs-h-cell { height: 26px; border-radius: 4px; background: rgba(255,255,255,0.03); }
.cs-sheet .cs-heat .cs-h-head { color: ${C.muted}; text-align: center; }
.cs-sheet table.cs-t { width: 100%; border-collapse: collapse; font-size: 13px; }
.cs-sheet table.cs-t th { text-align: left; font-weight: 500; color: ${C.muted}; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid ${C.line}; }
.cs-sheet table.cs-t td { padding: 8px; border-bottom: 1px solid ${C.line}; vertical-align: top; }
.cs-sheet table.cs-t td.r, .cs-sheet table.cs-t th.r { text-align: right; font-variant-numeric: tabular-nums; }
.cs-sheet .cs-code { color: ${C.muted}; font-size: 11.5px; }
.cs-sheet .cs-children { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.cs-sheet .cs-child { text-align: left; font: inherit; color: inherit; cursor: pointer; background: rgba(2,6,23,0.6); border: 1px solid ${C.line}; border-radius: 12px; padding: 12px 14px; }
.cs-sheet .cs-child:hover, .cs-sheet .cs-child:focus-visible { border-color: rgba(255,122,26,0.55); outline: none; }
.cs-sheet .cs-child .cs-num { font-size: 22px; }
.cs-sheet .cs-child .cs-ch-n { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.cs-sheet .cs-child .cs-ch-k { font-size: 11.5px; color: ${C.muted}; }
.cs-sheet .cs-lapsed li { font-size: 13px; line-height: 1.5; margin-bottom: 6px; }
.cs-sheet .cs-loading { color: ${C.muted}; font-size: 13px; padding: 30px 0; }
.cs-sheet button:focus-visible { outline: 2px solid ${C.orange}; outline-offset: 2px; }
@media (max-width: 760px) {
  #customerspend .cs-stage { height: 320px; }
  .cs-sheet .cs-two { grid-template-columns: 1fr; }
  .cs-drill .cs-sheet { top: 0; border-radius: 0; }
  .cs-sheet .cs-chart { height: 260px; }
}
@media (prefers-reduced-motion: reduce) { .cs-drill .cs-sheet, .cs-drill .cs-backdrop { transition: none; } }
`;
    document.head.appendChild(s);
  }

  // ───────────────────────── page shell ─────────────────────────
  function installPage() {
    if (document.getElementById(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="salesinvoices"]') || document.querySelector('.nav-link[data-page]');
    const anchorPage = document.getElementById('salesinvoices') || document.querySelector('.dashboard-page');
    if (!anchorBtn || !anchorPage) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>📈 Customer Spend</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `
      <div class="cs-head">
        <div>
          <h2 class="cs-title">Customer Spend</h2>
          <p class="cs-sub">Invoiced spend from Xero, refreshed every morning at 5:30. Open any customer to see their full history, what they buy, when they buy it and where they're heading.</p>
        </div>
        <div class="cs-totals" id="csTotals"></div>
      </div>
      <div class="cs-stage" id="csStage">
        <div class="cs-stage-fallback">Building the spend landscape…</div>
      </div>
      <div class="cs-section-h"><h3>Needs a call</h3><p id="csAlertsSub"></p></div>
      <div class="cs-alerts" id="csAlerts"></div>
      <div class="cs-section-h"><h3>Customers</h3><p id="csGridSub"></p></div>
      <div class="cs-controls">
        <div class="cs-seg" role="group" aria-label="Show">
          <button type="button" data-level="group" class="on">Customer groups</button>
          <button type="button" data-level="account">Individual accounts</button>
        </div>
        <div class="cs-seg" role="group" aria-label="Sort">
          <button type="button" data-sort="spend" class="on">Biggest</button>
          <button type="button" data-sort="growth">Growing</button>
          <button type="button" data-sort="decline">Shrinking</button>
          <button type="button" data-sort="attention">Needs a call</button>
        </div>
        <input class="cs-search" id="csSearch" type="search" placeholder="Find a customer" aria-label="Find a customer">
      </div>
      <div class="cs-grid" id="csGrid"><div class="cs-empty">Loading customers…</div></div>
      <button type="button" class="cs-btn cs-more" id="csMore" hidden>Show all customers</button>`;
    anchorPage.parentElement.appendChild(sec);

    const drill = document.createElement('div');
    drill.className = 'cs-drill';
    drill.id = 'csDrill';
    drill.setAttribute('role', 'dialog');
    drill.setAttribute('aria-modal', 'true');
    drill.innerHTML = '<div class="cs-backdrop"></div><div class="cs-sheet" id="csSheet" tabindex="-1"></div>';
    document.body.appendChild(drill);

    // navigation: app.js binds its nav buttons once at startup, so it doesn't
    // know about this page - handle show/hide here
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (!state.loaded) loadAll(); else landscape.resume();
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); landscape.pause(); }
    }, true);

    sec.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () => {
      state.level = b.dataset.level; state.showAll = false;
      sec.querySelectorAll('[data-level]').forEach(x => x.classList.toggle('on', x === b));
      renderGrid();
    }));
    sec.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
      state.sort = b.dataset.sort;
      sec.querySelectorAll('[data-sort]').forEach(x => x.classList.toggle('on', x === b));
      renderGrid();
    }));
    sec.querySelector('#csSearch').addEventListener('input', e => { state.search = e.target.value.trim().toLowerCase(); renderGrid(); });
    sec.querySelector('#csMore').addEventListener('click', () => { state.showAll = true; renderGrid(); });

    drill.querySelector('.cs-backdrop').addEventListener('click', closeDrill);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && drill.classList.contains('open')) closeDrill(); });
    return true;
  }

  // ───────────────────────── data load ─────────────────────────
  async function loadAll() {
    state.loaded = true;
    try {
      const [sg, sa, ag, aa, mg, ma] = await Promise.all([
        rpc('get_customer_spend_summary', { p_level: 'group' }),
        rpc('get_customer_spend_summary', { p_level: 'account' }),
        rpc('get_customer_spend_alerts', { p_level: 'group' }),
        rpc('get_customer_spend_alerts', { p_level: 'account' }),
        rpc('get_customer_spend_matrix', { p_level: 'group', p_months: 36 }),
        rpc('get_customer_spend_matrix', { p_level: 'account', p_months: 36 })
      ]);
      state.summary = { group: sg.rows || [], account: sa.rows || [] };
      state.alerts = { group: indexAlerts(ag.rows), account: indexAlerts(aa.rows) };
      state.alertRows = aa.rows || [];
      state.matrix = { group: mg, account: ma };
      state.asOf = sg.as_of;
      renderTotals();
      renderAlerts();
      renderGrid();
      landscape.build();
    } catch (err) {
      state.loaded = false;
      console.error('[customer_spend]', err);
      const msg = /permission|JWT|auth/i.test(err.message)
        ? 'Your session has expired. Sign out and back in, then open this tab again.'
        : 'Couldn\'t load spend data (' + esc(err.message) + '). Refresh the page to try again.';
      document.getElementById('csGrid').innerHTML = `<div class="cs-error">${msg}</div>`;
      document.getElementById('csStage').innerHTML = `<div class="cs-stage-fallback">${msg}</div>`;
    }
  }
  function indexAlerts(rows) { const m = {}; (rows || []).forEach(r => { m[r.key] = r; }); return m; }

  function renderTotals() {
    const rows = state.summary.group;
    const l12 = sum(rows.map(r => r.l12m)), l12p = sum(rows.map(r => r.l12m_prev));
    const ytd = sum(rows.map(r => r.ytd)), ytdly = sum(rows.map(r => r.ytd_ly));
    const active = rows.filter(r => num(r.l12m) > 0).length;
    document.getElementById('csTotals').innerHTML = `
      <div class="cs-total"><div class="cs-num">${money(ytd, true)}</div><div class="cs-k">Year to date ${deltaHtml(ytd, ytdly, 'vs last year')}</div></div>
      <div class="cs-total"><div class="cs-num">${money(l12, true)}</div><div class="cs-k">Last 12 months ${deltaHtml(l12, l12p)}</div></div>
      <div class="cs-total"><div class="cs-num">${active}</div><div class="cs-k">Customers buying this year</div></div>`;
  }

  function alertWhy(a) {
    if (a.status === 'gone_quiet') return `No invoice for ${a.days_since_last} days. They usually order every ${a.usual_gap_days || '?'} days.`;
    return `Last 30 days ${money(a.last_30d)} against a usual ${money(a.expected_30d)} (${a.pct_of_usual_30d}% of normal).`;
  }

  function renderAlerts() {
    const rows = state.alertRows;
    const el = document.getElementById('csAlerts');
    document.getElementById('csAlertsSub').textContent = rows.length
      ? `${rows.length} account${rows.length === 1 ? '' : 's'} below their usual pattern`
      : '';
    if (!rows.length) { el.innerHTML = '<div class="cs-empty" style="padding:14px 0;text-align:left">Every regular customer is buying at their usual pace.</div>'; return; }
    el.innerHTML = rows.map((a, i) => {
      const st = STATUS[a.status] || STATUS.watch;
      return `<button type="button" class="cs-alert" style="--st:${st.color}" data-i="${i}">
        <div class="cs-pill">${st.label}</div>
        <div class="cs-a-name">${esc(a.label)}</div>
        ${a.parent ? `<div class="cs-a-parent">${esc(a.parent)}</div>` : '<div class="cs-a-parent">&nbsp;</div>'}
        <div class="cs-a-why">${alertWhy(a)}</div></button>`;
    }).join('');
    el.querySelectorAll('.cs-alert').forEach(b => b.addEventListener('click', () => {
      const a = rows[+b.dataset.i];
      const stack = [];
      if (a.parent && a.parent !== a.key) stack.push({ level: 'group', key: a.parent, label: a.parent });
      stack.push({ level: 'account', key: a.key, label: a.label });
      openDrill(stack);
    }));
  }

  // ───────────────────────── cards ─────────────────────────
  function sparkline(vals, monthKeys) {
    const v = vals.slice(-25).map(num);
    const f = buildForecast(vals, monthKeys);
    const fc = f.months.slice(1, 4).map(m => m.pred);
    const all = v.concat(fc);
    const max = Math.max(1, ...all), W = 240, H = 46, n = all.length;
    const x = i => (i / (n - 1)) * W, y = val => H - 3 - (Math.max(0, val) / max) * (H - 8);
    const cur = v.slice(0, -1);
    const pts = cur.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
    const area = `0,${H} ${pts} ${x(cur.length - 1).toFixed(1)},${H}`;
    const fcStart = cur.length - 1;
    const fpts = [cur[cur.length - 1]].concat([f.months[0].pred], fc)
      .map((val, i) => `${x(fcStart + i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${area}" fill="${C.orangeSoft}"/>
      <polyline points="${pts}" fill="none" stroke="${C.orange}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
      <polyline points="${fpts}" fill="none" stroke="${C.silver}" stroke-width="1.5" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function renderGrid() {
    const level = state.level;
    const rows = (state.summary[level] || []).filter(r => num(r.l12m) > 0 || num(r.ytd) > 0);
    const mx = state.matrix[level] || { months: [], series: {} };
    const al = state.alerts[level] || {};
    let list = rows.filter(r => !state.search || String(r.label).toLowerCase().includes(state.search) || String(r.parent || '').toLowerCase().includes(state.search));
    const growth = r => { const p = pctChange(r.l12m, r.l12m_prev); return p === null ? 0 : p; };
    const sevRank = { gone_quiet: 3, under: 2, watch: 1 };
    if (state.sort === 'growth') list = list.filter(r => num(r.l12m_prev) > 500).sort((a, b) => growth(b) - growth(a));
    else if (state.sort === 'decline') list = list.filter(r => num(r.l12m_prev) > 500).sort((a, b) => growth(a) - growth(b));
    else if (state.sort === 'attention') list = list.filter(r => al[r.key]).sort((a, b) => (sevRank[al[b.key].status] - sevRank[al[a.key].status]) || (num(al[b.key].gap_gbp) - num(al[a.key].gap_gbp)));
    else list.sort((a, b) => num(b.l12m) - num(a.l12m));

    document.getElementById('csGridSub').textContent = `${list.length} ${level === 'group' ? 'customer groups' : 'accounts'}`;
    const limit = state.showAll || state.search ? list.length : 48;
    const grid = document.getElementById('csGrid');
    if (!list.length) {
      grid.innerHTML = `<div class="cs-empty">${state.search ? 'No customer matches “' + esc(state.search) + '”.' : 'Nothing to show for this sort.'}</div>`;
      document.getElementById('csMore').hidden = true;
      return;
    }
    grid.innerHTML = list.slice(0, limit).map((r, i) => {
      const a = al[r.key];
      const series = mx.series[r.key];
      const dot = a ? `<span class="cs-c-dot" style="background:${STATUS[a.status].color}" title="${STATUS[a.status].label}"></span>` : '';
      return `<button type="button" class="cs-card" data-i="${i}">
        ${dot}
        <div class="cs-c-name">${esc(r.label)}</div>
        <div class="cs-num">${money(r.l12m, true)}</div>
        <div class="cs-c-k">last 12 months ${deltaHtml(r.l12m, r.l12m_prev)}</div>
        ${series ? sparkline(series, mx.months) : '<svg></svg>'}
        <div class="cs-c-foot"><span>This month ${money(r.mtd, true)}</span><span>Last invoice ${daysAgo(r.days_since_last_invoice)}</span></div>
      </button>`;
    }).join('');
    const shown = list.slice(0, limit);
    grid.querySelectorAll('.cs-card').forEach(b => b.addEventListener('click', () => {
      const r = shown[+b.dataset.i];
      const stack = [];
      if (level === 'account' && r.parent && r.parent !== r.key) stack.push({ level: 'group', key: r.parent, label: r.parent });
      stack.push({ level, key: r.key, label: r.label });
      openDrill(stack);
    }));
    document.getElementById('csMore').hidden = shown.length >= list.length;
  }

  // ───────────────────────── drill-down ─────────────────────────
  function destroyCharts() { state.charts.forEach(c => { try { c.destroy(); } catch (e) { } }); state.charts = []; }

  function openDrill(stack) {
    state.drillStack = stack;
    const d = document.getElementById('csDrill');
    d.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderDrill();
    setTimeout(() => document.getElementById('csSheet').focus(), 50);
  }
  function closeDrill() {
    destroyCharts();
    document.getElementById('csDrill').classList.remove('open');
    document.body.style.overflow = '';
  }

  const childLevel = { group: 'account', account: 'branch', branch: null };

  async function renderDrill() {
    destroyCharts();
    const sheet = document.getElementById('csSheet');
    const node = state.drillStack[state.drillStack.length - 1];
    const crumbs = state.drillStack.slice(0, -1).map((n, i) => `<button type="button" data-crumb="${i}">${esc(n.label)}</button><span aria-hidden="true">›</span>`).join('');
    sheet.innerHTML = `<button type="button" class="cs-close" aria-label="Close">×</button>
      <div class="cs-crumbs">${crumbs || '<span>' + (node.level === 'group' ? 'Customer group' : node.level === 'account' ? 'Account' : 'Branch / contact') + '</span>'}</div>
      <h2>${esc(node.label)}</h2><div class="cs-loading">Loading ${esc(node.label)}…</div>`;
    sheet.scrollTop = 0;
    sheet.querySelector('.cs-close').addEventListener('click', closeDrill);
    sheet.querySelectorAll('[data-crumb]').forEach(b => b.addEventListener('click', () => {
      state.drillStack = state.drillStack.slice(0, +b.dataset.crumb + 1); renderDrill();
    }));

    try {
      const cl = childLevel[node.level];
      const parentLevel = node.level === 'group' ? null : node.level === 'account' ? 'group' : 'account';
      const parentKey = state.drillStack.length > 1 ? state.drillStack[state.drillStack.length - 2].key : null;
      const [selfSummary, children, monthly, mix] = await Promise.all([
        node.level === 'branch'
          ? rpc('get_customer_spend_summary', { p_level: 'branch', p_parent: parentKey })
          : Promise.resolve({ rows: state.summary[node.level] }),
        cl ? rpc('get_customer_spend_summary', { p_level: cl, p_parent: node.key }) : Promise.resolve({ rows: [] }),
        state.matrix[node.level] && state.matrix[node.level].series[node.key]
          ? Promise.resolve(null)
          : rpc('get_customer_spend_monthly', { p_level: node.level, p_key: node.key, p_months: 36 }),
        rpc('get_customer_product_mix', { p_level: node.level, p_key: node.key, p_top: 15 })
      ]);
      if (state.drillStack[state.drillStack.length - 1] !== node) return; // navigated away meanwhile

      const s = (selfSummary.rows || []).find(r => r.key === node.key) || {};
      let months, vals;
      if (monthly) { months = monthly.months.map(m => m.month); vals = monthly.months.map(m => num(m.net)); }
      else { months = state.matrix[node.level].months; vals = state.matrix[node.level].series[node.key].map(num); }
      const kids = (children.rows || []).filter(r => num(r.l12m) !== 0 || num(r.ytd) !== 0);

      // a group with a single account: skip straight to the account
      if (node.level === 'group' && kids.length === 1 && kids[0].key === node.key) {
        state.drillStack[state.drillStack.length - 1] = { level: 'account', key: node.key, label: node.label };
        return renderDrill();
      }
      const alert = (state.alerts[node.level] || {})[node.key];
      paintDrill(sheet, node, s, months, vals, kids, cl, mix, alert);
    } catch (err) {
      console.error('[customer_spend]', err);
      sheet.querySelector('.cs-loading').outerHTML = `<div class="cs-error" style="text-align:left">Couldn't load this customer (${esc(err.message)}).</div>`;
    }
  }

  function paintDrill(sheet, node, s, months, vals, kids, cl, mix, alert) {
    const fc = buildForecast(vals, months);
    const st = alert ? STATUS[alert.status] : null;
    const confCls = 'cs-conf-' + fc.confidence;

    const kpi = (k, cur, ly, lyLabel) => `<div class="cs-kpi"><div class="cs-k">${k}</div><div class="cs-num">${money(cur)}</div>
      <div class="cs-ly">${money(ly)} ${lyLabel} ${deltaHtml(cur, ly)}</div></div>`;

    const html = `
      ${st ? `<div class="cs-d-status" style="--st:${st.color}"><b style="color:${st.color}">${st.label}.</b> ${alertWhy(alert)}</div>` : ''}
      <div class="cs-kpis">
        ${kpi('This week', s.wtd, s.wtd_ly, 'same week last year')}
        ${kpi('This month', s.mtd, s.mtd_ly, 'last year')}
        ${kpi('This quarter', s.qtd, s.qtd_ly, 'last year')}
        ${kpi('Year to date', s.ytd, s.ytd_ly, 'last year')}
        <div class="cs-kpi"><div class="cs-k">Typical invoice</div><div class="cs-num">${money(s.avg_invoice_l12m)}</div>
          <div class="cs-ly">${num(s.invoices_l12m)} invoices in 12 months, last ${daysAgo(s.days_since_last_invoice)}</div></div>
      </div>

      <div class="cs-panel">
        <h3>Spend over time, and where it's heading</h3>
        <p class="cs-p-sub">Monthly invoiced spend. The dashed line is the forecast, and the shaded band is the range it's likely to land in, sized from how far the same method missed over the last ${fc.tested || 6} months.</p>
        <div class="cs-chart"><canvas id="csTimeline"></canvas></div>
        <div class="cs-fc">
          <div>Projected finish this month<span class="cs-num">${money(fc.monthEnd)}</span>${money(fc.mtd)} so far, ${Math.round(fc.frac * 100)}% through the month</div>
          <div>Next 6 months forecast<span class="cs-num">${money(fc.next6)}</span>${fc.ly6 > 0 ? `${money(fc.ly6)} same months last year ${deltaHtml(fc.next6, fc.ly6)}` : 'no spend in the same months last year'}</div>
          <div>Forecast confidence<span class="cs-num ${confCls}">${fc.confText.split(':')[0]}</span>${fc.confText.includes(':') ? fc.confText.split(':')[1].trim() + '. ' : ''}${fc.tested ? `Tested on their last few months: 3-month totals landed within ±${Math.round(fc.wape3 * 100)}%, single months within ±${Math.round(fc.wape * 100)}%. Method: ${fc.modelLabel}.` : ''}</div>
        </div>
      </div>

      <div class="cs-two">
        <div class="cs-panel">
          <h3>What they buy</h3>
          <p class="cs-p-sub">Spend by product type, last 12 months against the 12 before.</p>
          <div class="cs-chart short"><canvas id="csMix"></canvas></div>
        </div>
        <div class="cs-panel">
          <h3>When they buy it</h3>
          <p class="cs-p-sub">Average spend per calendar month by product type, across every year on record. Darker means more.</p>
          <div id="csHeat"></div>
        </div>
      </div>

      <div class="cs-panel">
        <h3>Top products</h3>
        <p class="cs-p-sub">Ranked by the last 12 months.</p>
        <div style="overflow-x:auto" id="csTop"></div>
      </div>

      <div id="csLapsedWrap"></div>
      <div id="csKidsWrap"></div>`;
    sheet.querySelector('.cs-loading').outerHTML = html;

    drawTimeline(months, vals, fc);
    drawMix(mix.by_type || []);
    drawHeat(mix.seasonality || []);
    drawTop(mix.top_products || []);

    const lapsed = mix.lapsed_products || [];
    if (lapsed.length) {
      document.getElementById('csLapsedWrap').innerHTML = `<div class="cs-panel" style="border-color:rgba(245,184,61,0.35)">
        <h3>Stopped ordering</h3>
        <p class="cs-p-sub">Products they bought regularly (in 3 or more months of the previous year) and haven't ordered for 90 days or more.</p>
        <ul class="cs-lapsed">${lapsed.map(p => `<li><b>${esc(p.product_name)}</b> <span class="cs-code">${esc(p.item_code || '')}</span>, ${esc(p.product_type)}. Last ordered ${daysAgo(p.days_since)}.</li>`).join('')}</ul></div>`;
    }

    if (cl && kids.length) {
      const noun = cl === 'account' ? 'Accounts' : 'Branches and contacts';
      const kAl = state.alerts[cl] || {};
      document.getElementById('csKidsWrap').innerHTML = `<div class="cs-panel">
        <h3>${noun}</h3>
        <p class="cs-p-sub">${kids.length} ${noun.toLowerCase()} under ${esc(node.label)}. Open one to see its own history.${cl === 'branch' ? ' Branch detail comes from DecoNetwork orders, so it starts in April 2026.' : ''}</p>
        <div class="cs-children">${kids.map((k, i) => {
          const a = kAl[k.key];
          return `<button type="button" class="cs-child" data-k="${i}">
            <div class="cs-ch-n">${a ? `<span style="color:${STATUS[a.status].color}">●</span> ` : ''}${esc(k.label)}</div>
            <div class="cs-num">${money(k.l12m, true)}</div>
            <div class="cs-ch-k">last 12 months ${deltaHtml(k.l12m, k.l12m_prev)}</div>
            <div class="cs-ch-k">Last invoice ${daysAgo(k.days_since_last_invoice)}</div></button>`;
        }).join('')}</div></div>`;
      document.querySelectorAll('#csKidsWrap .cs-child').forEach(b => b.addEventListener('click', () => {
        const k = kids[+b.dataset.k];
        state.drillStack.push({ level: cl, key: k.key, label: k.label });
        renderDrill();
      }));
    }
  }

  function chartDefaults() {
    if (!window.Chart) return false;
    Chart.defaults.color = C.muted;
    Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
    return true;
  }

  function drawTimeline(months, vals, fc) {
    if (!chartDefaults()) return;
    let start = firstMeaningful(vals.slice(0, -1).map(num));
    if (start >= vals.length - 1) start = Math.max(0, vals.length - 2);
    const hm = months.slice(start), hv = vals.slice(start);
    const n = hm.length;
    const fcMonths = fc.months.slice(1).map(m => m.key);
    const labels = hm.concat(fcMonths);
    const L = labels.length;
    const actual = hv.map((v, i) => i === n - 1 ? null : v).concat(Array(fcMonths.length).fill(null));
    const partial = Array(L).fill(null); partial[n - 1] = hv[n - 1];
    const lastYear = labels.map((k, i) => { const j = months.indexOf(addMonths(k, -12)); return j >= 0 && j >= start ? vals[j] : null; });
    const fcLine = Array(L).fill(null), lo = Array(L).fill(null), hi = Array(L).fill(null);
    if (n >= 2) { fcLine[n - 2] = hv[n - 2]; lo[n - 2] = hv[n - 2]; hi[n - 2] = hv[n - 2]; }
    fc.months.forEach((m, k) => { const i = n - 1 + k; fcLine[i] = m.pred; lo[i] = m.lo; hi[i] = m.hi; });

    const ctx = document.getElementById('csTimeline');
    const grad = ctx.getContext('2d').createLinearGradient(0, 0, 0, 320);
    grad.addColorStop(0, 'rgba(255,122,26,0.95)'); grad.addColorStop(1, 'rgba(255,122,26,0.35)');
    state.charts.push(new Chart(ctx, {
      data: {
        labels: labels.map(k => monthLabel(k, true)),
        datasets: [
          { type: 'bar', label: 'Spend', data: actual, backgroundColor: grad, borderRadius: 4, order: 3 },
          { type: 'bar', label: 'This month so far', data: partial, backgroundColor: 'rgba(255,122,26,0.45)', borderColor: C.orange, borderWidth: 1, borderDash: [3, 3], borderRadius: 4, order: 3 },
          { type: 'line', label: 'Same month last year', data: lastYear, borderColor: C.silverDim, borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: true, order: 2 },
          { type: 'line', label: 'Likely range', data: hi, borderWidth: 0, pointRadius: 0, fill: false, order: 1 },
          { type: 'line', label: 'Likely range low', data: lo, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(184,196,210,0.14)', order: 1 },
          { type: 'line', label: 'Forecast', data: fcLine, borderColor: C.silver, borderDash: [6, 5], borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.silver, tension: 0.25, order: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 700 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { grid: { color: C.line }, ticks: { callback: v => money(v, true) } }
        },
        plugins: {
          legend: { labels: { boxWidth: 10, boxHeight: 10, filter: i => i.text !== 'Likely range low' } },
          tooltip: {
            filter: i => i.raw != null && i.dataset.label !== 'Likely range low',
            callbacks: {
              label: i => {
                if (i.dataset.label === 'Likely range') return 'Likely range: ' + money(lo[i.dataIndex]) + ' to ' + money(hi[i.dataIndex]);
                return i.dataset.label + ': ' + money(i.raw);
              }
            }
          }
        }
      }
    }));
  }

  function drawMix(rows) {
    if (!chartDefaults()) return;
    const r = rows.filter(x => x.product_type !== 'Shipping' && (num(x.l12m) > 0 || num(x.l12m_prev) > 0)).slice(0, 9);
    const el = document.getElementById('csMix');
    if (!r.length) { el.parentElement.innerHTML = '<div class="cs-empty">No product detail on these invoices.</div>'; return; }
    state.charts.push(new Chart(el, {
      type: 'bar',
      data: {
        labels: r.map(x => x.product_type),
        datasets: [
          { label: 'Last 12 months', data: r.map(x => num(x.l12m)), backgroundColor: C.orange, borderRadius: 4 },
          { label: '12 months before', data: r.map(x => num(x.l12m_prev)), backgroundColor: C.silverDim, borderRadius: 4 }
        ]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 600 },
        scales: { x: { grid: { color: C.line }, ticks: { callback: v => money(v, true) } }, y: { grid: { display: false } } },
        plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { callbacks: { label: i => i.dataset.label + ': ' + money(i.raw) } } }
      }
    }));
  }

  function drawHeat(rows) {
    const el = document.getElementById('csHeat');
    const byType = {};
    rows.forEach(r => { if (r.product_type === 'No line detail') return; (byType[r.product_type] = byType[r.product_type] || Array(12).fill(0))[r.month - 1] = num(r.avg_net); });
    const types = Object.keys(byType).sort((a, b) => sum(byType[b]) - sum(byType[a])).slice(0, 8);
    if (!types.length) { el.innerHTML = '<div class="cs-empty">No product detail to show a pattern yet.</div>'; return; }
    const mnames = Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).toLocaleDateString('en-GB', { month: 'short' }).slice(0, 3));
    el.className = 'cs-heat';
    el.innerHTML = `<div class="cs-h-row"><span></span>${mnames.map(m => `<span class="cs-h-head">${m}</span>`).join('')}</div>` +
      types.map(t => {
        const v = byType[t], mx = Math.max(1, ...v);
        return `<div class="cs-h-row"><span class="cs-h-lab" title="${esc(t)}">${esc(t)}</span>${v.map((x, i) => {
          const a = x > 0 ? 0.12 + 0.88 * (x / mx) : 0;
          return `<span class="cs-h-cell" style="background:${a ? `rgba(255,122,26,${a.toFixed(2)})` : 'rgba(255,255,255,0.03)'}" title="${esc(t)}, ${mnames[i]}: ${money(x)} on average"></span>`;
        }).join('')}</div>`;
      }).join('');
  }

  function drawTop(rows) {
    const el = document.getElementById('csTop');
    if (!rows.length) { el.innerHTML = '<div class="cs-empty">No product detail on these invoices.</div>'; return; }
    el.innerHTML = `<table class="cs-t"><thead><tr><th>Product</th><th>Type</th><th class="r">Qty (12 mo)</th><th class="r">Spend (12 mo)</th><th class="r">Months bought</th><th class="r">Last ordered</th></tr></thead><tbody>
      ${rows.map(p => `<tr><td>${esc(p.product_name)} <span class="cs-code">${esc(p.item_code || '')}</span></td><td>${esc(p.product_type)}</td>
        <td class="r">${num(p.qty_l12m).toLocaleString('en-GB')}</td><td class="r">${money(p.l12m)}</td>
        <td class="r">${num(p.months_bought_l12m)} of 12</td><td class="r">${p.last_bought ? new Date(p.last_bought).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : ''}</td></tr>`).join('')}
    </tbody></table>`;
  }

  // ───────────────────────── 3D spend landscape ─────────────────────────
  const landscape = (function () {
    let renderer, scene, camera, raf = null, running = false, built = false;
    let bars = [], rowsMeta = [], hovered = null, tip, stage;
    let az = -0.62, el = 0.52, dist = 30, target = { x: 0, y: 1.5, z: 0 };
    let dragging = false, lastX = 0, lastY = 0, idleSince = 0, startT = 0, moved = 0;
    const raycaster = { obj: null }, mouse = { x: 0, y: 0 };

    function loadThree() {
      if (window.THREE) return Promise.resolve();
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = THREE_URL; s.onload = res; s.onerror = () => rej(new Error('3D library failed to load'));
        document.head.appendChild(s);
      });
    }

    function textSprite(text, color, size) {
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d');
      const fontPx = 64;
      ctx.font = `600 ${fontPx}px Inter, sans-serif`;
      const w = Math.ceil(ctx.measureText(text).width) + 20;
      cv.width = w; cv.height = fontPx + 24;
      ctx.font = `600 ${fontPx}px Inter, sans-serif`;
      ctx.fillStyle = color; ctx.textBaseline = 'middle';
      ctx.fillText(text, 10, cv.height / 2);
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      const h = size || 0.55;
      sp.scale.set(h * (cv.width / cv.height), h, 1);
      return sp;
    }

    function place() {
      camera.position.set(target.x + dist * Math.cos(el) * Math.sin(az), target.y + dist * Math.sin(el), target.z + dist * Math.cos(el) * Math.cos(az));
      camera.lookAt(target.x, target.y, target.z);
    }

    async function build() {
      stage = document.getElementById('csStage');
      if (built || !stage) return;
      try { await loadThree(); } catch (e) {
        stage.innerHTML = '<div class="cs-stage-fallback">The 3D view needs a connection to load. Everything below still works.</div>';
        return;
      }
      built = true;
      const mx = state.matrix.group;
      const top = state.summary.group.filter(r => mx.series[r.key]).sort((a, b) => num(b.l12m) - num(a.l12m)).slice(0, 12);
      const months = mx.months;
      const H_MONTHS = 24;
      const startIdx = months.length - H_MONTHS - 1;        // 24 complete months + current
      const cols = H_MONTHS + 1 + FORECAST_MONTHS;
      const colKeys = months.slice(startIdx).concat(Array.from({ length: FORECAST_MONTHS }, (_, k) => addMonths(months[months.length - 1], k + 1)));

      const grid = top.map(r => {
        const s = mx.series[r.key].map(num);
        const f = buildForecast(s, months);
        const actual = s.slice(startIdx);
        const fcv = f.months.slice(1).map(m => m.pred);
        return { r, vals: actual.concat(fcv), nActual: actual.length };
      });
      const maxV = Math.max(1, ...grid.flatMap(g => g.vals.slice(0, g.nActual)));
      const hOf = v => 7.5 * Math.sqrt(Math.max(0, v) / maxV);

      stage.innerHTML = '';
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      stage.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x020617, 34, 70);
      camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

      scene.add(new THREE.HemisphereLight(0xdfe7f2, 0x0b1224, 0.75));
      const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(-10, 18, 12); scene.add(key);
      const rim = new THREE.DirectionalLight(0xff7a1a, 0.35); rim.position.set(12, 6, -14); scene.add(rim);

      const spacingX = 0.95, spacingZ = 1.35, size = 0.62;
      const w = cols * spacingX, d = top.length * spacingZ;
      const x0 = -w / 2, z0 = -d / 2;

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(w + 6, d + 6), new THREE.MeshStandardMaterial({ color: 0x0a1330, roughness: 1 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; scene.add(floor);
      const gridHelper = new THREE.GridHelper(Math.max(w, d) + 6, Math.round((Math.max(w, d) + 6) / spacingX), 0x1e293b, 0x111a33);
      gridHelper.position.y = 0.001; scene.add(gridHelper);

      // divider between actual and forecast
      const divX = x0 + (H_MONTHS + 1) * spacingX - spacingX / 2 + spacingX / 2;
      const divider = new THREE.Mesh(new THREE.PlaneGeometry(0.03, d + 2), new THREE.MeshBasicMaterial({ color: 0xb8c4d2, transparent: true, opacity: 0.5 }));
      divider.rotation.x = -Math.PI / 2; divider.position.set(divX, 0.01, 0); scene.add(divider);

      const geo = new THREE.BoxGeometry(size, 1, size); geo.translate(0, 0.5, 0);
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const orange = new THREE.Color(C.orange), deep = new THREE.Color('#7C2D12');
      bars = []; rowsMeta = [];
      grid.forEach((g, zi) => {
        const z = z0 + zi * spacingZ + spacingZ / 2;
        rowsMeta.push({ key: g.r.key, label: g.r.label });
        g.vals.forEach((v, xi) => {
          const x = x0 + xi * spacingX + spacingX / 2;
          const h = Math.max(0.02, hOf(v));
          const isFc = xi >= g.nActual;
          let mesh;
          if (isFc) {
            mesh = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xb8c4d2, transparent: true, opacity: 0.55 }));
          } else {
            const t = xi / (g.nActual - 1);
            const col = deep.clone().lerp(orange, 0.35 + 0.65 * t);
            const isCur = xi === g.nActual - 1;
            mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
              color: col, roughness: 0.45, metalness: 0.15, emissive: col, emissiveIntensity: isCur ? 0.35 : 0.08,
              transparent: isCur, opacity: isCur ? 0.7 : 1
            }));
          }
          mesh.position.set(x, 0, z);
          mesh.scale.y = reduceMotion ? h : 0.0001;
          mesh.userData = { h, v, row: zi, col: xi, isFc, month: colKeys[xi], label: g.r.label, key: g.r.key, isCur: !isFc && xi === g.nActual - 1 };
          scene.add(mesh); bars.push(mesh);
        });
        const lab = textSprite(g.r.label.length > 26 ? g.r.label.slice(0, 25) + '…' : g.r.label, '#CBD5E1', 0.5);
        lab.center.set(1, 0.5);
        lab.position.set(x0 - 0.4, 0.3, z); scene.add(lab);
      });
      // month labels along the front edge, every 6 months + forecast marker
      colKeys.forEach((k, xi) => {
        if (xi % 6 !== 0 && xi !== H_MONTHS + 1) return;
        const lab = textSprite(xi === H_MONTHS + 1 ? 'Forecast' : monthLabel(k, true), xi === H_MONTHS + 1 ? '#B8C4D2' : '#94A3B8', 0.42);
        lab.position.set(x0 + xi * spacingX + spacingX / 2, 0.25, z0 + d + 0.9); scene.add(lab);
      });

      target = { x: 1.2, y: 1.2, z: 0 };
      dist = Math.max(22, w * 0.95);

      tip = document.createElement('div'); tip.className = 'cs-tip'; stage.appendChild(tip);
      const cap = document.createElement('div'); cap.className = 'cs-stage-cap';
      cap.innerHTML = `<b>Your top 12 customers, month by month.</b> <span class="cs-key" style="background:${C.orange}"></span>invoiced <span class="cs-key" style="border:1px solid ${C.silver}"></span>forecast. Heights use a square-root scale so smaller customers stay visible. Drag to turn it, tap a bar to open that customer.`;
      stage.appendChild(cap);

      bindInput();
      resize();
      window.addEventListener('resize', resize);
      startT = performance.now(); idleSince = startT;
      resume();
    }

    function resize() {
      if (!renderer || !stage) return;
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      if (w < 600) dist = Math.max(dist, 34);
    }

    function pick(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      const v = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const rc = new THREE.Raycaster(); rc.setFromCamera(v, camera);
      rc.params.Line = { threshold: 0.05 };
      const hits = rc.intersectObjects(bars, false);
      return hits.length ? hits[0].object : null;
    }

    function setHover(obj, clientX, clientY) {
      if (hovered && hovered !== obj) {
        const u = hovered.userData;
        if (hovered.material.emissiveIntensity !== undefined) hovered.material.emissiveIntensity = u.isCur ? 0.35 : 0.08;
        else hovered.material.opacity = 0.55;
      }
      hovered = obj;
      if (!obj) { tip.style.display = 'none'; renderer.domElement.style.cursor = ''; return; }
      if (obj.material.emissiveIntensity !== undefined) obj.material.emissiveIntensity = 0.7; else obj.material.opacity = 1;
      const u = obj.userData;
      const rect = stage.getBoundingClientRect();
      tip.style.left = (clientX - rect.left) + 'px'; tip.style.top = (clientY - rect.top) + 'px';
      tip.innerHTML = `<div>${esc(u.label)}</div><div class="cs-num">${money(u.v)}</div><div style="color:${C.muted}">${monthLabel(u.month, true)}${u.isFc ? ', forecast' : u.isCur ? ', so far this month' : ''}</div>`;
      tip.style.display = 'block';
      renderer.domElement.style.cursor = 'pointer';
    }

    function bindInput() {
      const cv = renderer.domElement;
      cv.addEventListener('pointerdown', e => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener('pointermove', e => {
        if (dragging) {
          const dx = e.clientX - lastX, dy = e.clientY - lastY; moved += Math.abs(dx) + Math.abs(dy);
          az -= dx * 0.006; el = clamp(el + dy * 0.004, 0.18, 1.25);
          lastX = e.clientX; lastY = e.clientY; idleSince = performance.now();
          setHover(null);
        } else if (e.pointerType === 'mouse') {
          setHover(pick(e.clientX, e.clientY), e.clientX, e.clientY);
        }
      });
      cv.addEventListener('pointerup', e => {
        dragging = false;
        if (moved < 6) {
          const obj = pick(e.clientX, e.clientY);
          if (obj) {
            if (e.pointerType !== 'mouse' && hovered !== obj) { setHover(obj, e.clientX, e.clientY); return; }
            const u = obj.userData;
            openDrill([{ level: 'group', key: u.key, label: u.label }]);
          }
        }
      });
      cv.addEventListener('pointerleave', () => { if (!dragging) setHover(null); });
      cv.addEventListener('pointercancel', () => { dragging = false; });  // browser took over to scroll the page
    }

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const t = now - startT;
      // one-time entrance: bars grow in, sweeping through the months
      if (!reduceMotion) {
        let settling = false;
        for (const b of bars) {
          const u = b.userData;
          const delay = u.col * 28 + u.row * 18;
          const p = clamp((t - delay) / 700, 0, 1);
          const e = 1 - Math.pow(1 - p, 3);
          const target = u.h * e;
          if (Math.abs(b.scale.y - target) > 1e-4) { b.scale.y = Math.max(0.0001, target); settling = true; }
        }
        if (!dragging && now - idleSince > 4000) az += 0.0009;  // slow drift when left alone
        if (settling) idleSince = Math.max(idleSince, now - 3000);
      }
      place();
      renderer.render(scene, camera);
    }

    function resume() {
      if (!built || running) return;
      const sec = document.getElementById(PAGE_ID);
      if (!sec || !sec.classList.contains('active')) return;
      running = true; resize(); raf = requestAnimationFrame(frame);
    }
    function pause() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }

    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume(); });
    return { build, pause, resume };
  })();

  // ───────────────────────── boot ─────────────────────────
  function boot() {
    injectStyles();
    if (!installPage()) { setTimeout(boot, 300); return; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // exposed for testing in the browser console
  window.CustomerSpend = { buildForecast, reload: () => { state.loaded = false; return loadAll(); } };
})();
