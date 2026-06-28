/* ═══════════════════════════════════════════════════════════════
   ATAM GO — Dispatch Command Centre
   Drop-in module. Reads window.state.data and window.ATAM_GO_CONFIG
   Auto-refreshes every 60 seconds. Zero dependency on core files.
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ── Constants ── */
  const REFRESH_MS = 60_000;
  const DISPATCH_CUTOFF_HOUR = 16; // 4pm = last dispatch

  const CARRIER_ICONS = {
    'DPD': '🟥',
    'Royal Mail': '🔴',
    'Tracked Courier': '📦',
    'Local Delivery': '🚐',
    'Collated Delivery': '🗂️',
    'Collection': '🏪',
  };

  const STATUS_MAP = {
    1: 'Quote',
    2: 'Production Complete',
    3: 'Shipped',
    4: 'Cancelled',
    5: 'On Hold',
    6: 'Awaiting Stock',
    7: 'Awaiting Artwork',
    8: 'In Production',
    9: 'Awaiting Payment',
  };

  /* ── State ── */
  let dispatchData = [];
  let dispatchedOrders = new Set(
    JSON.parse(localStorage.getItem('atam_dispatched') || '[]')
  );
  let dispatchTimer = null;
  let countdownInterval = null;
  let currentFilter = 'all';

  /* ── Init ── */
  function initDispatch() {
    injectStyles();
    injectPage();
    hookNavLink();
    loadAndRender();
    startCountdownTick();

    dispatchTimer = setInterval(loadAndRender, REFRESH_MS);
  }

  /* ── Hook sidebar nav — fully integrates with app.js page system ── */
  function hookNavLink() {
    const dispatchBtn = document.querySelector('[data-page="dispatch"]');
    if (!dispatchBtn) return;

    dispatchBtn.addEventListener('click', () => {
      // 1. Remove active from all nav links
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      dispatchBtn.classList.add('active');

      // 2. Hide all pages
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));

      // 3. Show dispatch page
      const dispatchPage = document.getElementById('dispatch');
      if (dispatchPage) {
        dispatchPage.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      // 4. Hide global filter controls — not relevant for dispatch
      const filterControls = document.querySelector('.topbar-controls');
      if (filterControls) filterControls.style.display = 'none';

      // 5. Refresh data
      loadAndRender();
    });
  }

  /* ── Load data from Supabase — always shows today + tomorrow ── */
  async function loadAndRender() {
    try {
      const cfg = window.ATAM_GO_CONFIG || {};
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;

      const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

      // Last 48 hours (overdue/missed) + next 14 days (upcoming) from WF3 table
      const from48h = new Date(Date.now() - 48 * 3600000).toISOString();
      const next14d = new Date(Date.now() + 14 * 86400000).toISOString();

      // Try upcoming_orders first (populated by WF3)
      // Fall back to decoration_records if table is empty or errors
      let data = null;
      let source = 'upcoming_orders';

      const { data: upcomingData, error: upcomingError } = await sb
        .from('upcoming_orders')
        .select('*')
        .gte('date_due', from48h)
        .lte('date_due', next14d)
        .order('date_due', { ascending: true });

      if (!upcomingError && upcomingData && upcomingData.length > 0) {
        // upcoming_orders has data — use it
        data = upcomingData;
        source = 'upcoming_orders';
      } else {
        // WF3 hasn't run yet — fall back to decoration_records
        console.log('[Dispatch] upcoming_orders empty or error, falling back to decoration_records');
        source = 'decoration_records';

        const { data: fallbackData, error: fallbackError } = await sb
          .from('decoration_records')
          .select('*')
          .gte('date_due', from48h)
          .lte('date_due', next14d)
          .order('date_due', { ascending: true });

        if (!fallbackError) data = fallbackData;
      }

      if (source === 'upcoming_orders') {
        // upcoming_orders — already one row per order
        dispatchData = (data || []).map(o => ({
          order_id: o.order_id,
          customer_name: o.customer_name || 'Unknown',
          store_name: o.store_name || '—',
          shipping_method: o.shipping_method || '—',
          date_due: o.date_due,
          date_produced: o.date_produced,
          date_shipped: o.date_shipped,
          assigned_to: o.assigned_to || null,
          order_status: o.order_status,
          total_qty: o.total_quantity || 0,
          processes: o.processes || [],
          is_production_complete: o.is_production_complete || false,
          products: o.products || [],
          dispatched: dispatchedOrders.has(String(o.order_id)),
        }));
      } else {
        // decoration_records — group by order_id first
        const grouped = {};
        for (const row of data || []) {
          const key = row.order_id;
          if (!key) continue;
          if (!grouped[key]) {
            grouped[key] = {
              order_id: key,
              customer_name: row.customer_name || 'Unknown',
              store_name: row.store_name || '—',
              shipping_method: row.shipping_method || '—',
              date_due: row.date_due,
              date_produced: row.date_produced,
              date_shipped: row.date_shipped,
              assigned_to: row.assigned_to || null,
              order_status: row.order_status,
              total_qty: 0,
              processes: new Set(),
              is_production_complete: !!row.date_produced,
              products: [],
            };
          }
          grouped[key].total_qty += Number(row.quantity || 0);
          if (row.process_code) grouped[key].processes.add(row.process_code);
        }
        dispatchData = Object.values(grouped).map(o => ({
          ...o,
          processes: [...o.processes],
          dispatched: dispatchedOrders.has(String(o.order_id)),
        }));
      }

      renderDispatch();

    } catch (err) {
      console.error('[Dispatch]', err);
      // Always render even on error — shows empty state rather than broken tab
      renderDispatch();
    }
  }

  /* ── Render ── */
  function renderDispatch() {
    renderSummaryBar();
    renderCards();
  }

  function renderSummaryBar() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const all = dispatchData;
    const todayOrders   = all.filter(o => o.date_due && new Date(o.date_due).toISOString().slice(0, 10) === todayStr);
    const overdueOrders = all.filter(o => o.date_due && new Date(o.date_due) < now && !o.dispatched && !o.date_shipped);
    const dispatched    = all.filter(o => o.dispatched || o.date_shipped).length;
    const upcoming      = all.filter(o => o.date_due && new Date(o.date_due) > now && !o.dispatched && !o.date_shipped).length;
    const critical      = all.filter(o => getUrgency(o) === 'critical' && !o.dispatched && !o.date_shipped).length;

    // Progress bar based on today's orders only
    const todayDispatched = todayOrders.filter(o => o.dispatched || o.date_shipped).length;
    const todayPct = todayOrders.length ? Math.round((todayDispatched / todayOrders.length) * 100) : 0;

    const el = document.getElementById('dispatch-summary-bar');
    if (!el) return;

    el.innerHTML = `
      <div class="dsb-stat">
        <span class="dsb-num ${overdueOrders.length > 0 ? 'dsb-red pulse-num' : 'dsb-green'}">${overdueOrders.length}</span>
        <span class="dsb-label">Overdue</span>
      </div>
      <div class="dsb-divider"></div>
      <div class="dsb-stat">
        <span class="dsb-num ${critical > 0 ? 'dsb-red' : 'dsb-green'}">${critical}</span>
        <span class="dsb-label">Critical Today</span>
      </div>
      <div class="dsb-divider"></div>
      <div class="dsb-stat">
        <span class="dsb-num dsb-green">${dispatched}</span>
        <span class="dsb-label">Dispatched</span>
      </div>
      <div class="dsb-divider"></div>
      <div class="dsb-stat">
        <span class="dsb-num dsb-amber">${upcoming}</span>
        <span class="dsb-label">Upcoming</span>
      </div>
      <div class="dsb-progress-wrap">
        <div class="dsb-progress-track">
          <div class="dsb-progress-fill" style="width:${todayPct}%"></div>
        </div>
        <span class="dsb-progress-pct">Today: ${todayPct}% dispatched</span>
      </div>
    `;
  }

  function renderCards() {
    const grid = document.getElementById('dispatch-card-grid');
    if (!grid) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    let orders = [...dispatchData];

    // Filter
    if (currentFilter === 'overdue') {
      orders = orders.filter(o => o.date_due && new Date(o.date_due) < now && !o.dispatched && !o.date_shipped);
    } else if (currentFilter === 'today') {
      orders = orders.filter(o => o.date_due && new Date(o.date_due).toISOString().slice(0, 10) === todayStr);
    } else if (currentFilter === 'upcoming') {
      orders = orders.filter(o => o.date_due && new Date(o.date_due) > now && !o.dispatched && !o.date_shipped);
    } else if (currentFilter === 'critical') {
      orders = orders.filter(o => getUrgency(o) === 'critical' && !o.dispatched && !o.date_shipped);
    } else if (currentFilter === 'pending') {
      orders = orders.filter(o => !o.dispatched && !o.date_shipped);
    } else if (currentFilter === 'notproduced') {
      orders = orders.filter(o => !o.date_produced && !o.dispatched && !o.date_shipped);
    } else if (currentFilter === 'done') {
      orders = orders.filter(o => o.dispatched || o.date_shipped);
    }

    if (!orders.length) {
      grid.innerHTML = `
        <div class="dispatch-empty">
          <div class="dispatch-empty-icon">✅</div>
          <p>No orders match this filter.</p>
        </div>
      `;
      return;
    }

    // Group orders by due date for day headers
    const grouped = {};
    orders.forEach(order => {
      const dayKey = order.date_due
        ? new Date(order.date_due).toISOString().slice(0, 10)
        : 'no-date';
      if (!grouped[dayKey]) grouped[dayKey] = [];
      grouped[dayKey].push(order);
    });

    // Build HTML with day group headers
    let html = '';
    Object.keys(grouped).sort().forEach(dayKey => {
      const dayOrders = grouped[dayKey];
      const dayDate = dayKey !== 'no-date' ? new Date(dayKey) : null;
      const isToday = dayKey === todayStr;
      const isPast = dayDate && dayDate < now && !isToday;
      const isTomorrow = dayKey === new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      const dayLabel = dayDate
        ? dayDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
        : 'No Date';

      const badge = isToday ? '<span class="day-badge day-today">Today</span>'
        : isPast ? '<span class="day-badge day-overdue">Overdue</span>'
        : isTomorrow ? '<span class="day-badge day-tomorrow">Tomorrow</span>'
        : '';

      html += `
        <div class="dispatch-day-header">
          <span class="dispatch-day-label">${dayLabel}</span>
          ${badge}
          <span class="dispatch-day-count">${dayOrders.length} order${dayOrders.length !== 1 ? 's' : ''}</span>
        </div>
      `;
      html += dayOrders.map(order => buildCard(order)).join('');
    });

    grid.innerHTML = html;

    // Bind dispatch buttons
    grid.querySelectorAll('.dispatch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const orderId = btn.dataset.orderId;
        markDispatched(orderId, btn);
      });
    });
  }

  function buildCard(order) {
    const urgency = getUrgency(order);
    const isDone = order.dispatched || !!order.date_shipped;
    const dueDate = order.date_due ? new Date(order.date_due) : null;
    const timeStr = dueDate ? dueDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
    const dateStr = dueDate ? dueDate.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : '—';

    const carrierIcon = Object.entries(CARRIER_ICONS).find(([k]) =>
      order.shipping_method?.includes(k)
    )?.[1] || '📬';

    const statusLabel = STATUS_MAP[order.order_status] || `Status ${order.order_status}`;
    const isProduced = !!order.date_produced;

    const countdown = dueDate && !isDone ? getCountdown(dueDate) : null;
    const countdownHtml = countdown
      ? `<div class="dc-countdown ${countdown.urgent ? 'dc-countdown-urgent' : ''}" data-due="${order.date_due}">
          ${countdown.text}
        </div>`
      : '';

    return `
      <div class="dispatch-card ${urgency} ${isDone ? 'dc-done' : ''}" data-order-id="${order.order_id}">
        <div class="dc-header">
          <div class="dc-order-id">
            <span class="dc-hash">#</span>${order.order_id}
          </div>
          <div class="dc-urgency-dot ${urgency}"></div>
        </div>

        <div class="dc-customer">${esc(order.customer_name)}</div>
        <div class="dc-store">${esc(order.store_name)}</div>

        <div class="dc-meta-row">
          <div class="dc-meta-item">
            <span class="dc-meta-label">Due</span>
            <span class="dc-meta-val">${dateStr} <strong>${timeStr}</strong></span>
          </div>
          <div class="dc-meta-item">
            <span class="dc-meta-label">Carrier</span>
            <span class="dc-meta-val">${carrierIcon} ${esc(order.shipping_method)}</span>
          </div>
        </div>

        <div class="dc-meta-row">
          <div class="dc-meta-item">
            <span class="dc-meta-label">Qty</span>
            <span class="dc-meta-val"><strong>${order.total_qty}</strong> items</span>
          </div>
          <div class="dc-meta-item">
            <span class="dc-meta-label">Assigned</span>
            <span class="dc-meta-val">${esc(order.assigned_to || 'Unassigned')}</span>
          </div>
        </div>

        <div class="dc-tags-row">
          ${order.processes.map(p => `<span class="dc-tag">${esc(p)}</span>`).join('')}
          <span class="dc-tag dc-tag-status ${isProduced ? 'dc-tag-produced' : ''}">${isProduced ? '✓ Produced' : statusLabel}</span>
        </div>

        ${countdownHtml}

        <div class="dc-actions">
          ${isDone
            ? `<div class="dc-dispatched-badge">✓ Dispatched ${order.date_shipped ? new Date(order.date_shipped).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</div>`
            : `<button class="dispatch-btn ${!isProduced ? 'dispatch-btn-warn' : ''}" data-order-id="${order.order_id}">
                ${!isProduced ? '⚠️ Mark Dispatched' : '✓ Mark Dispatched'}
              </button>`
          }
        </div>
      </div>
    `;
  }

  /* ── Urgency logic ── */
  function getUrgency(order) {
    if (order.dispatched || order.date_shipped) return 'done';

    const now = new Date();
    const due = order.date_due ? new Date(order.date_due) : null;
    if (!due) return 'normal';

    const msLeft = due - now;
    const hoursLeft = msLeft / 3600000;

    if (msLeft < 0) return 'critical'; // overdue
    if (hoursLeft <= 1) return 'critical';
    if (hoursLeft <= 3) return 'warning';
    return 'normal';
  }

  /* ── Countdown ── */
  function getCountdown(dueDate) {
    const now = new Date();
    const msLeft = dueDate - now;

    if (msLeft < 0) {
      const overBy = Math.abs(msLeft);
      const h = Math.floor(overBy / 3600000);
      const m = Math.floor((overBy % 3600000) / 60000);
      return { text: `⚠️ Overdue by ${h}h ${m}m`, urgent: true };
    }

    const h = Math.floor(msLeft / 3600000);
    const m = Math.floor((msLeft % 3600000) / 60000);
    const s = Math.floor((msLeft % 60000) / 1000);

    if (h > 6) return null; // no countdown needed if plenty of time
    if (h === 0 && m <= 30) {
      return { text: `🔴 ${m}m ${s}s remaining`, urgent: true };
    }
    return { text: `⏱ ${h}h ${m}m remaining`, urgent: h === 0 };
  }

  /* ── Live countdown tick ── */
  function startCountdownTick() {
    countdownInterval = setInterval(() => {
      document.querySelectorAll('[data-due]').forEach(el => {
        const due = new Date(el.dataset.due);
        const result = getCountdown(due);
        if (result) {
          el.textContent = result.text;
          el.classList.toggle('dc-countdown-urgent', result.urgent);
        }
      });

      // Re-render summary bar every tick
      renderSummaryBar();

      // Re-render cards every minute to update urgency classes
    }, 1000);
  }

  /* ── Mark dispatched ── */
  function markDispatched(orderId, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving…';
    }

    dispatchedOrders.add(String(orderId));
    localStorage.setItem('atam_dispatched', JSON.stringify([...dispatchedOrders]));

    // Update local data
    const order = dispatchData.find(o => String(o.order_id) === String(orderId));
    if (order) order.dispatched = true;

    // Animate card out briefly then re-render
    const card = document.querySelector(`.dispatch-card[data-order-id="${orderId}"]`);
    if (card) {
      card.classList.add('dc-flash-green');
      setTimeout(() => renderDispatch(), 600);
    } else {
      renderDispatch();
    }

    // Optional: push to webhook if configured
    const cfg = window.ATAM_GO_CONFIG || {};
    const webhookUrl = cfg.WEBHOOKS?.dispatchConfirm;
    if (webhookUrl && order) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dispatch_confirmed',
          order_id: orderId,
          customer_name: order.customer_name,
          shipping_method: order.shipping_method,
          confirmed_at: new Date().toISOString(),
          source: 'ATAM GO Dispatch'
        })
      }).catch(() => {});
    }
  }

  /* ── Filter buttons ── */
  function bindFilterButtons() {
    document.querySelectorAll('.dispatch-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dispatch-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderCards();
      });
    });
  }

  /* ── Inject page HTML ── */
  function injectPage() {
    // Add nav link
    const nav = document.querySelector('.sidebar-nav');
    if (nav && !document.querySelector('[data-page="dispatch"]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-link';
      btn.dataset.page = 'dispatch';
      btn.innerHTML = '<span>Dispatch</span>';
      nav.appendChild(btn);
    }

    // Patch existing nav links so they also hide the dispatch page
    // and restore the global filter controls
    document.querySelectorAll('.nav-link:not([data-page="dispatch"])').forEach(btn => {
      btn.addEventListener('click', () => {
        const dispatchPage = document.getElementById('dispatch');
        const dispatchBtn = document.querySelector('[data-page="dispatch"]');
        if (dispatchPage) dispatchPage.classList.remove('active');
        if (dispatchBtn) dispatchBtn.classList.remove('active');

        // Restore global filter controls
        const filterControls = document.querySelector('.topbar-controls');
        if (filterControls) filterControls.style.display = '';
      });
    });

    // Add page section
    const main = document.querySelector('.main-content');
    if (!main || document.getElementById('dispatch')) return;

    const section = document.createElement('section');
    section.id = 'dispatch';
    section.className = 'dashboard-page';
    section.innerHTML = `
      <div class="page-header">
        <div>
          <p class="eyebrow">Dispatch Command Centre</p>
          <h2>Today's Dispatch</h2>
          <p class="page-subtitle">Live order dispatch tracking — auto-refreshes every 60 seconds.</p>
        </div>
        <button type="button" class="primary-btn" onclick="window._dispatchRefresh()">↺ Refresh</button>
      </div>

      <div id="dispatch-summary-bar" class="dispatch-summary-bar">
        <div class="dsb-stat">
          <span class="dsb-num">—</span>
          <span class="dsb-label">Loading…</span>
        </div>
      </div>

      <div class="dispatch-filter-row">
        <button class="dispatch-filter-btn active" data-filter="all">All</button>
        <button class="dispatch-filter-btn" data-filter="overdue">🔴 Overdue</button>
        <button class="dispatch-filter-btn" data-filter="today">Today</button>
        <button class="dispatch-filter-btn" data-filter="upcoming">Upcoming</button>
        <button class="dispatch-filter-btn" data-filter="critical">⚡ Critical</button>
        <button class="dispatch-filter-btn" data-filter="pending">Pending</button>
        <button class="dispatch-filter-btn" data-filter="notproduced">⚠️ Not Produced</button>
        <button class="dispatch-filter-btn" data-filter="done">✓ Done</button>
      </div>

      <div id="dispatch-card-grid" class="dispatch-card-grid">
        <div class="dispatch-empty">
          <div class="dispatch-empty-icon">⏳</div>
          <p>Loading dispatch data…</p>
        </div>
      </div>
    `;

    main.appendChild(section);
    bindFilterButtons();

    window._dispatchRefresh = loadAndRender;
  }

  /* ── Inject styles ── */
  function injectStyles() {
    if (document.getElementById('dispatch-styles')) return;

    const style = document.createElement('style');
    style.id = 'dispatch-styles';
    style.textContent = `
      /* ── Summary Bar ── */
      .dispatch-summary-bar {
        display: flex;
        align-items: center;
        gap: 0;
        background: #0d1525;
        border: 1px solid #1e2d45;
        border-radius: 12px;
        padding: 20px 28px;
        margin-bottom: 20px;
        flex-wrap: wrap;
        gap: 12px;
      }
      .dsb-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 80px;
      }
      .dsb-num {
        font-size: 32px;
        font-weight: 800;
        line-height: 1;
        color: #e8edf5;
        font-variant-numeric: tabular-nums;
      }
      .dsb-label {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #64748b;
        margin-top: 4px;
      }
      .dsb-green { color: #22c55e !important; }
      .dsb-amber { color: #f59e0b !important; }
      .dsb-red   { color: #ef4444 !important; }
      .dsb-divider {
        width: 1px;
        height: 40px;
        background: #1e2d45;
        margin: 0 20px;
      }
      .dsb-progress-wrap {
        flex: 1;
        min-width: 160px;
        margin-left: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dsb-progress-track {
        height: 6px;
        background: #1e2d45;
        border-radius: 3px;
        overflow: hidden;
      }
      .dsb-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #22c55e, #16a34a);
        border-radius: 3px;
        transition: width 0.6s ease;
      }
      .dsb-progress-pct {
        font-size: 11px;
        color: #64748b;
        font-weight: 600;
      }
      .pulse-num {
        animation: pulse-red 1.2s ease-in-out infinite;
      }
      @keyframes pulse-red {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* ── Filter Row ── */
      .dispatch-filter-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      .dispatch-filter-btn {
        padding: 7px 16px;
        border-radius: 20px;
        border: 1px solid #1e2d45;
        background: #0d1525;
        color: #64748b;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        letter-spacing: 0.04em;
        transition: all 0.15s;
      }
      .dispatch-filter-btn:hover { border-color: #f97316; color: #f97316; }
      .dispatch-filter-btn.active {
        background: #f97316;
        border-color: #f97316;
        color: #fff;
      }

      /* ── Card Grid ── */
      .dispatch-card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
      }

      /* ── Cards ── */
      .dispatch-card {
        background: #0d1525;
        border: 1px solid #1e2d45;
        border-radius: 12px;
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        transition: transform 0.15s, box-shadow 0.15s;
        position: relative;
        overflow: hidden;
      }
      .dispatch-card::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 4px;
        height: 100%;
        border-radius: 12px 0 0 12px;
      }
      .dispatch-card.normal::before  { background: #22c55e; }
      .dispatch-card.warning::before { background: #f59e0b; }
      .dispatch-card.critical::before { background: #ef4444; }
      .dispatch-card.done::before    { background: #334155; }

      .dispatch-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      }
      .dispatch-card.dc-done {
        opacity: 0.55;
      }
      .dispatch-card.dc-flash-green {
        animation: flash-green 0.6s ease;
      }
      @keyframes flash-green {
        0%   { background: #0d1525; }
        40%  { background: rgba(34,197,94,0.2); border-color: #22c55e; }
        100% { background: #0d1525; }
      }

      .dc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .dc-order-id {
        font-size: 18px;
        font-weight: 800;
        color: #e8edf5;
        letter-spacing: -0.5px;
      }
      .dc-hash { color: #64748b; font-weight: 400; }

      .dc-urgency-dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .dc-urgency-dot.normal   { background: #22c55e; }
      .dc-urgency-dot.warning  { background: #f59e0b; animation: pulse-amber 2s infinite; }
      .dc-urgency-dot.critical { background: #ef4444; animation: pulse-red-dot 1s infinite; }
      .dc-urgency-dot.done     { background: #334155; }
      @keyframes pulse-amber {
        0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.4); }
        50%       { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
      }
      @keyframes pulse-red-dot {
        0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
        50%       { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
      }

      .dc-customer {
        font-size: 15px;
        font-weight: 700;
        color: #e8edf5;
        line-height: 1.2;
      }
      .dc-store {
        font-size: 12px;
        color: #64748b;
        margin-top: -6px;
      }

      .dc-meta-row {
        display: flex;
        gap: 16px;
      }
      .dc-meta-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
      }
      .dc-meta-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #475569;
      }
      .dc-meta-val {
        font-size: 13px;
        color: #94a3b8;
      }
      .dc-meta-val strong { color: #e8edf5; }

      .dc-tags-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .dc-tag {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 4px;
        background: #1e2d45;
        color: #64748b;
      }
      .dc-tag-status { background: #1e293b; color: #94a3b8; }
      .dc-tag-produced { background: rgba(34,197,94,0.15); color: #22c55e; }

      .dc-countdown {
        font-size: 13px;
        font-weight: 700;
        color: #94a3b8;
        background: #131929;
        border-radius: 6px;
        padding: 6px 10px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .dc-countdown-urgent {
        color: #ef4444;
        background: rgba(239,68,68,0.08);
        animation: flicker 1.5s ease-in-out infinite;
      }
      @keyframes flicker {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      .dc-actions {
        margin-top: 4px;
      }
      .dispatch-btn {
        width: 100%;
        padding: 10px;
        background: rgba(249,115,22,0.15);
        border: 1px solid rgba(249,115,22,0.4);
        border-radius: 8px;
        color: #f97316;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.15s;
        letter-spacing: 0.03em;
      }
      .dispatch-btn:hover {
        background: #f97316;
        color: #fff;
      }
      .dispatch-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .dispatch-btn-warn {
        border-color: rgba(245,158,11,0.4);
        color: #f59e0b;
        background: rgba(245,158,11,0.1);
      }
      .dispatch-btn-warn:hover {
        background: #f59e0b;
        color: #fff;
        border-color: #f59e0b;
      }
      .dc-dispatched-badge {
        text-align: center;
        color: #22c55e;
        font-size: 13px;
        font-weight: 700;
        padding: 8px;
        background: rgba(34,197,94,0.08);
        border-radius: 8px;
        border: 1px solid rgba(34,197,94,0.2);
      }

      /* ── Day group headers ── */
      .dispatch-day-header {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 0 6px;
        border-bottom: 1px solid #1e2d45;
        margin-bottom: 4px;
        margin-top: 8px;
      }
      .dispatch-day-header:first-child { margin-top: 0; }
      .dispatch-day-label {
        font-size: 14px;
        font-weight: 700;
        color: #e8edf5;
        letter-spacing: -0.2px;
      }
      .dispatch-day-count {
        font-size: 12px;
        color: #64748b;
        margin-left: auto;
        font-weight: 600;
      }
      .day-badge {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 4px;
      }
      .day-today    { background: rgba(249,115,22,0.15); color: #f97316; }
      .day-tomorrow { background: rgba(34,197,94,0.12);  color: #22c55e; }
      .day-overdue  { background: rgba(239,68,68,0.15);  color: #ef4444; animation: pulse-red 1.5s infinite; }

      /* ── Empty state ── */
      .dispatch-empty {
        grid-column: 1 / -1;
        text-align: center;
        padding: 60px 20px;
        color: #64748b;
      }
      .dispatch-empty-icon {
        font-size: 48px;
        margin-bottom: 12px;
      }

      /* ── Responsive ── */
      @media (max-width: 600px) {
        .dispatch-card-grid { grid-template-columns: 1fr; }
        .dispatch-summary-bar { gap: 16px; justify-content: center; }
        .dsb-divider { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Utility ── */
  function esc(val = '') {
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Boot when DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDispatch);
  } else {
    initDispatch();
  }

})();
