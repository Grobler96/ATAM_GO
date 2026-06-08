const cfg = window.ATAM_GO_CONFIG || {};

const state = {
  date: new Date().toISOString().slice(0, 10),
  store: '',
  type: '',
  search: '',
  charts: {},
  data: {
    overview: [],
    deco: [],
    process: [],
    customers: [],
    stores: [],
    ready: [],
    risk: [],
    activity: []
  }
};

const $ = id => document.getElementById(id);

const sb =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
    ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

document.addEventListener('DOMContentLoaded', async () => {
  if ($('dateInput')) $('dateInput').value = state.date;

  bind();

  if (!sb) {
    status('Missing config');
    toast('Copy config.example.js to config.js and add Supabase details.');
    return;
  }

  await refresh();
});

function bind() {
  if ($('refreshBtn')) $('refreshBtn').onclick = refresh;

  if ($('dateInput')) {
    $('dateInput').onchange = e => {
      state.date = e.target.value;
      refresh();
    };
  }

  if ($('storeFilter')) {
    $('storeFilter').onchange = e => {
      state.store = e.target.value;
      refresh();
    };
  }

  if ($('decorationFilter')) {
    $('decorationFilter').onchange = e => {
      state.type = e.target.value;
      refresh();
    };
  }

  if ($('searchInput')) {
    $('searchInput').oninput = e => {
      state.search = e.target.value.toLowerCase();
      renderActivity();
    };
  }

  if ($('triggerReadyShipWorkflow')) {
    $('triggerReadyShipWorkflow').onclick = () =>
      hook('readyShipAlert', {
        action: 'ready_to_ship_alert',
        date: state.date
      });
  }

  if ($('triggerRiskWorkflow')) {
    $('triggerRiskWorkflow').onclick = () =>
      hook('sendRiskAlert', {
        action: 'risk_alert',
        date: state.date
      });
  }

  document.querySelectorAll('[data-action]').forEach(button => {
    button.onclick = () =>
      hook(button.dataset.action, {
        action: button.dataset.action,
        date: state.date,
        source: 'ATAM GO'
      });
  });

  if ($('closeOrderModal')) {
    $('closeOrderModal').onclick = closeOrderModal;
  }

  if ($('orderModal')) {
    $('orderModal').onclick = e => {
      if (e.target.id === 'orderModal') {
        closeOrderModal();
      }
    };
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeOrderModal();
    }
  });
}

async function overview() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  const rows = data || [];
  const orders = new Set(rows.map(r => r.order_id).filter(Boolean));
  const customers = new Set(rows.map(r => r.customer_id || r.customer_name).filter(Boolean));

  state.data.overview = [{
    total_decorations: rows.reduce((sum, r) => sum + Number(r.quantity || 0), 0),
    embroidery_total: rows
      .filter(r => r.decoration_type === 'embroidery')
      .reduce((sum, r) => sum + Number(r.quantity || 0), 0),
    print_total: rows
      .filter(r => r.decoration_type === 'print')
      .reduce((sum, r) => sum + Number(r.quantity || 0), 0),
    unique_orders: orders.size,
    unique_customers: customers.size,
    decoration_lines: rows.length
  }];
}

async function deco() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  const grouped = {};

  for (const row of data || []) {
    const key = row.decoration_type || 'unknown';

    if (!grouped[key]) {
      grouped[key] = {
        decoration_type: key,
        total_quantity: 0,
        unique_orders_set: new Set()
      };
    }

    grouped[key].total_quantity += Number(row.quantity || 0);
    if (row.order_id) grouped[key].unique_orders_set.add(row.order_id);
  }

  state.data.deco = Object.values(grouped).map(r => ({
    decoration_type: r.decoration_type,
    total_quantity: r.total_quantity,
    unique_orders: r.unique_orders_set.size
  }));
}

async function process() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  const grouped = {};

  for (const row of data || []) {
    const key = row.process_code || 'UNKNOWN';

    if (!grouped[key]) {
      grouped[key] = {
        process_code: key,
        total_quantity: 0,
        unique_orders_set: new Set()
      };
    }

    grouped[key].total_quantity += Number(row.quantity || 0);
    if (row.order_id) grouped[key].unique_orders_set.add(row.order_id);
  }

  state.data.process = Object.values(grouped)
    .map(r => ({
      process_code: r.process_code,
      total_quantity: r.total_quantity,
      unique_orders: r.unique_orders_set.size
    }))
    .sort((a, b) => b.total_quantity - a.total_quantity);
}

