(function(){
'use strict';

/* ================= Boot & auth (merged into ATAM GO) ================= */
const CFG = window.ATAM_GO_CONFIG || {};
const sb = window._atamSb || supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const GBP = v => '£' + (Number(v)||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const NUM = v => (Number(v)||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});

let orders = [], monthly = [], months = [], selected = null;
const MONTHLY_TARGET = Number(CFG.MONTHLY_TARGET) || 40000; // static for now — update in config.js

/* ================= View nav ================= */
document.querySelectorAll('.view-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.view-btn').forEach(b=>b.classList.toggle('active', b===btn));
    const v = btn.dataset.view;
    document.getElementById('view-overview').classList.toggle('active', v==='overview');
    document.getElementById('view-team').classList.toggle('active', v==='team');
    if(v==='team') renderTeam(selected);
  });
});

let revenueInitialized = false;
async function initRevenue(){
  if(revenueInitialized) return; // lazy-load once, on first visit to this tab
  revenueInitialized = true;
  const loadingEl = document.getElementById('revenue-loading');
  const ok = await loadData();
  if(!ok){ revenueInitialized = false; return; } // allow retry on next tab click if it failed
  if(loadingEl) loadingEl.remove();
  buildTabs();
  const nowM = new Date().toISOString().slice(0,7);
  selectMonth(months.includes(nowM) ? nowM : (months[months.length-1] || nowM));
  drawTrend();
  maybeCelebrate();
  setInterval(loadData, 5*60*1000); // refresh data every 5 min
}

async function fetchAllOrders(){
  // Supabase's REST API caps any single response at 1000 rows. wip_orders has grown
  // past that, so a plain select() silently truncates to the oldest 1000 rows and
  // misses everything current. Page through in batches of 1000 until exhausted.
  const PAGE = 1000;
  let all = [], from = 0, lastError = null;
  while(true){
    const res = await sb.from('wip_orders').select('*').order('date_due',{ascending:true}).range(from, from+PAGE-1);
    if(res.error){ lastError = res.error; break; }
    const batch = res.data || [];
    all = all.concat(batch);
    if(batch.length < PAGE) break; // last page
    from += PAGE;
  }
  return { data: all, error: lastError };
}

async function loadData(){
  const [o, m] = await Promise.all([
    fetchAllOrders(),
    sb.from('monthly_revenue').select('*').order('month',{ascending:true})
  ]);
  if(o.error||m.error){
    console.error(o.error||m.error);
    const msg = (o.error||m.error).message || 'Could not connect to the data source.';
    toast('Revenue tab: ' + msg);
    return false;
  }
  orders = o.data||[]; monthly = m.data||[];
  months = [...new Set([...monthly.map(r=>r.month), ...orders.map(r=>r.billing_month)])].filter(Boolean).sort();
  const last = orders.reduce((a,r)=> r.synced_at>a ? r.synced_at : a, '');
  const t = last ? new Date(last).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
  const syncEl = document.getElementById('revenue-sync-time');
  if(syncEl) syncEl.textContent = t;
  renderMonthOverview();
  renderTarget();
  if(document.getElementById('view-team').classList.contains('active')) renderTeam(selected);
  return true;
}

/* ================= Month helpers ================= */
const monthLabel = m => new Date(m+'-01T00:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'});
const monthShort = m => new Date(m+'-01T00:00:00').toLocaleDateString('en-GB',{month:'short',year:'2-digit'});
function stats(m){
  const rows = orders.filter(o=>o.billing_month===m);
  const sum = a => a.reduce((s,o)=>s+(Number(o.order_value)||0),0);
  const billedRows = rows.filter(o=>o.is_billed);
  const unbilledRows = rows.filter(o=>!o.is_billed);
  return {
    rows, count:rows.length,
    total:sum(rows),
    billed:sum(billedRows), billedCount:billedRows.length,
    unbilled:sum(unbilledRows), unbilledCount:unbilledRows.length
  };
}

