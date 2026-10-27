// Stock tab: a copy of the old standalone "ATAM Stock" page (stock ledger, value calendar and projections), now inside ATAM GO.
// The old page stopped working: part of its data lived in a separate paused database, and its value tiles read data without
// signing in. This version reads everything from the main database with the signed-in person's login.
// Data: sku_inventory (what is on the shelf), inventory_value (cost, working stock, value), po_spend_monthly,
// daily_stock_value_summary and inventory_value_history (the value calendar). All refreshed from DecoNetwork every 3 hours.
// Read only. Adds its own nav button and page (app.js binds the nav once, same as quotes.js / winback.js).
(function () {
  'use strict';

  const PAGE_ID = 'stock';
  const REFRESH_MS = 5 * 60 * 1000;
  const REORDER_TARGET_DAYS = 14;

  const CATEGORIES = [
    { id: 'tshirts', label: 'T-Shirts', match: n => /t[\-\s]?shirt|tee|cool[\s-]?t|baselayer|base[\s-]?layer|ringspun|creator|valueweight/i.test(n) },
    { id: 'polos', label: 'Polos', match: n => /polo|piqué|pique/i.test(n) },
    { id: 'hoodies', label: 'Hoodies & Sweatshirts', match: n => /hoodie|hooded|sweatshirt|sweater|fleece|zoodie|cardigan|pullover|snood|mid[\s-]?layer/i.test(n) },
    { id: 'trousers', label: 'Trousers & Shorts', match: n => /trouser|short|cargo|combat|legging|jean|chino|jogger|pant/i.test(n) },
    { id: 'jackets', label: 'Jackets & Gilets', match: n => /jacket|gilet|bodywarmer|body[\s-]?warmer|softshell|soft[\s-]?shell|vest(?!.*hi[\s-]?vis)|coat|blazer|anorak/i.test(n) },
    { id: 'headwear', label: 'Headwear', match: n => /cap|beanie|hat|bucket|snood|scarf|balaclava|buff/i.test(n) },
    { id: 'ppe', label: 'PPE & Safety', match: n => /portwest|helmet|glove|goggle|glasses|ear[\s-]?(plug|defender|protect)|hi[\s-]?vis|high[\s-]?vis|mask|respirator|shoe[\s-]?cover|safety/i.test(n) },
    { id: 'workwear', label: 'Workwear', match: n => /apron|shirt(?!.*polo)|blouse|oxford|corporate|scrub|tunic|tabard/i.test(n) },
    { id: 'promo', label: 'Promotional', match: n => /johnstone|leyland|ppg|care[\s-]?uk|gori|jdc|jt[\s-]|northside|mercedes|total[\s-]?fitness/i.test(n) },
    { id: 'bags', label: 'Bags & Accessories', match: n => /bag|backpack|holdall|shopper|tote|lanyard|sock|socks|towel|blanket|umbrella/i.test(n) },
    { id: 'other', label: 'Other', match: () => true }
  ];
  const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'SM', 'S/M', 'M', 'M/L', 'ML', 'L', 'L/XL', 'LXL', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL', '6XL'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const state = {
    view: 'stock', tab: 'tshirts', q: '', open: {}, expanded: {},
    rows: [], valueBySku: new Map(), workingOnly: [], missingOnly: [], totals: { onHand: 0, working: 0, total: 0 }, spend: [],
    summary: {}, summaryLoaded: false, detail: {}, calY: null, calM: null, historyDays: 0, syncedAt: 0,
    loaded: false, loading: false, error: null, timer: null, focusSearch: false
  };
  let charts = [];

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => new Intl.NumberFormat('en-GB').format(Number(v || 0));
  const money = v => v == null ? '&mdash;' : '&pound;' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyP = v => '£' + Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const moneyP2 = v => '£' + Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  // The main database spells sizes out ("X Large"); the old page used codes (XL). Same codes here so the size columns line up.
  function sizeCode(s) {
    const t = String(s == null ? '' : s).trim();
    const m = t.match(/^(\d)X Large$/i);
    if (m) return m[1] + 'XL';
    const map = { 'XX LARGE': 'XXL', 'X LARGE': 'XL', LARGE: 'L', MEDIUM: 'M', SMALL: 'S', 'X SMALL': 'XS', 'XX SMALL': 'XXS' };
    return map[t.toUpperCase()] || t;
  }
  function commonPrefix(skus) {
    if (!skus.length) return '';
    let p = skus[0];
    for (const s of skus) { while (p && !s.startsWith(p)) p = p.slice(0, -1); }
    p = p.replace(/[^A-Za-z0-9]+$/, '');
    return p.length >= 3 ? p : '';
  }

  function setStatus(text, ok) {
    const el = $('stStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('connected', !!ok);
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; render(); setStatus('Loading...', false); }
    try {
      const sb = client();
      const [inv, val, spend] = await Promise.all([
        pageAll(() => sb.from('sku_inventory').select('sku,product_name,color,size,qty_on_hand,updated_at').gt('qty_on_hand', 0).order('product_name')),
        pageAll(() => sb.from('inventory_value').select('sku,product_name,qty_on_hand,working_stock_qty,unit_cost,stock_value,working_stock_value,total_value,cost_source,missing_cost,cost_ignored').order('sku')),
        sb.from('po_spend_monthly').select('month_key,po_count,total_spend').order('month_key')
      ]);
      state.rows = inv.map(r => ({ sku: r.sku, product_name: r.product_name || r.sku, product_id: r.product_name || r.sku, color_name: r.color || '', size_code: sizeCode(r.size), inv_lvl: Number(r.qty_on_hand || 0), synced_at: r.updated_at }));
      state.valueBySku = new Map(val.map(r => [r.sku, r]));
      state.workingOnly = val.filter(r => (r.working_stock_qty || 0) > 0);
      state.missingOnly = val.filter(r => r.missing_cost === true && ((r.qty_on_hand || 0) > 0 || (r.working_stock_qty || 0) > 0));
      state.totals = {
        onHand: val.reduce((s, r) => s + (Number(r.stock_value) || 0), 0),
        working: val.reduce((s, r) => s + (Number(r.working_stock_value) || 0), 0),
        total: val.reduce((s, r) => s + (Number(r.total_value) || 0), 0)
      };
      state.spend = (spend && spend.data) || [];
      state.syncedAt = inv.reduce((m, r) => { const t = r.updated_at ? new Date(r.updated_at).getTime() : 0; return t > m ? t : m; }, 0);
      try {
        const s = await sb.from('daily_stock_value_summary').select('*').order('snapshot_date');
        if (!s.error) { state.summary = {}; (s.data || []).forEach(r => { state.summary[r.snapshot_date] = r; }); state.summaryLoaded = true; state.historyDays = (s.data || []).length; }
      } catch (e) { /* the calendar tab will say so */ }
      state.loaded = true; state.error = null;
    } catch (e) {
      console.error('stock load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the stock figures';
    } finally { state.loading = false; }
    render();
    setStatus(state.error ? 'Error' : 'Connected', !state.error);
  }

  const categorise = row => { const n = row.product_name || ''; for (const c of CATEGORIES) if (c.match(n)) return c.id; return 'other'; };
  function sizeKey(code) {
    const c = String(code || '').toUpperCase().trim();
    const i = SIZE_ORDER.indexOf(c);
    if (i !== -1) return [0, i, c];
    const n = c.match(/^(\d+)/);
    return n ? [1, Number(n[1]), c] : [2, 0, c];
  }
  function sortSizes(codes) {
    return [...codes].sort((a, b) => { const x = sizeKey(a), y = sizeKey(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
  }
  function groupByProduct(rows) {
    const g = {};
    rows.forEach(r => {
      const o = g[r.product_id] = g[r.product_id] || { product_id: r.product_id, product_name: r.product_name, variations: [], total_stock: 0, low_count: 0, total_value: 0, costed_units: 0 };
      o.variations.push(r); o.total_stock += r.inv_lvl; if (r.inv_lvl <= 2) o.low_count++;
      const v = state.valueBySku.get(r.sku);
      if (v && v.stock_value !== null && v.stock_value !== undefined) { o.total_value += Number(v.stock_value); o.costed_units += r.inv_lvl; }
    });
    return Object.values(g).map(o => { o.product_code = commonPrefix(o.variations.map(v => v.sku)); return o; }).sort((a, b) => a.product_name.localeCompare(b.product_name));
  }

  function productCard(g) {
    const isOpen = !!state.open[g.product_id];
    const sizeCols = sortSizes([...new Set(g.variations.map(v => v.size_code).filter(Boolean))]);
    const noSizes = sizeCols.length === 0;
    const colorGroups = {};
    g.variations.forEach(v => { const ck = v.color_name || '—'; (colorGroups[ck] = colorGroups[ck] || {})[v.size_code || '_'] = v; });
    const colors = Object.keys(colorGroups).sort();
    const hdr = noSizes ? '<th>On hand</th>' : sizeCols.map(s => `<th>${esc(s)}</th>`).join('');
    const body = colors.map(color => {
      const sz = colorGroups[color];
      if (noSizes) {
        const v = sz['_']; if (!v) return '';
        return `<tr><td class="sk-color-cell">${esc(color)}<span class="sk-sku-base">${esc(v.sku || '')}</span></td><td><span class="sk-stock-pill ${v.inv_lvl <= 2 ? 'low' : 'ok'}">${num(v.inv_lvl)}</span></td></tr>`;
      }
      const cells = sizeCols.map(s => { const v = sz[s]; return v ? `<td><span class="sk-stock-pill ${v.inv_lvl <= 2 ? 'low' : 'ok'}" title="${esc(v.sku)}">${num(v.inv_lvl)}</span></td>` : '<td><span class="sk-stock-pill na">&mdash;</span></td>'; }).join('');
      return `<tr><td class="sk-color-cell">${esc(color)}<span class="sk-sku-base">${esc(g.product_code || '')}</span></td>${cells}</tr>`;
    }).join('');
    let valueStat = '';
    if (g.total_stock > 0) {
      if (g.costed_units === 0) valueStat = '<div class="sk-product-stat"><div class="sk-val" style="color:#475569;font-size:12px">no cost data</div><div class="sk-lbl">value</div></div>';
      else if (g.costed_units < g.total_stock) valueStat = `<div class="sk-product-stat" title="Cost data covers ${g.costed_units} of ${g.total_stock} units"><div class="sk-val money">~${money(g.total_value)}</div><div class="sk-lbl">value (partial)</div></div>`;
      else valueStat = `<div class="sk-product-stat"><div class="sk-val money">${money(g.total_value)}</div><div class="sk-lbl">value</div></div>`;
    }
    return `<div class="sk-product-card ${isOpen ? 'open' : ''}">
      <div class="sk-product-header" data-toggle="${esc(g.product_id)}" role="button" tabindex="0" aria-expanded="${isOpen}">
        <span class="sk-product-chevron">&#9656;</span>
        <div class="sk-product-info"><div class="sk-product-name">${esc(g.product_name)}</div><div class="sk-product-meta">${esc(g.product_code || '')} &middot; ${colors.length} colour${colors.length === 1 ? '' : 's'}</div></div>
        <div class="sk-product-stats">${g.low_count > 0 ? `<span class="sk-low-stock-badge">${g.low_count} low</span>` : ''}${valueStat}<div class="sk-product-stat"><div class="sk-val">${num(g.total_stock)}</div><div class="sk-lbl">units</div></div></div>
      </div>
      <div class="sk-variations-wrap"><table class="sk-variations-table"><thead><tr><th>Colour</th>${hdr}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  }

  function expandBtn(id, total, expanded, label) {
    return total > 10 ? `<button class="sk-expand-btn" data-expand="${id}">${expanded ? 'Show less' : 'Show all ' + total + ' ' + label}</button>` : '';
  }
  function attentionHtml() {
    const crit = state.rows.filter(r => r.inv_lvl <= 2).sort((a, b) => a.inv_lvl - b.inv_lvl);
    if (!crit.length) return '<div class="sk-attention-section"><div class="sk-attention-header"><span class="sk-dot" style="background:#4ade80;box-shadow:0 0 6px #4ade80"></span><strong>All stock healthy</strong></div><div class="sk-attention-empty">Nothing at 2 units or fewer.</div></div>';
    const exp = !!state.expanded.attention, vis = exp ? crit : crit.slice(0, 10);
    return `<div class="sk-attention-section"><div class="sk-attention-header"><span class="sk-dot"></span><strong>Critically low &mdash; 2 or fewer units</strong><span>${crit.length} SKU${crit.length === 1 ? '' : 's'}</span></div>
      <div class="sk-attention-body">${vis.map(r => `<div class="sk-attention-row"><span class="sk-attn-name">${esc(r.product_name)}</span><span class="sk-attn-meta">${esc(r.color_name || '')} ${esc(r.size_code || '')} &middot; ${esc(r.sku || '')}</span><span class="sk-stock-pill low" style="flex-shrink:0">${num(r.inv_lvl)}</span></div>`).join('')}
      ${expandBtn('attention', crit.length, exp, 'critically low SKUs')}</div></div>`;
  }
  function workingHtml() {
    if (!state.workingOnly.length) return '';
    const sorted = state.workingOnly.slice().sort((a, b) => (b.working_stock_value || 0) - (a.working_stock_value || 0));
    const total = sorted.reduce((s, r) => s + (Number(r.working_stock_value) || 0), 0);
    const exp = !!state.expanded.working, vis = exp ? sorted : sorted.slice(0, 10);
    return `<div class="sk-attention-section info"><div class="sk-attention-header"><span class="sk-dot"></span><strong>Working stock — full breakdown</strong><span>${sorted.length} SKU${sorted.length === 1 ? '' : 's'} &middot; ${money(total)}</span></div>
      <div class="sk-attention-body">${vis.map(r => `<div class="sk-attention-row"><span class="sk-attn-name">${esc(r.product_name || r.sku)}</span><span class="sk-attn-meta">${esc(r.sku || '')} &middot; ${(r.qty_on_hand || 0) > 0 ? num(r.qty_on_hand) + ' on hand + ' : ''}${num(r.working_stock_qty)} allocated</span><span class="sk-stock-pill ok" style="flex-shrink:0;background:rgba(245,158,11,0.15);color:#fbbf24">${money(r.working_stock_value)}</span></div>`).join('')}
      ${expandBtn('working', sorted.length, exp, 'working stock SKUs')}</div>
      <div class="sk-attention-note">This is every SKU with stock pulled to fulfil an order that hasn't shipped yet. This total always matches the "Working stock value" figure above &mdash; nothing here is double-counted or hidden elsewhere.</div></div>`;
  }
  function missingHtml() {
    if (!state.missingOnly.length) return '';
    const sorted = state.missingOnly.slice().sort((a, b) => (Number(b.qty_on_hand) || 0) - (Number(a.qty_on_hand) || 0));
    const units = sorted.reduce((s, r) => s + (Number(r.qty_on_hand) || 0) + (Number(r.working_stock_qty) || 0), 0);
    const exp = !!state.expanded.missing, vis = exp ? sorted : sorted.slice(0, 10);
    return `<div class="sk-attention-section neutral"><div class="sk-attention-header"><span class="sk-dot"></span><strong>Missing cost &mdash; not counted in stock value</strong><span>${sorted.length} SKU${sorted.length === 1 ? '' : 's'} &middot; ${num(units)} units</span></div>
      <div class="sk-attention-body">${vis.map(r => `<div class="sk-attention-row"><span class="sk-attn-name">${esc(r.product_name || r.sku)}</span><span class="sk-attn-meta">${esc(r.sku || '')}</span><span class="sk-stock-pill na" style="flex-shrink:0;background:rgba(148,163,184,0.15);color:#cbd5e1">${num((Number(r.qty_on_hand) || 0) + (Number(r.working_stock_qty) || 0))}</span></div>`).join('')}
      ${expandBtn('missing', sorted.length, exp, 'SKUs with no cost')}</div>
      <div class="sk-attention-note">These SKUs don't have a cost in any supplier price list yet, so their value is excluded from the totals above rather than being shown as zero.</div></div>`;
  }

  function nextMonthProjection(spendRows, currentValue) {
    const rows = spendRows.filter(r => Number(r.total_spend) > 0);
    if (rows.length < 2) return null;
    const by = {};
    rows.forEach(r => { const m = Number(r.month_key.slice(5, 7)); (by[m] = by[m] || []).push(Number(r.total_spend)); });
    const overall = rows.reduce((s, r) => s + Number(r.total_spend), 0) / rows.length;
    const idx = m => by[m] && by[m].length ? (by[m].reduce((a, b) => a + b, 0) / by[m].length) / overall : 1;
    const now = new Date().getMonth() + 1, next = (now % 12) + 1;
    const v = currentValue * (idx(next) / idx(now));
    return { value: v, delta: v - currentValue, monthsOfHistory: rows.length };
  }

  function calendarHtml() {
    if (!state.summaryLoaded) return '<div class="sk-cal-status">Loading stock value history…</div>';
    const today = new Date();
    if (state.calY === null) { state.calY = today.getFullYear(); state.calM = today.getMonth(); }
    const startWeekday = new Date(state.calY, state.calM, 1).getDay();
    const days = new Date(state.calY, state.calM + 1, 0).getDate();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const monthRows = [];
    let grid = '';
    for (let i = 0; i < startWeekday; i++) grid += '<div class="sk-cal-day empty"></div>';
    for (let d = 1; d <= days; d++) {
      const ds = state.calY + '-' + String(state.calM + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const rec = state.summary[ds], isToday = ds === todayStr;
      if (rec) { monthRows.push(rec); grid += `<div class="sk-cal-day has-data${isToday ? ' today' : ''}" data-date="${ds}" role="button" tabindex="0"><span class="sk-cal-daynum">${d}</span><span class="sk-cal-dayval">${money(rec.total_value)}</span></div>`; }
      else grid += `<div class="sk-cal-day${isToday ? ' today' : ''}"><span class="sk-cal-daynum">${d}</span><span class="sk-cal-nodot"></span></div>`;
    }
    let summary = '';
    if (monthRows.length) {
      const latest = [...monthRows].sort((a, b) => a.snapshot_date < b.snapshot_date ? 1 : -1)[0];
      const high = monthRows.reduce((m, r) => Number(r.total_value) > Number(m.total_value) ? r : m);
      const low = monthRows.reduce((m, r) => Number(r.total_value) < Number(m.total_value) ? r : m);
      summary = `<div class="sk-cal-summary-grid"><div class="sk-cal-summary-cell"><span>Days recorded</span><strong>${monthRows.length}</strong></div><div class="sk-cal-summary-cell"><span>Latest value</span><strong class="accent">${money(latest.total_value)}</strong></div><div class="sk-cal-summary-cell"><span>Month high</span><strong>${money(high.total_value)}</strong></div><div class="sk-cal-summary-cell"><span>Month low</span><strong>${money(low.total_value)}</strong></div></div>`;
    }
    return `${summary}<div class="sk-cal-toolbar"><button data-calnav="-1" aria-label="Previous month">&larr;</button><div class="sk-cal-month-label">${MONTH_LONG[state.calM]} ${state.calY}</div><button data-calnav="1" aria-label="Next month">&rarr;</button></div>
      <div class="sk-cal-wrap"><div class="sk-cal-weekdays"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div><div class="sk-cal-grid">${grid}</div></div>`;
  }

  async function openCalDay(ds) {
    const summary = state.summary[ds];
    if (!summary) return;
    let ov = $('skCalOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'skCalOverlay'; ov.className = 'sk-cal-modal-overlay';
      ov.innerHTML = '<div class="sk-cal-modal" id="skCalModal"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-calclose]')) ov.classList.remove('open'); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') ov.classList.remove('open'); });
    }
    const modal = $('skCalModal');
    modal.innerHTML = '<div class="sk-cal-status">Loading snapshot…</div>';
    ov.classList.add('open');
    if (!state.detail[ds]) {
      try {
        const r = await client().from('inventory_value_history').select('sku,product_name,qty_on_hand,working_stock_qty,total_qty,unit_cost,total_value').eq('snapshot_date', ds).order('total_value', { ascending: false, nullsFirst: false }).limit(50);
        if (r.error) throw r.error;
        state.detail[ds] = r.data || [];
      } catch (e) { modal.innerHTML = '<div class="sk-cal-status">Could not load detail: ' + esc(e.message || String(e)) + '</div>'; return; }
    }
    const top = state.detail[ds].filter(r => r.total_value).slice(0, 8);
    const nice = new Date(ds + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    modal.innerHTML = `<div class="sk-cal-modal-head"><div><h3>${esc(nice)}</h3><div class="sub">${num(summary.sku_count)} SKUs recorded</div></div><button class="sk-cal-modal-close" data-calclose="1" aria-label="Close">&times;</button></div>
      <p class="sk-cal-modal-total">${money(summary.total_value)}</p><p class="sk-cal-modal-total-label">Total stock value on hand</p>
      <div class="sk-cal-breakdown"><div><div class="k">On-hand stock</div><div class="v">${money(summary.on_hand_value)}</div></div><div><div class="k">Working stock</div><div class="v">${money(summary.working_stock_value)}</div></div>
      <div><div class="k">Total units</div><div class="v">${num(summary.total_qty)}</div></div><div><div class="k">On-hand / working units</div><div class="v">${num(summary.on_hand_qty)} / ${num(summary.working_stock_qty)}</div></div></div>
      <div class="sk-cal-top-skus"><strong>Top value SKUs this day:</strong><br>${top.map(r => `${esc(r.sku)} — ${esc(r.product_name || '')} — ${num(r.total_qty)} units @ ${money(r.unit_cost)} = ${money(r.total_value)}`).join('<br>')}</div>`;
  }

  function stockHtml() {
    const rows = state.rows, t = state.totals;
    const proj = nextMonthProjection(state.spend, t.total);
    const byCat = {};
    rows.forEach(r => { (byCat[categorise(r)] = byCat[categorise(r)] || []).push(r); });
    if (state.tab !== 'calendar' && !(byCat[state.tab] || []).length) state.tab = (CATEGORIES.find(c => (byCat[c.id] || []).length) || { id: 'calendar' }).id;
    const tabs = CATEGORIES.map(c => { const n = (byCat[c.id] || []).length; return n ? `<button class="sk-tab-btn ${c.id === state.tab ? 'active' : ''}" data-tab="${c.id}">${esc(c.label)}<span class="sk-tab-count">${n}</span></button>` : ''; }).join('') + `<button class="sk-tab-btn ${state.tab === 'calendar' ? 'active' : ''}" data-tab="calendar">📅 Value Calendar</button>`;
    let page = '';
    if (state.tab === 'calendar') page = `<div id="skCalendarView">${calendarHtml()}</div>`;
    else {
      let f = byCat[state.tab] || [];
      if (state.q) f = f.filter(r => [r.product_name, r.color_name, r.size_code, r.sku].join(' ').toLowerCase().includes(state.q));
      const groups = groupByProduct(f);
      page = groups.length ? groups.map(productCard).join('') : '<div class="sk-empty-state">No products match your search.</div>';
    }
    const kpi = (cls, label, value, sub, extra) => `<div class="sk-kpi-card ${cls}"${extra || ''}><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
    const projPct = proj && t.total ? (proj.delta / t.total * 100) : 0;
    const pct = Math.min(100, Math.round((state.historyDays / REORDER_TARGET_DAYS) * 100));
    return `<div class="sk-tab-bar" role="tablist">${tabs}</div>
      <div class="sk-main"><div class="sk-kpi-grid">
        ${kpi('', 'Total SKUs in stock', num(rows.length), '&nbsp;')}${kpi('', 'Total units on hand', num(rows.reduce((s, r) => s + r.inv_lvl, 0)), '&nbsp;')}
        ${kpi('warn', 'Critically low (&le;2)', num(rows.filter(r => r.inv_lvl <= 2).length), '&nbsp;')}${kpi('', 'Products tracked', num(new Set(rows.map(r => r.product_id)).size), '&nbsp;')}
        ${kpi('money', 'Total stock value', money(t.total), 'On-hand + working stock')}${kpi('money', 'On-hand stock value', money(t.onHand), 'Sat on the shelf, unallocated')}
        ${kpi('money', 'Working stock value', money(t.working), 'Tied up in unshipped orders')}
        ${kpi('', 'Projected value (next month)', proj ? money(proj.value) : 'Gathering data', proj ? (projPct >= 0 ? '+' : '') + projPct.toFixed(1) + '% seasonal, from ' + proj.monthsOfHistory + 'mo history' : 'Needs 2+ months of PO history', ' style="border-color:rgba(167,139,250,0.3)"')}</div>
        <div class="sk-controls-row"><input id="stSearch" type="search" value="${esc(state.q)}" placeholder="Search by product name, SKU, colour..." aria-label="Search stock"></div>
        ${attentionHtml()}${workingHtml()}${missingHtml()}
        <div class="sk-tab-page active">${page}</div>
        <div class="sk-last-synced"><span class="sk-history-progress">Reorder history: ${state.historyDays}/${REORDER_TARGET_DAYS} days <span class="sk-history-track"><span class="sk-history-fill" style="width:${pct}%"></span></span></span><span>${state.syncedAt ? 'Last synced: ' + new Date(state.syncedAt).toLocaleString('en-GB') : ''}</span></div></div>`;
  }

  // ---- Projections (the old projections page) ----
  function seasonalIndex(rows) {
    const by = {};
    rows.forEach(r => { const m = Number(r.month_key.slice(5, 7)); (by[m] = by[m] || []).push(Number(r.total_spend)); });
    const overall = rows.reduce((s, r) => s + Number(r.total_spend), 0) / rows.length;
    const index = {};
    for (let m = 1; m <= 12; m++) index[m] = by[m] && by[m].length ? (by[m].reduce((a, b) => a + b, 0) / by[m].length) / overall : 1;
    return { index, overall };
  }
  function projectForward(n, seasonal, base, baseMonth) {
    const pts = [];
    for (let i = 1; i <= n; i++) {
      const tm = ((baseMonth - 1 + i) % 12) + 1;
      pts.push({ monthNum: tm, value: base * ((seasonal.index[tm] || 1) / (seasonal.index[baseMonth] || 1)), seasonalIndex: seasonal.index[tm] || 1 });
    }
    return pts;
  }
  function projHtml() {
    const rows = state.spend.filter(r => Number(r.total_spend) > 0);
    if (rows.length < 2) return '<div class="sk-loading">Not enough purchase history yet to build a seasonal projection. Check back once more months of data have synced.</div>';
    const seasonal = seasonalIndex(rows), cur = state.totals.total;
    return `<div class="sk-main" style="max-width:1200px">
      <div class="sk-kpi-grid">
        <div class="sk-kpi-card"><span>Current stock value</span><strong>${moneyP2(cur)}</strong><small class="flat">Live from stock ledger</small></div>
        <div class="sk-kpi-card proj"><span>Projected value at slider month</span><strong id="skpKpiProjected">&mdash;</strong><small id="skpKpiDelta">&nbsp;</small></div>
        <div class="sk-kpi-card"><span>Avg monthly purchasing</span><strong>${moneyP(seasonal.overall)}</strong><small class="flat">Across ${rows.length} months of real history</small></div>
        <div class="sk-kpi-card"><span>Seasonal peak month</span><strong id="skpKpiPeak">&mdash;</strong><small class="flat">Historically highest spend</small></div></div>
      <div class="sk-panel"><p class="sk-panel-title">Projected stock value</p><p class="sk-panel-sub">Slide to see how stock value is projected to move, based on your own purchasing seasonality.</p>
        <div class="sk-slider-row"><label for="skpSlider">Months ahead</label><input type="range" id="skpSlider" min="1" max="12" value="6" step="1"><span class="sk-slider-value" id="skpSliderLabel">6 months</span></div>
        <div class="sk-legend-row"><span><span class="sk-legend-dot" style="background:#38bdf8"></span>Actual stock value history</span><span><span class="sk-legend-dot" style="background:#a78bfa"></span>Projected (seasonal model)</span></div>
        <div class="sk-chart-wrap"><canvas id="skpValueChart" role="img" aria-label="Line chart of actual and projected stock value by month"></canvas></div></div>
      <div class="sk-panel"><p class="sk-panel-title">Monthly purchasing &mdash; actual vs seasonal projection</p><p class="sk-panel-sub">Real purchase order spend by month, and the seasonal shape applied to future months.</p>
        <div class="sk-chart-wrap" style="height:280px"><canvas id="skpSpendChart" role="img" aria-label="Bar chart of monthly purchase order spend"></canvas></div><table class="sk-month-table" id="skpTable"></table></div>
      <div class="sk-panel"><p class="sk-panel-title">How this projection works</p><div class="sk-method-box"><strong>This is a seasonality model, not a demand forecast.</strong> It's built entirely from your own purchase order history &mdash; ${rows.length} months of real spend data pulled directly from DecoNetwork.
        <ul><li>Each calendar month gets a seasonal index: how far that month's typical spend runs above or below your yearly average.</li>
        <li>Future months are projected by applying that same seasonal shape to your current stock value &mdash; e.g. if October has historically run 40% above average, a projected October carries that same lift.</li>
        <li>With only ${rows.length} months of history, this shows one year's shape, not a multi-year trend. It will get more reliable as more months accumulate.</li>
        <li>This projects <strong>stock value</strong>, not sales demand or cash flow &mdash; it doesn't account for price changes, new products, or supplier changes.</li></ul></div></div></div>`;
  }
  function drawProjections() {
    charts.forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
    charts = [];
    const rows = state.spend.filter(r => Number(r.total_spend) > 0);
    if (rows.length < 2 || !$('skpValueChart')) return;
    if (typeof Chart === 'undefined') { $('skpValueChart').parentElement.innerHTML = '<div class="sk-loading">The chart library did not load.</div>'; return; }
    const seasonal = seasonalIndex(rows), cur = state.totals.total, baseMonth = new Date().getMonth() + 1;
    const sorted = rows.slice().sort((a, b) => a.month_key.localeCompare(b.month_key));
    const actualLabels = sorted.map(r => { const p = r.month_key.split('-'); return MONTH_SHORT[Number(p[1]) - 1] + " '" + p[0].slice(2); });
    const pts = projectForward(12, seasonal, cur, baseMonth);
    const projLabels = pts.map((p, i) => { const d = new Date(); d.setMonth(d.getMonth() + i + 1); return MONTH_SHORT[d.getMonth()] + " '" + String(d.getFullYear()).slice(2); });
    const tick = v => '£' + Number(v).toLocaleString();
    charts.push(new Chart($('skpValueChart'), { type: 'line', data: { labels: [...actualLabels.slice(-1), ...projLabels], datasets: [
      { label: 'Actual', data: [cur, ...new Array(projLabels.length).fill(null)], borderColor: '#38bdf8', backgroundColor: '#38bdf8', pointRadius: 4, tension: 0 },
      { label: 'Projected', data: [cur, ...pts.map(p => p.value)], borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.08)', borderDash: [6, 4], fill: true, pointRadius: 3, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#64748b', callback: tick }, grid: { color: '#1e2d45' } }, x: { ticks: { color: '#64748b' }, grid: { display: false } } } } }));
    charts.push(new Chart($('skpSpendChart'), { type: 'bar', data: { labels: [...actualLabels, ...projLabels], datasets: [
      { label: 'Actual spend', data: [...sorted.map(r => Number(r.total_spend)), ...new Array(projLabels.length).fill(null)], backgroundColor: '#38bdf8', borderRadius: 4 },
      { label: 'Seasonal projection', data: [...new Array(actualLabels.length).fill(null), ...pts.map(p => seasonal.overall * p.seasonalIndex)], backgroundColor: 'rgba(167,139,250,0.5)', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#64748b', callback: tick }, grid: { color: '#1e2d45' } }, x: { ticks: { color: '#64748b', maxRotation: 45, autoSkip: false }, grid: { display: false } } } } }));
    $('skpTable').innerHTML = ['<tr><th>Month</th><th>PO count</th><th>Spend</th><th>Seasonal index</th></tr>',
      ...sorted.map(r => { const m = Number(r.month_key.slice(5, 7)); return `<tr><td>${MONTH_SHORT[m - 1]} ${r.month_key.slice(0, 4)}<span class="sk-tag actual">actual</span></td><td>${esc(r.po_count)}</td><td>${moneyP(r.total_spend)}</td><td>${seasonal.index[m].toFixed(2)}&times;</td></tr>`; }),
      ...pts.map((p, i) => { const d = new Date(); d.setMonth(d.getMonth() + i + 1); return `<tr class="projected"><td>${MONTH_SHORT[p.monthNum - 1]} ${d.getFullYear()}<span class="sk-tag projected">projected</span></td><td>&mdash;</td><td>${moneyP(seasonal.overall * p.seasonalIndex)}</td><td>${p.seasonalIndex.toFixed(2)}&times;</td></tr>`; })].join('');
    let peak = 1, peakIdx = 0;
    for (let m = 1; m <= 12; m++) if (seasonal.index[m] > peakIdx) { peakIdx = seasonal.index[m]; peak = m; }
    $('skpKpiPeak').textContent = MONTH_SHORT[peak - 1] + ' (' + peakIdx.toFixed(1) + '× avg)';
    const slide = () => {
      const n = Number($('skpSlider').value);
      $('skpSliderLabel').textContent = n + (n === 1 ? ' month' : ' months');
      const target = projectForward(n, seasonal, cur, baseMonth).pop();
      $('skpKpiProjected').textContent = moneyP2(target.value);
      const delta = target.value - cur, pct = cur ? delta / cur * 100 : 0, el = $('skpKpiDelta');
      if (Math.abs(pct) < 1) { el.className = 'flat'; el.textContent = 'Roughly flat vs today'; }
      else if (delta > 0) { el.className = 'up'; el.textContent = '+' + pct.toFixed(1) + '% vs today (seasonal)'; }
      else { el.className = 'down'; el.textContent = pct.toFixed(1) + '% vs today (seasonal)'; }
    };
    $('skpSlider').addEventListener('input', slide);
    slide();
  }

  function render() {
    const el = $('stBody');
    if (!el) return;
    if (state.error) { el.innerHTML = `<div class="sk-empty-state">Couldn't load the stock figures: ${esc(state.error)}<br><br><button type="button" class="sk-expand-btn" style="width:auto;display:inline-block;padding:8px 18px" data-act="reload">Try again</button></div>`; return; }
    if (!state.loaded) { el.innerHTML = '<div class="sk-empty-state">Loading…</div>'; return; }
    const top = $('stProjBtn');
    if (top) top.textContent = state.view === 'proj' ? '← Back to stock ledger' : 'Projections →';
    el.innerHTML = state.view === 'proj' ? projHtml() : stockHtml();
    if (state.view === 'proj') drawProjections();
    if (state.focusSearch) { const s = $('stSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } state.focusSearch = false; }
  }

  function injectStyles() {
    if ($('stStyles')) return;
    const s = document.createElement('style');
    s.id = 'stStyles';
    s.textContent = `@keyframes sk-attn-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
#stock * { box-sizing: border-box; }
#stock { background: #020617; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #e8edf5; }
#stock .sk-topbar {  background: rgba(2,6,23,0.95); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.06); padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
#stock .sk-topbar h1 { font-size: 22px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
#stock .sk-topbar .sk-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #38bdf8; margin: 0 0 1px; }
#stock #stStatus { font-size: 12px; font-weight: 700; color: #64748b; }
#stock #stStatus.connected { color: #4ade80; }
#stock .sk-tab-bar { background: rgba(2,6,23,0.9); border-bottom: 1px solid #1e2d45; display: flex; gap: 0; overflow-x: auto; padding: 0 28px; scrollbar-width: none; }
#stock .sk-tab-bar::-webkit-scrollbar { display: none; }
#stock .sk-tab-btn { padding: 12px 18px; border: none; background: none; color: #64748b; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; transition: all 0.15s; position: relative; }
#stock .sk-tab-btn:hover { color: #cbd5e1; }
#stock .sk-tab-btn.active { color: #38bdf8; border-bottom-color: #38bdf8; }
#stock .sk-tab-btn .sk-tab-count { display: inline-block; background: rgba(56,189,248,0.15); color: #38bdf8; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 5px; font-weight: 800; }
#stock .sk-tab-btn.active .sk-tab-count { background: #38bdf8; color: #04243a; }
#stock .sk-main { max-width: 1400px; margin: 0 auto; padding: 24px 28px 80px; transition: margin-right 0.22s ease; }
#stock .sk-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
#stock .sk-kpi-card { background: #0d1525; border: 1px solid #1e2d45; border-radius: 12px; padding: 16px; position: relative; overflow: hidden; }
#stock .sk-kpi-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #38bdf8, #6366f1); }
#stock .sk-kpi-card.warn::before { background: linear-gradient(90deg, #f59e0b, #ef4444); }
#stock .sk-kpi-card.money::before { background: linear-gradient(90deg, #4ade80, #22d3ee); }
#stock .sk-kpi-card span { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
#stock .sk-kpi-card strong { display: block; font-size: 28px; font-weight: 800; margin-top: 4px; color: #f8fafc; font-variant-numeric: tabular-nums; }
#stock .sk-kpi-card small { display: block; font-size: 11px; color: #64748b; margin-top: 3px; }
#stock .sk-controls-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
#stock #stSearch { flex: 1; min-width: 200px; background: rgba(255,255,255,0.05); border: 1px solid #1e2d45; border-radius: 10px; padding: 9px 14px; color: #e8edf5; font-size: 13px; outline: none; }
#stock #stSearch:focus { border-color: #38bdf8; }
#stock #stSearch::placeholder { color: #475569; }
#stock .sk-attention-section { margin-bottom: 22px; border: 1px solid rgba(239,68,68,0.3); border-radius: 12px; background: rgba(239,68,68,0.04); overflow: hidden; }
#stock .sk-attention-section.info { border-color: rgba(245,158,11,0.35); background: rgba(245,158,11,0.05); }
#stock .sk-attention-section.neutral { border-color: rgba(148,163,184,0.35); background: rgba(148,163,184,0.05); }
#stock .sk-attention-header { padding: 12px 18px; display: flex; align-items: center; gap: 10px; background: rgba(239,68,68,0.08); border-bottom: 1px solid rgba(239,68,68,0.2); }
#stock .sk-attention-section.info .sk-attention-header { background: rgba(245,158,11,0.1); border-bottom-color: rgba(245,158,11,0.25); }
#stock .sk-attention-section.neutral .sk-attention-header { background: rgba(148,163,184,0.1); border-bottom-color: rgba(148,163,184,0.25); }
#stock .sk-attention-header .sk-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 6px #ef4444; animation: sk-attn-pulse 1.6s ease-in-out infinite; }
#stock .sk-attention-section.info .sk-attention-header .sk-dot { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
#stock .sk-attention-section.neutral .sk-attention-header .sk-dot { background: #94a3b8; box-shadow: 0 0 6px #94a3b8; }
#stock .sk-attention-header strong { font-size: 12px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: #f87171; }
#stock .sk-attention-section.info .sk-attention-header strong { color: #fbbf24; }
#stock .sk-attention-section.neutral .sk-attention-header strong { color: #cbd5e1; }
#stock .sk-attention-header span { font-size: 11px; color: #94a3b8; margin-left: auto; }
#stock .sk-attention-body { padding: 4px 10px; }
#stock .sk-attention-row { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; }
#stock .sk-attention-row:last-child { border-bottom: none; }
#stock .sk-attention-row .sk-attn-name { flex: 1; color: #e8edf5; font-weight: 600; }
#stock .sk-attention-row .sk-attn-meta { color: #64748b; font-size: 11px; }
#stock .sk-attention-empty { padding: 14px 18px; color: #4ade80; font-size: 12px; text-align: center; }
#stock .sk-attention-note { padding: 8px 18px 12px; color: #94a3b8; font-size: 11px; line-height: 1.5; }
#stock .sk-attention-body { max-height: 480px; overflow-y: auto; }
#stock .sk-expand-btn { display: block; width: 100%; background: rgba(255,255,255,0.03); border: none; border-top: 1px solid rgba(255,255,255,0.06); color: #38bdf8; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; padding: 10px; cursor: pointer; margin-top: 4px; }
#stock .sk-expand-btn:hover { background: rgba(56,189,248,0.08); }
#stock .sk-tab-page { display: none; }
#stock .sk-tab-page.active { display: block; }
#stock .sk-product-card { background: #0d1525; border: 1px solid #1e2d45; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
#stock .sk-product-header { padding: 12px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
#stock .sk-product-header:hover { background: rgba(56,189,248,0.04); }
#stock .sk-product-chevron { font-size: 11px; color: #64748b; transition: transform 0.2s ease; flex-shrink: 0; width: 12px; }
#stock .sk-product-card.open .sk-product-chevron { transform: rotate(90deg); }
#stock .sk-product-info { flex: 1; min-width: 0; }
#stock .sk-product-name { font-size: 13px; font-weight: 700; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#stock .sk-product-meta { font-size: 11px; color: #64748b; margin-top: 1px; }
#stock .sk-product-stats { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
#stock .sk-product-stat .sk-val { font-size: 15px; font-weight: 800; color: #f8fafc; font-variant-numeric: tabular-nums; text-align: right; }
#stock .sk-product-stat .sk-val.money { color: #4ade80; }
#stock .sk-product-stat .sk-lbl { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; text-align: right; }
#stock .sk-low-stock-badge { background: rgba(239,68,68,0.15); color: #f87171; font-size: 9px; font-weight: 800; padding: 2px 7px; border-radius: 20px; letter-spacing: 0.04em; text-transform: uppercase; }
#stock .sk-variations-wrap { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; border-top: 1px solid transparent; overflow-x: auto; }
#stock .sk-product-card.open .sk-variations-wrap { max-height: 2000px; border-top: 1px solid #1e2d45; }
#stock .sk-variations-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 400px; }
#stock .sk-variations-table th { text-align: center; padding: 7px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; background: rgba(255,255,255,0.02); }
#stock .sk-variations-table th:first-child { text-align: left; padding-left: 16px; }
#stock .sk-variations-table td { padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.04); color: #cbd5e1; text-align: center; }
#stock .sk-variations-table td.sk-color-cell { text-align: left; padding-left: 16px; font-weight: 700; color: #f8fafc; white-space: nowrap; }
#stock .sk-variations-table td.sk-color-cell .sk-sku-base { display: block; font-size: 10px; font-weight: 400; color: #64748b; margin-top: 1px; }
#stock .sk-stock-pill { display: inline-block; min-width: 28px; padding: 2px 7px; border-radius: 6px; font-weight: 700; font-variant-numeric: tabular-nums; font-size: 11px; }
#stock .sk-stock-pill.ok { background: rgba(34,197,94,0.12); color: #4ade80; }
#stock .sk-stock-pill.low { background: rgba(239,68,68,0.15); color: #f87171; }
#stock .sk-stock-pill.na { background: transparent; color: #2c3a52; }
#stock .sk-empty-state { text-align: center; padding: 50px 20px; color: #64748b; }
#stock .sk-last-synced { font-size: 10px; color: #475569; text-align: right; margin-top: 20px; display: flex; justify-content: flex-end; gap: 16px; }
#stock .sk-history-progress { font-size: 10px; color: #475569; display: flex; align-items: center; gap: 6px; }
#stock .sk-history-track { width: 60px; height: 4px; background: #1e2d45; border-radius: 4px; overflow: hidden; }
#stock .sk-history-fill { height: 100%; background: #38bdf8; }
#stock .sk-cal-summary-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 1px; background: #1e2d45; border: 1px solid #1e2d45; border-radius: 12px; overflow: hidden; margin-bottom: 18px; }
#stock .sk-cal-summary-cell { background: #0d1525; padding: 14px 16px; }
#stock .sk-cal-summary-cell span { display:block; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; margin-bottom: 6px; }
#stock .sk-cal-summary-cell strong { font-size: 18px; font-weight: 800; color: #f8fafc; font-variant-numeric: tabular-nums; }
#stock .sk-cal-summary-cell strong.accent { color: #4ade80; }
#stock .sk-cal-toolbar { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 14px; }
#stock .sk-cal-toolbar button { background: #0d1525; border: 1px solid #1e2d45; color: #e8edf5; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 15px; display:flex; align-items:center; justify-content:center; transition: border-color .15s, color .15s; }
#stock .sk-cal-toolbar button:hover { border-color: #38bdf8; color: #38bdf8; }
#stock .sk-cal-toolbar .sk-cal-month-label { font-size: 15px; font-weight: 800; min-width: 160px; text-align: center; color: #f8fafc; }
#stock .sk-cal-wrap { background: #0d1525; border: 1px solid #1e2d45; border-radius: 14px; padding: 18px; }
#stock .sk-cal-weekdays { display: grid; grid-template-columns: repeat(7,1fr); margin-bottom: 6px; }
#stock .sk-cal-weekdays div { text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b; padding-bottom: 4px; }
#stock .sk-cal-grid { display: grid; grid-template-columns: repeat(7,1fr); grid-auto-rows: 78px; gap: 6px; }
#stock .sk-cal-day { position: relative; border-radius: 8px; background: #111a2c; border: 1px solid #1e2d45; padding: 8px; display:flex; flex-direction:column; justify-content:space-between; transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
#stock .sk-cal-day.empty { background: transparent; border: none; }
#stock .sk-cal-day.has-data { cursor: pointer; }
#stock .sk-cal-day.has-data:hover { transform: translateY(-3px) scale(1.03); border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8, 0 10px 22px rgba(56,189,248,0.35); z-index: 2; }
#stock .sk-cal-day.today { border-color: #6366f1; }
#stock .sk-cal-day .sk-cal-daynum { font-size: 11px; font-weight: 700; color: #94a3b8; }
#stock .sk-cal-day .sk-cal-dayval { font-size: 12px; font-weight: 800; color: #4ade80; font-variant-numeric: tabular-nums; }
#stock .sk-cal-day .sk-cal-nodot { width: 4px; height: 4px; border-radius: 50%; background: #1e2d45; align-self: flex-end; }
.sk-cal-modal-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.72); display: none; align-items: center; justify-content: center; z-index: 3000; padding: 20px; }
.sk-cal-modal-overlay.open { display: flex; }
.sk-cal-modal { background: #0d1525; border: 1px solid #1e2d45; border-radius: 14px; width: 100%; max-width: 480px; max-height: 82vh; overflow-y: auto; padding: 24px; box-shadow: 0 30px 80px rgba(0,0,0,0.55); }
.sk-cal-modal-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #1e2d45; padding-bottom: 12px; margin-bottom: 16px; }
.sk-cal-modal-head h3 { margin: 0 0 3px; font-size: 18px; color: #f8fafc; }
.sk-cal-modal-head .sub { font-size: 11px; color: #64748b; }
.sk-cal-modal-close { background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; line-height: 1; padding: 4px; }
.sk-cal-modal-total { font-size: 32px; font-weight: 800; color: #4ade80; margin: 0 0 2px; font-variant-numeric: tabular-nums; }
.sk-cal-modal-total-label { font-size: 11px; color: #64748b; margin-bottom: 16px; }
.sk-cal-breakdown { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #1e2d45; border: 1px solid #1e2d45; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
.sk-cal-breakdown div { background: #111a2c; padding: 10px 12px; }
.sk-cal-breakdown .k { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
.sk-cal-breakdown .v { font-size: 14px; font-weight: 700; color: #e8edf5; }
.sk-cal-top-skus { font-size: 11px; color: #94a3b8; line-height: 1.8; border-top: 1px solid #1e2d45; padding-top: 12px; }
.sk-cal-top-skus strong { color: #cbd5e1; }
#stock .sk-cal-status { padding: 40px 20px; text-align: center; color: #64748b; font-size: 12px; }
#stock .sk-back-link { font-size: 12px; color: #64748b; text-decoration: none; display: flex; align-items: center; gap: 6px; }
#stock .sk-back-link:hover { color: #38bdf8; }
#stock .sk-main { max-width: 1200px; margin: 0 auto; padding: 28px 28px 80px; }
#stock .sk-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
#stock .sk-kpi-card.proj::before { background: linear-gradient(90deg, #a78bfa, #38bdf8); }
#stock .sk-kpi-card strong { display: block; font-size: 26px; font-weight: 800; margin-top: 4px; color: #f8fafc; font-variant-numeric: tabular-nums; }
#stock .sk-kpi-card small { display: block; font-size: 11px; margin-top: 3px; }
#stock .sk-kpi-card small.up { color: #4ade80; }
#stock .sk-kpi-card small.down { color: #f87171; }
#stock .sk-kpi-card small.flat { color: #64748b; }
#stock .sk-panel { background: #0d1525; border: 1px solid #1e2d45; border-radius: 14px; padding: 22px; margin-bottom: 22px; }
#stock .sk-panel-title { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 0 0 4px; }
#stock .sk-panel-sub { font-size: 12px; color: #64748b; margin: 0 0 18px; }
#stock .sk-slider-row { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
#stock .sk-slider-row label { font-size: 12px; color: #94a3b8; white-space: nowrap; }
#stock input[type="range"] { flex: 1; height: 4px; border-radius: 4px; background: #1e2d45; outline: none; -webkit-appearance: none; appearance: none; }
#stock input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #38bdf8; cursor: pointer; box-shadow: 0 0 0 4px rgba(56,189,248,0.2); }
#stock input[type="range"]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #38bdf8; cursor: pointer; border: none; box-shadow: 0 0 0 4px rgba(56,189,248,0.2); }
#stock .sk-slider-value { font-size: 15px; font-weight: 800; color: #38bdf8; min-width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
#stock .sk-chart-wrap { position: relative; height: 360px; margin-bottom: 8px; }
#stock .sk-legend-row { display: flex; gap: 20px; margin-bottom: 14px; font-size: 12px; color: #94a3b8; flex-wrap: wrap; }
#stock .sk-legend-row span { display: inline-flex; align-items: center; gap: 6px; }
#stock .sk-legend-dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
#stock .sk-method-box { background: rgba(56,189,248,0.05); border: 1px solid rgba(56,189,248,0.2); border-radius: 12px; padding: 16px 18px; font-size: 12.5px; line-height: 1.65; color: #b6c2d4; }
#stock .sk-method-box strong { color: #e8edf5; }
#stock .sk-method-box ul { margin: 8px 0 0; padding-left: 18px; }
#stock .sk-method-box li { margin-bottom: 5px; }
#stock .sk-month-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 6px; }
#stock .sk-month-table th { text-align: right; padding: 8px 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; border-bottom: 1px solid #1e2d45; }
#stock .sk-month-table th:first-child { text-align: left; }
#stock .sk-month-table td { padding: 8px 10px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.04); color: #cbd5e1; font-variant-numeric: tabular-nums; }
#stock .sk-month-table td:first-child { text-align: left; font-weight: 700; color: #f8fafc; }
#stock .sk-month-table tr.projected td { color: #a78bfa; }
#stock .sk-month-table tr.projected td:first-child { color: #c4b5fd; }
#stock .sk-tag { font-size: 9px; padding: 2px 6px; border-radius: 20px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; margin-left: 6px; }
#stock .sk-tag.actual { background: rgba(56,189,248,0.15); color: #38bdf8; }
#stock .sk-tag.projected { background: rgba(167,139,250,0.15); color: #a78bfa; }
#stock .sk-loading { text-align: center; padding: 60px; color: #64748b; font-size: 13px; }

.sk-cal-modal-overlay { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #e8edf5; }
.sk-cal-modal-overlay * { box-sizing: border-box; }
#stock { border-radius:14px; overflow:hidden; }
#stock .sk-proj-link { font-size:12px; font-weight:700; color:#38bdf8; text-decoration:none; display:flex; align-items:center; gap:6px; padding:7px 14px; border:1px solid rgba(56,189,248,0.3); border-radius:8px; background:rgba(56,189,248,0.08); cursor:pointer; font-family:inherit; }
#stock .sk-product-header { color:inherit; }
#stock .sk-loading { text-align:center; padding:60px; color:#64748b; font-size:13px; }
`;
    document.head.appendChild(s);
  }

  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="updatelog"]') || document.querySelector('.nav-link[data-page="calendar"]') || document.querySelector('.nav-link[data-page="newcustomers"]');
    const anchorPage = $('updatelog') || $('calendar') || $('newcustomers');
    if (!anchorBtn || !anchorPage) return false;
    if (!document.querySelector('.nav-link[data-page="updatelog"]') && boot.tries < 35) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>📦 Stock</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `<div class="sk-topbar"><div><p class="sk-eyebrow">ATAM Workwear</p><h1>ATAM Stock</h1></div>
      <div style="display:flex;align-items:center;gap:18px"><button type="button" class="sk-proj-link" id="stProjBtn" data-act="proj">Projections →</button><div id="stStatus">Connecting...</div></div></div>
      <div id="stBody"><div class="sk-empty-state">Loading…</div></div>`;
    anchorPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden && state.view === 'stock') load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'reload') { load(); return; }
      if (act && act.dataset.act === 'proj') { state.view = state.view === 'proj' ? 'stock' : 'proj'; render(); return; }
      const tab = e.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; render(); return; }
      const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.open[k] = !state.open[k]; const card = tg.closest('.sk-product-card'); if (card) { card.classList.toggle('open', !!state.open[k]); tg.setAttribute('aria-expanded', String(!!state.open[k])); } return; }
      const ex = e.target.closest('[data-expand]'); if (ex) { const k = ex.dataset.expand; state.expanded[k] = !state.expanded[k]; render(); return; }
      const nav = e.target.closest('[data-calnav]');
      if (nav) { state.calM += Number(nav.dataset.calnav); if (state.calM < 0) { state.calM = 11; state.calY--; } if (state.calM > 11) { state.calM = 0; state.calY++; } render(); return; }
      const day = e.target.closest('.sk-cal-day.has-data'); if (day) { openCalDay(day.dataset.date); return; }
    });
    sec.addEventListener('keydown', e => {
      const t = e.target.closest && e.target.closest('[data-toggle], .sk-cal-day.has-data');
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.click(); }
    });
    sec.addEventListener('input', e => { if (e.target.id === 'stSearch') { state.q = e.target.value.trim().toLowerCase(); state.focusSearch = true; render(); } });
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.StockPage = { reload: () => load(), state };
})();
