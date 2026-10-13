/**
 * DAN BOT v13 — a real agent for ATAM GO.
 *
 * What changed from v12
 *   - Sign-in required. The page sends the signed-in user's Supabase login token; the worker checks it with Supabase and
 *     then reads / writes the database AS THAT USER, so row-level security applies exactly as it does in the dashboard.
 *     No token = 401. (v12 had no login and read with the public key, which the 13 Oct lockdown now blocks, so it went
 *     quiet on revenue and discrepancies without saying so. Failures are now reported, never turned into "no data".)
 *   - Tools instead of a fixed snapshot. DAN decides what to look up: business_pulse, get_customer, query_table (any
 *     whitelisted table, with filters / ordering / grouping), query_stock, plus confirmed actions.
 *   - Newer model, short stateless history sent by the page, per-user rate limit.
 *   - Proactive: POST /alerts (no AI, cheap) and POST /briefing (a morning brief written by DAN).
 *
 * Endpoints (all POST, all need  Authorization: Bearer <supabase access token>)
 *   /            chat      { message, history?: [{role,content}], context? }  ->  { reply, tools }
 *   /chat        same
 *   /alerts      { }                                                          ->  { alerts: [...], pulse }
 *   /briefing    { }                                                          ->  { reply }
 *   GET /health  no login; shows the version and which secrets are set (never their values)
 *
 * Secrets / variables to set on the worker (Settings -> Variables and Secrets)
 *   ANTHROPIC_API_KEY   (secret, required)
 *   STOCK_SUPABASE_KEY  (secret, optional: the separate stock project's public key, for the stock tool)
 *   DAN_MODEL           (optional, default below)
 *   SUPABASE_URL / SUPABASE_KEY from v12 are no longer used and can be deleted.
 */

const VERSION = 'v13';
const SB_URL = 'https://aobosyvlhgkxhjxkfzlz.supabase.co';
// The public (publishable) key. It is meant to be public; the user's login token is what grants access.
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvYm9zeXZsaGdreGhqeGtmemx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MTA4NDAsImV4cCI6MjA5NjA4Njg0MH0.MwfoPHpa--9uiwCcgtzUn2nFMBcFawQAg44rmSdisyQ';
const STOCK_URL = 'https://euvmacftbcyoassrkpyq.supabase.co';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_STEPS = 8;
const MAX_ROWS = 200;
const MAX_AGG_ROWS = 6000;
const DAY = 86400000;
const TEAM = ['Daniel Spooner', 'Bethan Kaye', 'Emma Harman', 'Julie Sheehan', 'Francesca Spooner', 'Christine Ball'];

