// sales_invoices_view.js  (rewritten 30 Sept 2026)
// Powers the "Sales Invoices" tab as a REVIEW QUEUE, mirroring Purchase Order Review.
//
// How it fits together:
//   - WF6's stager puts every shipped order in pending_sales_invoices. Clean ones are stored
//     already 'approved' (auto); anything with a problem waits here as 'awaiting_review'.
//   - Nothing reaches Xero until a row is 'approved'. The poster then creates a DRAFT invoice
//     at 5pm (or when someone presses "Post approved now").
//   - Every change goes through SECURITY DEFINER functions (save/approve/reject/ignore/...);
//     the table itself is read-only to the browser.
//   - The old sales_invoice_log is still shown, under the "Log" tab.

(function () {
  'use strict';

  const WEBHOOK_BASE = 'https://atamcpi.app.n8n.cloud/webhook/';
  const ATAM_GO_TOKEN = '42f5d7bb154d98a8cfc5d8b7e2d83693a088e0f78b2357bf352c518ce25f07cc';
  const VAT_RATE = 0.2; // every line is posted as 20% VAT (OUTPUT2)

  const TABS = [
    { key: 'review',   label: 'Needs review',       statuses: ['awaiting_review'] },
    { key: 'hold',     label: 'On hold',            statuses: ['in_review'] },
    { key: 'approved', label: 'Approved',           statuses: ['approved'] },
    { key: 'posted',   label: 'Posted',             statuses: ['posted'] },
    { key: 'closed',   label: 'Rejected / ignored', statuses: ['rejected', 'ignored'] },
    { key: 'log',      label: 'Log',                statuses: null }
  ];

  // Plain-English explanation + fix for each reason the stager can attach.
  const REASONS = {
    no_contact: {
      chip: 'No Xero customer', cls: 'si-chip-blue',
      title: 'No Xero customer found',
      why: c => `Xero has no active customer that matches "${c}".`,
      fix: ['Search Xero below. The customer may be saved under a different name.',
            'If they are genuinely new, choose "Create account in Xero", then approve.']
    },
    ambiguous_contact: {
      chip: 'Pick customer', cls: 'si-chip-blue',
      title: 'More than one Xero customer matches',
      why: c => `Several Xero customers look like "${c}", so it was not safe to choose one automatically.`,
      fix: ['Pick the right one from the list below.',
            'Tidying the duplicate contacts in Xero stops this coming back.']
    },
    missing_po: {
      chip: 'PO missing', cls: 'si-chip-amber',
      title: 'PO number missing',
      why: c => `${c} needs its PO number on every invoice, but none was captured on the order.`,
      fix: ['Get the PO number and add it to the order in DecoNetwork. The next sync picks it up.',
            'Or type it into Reference below, then approve.']
    },
    placeholder_po: {
      chip: 'PO placeholder', cls: 'si-chip-amber',
      title: 'PO number looks like a placeholder',
      why: c => `${c} needs a real PO number, but the order only has a placeholder such as "N/A".`,
      fix: ['Get the real PO number and type it into Reference below, then approve.']
    },
    zero_total: {
      chip: '£0 total', cls: 'si-chip-amber',
      title: 'Invoice total is £0',
      why: () => 'Every line on this invoice is priced at £0.',
      fix: ['This is usually a free replacement or a sample. Choose Ignore if nothing should be billed.',
            'If it should be charged, correct the prices below, then approve.']
    },
    negative_price_line: {
      chip: 'Negative price', cls: 'si-chip-red',
      title: 'A line has a negative price',
      why: () => 'At least one line has a price below zero, which would create a credit.',
      fix: ['Check the order pricing in DecoNetwork.',
            'Correct the price below before approving.']
    },
    internal_customer: {
      chip: 'Internal order', cls: 'si-chip-purple',
      title: 'Internal order',
      why: () => 'This order is for Atam itself, so the invoice would bill our own company.',
      fix: ['Choose Ignore unless finance wants an inter-company invoice.']
    },
    no_lines: {
      chip: 'No lines', cls: 'si-chip-red',
      title: 'No billable lines',
      why: () => 'The order has nothing to invoice.',
      fix: ['Choose Ignore, or add the lines below.']
    }
  };

  const STATUS_META = {
    awaiting_review: { stamp: '!', cls: 'si-amber',  label: 'Needs review' },
    in_review:       { stamp: '⏸', cls: 'si-nomatch', label: 'On hold' },
    approved:        { stamp: '✓', cls: 'si-clean',  label: 'Approved, waiting to post' },
    posted:          { stamp: '✓', cls: 'si-clean',  label: 'Posted to Xero as draft' },
    rejected:        { stamp: '✕', cls: 'si-vendor', label: 'Rejected' },
    ignored:         { stamp: '–', cls: 'si-muted',  label: 'Ignored' }
  };

  const LOG_LABELS = {
    posted: 'Posted', skipped_no_contact: 'Skipped - no Xero contact', skipped_no_nominal_code: 'Skipped - nominal code not set',
    skipped_error: 'Skipped - error', duplicate_skipped: 'Already in Xero', deleted_in_xero: 'Deleted or voided in Xero',
    skipped_missing_po: 'Skipped - PO number missing'
  };

  let rows = [];
  let logRows = [];
  let deletedXeroIds = new Set();
  let currentTab = 'review';
  let searchText = '';
  const openIds = new Set();

  // ---------------------------------------------------------------- helpers
  const $ = id => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  function withinDays(d, days) {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= Date.now() - days * 86400000 && t <= Date.now() + 60000;
  }
  function num(n) { const x = Number(n); return isFinite(x) ? x : 0; }
  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  // Xero rounds each invoice line to 2dp, so totals here are the sum of rounded lines (not a rounded sum).
  function lineAmt(q, p) { return round2(num(q) * num(p)); }
  function rowNet(row) {
    const v = (row.final_subtotal != null) ? row.final_subtotal : row.subtotal;
    return num(v);
  }
  function rowLines(row) {
    return (Array.isArray(row.final_lines) && row.final_lines.length) ? row.final_lines : (Array.isArray(row.lines) ? row.lines : []);
  }
  function contactOf(row) {
    return {
      id: row.final_xero_contact_id || row.xero_contact_id || '',
      name: row.final_xero_contact_name || row.xero_contact_name || ''
    };
  }
  function toast(msg, kind) {
    const el = $('siToast');
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.className = 'si-toast ' + (kind === 'error' ? 'si-toast-error' : 'si-toast-ok');
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = 'none'; }, kind === 'error' ? 12000 : 6000);
  }

  async function getSb() {
    if (window._atamSb) return window._atamSb;
    const SUPABASE_URL = 'https://aobosyvlhgkxhjxkfzlz.supabase.co';
    const SUPABASE_ANON = 'sb_publishable_4Ii8Z8bGgQ5OrSKB2at_GA_GubBsWC1';
    window._atamSb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return window._atamSb;
  }

  async function callHook(path, body) {
    const res = await fetch(WEBHOOK_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atam-Go-Token': ATAM_GO_TOKEN },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data };
  }

  // ---------------------------------------------------------------- loading
  async function loadAll() {
    const container = $('salesInvoicesList');
    if (!container) return;
    const sb = await getSb();
    const [q, l] = await Promise.all([
      sb.from('pending_sales_invoices').select('*').order('created_at', { ascending: false }).limit(600),
      sb.from('sales_invoice_log').select('*').order('created_at', { ascending: false }).limit(300)
    ]);
    if (q.error) {
      console.error('[Sales Invoices] load error', q.error);
      container.innerHTML = '<div class="si-empty">Couldn\'t load the sales invoices. Check that you are signed in, then press Refresh.</div>';
      return;
    }
    rows = q.data || [];
    logRows = l.error ? [] : (l.data || []);
    deletedXeroIds = new Set(logRows.filter(r => r.status === 'deleted_in_xero' && r.xero_invoice_id).map(r => r.xero_invoice_id));
    renderAll();
  }

  // ---------------------------------------------------------------- summary + tabs
  function renderSummary() {
    const review = rows.filter(r => r.status === 'awaiting_review');
    const queued = rows.filter(r => r.status === 'approved');
    const postedToday = rows.filter(r => r.status === 'posted' && isToday(r.posted_at)).length;
    const postedWeek = rows.filter(r => r.status === 'posted' && withinDays(r.posted_at, 7));
    const valueWeek = postedWeek.reduce((s, r) => s + rowNet(r), 0);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('siNeedsReview', review.length);
    set('siNeedsReviewSub', review.length ? fmtMoney(review.reduce((s, r) => s + rowNet(r), 0)) + ' ex VAT' : 'all clear');
    set('siQueued', queued.length);
    set('siQueuedSub', queued.length ? fmtMoney(queued.reduce((s, r) => s + rowNet(r), 0)) + ' ex VAT, posts at 5pm' : 'nothing waiting');
    set('siPostedToday', postedToday);
    set('siValueWeek', fmtMoney(valueWeek));
  }

  function tabCount(tab) {
    if (tab.key === 'log') return null;
    return rows.filter(r => tab.statuses.indexOf(r.status) !== -1).length;
  }

  function renderTabs() {
    const el = $('siTabs');
    if (!el) return;
    el.innerHTML = TABS.map(t => {
      const n = tabCount(t);
      const attn = (t.key === 'review' && n > 0) ? ' si-tab-attn' : '';
      return `<button type="button" class="si-tab${t.key === currentTab ? ' active' : ''}${attn}" data-tab="${t.key}">${esc(t.label)}${n == null ? '' : ` <span class="si-tab-n">${n}</span>`}</button>`;
    }).join('');
  }

  function matchesSearch(row) {
    if (!searchText) return true;
    const hay = [row.order_id, row.invoice_number, row.customer_name, row.xero_contact_name, row.final_xero_contact_name, row.customer_po_number, row.reference]
      .join(' ').toLowerCase();
    return hay.indexOf(searchText) !== -1;
  }

  function renderAll() {
    renderSummary();
    renderTabs();
    renderList();
  }

  function renderList() {
    const container = $('salesInvoicesList');
    if (!container) return;

    if (currentTab === 'log') {
      const list = logRows.filter(r => !searchText || [r.order_id, r.customer_name, r.notes].join(' ').toLowerCase().indexOf(searchText) !== -1);
      container.innerHTML = list.length ? list.map(renderLogRow).join('') : '<div class="si-empty">Nothing in the log for this search.</div>';
      return;
    }

    const tab = TABS.find(t => t.key === currentTab);
    const list = rows.filter(r => tab.statuses.indexOf(r.status) !== -1 && matchesSearch(r));
    if (!list.length) {
      const hint = {
        review: 'Nothing needs review. New shipped orders with a problem will appear here.',
        hold: 'No invoices on hold.',
        approved: 'Nothing is waiting to post. Approved invoices go to Xero as drafts at 5pm.',
        posted: 'Nothing has been posted from the review queue yet.',
        closed: 'Nothing rejected or ignored.'
      }[currentTab] || 'Nothing here.';
      container.innerHTML = `<div class="si-empty">${hint}</div>`;
      return;
    }
    container.innerHTML = list.map(renderCard).join('');
    list.forEach(row => {
      if (openIds.has(row.id)) {
        const el = $('si-' + row.id);
        if (el) el.classList.add('open');
      }
    });
  }

  function renderLogRow(r) {
    const label = LOG_LABELS[r.status] || r.status;
    return `<div class="si-case si-log"><div class="si-case-head">
      <div class="si-stamp ${r.status === 'posted' ? 'si-clean' : 'si-muted'}">${r.status === 'posted' ? '✓' : '·'}</div>
      <div class="si-case-main">
        <div class="si-case-ref">Order ${esc(r.order_id)} · ${esc(fmtDate(r.created_at))}</div>
        <div class="si-case-title">${esc(r.customer_name || 'Unknown customer')}</div>
        <div class="si-case-sub">${esc(label)}${r.notes ? ' · ' + esc(String(r.notes).slice(0, 140)) : ''}</div>
      </div>
      <div class="si-case-meta"><span class="si-amt">${fmtMoney(r.total_amount)}</span></div>
    </div></div>`;
  }

  // ---------------------------------------------------------------- cards
  function reasonChips(row) {
    return (row.review_reasons || []).map(k => {
      const r = REASONS[k];
      return r ? `<span class="si-chip ${r.cls}">${esc(r.chip)}</span>` : `<span class="si-chip">${esc(k)}</span>`;
    }).join('');
  }

  function stampFor(row) {
    const meta = STATUS_META[row.status] || { stamp: '?', cls: 'si-nomatch', label: row.status };
    if (row.status === 'awaiting_review') {
      const r = row.review_reasons || [];
      if (r.indexOf('no_contact') !== -1 || r.indexOf('ambiguous_contact') !== -1) return { stamp: '?', cls: 'si-nomatch', label: meta.label };
      if (r.indexOf('negative_price_line') !== -1 || r.indexOf('no_lines') !== -1) return { stamp: '!', cls: 'si-vendor', label: meta.label };
    }
    if (row.status === 'approved' && row.post_error) return { stamp: '!', cls: 'si-vendor', label: 'Approved, posting failed' };
    if (row.status === 'posted' && deletedXeroIds.has(row.xero_invoice_id)) return { stamp: '✕', cls: 'si-vendor', label: 'Deleted in Xero' };
    return meta;
  }

  function renderCard(row) {
    const meta = stampFor(row);
    const contact = contactOf(row);
    const net = rowNet(row);
    let sub = esc(meta.label);
    if (row.status === 'approved') {
      sub += row.auto_approved ? ' · auto-approved (clean match)' : ' · approved by ' + esc(row.reviewed_by || '?');
    } else if (row.status === 'posted') {
      sub += ' · ' + esc(fmtDate(row.posted_at));
    } else if (row.status === 'rejected' || row.status === 'ignored') {
      sub += ' · ' + esc(row.reviewed_by || '');
    }
    const chips = (row.status === 'awaiting_review' || row.status === 'in_review') ? reasonChips(row) : '';
    const holdNote = (row.status === 'in_review' && row.snooze_note) ? `<span class="si-chip si-chip-blue">${esc(row.snooze_note)}</span>` : '';
    const invTag = (row.invoice_number && row.invoice_number !== row.order_id) ? ' · invoice ' + esc(row.invoice_number) : '';

    return `
      <div class="si-case" id="si-${esc(row.id)}" data-id="${esc(row.id)}" data-cid="${esc(contact.id)}" data-cname="${esc(contact.name)}">
        <div class="si-case-head">
          <div class="si-stamp ${meta.cls}">${meta.stamp}</div>
          <div class="si-case-main">
            <div class="si-case-ref">Order ${esc(row.order_id)}${invTag} · staged ${esc(fmtDate(row.created_at))}</div>
            <div class="si-case-title">${esc(row.customer_name || 'Unknown customer')}</div>
            <div class="si-case-sub">${sub} ${chips}${holdNote}</div>
          </div>
          <div class="si-case-meta"><span class="si-amt">${fmtMoney(net)}</span>ex VAT</div>
        </div>
        <div class="si-case-detail">${renderDetail(row)}</div>
      </div>`;
  }

  function renderDetail(row) {
    const editable = row.status === 'awaiting_review' || row.status === 'in_review';
    let html = '';

    // why it needs a person (mirrors the purchase tab's "What's wrong / How to fix")
    if (editable && (row.review_reasons || []).length) {
      html += (row.review_reasons || []).map(k => {
        const r = REASONS[k];
        if (!r) return '';
        return `<div class="si-why"><div class="si-why-title">${esc(r.title)}</div>
          <p>${esc(r.why(row.customer_name || 'This customer'))}</p>
          <ul>${r.fix.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
      }).join('');
    }
    if (row.status === 'in_review' && row.snooze_note) {
      html += `<div class="si-notes">⏸ On hold${row.snoozed_by ? ' by ' + esc(row.snoozed_by) : ''}: ${esc(row.snooze_note)}</div>`;
    }
    if (row.status === 'approved' && row.post_error) {
      html += `<div class="si-why si-why-red"><div class="si-why-title">Posting to Xero failed (${num(row.post_attempts)} of 3 attempts)</div>
        <p>${esc(row.post_error)}</p>
        <ul><li>Choose "Undo approval", fix what the message says, then approve again. That resets the attempts.</li></ul></div>`;
    }
    if (row.status === 'posted' && deletedXeroIds.has(row.xero_invoice_id)) {
      html += `<div class="si-why si-why-red"><div class="si-why-title">This invoice was deleted in Xero</div>
        <p>It is still recorded here as posted, so it will not be invoiced again on its own.</p>
        <ul><li>Choose "Put back in the queue" to bill it again. The invoiced quantities are reversed for you.</li></ul></div>`;
    }
    if ((row.status === 'rejected' || row.status === 'ignored') && row.review_notes) {
      html += `<div class="si-notes">${esc(row.review_notes)}</div>`;
    }

    // facts from DecoNetwork
    html += `<div class="si-facts">
      <div><span>Order</span><b>${esc(row.order_id)}</b></div>
      <div><span>Customer PO</span><b>${esc(row.customer_po_number || '—')}</b></div>
      <div><span>Store</span><b>${esc(row.store_name || '—')}</b></div>
      <div><span>Delivery</span><b>${esc(row.shipping_method || '—')}</b></div>
    </div>`;

    html += editable ? renderEditForm(row) : renderReadOnly(row);
    html += renderActions(row);
    return html;
  }

  function lineRowHtml(l, editable) {
    const q = num(l.qty), p = num(l.unit_price);
    if (!editable) {
      return `<div class="si-line si-line-ro"><span class="si-l-descro">${esc(l.description)}</span><span>${q}</span><span>${fmtMoney(p)}</span><span class="si-l-total">${fmtMoney(lineAmt(q, p))}</span></div>`;
    }
    return `<div class="si-line" data-kind="${esc(l.kind || 'product')}">
      <input class="si-l-desc" type="text" value="${esc(l.description)}" aria-label="Description">
      <input class="si-l-qty" type="number" step="any" min="0" value="${q}" aria-label="Quantity">
      <input class="si-l-price" type="number" step="any" value="${p}" aria-label="Unit price">
      <span class="si-l-total">${fmtMoney(lineAmt(q, p))}</span>
      <button type="button" class="si-l-del" data-action="remove-line" title="Remove this line" aria-label="Remove this line">✕</button>
    </div>`;
  }

  function totalsHtml(net) {
    const vat = round2(net * VAT_RATE);
    return `<div class="si-tot-row"><span>Net</span><b data-role="net">${fmtMoney(net)}</b></div>
      <div class="si-tot-row"><span>VAT (20%, calculated by Xero)</span><b data-role="vat">${fmtMoney(vat)}</b></div>
      <div class="si-tot-row si-tot-grand"><span>Total</span><b data-role="gross">${fmtMoney(net + vat)}</b></div>`;
  }

  function renderReadOnly(row) {
    const lines = rowLines(row);
    const contact = contactOf(row);
    const net = rowNet(row);
    const date = row.final_invoice_date || null;
    return `
      <div class="si-ro-grid">
        <div><span>Xero customer</span><b>${esc(contact.name || '—')}</b></div>
        <div><span>Reference</span><b>${esc(row.final_reference || row.reference || '—')}</b></div>
        <div><span>Invoice date</span><b>${date ? esc(date) : 'Date it is posted'}</b></div>
        <div><span>Xero invoice</span><b>${row.xero_invoice_id ? `<a class="si-link" target="_blank" rel="noopener" href="https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${esc(row.xero_invoice_id)}">Open in Xero</a>` : 'Not posted yet'}</b></div>
      </div>
      <div class="si-lines">
        <div class="si-lines-head si-line si-line-ro"><span>Description</span><span>Qty</span><span>Price</span><span>Total</span></div>
        ${lines.map(l => lineRowHtml(l, false)).join('')}
      </div>
      <div class="si-totals">${totalsHtml(net)}</div>
      ${row.review_notes && row.status !== 'rejected' && row.status !== 'ignored' ? `<div class="si-notes si-notes-muted">📝 ${esc(row.review_notes)}</div>` : ''}`;
  }

  function renderEditForm(row) {
    const lines = rowLines(row);
    const contact = contactOf(row);
    const cands = Array.isArray(row.contact_candidates) ? row.contact_candidates : [];
    const hasContact = !!contact.id;
    const ref = row.final_reference != null ? row.final_reference : (row.reference || '');
    const invDate = row.final_invoice_date || '';
    const dueDate = row.final_due_date || '';
    const net = lines.reduce((s, l) => s + lineAmt(l.qty, l.unit_price), 0);

    const optionSet = [];
    const seen = {};
    if (hasContact) { optionSet.push({ ContactID: contact.id, Name: contact.name || contact.id }); seen[contact.id] = true; }
    cands.forEach(c => { if (c && c.ContactID && !seen[c.ContactID]) { seen[c.ContactID] = true; optionSet.push(c); } });

    const options = `<option value="">Choose the Xero customer…</option>` + optionSet.map(c =>
      `<option value="${esc(c.ContactID)}" data-name="${esc(c.Name)}"${c.ContactID === contact.id ? ' selected' : ''}>${esc(c.Name)}${c.Email ? ' — ' + esc(c.Email) : ''}</option>`).join('');

    return `
      <div class="si-edit-label">Edit before approving. Nothing reaches Xero until this is approved.</div>

      <div class="si-field">
        <label>Xero customer</label>
        <div class="si-contact-current" data-role="contact-current">${hasContact ? '✅ ' + esc(contact.name || contact.id) : '⚠️ No customer chosen yet'}</div>
        <select data-role="contact-select">${options}</select>
        <div class="si-inline">
          <input type="text" data-role="contact-q" placeholder="Search Xero by name" value="${esc(row.customer_name || '')}">
          <button type="button" class="si-btn" data-action="search-contact">Search Xero</button>
        </div>
        <details class="si-create">
          <summary>Not in Xero? Create the account</summary>
          <div class="si-inline">
            <input type="text" data-role="create-name" placeholder="Customer name" value="${esc(row.customer_name || '')}">
            <input type="email" data-role="create-email" placeholder="Email (optional)">
            <button type="button" class="si-btn" data-action="create-contact">Create in Xero</button>
          </div>
          <div class="si-hint">This only creates the customer in Xero. It is safe to use even if you are unsure, because Xero refuses a duplicate name.</div>
        </details>
      </div>

      <div class="si-field-row">
        <div class="si-field"><label>Reference${row.po_required ? ' <span class="si-req">(PO number required for this customer)</span>' : ''}</label>
          <input type="text" data-role="reference" value="${esc(ref)}"></div>
        <div class="si-field"><label>Invoice date <span class="si-opt">(leave blank to use the day it is posted)</span></label>
          <input type="date" data-role="invoice-date" value="${esc(invDate)}"></div>
      </div>
      <div class="si-field-row">
        <div class="si-field"><label>Due date <span class="si-opt">(blank = 30 days after the invoice date)</span></label>
          <input type="date" data-role="due-date" value="${esc(dueDate)}"></div>
        <div class="si-field"></div>
      </div>

      <div class="si-lines" data-role="lines">
        <div class="si-lines-head si-line"><span>Description</span><span>Qty</span><span>Price</span><span>Total</span><span></span></div>
        ${lines.map(l => lineRowHtml(l, true)).join('')}
      </div>
      <button type="button" class="si-btn si-btn-add" data-action="add-line">+ Add a line</button>
      <div class="si-totals" data-role="totals">${totalsHtml(net)}</div>

      <div class="si-field">
        <label>Notes</label>
        <textarea data-role="notes" placeholder="Optional. Kept with the invoice record, and used as the reason if you reject or ignore it.">${esc(row.review_notes || '')}</textarea>
      </div>`;
  }

  function renderActions(row) {
    const b = (action, label, cls) => `<button type="button" class="si-btn ${cls || ''}" data-action="${action}">${label}</button>`;
    let inner = '';
    switch (row.status) {
      case 'awaiting_review':
        inner = b('reject', 'Reject', 'si-btn-danger') + b('ignore', 'Ignore') + b('hold', 'Hold') + b('save', 'Save changes') + b('approve', 'Approve', 'si-btn-primary');
        break;
      case 'in_review':
        inner = b('reject', 'Reject', 'si-btn-danger') + b('ignore', 'Ignore') + b('resume', 'Move back to review') + b('save', 'Save changes') + b('approve', 'Approve', 'si-btn-primary');
        break;
      case 'approved':
        inner = b('unapprove', 'Undo approval') + b('post-now', 'Post this one now', 'si-btn-primary');
        break;
      case 'posted':
        inner = deletedXeroIds.has(row.xero_invoice_id) ? b('requeue', 'Put back in the queue', 'si-btn-primary') : '';
        break;
      case 'rejected':
      case 'ignored':
        inner = b('restore', 'Restore to needs review', 'si-btn-primary');
        break;
    }
    return inner ? `<div class="si-actions">${inner}</div>` : '';
  }

  // ---------------------------------------------------------------- form reading
  function readForm(card) {
    const val = role => { const el = card.querySelector(`[data-role="${role}"]`); return el ? el.value : ''; };
    const lines = [];
    let bad = null;
    card.querySelectorAll('.si-lines .si-line[data-kind]').forEach(el => {
      const description = el.querySelector('.si-l-desc').value.trim();
      const qty = parseFloat(el.querySelector('.si-l-qty').value);
      const price = parseFloat(el.querySelector('.si-l-price').value);
      if (!description) bad = bad || 'Every line needs a description. Fill it in or remove the line.';
      else if (!isFinite(qty) || qty <= 0) bad = bad || `"${description.slice(0, 40)}" needs a quantity above zero.`;
      else if (!isFinite(price)) bad = bad || `"${description.slice(0, 40)}" needs a price.`;
      lines.push({ description: description, qty: qty, unit_price: price, kind: el.getAttribute('data-kind') || 'product' });
    });
    if (!bad && !lines.length) bad = 'The invoice needs at least one line.';
    return {
      error: bad,
      contactId: card.dataset.cid || '',
      contactName: card.dataset.cname || '',
      reference: val('reference').trim(),
      invoiceDate: val('invoice-date') || null,
      dueDate: val('due-date') || null,
      notes: val('notes').trim(),
      lines: lines,
      net: lines.reduce((s, l) => s + lineAmt(l.qty, l.unit_price), 0)
    };
  }

  function recalcCard(card) {
    let net = 0;
    card.querySelectorAll('.si-lines .si-line[data-kind]').forEach(el => {
      const q = parseFloat(el.querySelector('.si-l-qty').value) || 0;
      const p = parseFloat(el.querySelector('.si-l-price').value) || 0;
      net += lineAmt(q, p);
      el.querySelector('.si-l-total').textContent = fmtMoney(lineAmt(q, p));
    });
    const t = card.querySelector('[data-role="totals"]');
    if (t) t.innerHTML = totalsHtml(round2(net));
  }

  function setContact(card, id, name) {
    card.dataset.cid = id || '';
    card.dataset.cname = name || '';
    const cur = card.querySelector('[data-role="contact-current"]');
    if (cur) cur.textContent = id ? '✅ ' + (name || id) : '⚠️ No customer chosen yet';
    const sel = card.querySelector('[data-role="contact-select"]');
    if (sel && id) {
      let opt = Array.from(sel.options).find(o => o.value === id);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = id; opt.setAttribute('data-name', name || ''); opt.textContent = name || id;
        sel.appendChild(opt);
      }
      sel.value = id;
    }
  }

  // ---------------------------------------------------------------- actions
  function idOf(el) { const c = el.closest('.si-case'); return c ? c.getAttribute('data-id') : null; }

  async function rpc(name, args) {
    const sb = await getSb();
    const { error } = await sb.rpc(name, args);
    if (error) throw error;
  }

  function withBusy(btn, fn) {
    return async function () {
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; }
      try { await fn(); }
      catch (e) {
        console.error('[Sales Invoices]', e);
        toast((e && e.message) ? e.message : 'Something went wrong. Check the console.', 'error');
      }
      finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; } }
    };
  }

  function editArgs(card, f, id) {
    return {
      p_id: id, p_contact_id: f.contactId, p_contact_name: f.contactName, p_reference: f.reference,
      p_invoice_date: f.invoiceDate, p_due_date: f.dueDate, p_lines: f.lines, p_notes: f.notes || null
    };
  }

  async function doSave(card, id) {
    const f = readForm(card);
    if (f.error) { toast(f.error, 'error'); return; }
    await rpc('save_sales_invoice_edits', editArgs(card, f, id));
    toast('Changes saved. This invoice still needs approving.');
    await loadAll();
  }

  async function doApprove(card, id) {
    const row = rows.find(r => r.id === id) || {};
    const f = readForm(card);
    if (f.error) { toast(f.error, 'error'); return; }
    if (!f.contactId) { toast('Choose the Xero customer before approving.', 'error'); return; }
    const reasons = row.review_reasons || [];
    if (f.net <= 0 && !confirm('This invoice totals £0. Approve it anyway?')) return;
    if (reasons.indexOf('internal_customer') !== -1 && !confirm('This is an internal Atam order, so the invoice bills our own company. Approve it anyway?')) return;
    if (row.po_required && (!f.reference || f.reference === row.order_id) &&
        !confirm('This customer needs a PO number as the reference, and none is set. Approve without one?')) return;
    if (f.lines.some(l => l.unit_price < 0) && !confirm('A line has a negative price, which creates a credit. Approve anyway?')) return;
    await rpc('approve_sales_invoice', editArgs(card, f, id));
    toast('Approved. It goes to Xero as a draft at 5pm, or press "Post approved now".');
    openIds.delete(id);
    await loadAll();
  }

  async function onAction(btn) {
    const action = btn.getAttribute('data-action');
    const card = btn.closest('.si-case');
    const id = card ? card.getAttribute('data-id') : null;

    switch (action) {
      case 'add-line': {
        const wrap = card.querySelector('[data-role="lines"]');
        wrap.insertAdjacentHTML('beforeend', lineRowHtml({ description: '', qty: 1, unit_price: 0, kind: 'extra' }, true));
        const last = wrap.lastElementChild; if (last) last.querySelector('.si-l-desc').focus();
        recalcCard(card);
        return;
      }
      case 'remove-line': {
        btn.closest('.si-line').remove();
        recalcCard(card);
        return;
      }
      case 'search-contact':
        return withBusy(btn, async () => {
          const q = card.querySelector('[data-role="contact-q"]').value.trim();
          if (q.length < 3) { toast('Type at least 3 letters to search Xero.', 'error'); return; }
          const { ok, data } = await callHook('search-xero-customers', { q: q });
          if (!ok || data.ok === false) { toast((data && data.error) || 'Could not search Xero.', 'error'); return; }
          const list = data.contacts || [];
          if (!list.length) { toast(`Xero has no active customer matching "${q}". Try a shorter name, or create the account.`, 'error'); return; }
          const sel = card.querySelector('[data-role="contact-select"]');
          list.forEach(c => {
            if (!Array.from(sel.options).some(o => o.value === c.ContactID)) {
              const o = document.createElement('option');
              o.value = c.ContactID; o.setAttribute('data-name', c.Name);
              o.textContent = c.Name + (c.Email ? ' — ' + c.Email : '');
              sel.appendChild(o);
            }
          });
          toast(`Found ${list.length} in Xero. Choose the right one from the list.`);
          sel.focus();
        })();
      case 'create-contact':
        return withBusy(btn, async () => {
          const name = card.querySelector('[data-role="create-name"]').value.trim();
          const email = card.querySelector('[data-role="create-email"]').value.trim();
          if (name.length < 3) { toast('Enter the customer name first.', 'error'); return; }
          if (!confirm(`Create "${name}" as a new customer in Xero?`)) return;
          const { data } = await callHook('create-xero-customer', { name: name, email: email });
          if (!data || data.ok !== true) { toast((data && data.error) || 'Xero did not create the customer.', 'error'); return; }
          setContact(card, data.ContactID, data.Name);
          toast(`Created "${data.Name}" in Xero and selected it. Now approve the invoice.`);
        })();
      case 'save':
        return withBusy(btn, () => doSave(card, id))();
      case 'approve':
        return withBusy(btn, () => doApprove(card, id))();
      case 'reject':
        return withBusy(btn, async () => {
          if (!confirm('Reject this invoice? It will not be billed unless you restore it.')) return;
          const notes = (card.querySelector('[data-role="notes"]') || {}).value || '';
          await rpc('reject_sales_invoice', { p_id: id, p_review_notes: notes.trim() || null });
          toast('Rejected.'); await loadAll();
        })();
      case 'ignore':
        return withBusy(btn, async () => {
          if (!confirm('Ignore this order? Nothing will be invoiced for it unless you restore it.')) return;
          const notes = (card.querySelector('[data-role="notes"]') || {}).value || '';
          await rpc('ignore_sales_invoice', { p_id: id, p_review_notes: notes.trim() || null });
          toast('Ignored.'); await loadAll();
        })();
      case 'hold':
        return withBusy(btn, async () => {
          const note = prompt('Why are you holding this? (for example "waiting for the PO number")');
          if (note === null) return;
          await rpc('snooze_sales_invoice', { p_id: id, p_note: note.trim() || 'On hold' });
          toast('Moved to On hold.'); await loadAll();
        })();
      case 'resume':
        return withBusy(btn, async () => { await rpc('unsnooze_sales_invoice', { p_id: id }); toast('Moved back to Needs review.'); await loadAll(); })();
      case 'unapprove':
        return withBusy(btn, async () => { await rpc('unapprove_sales_invoice', { p_id: id }); toast('Approval undone. It is back in Needs review.'); await loadAll(); })();
      case 'restore':
        return withBusy(btn, async () => { await rpc('restore_sales_invoice', { p_id: id }); toast('Restored to Needs review.'); await loadAll(); })();
      case 'requeue':
        return withBusy(btn, async () => {
          if (!confirm('Put this invoice back in the queue so it can be billed again?')) return;
          await rpc('requeue_deleted_sales_invoice', { p_id: id });
          toast('Back in Needs review.'); await loadAll();
        })();
      case 'post-now':
        return withBusy(btn, async () => {
          const row = rows.find(r => r.id === id);
          if (!row) return;
          const { ok } = await callHook('post-approved-sales-invoices', { order_id: row.order_id });
          if (!ok) { toast('Could not start posting. Try again in a minute.', 'error'); return; }
          toast('Posting started. This page refreshes in 20 seconds.');
          setTimeout(loadAll, 20000);
        })();
    }
  }

  // ---------------------------------------------------------------- toolbar
  async function postAllApproved(btn) {
    const n = rows.filter(r => r.status === 'approved').length;
    if (!n) { toast('Nothing is approved and waiting to post.'); return; }
    if (!confirm(`Post ${n} approved invoice${n === 1 ? '' : 's'} to Xero now as drafts?`)) return;
    await withBusy(btn, async () => {
      const { ok } = await callHook('post-approved-sales-invoices', {});
      if (!ok) { toast('Could not start posting. Try again in a minute.', 'error'); return; }
      toast('Posting started. It takes about a second per invoice. This page refreshes in 30 seconds.');
      setTimeout(loadAll, 30000);
    })();
  }

  async function refreshQueue(btn) {
    await withBusy(btn, async () => {
      const { ok } = await callHook('stage-sales-invoices-now', {});
      if (!ok) { toast('Could not start the check. Try again in a minute.', 'error'); return; }
      toast('Checking for newly shipped orders. This takes a minute or two, then the page refreshes.');
      setTimeout(loadAll, 90000);
    })();
  }

  async function refreshFromXero(btn) {
    await withBusy(btn, async () => {
      const { ok, data } = await callHook('refresh-sales-invoices', {});
      if (!ok || data.success === false) throw new Error(data.error || 'Request failed');
      if (data.updatedCount > 0) {
        toast(`Updated ${data.updatedCount} invoice(s) to match Xero: ` + (data.updates || []).map(u => `${u.order_id} ${u.oldStatus} → ${u.newStatus}`).join(', '));
      } else {
        toast(data.message || 'Everything already matches Xero.');
      }
      await loadAll();
    })();
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    const container = $('salesInvoicesList');
    if (!container) return; // index.html not updated yet

    container.addEventListener('click', e => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn && container.contains(actionBtn)) { e.stopPropagation(); onAction(actionBtn); return; }
      const head = e.target.closest('.si-case-head');
      if (head && container.contains(head)) {
        const card = head.closest('.si-case');
        card.classList.toggle('open');
        const id = card.getAttribute('data-id');
        if (id) { if (card.classList.contains('open')) openIds.add(id); else openIds.delete(id); }
      }
    });
    container.addEventListener('input', e => {
      if (e.target.matches('.si-l-qty, .si-l-price')) recalcCard(e.target.closest('.si-case'));
    });
    container.addEventListener('change', e => {
      if (e.target.matches('[data-role="contact-select"]')) {
        const opt = e.target.options[e.target.selectedIndex];
        setContact(e.target.closest('.si-case'), e.target.value, opt ? (opt.getAttribute('data-name') || opt.textContent) : '');
      }
    });

    const tabs = $('siTabs');
    if (tabs) tabs.addEventListener('click', e => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      currentTab = t.getAttribute('data-tab');
      renderTabs(); renderList();
    });
    const search = $('siSearch');
    if (search) search.addEventListener('input', () => { searchText = search.value.trim().toLowerCase(); renderList(); });

    const wire = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', ev => fn(ev.currentTarget)); };
    wire('siRefreshBtn', () => loadAll());
    wire('siCheckNewBtn', refreshQueue);
    wire('siPostAllBtn', postAllApproved);
    wire('siRefreshFromXeroBtn', refreshFromXero);

    loadAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.salesInvoicesRefresh = loadAll;
})();