async function customers() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  const grouped = {};

  for (const row of data || []) {
    const key = row.customer_name || 'Unknown';

    if (!grouped[key]) {
      grouped[key] = {
        customer_name: key,
        store_name: row.store_name || '—',
        total_quantity: 0,
        unique_orders_set: new Set()
      };
    }

    grouped[key].total_quantity += Number(row.quantity || 0);
    if (row.order_id) grouped[key].unique_orders_set.add(row.order_id);
  }

  state.data.customers = Object.values(grouped)
    .map(r => ({
      customer_name: r.customer_name,
      store_name: r.store_name,
      total_quantity: r.total_quantity,
      unique_orders: r.unique_orders_set.size
    }))
    .sort((a, b) => b.total_quantity - a.total_quantity)
    .slice(0, 10);
}

async function stores() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  const grouped = {};

  for (const row of data || []) {
    const key = row.store_name || 'Unknown';

    if (!grouped[key]) {
      grouped[key] = {
        store_name: key,
        total_quantity: 0,
        unique_orders_set: new Set(),
        unique_customers_set: new Set()
      };
    }

    grouped[key].total_quantity += Number(row.quantity || 0);
    if (row.order_id) grouped[key].unique_orders_set.add(row.order_id);
    if (row.customer_id || row.customer_name) {
      grouped[key].unique_customers_set.add(row.customer_id || row.customer_name);
    }
  }

  state.data.stores = Object.values(grouped)
    .map(r => ({
      store_name: r.store_name,
      total_quantity: r.total_quantity,
      unique_orders: r.unique_orders_set.size,
      unique_customers: r.unique_customers_set.size
    }))
    .sort((a, b) => b.total_quantity - a.total_quantity);
}

async function activity() {
  let q = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date)
    .order('counted_at', { ascending: false })
    .limit(200);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  state.data.activity = data || [];
}

function renderKpis() {
  const o = state.data.overview[0] || {};

  $('totalDecorations').textContent = num(o.total_decorations);
  $('embroideryTotal').textContent = num(o.embroidery_total);
  $('printTotal').textContent = num(o.print_total);
  $('uniqueOrders').textContent = num(o.unique_orders);
  $('uniqueCustomers').textContent = num(o.unique_customers);
  $('decorationLines').textContent = num(o.decoration_lines);
}
function render() {
  renderKpis();
  chartDeco();
  chartProcess();

  table(
    'customerTable',
    state.data.customers,
    r => `
      <tr>
        <td><strong>${esc(r.customer_name || 'Unknown')}</strong></td>
        <td>${esc(r.store_name || '—')}</td>
        <td>${num(r.total_quantity)}</td>
        <td>${num(r.unique_orders)}</td>
      </tr>
    `,
    4
  );

  table(
    'storeTable',
    state.data.stores,
    r => `
      <tr>
        <td><strong>${esc(r.store_name || 'Unknown')}</strong></td>
        <td>${num(r.total_quantity)}</td>
        <td>${num(r.unique_orders)}</td>
        <td>${num(r.unique_customers)}</td>
      </tr>
    `,
    4
  );

  table(
    'readyTable',
    state.data.ready,
    r => `
      <tr>
        <td>${orderButton(r.order_id)}</td>
        <td>${esc(r.customer_name || 'Unknown')}</td>
        <td>${num(r.total_quantity)}</td>
        <td>${date(r.date_due)}</td>
        <td>${esc(r.shipping_method || '—')}</td>
        <td>${esc(r.assigned_to || '—')}</td>
      </tr>
    `,
    6
  );

  table(
    'riskTable',
    state.data.risk,
    r => `
      <tr>
        <td>${orderButton(r.order_id)}</td>
        <td>${esc(r.customer_name || 'Unknown')}</td>
        <td><span class="badge ${esc(r.risk_status)}">${title(r.risk_status)}</span></td>
        <td>${date(r.date_due)}</td>
        <td>${num(r.total_quantity)}</td>
      </tr>
    `,
    5
  );

  renderActivity();
  bindOrderButtons();
}