// ───────────────────────── what DAN may read ─────────────────────────
// Every table / view DAN can query, with its real columns. Anything not listed here is refused.
// `skip` = bulky columns left out unless asked for by name.
const TABLES = {
  upcoming_orders: { d: 'Open and recent DecoNetwork orders (due -30..+14 days). date_shipped null = not shipped. processes = decoration codes (WEMB embroidery, DTF/UV print).', c: 'order_id,customer_id,customer_name,store_name,order_status,date_due,date_scheduled,date_modified,date_produced,date_shipped,date_ordered,shipping_method,assigned_to,total_quantity,processes,products,is_production_complete,payment_status,outstanding_balance,customer_po_number,shipping_amount,shipping_address,dismissed_at,dismissed_reason,tax_amount,billable_amount,ship_country,synced_at', skip: 'shipping_address,products' },
  wip_orders: { d: 'Work-in-progress orders with value, used for revenue. order_value in GBP.', c: 'order_id,customer_name,store_name,order_value,garment_qty,date_due,date_shipped,date_invoiced,order_status,shipping_method,assigned_to,processes,is_production_complete,billing_month,is_billed,synced_at' },
  monthly_revenue: { d: 'Revenue per month: total pipeline, billed vs unbilled WIP, forecast.', c: 'month,month_label,total_orders,total_order_value,billed_orders,billed_value,unbilled_orders,unbilled_value,forecast_value,updated_at' },
  decoration_records: { d: 'One row per decoration completed in production (embroidery/print) with quantity, who did it and when. Large: always filter by report_date.', c: 'order_id,decoration_type,process_code,quantity,report_date,customer_id,customer_name,store_name,order_status,date_due,date_produced,date_shipped,shipping_method,product_name,view_name,area_name,processed_by,assigned_to' },
  quotes_board: { d: 'Every DecoNetwork quote. order_type 2 + approved_at null = open quote; approved_at set = converted; order_status 4 = cancelled. last_to_customer_at / last_from_customer_at = emails sent to / received from the customer.', c: 'order_id,deco_id,job_name,customer_name,contact_name,contact_email,customer_po,store_name,assigned_to,order_type,order_status,quote_value,garment_qty,processes,created_at,approved_at,modified_at,date_due,date_shipped,notes_count,last_note_at,last_to_customer_at,last_from_customer_at,to_customer_count,from_customer_count,synced_at,chase_count,last_chase_at,last_chase_by,last_chase_note' },
  customer_reorder_alerts: { d: 'Every customer with their usual reorder cycle. reorder_status: At Risk (overdue), Due Soon, Active, Not enough data, Suppressed.', c: 'customer_id,name,company,email,total_orders,first_order_date,last_order_date,mean_reorder_days,overdue_threshold_days,last_order_id,last_order_summary,last_order_value,suppress_alerts,status_override,notes,days_since_last_order,is_overdue,overdue_by_days,reorder_status,priority_score' },
  winback_board: { d: 'The Win-back pipeline: overdue customers with owner (salesperson on their last order), last logged contact, follow-up date, parked/closed state.', c: 'customer_id,name,company,email,total_orders,first_order_date,last_order_date,mean_reorder_days,overdue_threshold_days,last_order_id,last_order_summary,last_order_value,days_since_last_order,overdue_by_days,reorder_status,owner,last_contact_at,last_contact_by,last_contact_method,last_contact_outcome,last_contact_note,follow_up_on,contact_count,attributed_contact_at,attributed_contact_by,parked_until,closed_at,closed_reason' },
  winback_customer_quotes: { d: 'Quotes matched to a reorder customer (customer_id).', c: 'customer_id,match_kind,order_id,deco_id,job_name,customer_name,contact_name,contact_email,store_name,assigned_to,order_status,quote_value,garment_qty,created_at,approved_at,modified_at,last_to_customer_at,last_from_customer_at,last_chase_at' },
  winback_unmatched_quotes: { d: 'Recent quotes that could not be matched to any customer (mostly new prospects).', c: 'quote_key,customer_name,contact_name,contact_email,assigned_to,quotes,value,latest_at,latest_order_id,latest_job' },
  winback_contacts: { d: 'Log of calls / emails made to win customers back.', c: 'id,customer_id,contacted_by,method,outcome,note,follow_up_on,created_at' },
  pending_sales_invoices: { d: 'Sales invoice drafts for Xero. status: awaiting_review, approved, posted, rejected, ignored. review_reasons explains why a person must look (no_contact, discount_check, vat_check, missing_po...).', c: 'id,order_id,invoice_number,status,customer_name,customer_id,store_name,xero_contact_name,contact_status,customer_po_number,po_required,reference,invoice_date,due_date,lines,subtotal,shipping_method,review_reasons,auto_approved,final_subtotal,review_notes,reviewed_by,reviewed_at,snooze_note,xero_invoice_id,posted_at,post_attempts,post_error,created_at,updated_at', skip: 'lines' },
  sales_invoice_log: { d: 'Older log of sales invoices sent.', c: 'order_id,customer_name,xero_invoice_id,status,line_count,total_amount,notes,created_at' },
  pending_invoices: { d: 'Supplier (purchase) invoices extracted from email, with PO matching. status: approved, posted, rejected (and awaiting review when present).', c: 'id,received_at,extracted_vendor,extracted_invoice_number,extracted_invoice_date,extracted_due_date,extracted_po_number,extracted_goods,extracted_vat,extracted_total,extraction_confidence,extraction_notes,matched_po_number,matched_po_vendor,match_status,final_vendor,final_nominal_code,final_total,final_po_reference,status,reviewed_by,reviewed_at,review_notes,xero_bill_id,posted_at,created_at,snooze_note,snoozed_by' },
  invoice_discrepancies: { d: 'Purchase order vs supplier invoice mismatches (vendor mismatch, amount variance, no PO match).', c: 'id,po_number,po_vendor,invoice_ref,invoice_vendor,discrepancy_type,po_sub_total,po_tax,invoice_goods,invoice_vat,variance_amount,variance_pct,status,resolution_notes,resolved_by,resolved_at,deconetwork_correction_needed,deconetwork_corrected,deconetwork_corrected_by,created_at' },
  purchase_orders: { d: 'DecoNetwork purchase orders to suppliers.', c: 'po_number,vendor,status,status_description,date_raised,date_delivery,date_received,qty_ordered,qty_received,sub_total,tax,total,synced_at' },
  po_spend_monthly: { d: 'Monthly supplier PO spend.', c: 'month_key,po_count,total_spend,updated_at' },
  inventory_value: { d: 'Stock value per SKU (on hand and working stock tied to open orders).', c: 'sku,product_name,color,size,qty_on_hand,unit_cost,stock_value,working_stock_qty,working_stock_value,total_qty,total_value,missing_cost,is_stale,updated_at' },
  customer_spend_facts: { d: 'Xero sales lines for customer spend (net_gbp by customer / account / group / month via doc_date). Large: filter by doc_date.', c: 'doc_type,doc_number,doc_date,order_id,net_gbp,xero_contact_name,account_name,group_name,store_name,branch_label' },
  customer_accounts: { d: 'Customer accounts (grouped Xero contacts) for spend reporting.', c: 'id,account_name,group_id,is_excluded,exclude_reason,notes' }
};
for (const t of Object.values(TABLES)) { t.cols = t.c.split(','); t.skipSet = new Set((t.skip || '').split(',').filter(Boolean)); }
const OPS = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', like: 'like', ilike: 'ilike', in: 'in', is: 'is' };

// ───────────────────────── helpers ─────────────────────────
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
}
const iso = d => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysAgo = n => iso(new Date(Date.now() - n * DAY));
const daysAhead = n => iso(new Date(Date.now() + n * DAY));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const gbp = n => '£' + Math.round(num(n)).toLocaleString('en-GB');
const days = (a, b) => Math.floor((b - a) / DAY);
const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
const dayDate = v => { if (!v) return null; const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v); return isNaN(d) ? null : d; };

// ───────────────────────── auth ─────────────────────────
const tokenCache = new Map();   // token -> { user, until }
async function authenticate(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const token = m[1].trim();
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const res = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u || !u.id) return null;
  let name = u.email || 'a team member';
  try {
    const p = await fetch(`${SB_URL}/rest/v1/profiles?select=full_name&id=eq.${encodeURIComponent(u.id)}`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
    if (p.ok) { const rows = await p.json(); if (rows[0] && rows[0].full_name) name = rows[0].full_name; }
  } catch (e) { /* the email will do */ }
  const user = { id: u.id, email: u.email, name, token };
  tokenCache.set(token, { user, until: Date.now() + 60000 });
  if (tokenCache.size > 200) tokenCache.clear();
  return user;
}

const rate = new Map();   // user id -> [timestamps]
function limited(user, max = 40, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (rate.get(user.id) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { rate.set(user.id, list); return true; }
  list.push(now); rate.set(user.id, list);
  return false;
}

// ───────────────────────── database access (as the user) ─────────────────────────
async function sbGet(user, path, base = SB_URL, key = SB_ANON, token = user.token) {
  const res = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = ''; try { msg = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    return { ok: false, status: res.status, error: `Database refused the request (${res.status}). ${msg}` };
  }
  return { ok: true, data: await res.json() };
}
async function sbRpc(user, fn, args) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_ANON, Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) { let m = text; try { m = JSON.parse(text).message || text; } catch (e) { /* keep */ } return { ok: false, error: String(m).slice(0, 300) }; }
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: true, data };
}

