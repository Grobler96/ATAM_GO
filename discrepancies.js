// discrepancies.js
// Powers the Discrepancies tab. Reuses the existing window._atamSb Supabase
// client set up elsewhere in the app (per the established pattern) rather
// than creating a new client instance.

(function () {
  'use strict';

  const TYPE_META = {
    vendor_mismatch: { stamp: 'V', cls: 'vendor', label: 'Vendor mismatch' },
    amount_variance:  { stamp: '%', cls: 'amount', label: 'Amount variance' },
    no_po_match:      { stamp: '?', cls: 'nomatch', label: 'No PO match' },
    partial_delivery_unclear: { stamp: '~', cls: 'amount', label: 'Partial delivery' }
  };

  let allRows = [];

  async function getSb() {
    // Reuse the existing global client if the rest of the app has already
    // set one up (window._atamSb). Fall back only if genuinely absent.
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
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function loadDiscrepancies() {
    const sb = await getSb();
    const { data, error } = await sb
      .from('invoice_discrepancies')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.error('[Discrepancies] load error', error);
      document.getElementById('discrepanciesList').innerHTML =
        '<div class="disc-empty">Couldn\'t load discrepancies. Check the console for details.</div>';
      return;
    }
    allRows = data || [];
    renderSummary();
    renderList();
  }

  function renderSummary() {
    const open = allRows.filter(r => r.status === 'open');
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const resolvedThisWeek = allRows.filter(r => r.status !== 'open' && r.resolved_at && new Date(r.resolved_at) >= weekAgo);
    const openValue = open.reduce((s, r) => s + Math.abs(Number(r.variance_amount) || Number(r.invoice_goods) || 0), 0);
    const decoOutstanding = allRows.filter(r => r.deconetwork_correction_needed && !r.deconetwork_corrected);

    document.getElementById('discOpenCount').textContent = open.length;
    document.getElementById('discResolvedCount').textContent = resolvedThisWeek.length;
    document.getElementById('discOpenValue').textContent = fmtMoney(openValue);
    document.getElementById('discDecoOutstanding').textContent = decoOutstanding.length;
  }

  function renderList() {
    const container = document.getElementById('discrepanciesList');
    const open = allRows.filter(r => r.status === 'open');

    if (open.length === 0) {
      container.innerHTML = '<div class="disc-empty">✅ No open discrepancies right now.</div>';
      return;
    }

    container.innerHTML = open.map(row => renderCase(row)).join('');

    // Wire up expand/collapse + action buttons after render
    open.forEach(row => {
      const el = document.getElementById('case-' + row.id);
      if (!el) return;
      el.querySelector('.disc-case-head').addEventListener('click', () => el.classList.toggle('open'));

      const approveBtn = el.querySelector('[data-action="approve"]');
      const correctBtn = el.querySelector('[data-action="correct"]');
      const rejectBtn = el.querySelector('[data-action="reject"]');
      if (approveBtn) approveBtn.addEventListener('click', (e) => { e.stopPropagation(); resolveCase(row.id, 'approved'); });
      if (correctBtn) correctBtn.addEventListener('click', (e) => { e.stopPropagation(); resolveCase(row.id, 'corrected'); });
      if (rejectBtn) rejectBtn.addEventListener('click', (e) => { e.stopPropagation(); resolveCase(row.id, 'rejected'); });
    });
  }

  function renderCase(row) {
    const meta = TYPE_META[row.discrepancy_type] || TYPE_META.no_po_match;
    const varianceTxt = row.variance_amount != null
      ? (Number(row.variance_amount) >= 0 ? '+' : '') + fmtMoney(row.variance_amount)
      : '—';

    let whyText = '';
    if (row.discrepancy_type === 'vendor_mismatch') {
      whyText = `The purchase order is attached to <b>${row.po_vendor || 'an unknown vendor'}</b> in DecoNetwork, but the matched invoice is from <b>${row.invoice_vendor || 'a different vendor'}</b>. These may be entirely separate businesses.`;
    } else if (row.discrepancy_type === 'amount_variance') {
      whyText = `The invoiced total differs from the PO's sub-total + tax by ${varianceTxt} (${row.variance_pct != null ? row.variance_pct + '%' : 'outside tolerance'}), beyond the agreed ±2%/£1 tolerance.`;
    } else {
      whyText = `An invoice arrived from <b>${row.invoice_vendor || 'this vendor'}</b> with no PO number the system could match against DecoNetwork.`;
    }

    const decoFlag = row.deconetwork_correction_needed ? `
      <div class="disc-deco-flag">
        <label><input type="checkbox" ${row.deconetwork_corrected ? 'checked' : ''} disabled style="width:auto;"> DecoNetwork PO still needs manual correction</label>
        <div class="disc-df-note">Can't be fixed via API — someone with Purchasing access needs to edit this PO in DecoNetwork Business Hub.</div>
      </div>` : '';

    return `
      <div class="disc-case" id="case-${row.id}">
        <div class="disc-case-head">
          <div class="disc-stamp ${meta.cls}">${meta.stamp}</div>
          <div class="disc-case-main">
            <div class="disc-case-po">PO ${row.po_number || 'UNKNOWN'} · FLAGGED ${fmtDate(row.created_at)}</div>
            <div class="disc-case-title">${meta.label}${row.po_vendor && row.invoice_vendor ? ` — ${row.po_vendor} vs ${row.invoice_vendor}` : ''}</div>
            <div class="disc-case-sub">${row.invoice_vendor || row.po_vendor || 'Unknown vendor'}</div>
          </div>
          <div class="disc-case-meta">
            <span class="disc-amt">${fmtMoney(row.invoice_goods)}</span>
            ${varianceTxt} variance
            ${row.deconetwork_correction_needed && !row.deconetwork_corrected ? '<div class="disc-badge-mini">DecoNetwork fix pending</div>' : ''}
          </div>
        </div>
        <div class="disc-case-detail">
          <div class="disc-why">
            <div class="disc-why-label">What's wrong</div>
            <p>${whyText}</p>
          </div>

          <div class="disc-compare">
            <div class="disc-compare-card mismatch">
              <div class="disc-ct-label">DecoNetwork PO</div>
              <div class="disc-ct-vendor">${row.po_vendor || '—'}</div>
              <div class="disc-ct-row"><span>Sub-total</span><b>${fmtMoney(row.po_sub_total)}</b></div>
              <div class="disc-ct-row"><span>Tax</span><b>${fmtMoney(row.po_tax)}</b></div>
            </div>
            <div class="disc-compare-arrow">→</div>
            <div class="disc-compare-card">
              <div class="disc-ct-label">Invoice</div>
              <div class="disc-ct-vendor">${row.invoice_vendor || '—'}</div>
              <div class="disc-ct-row"><span>Goods</span><b>${fmtMoney(row.invoice_goods)}</b></div>
              <div class="disc-ct-row"><span>VAT</span><b>${fmtMoney(row.invoice_vat)}</b></div>
            </div>
          </div>

          <div class="disc-fix">
            <div class="disc-fix-label">How to fix this</div>
            <ol>
              <li>Pick the nominal code below and choose <b>Approve</b> or <b>Correct &amp; post</b> to send this to Xero.</li>
              ${row.deconetwork_correction_needed ? '<li>Separately, open the PO in <span class="disc-where">DecoNetwork → Business Hub → Purchase Orders</span> and correct the vendor there — this can\'t be done automatically.</li>' : ''}
            </ol>
          </div>

          <div class="disc-field">
            <label>Nominal code</label>
            <select id="nominal-${row.id}">
              <option ${row.proposed_nominal_code === '311' ? 'selected' : ''}>311 — Workwear/Clothing COGS</option>
            </select>
          </div>

          <div class="disc-field">
            <label>Resolution notes</label>
            <textarea id="notes-${row.id}" placeholder="Add a note before resolving...">${row.resolution_notes || ''}</textarea>
          </div>

          ${decoFlag}

          <div class="disc-actions">
            <button type="button" class="disc-btn danger" data-action="reject">Reject</button>
            <button type="button" class="disc-btn" data-action="correct">Correct &amp; post</button>
            <button type="button" class="disc-btn primary" data-action="approve">Approve &amp; post to Xero</button>
          </div>
        </div>
      </div>`;
  }

  async function resolveCase(id, status) {
    const sb = await getSb();
    const notesEl = document.getElementById('notes-' + id);
    const { data: { session } } = await sb.auth.getSession();
    const resolvedBy = session?.user?.email || 'unknown';

    const { error } = await sb.rpc('resolve_discrepancy', {
      p_id: id,
      p_status: status,
      p_resolved_by: resolvedBy,
      p_resolution_notes: notesEl ? notesEl.value : null
    });

    if (error) {
      console.error('[Discrepancies] resolve error', error);
      alert('Could not save that resolution — check the console for details.');
      return;
    }
    await loadDiscrepancies();
  }

  // ---- Export (PDF / Excel) ----
  // Uses jsPDF + SheetJS, loaded on demand only when the tab is used,
  // to avoid adding weight to every other page's load.
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function periodLabel() {
    const map = { today: 'Today', week: 'This Week', month: 'This Month', last30: 'Last 30 Days' };
    return map[document.getElementById('discPeriodSelect').value] || 'This Week';
  }

  function rowsForPeriod() {
    const sel = document.getElementById('discPeriodSelect').value;
    const now = new Date();
    let from;
    if (sel === 'today') from = new Date(now.setHours(0, 0, 0, 0));
    else if (sel === 'week') from = new Date(now.getTime() - 7 * 864e5);
    else if (sel === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
    else from = new Date(now.getTime() - 30 * 864e5);
    return allRows.filter(r => r.resolved_at && new Date(r.resolved_at) >= from);
  }

  async function exportPDF() {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const rows = rowsForPeriod();
    const margin = 40; let y = 50;
    const pageW = doc.internal.pageSize.getWidth();

    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 29, 33);
    doc.text('CPI Corporate Solutions Ltd', margin, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(91, 97, 105);
    y += 16; doc.text('Trading as ATAM Workwear', margin, y); y += 26;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(26, 29, 33);
    doc.text('Purchase Order / Invoice Discrepancy Audit Trail', margin, y); y += 16;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(91, 97, 105);
    doc.text(`Reporting period: ${periodLabel()}`, margin, y); y += 14;
    doc.text(`Report generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, margin, y); y += 24;
    doc.setDrawColor(228, 230, 233); doc.line(margin, y, pageW - margin, y); y += 22;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    rows.forEach(row => {
      y += 16; if (y > 760) { doc.addPage(); y = 50; }
      doc.setTextColor(26, 29, 33);
      doc.text(`PO ${row.po_number} — ${row.discrepancy_type} — ${row.status} by ${row.resolved_by || '—'} on ${fmtDate(row.resolved_at)}`, margin, y);
      y += 12;
      doc.setTextColor(120, 124, 130);
      doc.text(row.resolution_notes || 'No notes', margin + 4, y, { maxWidth: pageW - margin * 2 - 8 });
      y += 6;
      doc.setDrawColor(240, 241, 243); doc.line(margin, y, pageW - margin, y);
    });

    if (rows.length === 0) { doc.setTextColor(120,124,130); doc.text('No resolved items in this period.', margin, y); }

    doc.save(`ATAM_Discrepancy_Audit_Trail_${periodLabel().replace(/\s/g, '_')}.pdf`);
  }

  async function exportXLSX() {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/SheetJS/0.18.5/xlsx.full.min.js');
    const rows = rowsForPeriod();
    const header = ['PO Number', 'PO Vendor', 'Invoice Vendor', 'Issue Type', 'Invoice Goods (£)', 'Invoice VAT (£)', 'Variance (£)', 'Variance (%)', 'Nominal Code', 'Status', 'Resolved By', 'Resolved At', 'Xero Bill Ref', 'Notes'];
    const body = rows.map(r => [r.po_number, r.po_vendor, r.invoice_vendor, r.discrepancy_type, r.invoice_goods, r.invoice_vat, r.variance_amount, r.variance_pct, r.proposed_nominal_code, r.status, r.resolved_by, r.resolved_at, r.xero_bill_id, r.resolution_notes]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    ws['!cols'] = header.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Trail');
    XLSX.writeFile(wb, `ATAM_Discrepancy_Audit_Trail_${periodLabel().replace(/\s/g, '_')}.xlsx`);
  }

  // ---- Init: load data when the tab is first shown ----
  function initWhenVisible() {
    const btn = document.querySelector('.nav-link[data-page="discrepancies"]');
    if (btn) btn.addEventListener('click', () => loadDiscrepancies());

    document.getElementById('discExportPdfBtn')?.addEventListener('click', exportPDF);
    document.getElementById('discExportXlsxBtn')?.addEventListener('click', exportXLSX);
    document.getElementById('discPeriodSelect')?.addEventListener('change', () => {});

    // Load immediately on page load regardless of which tab is currently
    // visible — this is a small query, and it means the data is ready the
    // instant someone clicks into the tab rather than depending on the
    // click handler firing or the tab's active-class state at load time.
    loadDiscrepancies();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhenVisible);
  else initWhenVisible();
})();
