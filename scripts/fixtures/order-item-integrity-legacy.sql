-- Deliberately corrupt rows that can exist before 002_integrity_and_roles.sql.
-- IDs are stable so the audit tests can distinguish each integrity dimension.
INSERT INTO items (id, name, is_deleted)
VALUES
  (1, 'legacy-mask-overreceived', 0),
  (2, 'legacy-mask-remaining', 0),
  (3, 'legacy-deleted-overreceived', 0),
  (4, 'legacy-nonpositive-ordered', 0),
  (5, 'legacy-negative-received', 0),
  (6, 'legacy-duplicate', 0),
  (7, 'legacy-deleted-parent', 1),
  (8, 'legacy-invalid-parent-flag', 2),
  (9, 'legacy-ledger-owner', 0),
  (10, 'legacy-ledger-wrong-item', 0),
  (11, 'legacy-receipt-ledger-mismatch', 0),
  (12, 'legacy-status-mismatch', 0),
  (13, 'legacy-valid-control', 0);

INSERT INTO purchase_orders (id, title, status, is_deleted)
VALUES
  (101, 'legacy masked order', 'fully_received', 0),
  (102, 'legacy zero quantity order', 'fully_received', 0),
  (103, 'legacy negative receipt order', 'ordered', 0),
  (104, 'legacy duplicate order', 'ordered', 0),
  (105, 'legacy deleted parent order', 'ordered', 1),
  (106, 'legacy invalid parent flag order', 'ordered', 2),
  (107, 'legacy mismatched ledger item order', 'partially_received', 0),
  (108, 'legacy receipt ledger mismatch order', 'partially_received', 0),
  (109, 'legacy status mismatch order', 'fully_received', 0),
  (110, 'legacy deleted item parent order', 'ordered', 0),
  (111, 'legacy invalid item parent order', 'ordered', 0),
  (113, 'legacy invalid order item flag order', 'ordered', 0),
  (114, 'legacy valid control order', 'fully_received', 0);

INSERT INTO order_items
  (id, order_id, item_id, ordered_qty, received_qty, is_deleted)
VALUES
  (1001, 101, 1, 1, 3, 0),
  (1002, 101, 2, 3, 1, 0),
  (1003, 101, 3, 1, 2, 1),
  (1004, 102, 4, 0, 0, 0),
  (1005, 103, 5, 2, -1, 0),
  (1006, 104, 6, 2, 0, 0),
  (1007, 104, 6, 3, 0, 0),
  (1008, 105, 13, 1, 0, 0),
  (1009, 106, 13, 1, 0, 0),
  (1010, 110, 7, 1, 0, 0),
  (1011, 111, 8, 1, 0, 0),
  (1012, 113, 13, 1, 2, 2),
  (1013, 107, 9, 2, 1, 0),
  (1014, 108, 11, 3, 2, 0),
  (1015, 109, 12, 2, 1, 0),
  (1016, 114, 13, 1, 1, 0);

INSERT INTO stock_transactions
  (id, item_id, movement_type, quantity, reason, order_item_id)
VALUES
  (2001, 1, 'IN', 3, 'legacy matching receipt', 1001),
  (2002, 2, 'IN', 1, 'legacy matching receipt', 1002),
  (2003, 3, 'IN', 2, 'legacy deleted receipt', 1003),
  (2004, 5, 'IN', -1, 'legacy negative receipt', 1005),
  (2005, 13, 'IN', 2, 'legacy invalid order item flag', 1012),
  (2006, 9, 'IN', 1, 'legacy matching receipt', 1013),
  (2007, 10, 'IN', 7, 'legacy mismatched item', 1013),
  (2008, 11, 'IN', 1, 'legacy receipt ledger mismatch', 1014),
  (2009, 12, 'IN', 1, 'legacy matching receipt', 1015),
  (2010, 13, 'IN', 1, 'legacy matching receipt', 1016);