function buildQuery(tableName, args, cat) {
  const spec = cat[tableName];
  if (!spec) throw new Error(`"${tableName}" is not a table I can read. Use list_tables to see what is available.`);
  const cols = new Set(spec.cols);
  const colOk = c => typeof c === 'string' && cols.has(c);
  let select = Array.isArray(args.select) && args.select.length ? args.select : spec.cols.filter(c => !spec.skipSet.has(c));
  for (const c of select) if (!colOk(c)) throw new Error(`"${c}" is not a column of ${tableName}. Columns: ${spec.cols.join(', ')}`);
  const parts = [`select=${select.join(',')}`];
  for (const f of (args.filters || [])) {
    if (!colOk(f.column)) throw new Error(`Cannot filter on "${f.column}": not a column of ${tableName}.`);
    const op = OPS[f.op];
    if (!op) throw new Error(`Unknown filter operator "${f.op}". Use: ${Object.keys(OPS).join(', ')}.`);
    let v = f.value;
    if (op === 'in') { if (!Array.isArray(v)) throw new Error('"in" needs a list of values.'); v = '(' + v.map(x => encodeURIComponent(String(x).replace(/,/g, ' '))).join(',') + ')'; }
    else if (op === 'is') { if (!['null', 'true', 'false'].includes(String(v))) throw new Error('"is" needs null, true or false.'); v = String(v); }
    else { v = String(v); if (op === 'like' || op === 'ilike') v = v.replace(/%/g, '*'); v = encodeURIComponent(v); }
    parts.push(`${f.column}=${op}.${v}`);
  }
  for (const o of (args.order || [])) {
    if (!colOk(o.column)) throw new Error(`Cannot order by "${o.column}".`);
    parts.push(`order=${o.column}.${o.dir === 'asc' ? 'asc' : 'desc'}.nullslast`);
  }
  return { parts, select };
}

async function queryTable(user, args) {
  const spec = TABLES[args.table];
  const { parts, select } = buildQuery(args.table, args, TABLES);
  if (args.aggregate) {
    const ag = args.aggregate;
    const groupBy = ag.group_by || [], sums = ag.sum || [];
    for (const c of [...groupBy, ...sums]) if (!spec.cols.includes(c)) throw new Error(`"${c}" is not a column of ${args.table}.`);
    const need = Array.from(new Set([...groupBy, ...sums]));
    if (!need.length && !ag.count) throw new Error('aggregate needs group_by, sum or count.');
    const q = buildQuery(args.table, { ...args, select: need.length ? need : [spec.cols[0]], order: [] }, TABLES);
    let rows = [], from = 0;
    for (;;) {
      const r = await sbGet(user, `${args.table}?${q.parts.join('&')}&limit=1000&offset=${from}`);
      if (!r.ok) return { error: r.error };
      rows = rows.concat(r.data);
      if (r.data.length < 1000 || rows.length >= MAX_AGG_ROWS) break;
      from += 1000;
    }
    const groups = new Map();
    for (const row of rows) {
      const key = groupBy.map(c => row[c] == null ? '(none)' : String(row[c]).slice(0, 80)).join(' | ');
      let g = groups.get(key);
      if (!g) { g = { _group: groupBy.length ? Object.fromEntries(groupBy.map(c => [c, row[c] == null ? null : row[c]])) : {}, count: 0 }; for (const s of sums) g['sum_' + s] = 0; groups.set(key, g); }
      g.count++;
      for (const s of sums) g['sum_' + s] += num(row[s]);
    }
    let out = Array.from(groups.values());
    for (const g of out) for (const s of sums) g['sum_' + s] = r2(g['sum_' + s]);
    const sortKey = sums.length ? 'sum_' + sums[0] : 'count';
    out.sort((a, b) => b[sortKey] - a[sortKey]);
    return { table: args.table, rows_scanned: rows.length, truncated: rows.length >= MAX_AGG_ROWS, groups: out.slice(0, 100) };
  }
  const limit = Math.max(1, Math.min(MAX_ROWS, Number(args.limit) || 50));
  const r = await sbGet(user, `${args.table}?${parts.join('&')}&limit=${limit}`);
  if (!r.ok) return { error: r.error };
  return { table: args.table, count: r.data.length, capped_at: limit, rows: r.data };
}

async function queryStock(user, env, args) {
  if (!env.STOCK_SUPABASE_KEY) return { error: 'Stock data is not connected: STOCK_SUPABASE_KEY is not set on the worker.' };
  const cat = { inventory_levels: { cols: ['product_name', 'product_code', 'sku', 'color_name', 'size_code', 'inv_lvl', 'supplier', 'inv_on_order_po', 'inv_on_order_stk', 'inv_on_order_total', 'inv_reorder_to', 'inv_warn', 'supplier_inv_lvl', 'product_deleted', 'sku_deleted'], skipSet: new Set() } };
  const a = { ...args, table: 'inventory_levels' };
  let parts;
  try { ({ parts } = buildQuery('inventory_levels', a, cat)); } catch (e) { return { error: String(e.message || e) }; }
  const limit = Math.max(1, Math.min(MAX_ROWS, Number(args.limit) || 100));
  const r = await sbGet(user, `inventory_levels?${parts.join('&')}&product_deleted=eq.false&sku_deleted=eq.false&limit=${limit}`, STOCK_URL, env.STOCK_SUPABASE_KEY, env.STOCK_SUPABASE_KEY);
  if (!r.ok) return { error: r.error };
  return { count: r.data.length, rows: r.data };
}

