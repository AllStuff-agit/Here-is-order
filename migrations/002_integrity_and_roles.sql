-- Authorization and write-integrity hardening for existing databases.
PRAGMA foreign_keys = ON;

ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'
  CHECK (role IN ('admin', 'staff'));

-- Preserve access after upgrading a legacy database. New users remain explicit staff/admin.
UPDATE users
   SET role = 'admin'
 WHERE id = (
   SELECT id
     FROM users
    WHERE is_active = 1 AND is_deleted = 0
    ORDER BY id ASC
    LIMIT 1
 );

ALTER TABLE items ADD COLUMN creation_token TEXT;
ALTER TABLE purchase_orders ADD COLUMN creation_token TEXT;
ALTER TABLE stock_transactions ADD COLUMN operation_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_items_creation_token
  ON items(creation_token) WHERE creation_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_creation_token
  ON purchase_orders(creation_token) WHERE creation_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_transactions_operation_token
  ON stock_transactions(operation_token) WHERE operation_token IS NOT NULL;

-- Collapse any legacy duplicate active rows before enforcing one item per order.
UPDATE order_items AS target
   SET ordered_qty = (
         SELECT SUM(source.ordered_qty)
           FROM order_items AS source
          WHERE source.order_id = target.order_id
            AND source.item_id = target.item_id
            AND source.is_deleted = 0
       ),
       received_qty = (
         SELECT SUM(source.received_qty)
           FROM order_items AS source
          WHERE source.order_id = target.order_id
            AND source.item_id = target.item_id
            AND source.is_deleted = 0
       ),
       updated_at = datetime('now')
 WHERE target.is_deleted = 0
   AND target.id = (
     SELECT MIN(source.id)
       FROM order_items AS source
      WHERE source.order_id = target.order_id
        AND source.item_id = target.item_id
        AND source.is_deleted = 0
   );

UPDATE order_items AS target
   SET is_deleted = 1,
       deleted_at = datetime('now'),
       updated_at = datetime('now')
 WHERE target.is_deleted = 0
   AND target.id <> (
     SELECT MIN(source.id)
       FROM order_items AS source
      WHERE source.order_id = target.order_id
        AND source.item_id = target.item_id
        AND source.is_deleted = 0
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_active_order_item
  ON order_items(order_id, item_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_order_items_item
  ON order_items(item_id);

CREATE TRIGGER IF NOT EXISTS trg_categories_validate_insert
BEFORE INSERT ON item_categories
WHEN length(trim(NEW.name)) = 0 OR NEW.is_deleted NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_CATEGORY');
END;

CREATE TRIGGER IF NOT EXISTS trg_categories_validate_update
BEFORE UPDATE OF name, is_deleted ON item_categories
WHEN length(trim(NEW.name)) = 0 OR NEW.is_deleted NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_CATEGORY');
END;

CREATE TRIGGER IF NOT EXISTS trg_items_validate_insert
BEFORE INSERT ON items
WHEN length(trim(NEW.name)) = 0
  OR length(trim(NEW.unit)) = 0
  OR NEW.safety_stock < 0 OR NEW.min_stock < 0
  OR NEW.current_stock < 0 OR NEW.unit_price < 0
  OR NEW.is_deleted NOT IN (0, 1)
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM item_categories c
     WHERE c.id = NEW.category_id AND c.is_deleted = 0
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ITEM');
END;

CREATE TRIGGER IF NOT EXISTS trg_items_validate_update
BEFORE UPDATE OF category_id, name, unit, safety_stock, min_stock, current_stock, unit_price, is_deleted ON items
WHEN length(trim(NEW.name)) = 0
  OR length(trim(NEW.unit)) = 0
  OR NEW.safety_stock < 0 OR NEW.min_stock < 0
  OR NEW.current_stock < 0 OR NEW.unit_price < 0
  OR NEW.is_deleted NOT IN (0, 1)
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM item_categories c
     WHERE c.id = NEW.category_id AND c.is_deleted = 0
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ITEM');
END;

CREATE TRIGGER IF NOT EXISTS trg_order_items_validate_insert
BEFORE INSERT ON order_items
WHEN NEW.ordered_qty <= 0 OR NEW.received_qty < 0 OR NEW.received_qty > NEW.ordered_qty
  OR NEW.is_deleted NOT IN (0, 1)
  OR NOT EXISTS (SELECT 1 FROM items i WHERE i.id = NEW.item_id AND i.is_deleted = 0)
  OR NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = NEW.order_id AND po.is_deleted = 0)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORDER_ITEM');
END;

CREATE TRIGGER IF NOT EXISTS trg_order_items_validate_update
BEFORE UPDATE OF order_id, item_id, ordered_qty, received_qty, is_deleted ON order_items
WHEN NEW.ordered_qty <= 0 OR NEW.received_qty < 0 OR NEW.received_qty > NEW.ordered_qty
  OR NEW.is_deleted NOT IN (0, 1)
  OR (NEW.is_deleted = 0 AND (
    NOT EXISTS (SELECT 1 FROM items i WHERE i.id = NEW.item_id AND i.is_deleted = 0)
    OR NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = NEW.order_id AND po.is_deleted = 0)
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORDER_ITEM');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_transactions_validate_insert
BEFORE INSERT ON stock_transactions
WHEN (NEW.movement_type = 'IN' AND NEW.quantity <= 0)
  OR (NEW.movement_type = 'OUT' AND NEW.quantity >= 0)
  OR (NEW.order_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_items oi
     WHERE oi.id = NEW.order_item_id
       AND oi.item_id = NEW.item_id
       AND oi.is_deleted = 0
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_STOCK_TRANSACTION');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_orders_status_transition
BEFORE UPDATE OF status ON purchase_orders
WHEN NEW.status <> OLD.status
 AND NOT (
   (OLD.status = 'draft' AND NEW.status IN ('ordered', 'canceled'))
   OR (OLD.status = 'ordered' AND NEW.status IN ('partially_received', 'fully_received', 'canceled'))
   OR (OLD.status = 'partially_received' AND NEW.status = 'fully_received')
 )
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORDER_STATUS_TRANSITION');
END;