function renderKpis() {
  const overviewRows = state.data.overview || [];

  const overviewTotals = overviewRows.reduce(
    (acc, row) => {
      acc.totalDecorations += Number(row.total_decorations || 0);
      acc.embroideryTotal += Number(row.embroidery_total || 0);
      acc.printTotal += Number(row.print_total || 0);
      acc.uniqueOrders += Number(row.unique_orders || 0);
      acc.uniqueCustomers += Number(row.unique_customers || 0);
      acc.decorationLines += Number(row.decoration_lines || 0);
      return acc;
    },
    {
      totalDecorations: 0,
      embroideryTotal: 0,
      printTotal: 0,
      uniqueOrders: 0,
      uniqueCustomers: 0,
      decorationLines: 0
    }
  );

  const filteredDecorationTotals = state.data.deco.reduce(
    (acc, row) => {
      const qty = Number(row.total_quantity || 0);

      acc.total += qty;

      if (row.decoration_type === 'embroidery') acc.embroidery += qty;
      if (row.decoration_type === 'print') acc.print += qty;

      return acc;
    },
    {
      total: 0,
      embroidery: 0,
      print: 0
    }
  );

  const useFilteredTotals = Boolean(state.type || state.store);

  if ($('totalDecorations')) {
    $('totalDecorations').textContent = num(
      useFilteredTotals
        ? filteredDecorationTotals.total
        : overviewTotals.totalDecorations
    );
  }

  if ($('embroideryTotal')) {
    $('embroideryTotal').textContent = num(
      useFilteredTotals
        ? filteredDecorationTotals.embroidery
        : overviewTotals.embroideryTotal
    );
  }

  if ($('printTotal')) {
    $('printTotal').textContent = num(
      useFilteredTotals
        ? filteredDecorationTotals.print
        : overviewTotals.printTotal
    );
  }

  if ($('uniqueOrders')) {
    const uniqueOrders = new Set(
      state.data.activity.map(r => r.order_id).filter(Boolean)
    ).size;

    $('uniqueOrders').textContent = num(
      useFilteredTotals ? uniqueOrders : overviewTotals.uniqueOrders
    );
  }

  if ($('uniqueCustomers')) {
    const uniqueCustomers = new Set(
      state.data.activity
        .map(r => r.customer_id || r.customer_name)
        .filter(Boolean)
    ).size;

    $('uniqueCustomers').textContent = num(
      useFilteredTotals ? uniqueCustomers : overviewTotals.uniqueCustomers
    );
  }

  if ($('decorationLines')) {
    $('decorationLines').textContent = num(
      useFilteredTotals
        ? state.data.activity.length
        : overviewTotals.decorationLines
    );
  }
}

function chartDeco() {
  upchart(
    'decorationChart',
    'doughnut',
    state.data.deco.map(r => title(r.decoration_type)),
    state.data.deco.map(r => Number(r.total_quantity || 0)),
    true
  );
}

function chartProcess() {
  upchart(
    'processChart',
    'bar',
    state.data.process.map(r => r.process_code),
    state.data.process.map(r => Number(r.total_quantity || 0)),
    false
  );
}

function upchart(id, type, labels, data, legend) {
  const el = $(id);
  if (!el) return;

  if (state.charts[id]) {
    state.charts[id].destroy();
  }

  state.charts[id] = new Chart(el, {
    type,
    data: {
      labels,
      datasets: [
        {
          label: 'Quantity',
          data,
          borderWidth: 0,
          borderRadius: 10
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: legend,
          labels: {
            color: '#cbd5e1'
          }
        }
      },
      scales:
        type === 'doughnut'
          ? {}
          : {
              x: {
                ticks: {
                  color: '#94a3b8'
                },
                grid: {
                  color: 'rgba(255,255,255,.06)'
                }
              },
              y: {
                ticks: {
                  color: '#94a3b8'
                },
                grid: {
                  color: 'rgba(255,255,255,.06)'
                }
              }
            }
    }
  });
}

function renderActivity() {
  let rows = state.data.activity;

  if (state.search) {
    rows = rows.filter(r =>
      [
        r.order_id,
        r.customer_name,
        r.store_name,
        r.product_name,
        r.decoration_type,
        r.process_code,
        r.area_name,
        r.view_name,
        r.assigned_to
      ]
        .join(' ')
        .toLowerCase()
        .includes(state.search)
    );
  }

  table(
    'activityTable',
    rows,
    r => `
      <tr>
        <td>${datetime(r.counted_at)}</td>
        <td>${orderButton(r.order_id)}</td>
        <td>${esc(r.customer_name || 'Unknown')}</td>
        <td>${esc(r.product_name || '—')}</td>
        <td><span class="badge ${esc(r.decoration_type)}">${title(r.decoration_type)}</span></td>
        <td>${esc(r.process_code || '—')}</td>
        <td>${num(r.quantity)}</td>
        <td>${esc(r.area_name || '—')}</td>
      </tr>
    `,
    8
  );

  bindOrderButtons();
}

function table(id, rows, fn, cols) {
  const el = $(id);
  if (!el) return;

  el.innerHTML = rows.length
    ? rows.map(fn).join('')
    : `<tr><td colspan="${cols}">No data found.</td></tr>`;
}

function storesFilter() {
  const el = $('storeFilter');
  if (!el) return;

  const current = el.value;

  const set = new Set(
    [
      ...state.data.stores,
      ...state.data.customers,
      ...state.data.ready,
      ...state.data.risk,
      ...state.data.activity
    ]
      .map(r => r.store_name)
      .filter(Boolean)
  );

  el.innerHTML =
    '<option value="">All stores</option>' +
    [...set]
      .sort()
      .map(store => `<option>${esc(store)}</option>`)
      .join('');

  el.value = [...set].includes(current) ? current : '';
  state.store = el.value;
}

