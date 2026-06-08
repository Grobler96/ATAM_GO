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

const $ = (id) => document.getElementById(id);

const sb =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
    ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

document.addEventListener('DOMContentLoaded', async () => {
  $('dateInput').value = state.date;
  bind();

  if (!sb) {
    status('Missing config');
    toast('Copy config.example.js to config.js and add Supabase details.');
    return;
  }

  await refresh();
});

function bind() {
  $('refreshBtn').onclick = refresh;

  $('dateInput').onchange = (e) => {
    state.date = e.target.value;
    refresh();
  };

  $('storeFilter').onchange = (e) => {
    state.store = e.target.value;
    refresh();
  };

  $('decorationFilter').onchange = (e) => {
    state.type = e.target.value;
    refresh();
  };

  $('searchInput').oninput = (e) => {
    state.search = e.target.value.toLowerCase();
    renderActivity();
  };

  $('triggerReadyShipWorkflow').onclick = () =>
    hook('readyShipAlert', {
      action: 'ready_to_ship_alert',
      date: state.date
    });

  $('triggerRiskWorkflow').onclick = () =>
    hook('sendRiskAlert', {
      action: 'risk_alert',
      date: state.date
    });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.onclick = () =>
      hook(button.dataset.action, {
        action: button.dataset.action,
        date: state.date,
        source: 'ATAM GO'
      });
  });
}

async function refresh() {
  try {
    status('Loading...');

    await Promise.all([
      overview(),
      deco(),
      process(),
      customers(),
      stores(),
      ready(),
      risk(),
      activity()
    ]);

    storesFilter();
    render();
    status('Connected');
  } catch (e) {
    console.error(e);
    status('Error');
    toast(e.message || 'Load failed');
  }
}

function qStore(query) {
  return state.store ? query.eq('store_name', state.store) : query;
}

function qType(query) {
  return state.type ? query.eq('decoration_type', state.type) : query;
}

async function overview() {
  const { data, error } = await sb
    .from('daily_dashboard_overview')
    .select('*')
    .eq('report_date', state.date);

  if (error) throw error;
  state.data.overview = data || [];
}

