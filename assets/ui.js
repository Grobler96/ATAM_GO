/* ═══════════════════════════════════════════════
   ATAM GO — UI Utilities & Boot
   Toasts, settings save, and the DOMContentLoaded
   wiring that connects everything together.
   ═══════════════════════════════════════════════ */

'use strict';

// ── Toasts ───────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: 'check-circle', error: 'alert-circle', info: 'info' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i data-lucide="${icons[type]}" width="16" height="16"
    style="color:var(--color-${type === 'info' ? 'primary' : type});flex-shrink:0"></i> ${msg}`;
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

// ── Boot ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initTheme();

  // Nav
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  // Workflow launch buttons
  document.querySelectorAll('.btn-launch[data-runner]').forEach(btn => {
    btn.addEventListener('click', () => runWorkflow(btn.dataset.runner));
  });

  // "View Data" / goto buttons
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