function orderButton(orderId) {
  if (!orderId) return '—';

  return `
    <button class="order-link" data-order-id="${esc(orderId)}">
      #${esc(orderId)}
    </button>
  `;
}

function bindOrderButtons() {
  document.querySelectorAll('[data-order-id]').forEach(button => {
    button.onclick = () => openOrderModal(button.dataset.orderId);
  });
}

function openOrderModal(orderId) {
  const rows = state.data.activity.filter(
    row => String(row.order_id) === String(orderId)
  );

  if (!rows.length) {
    toast('No order data found.');
    return;
  }

  const first = rows[0];

  const totalQty = rows.reduce(
    (sum, row) => sum + Number(row.quantity || 0),
    0
  );

  const embroideryQty = rows
    .filter(row => row.decoration_type === 'embroidery')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  const printQty = rows
    .filter(row => row.decoration_type === 'print')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  if ($('modalOrderTitle')) {
    $('modalOrderTitle').textContent = `Order #${orderId}`;
  }

  if ($('modalOrderMeta')) {
    $('modalOrderMeta').innerHTML = `
      <div class="order-meta-card">
        <span>Customer</span>
        <strong>${esc(first.customer_name || 'Unknown')}</strong>
      </div>

      <div class="order-meta-card">
        <span>Store</span>
        <strong>${esc(first.store_name || '—')}</strong>
      </div>

      <div class="order-meta-card">
        <span>Assigned To</span>
        <strong>${esc(first.assigned_to || '—')}</strong>
      </div>

      <div class="order-meta-card">
        <span>Shipping</span>
        <strong>${esc(first.shipping_method || '—')}</strong>
      </div>

      <div class="order-meta-card">
        <span>Due Date</span>
        <strong>${date(first.date_due)}</strong>
      </div>

      <div class="order-meta-card">
        <span>Total Qty</span>
        <strong>${num(totalQty)}</strong>
      </div>

      <div class="order-meta-card">
        <span>Embroidery</span>
        <strong>${num(embroideryQty)}</strong>
      </div>

      <div class="order-meta-card">
        <span>Print</span>
        <strong>${num(printQty)}</strong>
      </div>
    `;
  }

  if ($('modalOrderLines')) {
    $('modalOrderLines').innerHTML = rows
      .map(
        row => `
          <tr>
            <td>${esc(row.product_name || '—')}</td>
            <td><span class="badge ${esc(row.decoration_type)}">${title(row.decoration_type)}</span></td>
            <td>${esc(row.process_code || '—')}</td>
            <td>${esc(row.view_name || '—')}</td>
            <td>${esc(row.area_name || '—')}</td>
            <td>${num(row.quantity)}</td>
          </tr>
        `
      )
      .join('');
  }

  if ($('orderModal')) {
    $('orderModal').classList.add('show');
  }
}

function closeOrderModal() {
  if ($('orderModal')) {
    $('orderModal').classList.remove('show');
  }
}

async function hook(key, payload) {
  const url = cfg.WEBHOOKS?.[key];

  if (!url) {
    toast(`No webhook set for ${key} yet.`);
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...payload,
        source: 'ATAM GO'
      })
    });

    if (!res.ok) {
      throw new Error(`Webhook failed: ${res.status}`);
    }

    toast('Workflow triggered.');
  } catch (e) {
    toast(e.message);
  }
}

function status(text) {
  if ($('connectionStatus')) {
    $('connectionStatus').textContent = text;
  }
}

function toast(text) {
  if (!$('toast')) return;

  $('toast').textContent = text;
  $('toast').classList.add('show');

  clearTimeout(toast.t);

  toast.t = setTimeout(() => {
    $('toast').classList.remove('show');
  }, 3500);
}

function num(value) {
  return new Intl.NumberFormat('en-GB').format(Number(value || 0));
}

function date(value) {
  return value
    ? new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }).format(new Date(value))
    : '—';
}

function datetime(value) {
  return value
    ? new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(value))
    : '—';
}

function title(value = '') {
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function bindPageNavigation() {
  const navButtons = document.querySelectorAll('.nav-link');
  const pages = document.querySelectorAll('.dashboard-page');

  navButtons.forEach(button => {
    button.onclick = () => {
      const targetPage = button.dataset.page;

      navButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      pages.forEach(page => {
        page.classList.remove('active');
      });

      const pageToShow = document.getElementById(targetPage);

      if (pageToShow) {
        pageToShow.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindPageNavigation();
});