/* ================= Tabs ================= */
function buildTabs(){
  const el = document.getElementById('tabs');
  el.innerHTML = '';
  const nowM = new Date().toISOString().slice(0,7);
  months.forEach(m=>{
    const s = stats(m);
    const pct = s.total ? s.billed/s.total : 0;
    const color = m > nowM ? 'var(--muted)' : pct >= .7 ? 'var(--green)' : 'var(--amber)';
    const tab = document.createElement('div');
    tab.className = 'tab'; tab.dataset.month = m;
    tab.setAttribute('role','tab'); tab.tabIndex = 0;
    tab.innerHTML = `
      <div class="t-month"><span class="t-ind" style="background:${color};box-shadow:0 0 7px ${color}"></span>${monthLabel(m)}</div>
      <div class="t-value">${GBP(s.total)}</div>
      <div class="t-meta">${s.count} orders · ${Math.round(pct*100)}% billed</div>`;
    tab.addEventListener('click', ()=>selectMonth(m));
    tab.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' ') selectMonth(m); });
    el.appendChild(tab);
  });
}

/* ================= Count-up ================= */
function countUp(el, to, formatter){
  const from = 0, dur = 700, t0 = performance.now();
  function frame(t){
    const p = Math.min((t-t0)/dur, 1);
    const e = 1 - Math.pow(1-p, 3); // ease-out-cubic
    el.textContent = formatter(from + (to-from)*e);
    if(p<1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ================= 3D tilt ================= */
const TILT_SEL = '.kpi,.ov-card,.team-card,.target-card,.forecast-card,.trend-card,.tab';
let tiltActive = null;
document.addEventListener('mousemove', e=>{
  const card = e.target.closest(TILT_SEL);
  if(tiltActive && tiltActive !== card){
    tiltActive.style.transform = '';
    tiltActive = null;
  }
  if(!card) return;
  tiltActive = card;
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left)/r.width - .5;
  const py = (e.clientY - r.top)/r.height - .5;
  card.style.transform = `perspective(900px) rotateX(${(-py*7).toFixed(2)}deg) rotateY(${(px*7).toFixed(2)}deg) translateY(-2px)`;
});
document.addEventListener('mouseleave', ()=>{
  if(tiltActive){ tiltActive.style.transform=''; tiltActive=null; }
});

/* ================= Gold explosion (target hit) ================= */
let celebrated = false;
function goldExplosion(){
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:300;overflow:hidden';
  document.body.appendChild(layer);
  const originX = innerWidth/2, originY = innerHeight*0.32;
  const N = 90;
  for(let i=0;i<N;i++){
    const p = document.createElement('div');
    const angle = Math.random()*Math.PI*2;
    const speed = 4 + Math.random()*11;
    const size = 4 + Math.random()*8;
    const isCoin = Math.random() < .35;
    p.style.cssText = `position:absolute;left:${originX}px;top:${originY}px;width:${size}px;height:${size}px;
      background:${isCoin ? 'radial-gradient(circle at 35% 30%, #fff6cf, #eab308 55%, #92400e)' : 'linear-gradient(135deg,#fde68a,#f59e0b)'};
      border-radius:${isCoin ? '50%' : '2px'};box-shadow:0 0 6px rgba(250,204,21,.75);`;
    layer.appendChild(p);
    const vx = Math.cos(angle)*speed, vy = Math.sin(angle)*speed - 5;
    let x=0, y=0, vyL=vy, rot=Math.random()*360, vr=(Math.random()-.5)*22, t=0;
    (function frame(){
      t += 1; vyL += 0.32; x += vx; y += vyL; rot += vr;
      const life = t/72;
      p.style.transform = `translate(${x}px,${y}px) rotate(${rot}deg)`;
      p.style.opacity = Math.max(0, 1-life);
      if(life < 1) requestAnimationFrame(frame); else p.remove();
    })();
  }
  const flash = document.getElementById('gold-flash');
  flash.textContent = '🏆 MONTHLY TARGET HIT';
  requestAnimationFrame(()=>flash.classList.add('show'));
  setTimeout(()=>flash.classList.remove('show'), 2400);
  setTimeout(()=>layer.remove(), 3200);
}
function maybeCelebrate(){
  if(celebrated) return;
  const nowM = new Date().toISOString().slice(0,7);
  const s = stats(nowM);
  if(MONTHLY_TARGET && s.total >= MONTHLY_TARGET){
    celebrated = true;
    setTimeout(goldExplosion, 700);
  }
}

/* ================= Coin fill color ================= */
function coinColors(pct){
  if(pct >= 100) return ['#15803d','#22c55e'];      // green — target hit
  if(pct >= 60)  return ['#0284c7','#38bdf8'];      // blue — on track
  return ['#b45309','#f59e0b'];                     // amber — early days
}
function paintCoin(fillEl, symEl, glowEl, pctEl, pct){
  const clamped = Math.max(0, Math.min(100, pct));
  const [c1,c2] = coinColors(pct);
  fillEl.style.setProperty('--fc1', c1);
  fillEl.style.setProperty('--fc2', c2);
  requestAnimationFrame(()=>{ fillEl.style.height = clamped + '%'; });
  symEl.classList.toggle('lit', clamped >= 35);
  symEl.style.setProperty('--fc2', c2);
  if(glowEl) glowEl.classList.toggle('on', pct >= 100);
  if(pctEl) pctEl.textContent = Math.round(pct) + '%';
}

/* ================= Month arithmetic (string-safe, no timezone drift) ================= */
function addMonths(ym, delta){
  let [y,m] = ym.split('-').map(Number);
  m += delta;
  while(m < 1){ m += 12; y--; }
  while(m > 12){ m -= 12; y++; }
  return y + '-' + String(m).padStart(2,'0');
}

/* ================= Next-month projection (linear trend on completed months) ================= */
function linReg(points){
  const n = points.length;
  const sumX = points.reduce((a,p)=>a+p[0],0);
  const sumY = points.reduce((a,p)=>a+p[1],0);
  const sumXY = points.reduce((a,p)=>a+p[0]*p[1],0);
  const sumXX = points.reduce((a,p)=>a+p[0]*p[0],0);
  const denom = n*sumXX - sumX*sumX;
  if(denom === 0) return { slope:0, intercept: sumY/n };
  const slope = (n*sumXY - sumX*sumY)/denom;
  const intercept = (sumY - slope*sumX)/n;
  return { slope, intercept };
}
function projectMonth(nowM, targetM){
  const completed = months.filter(m => m < nowM).sort();
  const hist = completed.slice(-6).map(m => stats(m).total);
  const known = stats(targetM).total; // orders already captured with a due date in the target month
  if(hist.length < 2) return { value: known, basis: 'captured' };
  const points = hist.map((v,i)=>[i,v]);
  const { slope, intercept } = linReg(points);
  const targetIndex = hist.length + 1; // hist ends at lastM; nowM=+0, targetM(next)=+1
  const trend = Math.max(0, intercept + slope*targetIndex);
  return { value: Math.max(known, trend), basis:'trend', trend, known };
}

/* ================= Month overview strip ================= */
function renderMonthOverview(){
  const nowM = new Date().toISOString().slice(0,7);
  const lastM = addMonths(nowM,-1);
  const nextM = addMonths(nowM, 1);
  const proj = projectMonth(nowM, nextM);
  const cards = [
    {m:lastM, tag:'Last Month', cur:false},
    {m:nowM,  tag:'This Month', cur:true},
    {m:nextM, tag:'Next Month', cur:false, projected:true}
  ];
  const wrap = document.getElementById('overview-strip');
  wrap.innerHTML = cards.map(c=>{
    const s = stats(c.m);
    const value = c.projected ? proj.value : s.total;
    const basisNote = c.projected
      ? (proj.basis === 'trend' ? `Trend-projected from ${Math.min(months.filter(m=>m<nowM).length,6)}mo history` : 'Based on orders captured so far')
      : '';
    return `<div class="ov-card ${c.cur?'now':''}">
      <div class="ov-eyebrow">${c.tag}${c.cur?'<em>NOW</em>':(c.projected?'<em>PROJECTED</em>':'')}</div>
      <div class="ov-month">${monthLabel(c.m)}</div>
      <div class="ov-value">${GBP(value)}</div>
      <div class="ov-meta"><span><b>${s.count}</b> orders</span><span><b>${GBP(s.billed)}</b> billed</span></div>
      ${basisNote?`<div class="ov-basis">${basisNote}</div>`:''}
    </div>`;
  }).join('');
}

/* ================= Target coin ================= */
function renderTarget(){
  const nowM = new Date().toISOString().slice(0,7);
  const s = stats(nowM);
  const pct = MONTHLY_TARGET ? (s.total / MONTHLY_TARGET) * 100 : 0;
  paintCoin(
    document.getElementById('target-coin-fill'),
    document.getElementById('target-coin-symbol'),
    document.getElementById('target-coin-glow'),
    document.getElementById('target-coin-pct'),
    pct
  );
  countUp(document.getElementById('target-current'), s.total, NUM);
  document.getElementById('target-goal').textContent = GBP(MONTHLY_TARGET);
  requestAnimationFrame(()=>{
    document.getElementById('target-bar-fill').style.width = Math.min(100,pct).toFixed(1)+'%';
    const [,c2] = coinColors(pct);
    document.getElementById('target-bar-fill').style.background = `linear-gradient(90deg, ${coinColors(pct)[0]}, ${c2})`;
  });
  const remaining = Math.max(0, MONTHLY_TARGET - s.total);
  document.querySelector('.target-card').classList.toggle('hit', pct >= 100);
  document.getElementById('target-foot').innerHTML = pct >= 100
    ? `Target reached — <b>${GBP(s.total - MONTHLY_TARGET)}</b> over £40,000 for ${monthLabel(nowM)}.`
    : `<b>${GBP(remaining)}</b> remaining to hit target for ${monthLabel(nowM)}.`;
}

/* ================= Team view ================= */
function renderTeam(m){
  const month = m || new Date().toISOString().slice(0,7);
  document.getElementById('team-title').textContent = `Team Revenue — ${monthLabel(month)}`;
  const rows = orders.filter(o=>o.billing_month===month);
  const byWorker = {};
  rows.forEach(o=>{
    const name = o.assigned_to || 'Unassigned';
    (byWorker[name] = byWorker[name] || {name, total:0, count:0, billed:0}).total += Number(o.order_value)||0;
    byWorker[name].count += 1;
    if(o.is_billed) byWorker[name].billed += Number(o.order_value)||0;
  });
  const list = Object.values(byWorker).sort((a,b)=>b.total-a.total);
  const grid = document.getElementById('team-grid');
  if(!list.length){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No orders assigned in ${monthLabel(month)} yet.</div>`;
    return;
  }
  grid.innerHTML = list.map((w,i)=>{
    const pct = MONTHLY_TARGET ? (w.total / MONTHLY_TARGET) * 100 : 0;
    return `<div class="team-card" style="position:relative">
      <div class="team-rank">#${i+1}</div>
      <div class="coin-wrap">
        <div class="coin" style="--coin-w:96px;--coin-h:118px;--sym-size:42px">
          <div class="coin-fill" id="tf-${i}"></div>
          <div class="coin-symbol" id="ts-${i}">£</div>
          <div class="coin-glow" id="tg-${i}"></div>
        </div>
      </div>
      <div class="team-name">${w.name}</div>
      <div class="team-value">${GBP(w.total)}</div>
      <div class="team-meta">${w.count} orders · ${GBP(w.billed)} billed</div>
    </div>`;
  }).join('');
  list.forEach((w,i)=>{
    const pct = MONTHLY_TARGET ? (w.total / MONTHLY_TARGET) * 100 : 0;
    paintCoin(
      document.getElementById(`tf-${i}`),
      document.getElementById(`ts-${i}`),
      document.getElementById(`tg-${i}`),
      null,
      pct
    );
  });
}

/* ================= Select month ================= */
function selectMonth(m){
  selected = m;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.month===m));
  const active = document.querySelector('.tab.active');
  if(active) active.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});
  const s = stats(m);

  countUp(document.getElementById('kpi-total'), s.total, NUM);
  countUp(document.getElementById('kpi-billed'), s.billed, NUM);
  countUp(document.getElementById('kpi-unbilled'), s.unbilled, NUM);
  document.getElementById('kpi-total-sub').textContent = `${s.count} orders in pipeline`;
  document.getElementById('kpi-billed-sub').textContent = `${s.billedCount} orders dispatched`;
  document.getElementById('kpi-unbilled-sub').textContent = `${s.unbilledCount} orders awaiting dispatch`;

  const pct = s.total ? Math.round(100*s.billed/s.total) : 0;
  countUp(document.getElementById('kpi-pct'), pct, v=>Math.round(v));
  const C = 188.5;
  requestAnimationFrame(()=>{
    document.getElementById('gauge-arc').style.strokeDashoffset = C * (1 - pct/100);
  });

  renderForecast(m, s);
  renderOrders(m, s);
  drawTrend();
}

/* ================= Forecast bar ================= */
function renderForecast(m, s){
  // Spill: unbilled orders in this month whose due date falls after month end
  const monthEnd = new Date(m+'-01T00:00:00'); monthEnd.setMonth(monthEnd.getMonth()+1);
  const spillRows = s.rows.filter(o=>!o.is_billed && o.date_due && new Date(o.date_due) >= monthEnd);
  const spill = spillRows.reduce((a,o)=>a+(Number(o.order_value)||0),0);
  const unbilledIn = s.unbilled - spill;
  const total = Math.max(s.total, 1);

  const pc = v => (100*v/total).toFixed(2)+'%';
  document.getElementById('seg-billed').style.width = '0%';
  document.getElementById('seg-unbilled').style.width = '0%';
  document.getElementById('seg-spill').style.width = '0%';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    document.getElementById('seg-billed').style.width = pc(s.billed);
    document.getElementById('seg-unbilled').style.width = pc(unbilledIn);
    document.getElementById('seg-spill').style.width = pc(spill);
  }));

  document.getElementById('fl-billed').textContent = GBP(s.billed);
  document.getElementById('fl-unbilled').textContent = GBP(unbilledIn);
  document.getElementById('fl-spill').textContent = GBP(spill);
  document.getElementById('fl-spill-wrap').style.display = spill > 0 ? 'flex' : 'none';
  document.getElementById('fl-total').textContent = GBP(s.total);

  // Today marker: position by day-of-month progress within selected month
  const now = new Date(), start = new Date(m+'-01T00:00:00');
  const days = new Date(start.getFullYear(), start.getMonth()+1, 0).getDate();
  let frac = (now - start) / (days*86400000);
  frac = Math.max(0, Math.min(1, frac));
  document.getElementById('fbar-today').style.left = (frac*100).toFixed(2)+'%';
}

/* ================= Orders list ================= */
function statusOf(o){
  const now = new Date();
  if(o.is_billed) return ['BILLED','billed'];
  if(o.date_due && new Date(o.date_due) < now) return ['OVERDUE','overdue'];
  if(o.is_production_complete) return ['AWAITING DISPATCH','awaiting'];
  return ['IN PRODUCTION','production'];
}
function renderOrders(m, s){
  document.getElementById('orders-title').textContent = `Orders — ${monthLabel(m)}`;
  const wrap = document.getElementById('orders');
  wrap.innerHTML = '';
  if(!s.rows.length){
    wrap.innerHTML = `<div class="empty-state">No orders in ${monthLabel(m)} yet. New orders appear here after the next sync.</div>`;
    return;
  }
  // Group by week of the month based on dispatch date if shipped, else due date
  const groups = {};
  s.rows.forEach(o=>{
    const d = new Date(o.date_shipped || o.date_due || m+'-01');
    const wk = Math.min(5, Math.floor((d.getDate()-1)/7)+1);
    (groups[wk] = groups[wk]||[]).push(o);
  });
  const now = new Date();
  const nowWk = (now.getFullYear()===Number(m.slice(0,4)) && (now.getMonth()+1)===Number(m.slice(5,7)))
    ? Math.min(5, Math.floor((now.getDate()-1)/7)+1) : null;
  const weekKeys = Object.keys(groups).sort((a,b)=>a-b);
  let delay = 0;
  weekKeys.forEach(wk=>{
    const g = document.createElement('div'); g.className='week-group';
    if(nowWk !== null ? Number(wk)!==nowWk : Number(wk)!==Number(weekKeys[0])) g.classList.add('collapsed');
    const val = groups[wk].reduce((a,o)=>a+(Number(o.order_value)||0),0);
    const head = document.createElement('div'); head.className='week-head';
    head.innerHTML = `Week ${wk}<span>${groups[wk].length} orders · ${GBP(val)}</span><span class="week-chevron">▾</span>`;
    head.addEventListener('click', ()=>g.classList.toggle('collapsed'));
    g.appendChild(head);
    const body = document.createElement('div'); body.className='week-body';
    const inner = document.createElement('div'); inner.className='week-body-inner';
    body.appendChild(inner);
    groups[wk]
      .sort((a,b)=>new Date(a.date_shipped||a.date_due||0)-new Date(b.date_shipped||b.date_due||0))
      .forEach(o=>{
        const [label, cls] = statusOf(o);
        const due = o.date_due ? new Date(o.date_due).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—';
        const ship = o.date_shipped
          ? '<b>'+new Date(o.date_shipped).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+'</b>'
          : 'Pending dispatch';
        const procs = (o.processes||[]).map(p=>`<span class="ptag">${String(p).toUpperCase()}</span>`).join('');
        const row = document.createElement('div');
        row.className = 'order-row'; row.tabIndex = 0;
        row.style.animationDelay = delay+'ms'; delay += 40;
        row.innerHTML = `
          <span class="o-id">#${o.order_id}</span>
          <span class="o-cust">${o.customer_name||'—'}<small>${o.store_name||''}</small></span>
          <span class="o-qty">${o.garment_qty ?? '—'} pcs</span>
          <span class="o-val">${GBP(o.order_value)}</span>
          <span class="o-date">Due ${due}</span>
          <span class="o-date">${ship}</span>
          <span class="rev-badge ${cls}">${label}</span>
          <span class="proc-tags">${procs}</span>
          <div class="o-detail">
            <div><b>Assigned to</b>${o.assigned_to||'Unassigned'}</div>
            <div><b>Shipping</b>${o.shipping_method||'—'}</div>
            <div><b>Order status</b>${o.order_status ?? '—'}</div>
            <div><b>Invoiced</b>${o.date_invoiced ? new Date(o.date_invoiced).toLocaleDateString('en-GB') : 'Not invoiced'}</div>
            <div><b>Production</b>${o.is_production_complete ? 'Complete' : 'In progress'}</div>
            <div><b>Last synced</b>${o.synced_at ? new Date(o.synced_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</div>
          </div>`;
        row.addEventListener('click', ()=>row.classList.toggle('open'));
        row.addEventListener('keydown', e=>{ if(e.key==='Enter') row.classList.toggle('open'); });
        requestAnimationFrame(()=>row.classList.add('in'));
        inner.appendChild(row);
      });
    g.appendChild(body);
    wrap.appendChild(g);
  });
}

/* ================= Trend chart (SVG, no libs) ================= */
function drawTrend(){
  const svg = document.getElementById('trend');
  const nowM = new Date().toISOString().slice(0,7);
  // rolling 6 months ending at current month (or latest data month)
  const anchor = months.includes(nowM) ? nowM : (months[months.length-1] || nowM);
  const seq = [];
  const a = new Date(anchor+'-01T00:00:00');
  for(let i=5;i>=0;i--){
    const d = new Date(a); d.setMonth(d.getMonth()-i);
    seq.push(d.toISOString().slice(0,7));
  }
  const vals = seq.map(m=>{
    const mr = monthly.find(r=>r.month===m);
    return mr ? Number(mr.billed_value)||0 : stats(m).billed;
  });
  const W = svg.clientWidth || 900, H = 240, padB = 34, padT = 16, padX = 24;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const max = Math.max(...vals, 1);
  const bw = Math.min(70, (W - padX*2) / seq.length * 0.55);
  const step = (W - padX*2) / seq.length;
  let html = '';
  // gridlines
  for(let i=1;i<=3;i++){
    const y = padT + (H-padB-padT) * (1 - i/3);
    html += `<line x1="${padX}" x2="${W-padX}" y1="${y}" y2="${y}" stroke="#131e34" stroke-dasharray="3 5"/>`;
    html += `<text x="${padX}" y="${y-5}" fill="#64748b" font-size="10">${GBP(max*i/3)}</text>`;
  }
  seq.forEach((m,i)=>{
    const h = (H-padB-padT) * (vals[i]/max);
    const x = padX + step*i + (step-bw)/2;
    const y = H - padB - h;
    const cur = m===anchor;
    html += `<g class="trend-g" data-m="${m}" data-v="${vals[i]}">
      <rect class="trend-bar" x="${x}" y="${y}" width="${bw}" height="${Math.max(h,2)}" rx="6"
        fill="${cur ? 'url(#gCur)' : 'url(#gStd)'}"
        style="transition-delay:${i*60}ms;${cur?'filter:drop-shadow(0 0 8px rgba(56,189,248,.5))':''}"/>
      <rect x="${padX+step*i}" y="${padT}" width="${step}" height="${H-padT-padB}" fill="transparent" class="trend-hit"/>
      <text x="${x+bw/2}" y="${H-12}" text-anchor="middle" fill="${cur?'#38bdf8':'#64748b'}" font-size="11" font-weight="${cur?700:400}">${monthShort(m)}</text>
    </g>`;
  });
  svg.innerHTML = `<defs>
    <linearGradient id="gStd" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#15803d"/>
    </linearGradient>
    <linearGradient id="gCur" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#0284c7"/>
    </linearGradient>
  </defs>` + html;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    svg.querySelectorAll('.trend-bar').forEach(b=>b.classList.add('up'));
  }));
  // tooltip
  const tip = document.getElementById('trend-tip');
  svg.querySelectorAll('.trend-g').forEach(g=>{
    g.addEventListener('mousemove', e=>{
      const m = g.dataset.m, v = Number(g.dataset.v);
      const s = stats(m);
      tip.innerHTML = `<b>${monthLabel(m)}</b><br>Billed: <b style="color:#22c55e">${GBP(v)}</b><br>Pipeline: ${GBP(s.total)} · ${s.count} orders`;
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX+14, innerWidth-220)+'px';
      tip.style.top = (e.clientY-10)+'px';
    });
    g.addEventListener('mouseleave', ()=>tip.style.display='none');
  });
}
window.addEventListener('resize', ()=>{ if(months.length) drawTrend(); });

/* ================= Wire into ATAM GO's tab navigation ================= */
// bindPageNavigation() in app.js owns the visual tab-switching (it sets .onclick
// on every .nav-link, including this one). We attach via addEventListener instead
// of .onclick so both handlers run without clobbering each other — this one just
// lazy-loads the revenue data the first time the tab is actually opened.
const revenueNavBtn = document.querySelector('.nav-link[data-page="revenue"]');
if(revenueNavBtn) revenueNavBtn.addEventListener('click', initRevenue);
})();
