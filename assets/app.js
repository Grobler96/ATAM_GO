/* ═══════════════════════════════════════════════
   ATAM GO — Core App Logic
   ═══════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────
let runsToday = 0;
let lastRunTime = null;
let tableData = [];
let runHistory = [];
let sortCol = null;
let sortDir = 1;
let webhookUrl = 'https://atamcpi.app.n8n.cloud/webhook/68aa00d4-9b77-42c2-9b0f-6afa8bcadf77';

// ── Page navigation ──────────────────────────────
const PAGE_TITLES = {
  home: 'Dashboard', workflows: 'Workflows', data: 'Data Viewer',
  analytics: 'Analytics', insights: 'Insights', settings: 'Settings'
};

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });

  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;

  // Populate insights when navigated to
  if (page === 'insights' && tableData.length) renderInsights(tableData);

  // Close mobile sidebar
  closeSidebar();
}

// ── Mobile sidebar ───────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ── Workflow runner ──────────────────────────────
const STEPS = [
  { label: 'Connecting to n8n…' },
  { label: 'Reaching Airtable…' },
  { label: 'Fetching customer records…' },
  { label: 'Running reorder logic…' },
  { label: 'Compiling results…' },
  { label: 'Finalising report…' },
];

function renderSteps(containerId, currentStep) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = STEPS.map((s, i) => {
    const state = i < currentStep ? 'done' : i === currentStep ? 'active' : '';
    const icon  = i < currentStep ? 'check-circle' : i === currentStep ? 'loader' : 'circle';
    return `<div class="progress-step ${state}"><i data-lucide="${icon}" width="14" height="14" class="step-icon ${i === currentStep ? 'spinning' : ''}"></i>${s.label}</div>`;
  }).join('');
  lucide.createIcons();
}

async function runWorkflow(prefix) {
  const isHome = prefix === 'home';
  const card       = document.getElementById(isHome ? 'wf-home-card' : 'wf-card');
  const btn        = document.getElementById('btn-' + prefix + '-launch');
  const badge      = document.getElementById(isHome ? 'wf-home-badge' : 'wf-badge');
  const progress   = document.getElementById('progress-' + prefix);
  const pfill      = document.getElementById('pfill-' + prefix);
  const pstepsId   = 'psteps-' + prefix;
  const successArea = document.getElementById('success-' + prefix);

  // Reset
  successArea.classList.remove('visible');
  progress.classList.add('visible');
  btn.disabled = true;
  card.classList.add('running');
  badge.textContent = 'RUNNING';
  badge.className = 'workflow-status-badge badge-running';
  pfill.style.background = '';
  pfill.style.width = '0%';

  const startTime = Date.now();
  let step = 0;
  renderSteps(pstepsId, step);

  const stepInterval = setInterval(() => {
    if (step < STEPS.length - 1) {
      step++;
      pfill.style.width = ((step / STEPS.length) * 85) + '%';
      renderSteps(pstepsId, step);
    }
  }, 800);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'reorder_check', source: 'ATAM GO Control Centre', timestamp: new Date().toISOString() })
    });

    clearInterval(stepInterval);
    pfill.style.width = '100%';
    renderSteps(pstepsId, STEPS.length);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) data = await res.json();

    runsToday++;
    lastRunTime = new Date();

    if (data) {
      const records = Array.isArray(data) ? data : (data.records || data.data || data.items || [data]);
      tableData = records;
      document.getElementById('kpi-records').textContent = records.length;
    }

    document.getElementById('kpi-runs').textContent = runsToday;
    document.getElementById('kpi-last').textContent  = lastRunTime.toLocaleTimeString();
    document.getElementById('last-updated').textContent = 'Updated ' + lastRunTime.toLocaleTimeString();

    runHistory.push({ time: lastRunTime, elapsed: parseFloat(elapsed), success: true });
    if (typeof updateAnalytics === 'function') updateAnalytics();

    setTimeout(() => {
      card.classList.remove('running');
      badge.textContent = 'DONE';
      badge.className = 'workflow-status-badge badge-done';
      successArea.classList.add('visible');
      lucide.createIcons();
      if (data) renderTable(tableData);
      if (tableData.length && typeof renderInsights === 'function') {
        renderInsights(tableData);
      }
      showToast('Reorder Check completed in ' + elapsed + 's', 'success');
    }, 400);

  } catch (err) {
    clearInterval(stepInterval);
    card.classList.remove('running');
    badge.textContent = 'ERROR';
    badge.className = 'workflow-status-badge badge-error';
    pfill.style.width = '100%';
    pfill.style.background = 'var(--color-error)';
    runHistory.push({ time: new Date(), elapsed: null, success: false });
    if (typeof updateAnalytics === 'function') updateAnalytics();
    showToast('Workflow failed: ' + (err.message || 'Network error'), 'error');
  }

  btn.disabled = false;
  lucide.createIcons();
}

// ── Data table ───────────────────────────────────
function renderTable(data) {
  const container = document.getElementById('table-container');
  if (!data || data.length === 0) {
    container.innerHTML = `<div class="empty-table"><div class="empty-table-icon"><i data-lucide="inbox" width="40" height="40"></i></div><h3>No records returned</h3><p>The workflow ran but returned no data.</p></div>`;
    lucide.createIcons();
    return;
  }
  const rows = data.map(r => r.fields ? { id: r.id, ...r.fields } : r);
  const PRIORITY_COLS = ['Name', 'Company', 'Priority', 'Is overdue', 'Days since last order', 'Overdue by days', 'Total orders', 'Mean reorder days', 'Last order date', 'Last order value'];
  const allCols = Object.keys(rows[0]);
  const cols = [...PRIORITY_COLS.filter(c => allCols.includes(c)), ...allCols.filter(c => !PRIORITY_COLS.includes(c))];

  document.getElementById('record-count').textContent = rows.length + ' records';

  const thead = `<thead><tr>${cols.map(c => `<th onclick="sortTable('${c}')">${c} <i data-lucide="chevrons-up-down" width="10" height="10"></i></th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map(row => `<tr>${cols.map(c => {
    const v = row[c] ?? '—';
    const str = String(v);
    if (c === 'Priority' || c === 'Is overdue') {
      const cls = str === 'High' ? 'high' : str === 'Medium' ? 'medium' : str === 'Yes' ? 'high' : str === 'No' ? 'not-overdue' : 'ok';
      return `<td><span class="td-badge ${cls}">${str}</span></td>`;
    }
    if (str.toLowerCase() === 'low')  return `<td><span class="td-badge low">Low</span></td>`;
    if (str.toLowerCase() === 'ok' || str.toLowerCase() === 'good') return `<td><span class="td-badge ok">${v}</span></td>`;
    return `<td>${str.length > 60 ? str.slice(0, 60) + '…' : str}</td>`;
  }).join('')}</tr>`).join('')}</tbody>`;

  container.innerHTML = `<div style="overflow-x:auto"><table>${thead}${tbody}</table></div>`;
  lucide.createIcons();
}

function filterTable(q) {
  if (!tableData.length) return;
  renderTable(q ? tableData.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) : tableData);
}

function sortTable(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  tableData.sort((a, b) => {
    const av = (a.fields?.[col] ?? a[col] ?? '');
    const bv = (b.fields?.[col] ?? b[col] ?? '');
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sortDir;
  });
  renderTable(tableData);
}

function exportCSV() {
  if (!tableData.length) { showToast('No data to export', 'info'); return; }
  const rows = tableData.map(r => r.fields ? r.fields : r);
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'reorder-check-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

// ── Toasts ───────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: 'check-circle', error: 'alert-circle', info: 'info' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i data-lucide="${icons[type]}" width="16" height="16" style="color:var(--color-${type === 'info' ? 'primary' : type});flex-shrink:0"></i> ${msg}`;
  document.getElementById('toast-container').appendChild(t);
  lucide.createIcons();
  setTimeout(() => t.remove(), 4000);
}

// ── Settings ─────────────────────────────────────
function saveSettings() {
  const val = document.getElementById('setting-webhook').value.trim();
  if (val) webhookUrl = val;
  showToast('Settings saved', 'success');
}

// ── Theme toggle ─────────────────────────────────
function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const root = document.documentElement;
  let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);

  function updateIcon() {
    btn.innerHTML = theme === 'dark'
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
  updateIcon();
  btn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    updateIcon();
    setTimeout(() => { if (typeof updateChartColors === 'function') updateChartColors(); }, 50);
  });
}

// ── Boot ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initTheme();

  // Nav clicks via data-page
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  // Workflow launch buttons
  document.querySelectorAll('.btn-launch[data-runner]').forEach(btn => {
    btn.addEventListener('click', () => runWorkflow(btn.dataset.runner));
  });

  // View data / goto buttons
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.goto));
  });

  // Table search
  const searchEl = document.getElementById('table-search');
  if (searchEl) searchEl.addEventListener('input', e => filterTable(e.target.value));

  // Export CSV
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) exportBtn.addEventListener('click', exportCSV);

  // Save settings
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) saveBtn.addEventListener('click', saveSettings);

  // Mobile menu
  document.getElementById('mobile-menu-btn').addEventListener('click', openSidebar);
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

  // Insights filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (tableData.length && typeof renderInsights === 'function') {
        renderInsights(tableData, chip.dataset.filter);
      }
    });
  });

  // Init analytics charts (empty state)
  if (typeof initCharts === 'function') initCharts();

  document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
});
