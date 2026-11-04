// Reminders and appointments: "contact this customer (or anyone) on a date", not tied to a quote or Win-back.
// Shared by the Calendar tab (add, edit, tick off, snooze, delete), the Today tab (shows what is due) and the account drawer on the
// Account managers tab (reminders for that account, and a button to add one). Database: sql/contact_reminders_2026-11-04.sql.
// Everything is written through database functions (add_reminder, update_reminder, snooze_reminder, complete_reminder, delete_reminder).
// The database decides who may do what: anyone can set reminders for themselves; only Daniel and Oliver can set them for other people.
// This file has no page of its own: it exposes window.ATAM_REM and fires a "atam-reminders-changed" event after any change.
(function () {
  'use strict';

  const KINDS = {
    call:    { icon: '📞', label: 'Call' },
    visit:   { icon: '🚗', label: 'Visit' },
    meeting: { icon: '🤝', label: 'Meeting / appointment' },
    email:   { icon: '✉️', label: 'Email' },
    other:   { icon: '📌', label: 'Other' }
  };
  const REPEATS = [
    ['', 'Does not repeat'], ['1 week', 'Every week'], ['2 week', 'Every 2 weeks'], ['1 month', 'Every month'], ['3 month', 'Every 3 months'],
    ['6 month', 'Every 6 months'], ['1 year', 'Every year'], ['custom', 'Custom…']
  ];
  const UNITS = { day: 'day', week: 'week', month: 'month', year: 'year' };

  const state = { items: [], loaded: false, loading: false, error: null, me: '', canAssign: false, team: [], names: null, namesLoading: false, busy: false };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromYmd = s => { const p = String(s).slice(0, 10).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), last)); return x; };
  const todayYmd = () => ymd(new Date());
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fmtDay = s => fromYmd(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const hhmm = t => (t ? String(t).slice(0, 5) : '');

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }
  const changed = () => { try { window.dispatchEvent(new CustomEvent('atam-reminders-changed')); } catch (e) { /* older browser: pages refresh on their own timers */ } };

  function friendly(msg) {
    msg = String(msg || '');
    if (/not signed in/i.test(msg)) return 'You have been signed out. Sign in again and retry.';
    if (/only Daniel or Oliver/i.test(msg)) return 'Only Daniel or Oliver can set a reminder for someone else. Leave "For" as yourself.';
    if (/belongs to someone else/i.test(msg)) return 'That reminder belongs to someone else, so only they (or Daniel or Oliver) can change it.';
    if (/already done/i.test(msg)) return 'That reminder is already done. Refresh the page.';
    if (/in the past|from today on/i.test(msg)) return 'Pick a date from today onwards.';
    if (/choose or type/i.test(msg)) return 'Type or pick who the reminder is about.';
    if (/too long/i.test(msg)) return 'That is too long (the note can be 500 characters at most).';
    if (/name is not set up/i.test(msg)) return 'Your name is not set on your profile yet, so ask Oliver to add it.';
    if (/unknown team member/i.test(msg)) return 'That person is not on the team list.';
    if (/choose how often|repeat/i.test(msg)) return 'Check the repeat settings: ' + msg.replace(/^.*?exception:?\s*/i, '');
    return 'Could not save: ' + msg;
  }

  // ---- loading ----
  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    try {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const res = await client().from('contact_reminders').select('*').eq('status', 'open').order('remind_on').range(from, from + 999);
        if (res.error) throw res.error;
        rows.push.apply(rows, res.data || []);
        if (!res.data || res.data.length < 1000) break;
      }
      state.items = rows.map(r => ({
        id: r.id, account: r.account_name || '', known: !!r.account_known, kind: KINDS[r.kind] ? r.kind : 'other', note: r.note || '',
        date: String(r.remind_on).slice(0, 10), time: hhmm(r.remind_time), every: r.repeat_every, unit: r.repeat_unit,
        until: r.repeat_until ? String(r.repeat_until).slice(0, 10) : '', owner: r.assigned_to || 'Unassigned', by: r.created_by || '',
        doneCount: r.done_count || 0, lastDone: r.last_done_at || null
      }));
      state.loaded = true; state.error = null;
      if (!state.me) {
        try {
          const u = await client().auth.getUser();
          const id = u && u.data && u.data.user && u.data.user.id;
          if (id) { const p = await client().from('profiles').select('full_name').eq('id', id).maybeSingle(); state.me = (p && p.data && p.data.full_name) || ''; }
        } catch (e) { /* "me" stays unknown: the form then asks the database */ }
        try { const c = await client().rpc('can_assign_reminders'); state.canAssign = !!(c && c.data === true); } catch (e) { state.canAssign = false; }
        try {
          const t = await client().from('mail_senders').select('rep_name').eq('kind', 'rep').eq('active', true);
          state.team = Array.from(new Set(((t && t.data) || []).map(r => r.rep_name).filter(Boolean))).sort();
        } catch (e) { /* the For list then only has the person themselves */ }
      }
    } catch (e) {
      console.error('reminders load failed', e);
      if (!state.loaded) state.error = (e && e.message) || 'Could not load reminders';
    } finally { state.loading = false; }
    changed();
  }
  async function loadNames() {
    if (state.names || state.namesLoading) return;
    state.namesLoading = true;
    try { const r = await client().rpc('reminder_account_names'); state.names = (r && r.data) || []; } catch (e) { state.names = []; }
    state.namesLoading = false;
    const dl = document.getElementById('rmAcctList');
    if (dl) dl.innerHTML = state.names.map(n => `<option value="${esc(n)}"></option>`).join('');
  }

  // ---- describing ----
  function repeatText(i) {
    if (!i.every) return '';
    const u = UNITS[i.unit] || i.unit;
    return i.every === 1 ? 'every ' + u : 'every ' + i.every + ' ' + u + 's';
  }
  function describe(i) {
    return (KINDS[i.kind] || KINDS.other).label + (i.time ? ' at ' + i.time : '') + (i.every ? ' · repeats ' + repeatText(i) + (i.until ? ' until ' + fmtDay(i.until) : '') : '') + (i.note ? ' · ' + i.note : '');
  }
  const forAccount = name => { const n = norm(name); return state.items.filter(i => norm(i.account) === n); };

  // ---- actions ----
  async function call(fn, args, okMsg) {
    if (state.busy) return { ok: false, error: 'busy' };
    state.busy = true;
    try {
      const res = await client().rpc(fn, args);
      if (res.error) return { ok: false, error: friendly(res.error.message) };
      await load(true);
      return { ok: true, data: res.data, msg: okMsg };
    } catch (e) { return { ok: false, error: friendly(e && e.message) }; }
    finally { state.busy = false; }
  }
  const complete = id => call('complete_reminder', { p_id: id });
  const snooze = (id, date) => call('snooze_reminder', { p_id: id, p_date: date });
  const remove = id => call('delete_reminder', { p_id: id });

  // ---- the form ----
  function styles() {
    if (document.getElementById('rmStyles')) return;
    const s = document.createElement('style');
    s.id = 'rmStyles';
    s.textContent = `
.rm-overlay { position:fixed; inset:0; z-index:3000; background:rgba(2,6,23,.7); display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:5vh 12px; }
.rm-card { width:min(560px,100%); background:#0b1222; border:1px solid rgba(255,255,255,.16); border-radius:16px; padding:20px 22px; color:#e2e8f0; box-shadow:0 24px 60px rgba(0,0,0,.5); }
.rm-card h3 { margin:0 0 4px; font-size:20px; } .rm-card p.rm-sub { margin:0 0 14px; color:#94a3b8; font-size:13px; line-height:1.45; }
.rm-row { margin:0 0 12px; } .rm-row label { display:block; font-size:12px; color:#94a3b8; margin-bottom:4px; }
.rm-card input, .rm-card select, .rm-card textarea { width:100%; box-sizing:border-box; padding:9px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:14px; font-family:inherit; }
.rm-card textarea { min-height:70px; resize:vertical; }
.rm-two { display:grid; grid-template-columns:1fr 1fr; gap:10px; } .rm-three { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
.rm-quick { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.rm-quick button, .rm-btn { padding:7px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.16); background:#0f172a; color:#e2e8f0; font-size:12.5px; cursor:pointer; }
.rm-btn:hover, .rm-quick button:hover { border-color:#38bdf8; } .rm-btn.pri { background:#2563eb; border-color:#2563eb; color:#fff; } .rm-btn.danger { border-color:rgba(239,68,68,.5); color:#fca5a5; }
.rm-btn[disabled] { opacity:.6; cursor:default; }
.rm-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:16px; }
.rm-msg { font-size:13px; } .rm-msg.err { color:#fca5a5; } .rm-hint { font-size:12px; color:#64748b; margin-top:4px; }
@media (max-width:560px) { .rm-two, .rm-three { grid-template-columns:1fr; } }`;
    document.head.appendChild(s);
  }

  function repeatPreset(i) {
    if (!i || !i.every) return '';
    const key = i.every + ' ' + i.unit;
    return REPEATS.some(r => r[0] === key) ? key : 'custom';
  }

  function openForm(opts) {
    opts = opts || {};
    styles();
    closeForm();
    const edit = opts.id ? state.items.find(x => x.id === opts.id) : null;
    if (opts.id && !edit) return;
    const today = todayYmd();
    const v = edit || { account: opts.account || '', kind: opts.kind || 'call', note: '', date: opts.date && opts.date >= today ? opts.date : ymd(addDays(new Date(), 7)), time: '', every: null, unit: null, until: '', owner: opts.owner || state.me };
    const who = Array.from(new Set([state.me].concat(state.canAssign ? state.team : []).concat(edit ? [edit.owner] : []))).filter(Boolean);
    const preset = repeatPreset(v);
    const overlay = document.createElement('div');
    overlay.className = 'rm-overlay';
    overlay.id = 'rmOverlay';
    overlay.innerHTML = `<div class="rm-card" role="dialog" aria-modal="true" aria-labelledby="rmTitle">
      <h3 id="rmTitle">${edit ? 'Edit reminder' : 'Add a reminder'}</h3>
      <p class="rm-sub">A reminder to contact a customer, or anyone else, on a date. It shows on the Calendar and on Today when it is due. It is not about a quote or Win-back.</p>
      <div class="rm-row"><label for="rmAcct">Customer or contact</label>
        <input id="rmAcct" type="text" list="rmAcctList" maxlength="200" placeholder="Start typing an account name, or type any name" value="${esc(v.account)}" autocomplete="off">
        <datalist id="rmAcctList">${(state.names || []).map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
        <div class="rm-hint">Pick an account from the list, or type a name for someone who is not an account yet (a prospect, for example).</div></div>
      <div class="rm-two"><div class="rm-row"><label for="rmKind">What</label><select id="rmKind">${Object.keys(KINDS).map(k => `<option value="${k}"${k === v.kind ? ' selected' : ''}>${KINDS[k].icon} ${esc(KINDS[k].label)}</option>`).join('')}</select></div>
        ${who.length > 1 || state.canAssign ? `<div class="rm-row"><label for="rmFor">For${state.canAssign ? '' : ' (you)'}</label><select id="rmFor"${state.canAssign ? '' : ' disabled'}>${who.map(n => `<option value="${esc(n)}"${n === v.owner ? ' selected' : ''}>${esc(n)}${n === state.me ? ' (me)' : ''}</option>`).join('')}</select></div>` : `<div class="rm-row"><label>For</label><input type="text" value="${esc(state.me || 'You')}" disabled></div>`}</div>
      <div class="rm-two"><div class="rm-row"><label for="rmDate">Date</label><input id="rmDate" type="date" min="${today}" value="${esc(v.date)}">
          <div class="rm-quick"><button type="button" data-q="1">Tomorrow</button><button type="button" data-q="7">In a week</button><button type="button" data-q="14">In 2 weeks</button><button type="button" data-q="m1">In a month</button><button type="button" data-q="m3">In 3 months</button></div></div>
        <div class="rm-row"><label for="rmTime">Time (optional)</label><input id="rmTime" type="time" value="${esc(v.time)}"></div></div>
      <div class="rm-row"><label for="rmNote">Note (optional)</label><textarea id="rmNote" maxlength="500" placeholder="e.g. General catch up. Ask how the new site is going.">${esc(v.note)}</textarea></div>
      <div class="rm-row"><label for="rmRep">Repeat</label><select id="rmRep">${REPEATS.map(r => `<option value="${esc(r[0])}"${r[0] === preset ? ' selected' : ''}>${esc(r[1])}</option>`).join('')}</select>
        <div id="rmCustom" class="rm-two" style="margin-top:8px;${preset === 'custom' ? '' : 'display:none'}"><div><label for="rmEvery">Every</label><input id="rmEvery" type="number" min="1" max="60" value="${esc(v.every || 1)}"></div>
          <div><label for="rmUnit">Unit</label><select id="rmUnit">${Object.keys(UNITS).map(u => `<option value="${u}"${u === (v.unit || 'month') ? ' selected' : ''}>${u}s</option>`).join('')}</select></div></div>
        <div id="rmUntilRow" style="margin-top:8px;${preset ? '' : 'display:none'}"><label for="rmUntil">Stop repeating after (optional)</label><input id="rmUntil" type="date" min="${today}" value="${esc(v.until)}"></div>
        <div class="rm-hint">When you tick a repeating reminder off, it moves to its next date by itself.</div></div>
      <div class="rm-actions"><button type="button" class="rm-btn pri" id="rmSave">${edit ? 'Save changes' : 'Add reminder'}</button><button type="button" class="rm-btn" id="rmCancel">Cancel</button><span class="rm-msg" id="rmMsg" role="status"></span></div></div>`;
    document.body.appendChild(overlay);
    const $ = id => overlay.querySelector('#' + id);
    const setMsg = (t, cls) => { const m = $('rmMsg'); m.textContent = t || ''; m.className = 'rm-msg ' + (cls || ''); };
    loadNames();

    $('rmRep').addEventListener('change', () => {
      const val = $('rmRep').value;
      $('rmCustom').style.display = val === 'custom' ? '' : 'none';
      $('rmUntilRow').style.display = val ? '' : 'none';
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.id === 'rmCancel') { closeForm(); return; }
      const q = e.target.closest('[data-q]');
      if (q) {
        const k = q.dataset.q, now = new Date();
        $('rmDate').value = ymd(k[0] === 'm' ? addMonths(now, Number(k.slice(1))) : addDays(now, Number(k)));
      }
    });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') closeForm(); });
    $('rmSave').addEventListener('click', async () => {
      const account = $('rmAcct').value.trim();
      if (!account) { setMsg('Type or pick who the reminder is about.', 'err'); $('rmAcct').focus(); return; }
      const date = $('rmDate').value;
      if (!date) { setMsg('Pick a date.', 'err'); return; }
      if (date < todayYmd()) { setMsg('Pick a date from today onwards.', 'err'); return; }
      const rep = $('rmRep').value;
      let every = null, unit = null;
      if (rep === 'custom') { every = parseInt($('rmEvery').value, 10); unit = $('rmUnit').value; if (!(every >= 1 && every <= 60)) { setMsg('Repeat every 1 to 60.', 'err'); return; } }
      else if (rep) { const p = rep.split(' '); every = Number(p[0]); unit = p[1]; }
      const until = rep ? ($('rmUntil').value || null) : null;
      if (until && until < date) { setMsg('The stop date is before the first date.', 'err'); return; }
      const forSel = $('rmFor');
      const args = { p_account: account, p_kind: $('rmKind').value, p_note: $('rmNote').value.trim() || null, p_date: date, p_time: $('rmTime').value || null,
        p_for: forSel && !forSel.disabled ? forSel.value : null, p_every: every, p_unit: unit, p_until: until };
      $('rmSave').disabled = true; setMsg('Saving…');
      const res = await call(edit ? 'update_reminder' : 'add_reminder', edit ? Object.assign({ p_id: edit.id }, args) : args);
      if (!res.ok) { $('rmSave').disabled = false; setMsg(res.error, 'err'); return; }
      closeForm();
      if (opts.onSaved) opts.onSaved(res);
    });
    setTimeout(() => { const f = edit ? $('rmNote') : $('rmAcct'); if (f) f.focus({ preventScroll: true }); }, 30);
  }
  function closeForm() { const o = document.getElementById('rmOverlay'); if (o) o.remove(); }

  // Snooze choices: always counted from today, so a late reminder is not moved to another past date.
  const SNOOZE = [['1', 'Tomorrow'], ['3', 'In 3 days'], ['7', 'Next week'], ['14', 'In 2 weeks'], ['m1', 'In a month']];
  function snoozeBy(id, key) {
    const now = new Date();
    return snooze(id, ymd(key[0] === 'm' ? addMonths(now, Number(key.slice(1))) : addDays(now, Number(key))));
  }
  const snoozeOptions = () => '<option value="">Snooze…</option>' + SNOOZE.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('');

  window.ATAM_REM = { state, load, loadNames, openForm, closeForm, complete, snooze, snoozeBy, snoozeOptions, remove, forAccount, describe, repeatText, KINDS, friendly };
})();
