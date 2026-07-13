WITH active_order_facts AS (
  SELECT oi.order_id,
         COUNT(*) AS active_item_count,
         SUM(oi.ordered_qty) AS total_ordered_qty,
         SUM(oi.received_qty) AS total_received_qty,
         SUM(CASE WHEN oi.received_qty < oi.ordered_qty THEN 1 ELSE 0 END)
           AS remaining_item_count,
         SUM(CASE WHEN oi.received_qty > 0 THEN 1 ELSE 0 END)
           AS positive_received_item_count
    FROM order_items oi
   WHERE oi.is_deleted = 0
   GROUP BY oi.order_id
),
order_status_facts AS (
  SELECT order_ids.order_id,
         po.status AS stored_status,
         CASE
           WHEN COALESCE(facts.active_item_count, 0) > 0
            AND COALESCE(facts.remaining_item_count, 0) = 0
             THEN 'fully_received'
           WHEN COALESCE(facts.positive_received_item_count, 0) > 0
             THEN 'partially_received'
           ELSE 'ordered'
         END AS derived_status
    FROM (SELECT DISTINCT order_id FROM order_items) order_ids
    LEFT JOIN purchase_orders po ON po.id = order_ids.order_id
    LEFT JOIN active_order_facts facts ON facts.order_id = order_ids.order_id
),
active_duplicate_groups AS (
  SELECT order_id, item_id
    FROM order_items
   WHERE is_deleted = 0
   GROUP BY order_id, item_id
  HAVING COUNT(*) > 1
),
ledger_facts AS (
  SELECT oi.id AS order_item_id,
         COALESCE(SUM(CASE
           WHEN st.item_id = oi.item_id AND st.movement_type = 'IN'
             THEN st.quantity
           ELSE 0
         END), 0) AS ledger_in_qty,
         MAX(CASE
           WHEN st.order_item_id IS NOT NULL AND st.item_id <> oi.item_id THEN 1
           ELSE 0
         END) AS has_mismatched_ledger_item
    FROM order_items oi
    LEFT JOIN stock_transactions st ON st.order_item_id = oi.id
   GROUP BY oi.id
),
detail_facts AS (
  SELECT 'order-item-integrity-v1' AS query_version,
         oi.order_id AS order_id,
         oi.id AS order_item_id,
         oi.item_id AS item_id,
         oi.ordered_qty AS ordered_qty,
         oi.received_qty AS received_qty,
         ledger.ledger_in_qty AS ledger_in_qty,
         oi.is_deleted AS order_item_is_deleted,
         po.is_deleted AS order_is_deleted,
         item.is_deleted AS item_is_deleted,
         status.stored_status AS stored_status,
         status.derived_status AS derived_status,
         CASE WHEN oi.received_qty > oi.ordered_qty THEN 1 ELSE 0 END
           AS is_over_received,
         CASE WHEN oi.ordered_qty <= 0 THEN 1 ELSE 0 END
           AS has_nonpositive_ordered,
         CASE WHEN oi.received_qty < 0 THEN 1 ELSE 0 END
           AS has_negative_received,
         CASE WHEN oi.is_deleted NOT IN (0, 1) THEN 1 ELSE 0 END
           AS has_invalid_order_item_deletion_flag,
         CASE
           WHEN oi.is_deleted = 0 AND duplicate.order_id IS NOT NULL THEN 1
           ELSE 0
         END AS is_active_duplicate,
         CASE
           WHEN oi.is_deleted = 0 AND ledger.has_mismatched_ledger_item = 1 THEN 1
           ELSE 0
         END AS has_mismatched_ledger_item,
         CASE
           WHEN oi.is_deleted = 0 AND oi.received_qty <> ledger.ledger_in_qty THEN 1
           ELSE 0
         END AS has_receipt_ledger_mismatch,
         CASE
           WHEN po.is_deleted = 0
            AND status.stored_status IN (
              'ordered', 'partially_received', 'fully_received'
            )
            AND status.stored_status <> status.derived_status
             THEN 1
           ELSE 0
         END AS has_status_mismatch,
         CASE WHEN po.id IS NULL THEN 1 ELSE 0 END
           AS has_missing_order_parent,
         CASE WHEN po.is_deleted = 1 THEN 1 ELSE 0 END
           AS has_deleted_order_parent,
         CASE WHEN po.is_deleted NOT IN (0, 1) THEN 1 ELSE 0 END
           AS has_invalid_order_parent_deletion_flag,
         CASE WHEN item.id IS NULL THEN 1 ELSE 0 END
           AS has_missing_item_parent,
         CASE WHEN item.is_deleted = 1 THEN 1 ELSE 0 END
           AS has_deleted_item_parent,
         CASE WHEN item.is_deleted NOT IN (0, 1) THEN 1 ELSE 0 END
           AS has_invalid_item_parent_deletion_flag,
         CASE
           WHEN oi.is_deleted = 0
            AND po.is_deleted = 0
            AND oi.received_qty < oi.ordered_qty
            AND order_facts.total_received_qty >= order_facts.total_ordered_qty
             THEN 1
           ELSE 0
         END AS is_masked_remaining_item
    FROM order_items oi
    LEFT JOIN purchase_orders po ON po.id = oi.order_id
    LEFT JOIN items item ON item.id = oi.item_id
    JOIN order_status_facts status ON status.order_id = oi.order_id
    LEFT JOIN active_order_facts order_facts ON order_facts.order_id = oi.order_id
    LEFT JOIN active_duplicate_groups duplicate
      ON duplicate.order_id = oi.order_id AND duplicate.item_id = oi.item_id
    JOIN ledger_facts ledger ON ledger.order_item_id = oi.id
)
SELECT query_version,
       order_id,
       order_item_id,
       item_id,
       ordered_qty,
       received_qty,
       ledger_in_qty,
       order_item_is_deleted,
       order_is_deleted,
       item_is_deleted,
       stored_status,
       derived_status,
       is_over_received,
       has_nonpositive_ordered,
       has_negative_received,
       has_invalid_order_item_deletion_flag,
       is_active_duplicate,
       has_mismatched_ledger_item,
       has_receipt_ledger_mismatch,
       has_status_mismatch,
       has_missing_order_parent,
       has_deleted_order_parent,
       has_invalid_order_parent_deletion_flag,
       has_missing_item_parent,
       has_deleted_item_parent,
       has_invalid_item_parent_deletion_flag,
       is_masked_remaining_item
  FROM detail_facts
 WHERE is_over_received = 1
    OR has_nonpositive_ordered = 1
    OR has_negative_received = 1
    OR is_active_duplicate = 1
    OR has_missing_order_parent = 1
    OR has_deleted_order_parent = 1
    OR has_missing_item_parent = 1
    OR has_deleted_item_parent = 1
    OR is_masked_remaining_item = 1
    OR has_invalid_order_item_deletion_flag = 1
    OR has_mismatched_ledger_item = 1
    OR has_receipt_ledger_mismatch = 1
    OR has_status_mismatch = 1
    OR has_invalid_order_parent_deletion_flag = 1
    OR has_invalid_item_parent_deletion_flag = 1
 ORDER BY order_item_id ASC;
