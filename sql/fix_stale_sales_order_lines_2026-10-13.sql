-- Order 636210 (13 Oct 2026): GO staged an invoice for GBP 219.90 but DecoNetwork had invoiced GBP 85.44 (+VAT = 102.53).
-- Cause: when an order is edited in DecoNetwork it issues NEW workflow item ids. WF3 upserts sales_order_lines by
-- workflow_item_id and never deletes, so the replaced items stayed behind (still qty_shipped > qty_invoiced) and were
-- invoiced on top of the real ones.
-- Fix: every WF3 run stamps all of an order's current items with the same synced_at, so any item more than 5 minutes
-- older than the newest item on its order has been replaced by DecoNetwork and is ignored by the invoice stager.
-- (No rows are deleted. None of the stale rows had been invoiced: qty_invoiced = 0 on all of them.)
-- Rollback: re-run the previous definition without the final NOT EXISTS clause (see git history of this file).
create or replace view public.sales_lines_outstanding as
 SELECT l.id, l.order_id, l.line_id, l.workflow_item_id, l.product_name, l.product_code, l.sku, l.option_name, l.qty_required, l.qty_produced,
        CASE WHEN u.order_id IS NOT NULL THEN GREATEST(COALESCE(l.qty_shipped, 0), COALESCE(l.qty_required, 0)) ELSE l.qty_shipped END AS qty_shipped,
        l.qty_invoiced, l.unit_price, l.shipping_status, l.production_status, l.shipped_date, l.synced_at, l.created_at, l.updated_at, l.size, l.line_total, l.line_qty
   FROM sales_order_lines l
     LEFT JOIN upcoming_orders u ON u.order_id = l.order_id AND (u.payment_status = ANY (ARRAY[4, 5])) AND u.outstanding_balance = 0::numeric AND COALESCE(u.billable_amount, 0::numeric) > 0::numeric AND u.dismissed_at IS NULL AND (u.order_status = ANY (ARRAY[1, 2, 8, 9]))
  WHERE CASE WHEN u.order_id IS NOT NULL THEN GREATEST(COALESCE(l.qty_shipped, 0), COALESCE(l.qty_required, 0)) ELSE l.qty_shipped END > l.qty_invoiced
    AND NOT EXISTS (SELECT 1 FROM sales_order_lines n WHERE n.order_id = l.order_id AND n.synced_at > l.synced_at + interval '5 minutes');
