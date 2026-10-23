// newcustomers.js — "New customers" tab: a nurture pipeline for people who are new and have not been quoted yet.
//
// What it is for
//   Post a catalogue, get a login set up, find out what products they want and record it, so that whoever quotes them
//   later has a good starting point. Every step is logged and the card moves along by itself.
//
// Where the data comes from (all read through the view nc_board, which only signed-in users can open)
//   - nc_customers   the people (added from DecoNetwork first orders every night, by hand, or from a customer export file)
//   - nc_activity    everything that happens: calls, emails, catalogue posted, login created, ready to quote
//   - nc_emails      emails sent from here (same n8n workflow as the Quotes and Win-back emails, body kind = 'nc')
//   Writes go through functions only: nc_add, nc_update, nc_mark, nc_log, nc_set_state, nc_import, nc_sync_from_deco,
//   queue_nc_email (see sql/new_customers_2026-10-23.sql).
//   DecoNetwork has no customer list in its API, so someone who registered but never ordered cannot be seen automatically:
//   add them by hand or import the customer export from the Business Hub.
//
// How the stage is decided
//   Lost / Parked    closed by hand / set aside until a date
//   Quoted or ordering   a quote exists for them (matched by email or name), or they have placed 2+ orders
//   Ready to quote   someone ticked "ready to quote" (the summary is the handover)
//   Talking          they replied, or the last contact was a conversation
//   Sent             we have done something (catalogue posted, email sent, call logged) and are waiting
//   New              nobody has been in touch yet
// The email box and the customer history panel are shared with the Quotes tab (window.ATAM_QT, from quotes.js).

