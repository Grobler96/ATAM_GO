/* ═══════════════════════════════════════════════
   ATAM GO — Analytics Charts (Runs + Response Time)
   ═══════════════════════════════════════════════ */

'use strict';

let chartRuns, chartTime;

function getChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid:    isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    text:    isDark ? '#8890a4' : '#6b7280',
    primary: isDark ? '#00d4ff' : '#0080a0',
    success: isDark ? '#00e5a0' : '#059669',
    warning: isDark ? '#ffb547' : '#d97706',
    error:   isDark ? '#ff4d6a' : '#dc2626',
  };
}

function baseChartOptions(c) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } } },
      y: { grid: { color: c.grid }, ticks: { color: c.text, font: { size: 11 } }, beginAtZero: true }
    }
  };
}

function initCharts() {
  const c = getChartColors();
  chartRuns = new Chart(document.getElementById('chart-runs'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: c.primary + '66', borderColor: c.primary, borderWidth: 2, borderRadius: 4 }] },
    options: baseChartOptions(c)
  });
  chartTime = new Chart(document.getElementById('chart-time'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: c.success, backgroundColor: c.success + '22', tension: 0.4, fill: true, pointRadius: 4, pointBackgroundColor: c.success }] },
    options: baseChartOptions(c)
  });
}

function updateChartColors() {
  if (!chartRuns) return;
  const c = getChartColors();
  [chartRuns, chartTime].forEach(ch => {
    ch.options.scales.x.grid.color  = c.grid;
    ch.options.scales.x.ticks.color = c.text;
    ch.options.scales.y.grid.color  = c.grid;
    ch.options.scales.y.ticks.color = c.text;
    ch.update();
  });
  if (typeof updateInsightChartColors === 'function') updateInsightChartColors();
}

function updateAnalytics() {
  if (!chartRuns) initCharts();
  document.getElementById('a-total').textContent = runHistory.length;
  const avgs = runHistory.filter(r => r.elapsed).map(r => r.elapsed);
  document.getElementById('a-avg').textContent = avgs.length
    ? (avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1) + 's' : '—';

  const byDate = {};
  runHistory.forEach(r => { const d = r.time.toLocaleDateString(); byDate[d] = (byDate[d] || 0) + 1; });
  chartRuns.data.labels = Object.keys(byDate);
  chartRuns.data.datasets[0].data = Object.values(byDate);
  chartRuns.update();

  chartTime.data.labels = runHistory.filter(r => r.elapsed).map((_, i) => 'Run ' + (i + 1));
  chartTime.data.datasets[0].data = runHistory.filter(r => r.elapsed).map(r => r.elapsed);
  chartTime.update();
}
