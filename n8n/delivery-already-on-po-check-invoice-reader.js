// DELIVERY ALREADY ON THE PO (12 Nov 2026, Steph: Ralawise OP/I157045 for PO 876934).
// The matcher above takes the invoice's delivery/carriage out before comparing with the PO, because delivery is normally NOT on the PO.
// But some POs already carry a delivery line (876934: sub total 24.74 includes a 9.95 delivery line), so the invoice then looked 9.95 short.
// If the match came out as an amount variance only because of that, and the invoice total as it stands is within tolerance of the PO,
// it is a clean match: the delivery is recorded as 0 (so the Review tab compares plainly and does not add it twice) and the usual
// auto-approval rule (clean match + high confidence) applies. ORN invoices have their own list price check and are left alone.
const item = $input.first().json;
const ornIsOrn = s => { const t = String(s || '').replace(/^[ (]+/, '').toLowerCase(); const h = t.slice(0, 3); return (h === 'orn' || h === 'ørn') && !/[a-z0-9]/.test(t.charAt(3)); };
if (item._route !== 'pending' || item.match_status !== 'amount_variance' || !item.matched_po_number || ornIsOrn(item.matched_po_vendor)) return [{ json: item }];
const del = Number(item.identified_delivery_charge || 0);
if (!(del > 0)) return [{ json: item }];
const goods = Number(item.extracted_goods || 0), vat = Number(item.extracted_vat || 0);
const poCombined = Number(item.matched_po_sub_total || 0) + Number(item.matched_po_tax || 0);
const diff = Math.abs(goods + vat - poCombined);
const within = diff <= 1.0 || (poCombined !== 0 && diff / poCombined <= 0.02);
if (!within) return [{ json: item }];
const out = Object.assign({}, item);
out.match_status = 'clean_match';
out.identified_delivery_charge = 0;
let n = String(item.extraction_notes || '');
const tag = '(already accounted for in matching).';
const a = n.indexOf('Includes a £'), b = n.indexOf(tag);
if (a >= 0 && b > a) n = (n.slice(0, a) + n.slice(b + tag.length)).trim();
out.extraction_notes = [n, 'The £' + del.toFixed(2) + ' delivery/carriage charge on the invoice is already on the PO, so the invoice total was compared with the PO as it stands and matches.'].filter(Boolean).join(' ');
if (item.extraction_confidence === 'high' && item.status !== 'approved') {
  const norm = s => { let t = (s || '').toString().trim().toLowerCase(); if (t.charAt(0) === '(') { const k = t.indexOf(')'); if (k > 0) t = t.slice(k + 1); } return t.split(' ').filter(w => w && ['ltd', 'limited', 'uk', 'ltd.', 'limited.'].indexOf(w) < 0).join(' '); };
  let mapRows = [];
  try { mapRows = $('Get Supplier Nominal Mapping').all().map(i => i.json); } catch (e) { mapRows = []; }
  const mapping = mapRows.find(m => { const nm = norm(m.vendor), nv = norm(item.extracted_vendor); return nm === nv || nv.includes(nm) || nm.includes(nv); });
  out.status = 'approved';
  out.reviewed_by = 'system (auto: clean match, high confidence)';
  out.reviewed_at = new Date().toISOString();
  out.review_notes = 'Auto-approved: clean match against PO ' + item.matched_po_number + ' with high extraction confidence (the delivery charge is already on the PO), per Steph request of 22 Sept 2026. No human reviewed this before it was staged for posting.';
  out.final_vendor = item.extracted_vendor || null;
  out.final_po_reference = item.matched_po_number;
  out.final_nominal_code = (mapping && mapping.nominal_code) ? mapping.nominal_code : '310';
  out.final_total = item.extracted_total || null;
}
return [{ json: out }];
