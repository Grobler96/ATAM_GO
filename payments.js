/* ═══════════════════════════════════════════════════════════════
   ATAM GO — payments.js
   Adds a "Payments Received" card to the Revenue tab, reading from
   wip_payments (actual cash received, from DecoNetwork's payment
   events — separate from the existing billed/unbilled WIP status).
   Self-contained: styles itself, lazy-loads on first Revenue tab
   click, and reuses the already-authenticated Supabase client.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const GBP = v => '£' + (Number(v)||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});

  const style = document.createElement('style');
  style.textContent = `
    #payments-card{
      background:rgba(15,23,42,.82);backdrop-filter:blur(18px);
      border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:22px;
      margin-bottom:18px;box-shadow:0 22px 70px rgba(0,0,0,.35);
    }
    #payments-card .pc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:16px}
    #payments-card .pc-title{font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#38bdf8}
    #payments-card .pc-total{font-size:clamp(24px,3vw,34px);font-weight:800;color:#f8fafc;letter-spacing:-.03em}
    #payments-card .pc-sub{font-size:12px;color:#94a3b8;margin-top:2px}
    #payments-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto}
    .pc-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}
    .pc-row:last-child{border-bottom:none}
    .pc-row .pc-cust{color:#f8fafc;font-weight:600}
    .pc-row .pc-meta{color:#94a3b8;font-size:11.5px;margin-top:2px}
    .pc-row .pc-amt{color:#4ade80;font-weight:800;white-space:nowrap}
    #payments-card .pc-empty{padding:24px 0;text-align:center;color:#64748b;font-size:12.5px}
  `;
  document.head.appendChild(style);

  async function fetchAllPayments(sb, since){
    const PAGE = 1000;
    let all = [], from = 0;
    while(true){
      const res = await sb.from('wip_payments').select('*')
        .gte('date_paid', since)
        .order('date_paid', {ascending:false})
        .range(from, from+PAGE-1);
      if(res.error) throw res.error;
      const batch = res.data || [];
      all = all.concat(batch);
      if(batch.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  async function loadPaymentsCard(){
    const container = document.getElementById('view-overview');
    if(!container || document.getElementById('payments-card')) return; // already injected

    const card = document.createElement('div');
    card.id = 'payments-card';
    card.innerHTML = `
      <div class="pc-head">
        <div>
          <div class="pc-title">Payments Received — This Month</div>
          <div class="pc-sub" id="pc-count">Loading…</div>
        </div>
        <div style="text-align:right">
          <div class="pc-total" id="pc-total">£0.00</div>
        </div>
      </div>
      <div id="payments-list"></div>
    `;
    // Insert right after the target card, before the month tabs.
    const targetCard = container.querySelector('.target-card');
    if(targetCard && targetCard.nextSibling){
      targetCard.parentNode.insertBefore(card, targetCard.nextSibling);
    } else {
      container.prepend(card);
    }

    try{
      const sb = window._atamSb;
      if(!sb) throw new Error('Supabase client not ready');

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const payments = await fetchAllPayments(sb, monthStart);

      const totalPaid = payments.reduce((a,p)=>a+(Number(p.paid_amount)||0),0);
      const totalRefunded = payments.reduce((a,p)=>a+(Number(p.refunded_amount)||0),0);

      document.getElementById('pc-total').textContent = GBP(totalPaid - totalRefunded);
      document.getElementById('pc-count').textContent =
        `${payments.length} payment${payments.length===1?'':'s'}` +
        (totalRefunded>0 ? ` · ${GBP(totalRefunded)} refunded` : '');

      const listEl = document.getElementById('payments-list');
      if(!payments.length){
        listEl.innerHTML = `<div class="pc-empty">No payments recorded yet this month.</div>`;
        return;
      }

      // Look up customer names for the visible slice only (keeps this cheap).
      const shown = payments.slice(0, 15);
      const orderIds = [...new Set(shown.map(p=>p.order_id))];
      let nameByOrder = {};
      if(orderIds.length){
        const { data: orderRows } = await sb.from('wip_orders').select('order_id,customer_name').in('order_id', orderIds);
        (orderRows||[]).forEach(o => { nameByOrder[o.order_id] = o.customer_name; });
      }

      listEl.innerHTML = shown.map(p => {
        const when = p.date_paid ? new Date(p.date_paid).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—';
        const cust = nameByOrder[p.order_id] || `Order #${p.order_id}`;
        return `<div class="pc-row">
          <div>
            <div class="pc-cust">${cust}</div>
            <div class="pc-meta">#${p.order_id} · ${p.payment_method || 'Unknown method'} · ${when}</div>
          </div>
          <div class="pc-amt">${GBP(p.paid_amount)}</div>
        </div>`;
      }).join('');

    } catch(err){
      console.error('[payments.js]', err);
      const listEl = document.getElementById('payments-list');
      if(listEl) listEl.innerHTML = `<div class="pc-empty">Couldn't load payments: ${err.message||err}</div>`;
    }
  }

  let initialized = false;
  const btn = document.querySelector('.nav-link[data-page="revenue"]');
  if(btn){
    btn.addEventListener('click', () => {
      if(initialized) return;
      initialized = true;
      // Small delay so this lands after revenue.js has built the tab's own DOM.
      setTimeout(loadPaymentsCard, 400);
    });
  }
})();
