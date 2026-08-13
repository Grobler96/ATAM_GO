<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ATAM GO — Discrepancies</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/SheetJS/0.18.5/xlsx.full.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');

  :root{
    --paper:#f7f5f0; --card:#fffdf9; --ink:#1c1a17; --ink-soft:#6b6459; --line:#e6e1d6;
    --seal-red:#a13d2e; --seal-red-bg:#f7e9e5;
    --seal-amber:#a8730f; --seal-amber-bg:#f9efdb;
    --seal-blue:#2e5286; --seal-blue-bg:#e7edf5;
    --seal-green:#3f6e4a; --seal-green-bg:#e7f0e8;
    --gold:#a3823b;
    --display: 'Fraunces', serif;
    --mono: 'IBM Plex Mono', monospace;
    --sans: 'Inter', -apple-system, sans-serif;
  }
  *{box-sizing:border-box;}
  body{margin:0;font-family:var(--sans);background:var(--paper);color:var(--ink);
    background-image: radial-gradient(circle at 1px 1px, rgba(0,0,0,0.028) 1px, transparent 0);
    background-size: 22px 22px;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:36px 28px 100px;}

  .tab-header{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:26px;display:flex;justify-content:space-between;align-items:flex-end;}
  .th-left .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.12em;color:var(--gold);text-transform:uppercase;margin-bottom:6px;}
  h1{font-family:var(--display);font-size:32px;font-weight:600;margin:0;letter-spacing:-0.01em;}
  .th-right{font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);text-align:right;line-height:1.6;}

  .summary-row{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);border-radius:4px;background:var(--card);margin-bottom:28px;overflow:hidden;}
  .summary-card{padding:18px 20px;border-right:1px solid var(--line);}
  .summary-card:last-child{border-right:none;}
  .summary-card .num{font-family:var(--display);font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1;}
  .summary-card.attn .num{color:var(--seal-red);}
  .summary-card .label{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft);margin-top:8px;}

  .export-bar{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px 18px;margin-bottom:22px;}
  .export-bar .eb-label{font-family:var(--mono);font-size:11.5px;font-weight:500;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.05em;margin-right:4px;}
  .export-bar select, .export-bar input[type=date]{padding:7px 10px;border:1px solid var(--line);border-radius:3px;font-size:12.5px;font-family:var(--sans);background:#fff;}
  .export-bar .spacer{flex:1;}
  .export-btn{display:flex;align-items:center;gap:6px;padding:9px 16px;border-radius:3px;font-size:12px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;text-transform:uppercase;border:1px solid var(--ink);background:#fff;cursor:pointer;color:var(--ink);}
  .export-btn.primary{background:var(--ink);color:#fff;}
  .export-btn:hover{opacity:.8;}
  .custom-range{display:none;gap:8px;align-items:center;}
  .custom-range.show{display:flex;}

  .filter-row{display:flex;gap:8px;margin-bottom:16px;}
  .chip{font-family:var(--mono);font-size:11.5px;padding:7px 14px;border-radius:3px;border:1px solid var(--line);background:var(--card);cursor:pointer;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.03em;}
  .chip.active{background:var(--ink);color:#fff;border-color:var(--ink);}

  .case{background:var(--card);border:1px solid var(--line);border-radius:5px;margin-bottom:14px;overflow:hidden;transition:box-shadow .15s;cursor:pointer;}
  .case:hover{box-shadow:0 4px 18px rgba(28,26,23,.08);}
  .case-head{display:flex;align-items:center;gap:16px;padding:16px 20px;}
  .stamp{width:44px;height:44px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:15px;font-weight:700;flex-shrink:0;}
  .stamp.vendor{border-color:var(--seal-red);color:var(--seal-red);background:var(--seal-red-bg);}
  .stamp.amount{border-color:var(--seal-amber);color:var(--seal-amber);background:var(--seal-amber-bg);}
  .stamp.nomatch{border-color:var(--seal-blue);color:var(--seal-blue);background:var(--seal-blue-bg);}
  .case-main{flex:1;}
  .case-po{font-family:var(--mono);font-size:11px;color:var(--ink-soft);letter-spacing:.03em;}
  .case-title{font-family:var(--display);font-size:18px;font-weight:600;margin-top:2px;}
  .case-sub{font-size:12.5px;color:var(--ink-soft);margin-top:3px;}
  .case-meta{text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-soft);flex-shrink:0;}
  .case-meta .amt{font-size:15px;font-weight:600;color:var(--ink);display:block;margin-bottom:3px;}
  .badge-mini{display:inline-block;font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:2px;background:#f1eefc;color:#5b3fb8;margin-top:6px;}

  .case-detail{display:none;border-top:1px solid var(--line);padding:22px 24px 24px;background:#fbfaf6;}
  .case.open .case-detail{display:block;}
  .case.open{box-shadow:0 6px 24px rgba(28,26,23,.1);}

  .why-block{background:#fff;border-left:3px solid var(--seal-red);border-radius:0 4px 4px 0;padding:14px 16px;margin-bottom:18px;}
  .why-block .wb-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--seal-red);font-weight:600;margin-bottom:5px;}
  .why-block p{margin:0;font-size:13.5px;line-height:1.55;}

  .compare{display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:stretch;margin-bottom:18px;}
  .compare-card{border:1px solid var(--line);border-radius:5px;padding:14px 16px;background:#fff;}
  .compare-card.mismatch{border-color:#e0b3a8;background:var(--seal-red-bg);}
  .compare-card .ct-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin-bottom:8px;}
  .compare-card .ct-vendor{font-family:var(--display);font-size:16px;font-weight:600;}
  .compare-card .ct-row{display:flex;justify-content:space-between;font-size:12px;margin-top:7px;color:var(--ink-soft);font-family:var(--mono);}
  .compare-card .ct-row b{color:var(--ink);}
  .compare-arrow{display:flex;align-items:center;color:var(--ink-soft);font-size:20px;}

  .fix-steps{background:#fff;border:1px dashed var(--gold);border-radius:5px;padding:16px 18px;margin-bottom:18px;}
  .fix-steps .fs-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--gold);font-weight:600;margin-bottom:10px;}
  .fix-steps ol{margin:0;padding-left:18px;}
  .fix-steps li{font-size:13px;line-height:1.6;margin-bottom:8px;}
  .fix-steps li:last-child{margin-bottom:0;}
  .fix-steps .where{display:inline-block;font-family:var(--mono);font-size:11px;background:var(--seal-blue-bg);color:var(--seal-blue);padding:1px 7px;border-radius:2px;margin-left:2px;}

  .doc-preview{border:1px solid var(--line);border-radius:5px;height:150px;display:flex;align-items:center;justify-content:center;color:var(--ink-soft);font-size:12px;background:#fff;margin-bottom:18px;font-family:var(--mono);}

  .field-block{margin-bottom:14px;}
  .field-block label{display:block;font-family:var(--mono);font-size:11px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-soft);}
  .field-block select, .field-block input, .field-block textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:3px;font-size:13px;font-family:var(--sans);background:#fff;}
  .field-block textarea{resize:vertical;min-height:56px;}

  .deco-flag{background:#f1eefc;border:1px solid #ddd4f7;border-radius:5px;padding:12px 14px;margin-bottom:16px;}
  .deco-flag label{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:#5b3fb8;margin-bottom:2px;}
  .deco-flag .df-note{font-size:11.5px;color:var(--ink-soft);margin-top:4px;line-height:1.5;}

  .action-row{display:flex;gap:8px;margin-top:20px;}
  .btn{flex:1;padding:12px;border-radius:4px;font-size:12.5px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.03em;border:1px solid var(--line);cursor:pointer;background:#fff;}
  .btn.primary{background:var(--ink);color:#fff;border-color:var(--ink);}
  .btn.danger{color:var(--seal-red);border-color:#e0b3a8;}
  .btn:hover{opacity:.82;}

  .dan-note{display:flex;gap:10px;align-items:flex-start;background:#eef4fb;border:1px solid #cfe0f2;border-radius:5px;padding:12px 14px;margin-top:18px;font-size:12px;color:#2e5286;line-height:1.5;}
  .dan-note .dot{width:8px;height:8px;border-radius:50%;background:#2e5286;margin-top:5px;flex-shrink:0;}
</style>
</head>
<body>
<div class="wrap">
  <div class="tab-header">
    <div class="th-left">
      <div class="eyebrow">ATAM GO · Invoice Reconciliation</div>
      <h1>Discrepancies</h1>
    </div>
    <div class="th-right">
      4 open cases · Last checked 08:14 today<br>
      Synced from DecoNetwork POs &amp; Hubdoc invoices
    </div>
  </div>

  <div class="summary-row">
    <div class="summary-card attn"><div class="num">4</div><div class="label">Open — needs review</div></div>
    <div class="summary-card"><div class="num">2</div><div class="label">Resolved this week</div></div>
    <div class="summary-card"><div class="num">£312.40</div><div class="label">Variance value, open</div></div>
    <div class="summary-card"><div class="num">1</div><div class="label">Awaiting DecoNetwork fix</div></div>
  </div>

  <div class="export-bar">
    <span class="eb-label">Audit trail:</span>
    <select id="periodSelect" onchange="document.getElementById('customRange').classList.toggle('show', this.value==='custom')">
      <option value="today">Today</option>
      <option value="week" selected>This week</option>
      <option value="month">This month</option>
      <option value="last30">Last 30 days</option>
      <option value="custom">Custom range…</option>
    </select>
    <div class="custom-range" id="customRange">
      <input type="date" id="fromDate"> <span style="color:var(--ink-soft);font-size:12px">to</span> <input type="date" id="toDate">
    </div>
    <div class="spacer"></div>
    <button class="export-btn" onclick="exportPDF()">↓ PDF</button>
    <button class="export-btn primary" onclick="exportXLSX()">↓ Excel</button>
  </div>

  <div class="filter-row">
    <div class="chip active">All open (4)</div>
    <div class="chip">Vendor mismatch</div>
    <div class="chip">Amount variance</div>
    <div class="chip">No PO match</div>
    <div class="chip">Resolved</div>
  </div>

  <div class="case open" onclick="if(event.target.tagName!=='SELECT'&&event.target.tagName!=='TEXTAREA'&&event.target.tagName!=='BUTTON'&&event.target.tagName!=='INPUT')this.classList.toggle('open')">
    <div class="case-head">
      <div class="stamp vendor">V</div>
      <div class="case-main">
        <div class="case-po">PO 876299 · FLAGGED TODAY 08:14</div>
        <div class="case-title">Vendor mismatch — Ralawise vs Prestige Leisure UK</div>
        <div class="case-sub">DecoNetwork lists this PO under Ralawise. The matched invoice is from Prestige Leisure UK.</div>
      </div>
      <div class="case-meta">
        <span class="amt">£72.30</span>
        £0.01 variance
        <div class="badge-mini">DecoNetwork fix pending</div>
      </div>
    </div>

    <div class="case-detail">
      <div class="why-block">
        <div class="wb-label">What's wrong</div>
        <p>The purchase order was raised in DecoNetwork against the wrong vendor. It's currently attached to Ralawise's vendor record, but the goods were actually ordered from and invoiced by Prestige Leisure UK — a completely separate supplier. The two companies have no connection to each other.</p>
      </div>

      <div class="compare">
        <div class="compare-card mismatch">
          <div class="ct-label">DecoNetwork PO</div>
          <div class="ct-vendor">Ralawise</div>
          <div class="ct-row"><span>Sub-total</span><b>£60.24</b></div>
          <div class="ct-row"><span>Tax</span><b>£12.06</b></div>
        </div>
        <div class="compare-arrow">→</div>
        <div class="compare-card">
          <div class="ct-label">Invoice (Hubdoc)</div>
          <div class="ct-vendor">Prestige Leisure UK</div>
          <div class="ct-row"><span>Goods</span><b>£60.24</b></div>
          <div class="ct-row"><span>VAT</span><b>£12.05</b></div>
        </div>
      </div>

      <div class="doc-preview">📄 Invoice SI2526832.pdf — click to preview</div>

      <div class="fix-steps">
        <div class="fs-label">How to fix this</div>
        <ol>
          <li>To make the Xero bill correct <b>right now</b>: pick the nominal code below and click <b>Approve &amp; post</b>. This posts the bill under Prestige Leisure UK regardless of what DecoNetwork shows.</li>
          <li>To stop this staying wrong at the source: open the PO in <span class="where">DecoNetwork → Business Hub → Purchase Orders</span>, find PO 876299, click <b>Edit Purchase Order</b>, and re-point the vendor to Prestige Leisure UK. Can't be done via API — needs Purchasing access, done manually.</li>
          <li>Tick the box below once that's done, so this case shows the full loop closed.</li>
        </ol>
      </div>

      <div class="field-block">
        <label>Nominal code</label>
        <select><option>311 — Workwear/Clothing COGS</option></select>
      </div>

      <div class="field-block">
        <label>Resolution notes</label>
        <textarea>Confirmed with Daniel — genuine data entry error, order was correctly placed with Prestige Leisure.</textarea>
      </div>

      <div class="deco-flag">
        <label><input type="checkbox" checked style="width:auto;"> DecoNetwork PO still needs manual correction</label>
        <div class="df-note">Daniel is on this. Untick once the vendor's been re-pointed in Business Hub — this case stays flagged until then.</div>
      </div>

      <div class="action-row">
        <button class="btn danger">Reject</button>
        <button class="btn">Correct &amp; post</button>
        <button class="btn primary">Approve &amp; post to Xero</button>
      </div>

      <div class="dan-note">
        <div class="dot"></div>
        <div>DAN knows about this case. Ask it "what's the deal with PO 876299" on the dashboard chat and it'll walk you through this exact breakdown, plus how many other open discrepancies exist and their total value.</div>
      </div>
    </div>
  </div>

  <div class="case" onclick="this.classList.toggle('open')">
    <div class="case-head">
      <div class="stamp amount">%</div>
      <div class="case-main">
        <div class="case-po">PO 876412 · FLAGGED YESTERDAY 15:02</div>
        <div class="case-title">Amount variance — Portwest</div>
        <div class="case-sub">Invoice total is £24.60 lower than the PO — 3.1%, outside the ±2%/£1 tolerance.</div>
      </div>
      <div class="case-meta">
        <span class="amt" style="color:var(--seal-red)">−£24.60</span>
        3.1% under
      </div>
    </div>
    <div class="case-detail">
      <div class="why-block">
        <div class="wb-label">What's wrong</div>
        <p>The invoiced total came in lower than the PO's sub-total + tax by more than the agreed tolerance band. Usually a discount not reflected in DecoNetwork, a partial delivery, or a pricing change since the PO was raised.</p>
      </div>
      <div class="fix-steps">
        <div class="fs-label">How to fix this</div>
        <ol>
          <li>Check the invoice PDF against the PO line items — look for a discount line or reduced quantity.</li>
          <li>If it's a genuine discount: note it below and approve at the invoiced amount.</li>
          <li>If it looks wrong: contact Portwest accounts before posting anything.</li>
        </ol>
      </div>
      <div class="field-block"><label>Resolution notes</label><textarea placeholder="What did you find?"></textarea></div>
      <div class="action-row">
        <button class="btn danger">Reject</button>
        <button class="btn">Correct &amp; post</button>
        <button class="btn primary">Approve &amp; post to Xero</button>
      </div>
    </div>
  </div>

  <div class="case" onclick="this.classList.toggle('open')">
    <div class="case-head">
      <div class="stamp nomatch">?</div>
      <div class="case-main">
        <div class="case-po">Invoice from ORN Workwear · FLAGGED YESTERDAY 11:47</div>
        <div class="case-title">No matching PO found</div>
        <div class="case-sub">An invoice arrived with no PO number the system can match against.</div>
      </div>
      <div class="case-meta">
        <span class="amt">£287.80</span>
        unmatched
      </div>
    </div>
    <div class="case-detail">
      <div class="why-block">
        <div class="wb-label">What's wrong</div>
        <p>This invoice doesn't reference a PO number that exists in DecoNetwork within the sync window, or the PO number on it doesn't match anything on file. Could be a genuine order placed without raising a formal PO.</p>
      </div>
      <div class="fix-steps">
        <div class="fs-label">How to fix this</div>
        <ol>
          <li>Check with whoever placed the order whether it was authorised.</li>
          <li>If genuine: raise a retrospective PO in <span class="where">DecoNetwork → Business Hub</span> so future reporting has a record, then re-run this match.</li>
          <li>If not authorised: reject and flag to Daniel.</li>
        </ol>
      </div>
      <div class="field-block"><label>Resolution notes</label><textarea></textarea></div>
      <div class="action-row">
        <button class="btn danger">Reject</button>
        <button class="btn">Correct &amp; post</button>
        <button class="btn primary">Approve &amp; post to Xero</button>
      </div>
    </div>
  </div>

  <div class="case" onclick="this.classList.toggle('open')">
    <div class="case-head">
      <div class="stamp amount">%</div>
      <div class="case-main">
        <div class="case-po">PO 876377 · FLAGGED MON 09:33</div>
        <div class="case-title">Amount variance — WCM &amp; A</div>
        <div class="case-sub">£8.90 under, 2.4% — just outside tolerance.</div>
      </div>
      <div class="case-meta">
        <span class="amt" style="color:var(--seal-red)">−£8.90</span>
        2.4% under
      </div>
    </div>
    <div class="case-detail">
      <div class="why-block">
        <div class="wb-label">What's wrong</div>
        <p>Small variance, likely a carriage charge rounding difference — but it's just past the ±2%/£1 tolerance line so it's been surfaced rather than auto-approved.</p>
      </div>
      <div class="field-block"><label>Resolution notes</label><textarea></textarea></div>
      <div class="action-row">
        <button class="btn danger">Reject</button>
        <button class="btn">Correct &amp; post</button>
        <button class="btn primary">Approve &amp; post to Xero</button>
      </div>
    </div>
  </div>

</div>

<script>
const auditData = [
  { po:'876299', poVendor:'Ralawise', invVendor:'Prestige Leisure UK', type:'Vendor mismatch', poAmt:72.30, invAmt:72.29, variance:-0.01, variancePct:-0.01, nominal:'311 - Workwear/Clothing COGS', resolution:'Approved & posted', resolvedBy:'daniel.spooner@atam.co.uk', resolvedAt:'2026-08-10 09:22', notes:'Confirmed genuine data-entry error. DecoNetwork PO still requires manual correction.', xeroBill:'XB-4471' },
  { po:'876412', poVendor:'Portwest', invVendor:'Portwest', type:'Amount variance', poAmt:793.40, invAmt:768.80, variance:-24.60, variancePct:-3.1, nominal:'311 - Workwear/Clothing COGS', resolution:'Corrected & posted', resolvedBy:'accounts@cpi.co.uk', resolvedAt:'2026-08-09 16:40', notes:'Supplier applied a volume discount not reflected on PO.', xeroBill:'XB-4468' },
  { po:'876390', poVendor:'—', invVendor:'ORN Workwear', type:'No PO match', poAmt:0, invAmt:287.80, variance:287.80, variancePct:null, nominal:'311 - Workwear/Clothing COGS', resolution:'Rejected', resolvedBy:'accounts@cpi.co.uk', resolvedAt:'2026-08-09 12:15', notes:'No matching PO found. Escalated to Daniel.', xeroBill:'—' },
  { po:'876377', poVendor:'WCM & A', invVendor:'WCM & A', type:'Amount variance', poAmt:371.20, invAmt:362.30, variance:-8.90, variancePct:-2.4, nominal:'311 - Workwear/Clothing COGS', resolution:'Approved & posted', resolvedBy:'daniel.spooner@atam.co.uk', resolvedAt:'2026-08-04 10:02', notes:'Within agreed tolerance band.', xeroBill:'XB-4459' }
];
function periodLabel(){
  const sel = document.getElementById('periodSelect').value;
  const map = { today:'Today', week:'This Week', month:'This Month', last30:'Last 30 Days' };
  if(sel==='custom'){ const f=document.getElementById('fromDate').value||'—', t=document.getElementById('toDate').value||'—'; return `${f} to ${t}`; }
  return map[sel];
}
function totals(){
  const totalVariance = auditData.reduce((s,r)=>s+r.variance,0);
  const approved = auditData.filter(r=>r.resolution.includes('Approved')||r.resolution.includes('Corrected')).length;
  const rejected = auditData.filter(r=>r.resolution==='Rejected').length;
  return { totalVariance, approved, rejected, count: auditData.length };
}
function exportPDF(){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const t = totals(); const pageW = doc.internal.pageSize.getWidth(); const margin = 40; let y = 50;
  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(26,29,33);
  doc.text('CPI Corporate Solutions Ltd', margin, y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(91,97,105);
  y+=16; doc.text('Trading as ATAM Workwear', margin, y); y+=26;
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(26,29,33);
  doc.text('Purchase Order / Invoice Discrepancy Audit Trail', margin, y); y+=16;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(91,97,105);
  doc.text(`Reporting period: ${periodLabel()}`, margin, y); y+=14;
  doc.text(`Report generated: ${new Date().toISOString().slice(0,16).replace('T',' ')}`, margin, y); y+=24;
  doc.setDrawColor(228,230,233); doc.line(margin,y,pageW-margin,y); y+=22;
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(26,29,33);
  doc.text('Summary', margin, y); y+=18;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(50,54,58);
  doc.text(`Total items reviewed: ${t.count}`, margin, y); y+=15;
  doc.text(`Approved / corrected & posted to Xero: ${t.approved}`, margin, y); y+=15;
  doc.text(`Rejected / escalated: ${t.rejected}`, margin, y); y+=15;
  doc.text(`Net variance value: £${t.totalVariance.toFixed(2)}`, margin, y); y+=26;
  const cols=[{header:'PO No.',w:52},{header:'PO Vendor',w:78},{header:'Invoice Vendor',w:82},{header:'Issue Type',w:72},{header:'PO £',w:46},{header:'Inv £',w:46},{header:'Var £',w:42},{header:'Resolution',w:78}];
  let x=margin;
  doc.setFillColor(251,251,252); doc.rect(margin,y,pageW-margin*2,20,'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(91,97,105);
  cols.forEach(c=>{doc.text(c.header,x+4,y+13);x+=c.w;}); y+=20;
  doc.setDrawColor(228,230,233); doc.line(margin,y,pageW-margin,y);
  doc.setFont('helvetica','normal'); doc.setFontSize(8);
  auditData.forEach(row=>{
    y+=18; if(y>760){doc.addPage();y=50;} x=margin;
    doc.setTextColor(26,29,33);
    doc.text(row.po,x+4,y); x+=cols[0].w;
    doc.text(row.poVendor,x+4,y); x+=cols[1].w;
    doc.text(row.invVendor,x+4,y); x+=cols[2].w;
    doc.text(row.type,x+4,y); x+=cols[3].w;
    doc.text(row.poAmt?row.poAmt.toFixed(2):'—',x+4,y); x+=cols[4].w;
    doc.text(row.invAmt.toFixed(2),x+4,y); x+=cols[5].w;
    doc.setTextColor(row.variance<0?192:26, row.variance<0?54:29, row.variance<0?44:33);
    doc.text((row.variance>=0?'+':'')+row.variance.toFixed(2),x+4,y); x+=cols[6].w;
    doc.setTextColor(26,29,33); doc.text(row.resolution,x+4,y);
    y+=4; doc.setFontSize(7); doc.setTextColor(120,124,130);
    doc.text(`Resolved by ${row.resolvedBy} on ${row.resolvedAt} — ${row.notes}`, margin+4, y+8, {maxWidth:pageW-margin*2-8});
    doc.setFontSize(8); y+=14;
    doc.setDrawColor(240,241,243); doc.line(margin,y,pageW-margin,y);
  });
  y+=30; if(y>740){doc.addPage();y=60;}
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(150,154,160);
  doc.text('This report was generated automatically from the ATAM GO invoice-matching audit log.', margin, y); y+=11;
  doc.text('Each item reflects a discrepancy and the resolution action taken prior to posting in Xero.', margin, y); y+=20;
  doc.setDrawColor(228,230,233); doc.line(margin,y,margin+180,y); y+=14;
  doc.text('Reviewed / signed off by: _______________________', margin, y);
  doc.save(`ATAM_Discrepancy_Audit_Trail_${periodLabel().replace(/\s/g,'_')}.pdf`);
}
function exportXLSX(){
  const t = totals();
  const summarySheet=[['CPI Corporate Solutions Ltd — Discrepancy Audit Trail'],[`Reporting period: ${periodLabel()}`],[`Generated: ${new Date().toISOString().slice(0,16).replace('T',' ')}`],[],['Total items reviewed',t.count],['Approved/corrected & posted',t.approved],['Rejected/escalated',t.rejected],['Net variance value (£)',t.totalVariance.toFixed(2)]];
  const detailHeader=['PO Number','PO Vendor','Invoice Vendor','Issue Type','PO Amount (£)','Invoice Amount (£)','Variance (£)','Variance (%)','Nominal Code','Resolution','Resolved By','Resolved At','Xero Bill Ref','Notes'];
  const detailRows=auditData.map(r=>[r.po,r.poVendor,r.invVendor,r.type,r.poAmt||'',r.invAmt,r.variance,r.variancePct===null?'':r.variancePct+'%',r.nominal,r.resolution,r.resolvedBy,r.resolvedAt,r.xeroBill,r.notes]);
  const wb=XLSX.utils.book_new();
  const wsSummary=XLSX.utils.aoa_to_sheet(summarySheet); wsSummary['!cols']=[{wch:38},{wch:20}];
  XLSX.utils.book_append_sheet(wb,wsSummary,'Summary');
  const wsDetail=XLSX.utils.aoa_to_sheet([detailHeader,...detailRows]);
  wsDetail['!cols']=[{wch:10},{wch:16},{wch:18},{wch:16},{wch:13},{wch:15},{wch:11},{wch:11},{wch:24},{wch:20},{wch:24},{wch:16},{wch:12},{wch:50}];
  XLSX.utils.book_append_sheet(wb,wsDetail,'Audit Trail Detail');
  XLSX.writeFile(wb, `ATAM_Discrepancy_Audit_Trail_${periodLabel().replace(/\s/g,'_')}.xlsx`);
}
</script>
</body>
</html>
