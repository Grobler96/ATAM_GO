(function () {
  'use strict';

  const state = {
    rows: [],
    filter: 'all'
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindSalesInvoices();
    loadSalesInvoices();
  });

  function bindSalesInvoices() {
    const filterEl = document.getElementById('siFilter');
    if (filterEl) {
      filterEl.onchange = e => {
        state.filter = e.target.value;
        renderList();
      };
    }

    const refreshBtn = document.getElementById('siRefreshBtn');
    if (refreshBtn) refreshBtn.onclick = loadSalesInvoices;
  }

  async function loadSalesInvoices() {
    if (!window._atamSb) return;

    try {
      const { data, error } = await window._atamSb
        .from('sales_invoice_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

      if (error) throw error;

      state.rows = data || [];
      renderSummary();
      renderList();
    } catch (err) {
      console.error('Sales invoice log load failed:', err);
      if (typeof toast === 'function') toast(err.message || 'Could not load sales invoices.');
    }
  }

  function isToday(iso) {
    if (!iso) return false;
    const d = new Date(iso);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }

  function startOfWeek() {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  const ATTENTION_STATUSES = ['skipped_no_contact', 'skipped_error', 'duplicate_skipped'];

  function renderSummary() {
    const rows = state.rows;
    const weekStart = startOfWeek();

    const postedToday = rows.filter(r => r.status === 'posted' && isToday(r.created_at));
    const postedThisWeek = rows.filter(
      r => r.status === 'posted' && r.created_at && new Date(r.created_at) >= weekStart
    );
    const needsAttention = rows.filter(r => ATTENTION_STATUSES.includes(r.status));
    const valueThisWeek = postedThisWeek.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

    setSiText('siPostedToday', num(postedToday.length));
    setSiText('siNeedsAttention', num(needsAttention.length));
    setSiText('siPostedWeek', num(postedThisWeek.length));
    setSiText('siValueWeek', money(valueThisWeek));
  }

  function setSiText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  const STATUS_META = {
    posted: { stamp: 'si-clean', icon: '✓', label: 'Posted' },
    skipped_no_contact: { stamp: 'si-nomatch', icon: '?', label: 'No Xero Contact Match' },
    skipped_no_nominal_code: { stamp: 'si-amber', icon: '!', label: 'Nominal Code Not Set' },
    skipped_error: { stamp: 'si-vendor', icon: '✗', label: 'Error' },
    duplicate_skipped: { stamp: 'si-dup', icon: '⧉', label: 'Duplicate Skipped' }
  };

  function renderList() {
    const container = document.getElementById('salesInvoicesList');
    if (!container) return;

    let rows = state.rows;
    if (state.filter === 'posted') rows = rows.filter(r => r.status === 'posted');
    if (state.filter === 'attention') rows = rows.filter(r => ATTENTION_STATUSES.includes(r.status));
    if (state.filter === 'nominal') rows = rows.filter(r => r.status === 'skipped_no_nominal_code');

    if (!rows.length) {
      container.innerHTML = '<div class="si-empty">No sales invoice activity yet.</div>';
      return;
    }

    container.innerHTML = rows.map(rowHtml).join('');

    container.querySelectorAll('.si-case').forEach(el => {
      el.onclick = () => el.classList.toggle('open');
    });
  }

  function rowHtml(row) {
    const meta = STATUS_META[row.status] || { stamp: 'si-nomatch', icon: '?', label: row.status || 'Unknown' };

    return `
      <div class="si-case">
        <div class="si-case-head">
          <div class="si-stamp ${meta.stamp}">${meta.icon}</div>
          <div class="si-case-main">
            <div class="si-case-ref">Order #${esc(row.order_id || '—')}</div>
            <div class="si-case-title">${esc(row.customer_name || 'Unknown customer')}</div>
            <div class="si-case-sub">
              <span class="si-badge-mini">${esc(meta.label)}</span>
              ${row.line_count ? `<span>${num(row.line_count)} line${Number(row.line_count) === 1 ? '' : 's'}</span>` : ''}
            </div>
          </div>
          <div class="si-case-meta">
            <span class="si-amt">${money(row.total_amount || 0)}</span>
            ${date(row.created_at)}
          </div>
        </div>
        <div class="si-case-detail">
          ${
            row.xero_invoice_id
              ? `<div class="si-detail-row"><span>Xero Invoice ID</span><b>${esc(row.xero_invoice_id)}</b></div>`
              : ''
          }
          ${
            row.notes
              ? `<div class="si-notes">${esc(row.notes)}</div>`
              : '<div class="si-notes si-notes-muted">No notes for this entry.</div>'
          }
        </div>
      </div>
    `;
  }

  window.loadSalesInvoices = loadSalesInvoices;
})();
