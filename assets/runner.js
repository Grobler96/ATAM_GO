/* ═══════════════════════════════════════════════
   ATAM GO — Workflow Runner
   Handles launching a workflow, the animated
   progress steps, and processing the response.
   ═══════════════════════════════════════════════ */

'use strict';

// ── Shared state (read by table.js, analytics, insights) ──
let runsToday  = 0;
let lastRunTime = null;
let tableData  = [];
let runHistory = [];

// ── Progress step renderer ───────────────────────
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

// ── Main workflow runner ─────────────────────────
async function runWorkflow(prefix) {
  const isHome      = prefix === 'home';
  const card        = document.getElementById(isHome ? 'wf-home-card' : 'wf-card');
  const btn         = document.getElementById('btn-' + prefix + '-launch');
  const badge       = document.getElementById(isHome ? 'wf-home-badge' : 'wf-badge');
  const progress    = document.getElementById('progress-' + prefix);
  const pfill       = document.getElementById('pfill-' + prefix);
  const pstepsId    = 'psteps-' + prefix;
  const successArea = document.getElementById('success-' + prefix);

  // Reset UI
  successArea.classList.remove('visible');
  progress.classList.add('visible');
  btn.disabled = true;
  card.classList.add('running');
  badge.textContent = 'RUNNING';
  badge.className   = 'workflow-status-badge badge-running';
  pfill.style.background = '';
  pfill.style.width = '0%';

  const startTime = Date.now();
  let step = 0;
  renderSteps(pstepsId, step);

  // Advance steps every 800ms while waiting
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
      body: JSON.stringify({
        trigger:   'reorder_check',
        source:    'ATAM GO Control Centre',
        timestamp: new Date().toISOString()
      })
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

    document.getElementById('kpi-runs').textContent  = runsToday;
    document.getElementById('kpi-last').textContent  = lastRunTime.toLocaleTimeString();
    document.getElementById('last-updated').textContent = 'Updated ' + lastRunTime.toLocaleTimeString();

    runHistory.push({ time: lastRunTime, elapsed: parseFloat(elapsed), success: true });
    if (typeof updateAnalytics === 'function') updateAnalytics();

    setTimeout(() => {
      card.classList.remove('running');
      badge.textContent = 'DONE';
      badge.className   = 'workflow-status-badge badge-done';
      successArea.classList.add('visible');
      lucide.createIcons();
      if (data) renderTable(tableData);
      if (tableData.length && typeof renderInsights === 'function') renderInsights(tableData);
      showToast('Reorder Check completed in ' + elapsed + 's', 'success');
    }, 400);

  } catch (err) {
    clearInterval(stepInterval);
    card.classList.remove('running');
    badge.textContent = 'ERROR';
    badge.className   = 'workflow-status-badge badge-error';
    pfill.style.width = '100%';
    pfill.style.background = 'var(--color-error)';
    runHistory.push({ time: new Date(), elapsed: null, success: false });
    if (typeof updateAnalytics === 'function') updateAnalytics();
    showToast('Workflow failed: ' + (err.message || 'Network error'), 'error');
  }

  btn.disabled = false;
  lucide.createIcons();
}
