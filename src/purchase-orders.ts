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

    const items = await db.prepare(
      `SELECT oi.id, oi.item_id, i.name AS item_name, i.spec,
              oi.ordered_qty, oi.received_qty,
              (oi.ordered_qty - oi.received_qty) AS remaining_qty, oi.memo
         FROM order_items oi
         LEFT JOIN items i ON i.id = oi.item_id
        WHERE oi.order_id = ? AND oi.is_deleted = 0
        ORDER BY oi.id DESC`,
    ).bind(orderId).all<PurchaseOrderDetail['items'][number]>();

    return success({ ...order, items: items.results });
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

function isPurchaseOrderStatus(status: string): status is PurchaseOrderStatus {
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
