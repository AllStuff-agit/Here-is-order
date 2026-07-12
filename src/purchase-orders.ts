export type PurchaseOrderFailure =
  | {
      kind: 'invalid';
      code: 'INVALID_INPUT' | 'INVALID_STATUS' | 'INVALID_STATUS_TRANSITION';
      message: string;
    }
  | {
      kind: 'not_found';
      code: 'NOT_FOUND';
      message: string;
    }
  | {
      kind: 'conflict';
      code: 'CONFLICT' | 'ORDER_DELETE_CONFLICT' | 'RECEIVE_CONFLICT';
      message: string;
    };

export type PurchaseOrderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PurchaseOrderFailure };

export type PurchaseOrderStatus =
  | 'draft'
  | 'ordered'
  | 'partially_received'
  | 'fully_received'
  | 'canceled';

export type PurchaseOrderRow = {
  id: number;
  title: string;
  status: PurchaseOrderStatus;
  order_date: string;
  external_order_ref: string | null;
  note: string | null;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItemInput = {
  itemId: number;
  orderedQty: number;
  memo: string | null;
};

export type OrderItemRow = {
  id: number;
  order_id: number;
  item_id: number;
  ordered_qty: number;
  received_qty: number;
  memo: string | null;
};

export type PurchaseOrderDetail = PurchaseOrderRow & {
  ordered_qty: number;
  received_qty: number;
  items: Array<{
    id: number;
    item_id: number;
    item_name: string | null;
    spec: string | null;
    ordered_qty: number;
    received_qty: number;
    remaining_qty: number;
    memo: string | null;
  }>;
};

export type CreateDraftInput = {
  title: string;
  note: string | null;
  requestedStatus?: string;
};

export type CreateDraftWithItemsInput = {
  title: string;
  note: string | null;
  items: readonly OrderItemInput[];
};

export type PurchaseOrderRevision = {
  title?: string;
  note?: string | null;
  externalOrderRef?: string | null;
  requestedStatus?: string;
};

export type OrderItemRevision = {
  orderedQty?: number;
  memo?: string | null;
};

export type PartialReceiptInput = {
  quantity: number;
  note?: string | null;
};

export type PartialReceiptResult = {
  order: PurchaseOrderRow | null;
  order_item: Pick<
    OrderItemRow,
    'id' | 'item_id' | 'ordered_qty' | 'received_qty' | 'memo'
  > | null;
};

export type AddItemsToDraftResult = {
  items: OrderItemRow[];
};

// These stages preserve the legacy order-before-body preflight for HTTP callers.
// Their executors rely on the conditional token write instead of re-reading status.
export type AddItemsToDraftStage = {
  execute(
    items: readonly OrderItemInput[],
  ): Promise<PurchaseOrderResult<AddItemsToDraftResult>>;
};

export type EditDraftItemStage = {
  execute(
    orderItemId: number,
    change: OrderItemRevision,
  ): Promise<PurchaseOrderResult<OrderItemRow | null>>;
};

export type PartialReceiptStage = {
  execute(
    note: string | null,
  ): Promise<PurchaseOrderResult<PartialReceiptResult>>;
};

export interface PurchaseOrderModule {
  createDraft(
    input: CreateDraftInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>>;
  createDraftWithItems(
    input: CreateDraftWithItemsInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>>;
  getDetail(orderId: number): Promise<PurchaseOrderResult<PurchaseOrderDetail>>;
  revise(
    orderId: number,
    change: PurchaseOrderRevision,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>>;
  deleteDraft(
    orderId: number,
  ): Promise<PurchaseOrderResult<{ deleted: true }>>;
  stageAddItemsToDraft(
    orderId: number,
  ): Promise<PurchaseOrderResult<AddItemsToDraftStage>>;
  addItemsToDraft(
    orderId: number,
    items: readonly OrderItemInput[],
  ): Promise<PurchaseOrderResult<AddItemsToDraftResult>>;
  stageEditDraftItem(
    orderId: number,
  ): Promise<PurchaseOrderResult<EditDraftItemStage>>;
  editDraftItem(
    orderId: number,
    orderItemId: number,
    change: OrderItemRevision,
  ): Promise<PurchaseOrderResult<OrderItemRow | null>>;
  stageReceive(
    orderId: number,
    orderItemId: number,
    quantity: number,
  ): Promise<PurchaseOrderResult<PartialReceiptStage>>;
  receive(
    orderId: number,
    orderItemId: number,
    receipt: PartialReceiptInput,
  ): Promise<PurchaseOrderResult<PartialReceiptResult>>;
}

export function purchaseOrders(
  db: D1Database,
  actorUserId: number,
): PurchaseOrderModule {
  return {
    createDraft,
    createDraftWithItems,
    getDetail,
    revise,
    deleteDraft,
    stageAddItemsToDraft,
    addItemsToDraft,
    stageEditDraftItem,
    editDraftItem,
    stageReceive,
    receive,
  };

  async function createDraft(
    input: CreateDraftInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>> {
    const title = input.title.trim();
    const status = input.requestedStatus == null || input.requestedStatus.trim() === ''
      ? 'draft'
      : input.requestedStatus.trim();
    if (status !== 'draft') {
      return invalid(
        'INVALID_STATUS_TRANSITION',
        '발주서는 초안 상태로만 생성할 수 있습니다.',
      );
    }
    if (!title) return invalid('INVALID_INPUT', '발주명은 필수입니다.');

    const creationToken = crypto.randomUUID();
    const batchResult = await db.batch([
      db.prepare(
        `INSERT INTO purchase_orders (title, status, note, creation_token)
         VALUES (?, 'draft', ?, ?)`,
      ).bind(title, input.note, creationToken),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'create', 'purchase_order', id, NULL, ?
           FROM purchase_orders WHERE creation_token = ?`,
      ).bind(
        actorUserId,
        JSON.stringify({ title, status: 'draft', note: input.note }),
        creationToken,
      ),
      db.prepare(
        `UPDATE purchase_orders SET creation_token = NULL WHERE creation_token = ?`,
      ).bind(creationToken),
    ]);
    const id = Number(batchResult[0].meta.last_row_id);
    const row = await selectPurchaseOrder(db, id);
    return success(row);
  }

  async function createDraftWithItems(
    input: CreateDraftWithItemsInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>> {
    const title = input.title.trim();
    if (!title) return invalid('INVALID_INPUT', '발주명은 필수입니다.');

    if (!Array.isArray(input.items) || input.items.length === 0) {
      return invalid('INVALID_INPUT', '품목 목록은 비어있을 수 없습니다.');
    }

    for (let index = 0; index < input.items.length; index += 1) {
      const row = input.items[index];
      if (
        !Number.isInteger(row.itemId)
        || row.itemId <= 0
        || !Number.isInteger(row.orderedQty)
        || row.orderedQty <= 0
      ) {
        return invalid(
          'INVALID_INPUT',
          `items[${index}]의 품목과 수량을 확인해주세요.`,
        );
      }
    }

    const mergedItems = new Map<number, OrderItemInput>();
    for (const row of input.items) {
      const current = mergedItems.get(row.itemId);
      mergedItems.set(row.itemId, {
        itemId: row.itemId,
        orderedQty: (current?.orderedQty ?? 0) + row.orderedQty,
        memo: row.memo ?? current?.memo ?? null,
      });
    }
    const items = Array.from(mergedItems.values());

    for (const row of items) {
      const item = await db.prepare(
        'SELECT id FROM items WHERE id = ? AND is_deleted = 0',
      ).bind(row.itemId).first();
      if (!item) {
        return invalid('INVALID_INPUT', `존재하지 않는 품목입니다. (id=${row.itemId})`);
      }
    }

    const creationToken = crypto.randomUUID();
    const statements = [
      db.prepare(
        `INSERT INTO purchase_orders (title, status, note, creation_token)
         VALUES (?, 'draft', ?, ?)`,
      ).bind(title, input.note, creationToken),
    ];

    for (const row of items) {
      statements.push(
        db.prepare(
          `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty, memo)
           SELECT id, ?, ?, 0, ? FROM purchase_orders WHERE creation_token = ?`,
        ).bind(row.itemId, row.orderedQty, row.memo, creationToken),
      );
      statements.push(
        db.prepare(
          `INSERT INTO audit_logs
             (actor_user_id, action, entity_type, entity_id, before_json, after_json)
           SELECT ?, 'create', 'order_item', oi.id, NULL, ?
             FROM order_items oi
             JOIN purchase_orders po ON po.id = oi.order_id
            WHERE po.creation_token = ? AND oi.item_id = ? AND oi.is_deleted = 0`,
        ).bind(
          actorUserId,
          JSON.stringify({
            item_id: row.itemId,
            ordered_qty: row.orderedQty,
            received_qty: 0,
            memo: row.memo,
          }),
          creationToken,
          row.itemId,
        ),
      );
    }

    statements.push(
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'create', 'purchase_order', id, NULL, ?
           FROM purchase_orders WHERE creation_token = ?`,
      ).bind(
        actorUserId,
        JSON.stringify({ title, status: 'draft', note: input.note, items }),
        creationToken,
      ),
    );
    statements.push(
      db.prepare(
        `UPDATE purchase_orders SET creation_token = NULL WHERE creation_token = ?`,
      ).bind(creationToken),
    );

    let batchResult: D1Result[];
    try {
      batchResult = await db.batch(statements);
    } catch {
      return conflict(
        'CONFLICT',
        '발주서 생성 중 품목 상태가 변경되었습니다. 다시 시도해주세요.',
      );
    }

    const orderId = Number(batchResult[0].meta.last_row_id);
    const row = await selectActivePurchaseOrder(db, orderId);
    return success(row);
  }

  async function getDetail(
    orderId: number,
  ): Promise<PurchaseOrderResult<PurchaseOrderDetail>> {
    const order = await selectActivePurchaseOrder(db, orderId);
    if (!order) return notFound('발주서를 찾지 못했습니다.');

    const { results: items } = await db.prepare(
      `SELECT oi.id, oi.item_id, i.name AS item_name, i.spec,
              oi.ordered_qty, oi.received_qty,
              (oi.ordered_qty - oi.received_qty) AS remaining_qty, oi.memo
         FROM order_items oi
         LEFT JOIN items i ON i.id = oi.item_id
        WHERE oi.order_id = ? AND oi.is_deleted = 0
        ORDER BY oi.id DESC`,
    ).bind(orderId).all<PurchaseOrderDetail['items'][number]>();

    const orderedQty = items.reduce((sum, item) => sum + Number(item.ordered_qty), 0);
    const receivedQty = items.reduce((sum, item) => sum + Number(item.received_qty), 0);

    return success({
      ...(order as PurchaseOrderRow),
      ordered_qty: orderedQty,
      received_qty: receivedQty,
      items,
    });
  }

  async function stageAddItemsToDraft(
    orderId: number,
  ): Promise<PurchaseOrderResult<AddItemsToDraftStage>> {
    const order = await db.prepare(
      'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0',
    ).bind(orderId).first<{ id: number; status: string }>();
    if (!order) return notFound('발주서를 찾지 못했습니다.');
    if (order.status !== 'draft') {
      return invalid(
        'INVALID_STATUS',
        '초안 상태에서만 발주 항목을 추가할 수 있습니다.',
      );
    }

    return success({
      execute(items) {
        return addItemsToStagedDraft(orderId, items);
      },
    });
  }

  async function addItemsToDraft(
    orderId: number,
    items: readonly OrderItemInput[],
  ): Promise<PurchaseOrderResult<AddItemsToDraftResult>> {
    const stage = await stageAddItemsToDraft(orderId);
    if (!stage.ok) return stage;
    return stage.value.execute(items);
  }

  async function addItemsToStagedDraft(
    orderId: number,
    items: readonly OrderItemInput[],
  ): Promise<PurchaseOrderResult<AddItemsToDraftResult>> {
    if (!Array.isArray(items) || items.length === 0) {
      return invalid('INVALID_INPUT', '항목과 수량을 확인해주세요.');
    }

    const rows: OrderItemInput[] = [];
    for (const row of items) {
      const itemId = row.itemId;
      const orderedQty = row.orderedQty;
      const memo = row.memo == null ? null : String(row.memo);
      if (
        !Number.isInteger(itemId)
        || !Number.isInteger(orderedQty)
        || orderedQty <= 0
      ) {
        return invalid('INVALID_INPUT', '항목과 수량을 확인해주세요.');
      }
      rows.push({ itemId, orderedQty, memo });
    }

    const mergedRows = rows.reduce<Map<
      number,
      { orderedQty: number; memo: string | null }
    >>((acc, row) => {
      const current = acc.get(row.itemId);
      acc.set(row.itemId, {
        orderedQty: (current?.orderedQty ?? 0) + row.orderedQty,
        memo: row.memo || current?.memo || null,
      });
      return acc;
    }, new Map());

    const groupedRows = Array.from(mergedRows.entries()).map(([itemId, row]) => ({
      itemId,
      orderedQty: row.orderedQty,
      memo: row.memo,
    }));

    for (const row of groupedRows) {
      const item = await db.prepare(
        'SELECT id FROM items WHERE id = ? AND is_deleted = 0',
      ).bind(row.itemId).first();
      if (!item) {
        return invalid(
          'INVALID_INPUT',
          `존재하지 않는 품목입니다. (id=${row.itemId})`,
        );
      }
    }

    const existingRows = new Map<number, {
      id: number;
      ordered_qty: number;
      received_qty: number;
      memo: string | null;
    }>();
    for (const row of groupedRows) {
      const existing = await db.prepare(
        `SELECT id, ordered_qty, received_qty, memo
           FROM order_items
          WHERE order_id = ? AND item_id = ? AND is_deleted = 0`,
      ).bind(orderId, row.itemId).first<{
        id: number;
        ordered_qty: number;
        received_qty: number;
        memo: string | null;
      }>();
      if (existing) existingRows.set(row.itemId, existing);
    }

    const mutationToken = crypto.randomUUID();
    const statements = [
      db.prepare(
        `UPDATE purchase_orders SET creation_token = ?
          WHERE id = ? AND is_deleted = 0 AND status = 'draft'`,
      ).bind(mutationToken, orderId),
    ];

    for (const row of groupedRows) {
      const existing = existingRows.get(row.itemId);
      if (existing) {
        statements.push(
          db.prepare(
            `UPDATE order_items
                SET ordered_qty = ordered_qty + ?, memo = ?, updated_at = datetime('now')
              WHERE id = ? AND order_id = ?
                AND EXISTS (
                  SELECT 1 FROM purchase_orders WHERE creation_token = ?
                )`,
          ).bind(row.orderedQty, row.memo, existing.id, orderId, mutationToken),
        );
        statements.push(
          db.prepare(
            `INSERT INTO audit_logs
               (actor_user_id, action, entity_type, entity_id, before_json, after_json)
             SELECT ?, 'update', 'order_item', oi.id,
                    json_object(
                      'order_id', oi.order_id, 'item_id', oi.item_id,
                      'ordered_qty', oi.ordered_qty - ?, 'received_qty', oi.received_qty
                    ),
                    json_object(
                      'order_id', oi.order_id, 'item_id', oi.item_id,
                      'ordered_qty', oi.ordered_qty, 'received_qty', oi.received_qty,
                      'memo', oi.memo
                    )
               FROM order_items oi
               JOIN purchase_orders po ON po.id = oi.order_id
              WHERE po.creation_token = ? AND oi.id = ?`,
          ).bind(actorUserId, row.orderedQty, mutationToken, existing.id),
        );
      } else {
        statements.push(
          db.prepare(
            `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty, memo)
             SELECT id, ?, ?, 0, ? FROM purchase_orders WHERE creation_token = ?`,
          ).bind(row.itemId, row.orderedQty, row.memo, mutationToken),
        );
        statements.push(
          db.prepare(
            `INSERT INTO audit_logs
               (actor_user_id, action, entity_type, entity_id, before_json, after_json)
             SELECT ?, 'create', 'order_item', oi.id, NULL, ?
               FROM order_items oi
               JOIN purchase_orders po ON po.id = oi.order_id
              WHERE po.creation_token = ? AND oi.item_id = ? AND oi.is_deleted = 0`,
          ).bind(
            actorUserId,
            JSON.stringify({
              order_id: orderId,
              item_id: row.itemId,
              ordered_qty: row.orderedQty,
              received_qty: 0,
              memo: row.memo,
            }),
            mutationToken,
            row.itemId,
          ),
        );
      }
    }
    statements.push(
      db.prepare(
        `UPDATE purchase_orders
            SET creation_token = NULL, updated_at = datetime('now')
          WHERE creation_token = ?`,
      ).bind(mutationToken),
    );

    let batchResult: D1Result[];
    try {
      batchResult = await db.batch(statements);
    } catch {
      return conflict(
        'CONFLICT',
        '발주 상태 또는 항목이 변경되었습니다. 다시 시도해주세요.',
      );
    }
    if (batchResult[0].meta.changes === 0) {
      return conflict(
        'CONFLICT',
        '초안 상태에서만 발주 항목을 추가할 수 있습니다.',
      );
    }

    const targets = await db.prepare(
      `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
         FROM order_items oi
        WHERE oi.order_id = ? AND oi.is_deleted = 0`,
    ).bind(orderId).all<OrderItemRow>();

    return success({ items: targets.results });
  }

  async function stageEditDraftItem(
    orderId: number,
  ): Promise<PurchaseOrderResult<EditDraftItemStage>> {
    const order = await db.prepare(
      'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0',
    ).bind(orderId).first<{ id: number; status: string }>();
    if (!order) return notFound('발주서를 찾지 못했습니다.');
    if (order.status !== 'draft') {
      return invalid(
        'INVALID_STATUS',
        '초안 상태에서만 발주 항목을 수정할 수 있습니다.',
      );
    }

    return success({
      execute(orderItemId, change) {
        return editStagedDraftItem(orderId, orderItemId, change);
      },
    });
  }

  async function editDraftItem(
    orderId: number,
    orderItemId: number,
    change: OrderItemRevision,
  ): Promise<PurchaseOrderResult<OrderItemRow | null>> {
    const stage = await stageEditDraftItem(orderId);
    if (!stage.ok) return stage;
    return stage.value.execute(orderItemId, change);
  }

  async function editStagedDraftItem(
    orderId: number,
    orderItemId: number,
    change: OrderItemRevision,
  ): Promise<PurchaseOrderResult<OrderItemRow | null>> {
    const patches: string[] = [];
    const params: unknown[] = [];
    let orderedQty: number | undefined;

    if ('orderedQty' in change) {
      orderedQty = change.orderedQty;
      if (!Number.isInteger(orderedQty) || (orderedQty ?? 0) <= 0) {
        return invalid(
          'INVALID_INPUT',
          'ordered_qty는 1 이상의 정수여야 합니다.',
        );
      }
      patches.push('ordered_qty = ?');
      params.push(orderedQty);
    }

    if ('memo' in change) {
      patches.push('memo = ?');
      params.push(change.memo == null ? null : String(change.memo));
    }

    if (!patches.length) {
      return invalid('INVALID_INPUT', '수정할 데이터가 없습니다.');
    }

    const before = await db.prepare(
      `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
         FROM order_items oi
        WHERE oi.id = ? AND oi.order_id = ? AND oi.is_deleted = 0`,
    ).bind(orderItemId, orderId).first<OrderItemRow>();
    if (!before) return notFound('발주 항목을 찾지 못했습니다.');

    if (orderedQty !== undefined) {
      const currentReceived = Number(before.received_qty || 0);
      if (currentReceived > orderedQty) {
        return invalid(
          'INVALID_INPUT',
          '수정하려는 수량이 이미 입고된 수량보다 작을 수 없습니다.',
        );
      }
    }

    const mutationToken = crypto.randomUUID();
    const sql = `UPDATE order_items SET ${patches.join(', ')}, updated_at = datetime('now')
      WHERE id = ? AND order_id = ? AND is_deleted = 0
        AND EXISTS (SELECT 1 FROM purchase_orders WHERE creation_token = ?)`;
    const batchResult = await db.batch([
      db.prepare(
        `UPDATE purchase_orders SET creation_token = ?
          WHERE id = ? AND is_deleted = 0 AND status = 'draft'`,
      ).bind(mutationToken, orderId),
      db.prepare(sql).bind(...params, orderItemId, orderId, mutationToken),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'update', 'order_item', oi.id, ?,
                json_object(
                  'id', oi.id, 'order_id', oi.order_id, 'item_id', oi.item_id,
                  'ordered_qty', oi.ordered_qty, 'received_qty', oi.received_qty,
                  'memo', oi.memo
                )
           FROM order_items oi
           JOIN purchase_orders po ON po.id = oi.order_id
          WHERE oi.id = ? AND po.creation_token = ? AND changes() = 1`,
      ).bind(
        actorUserId,
        JSON.stringify(before),
        orderItemId,
        mutationToken,
      ),
      db.prepare(
        `UPDATE purchase_orders
            SET creation_token = NULL, updated_at = datetime('now')
          WHERE creation_token = ?`,
      ).bind(mutationToken),
    ]);

    if (
      batchResult[0].meta.changes === 0
      || batchResult[1].meta.changes === 0
    ) {
      return conflict(
        'CONFLICT',
        '발주 상태 또는 항목이 변경되었습니다.',
      );
    }

    const after = await db.prepare(
      `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
         FROM order_items oi
        WHERE oi.id = ?`,
    ).bind(orderItemId).first<OrderItemRow>();

    return success(after);
  }

  async function stageReceive(
    orderId: number,
    orderItemId: number,
    quantity: number,
  ): Promise<PurchaseOrderResult<PartialReceiptStage>> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return invalid('INVALID_INPUT', 'qty는 1 이상의 정수여야 합니다.');
    }

    const order = await db.prepare(
      'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0',
    ).bind(orderId).first<{ id: number; status: string }>();
    if (!order) return notFound('발주서를 찾지 못했습니다.');

    if (order.status === 'draft') {
      return invalid('INVALID_STATUS', '초안 상태에서는 입고 처리할 수 없습니다.');
    }
    if (order.status === 'canceled') {
      return invalid('INVALID_STATUS', '취소된 발주서는 입고 처리할 수 없습니다.');
    }
    if (order.status === 'fully_received') {
      return invalid('INVALID_STATUS', '이미 입고 완료된 발주서입니다.');
    }

    const target = await db.prepare(
      `SELECT oi.id, oi.item_id, oi.ordered_qty, oi.received_qty
         FROM order_items oi
        WHERE oi.id = ? AND oi.order_id = ? AND oi.is_deleted = 0`,
    ).bind(orderItemId, orderId).first<{
      id: number;
      item_id: number;
      ordered_qty: number;
      received_qty: number;
    }>();
    if (!target) return notFound('발주 항목을 찾지 못했습니다.');

    const remain = target.ordered_qty - target.received_qty;
    if (remain <= 0) {
      return conflict('RECEIVE_CONFLICT', '이미 입고 완료된 항목입니다.');
    }
    if (quantity > remain) {
      return conflict(
        'RECEIVE_CONFLICT',
        `현재 최대 ${remain}개까지 입고 가능합니다.`,
      );
    }

    return success({
      execute(note) {
        return receiveStagedOrderItem(
          orderId,
          orderItemId,
          target.item_id,
          quantity,
          note,
        );
      },
    });
  }

  async function receive(
    orderId: number,
    orderItemId: number,
    receipt: PartialReceiptInput,
  ): Promise<PurchaseOrderResult<PartialReceiptResult>> {
    const stage = await stageReceive(orderId, orderItemId, receipt.quantity);
    if (!stage.ok) return stage;
    const note = receipt.note == null ? null : String(receipt.note);
    return stage.value.execute(note);
  }

  async function receiveStagedOrderItem(
    orderId: number,
    orderItemId: number,
    itemId: number,
    quantity: number,
    note: string | null,
  ): Promise<PurchaseOrderResult<PartialReceiptResult>> {
    const operationToken = crypto.randomUUID();
    const reason = note == null ? '부분입고 처리' : note;
    const statements = [
      db.prepare(
        `INSERT INTO stock_transactions
           (item_id, movement_type, quantity, order_item_id, reason, created_by, operation_token)
         SELECT oi.item_id, 'IN', ?, oi.id, ?, ?, ?
           FROM order_items oi
           JOIN purchase_orders po ON po.id = oi.order_id
           JOIN items i ON i.id = oi.item_id
          WHERE oi.id = ? AND oi.order_id = ? AND oi.is_deleted = 0
            AND po.is_deleted = 0 AND po.status IN ('ordered', 'partially_received')
            AND i.is_deleted = 0
            AND oi.received_qty + ? <= oi.ordered_qty`,
      ).bind(
        quantity,
        reason,
        actorUserId,
        operationToken,
        orderItemId,
        orderId,
        quantity,
      ),
      db.prepare(
        `UPDATE order_items
            SET received_qty = received_qty + ?, updated_at = datetime('now')
          WHERE id = ? AND order_id = ?
            AND EXISTS (
              SELECT 1 FROM stock_transactions WHERE operation_token = ?
            )`,
      ).bind(quantity, orderItemId, orderId, operationToken),
      db.prepare(
        `UPDATE items
            SET current_stock = current_stock + ?, updated_at = datetime('now')
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM stock_transactions WHERE operation_token = ?
            )`,
      ).bind(quantity, itemId, operationToken),
      db.prepare(
        `UPDATE purchase_orders
            SET status = (
                  SELECT CASE
                    WHEN SUM(received_qty) >= SUM(ordered_qty) THEN 'fully_received'
                    WHEN SUM(received_qty) > 0 THEN 'partially_received'
                    ELSE 'ordered'
                  END
                    FROM order_items
                   WHERE order_id = ? AND is_deleted = 0
                ),
                updated_at = datetime('now')
          WHERE id = ? AND status IN ('ordered', 'partially_received')
            AND EXISTS (
              SELECT 1 FROM stock_transactions WHERE operation_token = ?
            )`,
      ).bind(orderId, orderId, operationToken),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'receive', 'order_item', oi.id,
                json_object(
                  'id', oi.id,
                  'item_id', oi.item_id,
                  'ordered_qty', oi.ordered_qty,
                  'received_qty', oi.received_qty - st.quantity
                ),
                json_object(
                  'id', oi.id,
                  'item_id', oi.item_id,
                  'ordered_qty', oi.ordered_qty,
                  'received_qty', oi.received_qty
                )
           FROM order_items oi
           JOIN stock_transactions st ON st.order_item_id = oi.id
          WHERE st.operation_token = ?`,
      ).bind(actorUserId, operationToken),
    ];

    let batchResult: D1Result[];
    try {
      batchResult = await db.batch(statements);
    } catch {
      return conflict(
        'RECEIVE_CONFLICT',
        '입고 처리 중 상태가 변경되었습니다. 다시 시도해주세요.',
      );
    }

    if (batchResult[0].meta.changes === 0) {
      return conflict(
        'RECEIVE_CONFLICT',
        '남은 입고 수량 또는 발주 상태가 변경되었습니다.',
      );
    }

    const updatedOrder = await selectPurchaseOrder(db, orderId);
    const updatedItem = await db.prepare(
      `SELECT oi.id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
         FROM order_items oi WHERE oi.id = ?`,
    ).bind(orderItemId).first<Pick<
      OrderItemRow,
      'id' | 'item_id' | 'ordered_qty' | 'received_qty' | 'memo'
    >>();

    return success({ order: updatedOrder, order_item: updatedItem });
  }

  async function revise(
    orderId: number,
    change: PurchaseOrderRevision,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>> {
    const patches: string[] = [];
    const params: unknown[] = [];
    let requestedStatus: PurchaseOrderStatus | null = null;

    if ('title' in change) {
      const title = String(change.title || '').trim();
      if (!title) return invalid('INVALID_INPUT', '발주명은 빈 값이 될 수 없습니다.');
      patches.push('title = ?');
      params.push(title);
    }

    if ('requestedStatus' in change) {
      const status = String(change.requestedStatus).trim();
      if (!isPurchaseOrderStatus(status)) {
        return invalid(
          'INVALID_STATUS',
          '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled',
        );
      }
      if (status === 'partially_received' || status === 'fully_received') {
        return invalid(
          'INVALID_STATUS_TRANSITION',
          '부분입고/입고완료 상태는 입고 처리에서 자동으로 변경됩니다.',
        );
      }

      patches.push('status = ?');
      params.push(status);
      requestedStatus = status;
    }

    if ('note' in change) {
      patches.push('note = ?');
      params.push(change.note == null ? null : String(change.note));
    }

    if ('externalOrderRef' in change) {
      patches.push('external_order_ref = ?');
      params.push(
        change.externalOrderRef == null ? null : String(change.externalOrderRef),
      );
    }

    if (!patches.length) {
      return invalid('INVALID_INPUT', '수정할 데이터가 없습니다.');
    }

    const before = await db.prepare(
      'SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0',
    ).bind(orderId).first<Record<string, unknown>>();
    if (!before) return notFound('발주서를 찾지 못했습니다.');

    const previousStatus = String(before.status || '') as PurchaseOrderStatus;
    if (requestedStatus !== null && requestedStatus !== previousStatus) {
      if (requestedStatus === 'draft') {
        return invalid(
          'INVALID_STATUS_TRANSITION',
          '확정된 발주서는 초안으로 되돌릴 수 없습니다.',
        );
      }
      if (requestedStatus === 'ordered' && previousStatus !== 'draft') {
        return invalid(
          'INVALID_STATUS_TRANSITION',
          '초안 상태의 발주서만 확정할 수 있습니다.',
        );
      }
      if (requestedStatus === 'canceled') {
        if (previousStatus !== 'draft' && previousStatus !== 'ordered') {
          return invalid(
            'INVALID_STATUS_TRANSITION',
            '입고가 시작되었거나 종료된 발주서는 취소할 수 없습니다.',
          );
        }
        const receipt = await db.prepare(
          `SELECT COALESCE(SUM(received_qty), 0) AS received_qty
             FROM order_items WHERE order_id = ? AND is_deleted = 0`,
        ).bind(orderId).first<{ received_qty: number }>();
        if (Number(receipt?.received_qty || 0) > 0) {
          return invalid(
            'INVALID_STATUS_TRANSITION',
            '입고가 시작된 발주서는 취소할 수 없습니다.',
          );
        }
      }
    }

    if (requestedStatus === 'ordered') {
      const row = await db.prepare(
        'SELECT COUNT(1) AS cnt FROM order_items WHERE order_id = ? AND is_deleted = 0',
      ).bind(orderId).first<{ cnt: number }>();
      const itemCount = Number(row?.cnt || 0);
      if (itemCount <= 0) {
        return invalid(
          'INVALID_STATUS_TRANSITION',
          '발주 항목이 없는 초안은 발주 확정할 수 없습니다.',
        );
      }

      if (previousStatus === 'draft') {
        patches.push('order_date = date("now")');
      }
    }

    let query = `UPDATE purchase_orders SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`;
    const updateParams: unknown[] = [...params, orderId];
    if (requestedStatus !== null) {
      query += ' AND status = ?';
      updateParams.push(previousStatus);
      if (requestedStatus === 'ordered') {
        query += ` AND EXISTS (
          SELECT 1 FROM order_items
           WHERE order_id = purchase_orders.id AND is_deleted = 0
        )`;
      }
      if (requestedStatus === 'canceled') {
        query += ` AND NOT EXISTS (
          SELECT 1 FROM order_items
           WHERE order_id = purchase_orders.id AND is_deleted = 0 AND received_qty > 0
        )`;
      }
    }

    const batchResult = await db.batch([
      db.prepare(query).bind(...updateParams),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'update', 'purchase_order', po.id, ?,
                json_object(
                  'id', po.id, 'title', po.title, 'status', po.status,
                  'order_date', po.order_date, 'external_order_ref', po.external_order_ref,
                  'note', po.note, 'is_deleted', po.is_deleted,
                  'created_at', po.created_at, 'updated_at', po.updated_at
                )
           FROM purchase_orders po
          WHERE po.id = ? AND changes() = 1`,
      ).bind(actorUserId, JSON.stringify(before), orderId),
    ]);

    if (batchResult[0].meta.changes === 0) {
      return conflict('CONFLICT', '발주 상태가 변경되어 수정할 수 없습니다.');
    }

    const after = await selectActivePurchaseOrder(db, orderId);
    return success(after);
  }

  async function deleteDraft(
    orderId: number,
  ): Promise<PurchaseOrderResult<{ deleted: true }>> {
    const before = await db.prepare(
      'SELECT * FROM purchase_orders WHERE id = ?',
    ).bind(orderId).first<Record<string, unknown>>();
    if (!before) return notFound('발주서를 찾지 못했습니다.');
    if (before.is_deleted === 1) return notFound('발주서를 찾지 못했습니다.');
    if (before.status !== 'draft') {
      return conflict(
        'ORDER_DELETE_CONFLICT',
        '확정되었거나 입고가 시작된 발주서는 삭제할 수 없습니다.',
      );
    }

    const after = { ...before, is_deleted: 1 };
    const deleteToken = crypto.randomUUID();
    const batchResult = await db.batch([
      db.prepare(
        `UPDATE order_items
            SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now')
          WHERE order_id = ? AND is_deleted = 0
            AND EXISTS (
              SELECT 1 FROM purchase_orders po
               WHERE po.id = ? AND po.is_deleted = 0 AND po.status = 'draft'
            )
            AND NOT EXISTS (
              SELECT 1 FROM order_items received
               WHERE received.order_id = ? AND received.received_qty > 0
            )`,
      ).bind(orderId, orderId, orderId),
      db.prepare(
        `UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now'),
                creation_token = ?
          WHERE id = ? AND is_deleted = 0 AND status = 'draft'
            AND NOT EXISTS (
              SELECT 1 FROM order_items WHERE order_id = ? AND received_qty > 0
            )`,
      ).bind(deleteToken, orderId, orderId),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'soft_delete', 'purchase_order', id, ?, ?
           FROM purchase_orders WHERE creation_token = ?`,
      ).bind(
        actorUserId,
        JSON.stringify(before),
        JSON.stringify(after),
        deleteToken,
      ),
      db.prepare(
        'UPDATE purchase_orders SET creation_token = NULL WHERE creation_token = ?',
      ).bind(deleteToken),
    ]);

    if (batchResult[1].meta.changes === 0) {
      return conflict(
        'ORDER_DELETE_CONFLICT',
        '발주 상태가 변경되어 삭제할 수 없습니다.',
      );
    }
    return success({ deleted: true });
  }
}

function success<T>(value: T): PurchaseOrderResult<T> {
  return { ok: true, value };
}

function invalid(
  code: Extract<PurchaseOrderFailure, { kind: 'invalid' }>['code'],
  message: string,
): PurchaseOrderResult<never> {
  return { ok: false, error: { kind: 'invalid', code, message } };
}

function notFound(message: string): PurchaseOrderResult<never> {
  return {
    ok: false,
    error: { kind: 'not_found', code: 'NOT_FOUND', message },
  };
}

function conflict(
  code: Extract<PurchaseOrderFailure, { kind: 'conflict' }>['code'],
  message: string,
): PurchaseOrderResult<never> {
  return { ok: false, error: { kind: 'conflict', code, message } };
}

const ORDER_PUBLIC_COLUMNS = `id, title, status, order_date, external_order_ref, note,
  is_deleted, deleted_at, created_at, updated_at`;
const ORDER_STATUSES = [
  'draft',
  'ordered',
  'partially_received',
  'fully_received',
  'canceled',
] as const;

export function isPurchaseOrderStatus(status: string): status is PurchaseOrderStatus {
  return ORDER_STATUSES.includes(status as PurchaseOrderStatus);
}

function selectPurchaseOrder(db: D1Database, orderId: number) {
  return db.prepare(
    `SELECT ${ORDER_PUBLIC_COLUMNS}
       FROM purchase_orders
      WHERE id = ?`,
  ).bind(orderId).first<PurchaseOrderRow>();
}

function selectActivePurchaseOrder(db: D1Database, orderId: number) {
  return db.prepare(
    `SELECT ${ORDER_PUBLIC_COLUMNS}
       FROM purchase_orders
      WHERE id = ? AND is_deleted = 0`,
  ).bind(orderId).first<PurchaseOrderRow>();
}
