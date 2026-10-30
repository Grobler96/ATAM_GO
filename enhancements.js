/* ═══════════════════════════════════════════════════════════════
   ATAM GO — enhancements.js
   Drop-in. Add as the LAST <script> tag in your index.html,
   after app.js. Hooks into window.state and existing DOM IDs.
   Zero conflicts — all functions namespaced under window.ATAM_ENH
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── CONFIG ────────────────────────────────────────────────── */
  const NAV_ICONS = {
    overview:   '⚡',
    production: '🏭',
    orders:     '📦',
    customers:  '👥',
    activity:   '🕐',
    actions:    '⚙️',
  };

  const KPI_ACCENTS = [
    'accent-blue',
    'accent-violet',
    'accent-green',
    'accent-amber',
    'accent-red',
    'accent-cyan',
  ];

  /* ── UTILITIES ─────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const qs = (sel, ctx = document) => ctx.querySelector(sel);
  const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // app.js declares `const state = {...}`: a global variable, but NOT a property of window, so window.state is always empty.
  // Everything here reads the page's data through this.
  function appState() {
    return (typeof state !== 'undefined' && state) ? state : (window.state || null);
  }

  /* ══════════════════════════════════════════════════════════════
     1. STATUS BAR — always-visible traffic lights, with a small live clock
     Injected as the very first child of .main-content
     ══════════════════════════════════════════════════════════════ */
  function initStatusBar() {
    const main = qs('.main-content');
    if (!main) return;

    const bar = document.createElement('div');
    bar.id = 'atam-status-bar';
    bar.innerHTML = `
      <div class="atam-stat-pill">
        <div class="atam-stat-dot green" id="atam-dot-prod"></div>
        <span class="atam-stat-count" id="atam-s-total">—</span>
        <span class="atam-stat-label" id="atam-s-total-label">Decorated</span>
      </div>
      <div class="atam-stat-pill">
        <div class="atam-stat-dot amber" id="atam-dot-due"></div>
        <span class="atam-stat-count" id="atam-s-due">—</span>
        <span class="atam-stat-label">Due Today</span>
      </div>
      <div class="atam-stat-pill">
        <div class="atam-stat-dot red" id="atam-dot-late"></div>
        <span class="atam-stat-count" id="atam-s-late">—</span>
        <span class="atam-stat-label">Late / At Risk</span>
      </div>
      <div class="atam-stat-pill">
        <div class="atam-stat-dot blue"></div>
        <span class="atam-stat-count" id="atam-s-ship">—</span>
        <span class="atam-stat-label">Ready to Ship</span>
      </div>
      <div class="atam-live" title="The dashboard is connected and refreshing"><i></i><span>Live</span><time id="atam-live-clock">--:--</time></div>
    `;

    // Insert as the absolute first thing in main-content
    main.insertBefore(bar, main.firstChild);

    // a tiny clock instead of the old animated heartbeat line (which redrew a canvas 60 times a second, all day)
    const tick = () => { const c = $('atam-live-clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
    tick();
    setInterval(tick, 15000);
  }

  const RANGE_WORDS = { today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month', custom: 'Selected Dates' };
  // The page only loads the 50 most urgent late / ready orders, so a count of 50 really means "50 or more"
  const capped = n => (n >= 50 ? '50+' : fmtNum(n));

  function updateStatusBar() {
    const s = appState();
    if (!s) return;

    const overview = s.data?.overview?.[0];
    const due      = parseInt($('dueTodayCount')?.textContent?.replace(/,/g,''));
    const late     = s.data?.risk?.length || 0;
    const ship     = s.data?.ready?.length || 0;

    // "Decorated" follows the date buttons: it is the total for the dates chosen, not always today
    setText('atam-s-total-label', 'Decorated ' + (RANGE_WORDS[s.range] || 'Selected Dates'));
    setText('atam-s-total', overview ? fmtNum(overview.total_decorations) : '—');
    setText('atam-s-due',   isNaN(due) ? '—' : fmtNum(due));
    setText('atam-s-late',  capped(late));
    setText('atam-s-ship',  capped(ship));

    // Ambient glow state
    document.body.classList.remove('state-warning', 'state-critical');
    if (late >= 1) document.body.classList.add('state-critical');
    else if ((due || 0) >= 3) document.body.classList.add('state-warning');
  }

  /* ══════════════════════════════════════════════════════════════
     3. KPI CARD ACCENTS + SPARKLINES + COUNT-UP
     ══════════════════════════════════════════════════════════════ */
  // The six Overview cards (in page order) and the figures behind each: the daily series for the graph and the total that is
  // compared with the previous period for the % change.
  const OVERVIEW_KPIS = [
    { day: 'qty',    total: 'total_decorations',      color: '#38bdf8' },
    { day: 'emb',    total: 'embroidery_total',       color: '#a78bfa' },
    { day: 'print',  total: 'print_total',            color: '#22c55e' },
    { day: 'orders', total: 'unique_orders',          color: '#f59e0b' },
    { day: 'avg',    total: 'avg_garments_per_order', color: '#ef4444' },
    { day: 'lines',  total: 'decoration_lines',       color: '#06b6d4' },
  ];

  function initKpiCards() {
    const overviewCards = qsa('#overview .kpi-grid .kpi-card').slice(0, OVERVIEW_KPIS.length);
    qsa('.kpi-card').forEach((card, i) => {
      // Accent top border on every card
      card.classList.add(KPI_ACCENTS[i % KPI_ACCENTS.length]);

      const k = overviewCards.indexOf(card);
      if (k >= 0) {
        // graph and "change since the previous period" chip, only where we have the figures for them
        const sparkWrap = document.createElement('div');
        sparkWrap.className = 'atam-sparkline-wrap';
        sparkWrap.innerHTML = `<canvas id="atam-spark-${k}"></canvas>`;
        card.appendChild(sparkWrap);

        const delta = document.createElement('div');
        delta.className = 'atam-delta flat';
        delta.id = `atam-delta-${k}`;
        const small = qs('small', card);
        if (small) small.insertAdjacentElement('afterend', delta);
      }

      setTimeout(() => card.classList.add('atam-loaded'), 100 + i * 60);
    });
  }

  function updateKpiSparklines() {
    const s = appState();
    if (!s) return;

    const cur  = s.data?.overview?.[0] || {};
    const prev = s.data?.overviewPrev || null;
    const daily = s.data?.daily || [];
    const cmp = s.compare;

    OVERVIEW_KPIS.forEach((m, i) => {
      // graph: this metric day by day across the chosen dates so far (needs at least two days to be a line)
      const wrap = qs(`#atam-spark-${i}`)?.parentElement;
      const series = daily.map(d => d[m.day]);
      if (series.length >= 2) {
        drawSparkline(`atam-spark-${i}`, series, m.color);
        if (wrap) setTimeout(() => wrap.classList.add('visible'), 200 + i * 80);
      } else if (wrap) {
        wrap.classList.remove('visible');
      }

      // change: this period against the same number of days straight before it
      const delta = $(`atam-delta-${i}`);
      if (!delta) return;
      const a = Number(cur[m.total] || 0), b = prev ? Number(prev[m.total] || 0) : 0;
      if (!prev || !(b > 0) || !cmp) { delta.textContent = ''; return; }
      const pct = Math.round(((a - b) / b) * 100);
      delta.className = 'atam-delta ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
      delta.textContent = (pct > 0 ? '↑ ' : pct < 0 ? '↓ ' : '→ ') + Math.abs(pct) + '% vs ' + cmp.label;
      delta.title = `${fmtNum(a)} now, against ${fmtNum(b)} for ${cmp.title} (${cmp.from}${cmp.from !== cmp.to ? ' to ' + cmp.to : ''})`;
    });
  }

  function drawSparkline(id, data, color) {
    const canvas = $(id);
    if (!canvas || data.length < 2) return;

    const parent = canvas.parentElement;
    const W = parent.offsetWidth || 100;
    const H = 28;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const pad = 3;

    // Fill gradient under line
    const fillGrad = ctx.createLinearGradient(0, 0, 0, H);
    fillGrad.addColorStop(0, color + '44');
    fillGrad.addColorStop(1, 'transparent');

    const pts = data.map((v, i) => ({
      x: (i / (data.length - 1)) * (W - pad * 2) + pad,
      y: H - pad - ((v - min) / range) * (H - pad * 2),
    }));

    // Area fill
    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // End dot
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* ══════════════════════════════════════════════════════════════
     4. COUNT-UP ANIMATION for KPI numbers
     ══════════════════════════════════════════════════════════════ */
  const _prevValues = {};
  const _animToken = {};

  // The figure each Overview card should end on comes from the page's data, not from the text on screen: the text is half-way
  // through an animation whenever a second refresh signal arrives, which used to leave a card stuck on an old number. Starting a
  // new count-up also cancels any earlier one still running for the same card.
  function animateKpiNumbers() {
    const cur = appState()?.data?.overview?.[0];
    if (!cur) return;
    const targets = [
      { id: 'totalDecorations',    key: 'total_decorations' },
      { id: 'embroideryTotal',     key: 'embroidery_total' },
      { id: 'printTotal',          key: 'print_total' },
      { id: 'uniqueOrders',        key: 'unique_orders' },
      { id: 'avgGarmentsPerOrder', key: 'avg_garments_per_order' },
      { id: 'decorationLines',     key: 'decoration_lines' },
    ];

    targets.forEach(({ id, key }) => {
      const el = $(id);
      if (!el) return;

      const to = Math.round(Number(cur[key] || 0));
      const from = _prevValues[id] || 0;
      const token = (_animToken[id] || 0) + 1;
      _animToken[id] = token;

      if (to === from) { el.textContent = fmtNum(to); return; }
      _prevValues[id] = to;

      const card = el.closest('.kpi-card');
      if (card) card.classList.add('atam-counting');

      const duration = 700;
      const start = performance.now();

      function step(now) {
        if (_animToken[id] !== token) return;   // a newer refresh has taken over this card
        const t = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3); // ease-out-cubic
        const current = Math.round(from + (to - from) * ease);
        el.textContent = fmtNum(current);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          el.textContent = fmtNum(to);
          if (card) card.classList.remove('atam-counting');
        }
      }
      requestAnimationFrame(step);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     5. NAV ICONS + BADGES
     ══════════════════════════════════════════════════════════════ */
  function initNavEnhancements() {
    qsa('.nav-link').forEach(btn => {
      const page = btn.dataset.page;
      if (!page || !NAV_ICONS[page]) return;

      // Prepend icon
      const icon = document.createElement('span');
      icon.className = 'atam-nav-icon';
      icon.textContent = NAV_ICONS[page];
      btn.prepend(icon);
    });
  }

  // Red count on the Dispatch button: orders that are late or at risk (the page loads the 50 most urgent, so 50 means 50 or more).
  // The Dispatch button is added a moment after load by dispatch.js, so this is also retried a few times at start-up.
  function updateNavBadges() {
    const s = appState();
    if (!s) return;
    const count = s.data?.risk?.length || 0;
    const btn = qs('.nav-link[data-page="dispatch"]');
    if (!btn) return;

    let badge = qs('.atam-nav-badge', btn);
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'atam-nav-badge';
        badge.title = 'Late or at-risk orders';
        btn.appendChild(badge);
      }
      badge.textContent = count >= 50 ? '50+' : count;
    } else if (badge) {
      badge.remove();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     6. TABLE ROW STAGGER
     Re-runs after every render by observing tbody mutations
     ══════════════════════════════════════════════════════════════ */
  function initTableAnimations() {
    const tbodies = qsa('tbody');
    const observer = new MutationObserver(mutations => {
      mutations.forEach(m => {
        if (m.type === 'childList' && m.addedNodes.length) {
          qsa('tr', m.target).forEach((row, i) => {
            row.style.animationDelay = `${i * 28}ms`;
          });
        }
      });
    });

    tbodies.forEach(tb => observer.observe(tb, { childList: true }));
  }

  /* ══════════════════════════════════════════════════════════════
     7. CONNECTION STATUS COLOURS
     ══════════════════════════════════════════════════════════════ */
  function watchConnectionStatus() {
    const el = $('connectionStatus');
    if (!el) return;

    const observer = new MutationObserver(() => {
      const txt = (el.textContent || '').toLowerCase();
      el.classList.remove('status-connected', 'status-loading', 'status-error');
      if (txt.includes('connected')) el.classList.add('status-connected');
      else if (txt.includes('load') || txt.includes('connect')) el.classList.add('status-loading');
      else if (txt.includes('error')) el.classList.add('status-error');
    });

    observer.observe(el, { childList: true, characterData: true, subtree: true });
  }

  /* ══════════════════════════════════════════════════════════════
     8. REFRESH BTN SPIN
     ══════════════════════════════════════════════════════════════ */
  function initRefreshBtn() {
    const btn = $('refreshBtn');
    if (!btn) return;

    const originalClick = btn.onclick;
    btn.onclick = async function (...args) {
      btn.classList.add('refreshing');
      try {
        if (originalClick) await originalClick.apply(this, args);
      } finally {
        setTimeout(() => btn.classList.remove('refreshing'), 1200);
      }
    };
  }

  /* ══════════════════════════════════════════════════════════════
     9. DAN FAB — proactive insight notification dot
     Shows a red dot when there are late orders or at-risk customers
     ══════════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════
     10. TOPBAR sticky — becomes more opaque on scroll
     ══════════════════════════════════════════════════════════════ */
  function initTopbarScroll() {
    const main = qs('.main-content');
    const topbar = qs('.topbar');
    if (!main || !topbar) return;

    main.addEventListener('scroll', () => {
      const scrolled = main.scrollTop > 10;
      topbar.style.boxShadow = scrolled
        ? '0 8px 32px rgba(0,0,0,0.45)'
        : 'none';
      topbar.style.borderBottomColor = scrolled
        ? 'rgba(56,189,248,0.18)'
        : 'rgba(255,255,255,0.06)';
    });
  }

  /* ══════════════════════════════════════════════════════════════
     HOOK INTO app.js — patch the existing render/refresh cycle
     ══════════════════════════════════════════════════════════════ */
  function patchAppRefresh() {
    // We wait for the original refresh() to finish by observing
    // the connectionStatus element changing to 'Connected'
    const statusEl = $('connectionStatus');
    if (!statusEl) return;

    const observer = new MutationObserver(() => {
      const txt = (statusEl.textContent || '').toLowerCase();
      if (txt === 'connected') {
        // Small tick to let app.js complete its render cycle first
        setTimeout(() => {
          updateStatusBar();
          updateKpiSparklines();
          animateKpiNumbers();
          updateNavBadges();
            }, 80);
      }
    });

    observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
  }

  /* ── HELPERS ───────────────────────────────────────────────── */
  function fmtNum(n) {
    return new Intl.NumberFormat('en-GB').format(Number(n || 0));
  }

  function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }

  /* ══════════════════════════════════════════════════════════════
     BOOT — runs after DOM is ready
     ══════════════════════════════════════════════════════════════ */
  function boot() {
    initStatusBar();
    initNavEnhancements();
    initKpiCards();
    initTableAnimations();
    initRefreshBtn();
    initTopbarScroll();
    watchConnectionStatus();
    patchAppRefresh();

    // Dispatch is added to the sidebar a little after load, so try its badge again a few times
    [2500, 6000, 12000].forEach(ms => setTimeout(updateNavBadges, ms));

    // Initial draw tick after a short delay
    // (in case data was already loaded before this script ran)
    setTimeout(() => {
      updateStatusBar();
      updateKpiSparklines();
      updateNavBadges();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for manual calls if needed from console
  window.ATAM_ENH = {
    updateStatusBar,
    updateKpiSparklines,
    updateNavBadges,
    animateKpiNumbers,
  };

})();
