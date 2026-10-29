-- Order 636616 (29 Oct 2026): invoiced twice for the same 10 Large vests (636616 for GBP 272.16, then 636616-2 for GBP 90.72).
-- Cause: DecoNetwork re-issued the workflow item id of ONE row (Large) when the order was edited on 27 Oct. GO records
-- "already invoiced" per workflow_item_id (mark_sales_invoice_posted), so the new id looked uninvoiced (qty_invoiced 0) and
-- was invoiced again. The old row is already ignored as stale (see fix_stale_sales_order_lines_2026-10-13.sql) but its
-- qty_invoiced was never carried over.
-- Fix: a row's invoiced quantity is the larger of its own and that of any STALE (replaced) row for the same order line, size
-- and colour. Only replaced rows count, so a genuine second shipment on a separate current row is not suppressed.
-- Same columns as before. Rollback: re-run the previous definition (fix_stale_sales_order_lines_2026-10-13.sql).
create or replace view public.sales_lines_outstanding as
 SELECT l.id, l.order_id, l.line_id, l.workflow_item_id, l.product_name, l.product_code, l.sku, l.option_name, l.qty_required, l.qty_produced,
        CASE WHEN u.order_id IS NOT NULL THEN GREATEST(COALESCE(l.qty_shipped, 0), COALESCE(l.qty_required, 0)) ELSE l.qty_shipped END AS qty_shipped,
        l.qty_invoiced, l.unit_price, l.shipping_status, l.production_status, l.shipped_date, l.synced_at, l.created_at, l.updated_at, l.size, l.line_total, l.line_qty
   FROM sales_order_lines l
     LEFT JOIN upcoming_orders u ON u.order_id = l.order_id AND (u.payment_status = ANY (ARRAY[4, 5])) AND u.outstanding_balance = 0::numeric AND COALESCE(u.billable_amount, 0::numeric) > 0::numeric AND u.dismissed_at IS NULL AND (u.order_status = ANY (ARRAY[1, 2, 8, 9]))
  WHERE l.qty_invoiced IS NOT NULL AND CASE WHEN u.order_id IS NOT NULL THEN GREATEST(COALESCE(l.qty_shipped, 0), COALESCE(l.qty_required, 0)) ELSE l.qty_shipped END
        > GREATEST(l.qty_invoiced, COALESCE((
            SELECT max(COALESCE(o.qty_invoiced, 0)) FROM sales_order_lines o
             WHERE o.order_id = l.order_id AND o.line_id = l.line_id AND o.id <> l.id
               AND o.size IS NOT DISTINCT FROM l.size AND o.option_name IS NOT DISTINCT FROM l.option_name
               AND EXISTS (SELECT 1 FROM sales_order_lines nn WHERE nn.order_id = o.order_id AND nn.synced_at > o.synced_at + interval '5 minutes')
          ), 0))
    AND NOT EXISTS (SELECT 1 FROM sales_order_lines n WHERE n.order_id = l.order_id AND n.synced_at > l.synced_at + interval '5 minutes');
