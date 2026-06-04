/* ═══════════════════════════════════════════════
   ATAM GO — Data Table
   Renders, filters, sorts, and exports the
   results table in the Data Viewer page.
   ═══════════════════════════════════════════════ */

'use strict';

// ── Sort state ───────────────────────────────────
let sortCol = null;
let sortDir = 1;

// ── Priority column order ────────────────────────
// Columns listed here appear first in the table.
// Add or reorder as needed.
const PRIORITY_COLS = [
  'Name', 'Company', 'Priority', 'Is overdue',
  'Days since last order', 'Overdue by days',
  'Total orders', 'Mean reorder days',
  'Last order date', 'Last order value'
];

// ── Render table ─────────────────────────────────
function renderTable(data) {
  const container = document.getElementById('table-container');
  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="empty-table">
        <div class="empty-table-icon"><i data-lucide="inbox" width="40" height="40"></i></div>
        <h3>No records returned</h3>
        <p>The workflow ran but returned no data.</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  const rows    = data.map(r => r.fields ? { id: r.id, ...r.fields } : r);
  const allCols = Object.keys(rows[0]);
  const cols    = [
    ...PRIORITY_COLS.filter(c => allCols.includes(c)),
    ...allCols.filter(c => !PRIORITY_COLS.includes(c))
  ];

  document.getElementById('record-count').textContent = rows.length + ' records';

  const thead = `<thead><tr>${cols.map(c =>
    `<th onclick="sortTable('${c}')">${c} <i data-lucide="chevrons-up-down" width="10" height="10"></i></th>`
  ).join('')}</tr></thead>`;

  const tbody = `<tbody>${rows.map(row =>
    `<tr>${cols.map(c => {
      const v   = row[c] ?? '—';
      const str = String(v);
      if (c === 'Priority' || c === 'Is overdue') {
        const cls = str === 'High' ? 'high' : str === 'Medium' ? 'medium'
                  : str === 'Yes' ? 'high'  : str === 'No'     ? 'not-overdue' : 'ok';
        return `<td><span class="td-badge ${cls}">${str}</span></td>`;
      }
      if (str.toLowerCase() === 'low') return `<td><span class="td-badge low">Low</span></td>`;
      if (str.toLowerCase() === 'ok' || str.toLowerCase() === 'good')
        return `<td><span class="td-badge ok">${v}</span></td>`;
      return `<td>${str.length > 60 ? str.slice(0, 60) + '…' : str}</td>`;
    }).join('')}</tr>`
  ).join('')}</tbody>`;

  container.innerHTML = `<div style="overflow-x:auto"><table>${thead}${tbody}</table></div>`;
  lucide.createIcons();
}

// ── Filter ───────────────────────────────────────
function filterTable(q) {
  if (!tableData.length) return;
  renderTable(q
    ? tableData.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))
    : tableData
  );
}

// ── Sort ─────────────────────────────────────────
function sortTable(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  tableData.sort((a, b) => {
    const av = a.fields?.[col] ?? a[col] ?? '';
    const bv = b.fields?.[col] ?? b[col] ?? '';
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sortDir;
  });
  renderTable(tableData);
}

// ── Export CSV ───────────────────────────────────
function exportCSV() {
  if (!tableData.length) { showToast('No data to export', 'info'); return; }
  const rows = tableData.map(r => r.fields ? r.fields : r);
  const cols = Object.keys(rows[0]);
  const csv  = [
    cols.join(','),
    ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'reorder-check-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}
