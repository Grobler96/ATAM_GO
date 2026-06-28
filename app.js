const cfg = window.ATAM_GO_CONFIG || {};

const todayIso = new Date().toISOString().slice(0, 10);

const state = {
  dateFrom: todayIso,
  dateTo: todayIso,
  range: 'today',
  store: '',
  type: '',
  search: '',
  customerSearch: '',
  charts: {},
  data: {
    overview: [],
    deco: [],
    process: [],
    customers: [],
    stores: [],
    ready: [],
    risk: [],
    activity: [],
    customerAlerts: []
  }
};

const $ = id => document.getElementById(id);

const sb =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
    ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

// Expose Supabase client globally so dispatch.js and other modules
// can reuse the same authenticated session
window._atamSb = sb;

document.addEventListener('DOMContentLoaded', async () => {
  if ($('dateFromInput')) $('dateFromInput').value = state.dateFrom;
  if ($('dateToInput')) $('dateToInput').value = state.dateTo;

  bind();
  bindPageNavigation();
  updateCustomRangeUi();

  if (!sb) {
    status('Missing config');
    toast('Missing Supabase config. Check config.js.');
    return;
  }

  await refresh();
});

function bind() {
  if ($('refreshBtn')) $('refreshBtn').onclick = refresh;

  document.querySelectorAll('.range-btn').forEach(button => {
    button.onclick = () => {
      setDateRange(button.dataset.range);
      refresh();
    };
  });

  if ($('dateFromInput')) {
    $('dateFromInput').onchange = e => {
      state.dateFrom = e.target.value;
      state.range = 'custom';
      updateCustomRangeUi();
      refresh();
    };
  }

  if ($('dateToInput')) {
    $('dateToInput').onchange = e => {
      state.dateTo = e.target.value;
      state.range = 'custom';
      updateCustomRangeUi();
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
      renderProductionActivity();
      renderProductionInsights();
      bindOrderButtons();
    };
  }

  if ($('customerSearchInput')) {
    $('customerSearchInput').oninput = e => {
      state.customerSearch = e.target.value.toLowerCase();
      renderCustomerAlerts();
    };
  }

  if ($('refreshCustomersBtn')) {
    $('refreshCustomersBtn').onclick = async () => {
      try {
        await customerAlerts();
        renderCustomerAlerts();
        toast('Customer data refreshed.');
      } catch (error) {
        console.error(error);
        toast(error.message || 'Customer refresh failed.');
      }
    };
  }

  if ($('triggerReadyShipWorkflow')) {
    $('triggerReadyShipWorkflow').onclick = function() {
      hook('readyShipAlert', {
        action: 'ready_to_ship_alert',
        dateFrom: state.dateFrom,
        dateTo: state.dateTo
      }, this);
    };
  }

  if ($('triggerRiskWorkflow')) {
    $('triggerRiskWorkflow').onclick = function() {
      hook('sendRiskAlert', {
        action: 'risk_alert',
        dateFrom: state.dateFrom,
        dateTo: state.dateTo
      }, this);
    };
  }

  document.querySelectorAll('[data-action]').forEach(button => {
    button.onclick = function() {
      hook(button.dataset.action, {
        action: button.dataset.action,
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        source: 'ATAM GO'
      }, this);
    };
  });

  if ($('closeOrderModal')) {
    $('closeOrderModal').onclick = closeOrderModal;
  }

  if ($('orderModal')) {
    $('orderModal').onclick = e => {
      if (e.target.id === 'orderModal') closeOrderModal();
    };
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeOrderModal();
  });
}

async function refresh() {
  try {
    status('Loading...');

    await overview();
    await deco();
    await process();
    await customers();
    await stores();
    await activity();

    try {
      await customerAlerts();
    } catch (e) {
      console.warn('Customer reorder alerts view failed:', e.message);
      state.data.customerAlerts = [];
    }

    try {
      await ready();
    } catch (e) {
      console.warn('Ready view failed:', e.message);
      state.data.ready = [];
    }

    try {
      await risk();
    } catch (e) {
      console.warn('Risk view failed:', e.message);
      state.data.risk = [];
    }

    storesFilter();
    render();

    status('Connected');
  } catch (error) {
    console.error(error);
    status('Error');
    toast(error.message || 'Load failed');
  }
}

