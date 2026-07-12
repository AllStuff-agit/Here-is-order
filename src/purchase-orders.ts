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

export interface PurchaseOrderModule {
  createDraft(
    input: CreateDraftInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>>;
  createDraftWithItems(
    input: CreateDraftWithItemsInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow | null>>;
  getDetail(orderId: number): Promise<PurchaseOrderResult<PurchaseOrderDetail>>;
}

export function purchaseOrders(
  db: D1Database,
  actorUserId: number,
): PurchaseOrderModule {
  return {
    createDraft,
    createDraftWithItems,
    getDetail,
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
