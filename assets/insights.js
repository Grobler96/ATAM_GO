/* ═══════════════════════════════════════════════
   ATAM GO — Insights Page (Part 3)
   Customer behaviour analysis, reorder risk,
   interval distributions, priority breakdown
   ═══════════════════════════════════════════════ */

'use strict';

// Chart instances — destroyed & rebuilt on each render
let insCharts = {};

// ── Helpers ──────────────────────────────────────
function getField(record, key) {
  return record?.fields?.[key] ?? record?.[key] ?? null;
}

function applyFilter(records, filter) {
  switch (filter) {
    case 'eligible': return records.filter(r => getField(r, 'Eligible for frequency check') === 'Yes');
    case 'overdue':  return records.filter(r => getField(r, 'Is overdue') === 'Yes');
    case 'high':     return records.filter(r => getField(r, 'Priority') === 'High');
    default:         return records;
  }
}

function destroyInsCharts() {
  Object.values(insCharts).forEach(ch => { try { ch.destroy(); } catch(e) {} });
  insCharts = {};
}

function insChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid:    isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    text:    isDark ? '#8890a4' : '#6b7280',
    primary: isDark ? '#00d4ff' : '#0080a0',
    success: isDark ? '#00e5a0' : '#059669',
    warning: isDark ? '#ffb547' : '#d97706',
    error:   isDark ? '#ff4d6a' : '#dc2626',
    purple:  isDark ? '#a78bfa' : '#7c3aed',
  };
}

function baseOpts(c, extras) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: {} } },
    scales: {
      x: { grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } } },
      y: { grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } }, beginAtZero: true }
    }
  }, extras || {});
}

// ── KPI section ──────────────────────────────────
function renderInsightKPIs(records) {
  const eligible = records.filter(r => getField(r, 'Eligible for frequency check') === 'Yes');
  const overdue  = records.filter(r => getField(r, 'Is overdue') === 'Yes');
  const high     = records.filter(r => getField(r, 'Priority') === 'High');

  const avgCycle = eligible.length
    ? Math.round(eligible.reduce((s, r) => s + (Number(getField(r, 'Mean reorder days')) || 0), 0) / eligible.length)
    : null;

  // Top customer by order count
  const sorted = [...records].sort((a, b) => (Number(getField(b, 'Total orders')) || 0) - (Number(getField(a, 'Total orders')) || 0));
  const top = sorted[0] ? (getField(sorted[0], 'Name') || '—') : '—';

  document.getElementById('ins-avg-cycle').textContent = avgCycle !== null ? avgCycle + 'd' : '—';
  document.getElementById('ins-overdue').textContent   = overdue.length;
  document.getElementById('ins-high').textContent      = high.length;
  document.getElementById('ins-top').textContent       = top;
  document.getElementById('insights-count').textContent = records.length + ' customers';
}

// ── Chart 1: Priority doughnut ───────────────────
function renderPriorityChart(records) {
  const c = insChartColors();
  const counts = { High: 0, Medium: 0, 'Not overdue': 0 };
  records.forEach(r => {
    const p = getField(r, 'Priority') || 'Not overdue';
    if (p in counts) counts[p]++; else counts['Not overdue']++;
  });
  const ctx = document.getElementById('chart-priority');
  insCharts.priority = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: [c.error + 'cc', c.warning + 'cc', c.success + 'cc'],
        borderColor: [c.error, c.warning, c.success],
        borderWidth: 2,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: c.text, font: { size: 11 }, padding: 12, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} customers` } }
      }
    }
  });
}

// ── Chart 2: Reorder interval histogram ─────────
function renderIntervalChart(records) {
  const c = insChartColors();
  const eligible = records.filter(r => getField(r, 'Eligible for frequency check') === 'Yes');
  const buckets  = { '1–14d': 0, '15–30d': 0, '31–60d': 0, '61–90d': 0, '91–180d': 0, '180d+': 0 };
  eligible.forEach(r => {
    const d = Number(getField(r, 'Mean reorder days')) || 0;
    if      (d <= 14)  buckets['1–14d']++;
    else if (d <= 30)  buckets['15–30d']++;
    else if (d <= 60)  buckets['31–60d']++;
    else if (d <= 90)  buckets['61–90d']++;
    else if (d <= 180) buckets['91–180d']++;
    else               buckets['180d+']++;
  });
  const ctx = document.getElementById('chart-interval');
  insCharts.interval = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(buckets),
      datasets: [{ data: Object.values(buckets), backgroundColor: c.primary + '88', borderColor: c.primary, borderWidth: 2, borderRadius: 6 }]
    },
    options: {
      ...baseOpts(c),
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} customers` } } }
    }
  });
}

