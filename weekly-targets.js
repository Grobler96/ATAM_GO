/* ═══════════════════════════════════════════════════════════════
   ATAM GO — Weekly Targets Module
   Drop-in. Add as a new <script src="weekly-targets.js"> tag in
   index.html, after app.js (needs window._atamSb and config to exist).

   What it does:
   - Injects a "Weekly Targets" section at the top of the Overview tab
   - Shows two liquid-fill 3D shirt gauges: Embroidery and Print
   - Actual figures = sum of decoration_records quantity for the
     CURRENT working week (Monday to Friday), independent of the
     dashboard's global date filter
   - Resets automatically at Sunday midnight (next Monday begins a
     fresh week — Sat/Sun are excluded from the working week range)
   - Refreshes every 30 seconds independently of the main dashboard
   - Targets are 500 each, editable in TARGETS config below
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const TARGETS = {
    embroidery: 500,
    print: 500,
  };

  const REFRESH_MS = 30_000;

  const SHIRT_PATH = "M60 20 L40 10 L10 40 L30 65 L45 55 L45 200 L155 200 L155 55 L170 65 L190 40 L160 10 L140 20 C140 20 130 35 100 35 C70 35 60 20 60 20 Z";

  function $(id) { return document.getElementById(id); }
  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }

  /* ── Get Monday-Friday of the current working week ── */
  function getWorkingWeekRange() {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat

    // Days since most recent Monday. If today is Sunday (0), the most
    // recent Monday was 6 days ago — but per spec, Sunday should already
    // be showing the FOLLOWING week's fresh (empty) targets, since the
    // reset happens at Sunday midnight. So treat Sunday as "next week".
    let daysSinceMonday;
    if (dow === 0) {
      daysSinceMonday = -1; // push into next week's Monday (tomorrow)
    } else {
      daysSinceMonday = dow - 1;
    }

    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(now.getDate() - daysSinceMonday);

    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    friday.setHours(23, 59, 59, 999);

    return {
      from: monday.toISOString().slice(0, 10),
      to: friday.toISOString().slice(0, 10),
    };
  }

  /* ── Fetch actual totals for the working week ── */
  async function fetchWeeklyTotals() {
    const sb = window._atamSb;
    if (!sb) return { embroidery: 0, print: 0 };

    const range = getWorkingWeekRange();

    const { data, error } = await sb
      .from('decoration_records')
      .select('decoration_type, quantity')
      .gte('report_date', range.from)
      .lte('report_date', range.to);

    if (error) {
      console.warn('[Weekly Targets] fetch error:', error.message);
      return { embroidery: 0, print: 0 };
    }

    const rows = data || [];
    const embroidery = rows
      .filter(r => r.decoration_type === 'embroidery')
      .reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const print = rows
      .filter(r => r.decoration_type === 'print')
      .reduce((sum, r) => sum + Number(r.quantity || 0), 0);

    return { embroidery, print };
  }

  /* ── Build the liquid-fill shirt SVG, fillPct 0-100 ── */
  function buildShirtSvg(uid, fillPct) {
    const clamped = Math.max(0, Math.min(100, fillPct));
    // Shirt body spans roughly y=10 to y=200 in the 200x220 viewBox.
    // Map 0-100% fill to y position within that range (inverted: 0% = y=200, 100% = y=10)
    const fillTop = 200 - (clamped / 100) * 190;

    return `
      <svg class="wt-shirt-svg" viewBox="0 0 200 220">
        <defs>
          <clipPath id="wtClip-${uid}">
            <path d="${SHIRT_PATH}"/>
          </clipPath>
          <linearGradient id="wtFill-${uid}" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stop-color="var(--wt-grad-from)"/>
            <stop offset="100%" stop-color="var(--wt-grad-to)"/>
          </linearGradient>
        </defs>

        <path d="${SHIRT_PATH}" fill="#131c2e" stroke="#2a3f5f" stroke-width="2"/>

        <g clip-path="url(#wtClip-${uid})">
          <rect class="wt-fill-rect" x="0" y="${fillTop}" width="200" height="${220 - fillTop}"
                fill="url(#wtFill-${uid})" opacity="0.85"
                data-target-y="${fillTop}" data-from-y="220"></rect>
          <path class="wt-wave" fill="var(--wt-wave-color)" opacity="0.4"
                data-target-y="${fillTop}"
                d="M0 ${fillTop} Q25 ${fillTop - 6} 50 ${fillTop} T100 ${fillTop} T150 ${fillTop} T200 ${fillTop} V220 H0 Z"></path>
        </g>

        <path d="${SHIRT_PATH}" fill="none" stroke="var(--wt-stroke)" stroke-width="1.5" opacity="0.6"/>
      </svg>
    `;
  }

  function buildCardHtml(type, actual, target, colorVars) {
    const pct = target > 0 ? Math.round((actual / target) * 100) : 0;
    const uid = type;

    return `
      <div class="wt-card wt-${type}" style="${colorVars}">
        <div class="wt-label">${type === 'embroidery' ? 'Embroidery target' : 'Print target'}</div>
        <div class="wt-value-row">
          <span class="wt-value" id="wt-value-${uid}">${actual}</span>
          <span class="wt-target-text">/ ${target}</span>
        </div>
        <div class="wt-shirt-wrap">
          <div class="wt-glow-ring"></div>
          <div class="wt-shirt-3d" id="wt-shirt-${uid}">
            ${buildShirtSvg(uid, pct)}
          </div>
        </div>
        <div class="wt-pct-label" id="wt-pct-${uid}">${pct}% to target</div>
        <div class="wt-week-label" id="wt-week-${uid}"></div>
      </div>
    `;
  }

  function injectStyles() {
    if ($('weekly-targets-styles')) return;
    const style = document.createElement('style');
    style.id = 'weekly-targets-styles';
    style.textContent = `
      .wt-section {
        margin-bottom: 28px;
      }
      .wt-section-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 14px;
      }
      .wt-section-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #38bdf8;
      }
      .wt-section-sub {
        font-size: 12px;
        color: #64748b;
      }
      .wt-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      .wt-card {
        background: #0d1525;
        border: 1px solid #1e2d45;
        border-radius: 16px;
        padding: 24px;
        text-align: center;
        position: relative;
        overflow: hidden;
      }
      .wt-card::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: linear-gradient(90deg, var(--wt-accent-1), var(--wt-accent-2));
      }
      .wt-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #64748b;
        margin-bottom: 4px;
      }
      .wt-value-row {
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 6px;
        margin-bottom: 16px;
      }
      .wt-value {
        font-size: 32px;
        font-weight: 800;
        color: #f8fafc;
        font-variant-numeric: tabular-nums;
        transition: color 0.3s ease;
      }
      .wt-target-text {
        font-size: 13px;
        color: #64748b;
        font-weight: 600;
      }
      .wt-shirt-wrap {
        position: relative;
        width: 160px;
        height: 176px;
        margin: 0 auto;
        perspective: 600px;
      }
      .wt-shirt-3d {
        width: 100%;
        height: 100%;
        transform: rotateY(-12deg) rotateX(4deg);
        transform-style: preserve-3d;
        animation: wt-float 4s ease-in-out infinite;
      }
      @keyframes wt-float {
        0%, 100% { transform: rotateY(-12deg) rotateX(4deg) translateY(0px); }
        50% { transform: rotateY(-12deg) rotateX(4deg) translateY(-5px); }
      }
      .wt-shirt-svg { width: 100%; height: 100%; overflow: visible; }
      .wt-fill-rect, .wt-wave {
        transition: y 1s cubic-bezier(0.22, 1, 0.36, 1), d 1s cubic-bezier(0.22, 1, 0.36, 1), height 1s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .wt-pct-label {
        margin-top: 12px;
        font-size: 13px;
        font-weight: 700;
        color: var(--wt-accent-1);
      }
      .wt-week-label {
        margin-top: 4px;
        font-size: 10px;
        color: #475569;
        letter-spacing: 0.04em;
      }
      .wt-glow-ring {
        position: absolute;
        inset: -16px;
        border-radius: 50%;
        filter: blur(20px);
        opacity: 0.3;
        z-index: -1;
        background: radial-gradient(circle, var(--wt-accent-1), transparent 70%);
      }
      .wt-embroidery {
        --wt-accent-1: #38bdf8;
        --wt-accent-2: #6366f1;
        --wt-grad-from: #0ea5e9;
        --wt-grad-to: #38bdf8;
        --wt-wave-color: #7dd3fc;
        --wt-stroke: #38bdf8;
      }
      .wt-print {
        --wt-accent-1: #f472b6;
        --wt-accent-2: #f97316;
        --wt-grad-from: #ec4899;
        --wt-grad-to: #f472b6;
        --wt-wave-color: #fbcfe8;
        --wt-stroke: #f472b6;
      }
      .wt-card.wt-target-hit {
        animation: wt-hit-pulse 1.6s ease-in-out infinite;
      }
      @keyframes wt-hit-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
        50% { box-shadow: 0 0 24px 4px rgba(34,197,94,0.25); }
      }
      @media (max-width: 600px) {
        .wt-grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function injectSection() {
    const overview = $('overview');
    if (!overview) return;

    if ($('weekly-targets-section')) return;

    const section = document.createElement('div');
    section.id = 'weekly-targets-section';
    section.className = 'wt-section';
    section.innerHTML = `
      <div class="wt-section-header">
        <span class="wt-section-title">Weekly targets</span>
        <span class="wt-section-sub" id="wt-range-label"></span>
      </div>
      <div class="wt-grid">
        ${buildCardHtml('embroidery', 0, TARGETS.embroidery, '')}
        ${buildCardHtml('print', 0, TARGETS.print, '')}
      </div>
    `;

    // Insert as the very first child of the overview section, before
    // the existing page-header
    const firstChild = overview.firstElementChild;
    overview.insertBefore(section, firstChild);
  }

  function updateRangeLabel() {
    const range = getWorkingWeekRange();
    // Parse as local date to avoid UTC-to-local timezone shift
    const parseLocal = d => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m - 1, day);
    };
    const fmt = d => parseLocal(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const label = `Mon ${fmt(range.from)} – Fri ${fmt(range.to)}`;
    const el = $('wt-range-label');
    if (el) el.textContent = label;
  }

  function animateShirtFill(type, pct) {
    const wrap = $(`wt-shirt-${type}`);
    if (!wrap) return;

    const clamped = Math.max(0, Math.min(100, pct));
    const fillTop = 200 - (clamped / 100) * 190;

    const rect = qs('.wt-fill-rect', wrap);
    const wave = qs('.wt-wave', wrap);

    if (rect) {
      rect.setAttribute('y', fillTop);
      rect.setAttribute('height', 220 - fillTop);
    }
    if (wave) {
      wave.setAttribute('d', `M0 ${fillTop} Q25 ${fillTop - 6} 50 ${fillTop} T100 ${fillTop} T150 ${fillTop} T200 ${fillTop} V220 H0 Z`);
    }
  }

  function updateCard(type, actual, target) {
    const pct = target > 0 ? Math.round((actual / target) * 100) : 0;

    const valueEl = $(`wt-value-${type}`);
    if (valueEl) valueEl.textContent = new Intl.NumberFormat('en-GB').format(actual);

    const pctEl = $(`wt-pct-${type}`);
    if (pctEl) pctEl.textContent = `${pct}% to target`;

    animateShirtFill(type, pct);

    const card = qs(`.wt-${type}`);
    if (card) card.classList.toggle('wt-target-hit', actual >= target);
  }

  async function refresh() {
    updateRangeLabel();
    const totals = await fetchWeeklyTotals();
    updateCard('embroidery', totals.embroidery, TARGETS.embroidery);
    updateCard('print', totals.print, TARGETS.print);
  }

  function waitForSupabase(callback, attempts) {
    attempts = attempts || 0;
    if (window._atamSb) {
      callback();
    } else if (attempts < 50) {
      setTimeout(() => waitForSupabase(callback, attempts + 1), 200);
    }
  }

  function boot() {
    injectStyles();
    injectSection();
    updateRangeLabel();

    waitForSupabase(() => {
      refresh();
      setInterval(refresh, REFRESH_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 300));
  } else {
    setTimeout(boot, 300);
  }

})();