// ───────────────────────── business pulse (the numbers everything else builds on) ─────────────────────────
async function pulse(user) {
  const t = today(), now = new Date();
  const q = (name, path) => sbGet(user, path).then(r => ({ name, r }));
  const results = await Promise.all([
    q('orders', `upcoming_orders?select=order_id,customer_name,date_due,assigned_to,total_quantity,is_production_complete,date_shipped&date_shipped=is.null&dismissed_at=is.null&date_due=gte.${daysAgo(30)}&date_due=lte.${daysAhead(14)}&order=date_due.asc&limit=400`),
    q('revenue', 'monthly_revenue?select=month,month_label,total_order_value,billed_value,unbilled_value,forecast_value,updated_at&order=month.desc&limit=2'),
    q('quotes', `quotes_board?select=order_id,customer_name,assigned_to,quote_value,created_at,approved_at,modified_at,order_status,last_to_customer_at,last_from_customer_at,last_chase_at,job_name&created_at=gte.${daysAgo(70)}&limit=1000`),
    q('wb', 'winback_board?select=customer_id,company,name,owner,reorder_status,last_order_date,last_order_value,overdue_by_days,last_contact_at,last_contact_outcome,follow_up_on,parked_until,closed_at,attributed_contact_at&limit=1000'),
    q('wbq', `winback_customer_quotes?select=customer_id,order_id,quote_value,created_at,approved_at,modified_at,order_status,last_to_customer_at,last_from_customer_at,last_chase_at&created_at=gte.${daysAgo(70)}&limit=1000`),
    q('sales_inv', 'pending_sales_invoices?select=order_id,customer_name,subtotal,status,review_reasons&status=in.(awaiting_review,in_review)&limit=100'),
    q('disc', 'invoice_discrepancies?select=po_number,status&status=eq.open&limit=200'),
    q('buy_inv', 'pending_invoices?select=extracted_vendor,status&status=in.(awaiting_review,in_review)&limit=100'),
    q('fresh_orders', 'upcoming_orders?select=synced_at&order=synced_at.desc&limit=1'),
    q('fresh_quotes', 'quotes_board?select=synced_at&order=synced_at.desc&limit=1')
  ]);
  const by = {}, errors = [];
  for (const { name, r } of results) { if (r.ok) by[name] = r.data; else { by[name] = []; errors.push(`${name}: ${r.error}`); } }

  // orders
  const open = by.orders;
  const overdue = open.filter(o => o.date_due && o.date_due.slice(0, 10) < t);
  const dueToday = open.filter(o => o.date_due && o.date_due.slice(0, 10) === t);
  const atRisk = open.filter(o => !o.is_production_complete && o.date_due && o.date_due.slice(0, 10) >= t && o.date_due.slice(0, 10) <= daysAhead(4));
  const orders = {
    overdue: overdue.length, due_today: dueToday.length, at_risk_next_4_days: atRisk.length,
    overdue_list: overdue.slice(0, 8).map(o => ({ order: o.order_id, customer: o.customer_name, due: o.date_due.slice(0, 10), qty: o.total_quantity, assigned: o.assigned_to, production_done: !!o.is_production_complete })),
    at_risk_list: atRisk.slice(0, 8).map(o => ({ order: o.order_id, customer: o.customer_name, due: o.date_due.slice(0, 10), qty: o.total_quantity, assigned: o.assigned_to }))
  };

  // revenue
  const cur = by.revenue[0];
  const revenue = cur ? { month: cur.month_label || cur.month, pipeline: r2(num(cur.total_order_value)), billed: r2(num(cur.billed_value)), unbilled_wip: r2(num(cur.unbilled_value)), forecast: r2(num(cur.forecast_value)), billed_pct: num(cur.total_order_value) ? Math.round(num(cur.billed_value) / num(cur.total_order_value) * 100) : 0, updated: cur.updated_at ? cur.updated_at.slice(0, 10) : null } : null;

  // quotes (same rules as the Quotes tab)
  const quoteState = qu => {
    const created = toDate(qu.created_at), modified = toDate(qu.modified_at), approved = toDate(qu.approved_at);
    const lt = toDate(qu.last_to_customer_at), lf = toDate(qu.last_from_customer_at), lc = toDate(qu.last_chase_at);
    let touch = created || now; [modified, lt, lf, lc].forEach(d => { if (d && d > touch) touch = d; });
    const idle = Math.max(0, days(touch, now));
    const cancelled = Number(qu.order_status) === 4;
    const isOpen = !approved && !cancelled && idle < 30;
    const awaitingUs = isOpen && !!lf && (!lt || lf > lt) && (!lc || lf > lc);
    return { idle, isOpen, approved, awaitingUs, cancelled, value: num(qu.quote_value), created };
  };
  const qs = by.quotes.map(x => ({ x, s: quoteState(x) }));
  const openQ = qs.filter(a => a.s.isOpen);
  const needChase = openQ.filter(a => a.s.idle >= 3);
  const won7 = qs.filter(a => a.s.approved && days(a.s.approved, now) <= 7);
  const quotes = {
    open: openQ.length, open_value: r2(openQ.reduce((t2, a) => t2 + a.s.value, 0)),
    need_chasing: needChase.length, need_chasing_value: r2(needChase.reduce((t2, a) => t2 + a.s.value, 0)),
    customer_replied_waiting_on_us: openQ.filter(a => a.s.awaitingUs).length,
    converted_last_7_days: won7.length, converted_value_last_7_days: r2(won7.reduce((t2, a) => t2 + a.s.value, 0)),
    biggest_going_cold: needChase.sort((a, b) => b.s.value - a.s.value).slice(0, 5).map(a => ({ quote: a.x.order_id, customer: a.x.customer_name, value: a.s.value, quiet_days: a.s.idle, rep: a.x.assigned_to, replied: a.s.awaitingUs }))
  };

  // win-back (same stages as the Win-back tab)
  const wbQuotes = {};
  for (const x of by.wbq) { const s = quoteState(x); if (s.isOpen) (wbQuotes[x.customer_id] = wbQuotes[x.customer_id] || []).push(s); }
  const stage = { todo: [], soon: [], waiting: [], replied: [], quote: [], won: [] };
  let followUps = 0;
  for (const c of by.wb) {
    const lastOrder = dayDate(c.last_order_date), lc = toDate(c.last_contact_at), closed = toDate(c.closed_at), parked = dayDate(c.parked_until);
    const overdueCust = c.reorder_status === 'At Risk' || c.reorder_status === 'Due Soon';
    const cycle = !!(overdueCust && lc && (!lastOrder || lc >= lastOrder));
    if (closed && (!lastOrder || lastOrder <= closed)) continue;
    if (cycle && c.last_contact_outcome === 'not_interested') continue;
    if (parked && parked >= new Date(t + 'T00:00:00')) continue;
    if (c.attributed_contact_at && lastOrder && days(lastOrder, now) <= 30) { stage.won.push(c); continue; }
    if (wbQuotes[c.customer_id]) { stage.quote.push(c); continue; }
    if (cycle) {
      const fu = dayDate(c.follow_up_on);
      if (fu && fu <= new Date(t + 'T00:00:00')) followUps++;
      else if (!fu && days(lc, now) >= 7) followUps++;
      stage[c.last_contact_outcome === 'replied' || c.last_contact_outcome === 'quote_requested' ? 'replied' : 'waiting'].push(c);
    } else if (c.reorder_status === 'At Risk') stage.todo.push(c);
    else if (c.reorder_status === 'Due Soon') stage.soon.push(c);
  }
  const winback = {
    need_a_call: stage.todo.length, need_a_call_value: r2(stage.todo.reduce((t2, c) => t2 + num(c.last_order_value), 0)),
    due_soon: stage.soon.length, contacted_waiting: stage.waiting.length, replied_your_move: stage.replied.length,
    follow_ups_due: followUps, with_live_quote: stage.quote.length, won_back_last_30_days: stage.won.length,
    won_back_value_last_30_days: r2(stage.won.reduce((t2, c) => t2 + num(c.last_order_value), 0)),
    biggest_overdue: stage.todo.sort((a, b) => num(b.last_order_value) - num(a.last_order_value)).slice(0, 5).map(c => ({ customer: c.company || c.name, owner: c.owner, last_order_value: num(c.last_order_value), overdue_days: c.overdue_by_days })),
    replied_list: stage.replied.slice(0, 5).map(c => ({ customer: c.company || c.name, owner: c.owner, outcome: c.last_contact_outcome }))
  };

  // invoices
  const si = by.sales_inv;
  const invoices = {
    sales_invoices_waiting_review: si.length,
    sales_invoices_over_deco_total: si.filter(x => (x.review_reasons || []).includes('discount_check')).length,
    sales_invoice_value_waiting: r2(si.reduce((t2, x) => t2 + num(x.subtotal), 0)),
    supplier_invoices_waiting_review: by.buy_inv.length,
    open_invoice_discrepancies: by.disc.length
  };

  // freshness
  const stale = [];
  const age = (rows, label, hours) => { const s = rows[0] && toDate(rows[0].synced_at); if (!s) stale.push(`${label}: no sync time found`); else if ((now - s) / 3600000 > hours) stale.push(`${label} last synced ${Math.round((now - s) / 3600000)}h ago`); };
  age(by.fresh_orders, 'Orders', 3); age(by.fresh_quotes, 'Quotes', 9);
  if (revenue && revenue.updated && days(new Date(revenue.updated), now) > 2) stale.push(`Revenue last updated ${revenue.updated}`);

  return { as_of: new Date().toISOString(), today: t, orders, revenue, quotes, winback, invoices, stale_data: stale, problems_reading_data: errors };
}