function baseRecordsQuery() {
  let q = sb
    .from('decoration_records')
    .select('*')
    .gte('report_date', state.dateFrom)
    .lte('report_date', state.dateTo);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  return q;
}

async function overview() {
  const { data, error } = await baseRecordsQuery();
  if (error) throw error;

  const rows = data || [];
  const orders = new Set(rows.map(r => r.order_id).filter(Boolean));
  const customers = new Set(
    rows.map(r => r.customer_id || r.customer_name).filter(Boolean)
  );

  state.data.overview = [
    {
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
    }
  ];
}

async function deco() {
  const { data, error } = await baseRecordsQuery();
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
  const { data, error } = await baseRecordsQuery();
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
  const { data, error } = await baseRecordsQuery();
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
  const { data, error } = await baseRecordsQuery();
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

async function ready() {
  let q = sb
    .from('ready_to_ship_orders')
    .select('*')
    .order('date_due', { ascending: true, nullsFirst: false })
    .limit(50);

  if (state.store) q = q.eq('store_name', state.store);

  const { data, error } = await q;
  if (error) throw error;

  state.data.ready = data || [];
}

async function risk() {
  let q = sb
    .from('late_or_at_risk_orders')
    .select('*')
    .order('date_due', { ascending: true, nullsFirst: false })
    .limit(50);

  if (state.store) q = q.eq('store_name', state.store);

  const { data, error } = await q;
  if (error) throw error;

  state.data.risk = data || [];
}

async function activity() {
  let q = sb
    .from('decoration_records')
    .select('*')
    .gte('report_date', state.dateFrom)
    .lte('report_date', state.dateTo)
    .order('counted_at', { ascending: false })
    .limit(500);

  if (state.store) q = q.eq('store_name', state.store);
  if (state.type) q = q.eq('decoration_type', state.type);

  const { data, error } = await q;
  if (error) throw error;

  state.data.activity = data || [];
}

async function customerAlerts() {
  const { data, error } = await sb
    .from('customer_reorder_alerts')
    .select('*')
    .order('priority_score', { ascending: false })
    .order('days_since_last_order', { ascending: false })
    .limit(1000);

  if (error) throw error;

  state.data.customerAlerts = data || [];
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
  renderProductionActivity();
  renderProductionInsights();
  renderCustomerAlerts();
  bindOrderButtons();
}

function renderKpis() {
  const o = state.data.overview[0] || {};

  if ($('totalDecorations')) $('totalDecorations').textContent = num(o.total_decorations);
  if ($('embroideryTotal')) $('embroideryTotal').textContent = num(o.embroidery_total);
  if ($('printTotal')) $('printTotal').textContent = num(o.print_total);
  if ($('uniqueOrders')) $('uniqueOrders').textContent = num(o.unique_orders);
  if ($('uniqueCustomers')) $('uniqueCustomers').textContent = num(o.unique_customers);
  if ($('decorationLines')) $('decorationLines').textContent = num(o.decoration_lines);
}

function chartDeco() {
  upchart(
    'decorationChart',
    'doughnut',
    state.data.deco.map(r => title(r.decoration_type)),
    state.data.deco.map(r => Number(r.total_quantity || 0)),
    true
  );

  upchart(
    'decorationChartProduction',
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

  upchart(
    'processChartProduction',
    'bar',
    state.data.process.map(r => r.process_code),
    state.data.process.map(r => Number(r.total_quantity || 0)),
    false
  );
}

function renderActivity() {
  let rows = state.data.activity;

  if (state.search) rows = filterRowsBySearch(rows);

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

function renderProductionActivity() {
  let rows = state.data.activity;

  if (state.search) rows = filterRowsBySearch(rows);

  table(
    'productionActivityTable',
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

function renderProductionInsights() {
  let rows = state.data.activity || [];

  if (state.search) rows = filterRowsBySearch(rows);

  renderDuePressure(rows);
  renderBiggestJobs(rows);
  chartAreas(rows);
  chartAssignees(rows);
  bindOrderButtons();

  setTimeout(() => { resizeAllCharts(); }, 150);
}

function renderDuePressure(rows) {
  const orders = groupRowsByOrder(rows);

  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + 7);

  let dueToday = 0;
  let dueTomorrow = 0;
  let dueWeek = 0;

  for (const order of Object.values(orders)) {
    if (!order.date_due) continue;

    const due = startOfDay(new Date(order.date_due));

    if (sameDay(due, today)) dueToday++;
    if (sameDay(due, tomorrow)) dueTomorrow++;
    if (due >= today && due <= weekEnd) dueWeek++;
  }

  if ($('dueTodayCount')) $('dueTodayCount').textContent = num(dueToday);
  if ($('dueTomorrowCount')) $('dueTomorrowCount').textContent = num(dueTomorrow);
  if ($('dueWeekCount')) $('dueWeekCount').textContent = num(dueWeek);
}

function renderBiggestJobs(rows) {
  const orders = Object.values(groupRowsByOrder(rows))
    .sort((a, b) => b.total_quantity - a.total_quantity)
    .slice(0, 10);

  const biggest = orders[0];

  if ($('biggestJobQty')) {
    $('biggestJobQty').textContent = biggest ? num(biggest.total_quantity) : '0';
  }

  if ($('biggestJobLabel')) {
    $('biggestJobLabel').textContent = biggest
      ? `#${biggest.order_id} — ${biggest.customer_name || 'Unknown'}`
      : 'No job selected';
  }

  table(
    'biggestJobsTable',
    orders,
    order => `
      <tr>
        <td>${orderButton(order.order_id)}</td>
        <td>${esc(order.customer_name || 'Unknown')}</td>
        <td>${esc(order.store_name || '—')}</td>
        <td>${num(order.total_quantity)}</td>
        <td>${date(order.date_due)}</td>
        <td>${esc(order.assigned_to || '—')}</td>
      </tr>
    `,
    6
  );
}

function chartAreas(rows) {
  const grouped = {};

  for (const row of rows) {
    const key = row.area_name || 'Unknown Area';
    grouped[key] = (grouped[key] || 0) + Number(row.quantity || 0);
  }

  const topAreas = Object.entries(grouped)
    .map(([area, quantity]) => ({ area, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  upchart(
    'areaChart',
    'bar',
    topAreas.map(r => r.area),
    topAreas.map(r => r.quantity),
    false
  );
}

function chartAssignees(rows) {
  const grouped = {};

  for (const row of rows) {
    const key = row.assigned_to || 'Unassigned';
    grouped[key] = (grouped[key] || 0) + Number(row.quantity || 0);
  }

  const assignees = Object.entries(grouped)
    .map(([assignee, quantity]) => ({ assignee, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  upchart(
    'assigneeChart',
    'bar',
    assignees.map(r => r.assignee),
    assignees.map(r => r.quantity),
    false
  );
}

function renderCustomerAlerts() {
  let rows = state.data.customerAlerts || [];

  if (state.customerSearch) {
    rows = rows.filter(row =>
      [
        row.customer_id,
        row.name,
        row.company,
        row.email,
        row.reorder_status,
        row.last_order_id,
        row.last_order_summary
      ]
        .join(' ')
        .toLowerCase()
        .includes(state.customerSearch)
    );
  }

  const allRows = state.data.customerAlerts || [];
  const atRisk = allRows.filter(row => row.reorder_status === 'At Risk');
  const dueSoon = allRows.filter(row => row.reorder_status === 'Due Soon');
  const valueAtRisk = atRisk.reduce((sum, row) => sum + Number(row.last_order_value || 0), 0);

  setText('reorderTotalCustomers', num(allRows.length));
  setText('reorderAtRisk', num(atRisk.length));
  setText('reorderDueSoon', num(dueSoon.length));
  setText('reorderValueAtRisk', money(valueAtRisk));

  table(
    'reorderCustomerTable',
    rows,
    row => `
      <tr>
        <td>
          <strong>${esc(row.name || 'Unknown')}</strong>
          <div class="muted">ID: ${esc(row.customer_id || '—')}</div>
          <div class="muted">${esc(row.email || '')}</div>
        </td>
        <td>${esc(row.company || '—')}</td>
        <td>
          ${date(row.last_order_date)}
          <div class="muted">#${esc(row.last_order_id || '—')}</div>
        </td>
        <td>${row.days_since_last_order ?? '—'}</td>
        <td>
          ${row.mean_reorder_days ? `${num(row.mean_reorder_days)} days` : '—'}
          <div class="muted">
            Threshold: ${row.overdue_threshold_days ? `${num(row.overdue_threshold_days)} days` : '—'}
          </div>
        </td>
        <td>
          <span class="status-pill ${statusClass(row.reorder_status)}">
            ${esc(row.reorder_status || 'Unknown')}
          </span>
          ${
            row.overdue_by_days && Number(row.overdue_by_days) > 0
              ? `<div class="muted">Overdue by ${num(row.overdue_by_days)} days</div>`
              : ''
          }
        </td>
        <td>${money(row.last_order_value || 0)}</td>
        <td>
          <button
            type="button"
            class="customer-action-btn"
            data-ghl-customer-id="${esc(row.customer_id || '')}"
          >
            Push to GHL
          </button>
        </td>
      </tr>
    `,
    8
  );

  bindCustomerActionButtons();
}

function bindCustomerActionButtons() {
  document.querySelectorAll('[data-ghl-customer-id]').forEach(button => {
    button.onclick = function() {
      const customerId = button.dataset.ghlCustomerId;
      const customer = (state.data.customerAlerts || []).find(
        row => String(row.customer_id) === String(customerId)
      );

      if (!customer) {
        toast('Customer not found.');
        return;
      }

      hook('pushToGHL', {
        action: 'pushToGHL',
        customer_id: customer.customer_id,
        name: customer.name,
        company: customer.company,
        email: customer.email,
        reorder_status: customer.reorder_status,
        last_order_date: customer.last_order_date,
        days_since_last_order: customer.days_since_last_order,
        last_order_value: customer.last_order_value,
        source: 'ATAM GO'
      }, this);
    };
  });
}

function statusClass(status = '') {
  const cleaned = String(status).toLowerCase();

  if (cleaned === 'at risk') return 'at-risk';
  if (cleaned === 'due soon') return 'due-soon';
  if (cleaned === 'active') return 'active';
  if (cleaned === 'suppressed') return 'suppressed';

  return '';
}

function upchart(id, type, labels, data, legend) {
  const el = $(id);
  if (!el) return;

  if (state.charts[id]) state.charts[id].destroy();

  const hasData = data.some(value => Number(value || 0) > 0);

  state.charts[id] = new Chart(el, {
    type,
    data: {
      labels: hasData ? labels : ['No data'],
      datasets: [
        {
          label: 'Quantity',
          data: hasData ? data : [0],
          borderWidth: 0,
          borderRadius: 10
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: legend && hasData,
          labels: { color: '#cbd5e1' }
        },
        tooltip: { enabled: hasData }
      },
      scales:
        type === 'doughnut'
          ? {}
          : {
              x: {
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(255,255,255,.06)' }
              },
              y: {
                beginAtZero: true,
                ticks: { color: '#94a3b8' },
                grid: { color: 'rgba(255,255,255,.06)' }
              }
            }
    }
  });
}

function resizeAllCharts() {
  Object.values(state.charts).forEach(chart => {
    if (chart && typeof chart.resize === 'function') {
      chart.resize();
      chart.update();
    }
  });
}

function groupRowsByOrder(rows) {
  const grouped = {};

  for (const row of rows) {
    const key = row.order_id || 'UNKNOWN';

    if (!grouped[key]) {
      grouped[key] = {
        order_id: row.order_id,
        customer_name: row.customer_name,
        store_name: row.store_name,
        date_due: row.date_due,
        assigned_to: row.assigned_to,
        total_quantity: 0
      };
    }

    grouped[key].total_quantity += Number(row.quantity || 0);

    if (!grouped[key].date_due && row.date_due) grouped[key].date_due = row.date_due;
    if (!grouped[key].assigned_to && row.assigned_to) grouped[key].assigned_to = row.assigned_to;
  }

  return grouped;
}

function filterRowsBySearch(rows) {
  return rows.filter(r =>
    [
      r.order_id,
      r.customer_name,
      r.store_name,
      r.product_name,
      r.decoration_type,
      r.process_code,
      r.area_name,
      r.view_name,
      r.assigned_to,
      r.shipping_method
    ]
      .join(' ')
      .toLowerCase()
      .includes(state.search)
  );
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

  const totalQty = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const embroideryQty = rows
    .filter(row => row.decoration_type === 'embroidery')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const printQty = rows
    .filter(row => row.decoration_type === 'print')
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);

  if ($('modalOrderTitle')) $('modalOrderTitle').textContent = `Order #${orderId}`;

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

  if ($('orderModal')) $('orderModal').classList.add('show');
}

function closeOrderModal() {
  if ($('orderModal')) $('orderModal').classList.remove('show');
}

function bindPageNavigation() {
  const navButtons = document.querySelectorAll('.nav-link');
  const pages = document.querySelectorAll('.dashboard-page');

  navButtons.forEach(button => {
    button.onclick = () => {
      const targetPage = button.dataset.page;

      navButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      pages.forEach(page => page.classList.remove('active'));

      const pageToShow = document.getElementById(targetPage);

      if (pageToShow) {
        pageToShow.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });

        setTimeout(() => {
          resizeAllCharts();
          renderProductionInsights();
          renderCustomerAlerts();
        }, 150);
      }
    };
  });
}

function setDateRange(range) {
  const today = new Date();
  const start = new Date(today);

  state.range = range;

  if (range === 'today') {
    state.dateFrom = formatDate(today);
    state.dateTo = formatDate(today);
  }

  if (range === 'yesterday') {
    start.setDate(today.getDate() - 1);
    state.dateFrom = formatDate(start);
    state.dateTo = formatDate(start);
  }

  if (range === 'last7') {
    start.setDate(today.getDate() - 6);
    state.dateFrom = formatDate(start);
    state.dateTo = formatDate(today);
  }

  if (range === 'month') {
    start.setDate(1);
    state.dateFrom = formatDate(start);
    state.dateTo = formatDate(today);
  }

  if (range === 'custom') {
    if (!state.dateFrom) state.dateFrom = formatDate(today);
    if (!state.dateTo) state.dateTo = formatDate(today);
  }

  if ($('dateFromInput')) $('dateFromInput').value = state.dateFrom;
  if ($('dateToInput')) $('dateToInput').value = state.dateTo;

  updateCustomRangeUi();
}

function updateCustomRangeUi() {
  const customBox = $('customDateRange');

  if (customBox) {
    if (state.range === 'custom') {
      customBox.classList.add('show');
    } else {
      customBox.classList.remove('show');
    }
  }

  document.querySelectorAll('.range-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.range === state.range);
  });
}

function formatDate(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function startOfDay(dateObj) {
  const d = new Date(dateObj);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/* ─────────────────────────────────────────────
   HOOK — Webhook trigger with button loading states
   ───────────────────────────────────────────── */
async function hook(key, payload, buttonEl) {
  const url = cfg.WEBHOOKS?.[key];

  if (!url) {
    toast(`No webhook configured for "${key}" yet.`);
    return;
  }

  // ── Save original button content and set loading state ──
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.dataset.originalText = buttonEl.textContent.trim();
    buttonEl.innerHTML = `
      <span class="btn-label">Sending…</span>
      <span class="btn-progress-track">
        <span class="btn-progress-bar"></span>
      </span>
    `;
    buttonEl.classList.add('btn-loading');
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, source: 'ATAM GO' })
    });

    if (!res.ok) throw new Error(`Webhook failed: ${res.status}`);

    // ── Success ──
    if (buttonEl) {
      buttonEl.classList.remove('btn-loading');
      buttonEl.classList.add('btn-success');
      buttonEl.innerHTML = `<span class="btn-label">✓ Done</span>`;

      setTimeout(() => {
        buttonEl.classList.remove('btn-success');
        buttonEl.disabled = false;
        buttonEl.textContent = buttonEl.dataset.originalText || 'Trigger';
      }, 2500);
    }

    toast('Workflow triggered successfully.');

  } catch (e) {
    // ── Error ──
    if (buttonEl) {
      buttonEl.classList.remove('btn-loading');
      buttonEl.classList.add('btn-error');
      buttonEl.innerHTML = `<span class="btn-label">✗ Failed</span>`;

      setTimeout(() => {
        buttonEl.classList.remove('btn-error');
        buttonEl.disabled = false;
        buttonEl.textContent = buttonEl.dataset.originalText || 'Trigger';
      }, 2500);
    }

    toast(e.message || 'Workflow failed.');
  }
}

function status(text) {
  if ($('connectionStatus')) $('connectionStatus').textContent = text;
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

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function num(value) {
  return new Intl.NumberFormat('en-GB').format(Number(value || 0));
}

function money(value) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0
  }).format(Number(value || 0));
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
