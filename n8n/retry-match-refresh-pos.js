// Retry PO Match (epZnToAuVLXDdUFF), 19 Nov 2026, v98: steps added between 'Get Supplier Nominal Mapping' and 'Get Purchase Orders'.
// Make PO Pages (Code) -> Refresh POs from DecoNetwork (HTTP POST manage_purchase_orders/find, same call as the 3 hourly PO sync, date1 = 30 days ago, 3 pages of 100,
//   one at a time, credential 'Deconetwork log in', continue on error) -> Prepare Refreshed POs (Code, below) -> Save Refreshed POs (upsert into purchase_orders on id, run once, continue on error).

// ---- Make PO Pages ----
return [0, 100, 200].map(offset => ({ json: { offset, limit: 100 } }));

// ---- Prepare Refreshed POs ----
// Same trimming as the 3 hourly PO sync. Always returns ONE item so Retry Match carries on even if DecoNetwork did not answer.
const byId = {};
for (const item of $input.all()) {
  const raw = item.json || {};
  let pos = [];
  if (typeof raw.data === 'string') {
    try { const parsed = JSON.parse(raw.data); if (Array.isArray(parsed.purchase_orders)) pos = parsed.purchase_orders; } catch (e) { pos = []; }
  } else if (Array.isArray(raw.purchase_orders)) {
    pos = raw.purchase_orders;
  }
  for (const po of pos) {
    if (!po.id) continue;
    const lines = (po.purchase_order_lines || []).map(line => ({ sku: line.sku, product_name: line.product_name || null, qty_ordered: line.qty_ordered ?? null, qty_received: line.qty_received ?? null, unit_price: line.unit_price ?? null, total: line.total ?? null }));
    byId[String(po.id)] = { id: po.id, po_number: po.po_number || String(po.id), vendor: po.vendor || (po.vendor_details && po.vendor_details.name) || null, vendor_id: (po.vendor_details && po.vendor_details.id) ?? null, status: po.status ?? null, status_description: po.status_description || null, date_raised: po.date_raised || null, date_delivery: po.date_delivery || null, date_received: po.date_received || null, qty_ordered: po.qty_ordered ?? null, qty_received: po.qty_received ?? null, sub_total: po.sub_total ?? null, tax: po.tax ?? null, total: po.total ?? null, lines: lines, synced_at: new Date().toISOString() };
  }
}
const payload = Object.keys(byId).map(k => byId[k]);
return [{ json: { payload, count: payload.length } }];