(function () {
  'use strict';

  const PAGE_ID = 'newcustomers';
  const DAY = 86400000;
  const REFRESH_MS = 5 * 60 * 1000;
  const FIRST_CONTACT_DAYS = 2;   // new and untouched this long = needs a first contact
  const NUDGE_DAYS = 7;           // contacted this long ago with no follow-up date = time to nudge
  const COL_CAP = 30;
  const SYNC_DAYS = 90;

  const STAGES = {
    new:     { label: 'New', icon: '🌱', color: '#22c55e', blurb: 'nobody has been in touch yet' },
    sent:    { label: 'In touch, waiting', icon: '📮', color: '#38bdf8', blurb: 'catalogue, email or call done' },
    talking: { label: 'Talking', icon: '💬', color: '#a78bfa', blurb: 'they have replied' },
    ready:   { label: 'Ready to quote', icon: '🧾', color: '#f97316', blurb: 'enough known to quote' },
    done:    { label: 'Quoted or ordering', icon: '✅', color: '#22d3ee', blurb: 'handed on' },
    parked:  { label: 'Parked', icon: '🕒', color: '#64748b', blurb: 'set aside until a date' },
    lost:    { label: 'Lost', icon: '✖', color: '#94a3b8', blurb: 'not interested' }
  };
  const BOARD = ['new', 'sent', 'talking', 'ready', 'done'];

  const INTERESTS = ['Polos', 'T-shirts', 'Sweatshirts & hoodies', 'Fleeces', 'Jackets & softshells', 'Bodywarmers & gilets', 'Hi-vis', 'Shirts', 'Trousers & shorts',
    'Aprons & tabards', 'Headwear', 'Footwear', 'PPE', 'Badges', 'Promo & merchandise', 'Office & site supplies', 'Print & paper'];
  const DECORATION = ['Embroidery', 'Print', 'Not sure yet'];
  const LOGO = [['', 'Not asked yet'], ['yes', 'Has a logo'], ['no', 'No logo yet'], ['help', 'Needs help with artwork']];
  const LOGO_LABEL = Object.fromEntries(LOGO);
  const TEAM = ['Daniel Spooner', 'Bethan Kaye', 'Francesca Spooner', 'Emma Harman', 'Julie Sheehan', 'Christine Ball'];
  const SOURCE_LABEL = { deco: 'DecoNetwork first order', manual: 'Added by hand', csv: 'Imported' };

  const METHODS = [['call', '📞 Phone call'], ['email', '✉️ Email'], ['whatsapp', '💬 WhatsApp / text'], ['visit', '🚗 Visit'], ['post', '📮 Post'], ['other', 'Other']];
  const OUTCOMES = [
    ['left_message', 'Left a message'], ['no_answer', 'No answer'], ['spoke', 'Spoke to them'], ['ring_back', 'Asked us to ring back'],
    ['replied', 'They replied'], ['quote_requested', 'Asked for a quote'], ['not_interested', 'Not interested'], ['note', 'Just a note']
  ];
  const OUTCOME_LABEL = Object.assign(Object.fromEntries(OUTCOMES), { catalogue_posted: 'Catalogue posted', login_created: 'Login created', ready_to_quote: 'Marked ready to quote' });
  const METHOD_LABEL = Object.fromEntries(METHODS.map(m => [m[0], m[1].replace(/^\S+\s/, '')]));
  const FOLLOW_UP = { left_message: 3, no_answer: 3, spoke: 7, ring_back: 3, replied: 2, quote_requested: 2 };

  const TABS = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'interests', label: 'What they want' },
    { key: 'all', label: 'All customers' },
    { key: 'parked', label: 'Parked & lost' }
  ];

  const state = {
    rows: [], loaded: false, loading: false, error: null, tab: 'pipeline', owner: '', q: '', source: '', interest: '',
    sort: { tab: '', key: 'firstSeen', dir: -1 }, expanded: {}, timer: null, openId: null, animate: true, updatedAt: null, dirty: false
  };

  const PREF_KEY = 'atamgo_newcustomers_prefs_v1';
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (TABS.some(t => t.key === p.tab)) state.tab = p.tab;
    if (typeof p.owner === 'string') state.owner = p.owner;
  } catch (e) { /* storage unavailable: defaults are fine */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: state.tab, owner: state.owner })); } catch (e) { /* ignore */ } };

  // ───────────────────────── helpers ─────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const gbp = v => '£' + num(v).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const fmtDate = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtShort = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
  const fmtDateTime = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
  const days = (a, b) => Math.floor((b - a) / DAY);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ago = d => d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  const ownerName = r => r || 'Unassigned';
  const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const avatar = n => `<span class="nc-av" style="background:hsl(${hue(n)} 55% 38%)" title="${esc(ownerName(n))}">${esc(initials(n))}</span>`;
  const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
  const dayDate = v => { if (!v) return null; const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : v); return isNaN(d) ? null : d; };
  const isoDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDays = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  const key = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }
  const mailOn = () => !!(window.ATAM_QT && window.ATAM_QT.emailEnabled());

  // ───────────────────────── data ─────────────────────────
  async function fetchAll() {
    const PAGE = 1000;
    let all = [], from = 0;
    for (;;) {
      const res = await client().from('nc_board').select('*').order('id').range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      all = all.concat(res.data || []);
      if (!res.data || res.data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  function enrich(r, now) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const firstSeen = dayDate(r.first_seen), created = toDate(r.created_at);
    const label = r.company || r.contact_name || 'Unknown customer';
    const contactName = r.company && r.contact_name && key(r.contact_name) !== key(r.company) ? r.contact_name : '';
    const lastAct = toDate(r.last_activity_at), followUp = dayDate(r.follow_up_on);
    const outcome = r.last_activity_outcome || '';
    const emailSentAt = toDate(r.email_sent_at), emailRepliedAt = toDate(r.email_replied_at), emailDueAt = toDate(r.email_due_at);
    const parkedUntil = dayDate(r.parked_until), closedAt = toDate(r.closed_at);
    const catalogueAt = toDate(r.catalogue_posted_at), loginAt = toDate(r.login_created_at), readyAt = toDate(r.ready_at);
    const quoted = num(r.quote_count) > 0, regular = num(r.deco_total_orders) >= 2;
    const interests = Array.isArray(r.interests) ? r.interests : [], decoration = Array.isArray(r.decoration) ? r.decoration : [];

    const talking = !!emailRepliedAt || ['replied', 'spoke', 'quote_requested', 'ring_back'].includes(outcome);
    let stage = 'new';
    if (closedAt) stage = 'lost';
    else if (parkedUntil && parkedUntil >= today) stage = 'parked';
    else if (quoted || regular) stage = 'done';
    else if (readyAt) stage = 'ready';
    else if (talking) stage = 'talking';
    else if (num(r.activity_count) > 0 || catalogueAt || emailSentAt) stage = 'sent';

    const sinceSeen = firstSeen ? Math.max(0, days(firstSeen, now)) : 0;
    const actDays = lastAct ? Math.max(0, days(lastAct, now)) : null;
    const needsFirst = stage === 'new' && sinceSeen >= FIRST_CONTACT_DAYS;
    const followUpDue = (stage === 'sent' || stage === 'talking') && (followUp ? followUp <= today : (stage === 'sent' && actDays != null && actDays >= NUDGE_DAYS));
    const emailCycle = !!emailSentAt;
    const emailDue = emailCycle && !emailRepliedAt && !!emailDueAt && now >= emailDueAt && (stage === 'new' || stage === 'sent');

    return {
      id: String(r.id), label, contactName, person: r.contact_name || '', company: r.company || '', email: r.email || '', phone: r.phone || '', owner: r.owner || '',
      source: r.source, decoId: r.deco_customer_id || '', firstSeen, created, interests, decoration, estQty: r.est_qty || '', hasLogo: r.has_logo || '',
      staffCount: r.staff_count || '', timing: r.timing || '', decisionMaker: r.decision_maker || '', budget: r.budget || '', notes: r.notes || '',
      catalogueAt, catalogueBy: r.catalogue_posted_by || '', loginAt, loginBy: r.login_created_by || '', readyAt, readyBy: r.ready_by || '',
      parkedUntil, closedAt, closedReason: r.closed_reason || '',
      firstOrderId: r.first_order_id || '', firstOrderValue: num(r.first_order_value), firstOrderSummary: r.first_order_summary || '',
      activityCount: num(r.activity_count), lastAct, lastActBy: r.last_activity_by || '', outcome, lastActNote: r.last_activity_note || '', followUp,
      emailNo: num(r.email_no), emailSentAt, emailDueAt, emailRepliedAt, emailSender: r.email_sender || '', emailCycle, emailDue,
      decoOrders: num(r.deco_total_orders), decoLastOrder: dayDate(r.deco_last_order_date),
      quoteCount: num(r.quote_count), lastQuoteAt: toDate(r.last_quote_at), lastQuoteValue: num(r.last_quote_value), lastQuoteId: r.last_quote_id || '', quoteApproved: toDate(r.last_quote_approved_at),
      stage, sinceSeen, actDays, needsFirst, followUpDue
    };
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) { state.error = null; renderBody(); }
    try {
      const now = new Date();
      state.rows = (await fetchAll()).map(r => enrich(r, now));
      state.loaded = true; state.error = null; state.updatedAt = new Date();
      if (state.owner && !state.rows.some(r => (r.owner || '__none') === state.owner)) state.owner = '';
    } catch (e) {
      console.error('new customers load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load the new customers list';
    } finally {
      state.loading = false;
    }
    renderAll();
  }

  // ───────────────────────── filtering & stats ─────────────────────────
  function matches(r) {
    if (state.owner && (r.owner || '__none') !== state.owner) return false;
    if (state.source && r.source !== state.source) return false;
    if (state.interest && !r.interests.includes(state.interest)) return false;
    if (state.q) {
      const hay = [r.label, r.contactName, r.email, r.phone, r.owner, r.notes].concat(r.interests).join(' ').toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  }
  const visible = () => state.rows.filter(matches);

  function stats(rows) {
    const by = k => rows.filter(r => r.stage === k);
    const active = rows.filter(r => !['parked', 'lost', 'done'].includes(r.stage));
    return {
      nw: by('new'), sent: by('sent'), talking: by('talking'), ready: by('ready'), done: by('done'), active,
      needsFirst: by('new').filter(r => r.needsFirst), due: rows.filter(r => r.followUpDue || r.emailDue),
      withInterests: active.filter(r => r.interests.length).length
    };
  }

  function countUp(el) {
    if (!state.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.querySelectorAll('[data-to]').forEach(n => {
      const to = Number(n.dataset.to), t0 = performance.now();
      const tick = t => { const p = Math.min(1, (t - t0) / 600); n.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  // ───────────────────────── rendering ─────────────────────────
  function renderAll() {
    renderHead(); renderKpis(); renderControls(); renderBody(); updateNavBadge();
    const u = $('ncUpdated');
    if (u && state.updatedAt) u.textContent = 'Updated ' + state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    state.animate = false;
    if (state.openId && !state.dirty) refreshDrawer();
  }

  function updateNavBadge() {
    const btn = document.querySelector('.nav-link[data-page="' + PAGE_ID + '"]');
    if (!btn) return;
    const n = state.rows.filter(r => r.needsFirst || r.followUpDue || r.emailDue || (r.stage === 'talking' && r.emailRepliedAt && (!r.lastAct || r.emailRepliedAt >= r.lastAct))).length;
    let b = btn.querySelector('.nc-nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'nc-nav-badge'; btn.appendChild(b); }
    b.textContent = n;
    b.title = n + ' new customers need your attention';
  }

  function renderHead() {
    const el = $('ncValue'); if (!el || !state.loaded) return;
    const s = stats(state.rows);
    el.innerHTML = `<b>${plural(s.active.length, 'new customer')}</b> being looked after` +
      (s.needsFirst.length ? ` · <b>${s.needsFirst.length}</b> waiting ${FIRST_CONTACT_DAYS}+ days for a first contact` : '') +
      (s.withInterests ? ` · products recorded for ${s.withInterests} of ${s.active.length}` : '');
  }

  function renderKpis() {
    const el = $('ncKpis'); if (!el) return;
    const rows = visible(), s = stats(rows);
    const pct = s.active.length ? Math.round(s.withInterests / s.active.length * 100) : null;
    const tiles = [
      { n: s.nw.length, label: 'New, not contacted', sub: s.needsFirst.length ? plural(s.needsFirst.length, 'customer') + ' waiting ' + FIRST_CONTACT_DAYS + '+ days' : 'nobody left waiting', cls: s.needsFirst.length ? 'nc-kpi-attn' : '' },
      { n: s.sent.length, label: 'In touch, waiting', sub: s.due.length ? plural(s.due.length, 'customer') + ' due a follow-up' : 'nobody due a follow-up' },
      { n: s.talking.length, label: 'Talking', sub: s.talking.length ? 'they have replied' : 'nobody replied yet' },
      { n: s.ready.length, label: 'Ready to quote', sub: s.ready.length ? 'waiting for a quote' : 'none yet', cls: s.ready.length ? 'nc-kpi-good' : '' },
      { txt: pct == null ? '—' : pct + '%', label: 'Products recorded', sub: s.active.length ? s.withInterests + ' of ' + s.active.length + ' customers' : 'nobody yet' },
      { n: s.done.length, label: 'Quoted or ordering', sub: 'since they were added', cls: 'nc-kpi-good' }
    ];
    el.innerHTML = tiles.map((t, i) => `<div class="nc-kpi ${t.cls || ''}" style="--i:${i}">
      <div class="nc-kpi-n"${t.n != null ? ` data-to="${t.n}"` : ''}>${t.n != null ? t.n : esc(t.txt)}</div>
      <div class="nc-kpi-l">${esc(t.label)}</div><div class="nc-kpi-s">${esc(t.sub)}</div></div>`).join('');
    countUp(el);
  }

  function renderControls() {
    savePrefs();
    const owners = Array.from(new Set(state.rows.map(r => r.owner || '__none'))).sort((a, b) => ownerName(a === '__none' ? '' : a).localeCompare(ownerName(b === '__none' ? '' : b)));
    const sel = $('ncOwner');
    if (sel) sel.innerHTML = '<option value="">Everyone</option>' + owners.map(r => `<option value="${esc(r)}"${r === state.owner ? ' selected' : ''}>${esc(r === '__none' ? 'Unassigned' : r)}</option>`).join('');
    const src = $('ncSource');
    if (src) src.innerHTML = '<option value="">All sources</option>' + Object.keys(SOURCE_LABEL).map(k => `<option value="${k}"${k === state.source ? ' selected' : ''}>${esc(SOURCE_LABEL[k])}</option>`).join('');
    const tabs = $('ncTabs');
    if (tabs) {
      const rows = visible();
      const count = k => k === 'pipeline' ? rows.filter(r => BOARD.includes(r.stage)).length : k === 'parked' ? rows.filter(r => r.stage === 'parked' || r.stage === 'lost').length : k === 'all' ? rows.length : null;
      tabs.innerHTML = TABS.map(t => `<button type="button" role="tab" data-tab="${t.key}" class="nc-tab${t.key === state.tab ? ' active' : ''}">${esc(t.label)}${count(t.key) != null ? `<span class="nc-tab-n">${count(t.key)}</span>` : ''}</button>`).join('');
    }
    const flt = $('ncFilterNote');
    if (flt) flt.innerHTML = state.interest ? `Showing only customers interested in <b>${esc(state.interest)}</b> <button type="button" class="nc-btn" data-clear-interest>Clear</button>` : '';
  }

  function renderBody() {
    const el = $('ncBody'); if (!el) return;
    if (state.error) { el.innerHTML = `<div class="nc-empty">Couldn't load the new customers list: ${esc(state.error)}<br><button type="button" class="nc-btn" data-act="reload">Try again</button></div>`; return; }
    if (!state.loaded) {
      el.innerHTML = '<div class="nc-board" aria-busy="true">' + BOARD.map(() => '<section class="nc-col"><header class="nc-col-h"><div class="nc-sk" style="width:55%;height:14px"></div></header><div class="nc-col-b">' + [0, 1, 2].map(() => '<div class="nc-sk" style="height:96px"></div>').join('') + '</div></section>').join('') + '</div>';
      return;
    }
    if (state.tab === 'pipeline') el.innerHTML = boardHtml();
    else if (state.tab === 'interests') el.innerHTML = interestsHtml();
    else el.innerHTML = tableHtml(state.tab);
  }

  // ----- pipeline -----
  function interestChips(r, max) {
    if (!r.interests.length) return '';
    const shown = r.interests.slice(0, max || 3);
    return `<div class="nc-ichips">${shown.map(i => `<span>${esc(i)}</span>`).join('')}${r.interests.length > shown.length ? `<span class="more">+${r.interests.length - shown.length}</span>` : ''}</div>`;
  }

  function cardHtml(r, i) {
    const st = STAGES[r.stage];
    const flags = [];
    if (r.needsFirst) flags.push(`<span class="nc-flag hot">⏰ Waiting ${r.sinceSeen} days</span>`);
    if (r.followUpDue) flags.push('<span class="nc-flag hot">' + (r.followUp ? '⏰ Follow-up due' : '⏰ Time to nudge') + '</span>');
    else if ((r.stage === 'sent' || r.stage === 'talking') && r.followUp) flags.push(`<span class="nc-flag cool">Follow up ${esc(fmtShort(r.followUp))}</span>`);
    if (r.emailDue) flags.push(`<span class="nc-flag hot" title="Emailed ${esc(fmtDateTime(r.emailSentAt))} from ${esc(r.emailSender)}">✉️ No reply to email #${r.emailNo}</span>`);
    else if (r.emailRepliedAt) flags.push('<span class="nc-flag good">✉️ Replied</span>');
    if (r.stage !== 'done') flags.push(r.catalogueAt ? `<span class="nc-flag good" title="Posted ${esc(fmtDate(r.catalogueAt))}">📮 Catalogue sent</span>` : '<span class="nc-flag dim">📮 No catalogue yet</span>');
    if (r.loginAt && r.stage !== 'done') flags.push('<span class="nc-flag good">🔑 Login ready</span>');
    const sub = r.stage === 'done' ? (r.quoteCount ? `${plural(r.quoteCount, 'quote')}${r.lastQuoteValue ? ' · ' + gbp(r.lastQuoteValue) : ''}` : `${plural(r.decoOrders, 'order')}`)
      : r.lastAct ? `${esc(OUTCOME_LABEL[r.outcome] || 'Contacted')} · ${esc(ago(r.actDays))}` : `Added ${esc(ago(r.sinceSeen))}`;
    const quick = ['new', 'sent', 'talking'].includes(r.stage)
      ? `<div class="nc-quickrow">${r.email && mailOn() ? `<button type="button" class="nc-quick" data-mail="${esc(r.id)}">✉️ Email</button>` : ''}${!r.catalogueAt ? `<button type="button" class="nc-quick alt" data-cat="${esc(r.id)}" title="Tick this once the catalogue is in the post">📮 Catalogue posted</button>` : `<button type="button" class="nc-quick alt" data-log="${esc(r.id)}">📞 Log contact</button>`}</div>` : '';
    return `<article class="nc-card" data-id="${esc(r.id)}" tabindex="0" style="--c:${st.color};--i:${Math.min(i || 0, 8)}">
      <div class="nc-card-top"><span class="nc-card-cust">${esc(r.label)}</span><span class="nc-card-src" title="${esc(SOURCE_LABEL[r.source] || '')}">${r.source === 'deco' ? 'Deco' : r.source === 'csv' ? 'File' : 'Added'}</span></div>
      <div class="nc-card-mid">${avatar(r.owner)}<span class="nc-card-rep">${esc(ownerName(r.owner))}${r.contactName ? ' · ' + esc(r.contactName) : ''}</span></div>
      <div class="nc-flags">${flags.join('')}</div>${interestChips(r)}
      <div class="nc-card-foot"><span>${sub}</span><span>${esc(fmtShort(r.firstSeen))}</span></div>${quick}</article>`;
  }

  function sortFor(k) {
    switch (k) {
      case 'new': return (a, b) => (b.needsFirst ? 1 : 0) - (a.needsFirst ? 1 : 0) || (a.firstSeen || 0) - (b.firstSeen || 0);
      case 'sent': return (a, b) => ((b.followUpDue || b.emailDue) ? 1 : 0) - ((a.followUpDue || a.emailDue) ? 1 : 0) || (b.actDays || 0) - (a.actDays || 0);
      case 'talking': return (a, b) => (b.actDays || 0) - (a.actDays || 0);
      case 'ready': return (a, b) => (a.readyAt || 0) - (b.readyAt || 0);
      default: return (a, b) => (b.lastQuoteAt || b.firstSeen || 0) - (a.lastQuoteAt || a.firstSeen || 0);
    }
  }

  function callFirst(rows) {
    const cand = [];
    rows.forEach(r => {
      if (r.stage === 'talking' && r.emailRepliedAt && (!r.lastAct || r.emailRepliedAt >= r.lastAct)) cand.push({ r, p: 0, why: 'They replied · waiting on you' });
      else if (r.followUpDue) cand.push({ r, p: 1, why: r.followUp ? 'Follow-up due' : 'Contacted ' + r.actDays + 'd ago' });
      else if (r.emailDue) cand.push({ r, p: 1, why: 'No reply to email #' + r.emailNo });
      else if (r.needsFirst) cand.push({ r, p: 2, why: 'Waiting ' + r.sinceSeen + ' days for a first contact' });
    });
    return cand.sort((a, b) => a.p - b.p || (a.r.firstSeen || 0) - (b.r.firstSeen || 0)).slice(0, 6);
  }

  function boardHtml() {
    const rows = visible();
    if (!state.rows.length) return `<div class="nc-empty">Nobody here yet.<br>New customers appear from DecoNetwork first orders every night. You can also add one by hand or import a customer file with the buttons above.</div>`;
    if (!rows.length) return '<div class="nc-empty">Nothing matches.</div>';
    const first = callFirst(rows);
    const firstHtml = first.length ? `<section class="nc-first"><div class="nc-first-h"><h3>Do these first</h3><span class="nc-hint">replies and follow-ups come before first contacts</span></div><div class="nc-first-row">${first.map((c, i) => {
      const st = STAGES[c.r.stage];
      return `<article class="nc-first-card" data-id="${esc(c.r.id)}" tabindex="0" style="--c:${st.color};--i:${i}"><div class="nc-first-cust">${esc(c.r.label)}</div>
        <div class="nc-first-meta">${avatar(c.r.owner)}<span>${esc(ownerName(c.r.owner))}</span><b>${esc(c.why)}</b></div></article>`;
    }).join('')}</div></section>` : '';
    const counts = BOARD.map(k => ({ k, n: rows.filter(r => r.stage === k).length }));
    const funnel = `<div class="nc-funnel-box"><div class="nc-funnel">${counts.filter(c => c.n).map(c => `<div class="nc-fseg" style="--c:${STAGES[c.k].color};flex:${c.n} 1 0" title="${esc(STAGES[c.k].label)}: ${c.n}"><span>${c.n}</span></div>`).join('')}</div>
      <div class="nc-flegend">${counts.map(c => `<span><i style="--c:${STAGES[c.k].color}"></i>${esc(STAGES[c.k].label)} ${c.n}</span>`).join('')}</div></div>`;
    const cols = BOARD.map(k => {
      const items = rows.filter(r => r.stage === k).sort(sortFor(k));
      const st = STAGES[k];
      const cap = state.expanded[k] ? items.length : COL_CAP;
      return `<section class="nc-col" style="--c:${st.color}"><header class="nc-col-h"><div><span class="nc-col-t">${st.icon} ${esc(st.label)}</span><span class="nc-col-n">${items.length}</span></div>
        <div class="nc-col-s">${esc(st.blurb)}</div></header>
        <div class="nc-col-b">${items.length ? items.slice(0, cap).map((r, i) => cardHtml(r, i)).join('') + (items.length > cap ? `<button type="button" class="nc-more" data-more="${k}">Show all ${items.length}</button>` : '') : '<div class="nc-col-empty">Nobody here</div>'}</div></section>`;
    }).join('');
    return firstHtml + funnel + `<div class="nc-board">${cols}</div>`;
  }

  // ----- what they want -----
  function interestsHtml() {
    const rows = visible().filter(r => !['lost'].includes(r.stage));
    const withI = rows.filter(r => r.interests.length);
    if (!withI.length) return `<div class="nc-empty">No products recorded yet.<br>Open a customer and tick what they are interested in. This page then shows what new customers want across the board, which helps with stock and with quoting.</div>`;
    const tally = INTERESTS.map(i => ({ i, rs: rows.filter(r => r.interests.includes(i)) })).concat(
      Array.from(new Set(withI.flatMap(r => r.interests).filter(x => !INTERESTS.includes(x)))).map(i => ({ i, rs: rows.filter(r => r.interests.includes(i)) }))).filter(t => t.rs.length).sort((a, b) => b.rs.length - a.rs.length);
    const max = Math.max(1, ...tally.map(t => t.rs.length));
    const decTally = DECORATION.map(d => ({ d, n: rows.filter(r => r.decoration.includes(d)).length })).filter(t => t.n);
    return `<p class="nc-note">What ${plural(withI.length, 'new customer')} told us they want. Click a product to see who.${state.owner || state.source || state.q ? ' (Filtered as set above.)' : ''}</p>
      <div class="nc-int-wrap"><div class="nc-int-bars">${tally.map(t => `<button type="button" class="nc-int-row" data-interest="${esc(t.i)}"><span>${esc(t.i)}</span><div><i style="width:${Math.max(3, Math.round(t.rs.length / max * 100))}%"></i></div><em>${t.rs.length}</em></button>`).join('')}</div>
      <div class="nc-int-side">${decTally.length ? `<h4>Decoration</h4><div class="nc-ichips big">${decTally.map(t => `<span>${esc(t.d)} · ${t.n}</span>`).join('')}</div>` : ''}
      <h4>Not recorded yet</h4><p class="nc-hint">${plural(rows.length - withI.length, 'customer')} still to ask.</p></div></div>`;
  }

  // ----- tables -----
  const COLS = [
    { k: 'label', l: 'Customer', v: r => r.label.toLowerCase() },
    { k: 'stage', l: 'Stage', v: r => Object.keys(STAGES).indexOf(r.stage) },
    { k: 'owner', l: 'Owner', v: r => (r.owner || 'zzz').toLowerCase() },
    { k: 'firstSeen', l: 'Added', v: r => r.firstSeen ? r.firstSeen.getTime() : 0 },
    { k: 'source', l: 'Source', v: r => r.source },
    { k: 'interests', l: 'Interested in', v: r => r.interests.length, r: true },
    { k: 'catalogue', l: 'Catalogue', v: r => r.catalogueAt ? r.catalogueAt.getTime() : 0 },
    { k: 'contact', l: 'Last contact', v: r => r.lastAct ? r.lastAct.getTime() : 0 }
  ];
  function tableHtml(tab) {
    let rows = tab === 'all' ? visible() : visible().filter(r => r.stage === 'parked' || r.stage === 'lost');
    if (!rows.length) return `<div class="nc-empty">${tab === 'parked' ? 'Nothing parked or lost.' : 'Nothing matches.'}</div>`;
    if (state.sort.tab !== tab) state.sort = { tab, key: 'firstSeen', dir: -1 };
    const col = COLS.find(c => c.k === state.sort.key) || COLS[3];
    rows = rows.slice().sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir; });
    const head = COLS.map(c => `<th data-sort="${c.k}" class="${c.r ? 'r ' : ''}${c.k === state.sort.key ? 'sorted' : ''}">${esc(c.l)}${c.k === state.sort.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows.slice(0, 400).map(r => {
      const st = STAGES[r.stage];
      const extra = r.stage === 'parked' ? ' until ' + fmtShort(r.parkedUntil) : r.stage === 'lost' && r.closedReason ? ' · ' + r.closedReason : '';
      return `<tr data-id="${esc(r.id)}" tabindex="0"><td><b>${esc(r.label)}</b>${r.contactName ? `<div class="nc-dim">${esc(r.contactName)}</div>` : ''}</td>
        <td><span class="nc-chip" style="--c:${st.color}">${esc(st.label)}${esc(extra)}</span></td>
        <td><span class="nc-rep">${avatar(r.owner)}${esc(ownerName(r.owner))}</span></td>
        <td>${esc(fmtDate(r.firstSeen))}</td><td>${esc(SOURCE_LABEL[r.source] || r.source)}</td>
        <td class="r">${r.interests.length ? esc(r.interests.slice(0, 3).join(', ')) + (r.interests.length > 3 ? ' +' + (r.interests.length - 3) : '') : '—'}</td>
        <td>${r.catalogueAt ? esc(fmtShort(r.catalogueAt)) : '—'}</td>
        <td>${r.lastAct ? esc(fmtShort(r.lastAct)) + ' · ' + esc(OUTCOME_LABEL[r.outcome] || '') : '—'}</td></tr>`;
    }).join('');
    return `<div class="nc-tablewrap"><table class="nc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="nc-tfoot">${plural(rows.length, 'customer')}${rows.length > 400 ? ' (first 400 shown, use the search to narrow)' : ''}</div>`;
  }

  // ----- csv export -----
  function exportCsv() {
    const rows = visible();
    const guard = v => { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    const q = v => '"' + guard(v).replace(/"/g, '""') + '"';
    const head = ['Company', 'Contact', 'Email', 'Phone', 'Owner', 'Stage', 'Source', 'Added', 'Interested in', 'Decoration', 'Rough quantity', 'Logo', 'Staff', 'Timing', 'Decision maker', 'Budget', 'Catalogue posted', 'Login created', 'Ready to quote', 'Last contact', 'Notes'];
    const lines = [head.map(q).join(',')].concat(rows.map(r => [r.company, r.person, r.email, r.phone, r.owner, STAGES[r.stage].label, SOURCE_LABEL[r.source] || r.source, r.firstSeen ? isoDay(r.firstSeen) : '',
      r.interests.join('; '), r.decoration.join('; '), r.estQty, LOGO_LABEL[r.hasLogo] || '', r.staffCount, r.timing, r.decisionMaker, r.budget,
      r.catalogueAt ? isoDay(r.catalogueAt) : '', r.loginAt ? isoDay(r.loginAt) : '', r.readyAt ? isoDay(r.readyAt) : '', r.lastAct ? isoDay(r.lastAct) : '', r.notes].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'new-customers-' + isoDay(new Date()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ----- writes -----
  async function call(fn, args, btn, okMsg) {
    if (btn) btn.disabled = true;
    try {
      const res = await client().rpc(fn, args);
      if (res.error) throw res.error;
      if (okMsg) toast(okMsg);
      await load(true);
      return { ok: true, data: res.data };
    } catch (e) {
      toast('Could not save: ' + ((e && e.message) || 'try again'), true);
      return { ok: false };
    } finally { if (btn) btn.disabled = false; }
  }
  const mark = (id, what, on, btn, msg) => call('nc_mark', { p_id: Number(id), p_what: what, p_on: on }, btn, msg);
  const logContact = (id, method, outcome, note, followUp, btn) => call('nc_log', { p_id: Number(id), p_method: method, p_outcome: outcome, p_note: note || null, p_follow_up: followUp || null }, btn,
    'Logged. ' + (OUTCOME_LABEL[outcome] || '') + (followUp ? ' · follow up ' + fmtShort(dayDate(followUp)) : ''));
  const setCustState = (id, action, until, reason, btn) => call('nc_set_state', { p_id: Number(id), p_action: action, p_until: until || null, p_reason: reason || null }, btn,
    action === 'park' ? 'Parked until ' + fmtShort(dayDate(until)) + '.' : action === 'lost' ? 'Marked as lost.' : 'Back on the board.');

  // ----- drawer -----
  function openDrawer(id, focusForm) {
    const r = state.rows.find(x => x.id === id);
    if (!r) return;
    state.openId = id; state.dirty = false;
    const d = $('ncDrawer');
    d.classList.add('open');
    document.body.classList.add('nc-lock');
    $('ncSheet').innerHTML = drawerHtml(r, null);
    if (focusForm && $('ncOutcome')) $('ncOutcome').focus(); else $('ncSheet').focus();
    loadTimeline(id);
    loadHistory(id);
  }
  function closeDrawer() {
    state.openId = null; state.dirty = false;
    const d = $('ncDrawer'); if (d) d.classList.remove('open');
    setHist('');
    document.body.classList.remove('nc-lock');
  }
  function refreshDrawer() {
    const r = state.rows.find(x => x.id === state.openId);
    if (!r) return;
    const form = { m: ($('ncMethod') || {}).value, o: ($('ncOutcome') || {}).value, n: ($('ncNote') || {}).value, f: ($('ncFollow') || {}).value, t: ($('ncFollow') || {}).dataset ? ($('ncFollow') || {}).dataset.touched : '' };
    const mail = $('qtCompose') && $('qtCompose').firstChild ? $('qtCompose') : null;   // an email being written must survive a refresh
    const tl = $('ncTimeline') ? $('ncTimeline').innerHTML : null;
    $('ncSheet').innerHTML = drawerHtml(r, tl);
    if (mail && $('qtCompose')) $('qtCompose').replaceWith(mail);
    if (form.m && $('ncMethod')) $('ncMethod').value = form.m;
    if (form.o && $('ncOutcome')) $('ncOutcome').value = form.o;
    if ($('ncNote') && form.n) $('ncNote').value = form.n;
    if ($('ncFollow') && form.f) { $('ncFollow').value = form.f; if (form.t) $('ncFollow').dataset.touched = '1'; }
    loadTimeline(r.id);
  }

  function summaryText(r) {
    const L = [r.label + (r.contactName ? ' (' + r.contactName + ')' : '')];
    const contact = [r.email, r.phone].filter(Boolean).join(' · ');
    if (contact) L.push(contact);
    L.push('Added ' + fmtDate(r.firstSeen) + ' · ' + (SOURCE_LABEL[r.source] || r.source) + (r.owner ? ' · looked after by ' + r.owner : ''));
    L.push('');
    L.push('Interested in: ' + (r.interests.length ? r.interests.join(', ') : 'not recorded yet'));
    if (r.decoration.length) L.push('Decoration: ' + r.decoration.join(', '));
    if (r.estQty) L.push('Rough quantity: ' + r.estQty);
    if (r.hasLogo) L.push('Logo: ' + (LOGO_LABEL[r.hasLogo] || r.hasLogo));
    if (r.staffCount) L.push('People to dress: ' + r.staffCount);
    if (r.timing) L.push('When they need it: ' + r.timing);
    if (r.decisionMaker) L.push('Who decides: ' + r.decisionMaker);
    if (r.budget) L.push('Budget: ' + r.budget);
    L.push('');
    L.push('Catalogue: ' + (r.catalogueAt ? 'posted ' + fmtDate(r.catalogueAt) : 'not posted yet') + ' · Login: ' + (r.loginAt ? 'created ' + fmtDate(r.loginAt) : 'not created yet'));
    if (r.firstOrderSummary) L.push('First order' + (r.firstOrderId ? ' #' + r.firstOrderId : '') + ': ' + r.firstOrderSummary + (r.firstOrderValue ? ' (' + gbp(r.firstOrderValue) + ')' : ''));
    if (r.lastAct) L.push('Last contact: ' + fmtDate(r.lastAct) + ' · ' + (OUTCOME_LABEL[r.outcome] || '') + (r.lastActBy ? ' · ' + r.lastActBy : '') + (r.lastActNote ? ' — ' + r.lastActNote : ''));
    if (r.notes) { L.push(''); L.push('Notes: ' + r.notes); }
    return L.join('\n');
  }

  function stepRow(done, title, detail, btn) {
    return `<div class="nc-step${done ? ' done' : ''}"><span class="nc-step-i" aria-hidden="true">${done ? '✓' : '○'}</span><div class="nc-step-t"><b>${esc(title)}</b>${detail ? `<div class="nc-dim">${detail}</div>` : ''}</div>${btn || ''}</div>`;
  }

  function emailSectionHtml(r) {
    if (!mailOn()) return '';
    if (!r.email) return '<div class="qt-email-wrap"><div class="qt-note">No email address on file yet. Add one under "Edit contact details", or ring them.</div></div>';
    let timer = '';
    if (r.emailCycle && r.emailSentAt) {
      const left = r.emailDueAt ? r.emailDueAt - Date.now() : 0;
      if (r.emailRepliedAt) timer = `<div class="qt-timer qt-timer-ok">✉️ Email #${r.emailNo} sent. The customer has replied</div>`;
      else if (r.emailDue) timer = `<div class="qt-timer qt-timer-due">⏰ No reply to email #${r.emailNo} (sent ${esc(fmtDateTime(r.emailSentAt))}). Time to follow up</div>`;
      else timer = `<div class="qt-timer" title="Sent from ${esc(r.emailSender)}">✉️ Email #${r.emailNo} sent ${esc(fmtDateTime(r.emailSentAt))}. Waiting for a reply: ${left > DAY ? Math.ceil(left / DAY) + ' days' : Math.max(1, Math.ceil(left / 3600000)) + ' hours'} left</div>`;
    }
    const nextNo = r.emailCycle ? r.emailNo + 1 : 1;
    return `<div class="qt-email-wrap">${timer}<button type="button" class="qt-btn qt-primary qt-mailbtn" data-act="mail" data-for="${esc(r.id)}">✉️ ${nextNo > 1 ? 'Email #' + nextNo : 'Send a welcome email'}</button><div id="qtCompose"></div></div>`;
  }

  function drawerHtml(r, timelineHtml) {
    const st = STAGES[r.stage];
    const fact = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    let banner = '';
    if (r.stage === 'done') banner = r.quoteCount ? `<span class="nc-banner good">🧾 They have been quoted (${plural(r.quoteCount, 'quote')}${r.lastQuoteId ? ', latest #' + esc(r.lastQuoteId) : ''}). This is now a job for the Quotes tab.</span>` : `<span class="nc-banner good">✅ They have placed ${plural(r.decoOrders, 'order')}.</span>`;
    else if (r.stage === 'ready') banner = `<span class="nc-banner good">🧾 Marked ready to quote ${esc(fmtShort(r.readyAt))}${r.readyBy ? ' by ' + esc(r.readyBy) : ''}. Copy the summary below for whoever quotes them.</span>`;
    else if (r.stage === 'talking') banner = `<span class="nc-banner purple">💬 ${esc(OUTCOME_LABEL[r.outcome] || 'They replied')}${r.actDays != null ? ' ' + esc(ago(r.actDays)) : ''}. Find out what they want and record it below.</span>`;
    else if (r.followUpDue) banner = `<span class="nc-banner warn">⏰ ${r.followUp ? 'Follow-up was due ' + esc(fmtShort(r.followUp)) : 'Contacted ' + esc(ago(r.actDays || 0)) + ' with no follow-up date'}.</span>`;
    else if (r.needsFirst) banner = `<span class="nc-banner warn">⏰ Nobody has been in touch for ${r.sinceSeen} days.</span>`;
    else if (r.stage === 'lost') banner = `<span class="nc-banner">✖ Marked as lost: ${esc(r.closedReason)}.</span>`;
    else if (r.stage === 'parked') banner = `<span class="nc-banner">🕒 Parked until ${esc(fmtDate(r.parkedUntil))}.</span>`;
    const contactLine = [r.contactName, r.email ? `<a href="mailto:${esc(r.email)}" style="color:#7dd3fc">${esc(r.email)}</a>` : '', r.phone ? `<a href="tel:${esc(r.phone.replace(/[^+\d]/g, ''))}" style="color:#7dd3fc">${esc(r.phone)}</a>` : ''].filter(Boolean);
    const closed = r.stage === 'lost' || r.stage === 'parked';
    const today = isoDay(new Date());
    const chip = (v, list, attr) => `<button type="button" class="nc-chipbtn${list.includes(v) ? ' on' : ''}" ${attr}="${esc(v)}" aria-pressed="${list.includes(v)}">${esc(v)}</button>`;
    const extraInterests = r.interests.filter(i => !INTERESTS.includes(i));
    const steps = [
      stepRow(!!r.catalogueAt, 'Catalogue posted', r.catalogueAt ? esc(fmtDate(r.catalogueAt)) + (r.catalogueBy ? ' by ' + esc(r.catalogueBy) : '') : 'Tick this once a printed catalogue is in the post',
        r.catalogueAt ? `<button type="button" class="nc-btn" data-step="catalogue" data-on="0" title="Undo">Undo</button>` : `<button type="button" class="nc-btn nc-primary" data-step="catalogue" data-on="1">📮 Posted</button>`),
      stepRow(!!r.loginAt, 'Login created', r.loginAt ? esc(fmtDate(r.loginAt)) + (r.loginBy ? ' by ' + esc(r.loginBy) : '') : 'Tick this once they have a login to order online',
        r.loginAt ? `<button type="button" class="nc-btn" data-step="login" data-on="0" title="Undo">Undo</button>` : `<button type="button" class="nc-btn nc-primary" data-step="login" data-on="1">🔑 Created</button>`),
      stepRow(r.emailCycle, 'Welcome email', r.emailCycle ? (r.emailRepliedAt ? 'Sent and they replied' : 'Sent ' + esc(fmtShort(r.emailSentAt)) + ', waiting for a reply') : 'Use the email box below', ''),
      stepRow(r.interests.length > 0, 'Products recorded', r.interests.length ? esc(r.interests.slice(0, 4).join(', ')) + (r.interests.length > 4 ? ' +' + (r.interests.length - 4) : '') : 'Tick what they are interested in below', ''),
      stepRow(!!r.readyAt, 'Ready to quote', r.readyAt ? esc(fmtDate(r.readyAt)) + (r.readyBy ? ' by ' + esc(r.readyBy) : '') : 'When you know enough for someone to quote them',
        r.readyAt ? `<button type="button" class="nc-btn" data-step="ready" data-on="0" title="Undo">Undo</button>` : `<button type="button" class="nc-btn nc-primary" data-step="ready" data-on="1">🧾 Ready</button>`)
    ].join('');
    return `<div class="nc-d-top" style="--c:${st.color}"><div><div class="nc-d-eyebrow">${esc(st.icon)} ${esc(st.label)}</div><h3>${esc(r.label)}</h3>
      <p class="nc-d-job">${contactLine.join(' · ')}</p></div>
      <button type="button" class="nc-x" data-act="close" aria-label="Close">×</button></div>
      <div class="nc-facts">
        ${fact('Added', esc(fmtDate(r.firstSeen)) + `<div class="nc-dim">${esc(SOURCE_LABEL[r.source] || r.source)}</div>`)}
        ${fact('Owner', `<span class="nc-rep">${avatar(r.owner)}${esc(ownerName(r.owner))}</span>`)}
        ${fact('Orders so far', r.source === 'deco' || r.decoOrders ? plural(r.decoOrders, 'order') + (r.firstOrderValue ? `<div class="nc-dim">first one ${esc(gbp(r.firstOrderValue))}</div>` : '') : 'None')}
        ${fact('Quotes', r.quoteCount ? plural(r.quoteCount, 'quote') + (r.lastQuoteAt ? `<div class="nc-dim">latest ${esc(fmtShort(r.lastQuoteAt))}</div>` : '') : 'None yet')}
        ${fact('Last contact', r.lastAct ? esc(fmtShort(r.lastAct)) + `<div class="nc-dim">${esc(OUTCOME_LABEL[r.outcome] || '')}${r.lastActBy ? ' · ' + esc(r.lastActBy) : ''}</div>` : 'Never')}
        ${fact('Next follow-up', r.followUp ? esc(fmtShort(r.followUp)) : '—')}
      </div>
      ${r.firstOrderSummary ? `<p class="nc-dim" style="margin:10px 0 0">First order${r.firstOrderId ? ' #' + esc(r.firstOrderId) : ''}: ${esc(r.firstOrderSummary)}</p>` : ''}
      ${banner}
      <div class="nc-steps"><h4>Next steps</h4>${steps}</div>
      ${closed ? '' : emailSectionHtml(r)}
      <form class="nc-details" id="ncDetails" autocomplete="off"><h4>What they want</h4>
        <div class="nc-lbl">Products they are interested in</div>
        <div class="nc-chipgrid" id="ncInterests">${INTERESTS.map(i => chip(i, r.interests, 'data-int')).join('')}${extraInterests.map(i => chip(i, r.interests, 'data-int')).join('')}</div>
        <div class="nc-lbl">Decoration</div>
        <div class="nc-chipgrid" id="ncDecoration">${DECORATION.map(i => chip(i, r.decoration, 'data-dec')).join('')}</div>
        <div class="nc-two"><div><label for="ncQty">Rough quantity</label><input id="ncQty" maxlength="100" value="${esc(r.estQty)}" placeholder="e.g. 20 polos, 10 hoodies"></div>
          <div><label for="ncLogo">Logo</label><select id="ncLogo">${LOGO.map(l => `<option value="${esc(l[0])}"${l[0] === r.hasLogo ? ' selected' : ''}>${esc(l[1])}</option>`).join('')}</select></div></div>
        <div class="nc-two"><div><label for="ncStaff">People to dress</label><input id="ncStaff" maxlength="100" value="${esc(r.staffCount)}" placeholder="e.g. 12 staff"></div>
          <div><label for="ncTiming">When they need it</label><input id="ncTiming" maxlength="200" value="${esc(r.timing)}" placeholder="e.g. new starters in January"></div></div>
        <div class="nc-two"><div><label for="ncDecider">Who decides</label><input id="ncDecider" maxlength="200" value="${esc(r.decisionMaker)}"></div>
          <div><label for="ncBudget">Budget</label><input id="ncBudget" maxlength="200" value="${esc(r.budget)}"></div></div>
        <label for="ncNotes">Notes</label><textarea id="ncNotes" maxlength="4000" placeholder="Anything useful for whoever quotes them">${esc(r.notes)}</textarea>
        <button type="submit" class="nc-btn nc-primary nc-submit" id="ncSaveDetails">Save what they want</button>
      </form>
      <details class="nc-sum"><summary>Summary for quoting (copy)</summary><pre id="ncSum">${esc(summaryText(r))}</pre><button type="button" class="nc-btn" data-act="copy">Copy summary</button></details>
      <details class="nc-edit"><summary>Edit contact details</summary>
        <div class="nc-two"><div><label for="ncCompany">Company</label><input id="ncCompany" maxlength="200" value="${esc(r.company)}"></div><div><label for="ncPerson">Contact</label><input id="ncPerson" maxlength="200" value="${esc(r.person)}"></div></div>
        <div class="nc-two"><div><label for="ncEmail">Email</label><input id="ncEmail" type="email" maxlength="200" value="${esc(r.email)}"></div><div><label for="ncPhone">Phone</label><input id="ncPhone" maxlength="60" value="${esc(r.phone)}"></div></div>
        <label for="ncOwnerSel">Owner</label><select id="ncOwnerSel"><option value="">Unassigned</option>${Array.from(new Set(TEAM.concat(r.owner ? [r.owner] : []))).map(t => `<option value="${esc(t)}"${t === r.owner ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <button type="button" class="nc-btn nc-primary nc-submit" data-act="save-contact">Save contact details</button></details>
      ${closed ? '' : `<form class="nc-chase" id="ncLogForm" autocomplete="off"><h4>Log a contact</h4>
        <div class="nc-chase-row"><div class="nc-field"><label for="ncMethod">How</label><select id="ncMethod">${METHODS.filter(m => m[0] !== 'post').map(m => `<option value="${m[0]}">${esc(m[1])}</option>`).join('')}</select></div>
        <div class="nc-field"><label for="ncOutcome">What happened</label><select id="ncOutcome">${OUTCOMES.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('')}</select></div></div>
        <div style="margin-top:8px"><label for="ncFollow">Chase again on</label><input type="date" id="ncFollow" min="${today}" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px">
          <div class="nc-chips"><button type="button" data-fu="3">3 days</button><button type="button" data-fu="7">1 week</button><button type="button" data-fu="14">2 weeks</button><button type="button" data-fu="30">1 month</button><button type="button" data-fu="0">None</button></div></div>
        <textarea id="ncNote" placeholder="What did they say? (optional)" maxlength="1000" aria-label="Note"></textarea>
        <button class="nc-btn nc-primary nc-submit" type="submit">Save contact</button></form>`}
      <div class="nc-other"><h4>${closed ? 'Put back on the board' : 'Set aside'}</h4>
        ${closed ? '<div class="nc-chase-row"><button type="button" class="nc-btn nc-primary" data-state="reopen">Reopen</button></div>'
          : `<div class="nc-chase-row"><input type="date" id="ncParkDate" min="${isoDay(addDays(1))}" value="${isoDay(addDays(30))}" aria-label="Park until" style="padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px">
          <button type="button" class="nc-btn" data-state="park">🕒 Park until then</button></div>
          <div class="nc-chase-row" style="margin-top:8px"><input type="text" id="ncLostWhy" placeholder="Why? (not interested, closed down…)" maxlength="200" aria-label="Reason" style="flex:1;min-width:150px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#0f172a;color:#e2e8f0;font-size:13px"><button type="button" class="nc-btn" data-state="lost">✖ Mark lost</button></div>`}
      </div>
      <h4 class="nc-d-h">History</h4><ul class="nc-timeline" id="ncTimeline">${timelineHtml || '<li class="nc-dim">Loading…</li>'}</ul>`;
  }

  async function loadTimeline(id) {
    const el = $('ncTimeline'); if (!el) return;
    const r = state.rows.find(x => x.id === id);
    try {
      const res = await client().from('nc_activity').select('*').eq('nc_id', Number(id)).order('created_at', { ascending: false }).limit(60);
      if (res.error) throw res.error;
      if (state.openId !== id) return;
      const icon = c => c.outcome === 'catalogue_posted' ? '📮' : c.outcome === 'login_created' ? '🔑' : c.outcome === 'ready_to_quote' ? '🧾' : c.method === 'email' ? '✉️' : c.method === 'whatsapp' ? '💬' : c.method === 'visit' ? '🚗' : c.method === 'post' ? '📮' : '📞';
      const ev = (res.data || []).map(c => ({ at: toDate(c.created_at), icon: icon(c),
        text: `<b>${esc(OUTCOME_LABEL[c.outcome] || c.outcome)}</b> · ${esc(METHOD_LABEL[c.method] || c.method)}${c.by_name ? ' · ' + esc(c.by_name) : ''}${c.follow_up_on ? ' · chase ' + esc(fmtShort(dayDate(c.follow_up_on))) : ''}${c.note && c.note !== OUTCOME_LABEL[c.outcome] ? `<div class="nc-dim">${esc(c.note)}</div>` : ''}`, cls: c.outcome === 'replied' ? 'good' : '' }));
      if (r && r.created) ev.push({ at: r.created, icon: '🌱', text: `Added · ${esc(SOURCE_LABEL[r.source] || r.source)}`, cls: '' });
      ev.sort((a, b) => b.at - a.at);
      el.innerHTML = ev.length ? ev.slice(0, 40).map(e => `<li class="${e.cls}"><span class="nc-tl-i">${e.icon}</span><div><div>${e.text}</div><div class="nc-dim">${esc(fmtDateTime(e.at))}</div></div></li>`).join('') : '<li class="nc-dim">Nothing yet.</li>';
    } catch (e) { if ($('ncTimeline')) $('ncTimeline').innerHTML = '<li class="nc-dim">Could not load the history.</li>'; }
  }

  // ----- the details form -----
  function detailsPayload() {
    const pick = sel => Array.from(document.querySelectorAll(sel + '.on')).map(b => b.getAttribute(sel.includes('data-int') ? 'data-int' : 'data-dec'));
    return {
      interests: pick('[data-int]'), decoration: pick('[data-dec]'),
      est_qty: $('ncQty').value, has_logo: $('ncLogo').value, staff_count: $('ncStaff').value, timing: $('ncTiming').value,
      decision_maker: $('ncDecider').value, budget: $('ncBudget').value, notes: $('ncNotes').value
    };
  }
  async function saveDetails(btn) {
    const id = state.openId; if (!id) return;
    const res = await call('nc_update', { p_id: Number(id), p: detailsPayload() }, btn, 'Saved.');
    if (res.ok) { state.dirty = false; refreshDrawer(); }
  }
  async function saveContact(btn) {
    const id = state.openId; if (!id) return;
    const res = await call('nc_update', { p_id: Number(id), p: { company: $('ncCompany').value, contact_name: $('ncPerson').value, email: $('ncEmail').value, phone: $('ncPhone').value, owner: $('ncOwnerSel').value } }, btn, 'Saved.');
    if (res.ok) refreshDrawer();
  }

  // ----- email (same box as the Quotes tab: window.ATAM_QT.mountCompose, sent by the same n8n workflow) -----
  // Fixed wordings (no AI) using only facts we hold. They never mention prices, dates or offers.
  function draftIntro(r, sender, no, tone) {
    const A = window.ATAM_QT;
    tone = A.TONES.some(t => t.key === tone) ? tone : 'friendly';
    let fn = A.firstName(r.person);
    if (fn && fn === fn.toLowerCase()) fn = fn.charAt(0).toUpperCase() + fn.slice(1);
    const hi = fn ? 'Hi ' + fn : 'Hello';
    const me = sender && sender.kind === 'rep' ? A.firstName(sender.label) : 'Customer Support';
    const first = no <= 1, fromOrder = r.source === 'deco';
    const open = fromOrder ? 'Thanks for your recent order with us. I wanted to say hello and let you know what else we can help with.' : 'I wanted to get in touch and introduce ATAM Workwear.';
    const cat = r.catalogueAt ? "I've put our catalogue in the post to you, so it should be with you soon." : "I'd be happy to post you a copy of our catalogue.";
    const login = r.loginAt ? 'Your login for ordering online is set up, so just let me know if you need a hand using it.' : 'I can also set you up with a login so you can order online.';
    const ask = "If you tell me what you're looking for (the garments, embroidery or print, and roughly how many), I can pull some ideas together for you.";
    const L = {
      friendly: first ? `${open} ${cat} ${login} ${ask}` : `I'm just following up on my last email. ${cat} If there's anything you need, just let me know.`,
      short: first ? `Quick hello from ATAM Workwear. ${r.catalogueAt ? 'Your catalogue is in the post.' : 'Would you like a catalogue posted out?'} Tell me what you're after and I'll sort some ideas.` : `Just a quick follow-up. Is there anything you need from us at the moment?`,
      formal: first ? `${fn ? 'Dear ' + fn : 'Good day'},\n\nI am writing to introduce ATAM Workwear${fromOrder ? ' following your recent order' : ''}. ${cat} ${login} Please let me know what you require and I would be pleased to assist.`
        : `${fn ? 'Dear ' + fn : 'Good day'},\n\nFurther to my previous email, I would be grateful if you could let me know whether there is anything we can help you with.`,
      gentle: first ? `No rush at all. ${open} ${cat} Whenever you're ready, just tell me what you're looking for.` : `I know things get busy, so I'm just popping my last email back to the top of your inbox. If now isn't the right time, that's fine, and I'll leave it with you.`,
      helpful: first ? `${open} ${cat} ${login} It helps to know the sort of garments you need, whether you'd like embroidery or print, and roughly how many. Reply with whatever you know and I'll take it from there.`
        : `I'm following up in case it helps. If you tell me the garments, decoration and rough numbers, I can put some ideas together for you.`,
      ready: first ? `${open} If you already know what you need, just reply with the garments and rough numbers and I'll get a quote moving for you.` : `Just a quick reminder. If you'd like a quote, reply with what you need and I'll get it moving.`
    };
    const body = tone === 'formal' ? `${L.formal}\n\nKind regards,\n${me}\nATAM Workwear` : `${hi},\n\n${L[tone]}\n\nKind regards,\n${me}\nATAM Workwear`;
    const subjects = {
      friendly: first ? 'Welcome to ATAM Workwear' : 'Following up', short: 'Hello from ATAM Workwear', formal: first ? 'Introducing ATAM Workwear' : 'Following up on my previous email',
      gentle: first ? 'Just saying hello' : 'Just checking in again', helpful: 'How we can help', ready: 'Ready when you are'
    };
    return { subject: subjects[tone], body };
  }

  async function openCompose(id) {
    const r = state.rows.find(x => x.id === id);
    const box = $('qtCompose');
    const A = window.ATAM_QT;
    if (!r || !box) return;
    if (!A) { box.innerHTML = '<div class="qt-note qt-note-bad">The email box is not loaded yet. Refresh the page and try again.</div>'; return; }
    box.innerHTML = '<div class="qt-dim">Loading…</div>';
    let list;
    try { list = await A.loadSenders(); } catch (e) { console.error('senders failed', e); box.innerHTML = '<div class="qt-note qt-note-bad">Couldn\'t load the sender list.</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="qt-note">No sender mailboxes have been set up yet.</div>'; return; }
    const def = A.pickSender(list, r.owner);
    const no = r.emailCycle ? r.emailNo + 1 : 1;
    A.mountCompose(box, {
      senders: list, def, to: r.email, no, kind: 'nc', linkEnabled: false, rep: r.owner,
      heading: no > 1 ? `Email #${no} to this customer` : 'Welcome email',
      footnote: 'Sends straight away from the mailbox above and logs it on this customer. If there is no reply in 3 days it shows as due a follow-up, and a reply in that mailbox moves the card to Talking by itself. Nothing sends until you press Send.',
      draft: (sender, tone) => draftIntro(r, sender, no, tone),
      queue: p => client().rpc('queue_nc_email', { p_nc_id: Number(id), p_sender_id: p.senderId, p_to: p.to, p_subject: p.subject, p_body: p.body }),
      toast,
      after: async () => { const b = $('qtCompose'); if (b) b.innerHTML = ''; await load(true); }
    });
  }

  // ----- customer history panel (same panel as the Quotes tab, built by window.ATAM_QT.histHtml) -----
  const histCache = new Map();
  const HIST_TTL = 5 * 60 * 1000;
  const setHist = html => { const el = $('ncHist'); if (el) el.innerHTML = html; };
  async function loadHistory(id) {
    const hit = histCache.get(id);
    if (hit && Date.now() - hit.at < HIST_TTL) { renderHistory(id, hit.data); return; }
    setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide">Loading customer history…</div></div>');
    try {
      const res = await client().rpc('nc_customer_history', { p_id: Number(id) });
      if (res.error) throw res.error;
      histCache.set(id, { at: Date.now(), data: res.data });
      renderHistory(id, res.data);
    } catch (e) {
      console.error('customer history failed', e);
      if (state.openId === id) setHist('<div class="qt-hgrid"><div class="qt-hc qt-hc-wide"><b>Couldn\'t load the customer history.</b> <button type="button" class="qt-btn" data-act="hist-retry">Try again</button></div></div>');
    }
  }
  function knowCard(r) {
    const row = (k, v) => v ? `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '';
    const chips = list => list.length ? `<div class="qt-hchips">${list.map(i => `<span class="qt-hpill">${esc(i)}</span>`).join('')}</div>` : '<p class="qt-dim">Nothing recorded yet. Ask them what they need and tick it in the box on the right.</p>';
    return `<section class="qt-hc qt-hc-wide"><h4>What we know so far</h4>
      <div class="qt-hsub">Interested in</div>${chips(r.interests)}
      ${r.decoration.length ? `<div class="qt-hsub">Decoration</div>${chips(r.decoration)}` : ''}
      <div class="qt-hfacts" style="margin-top:12px">${row('Rough quantity', r.estQty)}${row('Logo', LOGO_LABEL[r.hasLogo] || '')}${row('People to dress', r.staffCount)}${row('When they need it', r.timing)}${row('Who decides', r.decisionMaker)}${row('Budget', r.budget)}</div>
      ${r.notes ? `<div class="qt-hsub">Notes</div><p style="margin:0;font-size:13px;white-space:pre-wrap">${esc(r.notes)}</p>` : ''}</section>`;
  }
  function renderHistory(id, h) {
    if (state.openId !== id) return;
    const r = state.rows.find(x => x.id === id);
    if (!r || !window.ATAM_QT) return;
    const pts = [];
    if (r.source === 'deco') pts.push(`🌱 First came to us through DecoNetwork on <b>${esc(fmtDate(r.firstSeen))}</b>${r.firstOrderValue ? ' with an order worth <b>' + esc(gbp(r.firstOrderValue)) + '</b>' : ''}. They have placed ${plural(r.decoOrders, 'order')} so far.`);
    else pts.push(`🌱 ${esc(SOURCE_LABEL[r.source] || 'Added')} on <b>${esc(fmtDate(r.firstSeen))}</b>. No orders yet.`);
    pts.push(r.catalogueAt ? `📮 Catalogue posted ${esc(fmtDate(r.catalogueAt))}.` : '📮 No catalogue posted yet.');
    pts.push(r.loginAt ? `🔑 Login created ${esc(fmtDate(r.loginAt))}.` : '🔑 No login created yet.');
    if (r.quoteCount) pts.push(`🧾 They have ${plural(r.quoteCount, 'quote')} on file${r.lastQuoteValue ? ' (latest ' + esc(gbp(r.lastQuoteValue)) + ')' : ''}.`);
    if (!h || !h.found) {
      setHist(`<div class="qt-hgrid"><section class="qt-hc qt-hc-wide qt-hhead"><div><div class="qt-d-eyebrow">New customer</div><h3>${esc(r.label)}</h3></div><span class="qt-hpill good">New</span></section>
        <section class="qt-hc qt-hc-wide"><h4>Talking points</h4><ul class="qt-htp">${pts.map(t => `<li>${t}</li>`).join('')}</ul></section>${knowCard(r)}
        <p class="qt-dim qt-hnote">No orders or invoices were found under this name yet, so there is no history to show. It fills in once they order.</p></div>`);
      return;
    }
    setHist(window.ATAM_QT.histHtml({ id: r.id, customer: r.label }, h, { quotes: [], noOpen: true, noun: 'customer', points: pts, top: knowCard(r) }));
  }

  // ----- add by hand and import a file -----
  function modal(html, onReady) {
    closeModal();
    const m = document.createElement('div');
    m.className = 'nc-modal'; m.id = 'ncModal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = `<div class="nc-modal-box">${html}</div>`;
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-modal-close]')) closeModal(); });
    document.body.appendChild(m);
    if (onReady) onReady(m);
  }
  const closeModal = () => { const m = $('ncModal'); if (m) m.remove(); };

  function showAdd() {
    modal(`<h3>Add a new customer</h3><p class="nc-dim">Someone who is not in DecoNetwork yet, or who has not ordered. You can fill in the rest later.</p>
      <form id="ncAddForm" autocomplete="off">
        <div class="nc-two"><div><label for="ncaCompany">Company</label><input id="ncaCompany" maxlength="200"></div><div><label for="ncaPerson">Contact name</label><input id="ncaPerson" maxlength="200"></div></div>
        <div class="nc-two"><div><label for="ncaEmail">Email</label><input id="ncaEmail" type="email" maxlength="200"></div><div><label for="ncaPhone">Phone</label><input id="ncaPhone" maxlength="60"></div></div>
        <label for="ncaOwner">Looked after by</label><select id="ncaOwner"><option value="">Me</option>${TEAM.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
        <label for="ncaNotes">Where did they come from, what did they say?</label><textarea id="ncaNotes" maxlength="4000"></textarea>
        <div class="nc-modal-row"><button type="submit" class="nc-btn nc-primary" id="ncaSave">Add customer</button><button type="button" class="nc-btn" data-modal-close>Cancel</button></div></form>`,
    m => { m.querySelector('#ncaCompany').focus(); m.querySelector('#ncAddForm').addEventListener('submit', async e => {
      e.preventDefault();
      const res = await call('nc_add', { p: { company: $('ncaCompany').value, contact_name: $('ncaPerson').value, email: $('ncaEmail').value, phone: $('ncaPhone').value, owner: $('ncaOwner').value, notes: $('ncaNotes').value } }, $('ncaSave'), 'Added.');
      if (res.ok) { closeModal(); state.tab = 'pipeline'; renderControls(); renderBody(); if (res.data != null) openDrawer(String(res.data)); }
    }); });
  }

  // a small, forgiving CSV reader (quotes, commas and line breaks inside quotes, BOM)
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
      else f += c;
    }
    row.push(f); if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }
  function mapCsv(rows) {
    if (rows.length < 2) return { rows: [], cols: {} };
    const head = rows[0].map(h => String(h).toLowerCase().trim());
    const find = re => head.findIndex(h => re.test(h));
    const cols = {
      email: find(/e-?mail/), company: find(/company|organi[sz]ation|business/), first: find(/first.?name|forename|given/), last: find(/last.?name|surname|family/),
      name: find(/^(full.?)?name$|contact/), phone: find(/phone|mobile|tel/), date: find(/date.?(added|created|registered|joined|signed)|registered|created|joined/)
    };
    const g = (r, i) => i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '';
    const out = rows.slice(1).map(r => {
      const person = [g(r, cols.first), g(r, cols.last)].filter(Boolean).join(' ') || g(r, cols.name);
      let date = g(r, cols.date); const m = date.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
      if (m) date = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); else if (/^\d{4}-\d{2}-\d{2}/.test(date)) date = date.slice(0, 10); else date = '';
      return { company: g(r, cols.company), contact_name: person, email: g(r, cols.email), phone: g(r, cols.phone), date_added: date };
    }).filter(r => r.company || r.contact_name);
    return { rows: out, cols };
  }
  function showImport() {
    modal(`<h3>Import a customer file</h3><p class="nc-dim">A CSV export of customers (for example from the DecoNetwork Business Hub customer list). It looks for columns called email, company, first name, last name (or name), phone and date added. People already in New customers (same email) are skipped.</p>
      <input type="file" id="nciFile" accept=".csv,text/csv"><div id="nciPreview" class="nc-dim" style="margin-top:10px"></div>
      <div class="nc-modal-row"><button type="button" class="nc-btn nc-primary" id="nciGo" disabled>Import</button><button type="button" class="nc-btn" data-modal-close>Cancel</button></div>`,
    m => {
      let parsed = null;
      m.querySelector('#nciFile').addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0]; if (!file) return;
        const pv = $('nciPreview'), go = $('nciGo'); go.disabled = true;
        if (file.size > 5 * 1024 * 1024) { pv.textContent = 'That file is too big (5 MB at most).'; return; }
        try { parsed = mapCsv(parseCsv(await file.text())); } catch (err) { pv.textContent = 'Could not read that file.'; return; }
        if (!parsed.rows.length) { pv.textContent = 'No customers found. The first row needs column headings such as Email and Company.'; return; }
        if (parsed.rows.length > 2000) { pv.textContent = 'That is more than 2,000 rows. Please split the file.'; return; }
        const found = Object.keys(parsed.cols).filter(k => parsed.cols[k] >= 0).join(', ');
        pv.innerHTML = `<b>${plural(parsed.rows.length, 'customer')}</b> found (columns used: ${esc(found)}).<br>First few: ${parsed.rows.slice(0, 4).map(r => esc(r.company || r.contact_name) + (r.email ? ' &lt;' + esc(r.email) + '&gt;' : '')).join(' · ')}`;
        go.disabled = false;
      });
      m.querySelector('#nciGo').addEventListener('click', async () => {
        if (!parsed || !parsed.rows.length) return;
        const go = $('nciGo'); go.disabled = true; go.textContent = 'Importing…';
        let added = 0, there = 0, bad = 0;
        try {
          for (let i = 0; i < parsed.rows.length; i += 500) {
            const res = await client().rpc('nc_import', { p_rows: parsed.rows.slice(i, i + 500) });
            if (res.error) throw res.error;
            added += num(res.data.added); there += num(res.data.already_there); bad += num(res.data.skipped_bad_rows);
          }
          closeModal(); toast(`Imported ${added}. ${there ? there + ' already there. ' : ''}${bad ? bad + ' rows skipped (no name or a bad email).' : ''}`);
          await load(true);
        } catch (err) {
          toast('Import stopped: ' + ((err && err.message) || 'try again') + (added ? ' (' + added + ' were added first)' : ''), true);
          go.disabled = false; go.textContent = 'Import'; if (added) load(true);
        }
      });
    });
  }

  async function syncDeco(btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await client().rpc('nc_sync_from_deco', { p_days: SYNC_DAYS });
      if (res.error) throw res.error;
      toast(num(res.data) ? `Added ${res.data} new customer${res.data === 1 ? '' : 's'} from DecoNetwork.` : 'Nobody new in the latest DecoNetwork orders.');
      await load(true);
    } catch (e) { toast('Could not check DecoNetwork: ' + ((e && e.message) || 'try again'), true); }
    finally { if (btn) btn.disabled = false; }
  }

  function toast(msg, bad) {
    const t = $('ncToast'); if (!t) return;
    t.textContent = msg; t.className = 'nc-toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = 'nc-toast'; }, 3500);
  }

  // ───────────────────────── styles ─────────────────────────
  // Same page, board and drawer rules as the Win-back tab (copied from winback.js with the names changed to nc-).
  const SHARED_CSS = `
#newcustomers .nc-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:22px 24px; border-radius:18px; border:1px solid rgba(255,255,255,.08); background:radial-gradient(120% 140% at 0% 0%, rgba(56,189,248,.16), transparent 55%), radial-gradient(90% 120% at 100% 0%, rgba(99,102,241,.14), transparent 60%), rgba(15,23,42,.55); }
#newcustomers .nc-head h2 { margin:0 0 6px; font-size:28px; }
#newcustomers .nc-head p { margin:0; color:#94a3b8; font-size:14px; max-width:760px; line-height:1.5; }
#newcustomers .nc-head .eyebrow { margin-bottom:4px; }
#newcustomers .nc-updated { font-size:11.5px; color:#64748b; white-space:nowrap; padding-top:6px; }
#newcustomers .nc-kpis { display:grid; grid-template-columns:repeat(6,1fr); margin:22px 0 14px; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.82); overflow:hidden; }
#newcustomers .nc-kpi { position:relative; padding:16px 18px; border-right:1px solid rgba(255,255,255,.08); min-width:0; animation:ncUp .5s both; animation-delay:calc(var(--i,0) * 60ms); }
#newcustomers .nc-kpi:last-child { border-right:none; }
#newcustomers .nc-kpi .nc-spark { position:absolute; right:14px; top:16px; }
#newcustomers .nc-kpi-n { font-size:28px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
#newcustomers .nc-kpi-attn .nc-kpi-n { color:#fbbf24; }
#newcustomers .nc-kpi-good .nc-kpi-n { color:#4ade80; }
#newcustomers .nc-kpi-l { font-size:12.5px; color:#cbd5e1; margin-top:8px; }
#newcustomers .nc-kpi-s { font-size:11px; color:#64748b; margin-top:2px; }
@keyframes ncUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
#newcustomers .nc-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:12px; }
#newcustomers .nc-tabs { display:flex; gap:6px; flex-wrap:wrap; flex:1; min-width:260px; }
#newcustomers .nc-tab { padding:8px 14px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background:transparent; color:#94a3b8; font-size:12.5px; font-weight:600; cursor:pointer; }
#newcustomers .nc-tab:hover { color:#e2e8f0; border-color:rgba(255,255,255,.25); }
#newcustomers .nc-tab.active { background:rgba(56,189,248,.14); border-color:rgba(56,189,248,.5); color:#e0f2fe; }
#newcustomers .nc-tab-n { display:inline-block; min-width:18px; margin-left:6px; padding:1px 6px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; text-align:center; font-variant-numeric:tabular-nums; }
#newcustomers .nc-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
#newcustomers .nc-seg { display:inline-flex; border:1px solid rgba(255,255,255,.12); border-radius:8px; overflow:hidden; }
#newcustomers .nc-seg button { padding:7px 12px; background:transparent; border:none; border-right:1px solid rgba(255,255,255,.1); color:#94a3b8; font-size:12px; font-weight:600; cursor:pointer; }
#newcustomers .nc-seg button:last-child { border-right:none; }
#newcustomers .nc-seg button.on { background:rgba(56,189,248,.16); color:#e0f2fe; }
#newcustomers select, #newcustomers input[type=search] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:rgba(15,23,42,.9); color:#e2e8f0; font-size:12.5px; max-width:230px; }
#newcustomers input[type=search] { min-width:200px; }
#newcustomers .nc-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
#newcustomers .nc-btn:hover { background:rgba(255,255,255,.06); }
#newcustomers .nc-btn:disabled { opacity:.5; cursor:default; }
#newcustomers .nc-primary, .nc-drawer .nc-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }
#newcustomers .nc-primary:hover, .nc-drawer .nc-primary:hover { background:linear-gradient(135deg,#38bdf8,#6366f1); opacity:.9; }
#newcustomers :focus-visible, .nc-drawer :focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
#newcustomers .nc-empty { padding:50px 20px; text-align:center; color:#94a3b8; border:1px dashed rgba(255,255,255,.14); border-radius:14px; line-height:2; }
#newcustomers .nc-dim { color:#64748b; font-size:12px; }
#newcustomers .nc-first { margin-bottom:18px; padding:16px 18px; border-radius:16px; border:1px solid rgba(245,158,11,.28); background:linear-gradient(135deg, rgba(245,158,11,.1), rgba(15,23,42,.6) 55%); }
#newcustomers .nc-first-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:12px; }
#newcustomers .nc-first-h h3 { margin:0; font-size:15px; }
#newcustomers .nc-first-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
#newcustomers .nc-first-card { padding:13px 14px; border-radius:12px; background:rgba(2,6,23,.55); border:1px solid rgba(255,255,255,.08); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s; animation:ncUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#newcustomers .nc-first-card:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.25); border-left-color:var(--c); }
#newcustomers .nc-first-val { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
#newcustomers .nc-first-cust { font-size:13px; font-weight:600; margin:2px 0 8px; overflow-wrap:anywhere; }
#newcustomers .nc-first-meta { display:flex; align-items:center; gap:7px; font-size:11.5px; color:#94a3b8; }
#newcustomers .nc-first-meta > span:not(.nc-av) { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#newcustomers .nc-first-meta b { color:var(--c); font-weight:600; white-space:nowrap; }
#newcustomers .nc-reply { display:inline-block; margin:0 0 8px; padding:3px 9px; border-radius:7px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; font-size:11px; font-weight:600; }
.nc-drawer .nc-reply-lg { display:block; margin:0 0 14px; padding:9px 12px; font-size:12.5px; border-radius:10px; background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); color:#bbf7d0; }
#newcustomers .nc-funnel-box { margin-bottom:18px; }
#newcustomers .nc-funnel { display:flex; gap:4px; height:34px; }
#newcustomers .nc-fseg { display:flex; align-items:center; padding:0 12px; min-width:0; border-radius:8px; background:linear-gradient(90deg, color-mix(in srgb, var(--c) 70%, #020617), color-mix(in srgb, var(--c) 45%, #020617)); font-size:12px; font-weight:700; overflow:hidden; white-space:nowrap; animation:ncGrow .7s both; transform-origin:left; }
@keyframes ncGrow { from { transform:scaleX(0); opacity:0; } to { transform:none; opacity:1; } }
#newcustomers .nc-flegend { display:flex; gap:16px; flex-wrap:wrap; margin-top:8px; font-size:11.5px; color:#94a3b8; }
#newcustomers .nc-flegend i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:6px; background:var(--c); }
#newcustomers .nc-board { width:0; min-width:100%; display:grid; grid-template-columns:repeat(5,minmax(205px,1fr)); gap:12px; overflow-x:auto; padding-bottom:10px; align-items:start; }
#newcustomers .nc-col { background:rgba(15,23,42,.6); border:1px solid rgba(255,255,255,.08); border-top:3px solid var(--c); border-radius:14px; min-width:205px; }
#newcustomers .nc-col-h { padding:12px 14px 10px; border-bottom:1px solid rgba(255,255,255,.06); background:linear-gradient(180deg, color-mix(in srgb, var(--c) 10%, transparent), transparent); border-radius:12px 12px 0 0; }
#newcustomers .nc-col-t { font-weight:700; font-size:13.5px; }
#newcustomers .nc-col-n { margin-left:8px; padding:1px 8px; border-radius:9px; background:rgba(255,255,255,.08); font-size:11px; font-variant-numeric:tabular-nums; }
#newcustomers .nc-col-s { font-size:11px; color:#64748b; margin-top:4px; }
#newcustomers .nc-col-b { padding:10px; display:flex; flex-direction:column; gap:8px; max-height:68vh; overflow-y:auto; }
#newcustomers .nc-col-empty { padding:24px 0; text-align:center; color:#475569; font-size:12px; }
#newcustomers .nc-card { padding:11px 12px; border-radius:11px; background:rgba(30,41,59,.7); border:1px solid rgba(255,255,255,.07); border-left:3px solid var(--c); cursor:pointer; transition:transform .15s, border-color .15s, background .15s, box-shadow .15s; animation:ncUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#newcustomers .nc-card:hover { transform:translateY(-2px); background:rgba(51,65,85,.7); border-color:rgba(255,255,255,.18); border-left-color:var(--c); box-shadow:0 10px 30px rgba(0,0,0,.35), 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent); }
#newcustomers .nc-card-top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
#newcustomers .nc-card-cust { font-weight:600; font-size:13px; line-height:1.3; overflow-wrap:anywhere; }
#newcustomers .nc-card-job { margin-top:3px; font-size:11.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#newcustomers .nc-card-val { font-weight:700; font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }
#newcustomers .nc-card-mid { display:flex; align-items:center; gap:7px; margin:8px 0; font-size:11.5px; color:#94a3b8; }
#newcustomers .nc-card-rep { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#newcustomers .nc-card-id { color:#64748b; font-variant-numeric:tabular-nums; }
#newcustomers .nc-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.08); overflow:hidden; }
#newcustomers .nc-bar i { display:block; height:100%; border-radius:2px; }
#newcustomers .nc-card-foot { display:flex; justify-content:space-between; gap:8px; margin-top:7px; font-size:11px; color:#94a3b8; }
#newcustomers .nc-quick { margin-top:9px; width:100%; padding:6px 10px; border-radius:8px; border:1px solid color-mix(in srgb, var(--c, #38bdf8) 55%, transparent); background:color-mix(in srgb, var(--c, #38bdf8) 12%, transparent); color:#f1f5f9; font-size:11.5px; font-weight:600; cursor:pointer; }
#newcustomers .nc-quick:hover { background:color-mix(in srgb, var(--c, #38bdf8) 26%, transparent); }
#newcustomers .nc-quick:disabled { opacity:.6; cursor:default; }
.nc-av { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; font-size:10px; font-weight:700; color:#fff; flex:none; }
#newcustomers .nc-rep { display:inline-flex; align-items:center; gap:8px; }
.nc-chip { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:600; color:var(--c); background:color-mix(in srgb, var(--c) 14%, transparent); border:1px solid color-mix(in srgb, var(--c) 40%, transparent); }
#newcustomers .nc-tablewrap { width:0; min-width:100%; overflow-x:auto; border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); }
#newcustomers .nc-table { width:100%; border-collapse:collapse; font-size:13px; }
#newcustomers .nc-table th { text-align:left; padding:11px 14px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,.1); cursor:pointer; white-space:nowrap; user-select:none; }
#newcustomers .nc-table th.sorted { color:#e0f2fe; }
#newcustomers .nc-table td { padding:11px 14px; border-bottom:1px solid rgba(255,255,255,.05); white-space:nowrap; }
#newcustomers .nc-table .r, #newcustomers .nc-table th.r { text-align:right; font-variant-numeric:tabular-nums; }
#newcustomers .nc-table tbody tr { cursor:pointer; }
#newcustomers .nc-table tbody tr:hover { background:rgba(56,189,248,.07); }
#newcustomers .nc-tfoot { margin-top:10px; font-size:12px; color:#94a3b8; text-align:right; }
#newcustomers .nc-chartbox { border:1px solid rgba(255,255,255,.1); border-radius:14px; background:rgba(15,23,42,.6); padding:16px 18px; margin-bottom:22px; }
#newcustomers .nc-chart-h, #newcustomers .nc-team-h { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:10px; }
#newcustomers .nc-chart-h h3, #newcustomers .nc-team-h h3 { margin:0; font-size:15px; }
#newcustomers .nc-chart { position:relative; height:220px; }
#newcustomers .nc-team { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
#newcustomers .nc-rep-card { padding:16px; border-radius:16px; border:1px solid rgba(255,255,255,.1); border-top:3px solid hsl(var(--h,200) 65% 55%); background:linear-gradient(180deg, hsl(var(--h,200) 60% 50% / .07), rgba(15,23,42,.85) 40%); cursor:pointer; transition:border-color .15s, transform .15s; animation:ncUp .4s both; animation-delay:calc(var(--i,0) * 40ms); }
#newcustomers .nc-rep-card:hover { border-color:rgba(56,189,248,.5); transform:translateY(-2px); }
#newcustomers .nc-rep-card.sel { border-color:#38bdf8; box-shadow:0 0 0 1px #38bdf8 inset; }
#newcustomers .nc-rep-card header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
#newcustomers .nc-rep-id { display:flex; align-items:center; gap:10px; min-width:0; }
#newcustomers .nc-rep-id .nc-av { width:38px; height:38px; font-size:14px; }
#newcustomers .nc-rep-name { font-weight:700; font-size:15px; }
#newcustomers .nc-medal { font-size:15px; }
#newcustomers .nc-rep-sub { font-size:11.5px; color:#94a3b8; margin-top:2px; }
#newcustomers .nc-rep-sub.warn, #newcustomers .nc-rep-grid .warn b { color:#fbbf24; }
#newcustomers .nc-ring { --p:0; width:68px; height:68px; border-radius:50%; flex:none; display:grid; place-items:center; background:conic-gradient(#22c55e calc(var(--p) * 1%), rgba(255,255,255,.09) 0); }
#newcustomers .nc-ring > div { width:54px; height:54px; border-radius:50%; background:#0f172a; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.1; }
#newcustomers .nc-ring b { font-size:15px; }
#newcustomers .nc-ring span { font-size:8px; color:#94a3b8; text-transform:uppercase; letter-spacing:.04em; }
#newcustomers .nc-rep-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px 8px; }
#newcustomers .nc-rep-grid b { display:block; font-size:15px; font-variant-numeric:tabular-nums; }
#newcustomers .nc-rep-grid span { font-size:10.5px; color:#64748b; }
#newcustomers .nc-split { display:flex; gap:2px; height:6px; border-radius:3px; overflow:hidden; margin-top:14px; }
#newcustomers .nc-split i { display:block; }
#newcustomers .nc-spark-row { display:flex; align-items:center; gap:10px; margin-top:12px; font-size:11px; color:#64748b; }
#newcustomers .nc-spark-row .nc-spark { flex:none; }
#newcustomers .nc-rep-card footer { display:flex; justify-content:space-between; gap:8px; margin-top:14px; padding-top:11px; border-top:1px solid rgba(255,255,255,.07); font-size:11.5px; color:#94a3b8; }
#newcustomers .nc-sk { border-radius:10px; background:linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.1), rgba(255,255,255,.04)); background-size:200% 100%; animation:wbShim 1.3s infinite linear; }
@keyframes wbShim { from { background-position:200% 0; } to { background-position:-200% 0; } }
#newcustomers .nc-toast, .nc-toast { position:fixed; left:50%; bottom:26px; transform:translate(-50%,20px); opacity:0; pointer-events:none; padding:11px 18px; border-radius:10px; background:#0f172a; border:1px solid rgba(34,197,94,.5); color:#dcfce7; font-size:13px; z-index:2000; transition:all .2s; }
.nc-toast.show { opacity:1; transform:translate(-50%,0); }
.nc-toast.bad { border-color:rgba(248,113,113,.6); color:#fecaca; }
.nc-nav-badge { margin-left:8px; padding:1px 8px; border-radius:9px; background:#fbbf24; color:#1e293b; font-size:11px; font-weight:700; }
body.nc-lock { overflow:hidden; }
.nc-drawer { position:fixed; inset:0; z-index:1500; visibility:hidden; }
.nc-drawer.open { visibility:visible; }
.nc-drawer .nc-backdrop { position:absolute; inset:0; background:rgba(2,6,23,.65); backdrop-filter:blur(3px); opacity:0; transition:opacity .2s; }
.nc-drawer.open .nc-backdrop { opacity:1; }
.nc-drawer .nc-sheet { position:absolute; top:0; right:0; bottom:0; width:min(480px,100%); background:#0b1220; border-left:1px solid rgba(255,255,255,.12); padding:22px; overflow-y:auto; transform:translateX(100%); transition:transform .25s ease; outline:none; color:#f8fafc; }
.nc-drawer.open .nc-sheet { transform:none; }
.nc-drawer .nc-d-top { display:flex; justify-content:space-between; gap:12px; border-top:3px solid var(--c); margin:-22px -22px 0; padding:18px 22px 0; }
.nc-drawer .nc-d-eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#64748b; }
.nc-drawer h3 { margin:4px 0 6px; font-size:21px; line-height:1.25; overflow-wrap:anywhere; }
.nc-drawer .nc-d-job { margin:0 0 10px; font-size:13px; color:#94a3b8; }
.nc-drawer .nc-x { width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:transparent; color:#e2e8f0; font-size:20px; cursor:pointer; flex:none; }
.nc-drawer .nc-d-val { margin:16px 0 14px; font-size:32px; font-weight:700; font-variant-numeric:tabular-nums; }
.nc-drawer .nc-d-val span { margin-left:10px; font-size:12px; color:#94a3b8; font-weight:400; }
.nc-drawer .nc-deco { display:inline-block; margin:0 0 16px; padding:7px 12px; border-radius:8px; border:1px solid rgba(56,189,248,.45); color:#bae6fd; font-size:12.5px; font-weight:600; text-decoration:none; }
.nc-drawer .nc-deco:hover { background:rgba(56,189,248,.12); }
.nc-drawer .nc-facts { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.07); border-radius:12px; overflow:hidden; }
.nc-drawer .nc-facts > div { background:#0f172a; padding:11px 13px; min-width:0; }
.nc-drawer .nc-facts > div > span { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin-bottom:3px; }
.nc-drawer .nc-facts b { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.nc-drawer .nc-facts a { color:#7dd3fc; font-weight:400; }
.nc-drawer .nc-rep { display:inline-flex; align-items:center; gap:8px; }
.nc-drawer .nc-chase { margin-top:20px; padding:14px; border-radius:12px; background:rgba(56,189,248,.07); border:1px solid rgba(56,189,248,.25); }
.nc-drawer .nc-chase h4, .nc-drawer .nc-d-h { margin:0 0 10px; font-size:13px; }
.nc-drawer .nc-d-h { margin:22px 0 10px; }
.nc-drawer .nc-chase-row { display:flex; gap:8px; flex-wrap:wrap; }
.nc-drawer .nc-chase select, .nc-drawer .nc-chase input { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font-size:13px; }
.nc-drawer .nc-chase input { flex:1; min-width:140px; }
.nc-drawer .nc-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); background:transparent; }
.nc-drawer .nc-btn:disabled { opacity:.5; }
.nc-drawer .nc-dim { color:#64748b; font-size:12px; }
.nc-drawer .nc-chase p { margin:10px 0 0; }
.nc-drawer .nc-timeline { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px; }
.nc-drawer .nc-timeline li { display:flex; gap:11px; font-size:13px; line-height:1.4; }
.nc-drawer .nc-hist { display:none; position:absolute; top:0; bottom:0; left:0; right:calc(min(480px,100%) + 44px); padding:22px 26px 22px 22px; overflow-y:auto; pointer-events:none; opacity:0; transform:translateX(24px); transition:opacity .25s .05s, transform .25s .05s; color:#f8fafc; }
.nc-drawer.open .nc-hist { opacity:1; transform:none; }
@media (min-width: 1180px) { .nc-drawer .nc-hist { display:block; } }
@media (prefers-reduced-motion: reduce) { .nc-drawer .nc-hist { transition:none !important; } }
.nc-drawer .nc-timeline li.good { color:#86efac; } .nc-drawer .nc-timeline li.bad { color:#fca5a5; }
.nc-drawer .nc-tl-i { width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,.07); display:grid; place-items:center; font-size:12px; flex:none; }
@media (max-width: 1100px) { #newcustomers .nc-kpis { grid-template-columns:repeat(3,1fr); } #newcustomers .nc-kpi:nth-child(3n) { border-right:none; } #newcustomers .nc-kpi:nth-child(-n+3) { border-bottom:1px solid rgba(255,255,255,.08); } }
@media (max-width: 640px) { #newcustomers .nc-head { padding:16px; flex-direction:column; } #newcustomers .nc-kpi .nc-spark { display:none; }
  #newcustomers .nc-kpis { grid-template-columns:repeat(2,1fr); } #newcustomers .nc-kpi:nth-child(3n) { border-right:1px solid rgba(255,255,255,.08); } #newcustomers .nc-kpi:nth-child(2n) { border-right:none; } #newcustomers .nc-kpi { border-bottom:1px solid rgba(255,255,255,.08); }
  #newcustomers .nc-board { grid-template-columns:repeat(5,82vw); scroll-snap-type:x mandatory; } #newcustomers .nc-col { scroll-snap-align:start; }
  #newcustomers input[type=search] { min-width:0; flex:1; } .nc-drawer .nc-facts { grid-template-columns:1fr; } }
@media (prefers-reduced-motion: reduce) { #newcustomers *, #newcustomers *::before, #newcustomers *::after, .nc-drawer .nc-sheet, .nc-drawer .nc-backdrop { animation:none !important; transition:none !important; } }

#newcustomers .nc-head { background:radial-gradient(120% 140% at 0% 0%, rgba(249,115,22,.18), transparent 60%), radial-gradient(90% 120% at 100% 0%, rgba(139,92,246,.14), transparent 55%), rgba(15,23,42,.85); }
#newcustomers .nc-tab.active { background:rgba(249,115,22,.14); border-color:rgba(249,115,22,.55); color:#ffedd5; }
#newcustomers .nc-seg button.on { background:rgba(249,115,22,.16); color:#ffedd5; }
#newcustomers .nc-primary, .nc-drawer .nc-primary { background:linear-gradient(135deg,#f97316,#ec4899); }
#newcustomers .nc-primary:hover, .nc-drawer .nc-primary:hover { background:linear-gradient(135deg,#f97316,#ec4899); }
#newcustomers :focus-visible, .nc-drawer :focus-visible { outline-color:#fb923c; }
#newcustomers .nc-board { grid-template-columns:repeat(6,minmax(215px,1fr)); }
#newcustomers .nc-col { min-width:215px; }
#newcustomers .nc-value-line { margin:0 0 14px; font-size:13px; color:#cbd5e1; }
#newcustomers .nc-value-line b { color:#fdba74; font-size:15px; }
#newcustomers .nc-card-sub { margin-top:3px; font-size:11.5px; color:#94a3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#newcustomers .nc-card-val small { display:block; font-size:9.5px; font-weight:500; color:#64748b; text-align:right; }
#newcustomers .nc-flags { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 8px; }
#newcustomers .nc-flag { display:inline-block; padding:2px 8px; border-radius:7px; font-size:10.5px; font-weight:600; border:1px solid rgba(255,255,255,.16); color:#cbd5e1; background:rgba(255,255,255,.05); }
#newcustomers .nc-flag.hot { border-color:rgba(251,191,36,.5); color:#fde68a; background:rgba(251,191,36,.12); }
#newcustomers .nc-flag.good { border-color:rgba(34,197,94,.45); color:#bbf7d0; background:rgba(34,197,94,.12); }
#newcustomers .nc-flag.cool { border-color:rgba(56,189,248,.45); color:#bae6fd; background:rgba(56,189,248,.1); }
#newcustomers .nc-flag.purple { border-color:rgba(167,139,250,.5); color:#ddd6fe; background:rgba(167,139,250,.12); }
#newcustomers .nc-flag.dim { color:#94a3b8; }
#newcustomers .nc-qchip { display:flex; justify-content:space-between; gap:8px; align-items:center; margin:0 0 7px; padding:6px 9px; border-radius:9px; background:rgba(34,211,238,.08); border:1px solid rgba(34,211,238,.28); font-size:11.5px; color:#cffafe; }
#newcustomers .nc-qchip.cold { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.3); color:#cbd5e1; }
#newcustomers .nc-qchip b { font-variant-numeric:tabular-nums; }
#newcustomers .nc-qchip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
#newcustomers .nc-quickrow { display:flex; gap:6px; margin-top:9px; }
#newcustomers .nc-quickrow .nc-quick { margin-top:0; }
#newcustomers .nc-quickrow .nc-quick.alt { width:auto; flex:none; background:transparent; border-color:rgba(255,255,255,.16); color:#cbd5e1; }
#newcustomers .nc-bar i.over { background:repeating-linear-gradient(45deg,#ef4444,#ef4444 6px,#f97316 6px,#f97316 12px) !important; }
#newcustomers .nc-more { width:100%; padding:8px; border-radius:9px; border:1px dashed rgba(255,255,255,.2); background:transparent; color:#94a3b8; font-size:12px; cursor:pointer; }
#newcustomers .nc-more:hover { color:#e2e8f0; border-color:rgba(255,255,255,.4); }
#newcustomers .nc-first { border-color:rgba(249,115,22,.3); background:linear-gradient(135deg, rgba(249,115,22,.1), rgba(15,23,42,.6) 55%); }
#newcustomers .nc-hint { font-size:12px; color:#94a3b8; }
#newcustomers .nc-check { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#94a3b8; cursor:pointer; }
#newcustomers .nc-linkrow input[type=text] { padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:rgba(15,23,42,.9); color:#e2e8f0; font-size:12.5px; width:min(340px,100%); }
#newcustomers .nc-linkrow td { white-space:normal; }
#newcustomers .nc-linkrow .nc-btn { margin-right:6px; }
#newcustomers .nc-note { margin:0 0 14px; padding:12px 14px; border-radius:12px; background:rgba(56,189,248,.07); border:1px solid rgba(56,189,248,.25); font-size:12.5px; color:#cbd5e1; line-height:1.5; }
.nc-drawer .nc-chase { background:rgba(249,115,22,.07); border-color:rgba(249,115,22,.28); }
.nc-drawer .nc-chase label { display:block; margin:0 0 4px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
.nc-drawer .nc-field { flex:1; min-width:130px; }
.nc-drawer .nc-field select, .nc-drawer .nc-field input, .nc-drawer textarea { width:100%; box-sizing:border-box; }
.nc-drawer textarea { margin-top:8px; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font:inherit; font-size:13px; min-height:60px; resize:vertical; }
.nc-drawer .nc-chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.nc-drawer .nc-chips button { padding:3px 9px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:transparent; color:#cbd5e1; font-size:11px; cursor:pointer; }
.nc-drawer .nc-chips button:hover { background:rgba(255,255,255,.08); }
.nc-drawer .nc-submit { margin-top:10px; width:100%; padding:10px; }
.nc-drawer .nc-other { margin-top:16px; padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.03); }
.nc-drawer .nc-other h4 { margin:0 0 8px; font-size:12.5px; }
.nc-drawer .nc-other .nc-chase-row { align-items:center; }
.nc-drawer .nc-dq { display:block; margin:0 0 8px; padding:9px 11px; border-radius:10px; background:#0f172a; border:1px solid rgba(255,255,255,.08); font-size:12.5px; }
.nc-drawer .nc-dq-top { display:flex; justify-content:space-between; gap:8px; font-weight:600; }
.nc-drawer .nc-dq-sub { margin-top:3px; color:#94a3b8; font-size:11.5px; }
.nc-drawer .nc-dq a { color:#7dd3fc; font-weight:600; font-size:11.5px; }
.nc-drawer .nc-banner { display:block; margin:14px 0 0; padding:9px 12px; font-size:12.5px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05); color:#e2e8f0; }
.nc-drawer .nc-banner.good { background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.4); color:#bbf7d0; }
.nc-drawer .nc-banner.warn { background:rgba(251,191,36,.12); border-color:rgba(251,191,36,.4); color:#fde68a; }
.nc-drawer .nc-banner.purple { background:rgba(167,139,250,.12); border-color:rgba(167,139,250,.4); color:#ddd6fe; }
.nc-drawer .nc-d-val { font-size:26px; }
@media (max-width: 640px) { #newcustomers .nc-board { grid-template-columns:repeat(6,82vw); } }
#newcustomers .nc-quick { white-space:nowrap; padding:6px 8px; font-size:11.5px; }
#newcustomers .nc-quickrow .nc-quick:not(.alt) { flex:1; min-width:0; }
#newcustomers .nc-first-meta { flex-wrap:wrap; }
#newcustomers .nc-first-meta b { white-space:normal; }
#newcustomers .nc-first-meta > span:not(.nc-av) { flex:0 1 auto; max-width:50%; }
#newcustomers .nc-board { grid-template-columns:repeat(6,minmax(200px,1fr)); }
#newcustomers .nc-col { min-width:200px; }
#newcustomers .nc-rep-card footer { flex-wrap:wrap; }
@media (max-width: 640px) { #newcustomers .nc-board { grid-template-columns:repeat(6,82vw); } }
#newcustomers .nc-quickrow { flex-wrap:wrap; }
#newcustomers .nc-quickrow .nc-quick, #newcustomers .nc-quickrow .nc-quick.alt, #newcustomers .nc-quickrow .nc-quick:not(.alt) { width:auto; flex:1 1 auto; min-width:max-content; }
`;

  function injectStyles() {
    if ($('ncStyles')) return;
    const s = document.createElement('style');
    s.id = 'ncStyles';
    // the page, board and drawer share their look with the Win-back tab (same rules, nc- names)
    s.textContent = SHARED_CSS + `
#newcustomers .nc-card-src { font-size:9.5px; font-weight:600; padding:2px 7px; border-radius:7px; background:rgba(255,255,255,.06); color:#94a3b8; white-space:nowrap; align-self:flex-start; }
#newcustomers .nc-ichips, .nc-hist .nc-ichips { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 8px; }
#newcustomers .nc-ichips span { padding:2px 8px; border-radius:7px; font-size:10.5px; font-weight:600; background:rgba(34,197,94,.1); border:1px solid rgba(34,197,94,.3); color:#bbf7d0; }
#newcustomers .nc-ichips span.more { background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.14); color:#94a3b8; }
#newcustomers .nc-ichips.big span { font-size:12px; padding:4px 10px; }
#newcustomers .nc-card-foot { display:flex; justify-content:space-between; gap:8px; margin-top:8px; font-size:11.5px; color:#94a3b8; }
#newcustomers .nc-int-wrap { display:grid; grid-template-columns:minmax(0,2fr) minmax(220px,1fr); gap:24px; align-items:start; }
#newcustomers .nc-int-row { display:grid; grid-template-columns:180px 1fr 40px; gap:12px; align-items:center; width:100%; padding:7px 4px; border:none; background:transparent; color:#e2e8f0; font-size:13px; text-align:left; cursor:pointer; border-radius:8px; }
#newcustomers .nc-int-row:hover { background:rgba(34,197,94,.08); }
#newcustomers .nc-int-row > div { height:10px; background:rgba(255,255,255,.07); border-radius:5px; overflow:hidden; }
#newcustomers .nc-int-row i { display:block; height:100%; background:linear-gradient(90deg,#22c55e,#38bdf8); }
#newcustomers .nc-int-row em { font-style:normal; color:#94a3b8; text-align:right; font-variant-numeric:tabular-nums; }
#newcustomers .nc-int-side h4 { margin:0 0 8px; font-size:13px; }
#newcustomers .nc-filter-note { font-size:12.5px; color:#cbd5e1; margin:0 0 12px; }
@media (max-width: 800px) { #newcustomers .nc-int-wrap { grid-template-columns:1fr; } #newcustomers .nc-int-row { grid-template-columns:120px 1fr 32px; } }
.nc-drawer .nc-steps { margin-top:18px; padding:14px; border-radius:12px; background:rgba(34,197,94,.06); border:1px solid rgba(34,197,94,.25); }
.nc-drawer .nc-steps h4, .nc-drawer .nc-details h4 { margin:0 0 10px; font-size:13px; }
.nc-drawer .nc-step { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid rgba(255,255,255,.06); font-size:13px; }
.nc-drawer .nc-step:first-of-type { border-top:none; }
.nc-drawer .nc-step-i { width:22px; height:22px; border-radius:50%; display:grid; place-items:center; flex:none; font-size:12px; background:rgba(255,255,255,.07); color:#94a3b8; }
.nc-drawer .nc-step.done .nc-step-i { background:rgba(34,197,94,.25); color:#bbf7d0; }
.nc-drawer .nc-step-t { flex:1; min-width:0; }
.nc-drawer .nc-details, .nc-drawer .nc-sum, .nc-drawer .nc-edit { margin-top:18px; padding:14px; border-radius:12px; background:rgba(15,23,42,.8); border:1px solid rgba(255,255,255,.1); }
.nc-drawer .nc-sum summary, .nc-drawer .nc-edit summary { cursor:pointer; font-size:13px; font-weight:600; }
.nc-drawer .nc-sum pre { margin:12px 0; padding:10px; border-radius:8px; background:#0b1220; font:12px/1.5 inherit; white-space:pre-wrap; overflow-wrap:anywhere; color:#cbd5e1; }
.nc-drawer .nc-lbl, .nc-drawer .nc-details label, .nc-drawer .nc-edit label, .nc-modal label { display:block; margin:12px 0 4px; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
.nc-drawer .nc-chipgrid { display:flex; flex-wrap:wrap; gap:6px; }
.nc-drawer .nc-chipbtn { padding:5px 11px; border-radius:999px; font-size:12px; font-weight:600; cursor:pointer; color:#cbd5e1; border:1px solid rgba(255,255,255,.18); background:transparent; }
.nc-drawer .nc-chipbtn:hover { background:rgba(34,197,94,.12); }
.nc-drawer .nc-chipbtn.on { color:#fff; background:rgba(34,197,94,.28); border-color:rgba(34,197,94,.7); }
.nc-drawer .nc-two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.nc-drawer .nc-details input, .nc-drawer .nc-details select, .nc-drawer .nc-details textarea, .nc-drawer .nc-edit input, .nc-drawer .nc-edit select, .nc-modal input:not([type=file]), .nc-modal select, .nc-modal textarea { width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.14); background:#0f172a; color:#e2e8f0; font:inherit; font-size:13px; }
.nc-drawer .nc-details textarea, .nc-modal textarea { min-height:70px; resize:vertical; }
.nc-drawer .nc-submit { margin-top:12px; }
.nc-drawer .nc-banner { display:block; margin:12px 0 0; padding:9px 12px; border-radius:10px; font-size:12.5px; background:rgba(148,163,184,.12); border:1px solid rgba(148,163,184,.3); color:#cbd5e1; }
.nc-drawer .nc-banner.good { background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.4); color:#bbf7d0; }
.nc-drawer .nc-banner.warn { background:rgba(245,158,11,.14); border-color:rgba(245,158,11,.4); color:#fde68a; }
.nc-drawer .nc-banner.purple { background:rgba(167,139,250,.14); border-color:rgba(167,139,250,.4); color:#ddd6fe; }
.nc-modal { position:fixed; inset:0; z-index:1600; background:rgba(2,6,23,.7); backdrop-filter:blur(3px); display:grid; place-items:center; padding:16px; }
.nc-modal-box { width:min(560px,100%); max-height:90vh; overflow-y:auto; background:#0b1220; border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:22px; color:#f8fafc; }
.nc-modal-box h3 { margin:0 0 6px; font-size:20px; }
.nc-modal .nc-two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.nc-modal-row { display:flex; gap:8px; margin-top:16px; }
.nc-modal .nc-btn { padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; color:#e2e8f0; border:1px solid rgba(255,255,255,.14); background:transparent; }
.nc-modal .nc-btn:disabled { opacity:.5; cursor:default; }
.nc-modal .nc-primary { background:linear-gradient(135deg,#22c55e,#38bdf8); border:none; color:#04210f; }
.nc-modal .nc-dim { color:#94a3b8; font-size:12.5px; line-height:1.5; }
@media (max-width: 640px) { .nc-drawer .nc-two, .nc-modal .nc-two { grid-template-columns:1fr; } }
`;
    // the email box rules (from quotes.js) are reused by giving them the same look under the new drawer
    document.head.appendChild(s);
  }

  // ───────────────────────── page ─────────────────────────
  function installPage() {
    if ($(PAGE_ID)) return true;
    const anchorBtn = document.querySelector('.nav-link[data-page="winback"]') || document.querySelector('.nav-link[data-page="quotes"]');
    const anchorPage = $('winback') || $('quotes');
    if (!anchorBtn || !anchorPage) return false;
    if (!document.querySelector('.nav-link[data-page="winback"]') && boot.tries < 16) return false;   // give the Win-back tab a moment to appear first

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-link';
    btn.dataset.page = PAGE_ID;
    btn.innerHTML = '<span>🌱 New customers</span>';
    anchorBtn.insertAdjacentElement('afterend', btn);

    const sec = document.createElement('section');
    sec.id = PAGE_ID;
    sec.className = 'dashboard-page';
    sec.innerHTML = `
      <div class="nc-head">
        <div>
          <p class="eyebrow">Sales</p>
          <h2>New customers</h2>
          <p>People who are new and have not been quoted yet. Send them a catalogue, get a login set up, find out what they want and record it, so that whoever quotes them has a good starting point. First-time customers from DecoNetwork appear here by themselves every night. Add anyone else by hand or from a customer file.</p>
        </div>
        <div class="nc-updated" id="ncUpdated" aria-live="polite"></div>
      </div>
      <p class="nc-value-line" id="ncValue"></p>
      <div class="nc-kpis" id="ncKpis"></div>
      <div class="nc-toolbar"><div class="nc-tabs" id="ncTabs" role="tablist"></div></div>
      <div class="nc-tools">
        <select id="ncOwner" aria-label="Owner"><option value="">Everyone</option></select>
        <select id="ncSource" aria-label="Source"><option value="">All sources</option></select>
        <input type="search" id="ncSearch" placeholder="Search name, email, product or note" aria-label="Search new customers">
        <button type="button" class="nc-btn nc-primary" data-act="add">＋ Add customer</button>
        <button type="button" class="nc-btn" data-act="import">⬆ Import file</button>
        <button type="button" class="nc-btn" data-act="sync" title="Looks at the latest DecoNetwork orders (refreshed every night)">Check DecoNetwork</button>
        <button type="button" class="nc-btn" data-act="reload">Refresh</button>
        <button type="button" class="nc-btn" data-act="export">⬇ Export CSV</button>
      </div>
      <p class="nc-filter-note" id="ncFilterNote"></p>
      <div id="ncBody"><div class="nc-empty">Loading…</div></div>
      <div class="nc-toast" id="ncToast" role="status"></div>`;
    anchorPage.parentElement.appendChild(sec);

    const drawer = document.createElement('div');
    drawer.className = 'nc-drawer';
    drawer.id = 'ncDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'New customer details');
    drawer.innerHTML = '<div class="nc-backdrop" data-act="close"></div><aside class="qt-hist nc-hist" id="ncHist" aria-label="Customer history"></aside><div class="nc-sheet" id="ncSheet" tabindex="-1"></div>';
    document.body.appendChild(drawer);

    // app.js binds its nav buttons once at startup, so it does not know about this page.
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dashboard-page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      sec.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      state.animate = true;
      if (!state.loaded) load(); else load(true);
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (sec.classList.contains('active') && !document.hidden) load(true); }, REFRESH_MS);
    });
    document.addEventListener('click', e => {
      const other = e.target.closest('.nav-link');
      if (other && other !== btn) { btn.classList.remove('active'); sec.classList.remove('active'); closeDrawer(); clearInterval(state.timer); }
    }, true);

    sec.addEventListener('click', e => {
      const ml = e.target.closest('[data-mail]');
      if (ml) { e.stopPropagation(); openDrawer(ml.dataset.mail); setTimeout(() => openCompose(ml.dataset.mail), 0); return; }
      const cat = e.target.closest('[data-cat]');
      if (cat) { e.stopPropagation(); mark(cat.dataset.cat, 'catalogue', true, cat, 'Catalogue marked as posted. Chase in a week.'); return; }
      const log = e.target.closest('[data-log]');
      if (log) { e.stopPropagation(); openDrawer(log.dataset.log, true); return; }
      const more = e.target.closest('[data-more]');
      if (more) { state.expanded[more.dataset.more] = true; renderBody(); return; }
      if (e.target.closest('[data-clear-interest]')) { state.interest = ''; renderControls(); renderKpis(); renderBody(); return; }
      const ib = e.target.closest('[data-interest]');
      if (ib) { state.interest = ib.dataset.interest; state.tab = 'pipeline'; renderAll(); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'reload') { load(); return; }
        if (a === 'export') { exportCsv(); return; }
        if (a === 'add') { showAdd(); return; }
        if (a === 'import') { showImport(); return; }
        if (a === 'sync') { syncDeco(act); return; }
      }
      const tab = e.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; renderControls(); renderBody(); return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        state.sort = { tab: state.tab, key: k, dir: state.sort.tab === state.tab && state.sort.key === k ? -state.sort.dir : (k === 'label' || k === 'owner' ? 1 : -1) };
        renderBody(); return;
      }
      const item = e.target.closest('[data-id]');
      if (item) openDrawer(item.dataset.id);
    });
    sec.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button, input, select, a')) return;
      const item = e.target.closest('.nc-card[data-id], .nc-first-card[data-id], tr[data-id]');
      if (item) { e.preventDefault(); openDrawer(item.dataset.id); }
    });
    $('ncOwner').addEventListener('change', e => { state.owner = e.target.value; renderAll(); });
    $('ncSource').addEventListener('change', e => { state.source = e.target.value; renderAll(); });
    $('ncSearch').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderHead(); renderKpis(); renderControls(); renderBody(); });

    drawer.addEventListener('click', e => {
      if (e.target.closest('[data-act="close"]')) { closeDrawer(); return; }
      const sb = e.target.closest('[data-step]');
      if (sb && state.openId) { mark(state.openId, sb.dataset.step, sb.dataset.on === '1', sb, sb.dataset.on === '1' ? (sb.dataset.step === 'catalogue' ? 'Catalogue marked as posted. Chase in a week.' : sb.dataset.step === 'login' ? 'Login marked as created.' : 'Marked ready to quote.') : 'Undone.'); return; }
      const mb = e.target.closest('[data-act="mail"]');
      if (mb) { openCompose(mb.dataset.for); return; }
      const ib = e.target.closest('[data-int], [data-dec]');
      if (ib) { const on = !ib.classList.contains('on'); ib.classList.toggle('on', on); ib.setAttribute('aria-pressed', String(on)); state.dirty = true; return; }
      if (e.target.closest('[data-act="copy"]')) {
        const text = ($('ncSum') || {}).textContent || '';
        const done = () => toast('Summary copied.');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy. Select the text and copy it.', true)); else toast('Select the text and copy it.', true);
        return;
      }
      if (e.target.closest('[data-act="save-contact"]')) { saveContact(e.target.closest('button')); return; }
      if (e.target.closest('[data-act="hist-retry"]') && state.openId) { histCache.delete(state.openId); loadHistory(state.openId); return; }
      const fu = e.target.closest('[data-fu]');
      if (fu) { const n = Number(fu.dataset.fu); const f = $('ncFollow'); f.value = n ? isoDay(addDays(n)) : ''; f.dataset.touched = '1'; return; }
      const stt = e.target.closest('[data-state]');
      if (stt && state.openId) {
        const a = stt.dataset.state;
        if (a === 'park') { const v = ($('ncParkDate') || {}).value; if (!v) { toast('Pick a date first.', true); return; } setCustState(state.openId, 'park', v, null, stt); }
        else if (a === 'lost') setCustState(state.openId, 'lost', null, ($('ncLostWhy') || {}).value, stt);
        else setCustState(state.openId, 'reopen', null, null, stt);
      }
    });
    drawer.addEventListener('input', e => { if (e.target.closest('#ncDetails')) state.dirty = true; });
    drawer.addEventListener('change', e => {
      if (e.target.id === 'ncOutcome') {
        const f = $('ncFollow');
        if (f && !f.dataset.touched) { const n = FOLLOW_UP[e.target.value]; f.value = n ? isoDay(addDays(n)) : ''; }
      }
      if (e.target.id === 'ncFollow') e.target.dataset.touched = '1';
      if (e.target.closest('#ncDetails')) state.dirty = true;
    });
    drawer.addEventListener('submit', async e => {
      if (e.target.id === 'ncDetails') { e.preventDefault(); saveDetails($('ncSaveDetails')); return; }
      if (e.target.id !== 'ncLogForm') return;
      e.preventDefault();
      const id = state.openId; if (!id) return;
      const res = await logContact(id, $('ncMethod').value, $('ncOutcome').value, $('ncNote').value, $('ncFollow').value, e.target.querySelector('[type=submit]'));
      if (res.ok && $('ncNote')) $('ncNote').value = '';
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('ncModal')) closeModal(); else if (state.openId) closeDrawer(); } });

    renderControls();
    return true;
  }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    injectStyles();
    if (!installPage()) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NewCustomersPage = { reload: () => load(), state };
})();
