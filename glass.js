/* ═══════════════════════════════════════════════════════════════
   ATAM GO — glass.js
   Motion for the dark glass look (see glass.css). Drop-in: add
   <script src="glass.js"></script> as the LAST script in index.html.
   Nothing else is changed. To switch it off for yourself, run
   localStorage.setItem('atam-glass','off') in the browser console.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  try { if (localStorage.getItem('atam-glass') === 'off') return; } catch (e) {}

  var root = document.documentElement;
  root.classList.add('glass');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CARDS = '.kpi-card, .panel, .workflow-card, .action-card, .sk-kpi-card, .forecast-card, .ov-card, .target-card, .team-card, .trend-card';
  var NUMBERS = '.kpi-card strong, .sk-kpi-card strong';

  /* ── 1. Charts: smoother curves, drawn in rather than snapped ── */
  function tuneCharts() {
    if (!window.Chart || reduce) return;
    var d = Chart.defaults;
    d.animation = { duration: 1100, easing: 'easeOutQuart' };
    if (d.elements && d.elements.line) {
      d.elements.line.tension = 0.38;
      d.elements.line.borderCapStyle = 'round';
      d.elements.line.borderJoinStyle = 'round';
    }
    if (d.elements && d.elements.bar) d.elements.bar.borderRadius = 6;
  }

  /* ── 2. Sliding pill behind the active nav tab ── */
  function initNavPill() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    var pill = document.createElement('div');
    pill.className = 'g-nav-pill';
    nav.insertBefore(pill, nav.firstChild);
    var placed = false;

    function place() {
      var active = nav.querySelector('.nav-link.active');
      if (!active || !active.offsetHeight) { if (pill.classList.contains('ready')) pill.classList.remove('ready'); return; }
      if (!placed) pill.style.transition = 'none';
      pill.style.height = active.offsetHeight + 'px';
      pill.style.transform = 'translateY(' + active.offsetTop + 'px)';
      if (!placed) {
        void pill.offsetWidth;
        pill.style.transition = '';
        placed = true;
      }
      if (!pill.classList.contains('ready')) pill.classList.add('ready');
    }

    place();
    // ignore the pill's own changes, or placing it would trigger itself forever
    new MutationObserver(function (list) {
      if (list.some(function (m) { return m.target !== pill; })) place();
    }).observe(nav, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    window.addEventListener('resize', place);
    window.addEventListener('load', place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  }

  /* ── 3. Cards float up one after another when a tab opens ── */
  function stagger(page) {
    if (reduce) return;
    var items = Array.prototype.filter.call(page.querySelectorAll(CARDS), function (el) {
      return el.offsetParent !== null;
    }).slice(0, 28);
    items.forEach(function (el, i) {
      el.classList.remove('g-in');
      el.style.setProperty('--gi', i);
    });
    void page.offsetWidth;
    items.forEach(function (el) { el.classList.add('g-in'); });
    setTimeout(function () {
      items.forEach(function (el) { el.classList.remove('g-in'); });
    }, 2000);
  }

  function watchPages() {
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        var t = m.target;
        if (t.classList && t.classList.contains('dashboard-page') && t.classList.contains('active') && !t._gWas) stagger(t);
        if (t.classList && t.classList.contains('dashboard-page')) t._gWas = t.classList.contains('active');
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    var first = document.querySelector('.dashboard-page.active');
    if (first) { first._gWas = true; stagger(first); }
  }

  /* ── 4. Big numbers count up to their new value ── */
  var NUM_RE = /^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)([^\d]*)$/;
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 4); };

  function countTo(el, text) {
    var m = NUM_RE.exec(text.trim());
    if (!m) { el._gv = null; return; }
    var to = parseFloat(m[2].replace(/,/g, ''));
    var from = typeof el._gv === 'number' ? el._gv : 0;
    var decimals = (m[2].split('.')[1] || '').length;
    var commas = m[2].indexOf(',') !== -1 || Math.abs(to) >= 10000;
    el._gv = to;
    if (el._gRaf) cancelAnimationFrame(el._gRaf);
    if (from === to) return;
    var start = null, dur = 1000;

    function fmt(v) {
      var s = commas
        ? v.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : v.toFixed(decimals);
      return m[1] + s + m[3];
    }
    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el._gOwn = p < 1 ? fmt(from + (to - from) * easeOut(p)) : text;
      el.textContent = el._gOwn;
      if (p < 1) el._gRaf = requestAnimationFrame(frame);
    }
    el._gRaf = requestAnimationFrame(frame);
  }

  function watchNumbers() {
    if (reduce) return;
    new MutationObserver(function (list) {
      var seen = [];
      list.forEach(function (m) {
        var el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (!el || !el.matches || !el.matches(NUMBERS) || seen.indexOf(el) !== -1) return;
        seen.push(el);
        var text = el.textContent;
        if (text === el._gOwn) return;      // our own animation frame
        countTo(el, text);
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  /* ── 5. Cursor light on the glass ── */
  function watchPointer() {
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
    var pending = null, queued = false;
    document.addEventListener('pointermove', function (e) {
      var card = e.target.closest && e.target.closest(CARDS);
      if (!card) return;
      pending = { card: card, x: e.clientX, y: e.clientY };
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        var r = pending.card.getBoundingClientRect();
        pending.card.style.setProperty('--mx', (pending.x - r.left) + 'px');
        pending.card.style.setProperty('--my', (pending.y - r.top) + 'px');
      });
    }, { passive: true });
  }

  function start() {
    tuneCharts();
    initNavPill();
    watchPages();
    watchNumbers();
    watchPointer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
