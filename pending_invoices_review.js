// pending_invoices_review.js
// Powers the "Invoice Review" tab, the gate BEFORE anything reaches Xero.
// Every invoice sits here, fully editable, until approved. Nothing here
// has touched Xero yet. Reuses window._atamSb same as discrepancies.js.

(function () {
  'use strict';

  const RETRY_MATCH_WEBHOOK = 'https://atamcpi.app.n8n.cloud/webhook/retry-po-match';
  const RETRY_MATCH_TOKEN = '42f5d7bb154d98a8cfc5d8b7e2d83693a088e0f78b2357bf352c518ce25f07cc';

  const MATCH_META = {
    clean_match:        { stamp: '✓', cls: 'clean',  label: 'Clean match' },
    vendor_mismatch:     { stamp: 'V', cls: 'vendor', label: 'Vendor mismatch' },
    amount_variance:     { stamp: '%', cls: 'amount', label: 'Amount variance' },
    no_po_match:         { stamp: '?', cls: 'nomatch', label: 'No PO match' },
    duplicate_suspected: { stamp: '⚠', cls: 'vendor', label: 'Possible duplicate' },
    pending:             { stamp: '…', cls: 'nomatch', label: 'Not yet matched' },
  };

  let allRows = [];
  let approvedRows = [];

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

  async function loadPending() {
    const sb = await getSb();
    const { data, error } = await sb
      .from('pending_invoices')
      .select('*')
      .eq('status', 'awaiting_review')
      .order('received_at', { ascending: false })
      .limit(200);
    if (error) {
      console.error('[Review] load error', error);
      document.getElementById('reviewList').innerHTML = '<div class="rev-empty">Couldn\'t load pending invoices. Check the console.</div>';
      return;
    }
    allRows = data || [];
    renderSummary();
    renderList();
    await loadApproved();
  }

  async function loadApproved() {
    const container = document.getElementById('approvedList');
    if (!container) return; // index.html hasn't been updated with the new section yet

    const sb = await getSb();
    const { data, error } = await sb
      .from('pending_invoices')
      .select('*')
      .eq('status', 'approved')
      .is('xero_bill_id', null)
      .order('reviewed_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[Review] load approved error', error);
      return;
    }
    approvedRows = data || [];
    renderApprovedList();
  }

  function renderSummary() {
    const highConf = allRows.filter(r => r.extraction_confidence === 'high').length;
    const lowConf = allRows.filter(r => r.extraction_confidence === 'low').length;
    const cleanMatches = allRows.filter(r => r.match_status === 'clean_match').length;
    const totalValue = allRows.reduce((s, r) => s + (Number(r.extracted_total) || 0), 0);

    document.getElementById('revAwaitingCount').textContent = allRows.length;
    document.getElementById('revCleanCount').textContent = cleanMatches;
    document.getElementById('revLowConfCount').textContent = lowConf;
    document.getElementById('revTotalValue').textContent = fmtMoney(totalValue);
  }

  function renderList() {
    const container = document.getElementById('reviewList');
    if (allRows.length === 0) {
      container.innerHTML = '<div class="rev-empty">✅ Nothing waiting for review right now.</div>';
      return;
    }
    container.innerHTML = allRows.map(row => renderCase(row)).join('');

    allRows.forEach(row => {
      const el = document.getElementById('rev-' + row.id);
      if (!el) return;
      el.querySelector('.rev-case-head').addEventListener('click', () => el.classList.toggle('open'));

      const approveBtn = el.querySelector('[data-action="approve"]');
      const rejectBtn = el.querySelector('[data-action="reject"]');
      const retryBtn = el.querySelector('[data-action="retry-match"]');
      if (approveBtn) approveBtn.addEventListener('click', (e) => { e.stopPropagation(); approveRow(row.id); });
      if (rejectBtn) rejectBtn.addEventListener('click', (e) => { e.stopPropagation(); rejectRow(row.id); });
      if (retryBtn) retryBtn.addEventListener('click', (e) => { e.stopPropagation(); retryMatch(row.id, retryBtn); });
    });
  }

  function renderApprovedList() {
    const container = document.getElementById('approvedList');
    if (!container) return;

    const countEl = document.getElementById('revApprovedCount');
    if (countEl) countEl.textContent = approvedRows.length;

    if (approvedRows.length === 0) {
      container.innerHTML = '<div class="rev-empty" style="padding:24px 20px">Nothing sitting in approved-but-not-yet-posted right now.</div>';
      return;
    }

    container.innerHTML = approvedRows.map(row => `
      <div class="rev-case" id="rev-approved-${row.id}" style="cursor:default">
        <div class="rev-case-head" style="cursor:default">
          <div class="rev-stamp clean">✓</div>
          <div class="rev-case-main">
            <div class="rev-case-ref">Invoice ${row.extracted_invoice_number || 'unknown'} · Approved by ${row.reviewed_by || 'unknown'} at ${fmtDate(row.reviewed_at)}</div>
            <div class="rev-case-title">${row.final_vendor || row.extracted_vendor || 'Unknown vendor'}</div>
            <div class="rev-case-sub">${row.final_po_reference ? 'PO ' + row.final_po_reference : 'No PO reference'} · Waiting to post to Xero</div>
          </div>
          <div class="rev-case-meta">
            <span class="rev-amt">${fmtMoney(row.final_total)}</span>
          </div>
        </div>
        <div style="padding:0 20px 16px">
          <button type="button" class="rev-btn danger" data-action="undo-approve" data-id="${row.id}" style="width:100%">↺ Undo Approval</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="undo-approve"]').forEach(btn => {
      btn.addEventListener('click', () => undoApprove(btn.dataset.id, btn));
    });
  }

  async function undoApprove(id, buttonEl) {
    if (!confirm('Undo this approval and send it back to Awaiting Review?')) return;

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Undoing…';
    }

    const sb = await getSb();
    const { error } = await sb.rpc('unapprove_pending_invoice', { p_id: id });

    if (error) {
      console.error('[Review] undo approve error', error);
      alert(error.message && error.message.includes('already been posted')
        ? 'This invoice has already been posted to Xero and cannot be undone here. Contact Daniel to reverse it.'
        : 'Could not undo this approval. Check the console.');
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = '↺ Undo Approval';
      }
      return;
    }

    await loadPending();
  }

  function renderCase(row) {
    const meta = MATCH_META[row.match_status] || MATCH_META.pending;
    const confBadge = row.extraction_confidence === 'low'
      ? '<span class="rev-badge-mini rev-badge-warn">Low confidence, check carefully</span>'
      : row.extraction_confidence === 'medium'
      ? '<span class="rev-badge-mini">Medium confidence</span>'
      : '';

    // Shown under the "How to fix this" list for anything that isn't already a clean
    // match. Re-checks this invoice against the current DecoNetwork PO list on demand,
    // using whatever's currently typed into Vendor / PO Reference below. Useful when a
    // PO was raised or synced after this invoice first arrived.
    const retryMatchButton = row.match_status !== 'clean_match'
      ? `<button type="button" class="rev-btn" data-action="retry-match" style="margin-top:10px;width:100%">↻ Retry Match Against Current POs</button>`
      : '';

    let whyHtml = '';
    if (row.match_status === 'clean_match') {
      whyHtml = `<div class="rev-why rev-why-good"><div class="rev-why-label">Looks good</div><p>Vendor and amount both line up with PO ${row.matched_po_number} within tolerance. Safe to approve as-is, or adjust anything below first if something looks off.</p></div>`;
    } else if (row.match_status === 'vendor_mismatch') {
      whyHtml = `<div class="rev-why"><div class="rev-why-label">What's wrong</div><p>This invoice is from <b>${row.extracted_vendor || 'this vendor'}</b>, but the matched PO (${row.matched_po_number}) is recorded under <b>${row.matched_po_vendor || 'a different vendor'}</b> in DecoNetwork. Could be a genuine data-entry error on the PO, or the wrong PO matched.</p></div>
        <div class="rev-fix"><div class="rev-fix-label">How to fix this</div><ol>
          <li>Check the amounts below actually match this PO. If they do, the vendor field in DecoNetwork is likely just wrong.</li>
          <li>Update the <b>Vendor</b> field below to the correct one, then hit <b>Retry Match</b> to confirm it now lines up before approving.</li>
          <li>Separately, flag the PO for correction in <span class="rev-where">DecoNetwork → Business Hub</span> so it's right at the source too. That's a manual step outside this tab.</li>
        </ol>${retryMatchButton}</div>`;
    } else if (row.match_status === 'amount_variance') {
      const poCombined = (Number(row.matched_po_sub_total)||0) + (Number(row.matched_po_tax)||0);
      const invCombined = (Number(row.extracted_goods)||0) + (Number(row.extracted_vat)||0);
      const diff = (invCombined - poCombined).toFixed(2);
      whyHtml = `<div class="rev-why"><div class="rev-why-label">What's wrong</div><p>The invoice total (${fmtMoney(invCombined)}) is ${diff >= 0 ? fmtMoney(Math.abs(diff)) + ' more than' : fmtMoney(Math.abs(diff)) + ' less than'} PO ${row.matched_po_number}'s value (${fmtMoney(poCombined)}), outside the agreed ±2%/£1 tolerance. Often a carriage charge, discount, or partial delivery not reflected on the original PO.</p></div>
        <div class="rev-fix"><div class="rev-fix-label">How to fix this</div><ol>
          <li>Check the line items below against the PO for what caused the difference: an added charge, a partial delivery, or a genuine pricing change.</li>
          <li>If the PO itself has since been corrected in DecoNetwork, hit <b>Retry Match</b> to re-check against the current figures.</li>
          <li>If the variance is genuine, just approve as-is. The <b>Total to post</b> field below already reflects what was actually invoiced.</li>
          <li>If something looks wrong, correct the fields below before approving, or reject and follow up with the supplier.</li>
        </ol>${retryMatchButton}</div>`;
    } else if (row.match_status === 'no_po_match') {
      whyHtml = `<div class="rev-why"><div class="rev-why-label">What's wrong</div><p>No PO number was found on this invoice, or it didn't match anything in DecoNetwork. This could mean the PO hasn't synced yet, was raised under a different number, or genuinely doesn't exist.</p></div>
        <div class="rev-fix"><div class="rev-fix-label">How to fix this, in order</div><ol>
          <li><b>Check DecoNetwork directly</b> for a PO around this date and amount. If you find one, type its number into <b>PO Reference</b> below, then hit <b>Retry Match</b>. This validates it against the real PO figures rather than just trusting the number.</li>
          <li>If the PO was only just raised, it may not have synced yet (sync runs every 3 hours). Hit <b>Retry Match</b> again a little later.</li>
          <li><b>Only if you've genuinely confirmed no PO exists</b> for this order (checked DecoNetwork yourself, and confirmed with whoever placed it that it was authorised), approve with the PO Reference field left blank. This should be the exception, not the default: every approval without a PO reference is a real gap in the audit trail.</li>
          <li>If it looks wrong or unauthorised, reject and flag to Daniel.</li>
        </ol>${retryMatchButton}</div>`;
    } else {
      whyHtml = `<div class="rev-why"><div class="rev-why-label">Not yet matched</div><p>This invoice hasn't been checked against DecoNetwork POs yet.</p></div>${retryMatchButton}`;
    }

    let lineItemsHtml = '';
    try {
      const items = JSON.parse(row.extracted_line_items || '[]');
      if (items.length) {
        lineItemsHtml = items.map(li =>
          `<div class="rev-li-row"><span>${li.description || ''}</span><span>${li.quantity || ''} × ${fmtMoney(li.unit_price)}</span><span>${fmtMoney(li.line_total)}</span></div>`
        ).join('');
      }
    } catch (e) { /* ignore malformed line items */ }

    return `
      <div class="rev-case" id="rev-${row.id}">
        <div class="rev-case-head">
          <div class="rev-stamp ${meta.cls}">${meta.stamp}</div>
          <div class="rev-case-main">
            <div class="rev-case-ref">Invoice ${row.extracted_invoice_number || 'unknown'} · Received ${fmtDate(row.received_at)}</div>
            <div class="rev-case-title">${row.extracted_vendor || 'Unknown vendor'} · ${meta.label}</div>
            <div class="rev-case-sub">${row.matched_po_number ? 'Matched to PO ' + row.matched_po_number : 'No PO matched yet'} ${confBadge}</div>
          </div>
          <div class="rev-case-meta">
            <span class="rev-amt">${fmtMoney(row.extracted_total)}</span>
            ${row.extracted_invoice_date ? fmtDate(row.extracted_invoice_date).split(',')[0] : ''}
          </div>
        </div>

        <div class="rev-case-detail">
          ${whyHtml}
          ${row.extraction_notes ? `<div class="rev-notes-flag">📝 ${row.extraction_notes}</div>` : ''}

          <div class="rev-compare">
            <div class="rev-compare-card">
              <div class="rev-ct-label">Matched DecoNetwork PO</div>
              <div class="rev-ct-vendor">${row.matched_po_vendor || 'No match'}</div>
              <div class="rev-ct-row"><span>Sub-total</span><b>${fmtMoney(row.matched_po_sub_total)}</b></div>
              <div class="rev-ct-row"><span>Tax</span><b>${fmtMoney(row.matched_po_tax)}</b></div>
            </div>
            <div class="rev-compare-arrow">→</div>
            <div class="rev-compare-card ${row.match_status !== 'clean_match' ? 'mismatch' : ''}">
              <div class="rev-ct-label">Extracted from invoice</div>
              <div class="rev-ct-vendor">${row.extracted_vendor || '—'}</div>
              <div class="rev-ct-row"><span>Goods</span><b>${fmtMoney(row.extracted_goods)}</b></div>
              <div class="rev-ct-row"><span>VAT</span><b>${fmtMoney(row.extracted_vat)}</b></div>
            </div>
          </div>

          ${lineItemsHtml ? `<div class="rev-line-items"><div class="rev-li-label">Line items</div>${lineItemsHtml}</div>` : ''}

          <div class="rev-edit-label">Edit before posting. Nothing reaches Xero until you approve</div>

          <div class="rev-field-row">
            <div class="rev-field">
              <label>Vendor</label>
              <input type="text" id="vendor-${row.id}" value="${(row.extracted_vendor || '').replace(/"/g,'&quot;')}">
            </div>
            <div class="rev-field">
              <label>PO Reference</label>
              <input type="text" id="poref-${row.id}" value="${(row.matched_po_number || row.extracted_po_number || '').replace(/"/g,'&quot;')}">
            </div>
          </div>
          <div class="rev-field-row">
            <div class="rev-field">
              <label>Total to post</label>
              <input type="number" step="0.01" id="total-${row.id}" value="${row.extracted_total || 0}">
            </div>
            <div class="rev-field">
              <label>Nominal code</label>
              <select id="nominal-${row.id}">
                <option>311: Workwear/Clothing COGS</option>
              </select>
            </div>
          </div>

          <div class="rev-field">
            <label>Review notes</label>
            <textarea id="notes-${row.id}" placeholder="Optional note before approving or rejecting..."></textarea>
          </div>

          <div class="rev-actions">
            <button type="button" class="rev-btn danger" data-action="reject">Reject</button>
            <button type="button" class="rev-btn primary" data-action="approve">Approve, ready to post</button>
          </div>
          <div class="rev-post-note">Approving stages this for posting to Xero once that connection is wired up. Nothing is sent automatically yet.</div>
        </div>
      </div>`;
  }

  async function retryMatch(id, buttonEl) {
    const vendor = document.getElementById('vendor-' + id).value;
    const poRef = document.getElementById('poref-' + id).value;
    const row = allRows.find(r => r.id === id);
    if (!row) return;

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Checking…';
    }

    try {
      const res = await fetch(RETRY_MATCH_WEBHOOK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Atam-Go-Token': RETRY_MATCH_TOKEN
        },
        body: JSON.stringify({
          id: id,
          vendor: vendor,
          po_number: poRef,
          goods_total: row.extracted_goods,
          vat_total: row.extracted_vat
        })
      });
      if (!res.ok) throw new Error('Retry match failed: ' + res.status);
      await loadPending();
    } catch (e) {
      console.error('[Review] retry match error', e);
      alert('Could not re-check this invoice. Check the console.');
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = '↻ Retry Match Against Current POs';
      }
    }
  }

  async function approveRow(id) {
    const sb = await getSb();
    const { data: { session } } = await sb.auth.getSession();
    const reviewedBy = session?.user?.email || 'unknown';

    const vendor = document.getElementById('vendor-' + id).value;
    const poRef = document.getElementById('poref-' + id).value;
    const total = parseFloat(document.getElementById('total-' + id).value) || 0;
    const nominal = document.getElementById('nominal-' + id).value;
    const notes = document.getElementById('notes-' + id).value;

    const { error } = await sb.rpc('approve_pending_invoice', {
      p_id: id,
      p_reviewed_by: reviewedBy,
      p_final_vendor: vendor,
      p_final_nominal_code: nominal,
      p_final_total: total,
      p_final_po_reference: poRef,
      p_review_notes: notes || null
    });
    if (error) { console.error(error); alert('Could not approve. Check the console.'); return; }
    await loadPending();
  }

  async function rejectRow(id) {
    const sb = await getSb();
    const { data: { session } } = await sb.auth.getSession();
    const reviewedBy = session?.user?.email || 'unknown';
    const notes = document.getElementById('notes-' + id).value;

    const { error } = await sb.rpc('reject_pending_invoice', {
      p_id: id,
      p_reviewed_by: reviewedBy,
      p_review_notes: notes || null
    });
    if (error) { console.error(error); alert('Could not reject. Check the console.'); return; }
    await loadPending();
  }

  function initWhenVisible() {
    loadPending();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhenVisible);
  else initWhenVisible();

  window.reviewRefresh = loadPending;
})();
