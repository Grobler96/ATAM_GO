/* ═══════════════════════════════════════════════════════════════
   ATAM GO — effects3d.js
   Drop-in 3D enhancement. Zero changes to core files.
   Add <script src="effects3d.js"></script> before </body>
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Respect reduced motion preference ── */
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  /* ── Config ── */
  const CFG = {
    tilt: {
      max: 12,           // max tilt degrees
      perspective: 800,  // CSS perspective px
      scale: 1.03,       // scale on hover
      speed: 400,        // transition ms
      glare: true,       // glare effect
      glareMax: 0.25     // glare opacity
    },
    transition: {
      duration: 380,     // page transition ms
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
    },
    parallax: {
      strength: 18       // px of parallax movement
    },
    particles: {
      count: 28,
      speed: 0.35
    },
    entrance: {
      stagger: 55        // ms between card entrances
    }
  };

  /* ── Inject styles ── */
  function injectStyles() {
    if (document.getElementById('effects3d-styles')) return;
    const style = document.createElement('style');
    style.id = 'effects3d-styles';
    style.textContent = `

      /* ── Page transition wrapper ── */
      .dashboard-page {
        transform-style: preserve-3d;
        backface-visibility: hidden;
        will-change: transform, opacity;
      }

      .page-exit {
        animation: pageExit ${CFG.transition.duration}ms ${CFG.transition.easing} forwards;
        pointer-events: none;
      }

      .page-enter {
        animation: pageEnter ${CFG.transition.duration}ms ${CFG.transition.easing} forwards;
      }

      @keyframes pageExit {
        0%   { opacity: 1; transform: perspective(1200px) rotateY(0deg) translateZ(0px); }
        100% { opacity: 0; transform: perspective(1200px) rotateY(-8deg) translateZ(-80px); }
      }

      @keyframes pageEnter {
        0%   { opacity: 0; transform: perspective(1200px) rotateY(6deg) translateZ(-60px); }
        100% { opacity: 1; transform: perspective(1200px) rotateY(0deg) translateZ(0px); }
      }

      /* ── Tilt cards ── */
      .tilt-target {
        transform-style: preserve-3d;
        transition: transform ${CFG.tilt.speed}ms ease, box-shadow ${CFG.tilt.speed}ms ease;
        will-change: transform;
        position: relative;
        overflow: hidden;
      }

      .tilt-target:hover {
        box-shadow:
          0 20px 60px rgba(0, 0, 0, 0.5),
          0 0 0 1px rgba(249, 115, 22, 0.15);
      }

      .tilt-glare {
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        border-radius: inherit;
        pointer-events: none;
        z-index: 10;
        background: linear-gradient(
          135deg,
          rgba(255, 255, 255, 0.18) 0%,
          transparent 60%
        );
        opacity: 0;
        transition: opacity ${CFG.tilt.speed}ms ease;
      }

      /* ── Card entrance ── */
      .card-entrance {
        opacity: 0;
        transform: perspective(800px) translateY(28px) rotateX(8deg);
        transition:
          opacity 0.5s ease,
          transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .card-entrance.card-visible {
        opacity: 1;
        transform: perspective(800px) translateY(0) rotateX(0deg);
      }

      /* ── Parallax layer ── */
      #parallax-bg {
        position: fixed;
        inset: -40px;
        pointer-events: none;
        z-index: 0;
        will-change: transform;
        transition: transform 0.08s linear;
      }

      /* ── Particle canvas ── */
      #particles-canvas {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 0;
        opacity: 0.45;
      }

      /* ── Nav link 3D press ── */
      .nav-link {
        transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.15s ease !important;
      }

      .nav-link:hover {
        transform: perspective(400px) translateZ(4px) scale(1.02) !important;
      }

      .nav-link:active {
        transform: perspective(400px) translateZ(-2px) scale(0.97) !important;
      }

      /* ── KPI number pop ── */
      @keyframes kpiPop {
        0%   { transform: perspective(400px) scale(0.85) rotateX(20deg); opacity: 0; }
        70%  { transform: perspective(400px) scale(1.05) rotateX(-3deg); opacity: 1; }
        100% { transform: perspective(400px) scale(1) rotateX(0deg); opacity: 1; }
      }

      .kpi-pop {
        animation: kpiPop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }

      /* ── Sidebar 3D depth ── */
      .sidebar {
        transform-style: preserve-3d;
        transition: transform 0.3s ease;
      }

      /* ── Main content — no global transform, avoids page shift on tall pages ── */
      .main-content {
        transform-style: flat;
      }

      /* ── Panel hover lift ── */
      .panel {
        transition:
          transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),
          box-shadow 0.25s ease !important;
      }

      .panel:hover {
        transform: perspective(1000px) translateY(-3px) translateZ(8px) !important;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4) !important;
      }

      /* ── Topbar float ── */
      .topbar {
        transition: transform 0.08s linear;
        will-change: transform;
      }

      /* ── Action cards ── */
      .action-card {
        transition:
          transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
          box-shadow 0.2s ease !important;
      }
      .action-card:hover {
        transform: perspective(600px) translateY(-6px) translateZ(16px) rotateX(3deg) !important;
        box-shadow: 0 20px 50px rgba(249,115,22,0.2) !important;
      }
      .action-card:active {
        transform: perspective(600px) translateY(-1px) translateZ(4px) !important;
      }

      /* ── Ripple on button click ── */
      .ripple-effect {
        position: absolute;
        border-radius: 50%;
        background: rgba(249, 115, 22, 0.35);
        transform: scale(0);
        animation: ripple 0.55s ease-out forwards;
        pointer-events: none;
        z-index: 100;
      }

      @keyframes ripple {
        to { transform: scale(4); opacity: 0; }
      }

      /* ── Brand logo 3D hover ── */
      .brand-logo-wide {
        transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.3s ease;
      }
      .brand-logo-wide:hover {
        transform: perspective(400px) rotateY(-8deg) scale(1.06);
        filter: drop-shadow(0 4px 12px rgba(249,115,22,0.4));
      }

      /* ── Reduced motion safety ── */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /* ══════════════════════════════════════════
     PARTICLE SYSTEM
  ══════════════════════════════════════════ */
  function initParticles() {
    const canvas = document.createElement('canvas');
    canvas.id = 'particles-canvas';
    document.body.insertBefore(canvas, document.body.firstChild);
    const ctx = canvas.getContext('2d');

    let W, H, particles = [], animFrame;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }

    function createParticle() {
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.5 + 0.4,
        vx: (Math.random() - 0.5) * CFG.particles.speed,
        vy: (Math.random() - 0.5) * CFG.particles.speed,
        opacity: Math.random() * 0.5 + 0.1,
        pulse: Math.random() * Math.PI * 2
      };
    }

    function init() {
      resize();
      particles = Array.from({ length: CFG.particles.count }, createParticle);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.pulse += 0.012;

        if (p.x < 0) p.x = W;
        if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H;
        if (p.y > H) p.y = 0;

        const opacity = p.opacity * (0.7 + 0.3 * Math.sin(p.pulse));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(249, 115, 22, ${opacity})`;
        ctx.fill();
      });

      // Draw connecting lines between nearby particles
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 140) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(249, 115, 22, ${0.06 * (1 - dist / 140)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      animFrame = requestAnimationFrame(draw);
    }

    init();
    draw();
    window.addEventListener('resize', () => { resize(); });
  }

  /* ══════════════════════════════════════════
     MOUSE PARALLAX
  ══════════════════════════════════════════ */
  function initParallax() {
    let mouseX = 0, mouseY = 0;
    let currentX = 0, currentY = 0;
    const topbar = document.querySelector('.topbar');

    // Pages where parallax on main content is disabled (tall scrolling pages)
    const PARALLAX_DISABLED_PAGES = ['customers', 'activity', 'orders', 'production'];

    function isParallaxPage() {
      const active = document.querySelector('.dashboard-page.active');
      if (!active) return false;
      return !PARALLAX_DISABLED_PAGES.includes(active.id);
    }

    document.addEventListener('mousemove', e => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      mouseX = (e.clientX - cx) / cx;
      mouseY = (e.clientY - cy) / cy;
    });

    function tick() {
      currentX += (mouseX - currentX) * 0.05;
      currentY += (mouseY - currentY) * 0.05;

      // Very subtle topbar float on all pages — tiny translate only, no rotation
      if (topbar) {
        const px = currentX * 5;
        const py = currentY * 3;
        topbar.style.transform = `translateX(${px}px) translateY(${py}px)`;
      }

      requestAnimationFrame(tick);
    }

    tick();
  }

  /* ══════════════════════════════════════════
     CARD TILT — applied to all tilt targets
  ══════════════════════════════════════════ */
  function applyTilt(el) {
    if (el.dataset.tiltInit) return;
    el.dataset.tiltInit = '1';
    el.classList.add('tilt-target');

    // Add glare element
    const glare = document.createElement('div');
    glare.className = 'tilt-glare';
    el.style.position = el.style.position || 'relative';
    el.appendChild(glare);

    let rect, animId;

    el.addEventListener('mouseenter', () => {
      rect = el.getBoundingClientRect();
      el.style.transition = `transform ${CFG.tilt.speed}ms ease, box-shadow ${CFG.tilt.speed}ms ease`;
    });

    el.addEventListener('mousemove', e => {
      if (!rect) rect = el.getBoundingClientRect();

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      const rotateX = ((y - cy) / cy) * -CFG.tilt.max;
      const rotateY = ((x - cx) / cx) * CFG.tilt.max;

      cancelAnimationFrame(animId);
      animId = requestAnimationFrame(() => {
        el.style.transition = 'none';
        el.style.transform = `
          perspective(${CFG.tilt.perspective}px)
          rotateX(${rotateX}deg)
          rotateY(${rotateY}deg)
          scale3d(${CFG.tilt.scale}, ${CFG.tilt.scale}, ${CFG.tilt.scale})
        `;

        if (CFG.tilt.glare) {
          const glareX = (x / rect.width) * 100;
          const glareY = (y / rect.height) * 100;
          glare.style.background = `radial-gradient(circle at ${glareX}% ${glareY}%, rgba(255,255,255,${CFG.tilt.glareMax}), transparent 65%)`;
          glare.style.opacity = '1';
        }
      });
    });

    el.addEventListener('mouseleave', () => {
      cancelAnimationFrame(animId);
      el.style.transition = `transform ${CFG.tilt.speed}ms cubic-bezier(0.34,1.56,0.64,1), box-shadow ${CFG.tilt.speed}ms ease`;
      el.style.transform = `perspective(${CFG.tilt.perspective}px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)`;
      glare.style.opacity = '0';
    });
  }

  function initTilt() {
    const selectors = [
      '.kpi-card',
      '.panel',
      '.action-card',
      '.dispatch-card',
      '.order-meta-card'
    ];

    function applyToAll() {
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => applyTilt(el));
      });
    }

    applyToAll();

    // Watch for dynamically added cards
    const observer = new MutationObserver(() => applyToAll());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════════
     PAGE TRANSITIONS
  ══════════════════════════════════════════ */
  function bindNavTransition(btn) {
    if (btn.dataset.transitionBound) return;
    btn.dataset.transitionBound = '1';
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.page;
      const currentPage = document.querySelector('.dashboard-page.active');
      const nextPage = document.getElementById(targetId);

      if (!nextPage || currentPage === nextPage) return;

      if (currentPage) {
        currentPage.classList.add('page-exit');
        setTimeout(() => currentPage.classList.remove('page-exit'), CFG.transition.duration);
      }

      setTimeout(() => {
        if (nextPage.classList.contains('active')) {
          triggerCardEntrances(nextPage);
        } else {
          const check = setInterval(() => {
            if (nextPage.classList.contains('active')) {
              clearInterval(check);
              nextPage.classList.add('page-enter');
              setTimeout(() => nextPage.classList.remove('page-enter'), CFG.transition.duration);
              triggerCardEntrances(nextPage);
              triggerKpiPop(nextPage);
            }
          }, 20);
        }
      }, CFG.transition.duration * 0.3);
    });
  }

  function initPageTransitions() {
    // Bind existing nav buttons
    document.querySelectorAll('.nav-link').forEach(bindNavTransition);

    // Watch for new nav buttons added dynamically (e.g. dispatch.js)
    const navObserver = new MutationObserver(() => {
      document.querySelectorAll('.nav-link').forEach(bindNavTransition);
    });
    const nav = document.querySelector('.sidebar-nav');
    if (nav) navObserver.observe(nav, { childList: true });

    const navButtons = document.querySelectorAll('.nav-link');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.page;
        const currentPage = document.querySelector('.dashboard-page.active');
        const nextPage = document.getElementById(targetId);

        if (!nextPage || currentPage === nextPage) return;

        // Exit current page
        if (currentPage) {
          currentPage.classList.add('page-exit');
          setTimeout(() => {
            currentPage.classList.remove('page-exit');
          }, CFG.transition.duration);
        }

        // Enter next page after short delay
        setTimeout(() => {
          if (nextPage.classList.contains('active')) {
            triggerCardEntrances(nextPage);
          } else {
            // Wait for app.js to toggle active, then add entrance
            const check = setInterval(() => {
              if (nextPage.classList.contains('active')) {
                clearInterval(check);
                nextPage.classList.add('page-enter');
                setTimeout(() => nextPage.classList.remove('page-enter'), CFG.transition.duration);
                triggerCardEntrances(nextPage);
                triggerKpiPop(nextPage);
              }
            }, 20);
          }
        }, CFG.transition.duration * 0.3);
      });
    });
  }

  /* ══════════════════════════════════════════
     CARD ENTRANCES — staggered 3D rise
  ══════════════════════════════════════════ */
  function triggerCardEntrances(container) {
    const cards = container.querySelectorAll(
      '.kpi-card, .panel, .action-card, .dispatch-card'
    );

    cards.forEach((card, i) => {
      card.classList.remove('card-visible');
      card.classList.add('card-entrance');

      setTimeout(() => {
        card.classList.add('card-visible');
        applyTilt(card);
      }, i * CFG.entrance.stagger);
    });
  }

  /* ══════════════════════════════════════════
     KPI NUMBER POP — on page change
  ══════════════════════════════════════════ */
  function triggerKpiPop(container) {
    const kpis = container.querySelectorAll('.kpi-card strong, .dsb-num');
    kpis.forEach((el, i) => {
      el.classList.remove('kpi-pop');
      setTimeout(() => {
        void el.offsetWidth; // reflow
        el.classList.add('kpi-pop');
      }, i * 60 + 100);
    });
  }

  /* ══════════════════════════════════════════
     RIPPLE on primary/secondary buttons
  ══════════════════════════════════════════ */
  function initRipple() {
    function addRipple(e) {
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;

      const ripple = document.createElement('span');
      ripple.className = 'ripple-effect';
      ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;

      btn.style.position = 'relative';
      btn.style.overflow = 'hidden';
      btn.appendChild(ripple);

      setTimeout(() => ripple.remove(), 600);
    }

    function bindRipples() {
      document.querySelectorAll(
        '.primary-btn, .secondary-btn, .range-btn, .dispatch-filter-btn, .dispatch-btn, .nav-link'
      ).forEach(btn => {
        if (btn.dataset.ripple) return;
        btn.dataset.ripple = '1';
        btn.addEventListener('click', addRipple);
      });
    }

    bindRipples();
    const obs = new MutationObserver(bindRipples);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════════
     SIDEBAR DEPTH — slight Z shift on hover
  ══════════════════════════════════════════ */
  function initSidebarDepth() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    sidebar.addEventListener('mouseenter', () => {
      sidebar.style.transform = 'perspective(1200px) translateZ(6px)';
    });
    sidebar.addEventListener('mouseleave', () => {
      sidebar.style.transform = 'perspective(1200px) translateZ(0px)';
    });
  }

  /* ══════════════════════════════════════════
     TABLE ROW HOVER DEPTH
  ══════════════════════════════════════════ */
  function initTableRows() {
    function bindRows() {
      document.querySelectorAll('tbody tr').forEach(row => {
        if (row.dataset.depth3d) return;
        row.dataset.depth3d = '1';

        row.addEventListener('mouseenter', () => {
          row.style.transform = 'perspective(800px) translateZ(4px)';
          row.style.transition = 'transform 0.15s ease, background 0.15s ease';
          row.style.position = 'relative';
          row.style.zIndex = '1';
        });
        row.addEventListener('mouseleave', () => {
          row.style.transform = 'perspective(800px) translateZ(0px)';
          row.style.zIndex = '';
        });
      });
    }

    bindRows();
    const obs = new MutationObserver(bindRows);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════════
     INITIAL PAGE ENTRANCE on load
  ══════════════════════════════════════════ */
  function initLoadEntrance() {
    const activePage = document.querySelector('.dashboard-page.active');
    if (!activePage) return;

    activePage.style.opacity = '0';
    activePage.style.transform = 'perspective(1200px) translateZ(-40px)';

    setTimeout(() => {
      activePage.style.transition = `opacity 0.6s ease, transform 0.6s cubic-bezier(0.34,1.56,0.64,1)`;
      activePage.style.opacity = '1';
      activePage.style.transform = 'perspective(1200px) translateZ(0px)';

      triggerCardEntrances(activePage);
      triggerKpiPop(activePage);
    }, 180);
  }

  /* ══════════════════════════════════════════
     BOOT
  ══════════════════════════════════════════ */
  function boot() {
    injectStyles();
    initParticles();
    initParallax();
    initTilt();
    initPageTransitions();
    initRipple();
    initSidebarDepth();
    initTableRows();
    initLoadEntrance();

    console.log('%c⚡ ATAM GO 3D Effects loaded', 'color:#f97316;font-weight:700;font-size:13px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
