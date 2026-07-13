WITH active_order_stats AS (
  SELECT oi.order_id,
         SUM(oi.ordered_qty) AS total_ordered_qty,
         SUM(oi.received_qty) AS total_received_qty,
         SUM(CASE WHEN oi.received_qty < oi.ordered_qty THEN 1 ELSE 0 END)
           AS remaining_item_count
    FROM order_items oi
   WHERE oi.is_deleted = 0
   GROUP BY oi.order_id
),
active_duplicate_groups AS (
  SELECT order_id, item_id
    FROM order_items
   WHERE is_deleted = 0
   GROUP BY order_id, item_id
  HAVING COUNT(*) > 1
)
SELECT 'order-item-integrity-v1' AS query_version,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS active_overreceived_rows,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 1 AND received_qty > ordered_qty)
         AS deleted_overreceived_rows,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted NOT IN (0, 1))
         AS invalid_order_item_deletion_flag_rows,
       (SELECT COALESCE(SUM(received_qty - ordered_qty), 0)
          FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS active_overreceived_excess_qty,
       (SELECT COUNT(DISTINCT order_id) FROM order_items
         WHERE is_deleted = 0 AND received_qty > ordered_qty)
         AS overreceived_orders,
       (SELECT COUNT(*)
          FROM active_order_stats stats
          JOIN purchase_orders po ON po.id = stats.order_id AND po.is_deleted = 0
         WHERE stats.total_received_qty >= stats.total_ordered_qty
           AND stats.remaining_item_count > 0)
         AS masked_orders,
       (SELECT COUNT(*)
          FROM purchase_orders po
         WHERE po.is_deleted = 0
           AND po.status IN ('ordered', 'partially_received', 'fully_received')
           AND po.status <> (
             SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM order_items active
                  WHERE active.order_id = po.id AND active.is_deleted = 0
               ) AND NOT EXISTS (
                 SELECT 1 FROM order_items active
                  WHERE active.order_id = po.id AND active.is_deleted = 0
                    AND active.received_qty < active.ordered_qty
               ) THEN 'fully_received'
               WHEN EXISTS (
                 SELECT 1 FROM order_items active
                  WHERE active.order_id = po.id AND active.is_deleted = 0
                    AND active.received_qty > 0
               ) THEN 'partially_received'
               ELSE 'ordered'
             END
           ))
         AS active_status_mismatch_orders,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND ordered_qty <= 0)
         AS active_nonpositive_ordered_rows,
       (SELECT COUNT(*) FROM order_items
         WHERE is_deleted = 0 AND received_qty < 0)
         AS active_negative_received_rows,
       (SELECT COUNT(*) FROM active_duplicate_groups)
         AS active_duplicate_groups,
       (SELECT COUNT(DISTINCT oi.id)
          FROM order_items oi
          JOIN stock_transactions st ON st.order_item_id = oi.id
         WHERE oi.is_deleted = 0 AND st.item_id <> oi.item_id)
         AS active_mismatched_ledger_item_rows,
       (SELECT COUNT(*)
          FROM order_items oi
         WHERE oi.is_deleted = 0
           AND oi.received_qty <> COALESCE((
             SELECT SUM(st.quantity)
               FROM stock_transactions st
              WHERE st.order_item_id = oi.id
                AND st.item_id = oi.item_id
                AND st.movement_type = 'IN'
           ), 0))
         AS active_receipt_ledger_mismatch_rows,
       (SELECT COUNT(*) FROM order_items oi
          LEFT JOIN purchase_orders po ON po.id = oi.order_id
         WHERE oi.is_deleted = 0 AND po.id IS NULL)
         AS active_missing_order_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN purchase_orders po ON po.id = oi.order_id
         WHERE oi.is_deleted = 0 AND po.is_deleted = 1)
         AS active_deleted_order_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN purchase_orders po ON po.id = oi.order_id
         WHERE oi.is_deleted = 0 AND po.is_deleted NOT IN (0, 1))
         AS active_invalid_order_parent_deletion_flag_rows,
       (SELECT COUNT(*) FROM order_items oi
          LEFT JOIN items i ON i.id = oi.item_id
         WHERE oi.is_deleted = 0 AND i.id IS NULL)
         AS active_missing_item_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN items i ON i.id = oi.item_id
         WHERE oi.is_deleted = 0 AND i.is_deleted = 1)
         AS active_deleted_item_parent_rows,
       (SELECT COUNT(*) FROM order_items oi
          JOIN items i ON i.id = oi.item_id
         WHERE oi.is_deleted = 0 AND i.is_deleted NOT IN (0, 1))
         AS active_invalid_item_parent_deletion_flag_rows;
