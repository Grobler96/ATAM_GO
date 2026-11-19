const ornIsOrn = s => { const t = String(s || '').replace(/^[ (]+/, '').toLowerCase(); const h = t.slice(0, 3); return (h === 'orn' || h === 'ørn') && !/[a-z0-9]/.test(t.charAt(3)); };
const ornParseLines = v => {
  let x = v;
  for (let i = 0; i < 3 && typeof x === 'string'; i++) { try { x = JSON.parse(x); } catch (e) { return []; } }
  return Array.isArray(x) ? x : [];
};
function ornAdjust(p) {
  const { item, ctx, lines, allocations, addSelf, baseNotes } = p;
  const r2 = n => Math.round(n * 100) / 100;
  const fmt = n => '£' + Number(n).toFixed(2);
  const MARK = '[ORN price check';
  const stripMark = t => { const x = String(t || ''); const k = x.indexOf(MARK); return (k >= 0 ? x.slice(0, k) : x).trim(); };
  const rules = ctx.rules;
  const season = rules.map(r => String(r.season)).sort().pop();
  const listPrice = sku => {
    const s = String(sku || '').trim().toUpperCase();
    const style = s.split('.')[0];
    let best = null;
    for (const r of rules) {
      if (String(r.style).toUpperCase() !== style) continue;
      if (r.size_regex && !new RegExp(r.size_regex).test(s)) continue;
      const rank = r.size_regex ? 1 : 0;
      if (!best || String(r.season) > best.season || (String(r.season) === best.season && rank > best.rank)) best = { season: String(r.season), rank, price: Number(r.unit_price) };
    }
    return best ? best.price : null;
  };
  const skuLines = [], otherLines = [];
  // DELIVERY LINES (19 Nov 2026, v94, Steph: ORN 876991). A carriage line can carry a bracketed code (for example Two-day Carriage Charge [DCP2day]). It was
  // read as a product SKU that is not on the price list, so it stayed inside the goods figure and made the invoice look 6.95 over the PO. A line whose code is NOT on the
  // price list and which is described as delivery / carriage (or whose code starts DCP, DEL, CARR, POST, SHIP) is now treated as a non-goods line, like the
  // Minimum Order Charge line. Anything on the price list is always checked as a product.
  const delWords = /deliver|carriage|postage|courier|shipping|handling/i;
  const delCode = /^(dcp|del|carr|post|ship)/i;
  for (const l of lines) {
    const d = String(l.description || '');
    const a = d.indexOf('['), b = d.indexOf(']');
    const code = (a >= 0 && b > a) ? d.slice(a + 1, b).trim() : '';
    const isSkuCode = !!code && !/[^A-Za-z0-9.]/.test(code);
    const isDelivery = isSkuCode && listPrice(code) === null && (delWords.test(d) || delCode.test(code));
    if (isSkuCode && !isDelivery) skuLines.push({ sku: code, qty: Number(l.quantity || 0), up: Number(l.unit_price || 0), lt: Number(l.line_total || 0) });
    else otherLines.push(l);
  }
  if (skuLines.length === 0) return { skip: true, note: MARK + '] Could not read any SKU lines from this invoice, so the list price check was not done - compared with the Deco PO as before.' };
  const poNums = String(item.matched_po_number).split(',').map(s => s.trim()).filter(Boolean);
  let poSub = 0, unpriced = 0;
  const perPo = {};
  for (const n of poNums) {
    const pv = ctx.po_values[n];
    if (!pv) return { skip: true, note: MARK + '] PO ' + n + ' has no line detail to price, so the list price check was not done - compared with the Deco PO as before.' };
    perPo[n] = Number(pv.list_sub || 0);
    poSub += perPo[n];
    unpriced += Number(pv.unpriced || 0);
  }
  poSub = r2(poSub);
  const off = [], notListed = [], mathBad = [];
  for (const l of skuLines) {
    const lp = listPrice(l.sku);
    if (lp === null) notListed.push(l);
    else if (Math.abs(l.up - lp) >= 0.005) off.push(Object.assign({ lp }, l));
    if (Math.abs(l.qty * l.up - l.lt) > 0.02) mathBad.push(l);
  }
  const otherTotal = otherLines.reduce((s, l) => s + Number(l.line_total || 0), 0);
  const invNet = r2(Number(p.goods || 0) - otherTotal);
  const TOL_PCT = 0.02, TOL_ABS = 1.0;
  const diff = Math.abs(invNet - poSub);
  const within = diff <= TOL_ABS || (poSub !== 0 && diff / poSub <= TOL_PCT);
  const issues = off.length + notListed.length + mathBad.length;
  let status = (issues === 0 && within) ? 'clean_match' : 'amount_variance';
  const oldStatus = item.match_status;
  let dupNote = null;
  if (oldStatus === 'duplicate_suspected') {
    status = 'duplicate_suspected';
  } else {
    const over = [];
    for (const n of poNums) {
      const others = allocations.filter(r => String(r.matched_po_number || '').split(',').map(s => s.trim()).includes(n));
      if (others.length === 0) continue;
      const already = others.reduce((s, r) => s + Number(r.extracted_goods || 0) - Number(r.identified_delivery_charge || 0) + Number(r.extracted_vat || 0), 0);
      const poOwn = perPo[n] * 1.2;
      const total = already + (addSelf ? invNet * 1.2 : 0);
      const overBy = total - poOwn;
      if (overBy > TOL_ABS && (poOwn === 0 || overBy / poOwn > TOL_PCT)) over.push({ n, already, poOwn, total });
    }
    if (over.length) {
      status = 'duplicate_suspected';
      dupNote = over.map(o => 'PO ' + o.n + ' already has ' + fmt(o.already) + ' invoiced' + (addSelf ? ', which with this invoice would be ' + fmt(o.total) : '') + ' against a list-priced PO value of ' + fmt(o.poOwn) + ' (inc. VAT)').join('; ') + ' - check for a genuine duplicate before approving.';
    }
  }
  let seg = MARK + ' ' + season + '] ';
  if (off.length) seg += off.length + ' line(s) NOT at list price: ' + off.slice(0, 6).map(o => o.sku + ' ' + o.qty + ' x ' + fmt(o.up) + ' (list ' + fmt(o.lp) + ')').join('; ') + (off.length > 6 ? ' ...' : '') + '. ';
  if (notListed.length) seg += notListed.length + ' SKU(s) not on the price list: ' + notListed.slice(0, 6).map(o => o.sku).join(', ') + '. ';
  if (mathBad.length) seg += mathBad.length + ' line(s) where qty x price does not equal the line total: ' + mathBad.slice(0, 4).map(o => o.sku).join(', ') + '. ';
  if (!off.length && !notListed.length) seg += 'All ' + skuLines.length + (skuLines.length === 1 ? ' SKU line is' : ' SKU lines are') + ' at list price. ';
  seg += 'Invoice goods ' + fmt(invNet) + ' (ex VAT, delivery/minimum-order lines excluded) vs PO ' + poNums.join(', ') + ' at list price ' + fmt(poSub);
  if (!within) seg += ' - difference ' + fmt(diff) + ' (could be a part-delivery or a wrong PO)';
  seg += '. Deco PO showed ' + fmt(item.matched_po_sub_total) + ' and is not used for ORN.';
  if (unpriced > 0) seg += ' ' + unpriced + ' PO line(s) not on the list were counted at the Deco price.';
  const notes = [stripMark(baseNotes), dupNote, seg].filter(Boolean).join(' ');
  return { skip: false, status, poSub, poTax: r2(poSub * 0.2), perPo, notes, issues, within, invNet, diff, offCount: off.length, notListedCount: notListed.length };
}

const item = $input.first().json;
const body = $('Retry Match Webhook').first().json.body || {};
const okStatus = ['clean_match', 'amount_variance', 'duplicate_suspected'];
const bd = Array.isArray(item.matched_pos_breakdown) ? item.matched_pos_breakdown : [];
if (!item.matched_po_number || bd.length === 0 || !bd.every(b => ornIsOrn(b.vendor)) || okStatus.indexOf(item.match_status) < 0) return [{ json: item }];
let ctx = null;
try { ctx = $('Get ORN Price Context').first().json; } catch (e) { ctx = null; }
let row = {};
try { row = $('Get Invoice Row').first().json || {}; } catch (e) { row = {}; }
const base = item.duplicateNote || row.extraction_notes || '';
const out = Object.assign({}, item);
if (!ctx || !Array.isArray(ctx.rules) || !ctx.po_values) {
  out.duplicateNote = [base, '[ORN price check] The list price check was unavailable this time - compared with the Deco PO as before.'].filter(Boolean).join(' ');
  return [{ json: out }];
}
const res = ornAdjust({
  item, ctx,
  lines: ornParseLines(row.extracted_line_items),
  allocations: $('Get Existing PO Allocations').all().map(i => i.json).filter(r => String(r.id) !== String(body.id)),
  addSelf: false,
  baseNotes: base,
  goods: body.goods_total
});
if (res.skip) {
  out.duplicateNote = [base, res.note].filter(Boolean).join(' ');
  return [{ json: out }];
}
out.match_status = res.status;
out.matched_po_sub_total = res.poSub;
out.matched_po_tax = res.poTax;
out.matched_pos_breakdown = bd.map(b => {
  const ls = res.perPo[String(b.po_number)];
  const sub = (ls === undefined) ? b.sub_total : ls;
  return { po_number: b.po_number, vendor: b.vendor, sub_total: sub, tax: Math.round(Number(sub) * 20) / 100 };
});
out.duplicateNote = res.notes;
return [{ json: out }];