async function deco() {
  let query = sb
    .from('daily_decoration_summary')
    .select('*')
    .eq('report_date', state.date);

  query = qType(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.deco = data || [];
}

async function process() {
  let query = sb
    .from('daily_process_code_summary')
    .select('*')
    .eq('report_date', state.date);

  query = qType(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.process = data || [];
}

async function customers() {
  let query = sb
    .from('daily_customer_summary')
    .select('*')
    .eq('report_date', state.date)
    .order('total_quantity', { ascending: false })
    .limit(100);

  query = qStore(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.customers = data || [];
}

async function stores() {
  const { data, error } = await sb
    .from('daily_store_summary')
    .select('*')
    .eq('report_date', state.date)
    .order('total_quantity', { ascending: false });

  if (error) throw error;
  state.data.stores = data || [];
}

async function ready() {
  let query = sb
    .from('ready_to_ship_orders')
    .select('*')
    .order('date_due', { ascending: true, nullsFirst: false })
    .limit(100);

  query = qStore(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.ready = data || [];
}

async function risk() {
  let query = sb
    .from('late_or_at_risk_orders')
    .select('*')
    .order('date_due', { ascending: true, nullsFirst: false })
    .limit(100);

  query = qStore(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.risk = data || [];
}

async function activity() {
  let query = sb
    .from('recent_decoration_activity')
    .select('*')
    .eq('report_date', state.date)
    .order('counted_at', { ascending: false })
    .limit(1000);

  query = qStore(query);
  query = qType(query);

  const { data, error } = await query;

  if (error) throw error;
  state.data.activity = data || [];
}

function render() {
  renderKpis();
  chartDeco();
  chartProcess();

  table(
    'customerTable',
    getFilteredCustomers(),
    (r) => `
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
    getFilteredStores(),
    (r) => `
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
    (r) => `
      <tr>
        <td><strong>#${esc(r.order_id)}</strong></td>
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
    (r) => `
      <tr>
        <td><strong>#${esc(r.order_id)}</strong></td>
        <td>${esc(r.customer_name || 'Unknown')}</td>
        <td><span class="badge ${esc(r.risk_status)}">${title(r.risk_status)}</span></td>
        <td>${date(r.date_due)}</td>
        <td>${num(r.total_quantity)}</td>
      </tr>
    `,
    5
  );

  renderActivity();
}

function renderKpis() {
  const rows = getFilteredActivityRows();

  const totalDecorations = rows.reduce(
    (sum, row) => sum + Number(row.quantity || 0),
    0
  );

  const embroideryTotal = rows
    .filter((row) => row.decoration_type === 'embroidery')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  const printTotal = rows
    .filter((row) => row.decoration_type === 'print')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  const uniqueOrders = new Set(
    rows.map((row) => row.order_id).filter(Boolean)
  ).size;

  const uniqueCustomers = new Set(
    rows.map((row) => row.customer_id || row.customer_name).filter(Boolean)
  ).size;

  const decorationLines = rows.length;

  $('totalDecorations').textContent = num(totalDecorations);
  $('embroideryTotal').textContent = num(embroideryTotal);
  $('printTotal').textContent = num(printTotal);
  $('uniqueOrders').textContent = num(uniqueOrders);
  $('uniqueCustomers').textContent = num(uniqueCustomers);
  $('decorationLines').textContent = num(decorationLines);
}

function chartDeco() {
  const rows = getFilteredActivityRows();

  const totals = rows.reduce((acc, row) => {
    const type = row.decoration_type || 'unknown';
    acc[type] = (acc[type] || 0) + Number(row.quantity || 0);
    return acc;
  }, {});

  const labels = Object.keys(totals).map(title);
  const values = Object.values(totals);

  upchart('decorationChart', 'doughnut', labels, values, true);
}

function chartProcess() {
  const rows = getFilteredActivityRows();

  const totals = rows.reduce((acc, row) => {
    const code = row.process_code || 'Unknown';
    acc[code] = (acc[code] || 0) + Number(row.quantity || 0);
    return acc;
  }, {});

  const labels = Object.keys(totals);
  const values = Object.values(totals);

  upchart('processChart', 'bar', labels, values, false);
}

function upchart(id, type, labels, data, legend) {
  if (state.charts[id]) {
    state.charts[id].destroy();
  }

  const scales =
    type === 'doughnut'
      ? {}
      : {
          x: {
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(255,255,255,.06)' }
          },
          y: {
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(255,255,255,.06)' }
          }
        };

  state.charts[id] = new Chart($(id), {
    type,
    data: {
      labels,
      datasets: [
        {
          label: 'Quantity',
          data,
          borderWidth: 0,
          borderRadius: type === 'bar' ? 10 : 0
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
      scales
    }
  });
}

function renderActivity() {
  let rows = getFilteredActivityRows();

  if (state.search) {
    rows = rows.filter((r) =>
      [
        r.order_id,
        r.customer_name,
        r.store_name,
        r.product_name,
        r.decoration_type,
        r.process_code,
        r.area_name,
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
    (r) => `
      <tr>
        <td>${datetime(r.counted_at)}</td>
        <td><strong>#${esc(r.order_id)}</strong></td>
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
}

function getFilteredActivityRows() {
  return state.data.activity.filter((row) => {
    const matchesStore = !state.store || row.store_name === state.store;
    const matchesType = !state.type || row.decoration_type === state.type;

    return matchesStore && matchesType;
  });
}

function getFilteredCustomers() {
  return state.data.customers
    .filter((row) => !state.store || row.store_name === state.store)
    .slice(0, 10);
}

function getFilteredStores() {
  return state.data.stores.filter(
    (row) => !state.store || row.store_name === state.store
  );
}

function table(id, rows, fn, cols) {
  $(id).innerHTML = rows.length
    ? rows.map(fn).join('')
    : `<tr><td colspan="${cols}">No data found.</td></tr>`;
}

function storesFilter() {
  const current = $('storeFilter').value || state.store;

  const storeNames = new Set([
    ...state.data.stores.map((r) => r.store_name),
    ...state.data.customers.map((r) => r.store_name),
    ...state.data.ready.map((r) => r.store_name),
    ...state.data.risk.map((r) => r.store_name),
    ...state.data.activity.map((r) => r.store_name)
  ].filter(Boolean));

  const stores = [...storeNames].sort();

  $('storeFilter').innerHTML =
    '<option value="">All stores</option>' +
    stores.map((store) => `<option value="${esc(store)}">${esc(store)}</option>`).join('');

  $('storeFilter').value = stores.includes(current) ? current : '';
  state.store = $('storeFilter').value;
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

function status(t) {
  $('connectionStatus').textContent = t;
}

function toast(t) {
  $('toast').textContent = t;
  $('toast').classList.add('show');

  clearTimeout(toast.t);

  toast.t = setTimeout(() => {
    $('toast').classList.remove('show');
  }, 3500);
}

function num(v) {
  return new Intl.NumberFormat('en-GB').format(Number(v) || 0);
}

function date(v) {
  return v
    ? new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }).format(new Date(v))
    : '—';
}

function datetime(v) {
  return v
    ? new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(v))
    : '—';
}

function title(v = '') {
  return String(v)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(v = '') {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
