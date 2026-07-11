-- Cloudflare D1 schema for Cafe Inventory MVP
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '관리자',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin', 'staff'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_expires ON sessions(token, expires_at);

CREATE TABLE IF NOT EXISTS item_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT NOT NULL DEFAULT '개',
  safety_stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  current_stock INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  creation_token TEXT,
  FOREIGN KEY (category_id) REFERENCES item_categories(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_items_name_spec_not_deleted
  ON items(name, COALESCE(spec, ''), is_deleted)
  WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('IN', 'OUT', 'ADJUST')),
  quantity INTEGER NOT NULL,
  reason TEXT,
  order_item_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  operation_token TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','ordered','partially_received','fully_received','canceled')) DEFAULT 'draft',
  order_date TEXT NOT NULL DEFAULT (date('now')),
  external_order_ref TEXT,
  note TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  creation_token TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  ordered_qty INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_items_deleted_name ON items(name, is_deleted);
CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_transactions(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_order_item ON stock_transactions(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status ON purchase_orders(status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_creation_token
  ON items(creation_token) WHERE creation_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_creation_token
  ON purchase_orders(creation_token) WHERE creation_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_transactions_operation_token
  ON stock_transactions(operation_token) WHERE operation_token IS NOT NULL;
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
