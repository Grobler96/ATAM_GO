// sales_invoices_view.js
// Powers the "Sales Invoices" tab. Read-mostly view over sales_invoice_log, the
// audit trail written by WF6_Post_Sales_Invoices_to_Xero. Nothing here posts
// anything new to Xero - the only write action is "Refresh from Xero", which
// re-checks logged invoices against Xero's real current status and corrects
// drift (e.g. an invoice deleted/voided directly in Xero after being logged).

(function () {
  'use strict';

  const REFRESH_SALES_INVOICES_WEBHOOK = 'https://atamcpi.app.n8n.cloud/webhook/refresh-sales-invoices';
  const ATAM_GO_TOKEN = '42f5d7bb154d98a8cfc5d8b7e2d83693a088e0f78b2357bf352c518ce25f07cc';

  // Anything in this set is "needs attention" for the summary card - a real
  // problem worth someone's eyes, as opposed to a normal successful post.
  const ATTENTION_STATUSES = new Set([
    'skipped_no_contact',
    'skipped_no_nominal_code',
    'skipped_error',
    'duplicate_skipped',
    'deleted_in_xero'
  ]);

  const STATUS_META = {
    posted:                  { stamp: '✓', cls: 'si-clean',   label: 'Posted' },
    skipped_no_contact:      { stamp: '?', cls: 'si-nomatch', label: 'Skipped - no Xero contact match' },
    skipped_no_nominal_code: { stamp: '!', cls: 'si-amber',   label: 'Skipped - nominal code not set' },
    skipped_error:           { stamp: '!', cls: 'si-vendor',  label: 'Skipped - error' },
    duplicate_skipped:       { stamp: '⚠', cls: 'si-dup',     label: 'Skipped - possible duplicate' },
    deleted_in_xero:         { stamp: '✕', cls: 'si-vendor',  label: 'Deleted/voided in Xero' }
  };

  let allRows = [];
  let currentFilter = 'all';

  async function getSb() {
    if (window._atamSb) return window._atamSb;
    const SUPABASE_URL = 'https://aobosyvlhgkxhjxkfzlz.supabase.co';
    const SUPABASE_ANON = 'sb_publishable_4Ii8Z8bGgQ5OrSKB2at_GA_GubBsWC1';
    window._atamSb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return window._atamSb;
  }

  function fmtMoney(n) {
    return '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function isToday(d) {
    if (!d) return false;
    const a = new Date(d), b = new Date();
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function isThisWeek(d) {
    if (!d) return false;
    const a = new Date(d);
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    return a >= weekAgo && a <= now;
  }

  async function loadSalesInvoices() {
    const container = document.getElementById('salesInvoicesList');
    if (!container) return; // index.html hasn't been updated with this tab yet

    const sb = await getSb();
    const { data, error } = await sb
      .from('sales_invoice_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[Sales Invoices] load error', error);
      container.innerHTML = '<div class="si-empty">Couldn\'t load sales invoices. Check the console.</div>';
      return;
    }

    allRows = data || [];
    renderSummary();
    renderList();
  }

  function renderSummary() {
    const postedToday = allRows.filter(r => r.status === 'posted' && isToday(r.created_at)).length;
    const needsAttention = allRows.filter(r => ATTENTION_STATUSES.has(r.status)).length;
    const postedWeek = allRows.filter(r => r.status === 'posted' && isThisWeek(r.created_at));
    const valueWeek = postedWeek.reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);

    const el = id => document.getElementById(id);
    if (el('siPostedToday')) el('siPostedToday').textContent = postedToday;
    if (el('siNeedsAttention')) el('siNeedsAttention').textContent = needsAttention;
    if (el('siPostedWeek')) el('siPostedWeek').textContent = postedWeek.length;
    if (el('siValueWeek')) el('siValueWeek').textContent = fmtMoney(valueWeek);
  }

  function filteredRows() {
    if (currentFilter === 'all') return allRows;
    if (currentFilter === 'posted') return allRows.filter(r => r.status === 'posted');
    if (currentFilter === 'attention') return allRows.filter(r => ATTENTION_STATUSES.has(r.status));
    if (currentFilter === 'nominal') return allRows.filter(r => r.status === 'skipped_no_nominal_code');
    return allRows;
  }

  function renderList() {
    const container = document.getElementById('salesInvoicesList');
    if (!container) return;

    const rows = filteredRows();

    if (rows.length === 0) {
      container.innerHTML = '<div class="si-empty">Nothing here for this filter.</div>';
      return;
    }

    container.innerHTML = rows.map(row => renderCase(row)).join('');

    rows.forEach(row => {
      const el = document.getElementById('si-' + row.id);
      if (!el) return;
      const head = el.querySelector('.si-case-head');
      if (head) head.addEventListener('click', () => el.classList.toggle('open'));
    });
  }

  function renderCase(row) {
    const meta = STATUS_META[row.status] || { stamp: '?', cls: 'si-nomatch', label: row.status || 'Unknown' };

    let notesHtml = '';
    if (row.notes) {
      const isProblem = ATTENTION_STATUSES.has(row.status);
      notesHtml = `<div class="si-notes${isProblem ? '' : ' si-notes-muted'}">${row.status === 'deleted_in_xero' ? '⚠️' : '📝'} ${row.notes}</div>`;
    }

    return `
      <div class="si-case" id="si-${row.id}">
        <div class="si-case-head">
          <div class="si-stamp ${meta.cls}">${meta.stamp}</div>
          <div class="si-case-main">
            <div class="si-case-ref">Order ${row.order_id || 'unknown'} · ${fmtDate(row.created_at)}</div>
            <div class="si-case-title">${row.customer_name || 'Unknown customer'}</div>
            <div class="si-case-sub">${meta.label}</div>
          </div>
          <div class="si-case-meta">
            <span class="si-amt">${fmtMoney(row.total_amount)}</span>
          </div>
        </div>
        <div class="si-case-detail">
          <div class="si-detail-row"><span>Order</span><b>${row.order_id || '—'}</b></div>
          <div class="si-detail-row"><span>Customer</span><b>${row.customer_name || '—'}</b></div>
          <div class="si-detail-row"><span>Amount</span><b>${fmtMoney(row.total_amount)}</b></div>
          <div class="si-detail-row"><span>Xero Invoice ID</span><b>${row.xero_invoice_id || 'Never posted'}</b></div>
          <div class="si-detail-row"><span>Logged</span><b>${fmtDate(row.created_at)}</b></div>
          ${notesHtml}
        </div>
      </div>`;
  }

  async function refreshFromXero(buttonEl) {
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Checking Xero…';
    }
    try {
      const res = await fetch(REFRESH_SALES_INVOICES_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Atam-Go-Token': ATAM_GO_TOKEN },
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || 'Request failed: ' + res.status);

      if (data.updatedCount > 0) {
        const changeLines = (data.updates || [])
          .map(u => `Order ${u.order_id}: ${u.oldStatus} → ${u.newStatus}`)
          .join('\n');
        alert(`Updated ${data.updatedCount} invoice(s) to match Xero:\n${changeLines}`);
      } else {
        alert(data.message || 'Everything already matches Xero.');
      }
      await loadSalesInvoices();
    } catch (e) {
      console.error('[Sales Invoices] refresh from Xero error', e);
      alert('Could not check Xero. Check the console.');
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = '🔄 Refresh from Xero';
      }
    }
  }

  function wireControls() {
    const filterEl = document.getElementById('siFilter');
    if (filterEl) {
      filterEl.addEventListener('change', () => {
        currentFilter = filterEl.value;
        renderList();
      });
    }

    const refreshBtn = document.getElementById('siRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => loadSalesInvoices());
    }

    const refreshFromXeroBtn = document.getElementById('siRefreshFromXeroBtn');
    if (refreshFromXeroBtn) {
      refreshFromXeroBtn.addEventListener('click', (e) => refreshFromXero(e.currentTarget));
    }
  }

  function initWhenVisible() {
    wireControls();
    loadSalesInvoices();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhenVisible);
  else initWhenVisible();

  window.salesInvoicesRefresh = loadSalesInvoices;
})();
