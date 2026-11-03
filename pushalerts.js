// Phone alerts: the "Phone alerts" control on the Today tab, and what happens when someone taps an alert.
// Alerts are web push messages sent by an n8n workflow ("Phone alerts sender") to devices that have switched them on here.
// Database: sql/push_alerts_2026-11-03.sql (push_public_key, save_push_subscription, remove_push_subscription, my_push_devices, send_test_push).
// On an iPhone or iPad, alerts only work once ATAM GO has been added to the Home Screen and is opened from there (an Apple rule).
(function () {
  'use strict';

  const state = { status: 'checking', devices: 0, busy: false, msg: '' };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function client() {
    if (window._atamSb) return window._atamSb;
    const cfg = window.ATAM_GO_CONFIG || {};
    window._atamSb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._atamSb;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function refresh() {
    if (!supported) { state.status = isIos && !standalone ? 'ios-install' : 'unsupported'; draw(); return; }
    if (isIos && !standalone) { state.status = 'ios-install'; draw(); return; }
    if (Notification.permission === 'denied') { state.status = 'denied'; draw(); return; }
    try {
      const sub = await currentSub();
      const d = await client().rpc('my_push_devices');
      state.devices = d && d.data ? Number(d.data) : 0;
      state.status = sub && Notification.permission === 'granted' ? 'on' : 'off';
    } catch (e) { state.status = 'off'; }
    draw();
  }

  async function turnOn() {
    if (state.busy) return;
    state.busy = true; state.msg = ''; draw();
    try {
      const k = await client().rpc('push_public_key');
      if (k.error) throw k.error;
      if (!k.data) throw new Error('Alerts have not been set up on the server yet. Ask Oliver.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Alerts were not allowed. You can change this in your phone or browser settings for this site.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.data) });
      const j = sub.toJSON();
      const sv = await client().rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys && j.keys.p256dh, p_auth: j.keys && j.keys.auth, p_ua: navigator.userAgent });
      if (sv.error) throw sv.error;
      state.msg = 'Alerts are on for this device.';
    } catch (e) {
      console.error('turn on alerts failed', e);
      state.msg = (e && e.message) || 'Could not turn alerts on.';
    }
    state.busy = false;
    await refresh();
  }

  async function turnOff() {
    if (state.busy) return;
    state.busy = true; draw();
    try {
      const sub = await currentSub();
      if (sub) {
        const ep = sub.endpoint;
        await sub.unsubscribe();
        await client().rpc('remove_push_subscription', { p_endpoint: ep });
      }
      state.msg = 'Alerts are off for this device.';
    } catch (e) { state.msg = (e && e.message) || 'Could not turn alerts off.'; }
    state.busy = false;
    await refresh();
  }

  async function test() {
    if (state.busy) return;
    state.busy = true; state.msg = ''; draw();
    try {
      const r = await client().rpc('send_test_push');
      if (r.error) throw r.error;
      state.msg = 'Test queued. Alerts are sent every 2 hours, so it can take up to 2 hours to arrive. (Oliver can send the queue straight away.)';
    } catch (e) { state.msg = (e && e.message) || 'Could not send a test.'; }
    state.busy = false; draw();
  }

  function draw() {
    const box = $('paBox'); if (!box) return;
    const st = state.status;
    let main = '';
    if (st === 'checking') main = 'Checking…';
    else if (st === 'unsupported') main = 'This browser cannot receive phone alerts.';
    else if (st === 'ios-install') main = 'On an iPhone or iPad: tap the Share button, choose <b>Add to Home Screen</b>, then open ATAM GO from that icon and come back here to turn alerts on.';
    else if (st === 'denied') main = 'Alerts are blocked for this site. Allow notifications for ATAM GO in your phone or browser settings, then come back here.';
    else if (st === 'on') main = `🔔 Alerts are <b>on</b> for this device. <button type="button" class="pa-btn" data-pa="test"${state.busy ? ' disabled' : ''}>Send me a test</button> <button type="button" class="pa-btn" data-pa="off"${state.busy ? ' disabled' : ''}>Turn off</button>`;
    else main = `🔕 Alerts are off. Get a message on your phone when a customer replies to your quote or an order of yours becomes late (checked every 2 hours). <button type="button" class="pa-btn pa-primary" data-pa="on"${state.busy ? ' disabled' : ''}>Turn on alerts</button>`;
    box.innerHTML = `<div class="pa-row">${main}</div>${state.msg ? `<div class="pa-msg" role="status">${esc(state.msg)}</div>` : ''}`;
  }

  function injectStyles() {
    if ($('paStyles')) return;
    const s = document.createElement('style');
    s.id = 'paStyles';
    s.textContent = `
#paBox { margin:12px 0 0; padding:10px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(15,23,42,.55); font-size:13.5px; color:#cbd5e1; line-height:1.5; }
#paBox .pa-row { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; }
#paBox .pa-msg { margin-top:6px; color:#94a3b8; font-size:12.5px; }
#paBox .pa-btn { padding:6px 12px; border-radius:8px; font-size:12.5px; font-weight:600; border:1px solid rgba(255,255,255,.16); background:transparent; color:#e2e8f0; cursor:pointer; }
#paBox .pa-btn:hover { background:rgba(255,255,255,.07); }
#paBox .pa-btn:disabled { opacity:.5; cursor:default; }
#paBox .pa-primary { background:linear-gradient(135deg,#38bdf8,#6366f1); border:none; color:#fff; }`;
    document.head.appendChild(s);
  }

  function install() {
    const head = document.querySelector('#today .td-headbox');
    if (!head) return false;
    if ($('paBox')) return true;
    injectStyles();
    const box = document.createElement('div');
    box.id = 'paBox';
    head.appendChild(box);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-pa]'); if (!b) return;
      if (b.dataset.pa === 'on') turnOn(); else if (b.dataset.pa === 'off') turnOff(); else if (b.dataset.pa === 'test') test();
    });
    draw();
    refresh();
    return true;
  }

  // Going to a page from an alert: either this window is told (the service worker posts a message) or it was opened with ?go=<page>.
  function goTo(page) {
    if (!page) return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      const btn = document.querySelector('.nav-link[data-page="' + page + '"]');
      if (btn) { clearInterval(t); btn.click(); } else if (tries > 80) clearInterval(t);
    }, 250);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'atamgo-go') goTo(e.data.go); });
  }
  try {
    const q = new URLSearchParams(location.search).get('go');
    if (q) { goTo(q); history.replaceState(null, '', location.pathname); }
  } catch (e) { /* the page just opens as normal */ }

  function boot() {
    boot.tries = (boot.tries || 0) + 1;
    if (!install() && boot.tries < 100) setTimeout(boot, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