// deterministic alerts: no AI, cheap, shown in the chat panel
function alertsFrom(p) {
  const a = [];
  const add = (id, level, icon, title, detail, ask) => a.push({ id, level, icon, title, detail, ask });
  if (p.orders.overdue) add('orders-overdue', 'urgent', '🚨', `${p.orders.overdue} order${p.orders.overdue > 1 ? 's' : ''} overdue`, p.orders.overdue_list.slice(0, 3).map(o => `#${o.order} ${o.customer}`).join(', '), 'Which orders are overdue and who has them?');
  if (p.orders.at_risk_next_4_days) add('orders-risk', 'warn', '⏰', `${p.orders.at_risk_next_4_days} order${p.orders.at_risk_next_4_days > 1 ? 's' : ''} at risk of going late`, 'Due within 4 days and production not finished', 'What is at risk of going late this week?');
  if (p.winback.replied_your_move) add('wb-replied', 'urgent', '💬', `${p.winback.replied_your_move} win-back customer${p.winback.replied_your_move > 1 ? 's' : ''} replied`, p.winback.replied_list.map(c => c.customer).slice(0, 3).join(', '), 'Which win-back customers have replied and need an answer?');
  if (p.quotes.customer_replied_waiting_on_us) add('quote-replied', 'urgent', '✉️', `${p.quotes.customer_replied_waiting_on_us} quote${p.quotes.customer_replied_waiting_on_us > 1 ? 's' : ''} with a customer reply waiting`, 'Customer wrote last and nobody has answered', 'Which quotes have a customer reply waiting?');
  if (p.winback.follow_ups_due) add('wb-followups', 'warn', '📞', `${p.winback.follow_ups_due} follow-up${p.winback.follow_ups_due > 1 ? 's' : ''} due`, 'Win-back customers to chase again', 'Which win-back follow-ups are due?');
  if (p.quotes.need_chasing) add('quotes-chase', 'warn', '🧾', `${p.quotes.need_chasing} quote${p.quotes.need_chasing > 1 ? 's' : ''} need chasing, ${gbp(p.quotes.need_chasing_value)}`, p.quotes.biggest_going_cold.slice(0, 2).map(q => `${q.customer} ${gbp(q.value)}`).join(', '), 'Which quotes need chasing, biggest first?');
  if (p.invoices.sales_invoices_over_deco_total) add('inv-over', 'warn', '🧮', `${p.invoices.sales_invoices_over_deco_total} sales invoice${p.invoices.sales_invoices_over_deco_total > 1 ? 's' : ''} above the DecoNetwork total`, 'Flagged as discount_check, needs a person to look', 'Which sales invoices are flagged as above the DecoNetwork total?');
  if (p.invoices.sales_invoices_waiting_review) add('inv-review', 'info', '🧾', `${p.invoices.sales_invoices_waiting_review} sales invoice${p.invoices.sales_invoices_waiting_review > 1 ? 's' : ''} waiting for review`, gbp(p.invoices.sales_invoice_value_waiting) + ' to bill', 'What sales invoices are waiting for review?');
  if (p.invoices.open_invoice_discrepancies) add('disc-open', 'warn', '⚖️', `${p.invoices.open_invoice_discrepancies} open invoice discrepanc${p.invoices.open_invoice_discrepancies > 1 ? 'ies' : 'y'}`, 'Supplier invoices that do not match their PO', 'What invoice discrepancies are open?');
  if (p.winback.need_a_call) add('wb-calls', 'info', '📈', `${gbp(p.winback.need_a_call_value)} of repeat business overdue`, `${p.winback.need_a_call} customers need a call`, 'Who should we call first to win back business?');
  if (p.winback.won_back_last_30_days) add('wb-won', 'good', '🎉', `${p.winback.won_back_last_30_days} customer${p.winback.won_back_last_30_days > 1 ? 's' : ''} won back this month`, gbp(p.winback.won_back_value_last_30_days), 'Who have we won back recently?');
  if (p.quotes.converted_last_7_days) add('quotes-won', 'good', '✅', `${p.quotes.converted_last_7_days} quote${p.quotes.converted_last_7_days > 1 ? 's' : ''} converted this week`, gbp(p.quotes.converted_value_last_7_days), 'Which quotes converted this week?');
  for (const s of p.stale_data) add('stale-' + s.slice(0, 12), 'warn', '🛠️', 'Data may be out of date', s, 'Is any of our data out of date?');
  if (p.problems_reading_data.length) add('read-problems', 'warn', '🔒', "I couldn't read some data", p.problems_reading_data[0].slice(0, 120), 'What data are you unable to read right now?');
  const rank = { urgent: 0, warn: 1, info: 2, good: 3 };
  return a.sort((x, y) => rank[x.level] - rank[y.level]);
}

