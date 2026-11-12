// DELIVERY ALREADY ON THE PO (12 Nov 2026). Same rule as the invoice reader: if the match is an amount variance only because the invoice's
// delivery was taken out and the PO already carries a delivery line, compare the invoice total as it stands. ORN invoices are left alone.
const item = $input.first().json;
const body = $('Retry Match Webhook').first().json.body || {};
const ornIsOrn = s => { const t = String(s || '').replace(/^[ (]+/, '').toLowerCase(); const h = t.slice(0, 3); return (h === 'orn' || h === 'ørn') && !/[a-z0-9]/.test(t.charAt(3)); };
const del = Number(body.delivery_charges_total || 0);
const bd = Array.isArray(item.matched_pos_breakdown) ? item.matched_pos_breakdown : [];
if (item.match_status !== 'amount_variance' || !(del > 0) || !item.matched_po_number || (bd.length > 0 && bd.every(b => ornIsOrn(b.vendor)))) return [{ json: item }];
const goods = Number(body.goods_total || 0), vat = Number(body.vat_total || 0);
const poCombined = Number(item.matched_po_sub_total || 0) + Number(item.matched_po_tax || 0);
const diff = Math.abs(goods + vat - poCombined);
const within = diff <= 1.0 || (poCombined !== 0 && diff / poCombined <= 0.02);
if (!within) return [{ json: item }];
let row = {};
try { row = $('Get Invoice Row').first().json || {}; } catch (e) { row = {}; }
let n = String(item.duplicateNote || row.extraction_notes || '');
const tag = '(already accounted for in matching).';
const a = n.indexOf('Includes a £'), b = n.indexOf(tag);
if (a >= 0 && b > a) n = (n.slice(0, a) + n.slice(b + tag.length)).trim();
const out = Object.assign({}, item);
out.match_status = 'clean_match';
out.deliveryOnPo = true;
out.duplicateNote = [n, 'The £' + del.toFixed(2) + ' delivery/carriage charge on the invoice is already on the PO, so the invoice total was compared with the PO as it stands and matches.'].filter(Boolean).join(' ');
return [{ json: out }];