// ── Chart 3: Recency distribution ───────────────
function renderRecencyChart(records) {
  const c = insChartColors();
  const buckets = { '0–7d': 0, '8–30d': 0, '31–90d': 0, '91–180d': 0, '181–365d': 0, '365d+': 0 };
  records.forEach(r => {
    const d = Number(getField(r, 'Days since last order')) || 0;
    if      (d <= 7)   buckets['0–7d']++;
    else if (d <= 30)  buckets['8–30d']++;
    else if (d <= 90)  buckets['31–90d']++;
    else if (d <= 180) buckets['91–180d']++;
    else if (d <= 365) buckets['181–365d']++;
    else               buckets['365d+']++;
  });
  const ctx = document.getElementById('chart-recency');
  insCharts.recency = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(buckets),
      datasets: [{ data: Object.values(buckets), backgroundColor: c.purple + '88', borderColor: c.purple, borderWidth: 2, borderRadius: 6 }]
    },
    options: {
      ...baseOpts(c),
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} customers` } } }
    }
  });
}

// ── Chart 4: Reorder risk scatter/bubble ────────
function renderRiskChart(records) {
  const c = insChartColors();
  const eligible = records.filter(r => getField(r, 'Eligible for frequency check') === 'Yes');

  const datasets = [
    { label: 'High',       color: c.error,   data: [] },
    { label: 'Medium',     color: c.warning, data: [] },
    { label: 'Not overdue',color: c.success, data: [] },
  ];

  eligible.forEach(r => {
    const overdueDays  = Number(getField(r, 'Overdue by days'))   || 0;
    const orderValue   = Number(getField(r, 'Last order value'))  || 0;
    const totalOrders  = Number(getField(r, 'Total orders'))      || 1;
    const priority     = getField(r, 'Priority') || 'Not overdue';
    const name         = getField(r, 'Name') || '?';
    const point = { x: overdueDays, y: orderValue, r: Math.max(4, Math.min(totalOrders * 2, 22)), name };
    const ds = datasets.find(d => d.label === priority) || datasets[2];
    ds.data.push(point);
  });

  const ctx = document.getElementById('chart-risk');
  insCharts.risk = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: datasets.map(ds => ({
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.color + '55',
        borderColor: ds.color,
        borderWidth: 2
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: insChartColors().text, font: { size: 11 }, padding: 12, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => `${ctx.raw.name} — ${ctx.raw.x}d overdue, £${ctx.raw.y.toFixed(0)} last order` } }
      },
      scales: {
        x: { title: { display: true, text: 'Days overdue', color: c.text, font: { size: 11 } }, grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } } },
        y: { title: { display: true, text: 'Last order value (£)', color: c.text, font: { size: 11 } }, grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } }, beginAtZero: true }
      }
    }
  });
}

// ── Chart 5: Top customers bar ───────────────────
function renderTopChart(records) {
  const c = insChartColors();
  const sorted = [...records]
    .filter(r => (Number(getField(r, 'Total orders')) || 0) > 1)
    .sort((a, b) => (Number(getField(b, 'Total orders')) || 0) - (Number(getField(a, 'Total orders')) || 0))
    .slice(0, 10);

  const labels = sorted.map(r => getField(r, 'Name') || '?');
  const values = sorted.map(r => Number(getField(r, 'Total orders')) || 0);
  const colors = sorted.map(r => {
    const p = getField(r, 'Priority');
    return p === 'High' ? c.error + '99' : p === 'Medium' ? c.warning + '99' : c.success + '99';
  });
  const borders = sorted.map(r => {
    const p = getField(r, 'Priority');
    return p === 'High' ? c.error : p === 'Medium' ? c.warning : c.success;
  });

  const ctx = document.getElementById('chart-top');
  insCharts.top = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderColor: borders, borderWidth: 2, borderRadius: 6 }]
    },
    options: {
      ...baseOpts(c),
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} orders` } } },
      scales: {
        x: { grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } } },
        y: { grid: { color: 'transparent' }, ticks: { color: c.text, font: { size: 11 } } }
      }
    }
  });
}

// ── Risk register table ──────────────────────────
function renderRiskTable(records) {
  const container = document.getElementById('risk-table-container');
  const atRisk = records
    .filter(r => getField(r, 'Is overdue') === 'Yes' || getField(r, 'Eligible for frequency check') === 'Yes')
    .sort((a, b) => (Number(getField(b, 'Overdue by days')) || 0) - (Number(getField(a, 'Overdue by days')) || 0));

  document.getElementById('risk-count').textContent = atRisk.length + ' customers tracked';

  if (!atRisk.length) {
    container.innerHTML = '<div class="empty-table"><div class="empty-table-icon"><i data-lucide="check-circle" width="40" height="40"></i></div><h3>All clear</h3><p>No customers are at reorder risk.</p></div>';
    lucide.createIcons();
    return;
  }

  const cols = ['Name', 'Company', 'Priority', 'Overdue by days', 'Days since last order', 'Mean reorder days', 'Total orders', 'Last order value', 'Notify now'];
  const rows = atRisk.map(r => {
    const f = r.fields || r;
    return cols.map(c => {
      const v = f[c] ?? '—';
      const str = String(v);
      if (c === 'Priority') {
        const cls = str === 'High' ? 'high' : str === 'Medium' ? 'medium' : 'not-overdue';
        return `<td><span class="td-badge ${cls}">${str}</span></td>`;
      }
      if (c === 'Notify now') {
        const cls = str === 'Yes' ? 'high' : 'ok';
        return `<td><span class="td-badge ${cls}">${str}</span></td>`;
      }
      if (c === 'Last order value' && str !== '—') return `<td>£${Number(v).toFixed(2)}</td>`;
      return `<td>${str}</td>`;
    }).join('');
  });

  container.innerHTML = `<div style="overflow-x:auto"><table>
    <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r}</tr>`).join('')}</tbody>
  </table></div>`;
  lucide.createIcons();
}

// ── Main render ──────────────────────────────────
function renderInsights(records, filter) {
  const activeFilter = filter || document.querySelector('.filter-chip.active')?.dataset?.filter || 'all';
  const filtered = applyFilter(records, activeFilter);

  destroyInsCharts();
  renderInsightKPIs(filtered);
  renderPriorityChart(filtered);
  renderIntervalChart(filtered);
  renderRecencyChart(filtered);
  renderRiskChart(filtered);
  renderTopChart(filtered);
  renderRiskTable(filtered);
}

// Called by charts.js updateChartColors
function updateInsightChartColors() {
  // Re-render with current data if available
  if (typeof tableData !== 'undefined' && tableData.length) {
    renderInsights(tableData);
  }
}