// ───────────────────────── tools ─────────────────────────
const TOOL_DEFS = [
  { name: 'business_pulse', description: 'Live key numbers across the whole business right now: overdue / at-risk orders, revenue this month, quotes (open, need chasing, converted), the Win-back pipeline, sales and supplier invoices waiting, and whether any data is stale. Call this first for broad questions ("how are we doing", "what needs attention", briefings).', input_schema: { type: 'object', properties: {} } },
  { name: 'list_tables', description: 'List every table / view you can query with query_table, with a one-line description and the exact column names. Call this if you are unsure of a table or column name.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'query_table', description: 'Read rows from one table or view (read-only, as the signed-in user). Supports filters, ordering, a row limit (max 200) and server-side grouping with sums for analysis. Use aggregate for totals and breakdowns instead of pulling many rows. Dates are YYYY-MM-DD. For text search use op "ilike" with %term%.',
    input_schema: {
      type: 'object', properties: {
        table: { type: 'string', description: 'A table name from list_tables' },
        select: { type: 'array', items: { type: 'string' }, description: 'Columns to return (default: the main columns)' },
        filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string', enum: Object.keys(OPS) }, value: {} }, required: ['column', 'op', 'value'] } },
        order: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] } },
        limit: { type: 'number' },
        aggregate: { type: 'object', description: 'Group and total instead of returning rows', properties: { group_by: { type: 'array', items: { type: 'string' } }, sum: { type: 'array', items: { type: 'string' } }, count: { type: 'boolean' } } }
      }, required: ['table']
    }
  },
  {
    name: 'query_stock', description: 'Read live stock levels (separate stock system): units on shelf, on order from suppliers, reorder levels. Filter by product_name / sku / color_name / size_code / supplier with ilike, or inv_lvl with lt / lte etc.',
    input_schema: { type: 'object', properties: { filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string', enum: Object.keys(OPS) }, value: {} }, required: ['column', 'op', 'value'] } }, order: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] } }, limit: { type: 'number' } } }
  },
  { name: 'get_customer', description: 'Everything about one customer in one go: reorder pattern, Win-back status and contact history, and their quotes. Pass part of the company or contact name.', input_schema: { type: 'object', properties: { search: { type: 'string' } }, required: ['search'] } },
  { name: 'log_winback_contact', description: 'ACTION. Log a contact (call / email / WhatsApp / visit) against an overdue customer in the Win-back pipeline. Only call after the user has clearly asked for it AND you have read back exactly what you will log and they said yes, then set confirmed true.', input_schema: { type: 'object', properties: { customer_id: { type: 'string', description: 'customer_id from get_customer or winback_board' }, method: { type: 'string', enum: ['call', 'email', 'whatsapp', 'visit', 'other'] }, outcome: { type: 'string', enum: ['left_message', 'no_answer', 'spoke', 'ring_back', 'replied', 'quote_requested', 'ordered', 'not_interested'] }, note: { type: 'string' }, follow_up_on: { type: 'string', description: 'YYYY-MM-DD, optional' }, confirmed: { type: 'boolean' } }, required: ['customer_id', 'method', 'outcome', 'confirmed'] } },
  { name: 'set_winback_state', description: 'ACTION. Park a customer until a date, mark them lost, or reopen them. Needs the user\'s explicit yes first (confirmed true).', input_schema: { type: 'object', properties: { customer_id: { type: 'string' }, action: { type: 'string', enum: ['park', 'lost', 'reopen'] }, until: { type: 'string', description: 'YYYY-MM-DD, required for park' }, reason: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['customer_id', 'action', 'confirmed'] } },
  { name: 'reassign_order', description: 'ACTION. Give an open order to a different team member. Needs the user\'s explicit yes first (confirmed true).', input_schema: { type: 'object', properties: { order_id: { type: 'string' }, assigned_to: { type: 'string', enum: TEAM }, confirmed: { type: 'boolean' } }, required: ['order_id', 'assigned_to', 'confirmed'] } },
  { name: 'mark_deconetwork_correction_done', description: 'ACTION. Tick off that a purchase order\'s vendor has been corrected by hand in DecoNetwork. Only after the user says it has already been done (confirmed true).', input_schema: { type: 'object', properties: { po_number: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['po_number', 'confirmed'] } }
];

async function runTool(user, env, name, input) {
  try {
    if (name === 'business_pulse') return await pulse(user);
    if (name === 'list_tables') return Object.fromEntries(Object.entries(TABLES).map(([k, v]) => [k, { about: v.d, columns: v.cols }]));
    if (name === 'query_table') return await queryTable(user, input || {});
    if (name === 'query_stock') return await queryStock(user, env, input || {});
    if (name === 'get_customer') return await getCustomer(user, String((input || {}).search || ''));
    const isAction = ['log_winback_contact', 'set_winback_state', 'reassign_order', 'mark_deconetwork_correction_done'].includes(name);
    if (isAction && !(input && input.confirmed === true)) return { done: false, message: 'Not done: the user has not confirmed. Read back exactly what you will do and ask for a yes.' };
    if (name === 'log_winback_contact') {
      const r = await sbRpc(user, 'log_winback_contact', { p_customer_id: String(input.customer_id), p_method: input.method, p_outcome: input.outcome, p_note: input.note || null, p_follow_up: input.follow_up_on || null });
      return r.ok ? { done: true, message: `Logged ${input.outcome.replace(/_/g, ' ')} (${input.method}) as ${user.name}.` } : { done: false, message: r.error };
    }
    if (name === 'set_winback_state') {
      const r = await sbRpc(user, 'set_winback_state', { p_customer_id: String(input.customer_id), p_action: input.action, p_until: input.until || null, p_reason: input.reason || null });
      return r.ok ? { done: true, message: `Customer ${input.action === 'park' ? 'parked until ' + input.until : input.action === 'lost' ? 'marked lost' : 'reopened'}.` } : { done: false, message: r.error };
    }
    if (name === 'reassign_order') {
      const r = await sbRpc(user, 'dan_reassign_order', { p_order_id: String(input.order_id), p_assigned_to: input.assigned_to });
      return r.ok ? { done: true, message: r.data || `Order ${input.order_id} reassigned.` } : { done: false, message: r.error };
    }
    if (name === 'mark_deconetwork_correction_done') {
      const f = await sbGet(user, `invoice_discrepancies?select=id,po_number&po_number=eq.${encodeURIComponent(String(input.po_number))}&deconetwork_correction_needed=eq.true&deconetwork_corrected=eq.false&limit=5`);
      if (!f.ok) return { done: false, message: f.error };
      if (!f.data.length) return { done: false, message: `No discrepancy for PO ${input.po_number} is waiting on a DecoNetwork correction.` };
      for (const row of f.data) { const r = await sbRpc(user, 'mark_deconetwork_corrected', { p_id: row.id, p_corrected_by: user.name }); if (!r.ok) return { done: false, message: r.error }; }
      return { done: true, message: `PO ${input.po_number} marked as corrected in DecoNetwork (recorded by ${user.name}).` };
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function getCustomer(user, search) {
  const term = search.replace(/[^\w &.'-]/g, ' ').trim();
  if (term.length < 2) return { error: 'Give me at least two letters of the customer name.' };
  const pat = encodeURIComponent('*' + term + '*');
  const cust = await sbGet(user, `customer_reorder_alerts?select=customer_id,name,company,email,total_orders,first_order_date,last_order_date,mean_reorder_days,overdue_by_days,reorder_status,last_order_id,last_order_summary,last_order_value&or=(company.ilike.${pat},name.ilike.${pat})&order=last_order_date.desc&limit=5`);
  if (!cust.ok) return { error: cust.error };
  if (!cust.data.length) return { found: 0, message: `No customer matching "${term}".` };
  const out = [];
  for (const c of cust.data.slice(0, 3)) {
    const id = encodeURIComponent(c.customer_id);
    const [wb, contacts, quotes] = await Promise.all([
      sbGet(user, `winback_board?select=owner,last_contact_at,last_contact_by,last_contact_outcome,last_contact_note,follow_up_on,contact_count,parked_until,closed_at,closed_reason&customer_id=eq.${id}&limit=1`),
      sbGet(user, `winback_contacts?select=created_at,contacted_by,method,outcome,note,follow_up_on&customer_id=eq.${id}&order=created_at.desc&limit=8`),
      sbGet(user, `winback_customer_quotes?select=order_id,job_name,quote_value,created_at,approved_at,modified_at,order_status,assigned_to,last_from_customer_at,last_to_customer_at&customer_id=eq.${id}&order=created_at.desc&limit=10`)
    ]);
    out.push({ customer: c, winback: wb.ok ? wb.data[0] || null : { error: wb.error }, contact_history: contacts.ok ? contacts.data : { error: contacts.error }, quotes: quotes.ok ? quotes.data : { error: quotes.error } });
  }
  return { found: cust.data.length, shown: out.length, customers: out };
}

// ───────────────────────── the agent ─────────────────────────
function systemPrompt(user, ctx) {
  const t = today();
  const dow = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  return `You are DAN, the in-house business agent for ATAM Workwear, a UK workwear decoration business (embroidery and print on garments). You work inside ATAM GO, the company dashboard. You are talking to ${user.name}.

TODAY: ${t} (${dow}). Times are UK.

YOU ARE AN AGENT, NOT A REPORT. You have tools that read the live database (as the person you are talking to) and a few confirmed actions. Look things up rather than guessing. For broad questions call business_pulse first, then dig into whatever matters with query_table or get_customer. Use aggregate in query_table for totals and breakdowns. If a tool returns an error, tell the user plainly what could not be read; NEVER say there is no data when the real problem is that something could not be read. Never invent numbers, names or dates. If something is not in the data, say so.

BE PROACTIVE. Notice what matters and say it: late orders, replies waiting, quotes going cold, money overdue, anything stale. After answering, offer the sensible next step in one short line ("Want me to log that call?"). Connect the dots across areas: a customer overdue to reorder who also has a quote out, a big quote going cold, an invoice above the DecoNetwork total.

ACTIONS. You can log win-back contacts, park/lose/reopen a win-back customer, reassign an open order, and tick off a DecoNetwork correction. Only when asked. Before any action, read back exactly what you will do and wait for a clear yes in the user's next message, then call the tool with confirmed true. Never approve, reject or post invoices to Xero, send emails, or change prices; those stay with people in the dashboard. If asked for something you cannot do, say so lightly: "Sorry, I can't do that yet. Maybe ask Oli to upgrade me? :)"

HOW THE BUSINESS WORKS (so you read the data right):
- Orders live in upcoming_orders (due -30..+14 days) and wip_orders (value). date_shipped null = not shipped. is_production_complete = decoration finished. processes: WEMB = embroidery, DTF/UV = print.
- Quotes (quotes_board): open = approved_at null, not cancelled (order_status 4), touched in the last 30 days. Quiet 3-13 days = needs chasing, 14-29 = going cold, 30+ = lost. Approved = converted. A customer reply with nobody answering is the most urgent thing. Conversion rate excludes quotes approved within an hour of being raised (keyed straight in).
- Win-back pipeline (winback_board, winback_customer_quotes, winback_contacts): customers past their usual reorder time. Stages: Due soon, Needs a call, Contacted waiting, Replied (your move), Quote out, Won back. Owner = the salesperson on their last order. Won back = ordered or approved a quote within 120 days after a logged contact.
- Sales invoices (pending_sales_invoices) are drafts for Xero. review_reasons: no_contact (pick the Xero customer), discount_check (invoice is more than DecoNetwork's own total, look before posting), vat_check, missing_po, placeholder_po.
- Supplier invoices (pending_invoices) and invoice_discrepancies compare supplier invoices to DecoNetwork purchase orders.
- Revenue: monthly_revenue (pipeline, billed, unbilled WIP, forecast). Stock: query_stock (live levels) and inventory_value (cost and value).
- Team: ${TEAM.join(', ')}.
- You do NOT have labour or machine cost per job, so no profit per job. Say so rather than estimate.

HOW TO WRITE (this is read in a small chat panel and may be read aloud):
- Plain text only. No markdown, no asterisks, no tables, no headers, no emojis in the middle of sentences.
- Lead with the answer and the numbers. Short punchy sentences like a sharp colleague. 3 to 6 lines for most answers. Lists of up to about 8 items are fine, one per line with simple numbering.
- Use £ and UK dates. Round money sensibly.
- Do not mention tools, queries or how you got the data. End with at most one short follow-up line.
${ctx && ctx.dateFrom ? `\nThe dashboard is currently showing ${ctx.dateFrom} to ${ctx.dateTo} (for "this range" questions).` : ''}`;
}

async function callClaude(env, system, messages, tools) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.DAN_MODEL || DEFAULT_MODEL, max_tokens: 1600,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages, tools
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`AI error ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}

async function agent(env, user, system, messages) {
  const used = [];
  let msgs = messages.slice();
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callClaude(env, system, msgs, TOOL_DEFS);
    if (data.stop_reason === 'tool_use') {
      const blocks = data.content.filter(b => b.type === 'tool_use');
      const results = await Promise.all(blocks.map(async b => {
        used.push(b.name);
        const out = await runTool(user, env, b.name, b.input);
        let text = JSON.stringify(out);
        if (text.length > 40000) text = text.slice(0, 40000) + '…(truncated: narrow your filters or use aggregate)';
        return { type: 'tool_result', tool_use_id: b.id, content: text };
      }));
      msgs.push({ role: 'assistant', content: data.content });
      msgs.push({ role: 'user', content: results });
      continue;
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { reply: text || 'Sorry, I did not get an answer back.', tools: Array.from(new Set(used)) };
  }
  return { reply: 'That needed more digging than I could finish in one go. Try asking it in a narrower way?', tools: Array.from(new Set(used)) };
}

function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  const out = [];
  for (const m of h.slice(-12)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
    out.push({ role: m.role, content: m.content.slice(0, 4000) });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  // roles must alternate
  return out.filter((m, i) => i === 0 || m.role !== out[i - 1].role);
}

// ───────────────────────── entry ─────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/health') {
      return json({ ok: true, version: VERSION, model: env.DAN_MODEL || DEFAULT_MODEL, anthropic_key_set: !!env.ANTHROPIC_API_KEY, stock_key_set: !!env.STOCK_SUPABASE_KEY });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let user;
    try { user = await authenticate(request); } catch (e) { return json({ error: 'Could not check your login. Try again.' }, 503); }
    if (!user) return json({ error: 'Please sign in again.', reply: 'Please sign in to ATAM GO again, then ask me once more.' }, 401);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'The AI key is not set on the worker.', reply: 'My AI key is not set up yet. Ask Oli to add ANTHROPIC_API_KEY to the worker.' }, 500);

    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }

    try {
      if (path === '/alerts') {
        const p = await pulse(user);
        return json({ alerts: alertsFrom(p), pulse: p });
      }
      if (limited(user)) return json({ reply: 'Easy, I am getting a lot of questions. Give me a minute and ask again.' }, 429);

      if (path === '/briefing') {
        const p = await pulse(user);
        const hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }));
        const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
        const prompt = `Give ${user.name} their ${part} briefing. Here are the live numbers:\n${JSON.stringify(p)}\n\nWrite it like Jarvis briefing Tony Stark: short, sharp, specific. Start with "Good ${part}, ${user.name.split(' ')[0]}." Then the 3 to 5 things that matter most today, most urgent first, with names and numbers. Mention anything stale or unreadable. If a customer is both overdue to reorder and has a quote out, say so. Finish with one suggested first move. Use your tools if you need a detail the numbers do not give. 8 lines at most, plain text.`;
        const out = await agent(env, user, systemPrompt(user, null), [{ role: 'user', content: prompt }]);
        return json({ reply: out.reply, tools: out.tools });
      }

      // chat
      const message = String(body.message || body.chatInput || '').trim();
      if (!message) return json({ reply: 'No message received.' }, 400);
      const history = cleanHistory(body.history);
      const messages = [...history, { role: 'user', content: message.slice(0, 4000) }];
      const out = await agent(env, user, systemPrompt(user, body.context), messages);
      return json({ reply: out.reply, tools: out.tools });
    } catch (e) {
      console.error('DAN error', e);
      return json({ reply: 'Sorry, something went wrong on my side. Try again in a moment.', error: String((e && e.message) || e).slice(0, 200) }, 500);
    }
  }
};

