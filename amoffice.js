// Account managers tab: the 3D office. One little person per account manager at a desk, a meeting table in the middle with a glowing
// bar per person (their revenue), and a wall screen with the total. Click a person to open them (same as clicking their card).
// Not a page of its own: accountmanagers.js calls window.ATAM_OFFICE.attach(slot) after each draw and setData(...) with the numbers.
// Needs three.js (global THREE, r160, loaded in index.html). If WebGL is missing it quietly does nothing; the cards below always work.
(function () {
  'use strict';
  if (window.ATAM_OFFICE) return;

  const SKIN = ['#f2c9a5', '#e0a97c', '#c98b5f', '#a56a43', '#7a4a2d', '#f6d6bd'];
  const HAIR = ['#1f1a17', '#3b2a1e', '#6b4423', '#b5833a', '#8a2d1f', '#2b2f3a', '#5a5f6b'];
  const NAVY = 0x020617, FLOOR = 0x0b1226, CYAN = 0x38bdf8, PURPLE = 0xa855f7;
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const S = {
    host: null, el: null, canvas: null, tip: null, hint: null,
    renderer: null, scene: null, camera: null, root: null, ray: null,
    people: [], bars: [], items: [], meta: null, onPick: null,
    sig: '', hover: -1, theta: 0.32, phi: 1.0, drag: null, userMoved: false, t0: 0, ok: null, wall: null, raf: 0
  };

  const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const col = (h, s, l) => new THREE.Color().setHSL(h / 360, s, l);

  // ─────────────── set-up (once) ───────────────
  function init() {
    if (S.ok !== null) return S.ok;
    S.ok = false;
    try {
      if (!window.THREE) return false;
      const c = document.createElement('canvas');
      S.renderer = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true });
      S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      S.renderer.setClearColor(0x000000, 0);
      S.canvas = c;
      S.scene = new THREE.Scene();
      S.camera = new THREE.PerspectiveCamera(32, 2, 0.1, 100);
      S.ray = new THREE.Raycaster();
      S.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a1d5a, 1.25));
      const sun = new THREE.DirectionalLight(0xffffff, 0.85); sun.position.set(-6, 12, 8); S.scene.add(sun);
      const rim = new THREE.PointLight(PURPLE, 0.9, 30); rim.position.set(8, 5, -6); S.scene.add(rim);
      const glow = new THREE.PointLight(CYAN, 0.9, 22); glow.position.set(0, 3, 4); S.scene.add(glow);

      const el = document.createElement('div');
      el.className = 'amo';
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'A 3D office with one person at a desk for each account manager. The cards below show the same people.');
      c.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;cursor:grab;outline:none';
      const tip = document.createElement('div'); tip.className = 'amo-tip'; tip.hidden = true;
      const hint = document.createElement('div'); hint.className = 'amo-hint'; hint.textContent = 'Click a person to open them. Drag to turn the office.';
      el.append(c, tip, hint);
      S.el = el; S.tip = tip; S.hint = hint;

      c.addEventListener('pointerdown', e => { S.drag = { x: e.clientX, y: e.clientY, th: S.theta, ph: S.phi, moved: false, id: e.pointerId }; });
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      c.addEventListener('pointerleave', () => { if (!S.drag) setHover(-1); });
      if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
      S.ok = true;
    } catch (e) { console.warn('3D office unavailable', e); S.ok = false; }
    return S.ok;
  }

  function resize() {
    if (!S.el || !S.renderer) return;
    const w = S.el.clientWidth || 600, h = S.el.clientHeight || 360;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
    S.aspect = w / h;
  }

  // ─────────────── pointer ───────────────
  function pick(e) {
    const r = S.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    S.ray.setFromCamera(v, S.camera);
    const hit = S.ray.intersectObjects(S.people.map(p => p.group), true)[0];
    if (!hit) return -1;
    let o = hit.object; while (o && o.userData.idx === undefined) o = o.parent;
    return o ? o.userData.idx : -1;
  }
  function onMove(e) {
    if (!S.canvas) return;
    if (S.drag) {
      const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) S.drag.moved = true;
      if (S.drag.moved) {
        S.userMoved = true;
        S.theta = Math.max(-1.1, Math.min(1.1, S.drag.th - dx * 0.006));
        if (e.pointerType === 'mouse') S.phi = Math.max(0.65, Math.min(1.25, S.drag.ph - dy * 0.004));
        S.canvas.style.cursor = 'grabbing';
        setHover(-1);
      }
      return;
    }
    if (e.target !== S.canvas) return;
    const i = pick(e);
    setHover(i, e);
  }
  function onUp(e) {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (S.canvas) S.canvas.style.cursor = 'grab';
    if (!d.moved && e.target === S.canvas) {
      const i = pick(e);
      if (i >= 0 && S.onPick) S.onPick(S.items[i].name);
    }
  }
  function setHover(i, e) {
    if (i !== S.hover) {
      S.hover = i;
      S.canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
    }
    if (i < 0) { S.tip.hidden = true; return; }
    const it = S.items[i], f = S.meta && S.meta.fmt || String;
    S.tip.innerHTML = '<b></b><span></span><span></span><span></span>';
    const k = S.tip.children;
    k[0].textContent = it.label;
    k[1].textContent = f(it.rev) + ' ' + (S.meta.periodLabel || '');
    k[2].textContent = it.accounts + (it.accounts === 1 ? ' account' : ' accounts') + (it.auto ? ', ' + it.auto + ' on automatic' : '');
    k[3].textContent = 'Open quotes ' + f(it.openValue) + (it.rate == null ? '' : ', win rate ' + Math.round(it.rate * 100) + '%');
    S.tip.hidden = false;
    if (e) {
      const r = S.el.getBoundingClientRect();
      S.tip.style.left = Math.min(r.width - 210, Math.max(6, e.clientX - r.left + 14)) + 'px';
      S.tip.style.top = Math.max(6, e.clientY - r.top - 10) + 'px';
    }
  }

  // ─────────────── building blocks ───────────────
  const mat = (c, o) => new THREE.MeshLambertMaterial(Object.assign({ color: c }, o || {}));
  const box = (w, h, d, c, x, y, z, o) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c, o)); m.position.set(x, y, z); return m; };

  function labelSprite(it) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
    const g = cv.getContext('2d');
    const text = it.label + (it.you ? '  (you)' : '');
    g.font = '600 46px system-ui, Segoe UI, Arial'; const w = Math.min(480, g.measureText(text).width + 56);
    const x = (512 - w) / 2;
    g.fillStyle = 'rgba(2,6,23,.86)'; g.strokeStyle = it.none ? 'rgba(148,163,184,.8)' : 'hsl(' + it.hue + ' 80% 62%)'; g.lineWidth = 4;
    g.beginPath(); g.roundRect ? g.roundRect(x, 18, w, 72, 36) : g.rect(x, 18, w, 72); g.fill(); g.stroke();
    g.fillStyle = '#f8fafc'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 55);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(2.5, 0.625, 1); sp.renderOrder = 10;
    return sp;
  }

  function buildPerson(it, i, pos) {
    const g = new THREE.Group(); g.position.set(pos.x, 0, pos.z); g.userData.idx = i;
    const h = hash(it.name), none = it.none;
    const shirt = none ? new THREE.Color(0x475569) : col(it.hue, 0.6, 0.45);
    const skin = SKIN[h % SKIN.length], hair = HAIR[(h >>> 3) % HAIR.length];
    const wood = 0x1e293b;
    // desk
    const desk = new THREE.Group();
    desk.add(box(2.3, 0.1, 1.1, 0x233047, 0, 0.78, 0.55));
    [[-1.05, 0.2], [1.05, 0.2], [-1.05, 0.95], [1.05, 0.95]].forEach(p => desk.add(box(0.08, 0.74, 0.08, wood, p[0], 0.37, p[1])));
    const mon = box(0.95, 0.58, 0.05, 0x0b1020, 0, 1.28, 0.62);
    const scr = box(0.86, 0.5, 0.02, none ? 0x334155 : CYAN, 0, 1.28, 0.585, { emissive: none ? 0x0 : CYAN, emissiveIntensity: 0.55 });
    desk.add(mon, scr, box(0.1, 0.22, 0.1, 0x0b1020, 0, 0.97, 0.62), box(0.7, 0.03, 0.26, 0x0f172a, 0, 0.84, 0.28));
    desk.add(box(0.28, 0.08, 0.2, 0xe2e8f0, 0.85, 0.87, 0.3)); // mug-ish block
    g.add(desk);
    if (!none) {
      // chair
      g.add(box(0.8, 0.08, 0.8, 0x0f172a, 0, 0.5, -0.5), box(0.8, 0.8, 0.08, 0x0f172a, 0, 0.95, -0.92), box(0.08, 0.5, 0.08, 0x0f172a, 0, 0.25, -0.5));
      const p = new THREE.Group(); p.position.set(0, 0, -0.5); g.add(p);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.8, 14), mat(shirt)); body.position.set(0, 1.0, 0); p.add(body);
      const head = new THREE.Group(); head.position.set(0, 1.7, 0); p.add(head);
      head.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), mat(skin)));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(hair)); cap.position.y = 0.03; cap.rotation.x = -0.25; head.add(cap);
      [-0.12, 0.12].forEach(x => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), mat(0x0b1020)); e.position.set(x, 0.0, 0.31); head.add(e); });
      const arms = [-1, 1].map(s => { const a = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.62, 8), mat(shirt)); a.position.set(s * 0.46, 1.1, 0.3); a.rotation.x = 1.25; p.add(a); return a; });
      [-0.18, 0.18].forEach(x => { const l = box(0.2, 0.2, 0.7, 0x111827, x, 0.62, 0.35); p.add(l); });
      // built facing +z, which is towards the desk (and the camera), so no extra turn
      g.userData.parts = { head, arms, body };
    }
    // floor ring that glows on hover
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.62, 40), new THREE.MeshBasicMaterial({ color: none ? 0x94a3b8 : new THREE.Color().setHSL(it.hue / 360, 0.85, 0.62), transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.03, 0.1); g.add(ring); g.userData.ring = ring;
    const sp = labelSprite(it); sp.position.set(0, none ? 1.9 : 2.55, -0.5); g.add(sp);
    // wider invisible hit box so the whole seat is easy to click
    const hit = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.8, 2.2), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(0, 1.4, 0); g.add(hit);
    return g;
  }

  function wallTexture(items, meta) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
    const g = cv.getContext('2d'), f = meta.fmt || String;
    g.fillStyle = '#070d1f'; g.fillRect(0, 0, 1024, 256);
    const gr = g.createLinearGradient(0, 0, 1024, 256); gr.addColorStop(0, 'rgba(56,189,248,.22)'); gr.addColorStop(1, 'rgba(168,85,247,.22)'); g.fillStyle = gr; g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#94a3b8'; g.font = '600 26px system-ui, Arial'; g.fillText('ATAM GO  ·  ACCOUNT MANAGERS', 40, 52);
    g.fillStyle = '#f8fafc'; g.font = '700 74px system-ui, Arial'; g.fillText(f(meta.total), 40, 135);
    g.fillStyle = '#7dd3fc'; g.font = '500 26px system-ui, Arial'; g.fillText(meta.periodLabel || '', 40, 180);
    const max = Math.max(1, ...items.map(i => Math.max(0, i.rev)));
    const n = items.length, bw = Math.min(54, 520 / Math.max(1, n) - 10);
    items.forEach((it, k) => {
      const hgt = Math.max(6, (Math.max(0, it.rev) / max) * 150), x = 470 + k * (bw + 10);
      g.fillStyle = it.none ? '#64748b' : 'hsl(' + it.hue + ' 80% 60%)'; g.fillRect(x, 220 - hgt, bw, hgt);
    });
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; return t;
  }

  function clearRoot() {
    if (!S.root) return;
    S.scene.remove(S.root);
    S.root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { const m = o.material; if (m.map) m.map.dispose(); m.dispose(); } });
  }

  function build() {
    clearRoot();
    const root = new THREE.Group(); S.root = root; S.scene.add(root);
    const items = S.items, n = items.length;
    const cols = n <= 3 ? n : n <= 6 ? 3 : 4, rows = Math.ceil(n / cols);
    const gapX = 3.1, gapZ = 3.3;
    const W = Math.max(9, cols * gapX + 2.4), D = rows * gapZ + 6.4;
    // floor
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, D), mat(FLOOR)); floor.position.set(0, -0.15, 0); root.add(floor);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 0.3, D)), new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.55 })); edge.position.copy(floor.position); root.add(edge);
    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D)), 0x1d4ed8, 0x172554); grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.01; root.add(grid);
    // back wall with the screen, left wall low
    const backZ = -D / 2;
    root.add(box(W, 3.6, 0.2, 0x16224a, 0, 1.8, backZ));
    root.add(box(0.2, 1.2, D, 0x16224a, -W / 2, 0.6, 0));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(8.5, W - 2), Math.min(8.5, W - 2) / 4), new THREE.MeshBasicMaterial({ map: wallTexture(items, S.meta) }));
    screen.position.set(0, 2.55, backZ + 0.12); root.add(screen); S.wall = screen;
    root.add(box(Math.min(8.5, W - 2) + 0.2, Math.min(8.5, W - 2) / 4 + 0.2, 0.06, CYAN, 0, 2.55, backZ + 0.09, { emissive: CYAN, emissiveIntensity: 0.6 }));
    // people
    S.people = items.map((it, i) => {
      const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - cols * (rows - 1) : cols, c = i - r * cols;
      const pos = { x: (c - (inRow - 1) / 2) * gapX, z: backZ + 2.6 + r * gapZ };
      const g = buildPerson(it, i, pos); root.add(g);
      return { group: g, base: pos, phase: (hash(it.name) % 100) / 16 };
    });
    // meeting table at the front, bars grow from it
    const tz = D / 2 - 2.1, T = new THREE.Group(); T.position.set(0, 0, tz); root.add(T);
    T.add(new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.12, 40), mat(0xe2e8f0)).translateY(0.78));
    T.add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 0.78, 16), mat(0x1e293b)).translateY(0.39));
    const max = Math.max(1, ...items.map(i => Math.max(0, i.rev)));
    S.bars = items.map((it, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2, h = 0.15 + (Math.max(0, it.rev) / max) * 1.7;
      const c = it.none ? new THREE.Color(0x64748b) : col(it.hue, 0.8, 0.58);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.34, h, 0.34), new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.55 }));
      b.position.set(Math.cos(a) * 1.55, 0.84 + h / 2, Math.sin(a) * 1.55); T.add(b); b.userData.h = h; return b;
    });
    const cx = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.03, 8, 64), new THREE.MeshBasicMaterial({ color: PURPLE })); cx.rotation.x = Math.PI / 2; cx.position.y = 0.85; T.add(cx);
    S.room = { W, D };
    S.sig = signature();
    resize();
  }

  const signature = () => S.items.map(i => i.name + ':' + Math.round(i.rev) + ':' + i.accounts + ':' + i.hue).join('|') + '#' + (S.meta ? Math.round(S.meta.total) : 0);

  // ─────────────── loop ───────────────
  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    if (!S.el || !S.el.isConnected || !S.el.offsetParent || document.hidden || !S.root) return;
    const t = now / 1000;
    if (!S.t0) S.t0 = t;
    const sway = (reduceMotion || S.userMoved) ? 0 : Math.sin((t - S.t0) * 0.25) * 0.07;
    const R = Math.max(S.room.W, S.room.D) * (S.aspect < 1.4 ? 1.25 : S.aspect > 2.2 ? 1.0 : 0.95) * 1.05 + 3;
    const th = S.theta + sway;
    S.camera.position.set(Math.sin(th) * Math.sin(S.phi) * R, Math.cos(S.phi) * R + 0.5, Math.cos(th) * Math.sin(S.phi) * R * 0.98);
    S.camera.lookAt(0, 1.3, 0.2);
    S.people.forEach((p, i) => {
      const parts = p.group.userData.parts, hv = i === S.hover;
      const ring = p.group.userData.ring; if (ring) ring.material.opacity += ((hv ? 0.9 : 0) - ring.material.opacity) * 0.2;
      p.group.position.y += ((hv ? 0.06 : 0) - p.group.position.y) * 0.2;
      if (!parts || reduceMotion) return;
      const w = t * 2 + p.phase;
      parts.head.position.y = 1.7 + Math.sin(w * 0.7) * 0.015;
      parts.head.rotation.y = Math.sin(w * 0.35) * 0.18 + (hv ? 0 : 0);
      parts.arms[0].rotation.x = 1.25 + Math.sin(w * 4) * 0.07; parts.arms[1].rotation.x = 1.25 + Math.cos(w * 4.3) * 0.07;
    });
    S.bars.forEach((b, i) => { const hv = i === S.hover; const k = hv ? 1.15 : 1; b.scale.x += (k - b.scale.x) * 0.2; b.scale.z = b.scale.x; b.material.emissiveIntensity += ((hv ? 1.1 : 0.55) - b.material.emissiveIntensity) * 0.2; });
    S.renderer.render(S.scene, S.camera);
  }

  // ─────────────── public ───────────────
  window.ATAM_OFFICE = {
    available() { return init(); },
    // items: [{ name, label, hue, rev, accounts, auto, openValue, rate, you, none }]; meta: { total, periodLabel, fmt }
    setData(items, meta, onPick) {
      if (!init()) return;
      S.items = items; S.meta = meta; S.onPick = onPick;
      if (!S.root || signature() !== S.sig) build();
      if (!S.raf) S.raf = requestAnimationFrame(frame);
    },
    // Put the (kept-alive) canvas into the slot that the page just drew.
    attach(slot) {
      if (!slot || !init()) return;
      if (S.el.parentNode !== slot) slot.appendChild(S.el);
      resize();
    },
    detach() { if (S.el && S.el.parentNode) S.el.remove(); }
  };
})();
