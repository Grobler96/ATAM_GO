// Stock tab: what is on the shelf, what is tied up in orders, what it is worth, and what is running low.
// Replaces the separate "ATAM Stock" page, which stopped working (its own database was switched off and its value tiles
// read data without signing in). Everything here comes from the main database and needs the signed-in person's login.
// Data: the view-like table inventory_value (filled every 3 hours by the DecoNetwork stock workflows) and po_spend_monthly.
// Read only. Adds its own nav button and page (app.js binds the nav once, same as quotes.js / winback.js).
(function () {
  'use strict';

  const PAGE_ID = 'stock';
  const REFRESH_MS = 5 * 60 * 1000;
  const LOW_AT = 2;

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

  const state = { rows: [], spend: [], tab: 'tshirts', q: '', open: {}, expanded: {}, loaded: false, loading: false, error: null, updatedAt: null, timer: null };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => new Intl.NumberFormat('en-GB').format(Number(v || 0));
  const gbp = v => v == null ? '–' : '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const gbp2 = v => v == null ? '–' : '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qty = r => Number(r.qty_on_hand || 0);
  const work = r => Number(r.working_stock_qty || 0);

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
      const sb = client();
      const [rows, spend] = await Promise.all([
        pageAll(() => sb.from('inventory_value').select('sku,product_name,color,size,qty_on_hand,working_stock_qty,unit_cost,stock_value,working_stock_value,total_value,missing_cost,cost_ignored,updated_at').order('sku')),
        sb.from('po_spend_monthly').select('month_key,total_spend')
      ]);
      state.rows = rows;
      state.spend = (spend && spend.data) || [];
      state.updatedAt = rows.reduce((m, r) => (r.updated_at && r.updated_at > m ? r.updated_at : m), '');
      state.loaded = true; state.error = null;
    } catch (e) {
      console.error('stock load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the stock figures';
    } finally { state.loading = false; }
    render();
  }

  const categorise = name => { for (const c of CATEGORIES) if (c.match(name || '')) return c.id; return 'other'; };
  function sizeKey(code) {
    const c = String(code || '').toUpperCase().trim();
    const i = SIZE_ORDER.indexOf(c);
    if (i !== -1) return [0, i, c];
    const n = c.match(/^(\d+)/);
    return n ? [1, Number(n[1]), c] : [2, 0, c];
  }
  const bySize = (a, b) => { const x = sizeKey(a.size), y = sizeKey(b.size); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };

  // Next month's value, scaled by how much we normally spend that month compared with this one (from the purchase order history).
  function projection(spend, current) {
    const rows = spend.filter(r => Number(r.total_spend) > 0 && r.month_key);
    if (rows.length < 2) return null;
    const by = {};
    rows.forEach(r => { const m = Number(String(r.month_key).slice(5, 7)); (by[m] = by[m] || []).push(Number(r.total_spend)); });
    const overall = rows.reduce((s, r) => s + Number(r.total_spend), 0) / rows.length;
    const idx = m => by[m] && by[m].length ? (by[m].reduce((a, b) => a + b, 0) / by[m].length) / overall : 1;
    const now = new Date().getMonth() + 1, next = (now % 12) + 1;
    const v = current * (idx(next) / idx(now));
    return { value: v, delta: v - current };
  }

  function groups(rows) {
    const g = {};
    rows.forEach(r => {
      const k = r.product_name || r.sku;
      const o = g[k] = g[k] || { name: k, vars: [], units: 0, value: 0, low: 0 };
      o.vars.push(r); o.units += qty(r); o.value += Number(r.stock_value) || 0; if (qty(r) <= LOW_AT) o.low++;
    });
    return Object.values(g).sort((a, b) => a.name.localeCompare(b.name));
  }

  function listSection(id, cls, title, count, items, row, note) {
    const open = state.expanded[id];
    const shown = open ? items : items.slice(0, 10);
    return `<div class="st-sect ${cls}"><div class="st-sect-h"><b>${esc(title)}</b><span>${esc(count)}</span></div>
      ${shown.map(row).join('')}
      ${items.length > 10 ? `<button type="button" class="st-more" data-expand="${id}">${open ? 'Show less' : 'Show all ' + items.length}</button>` : ''}
      ${note ? `<p class="st-note">${esc(note)}</p>` : ''}</div>`;
  }

  function cardHtml(g) {
    const open = !!state.open[g.name];
    const vars = g.vars.slice().sort((a, b) => String(a.color || '').localeCompare(String(b.color || '')) || bySize(a, b));
    return `<div class="st-card${open ? ' open' : ''}"><button type="button" class="st-card-h" data-toggle="${esc(g.name)}" aria-expanded="${open}">
        <span class="st-name">${esc(g.name)}</span>
        <span class="st-meta">${g.vars.length} SKU${g.vars.length === 1 ? '' : 's'}${g.low ? ` · <em>${g.low} low</em>` : ''}</span>
        <span class="st-units">${num(g.units)} <small>units</small></span><span class="st-val">${gbp(g.value)}</span><span class="st-caret">${open ? '−' : '+'}</span></button>
      ${open ? `<div class="st-vars">${vars.map(v => `<div class="st-var"><span>${esc(v.color || '')} ${esc(v.size || '')}</span><span class="st-sku">${esc(v.sku)}</span><span class="st-pill${qty(v) <= LOW_AT ? ' low' : ''}">${num(qty(v))}</span><span class="st-val">${v.missing_cost && !v.cost_ignored ? 'no cost' : gbp2(v.stock_value)}</span></div>`).join('')}</div>` : ''}</div>`;
  }

  function render() {
    const el = $('stBody');
    if (!el) return;
    if (state.error) { el.innerHTML = `<div class="st-empty">Couldn't load the stock figures: ${esc(state.error)}<br><button type="button" class="st-btn" data-reload="1">Try again</button></div>`; return; }
    if (!state.loaded) { el.innerHTML = '<div class="st-empty">Loading…</div>'; return; }

    const all = state.rows;
    const inStock = all.filter(r => qty(r) > 0);
    const low = inStock.filter(r => qty(r) <= LOW_AT).sort((a, b) => qty(a) - qty(b) || String(a.product_name).localeCompare(String(b.product_name)));
    const workRows = all.filter(r => work(r) > 0).sort((a, b) => (Number(b.working_stock_value) || 0) - (Number(a.working_stock_value) || 0));
    const missing = all.filter(r => r.missing_cost === true && !r.cost_ignored && (qty(r) > 0 || work(r) > 0)).sort((a, b) => qty(b) - qty(a));
    const sum = k => all.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const onHand = sum('stock_value'), working = sum('working_stock_value'), total = sum('total_value');
    const proj = projection(state.spend, total);
    const q = state.q;
    const match = r => !q || [r.product_name, r.sku, r.color, r.size].join(' ').toLowerCase().includes(q);
    const shown = inStock.filter(match);
    const cats = CATEGORIES.map(c => ({ c, rows: shown.filter(r => categorise(r.product_name) === c.id) })).filter(x => x.rows.length);
    if (!cats.some(x => x.c.id === state.tab) && cats.length) state.tab = cats[0].c.id;
    const cur = cats.find(x => x.c.id === state.tab);
    const tile = (label, value, cls, sub) => `<div class="st-tile ${cls || ''}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';

    el.innerHTML = `<div class="st-tiles">
        ${tile('SKUs in stock', num(inStock.length))}${tile('Units on hand', num(inStock.reduce((s, r) => s + qty(r), 0)))}
        ${tile('Critically low (≤' + LOW_AT + ')', num(low.length), 'warn')}${tile('Products tracked', num(new Set(inStock.map(r => r.product_name)).size))}
        ${tile('Total stock value', gbp(total), 'money', 'on hand plus allocated to orders')}${tile('On-hand value', gbp(onHand), 'money')}
        ${tile('Working stock value', gbp(working), 'money', 'pulled for orders not yet shipped')}${tile('Projected value next month', proj ? gbp(proj.value) : '–', 'proj', proj ? (proj.delta >= 0 ? '▲ ' : '▼ ') + gbp(Math.abs(proj.delta)) + ' vs now' : 'needs more purchase history')}</div>
      <div class="st-tools"><input type="search" id="stSearch" value="${esc(state.q)}" placeholder="Search product, SKU or colour" aria-label="Search stock"><button type="button" class="st-btn" data-reload="1">Refresh</button></div>
      ${low.length ? listSection('low', 'low', 'Critically low: ' + LOW_AT + ' or fewer units', low.length + ' SKUs', low, r => `<div class="st-row"><span class="st-name">${esc(r.product_name)}</span><span class="st-meta">${esc(r.color || '')} ${esc(r.size || '')} · ${esc(r.sku)}</span><span class="st-pill low">${num(qty(r))}</span></div>`)
        : '<div class="st-sect ok"><div class="st-sect-h"><b>All stock healthy</b><span>nothing at 2 or fewer</span></div></div>'}
      ${workRows.length ? listSection('work', 'work', 'Working stock: allocated to orders not yet shipped', workRows.length + ' SKUs · ' + gbp(working), workRows, r => `<div class="st-row"><span class="st-name">${esc(r.product_name || r.sku)}</span><span class="st-meta">${esc(r.sku)} · ${qty(r) > 0 ? num(qty(r)) + ' on hand + ' : ''}${num(work(r))} allocated</span><span class="st-pill work">${gbp(r.working_stock_value)}</span></div>`, 'Every SKU with stock pulled for an order that has not shipped. This always adds up to the Working stock value above.') : ''}
      ${missing.length ? listSection('missing', 'missing', 'Missing cost: not counted in stock value', missing.length + ' SKUs · ' + num(missing.reduce((s, r) => s + qty(r) + work(r), 0)) + ' units', missing, r => `<div class="st-row"><span class="st-name">${esc(r.product_name || r.sku)}</span><span class="st-meta">${esc(r.sku)}</span><span class="st-pill na">${num(qty(r) + work(r))}</span></div>`, 'These SKUs have no cost in any supplier price list yet, so they are left out of the totals above rather than counted as zero.') : ''}
      ${cats.length ? `<div class="st-tabs" role="tablist">${cats.map(x => `<button type="button" role="tab" class="${x.c.id === state.tab ? 'on' : ''}" data-tab="${x.c.id}">${esc(x.c.label)} <span>${x.rows.length}</span></button>`).join('')}</div>
        <div class="st-cards">${groups(cur.rows).map(cardHtml).join('')}</div>` : '<div class="st-empty">No stock matches that search.</div>'}
      <p class="st-foot">${updated ? 'Figures last updated ' + esc(updated) + '. ' : ''}They refresh from DecoNetwork every 3 hours. Only SKUs with at least one unit on hand are listed below.</p>`;
    const s = $('stSearch');
    if (s && document.activeElement !== s && state.focusSearch) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    state.focusSearch = false;
  }

  function injectStyles() {
    if ($('stStyles')) return;
    const s = document.createElement('style');
    s.id = 'stStyles';
    s.textContent = `
#stock { color:#e2e8f0; }
#stock .st-hero { padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(34,197,94,.12), transparent 60%), rgba(15,23,42,.55); }
#stock .st-hero h2 { margin:0 0 6px; font-size:28px; } #stock .st-hero p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#stock .st-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin:18px 0; }
#stock .st-tile { padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.8); border-top:3px solid #38bdf8; }
#stock .st-tile.warn { border-top-color:#f97316; } #stock .st-tile.money { border-top-color:#22c55e; } #stock .st-tile.proj { border-top-color:#a78bfa; }
#stock .st-tile span { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; }
#stock .st-tile b { display:block; font-size:24px; margin:4px 0 2px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; } #stock .st-tile small { color:#64748b; font-size:11.5px; }
#stock .st-tools { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
#stock input[type=search] { flex:1; min-width:200px; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:#0b1222; color:#e2e8f0; font-size:14px; }
#stock .st-btn { padding:8px 14px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:13px; cursor:pointer; }
#stock .st-sect { margin-bottom:12px; padding:12px 14px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.65); border-left:4px solid #64748b; }
#stock .st-sect.low { border-left-color:#f97316; } #stock .st-sect.ok { border-left-color:#22c55e; } #stock .st-sect.work { border-left-color:#f59e0b; } #stock .st-sect.missing { border-left-color:#94a3b8; }
#stock .st-sect-h { display:flex; justify-content:space-between; gap:10px; margin-bottom:6px; flex-wrap:wrap; } #stock .st-sect-h span { color:#94a3b8; font-size:12.5px; }
#stock .st-row, #stock .st-var { display:flex; gap:12px; align-items:center; padding:6px 0; border-top:1px solid rgba(255,255,255,.06); font-size:13px; }
#stock .st-name { flex:1 1 200px; min-width:0; overflow-wrap:anywhere; font-weight:600; } #stock .st-meta { color:#94a3b8; font-size:12.5px; } #stock .st-meta em { color:#fb923c; font-style:normal; }
#stock .st-sku { flex:1; color:#64748b; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow-wrap:anywhere; }
#stock .st-pill { padding:2px 10px; border-radius:10px; background:rgba(34,197,94,.14); color:#86efac; font-size:12.5px; font-variant-numeric:tabular-nums; }
#stock .st-pill.low { background:rgba(249,115,22,.18); color:#fdba74; } #stock .st-pill.work { background:rgba(245,158,11,.15); color:#fbbf24; } #stock .st-pill.na { background:rgba(148,163,184,.15); color:#cbd5e1; }
#stock .st-more { background:transparent; border:0; color:#7dd3fc; cursor:pointer; padding:8px 0 0; font-size:13px; } #stock .st-note { margin:8px 0 0; color:#64748b; font-size:12px; line-height:1.5; }
#stock .st-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:18px 0 10px; }
#stock .st-tabs button { padding:7px 12px; border-radius:20px; border:1px solid rgba(255,255,255,.14); background:#0b1222; color:#cbd5e1; font-size:13px; cursor:pointer; } #stock .st-tabs button span { color:#64748b; margin-left:4px; }
#stock .st-tabs button.on { border-color:#38bdf8; background:rgba(56,189,248,.16); color:#e0f2fe; }
#stock .st-cards { display:flex; flex-direction:column; gap:8px; }
#stock .st-card { border-radius:12px; border:1px solid rgba(255,255,255,.09); background:rgba(15,23,42,.7); overflow:hidden; }
#stock .st-card-h { width:100%; display:flex; gap:12px; align-items:center; padding:11px 14px; background:transparent; border:0; color:inherit; cursor:pointer; text-align:left; flex-wrap:wrap; font:inherit; }
#stock .st-units { font-variant-numeric:tabular-nums; } #stock .st-units small { color:#64748b; } #stock .st-val { min-width:70px; text-align:right; color:#86efac; font-variant-numeric:tabular-nums; } #stock .st-caret { width:16px; text-align:center; color:#64748b; }
#stock .st-vars { padding:2px 14px 10px; }
#stock .st-empty { padding:30px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:12px; }
#stock .st-foot { margin-top:18px; color:#64748b; font-size:12px; max-width:760px; line-height:1.5; }
@media (max-width: 640px) { #stock .st-row, #stock .st-var { flex-wrap:wrap; } }
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
    sec.innerHTML = `<div class="st-hero"><p class="eyebrow">Operations</p><h2>Stock</h2>
      <p>What is on the shelf, what is tied up in orders that have not shipped, what it is all worth, and what is running low. Figures come from DecoNetwork and refresh every 3 hours.</p></div><div id="stBody"><div class="st-empty">Loading…</div></div>`;
    anchorPage.parentElement.appendChild(sec);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      if (e.target.closest('[data-reload]')) { load(); return; }
      const tab = e.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; render(); return; }
      const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; state.open[k] = !state.open[k]; render(); return; }
      const ex = e.target.closest('[data-expand]'); if (ex) { const k = ex.dataset.expand; state.expanded[k] = !state.expanded[k]; render(); return; }
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
