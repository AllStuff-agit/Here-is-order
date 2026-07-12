import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const TABLES_IN_DELETE_ORDER = [
  'stock_transactions',
  'order_items',
  'audit_logs',
  'sessions',
  'purchase_orders',
  'items',
  'item_categories',
  'users',
] as const;

beforeEach(async () => {
  await env.DB.batch(
    TABLES_IN_DELETE_ORDER.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

async function createSession(role: 'admin' | 'staff' = 'admin') {
  const sessionToken = `${role}-${crypto.randomUUID()}`;
  const user = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES (?, ?, ?, ?)`
  )
    .bind(`${role}-${crypto.randomUUID()}`, 'unused-in-session-test', role, role)
    .run();

  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+1 hour'))`
  )
    .bind(sessionToken, user.meta.last_row_id)
    .run();

  return sessionToken;
}

function apiRequest(path: string, sessionToken: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `isorder_sid=${sessionToken}`);
  if (init.body != null) headers.set('Content-Type', 'application/json');

  return exports.default.fetch(
    new Request(`http://example.com${path}`, { ...init, headers }),
  );
}

async function expectApiError(
  response: Response,
  status: number,
  code: string,
  message: string,
) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code, message },
  });
}

describe('사용자 관리 권한', () => {
  it('staff 사용자의 사용자 목록과 감사로그 조회를 거부한다', async () => {
    const sessionToken = 'staff-session-token';
    const user = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, name, role)
       VALUES (?, ?, ?, ?)`
    )
      .bind('staff-user', 'unused-in-session-test', '직원', 'staff')
      .run();

    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+1 hour'))`
    )
      .bind(sessionToken, user.meta.last_row_id)
      .run();

    const response = await exports.default.fetch(
      new Request('http://example.com/api/users', {
        headers: {
          Cookie: `isorder_sid=${sessionToken}`,
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: '관리자 권한이 필요합니다.',
      },
    });

    const auditResponse = await apiRequest('/api/audit-logs', sessionToken);
    expect(auditResponse.status).toBe(403);
    await expect(auditResponse.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: '관리자 권한이 필요합니다.',
      },
    });
  });
});

describe('발주서 일괄 생성', () => {
  it('일부라도 잘못된 품목 행이 있으면 발주서를 전혀 생성하지 않는다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`
    )
      .bind('테스트 원두')
      .run();

    const createResponse = await apiRequest(
      '/api/purchase-orders/with-items',
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({
          title: '원자적 발주',
          items: [
            { item_id: item.meta.last_row_id, ordered_qty: 3 },
            { item_id: item.meta.last_row_id, ordered_qty: 0 },
          ],
        }),
      },
    );

    expect(createResponse.status).toBe(400);

    const listResponse = await apiRequest(
      '/api/purchase-orders',
      sessionToken,
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      ok: true,
      data: [],
    });
  });
});

describe('발주 부분입고', () => {
  it('동시에 남은 수량을 초과해 입고해도 한 요청만 반영하고 재고와 누적입고를 일치시킨다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`
    )
      .bind('동시입고 원두')
      .run();
    const order = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status)
       VALUES (?, 'ordered')`
    )
      .bind('동시입고 발주')
      .run();
    const orderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 5, 0)`
    )
      .bind(order.meta.last_row_id, item.meta.last_row_id)
      .run();

    const receivePath = `/api/purchase-orders/${order.meta.last_row_id}/items/${orderItem.meta.last_row_id}/receive`;
    const receive = () => apiRequest(receivePath, sessionToken, {
      method: 'POST',
      body: JSON.stringify({ qty: 4 }),
    });

    const responses = await Promise.all([receive(), receive()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const detailResponse = await apiRequest(
      `/api/purchase-orders/${order.meta.last_row_id}`,
      sessionToken,
    );
    const detail = await detailResponse.json() as {
      ok: true;
      data: { items: Array<{ id: number; received_qty: number }> };
    };
    expect(detail.ok).toBe(true);
    expect(detail.data.items).toEqual([
      expect.objectContaining({
        id: Number(orderItem.meta.last_row_id),
        received_qty: 4,
      }),
    ]);

    const itemsResponse = await apiRequest('/api/items', sessionToken);
    const items = await itemsResponse.json() as {
      ok: true;
      data: Array<{ id: number; current_stock: number }>;
    };
    expect(items.ok).toBe(true);
    expect(items.data).toEqual([
      expect.objectContaining({
        id: Number(item.meta.last_row_id),
        current_stock: 4,
      }),
    ]);
  });

  it('preserves path falsiness, quantity coercion, malformed JSON, and top-level null handling', async () => {
    const sessionToken = await createSession();

    await expectApiError(
      await apiRequest('/api/purchase-orders/0/items/1/receive', sessionToken, {
        method: 'POST',
        body: 'null',
      }),
      400,
      'INVALID_INPUT',
      '발주 ID 또는 항목 ID가 유효하지 않습니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/1/items/0/receive', sessionToken, {
        method: 'POST',
        body: JSON.stringify({ qty: 1 }),
      }),
      400,
      'INVALID_INPUT',
      '발주 ID 또는 항목 ID가 유효하지 않습니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/999999/items/999999/receive', sessionToken, {
        method: 'POST',
        body: '{',
      }),
      400,
      'INVALID_INPUT',
      'qty는 1 이상의 정수여야 합니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/999999/items/999999/receive', sessionToken, {
        method: 'POST',
        body: JSON.stringify({ qty: '1.5' }),
      }),
      400,
      'INVALID_INPUT',
      'qty는 1 이상의 정수여야 합니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/999999/items/999999/receive', sessionToken, {
        method: 'POST',
        body: JSON.stringify({ qty: [1] }),
      }),
      404,
      'NOT_FOUND',
      '발주서를 찾지 못했습니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/-1/items/-2/receive', sessionToken, {
        method: 'POST',
        body: JSON.stringify({ qty: ' 1 ' }),
      }),
      404,
      'NOT_FOUND',
      '발주서를 찾지 못했습니다.',
    );
    await expectApiError(
      await apiRequest('/api/purchase-orders/999999/items/999999/receive', sessionToken, {
        method: 'POST',
        body: 'null',
      }),
      500,
      'INTERNAL_ERROR',
      '서버 오류가 발생했습니다.',
    );
  });

  it('keeps receipt preflight order and messages ahead of throwing note conversion', async () => {
    const sessionToken = await createSession();
    const throwingNote = { toString: null, valueOf: null };
    const request = (orderId: number, orderItemId: number, qty = 1) => apiRequest(
      `/api/purchase-orders/${orderId}/items/${orderItemId}/receive`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({ qty, note: throwingNote }),
      },
    );
    const createOrder = async (title: string, status: string) => {
      const result = await env.DB.prepare(
        'INSERT INTO purchase_orders (title, status) VALUES (?, ?)',
      ).bind(title, status).run();
      return Number(result.meta.last_row_id);
    };

    await expectApiError(
      await request(999999, 999999),
      404,
      'NOT_FOUND',
      '발주서를 찾지 못했습니다.',
    );

    const draftOrderId = await createOrder('receipt draft preflight', 'draft');
    await expectApiError(
      await request(draftOrderId, 999999),
      400,
      'INVALID_STATUS',
      '초안 상태에서는 입고 처리할 수 없습니다.',
    );

    const canceledOrderId = await createOrder('receipt canceled preflight', 'canceled');
    await expectApiError(
      await request(canceledOrderId, 999999),
      400,
      'INVALID_STATUS',
      '취소된 발주서는 입고 처리할 수 없습니다.',
    );

    const fullOrderId = await createOrder('receipt full preflight', 'fully_received');
    await expectApiError(
      await request(fullOrderId, 999999),
      400,
      'INVALID_STATUS',
      '이미 입고 완료된 발주서입니다.',
    );

    const missingItemOrderId = await createOrder('receipt missing item', 'ordered');
    await expectApiError(
      await request(missingItemOrderId, 999999),
      404,
      'NOT_FOUND',
      '발주 항목을 찾지 못했습니다.',
    );

    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('receipt preflight 원두').run();
    const itemId = Number(item.meta.last_row_id);

    const completedItemOrderId = await createOrder('receipt completed item', 'ordered');
    const completedItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 1, 1)`,
    ).bind(completedItemOrderId, itemId).run();
    await expectApiError(
      await request(completedItemOrderId, Number(completedItem.meta.last_row_id)),
      409,
      'RECEIVE_CONFLICT',
      '이미 입고 완료된 항목입니다.',
    );

    const limitedOrderId = await createOrder('receipt limited item', 'ordered');
    const limitedItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 3, 1)`,
    ).bind(limitedOrderId, itemId).run();
    await expectApiError(
      await request(limitedOrderId, Number(limitedItem.meta.last_row_id), 3),
      409,
      'RECEIVE_CONFLICT',
      '현재 최대 2개까지 입고 가능합니다.',
    );

    const validOrderId = await createOrder('receipt throwing note', 'ordered');
    const validItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 1, 0)`,
    ).bind(validOrderId, itemId).run();
    await expectApiError(
      await request(validOrderId, Number(validItem.meta.last_row_id)),
      500,
      'INTERNAL_ERROR',
      '서버 오류가 발생했습니다.',
    );
  });

  it('leaves inactive inventory and unexpected statuses to the first receipt statement', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('receipt batch eligibility 원두').run();
    const itemId = Number(item.meta.last_row_id);
    const inactiveOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
    ).bind('inactive inventory receipt').run();
    const inactiveOrderId = Number(inactiveOrder.meta.last_row_id);
    const inactiveOrderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 2, 0)`,
    ).bind(inactiveOrderId, itemId).run();
    const inactiveOrderItemId = Number(inactiveOrderItem.meta.last_row_id);
    await env.DB.prepare(
      `UPDATE items SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?`,
    ).bind(itemId).run();

    await expectApiError(
      await apiRequest(
        `/api/purchase-orders/${inactiveOrderId}/items/${inactiveOrderItemId}/receive`,
        sessionToken,
        {
          method: 'POST',
          body: JSON.stringify({ qty: 1 }),
        },
      ),
      409,
      'RECEIVE_CONFLICT',
      '남은 입고 수량 또는 발주 상태가 변경되었습니다.',
    );
    await expectApiError(
      await apiRequest(
        `/api/purchase-orders/${inactiveOrderId}/items/${inactiveOrderItemId}/receive`,
        sessionToken,
        {
          method: 'POST',
          body: JSON.stringify({
            qty: 1,
            note: { toString: null, valueOf: null },
          }),
        },
      ),
      500,
      'INTERNAL_ERROR',
      '서버 오류가 발생했습니다.',
    );

    const unexpectedItem = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('unexpected status receipt 원두').run();
    const unexpectedOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
    ).bind('unexpected status receipt').run();
    const unexpectedOrderId = Number(unexpectedOrder.meta.last_row_id);
    const unexpectedOrderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 1, 0)`,
    ).bind(unexpectedOrderId, unexpectedItem.meta.last_row_id).run();

    await env.DB.prepare(
      'DROP TRIGGER IF EXISTS trg_purchase_orders_status_transition',
    ).run();
    try {
      await env.DB.exec('PRAGMA ignore_check_constraints = ON');
      await env.DB.prepare(
        `UPDATE purchase_orders SET status = 'unexpected' WHERE id = ?`,
      ).bind(unexpectedOrderId).run();
    } finally {
      try {
        await env.DB.exec('PRAGMA ignore_check_constraints = OFF');
      } finally {
        await env.DB.prepare(
          `CREATE TRIGGER IF NOT EXISTS trg_purchase_orders_status_transition
           BEFORE UPDATE OF status ON purchase_orders
           WHEN NEW.status <> OLD.status
            AND NOT (
              (OLD.status = 'draft' AND NEW.status IN ('ordered', 'canceled'))
              OR (OLD.status = 'ordered' AND NEW.status IN ('partially_received', 'fully_received', 'canceled'))
              OR (OLD.status = 'partially_received' AND NEW.status = 'fully_received')
            )
           BEGIN
             SELECT RAISE(ABORT, 'INVALID_ORDER_STATUS_TRANSITION');
           END`,
        ).run();
      }
    }

    await expectApiError(
      await apiRequest(
        `/api/purchase-orders/${unexpectedOrderId}/items/${unexpectedOrderItem.meta.last_row_id}/receive`,
        sessionToken,
        { method: 'POST', body: JSON.stringify({ qty: 1 }) },
      ),
      409,
      'RECEIVE_CONFLICT',
      '남은 입고 수량 또는 발주 상태가 변경되었습니다.',
    );
  });

  it('preserves omitted, null, and empty receipt reasons', async () => {
    const sessionToken = await createSession();
    const cases = [
      { label: 'omitted', includeNote: false, note: null, reason: '부분입고 처리' },
      { label: 'null', includeNote: true, note: null, reason: '부분입고 처리' },
      { label: 'empty', includeNote: true, note: '', reason: '' },
    ] as const;

    for (const testCase of cases) {
      const item = await env.DB.prepare(
        `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
         VALUES (?, '개', 0, 0, 0, 0)`,
      ).bind(`receipt reason ${testCase.label}`).run();
      const order = await env.DB.prepare(
        `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
      ).bind(`receipt reason ${testCase.label}`).run();
      const orderItem = await env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
         VALUES (?, ?, 1, 0)`,
      ).bind(order.meta.last_row_id, item.meta.last_row_id).run();
      const payload: { qty: number; note?: string | null } = { qty: 1 };
      if (testCase.includeNote) payload.note = testCase.note;

      const response = await apiRequest(
        `/api/purchase-orders/${order.meta.last_row_id}/items/${orderItem.meta.last_row_id}/receive`,
        sessionToken,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      expect(response.status).toBe(200);
      const ledger = await env.DB.prepare(
        `SELECT reason, operation_token
           FROM stock_transactions WHERE order_item_id = ?`,
      ).bind(orderItem.meta.last_row_id).first<{
        reason: string | null;
        operation_token: string | null;
      }>();
      expect(ledger).toEqual({
        reason: testCase.reason,
        operation_token: expect.any(String),
      });
    }
  });

  it('returns 200 when receipt order and order-item readbacks independently disappear', async () => {
    const sessionToken = await createSession();
    const createFixture = async (label: string) => {
      const item = await env.DB.prepare(
        `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
         VALUES (?, '개', 0, 0, 0, 0)`,
      ).bind(`${label} 원두`).run();
      const order = await env.DB.prepare(
        `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
      ).bind(`${label} 발주`).run();
      const orderItem = await env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty, memo)
         VALUES (?, ?, 1, 0, ?)`,
      ).bind(order.meta.last_row_id, item.meta.last_row_id, `${label} memo`).run();
      return {
        itemId: Number(item.meta.last_row_id),
        orderId: Number(order.meta.last_row_id),
        orderItemId: Number(orderItem.meta.last_row_id),
      };
    };

    const removedItem = await createFixture('removed item readback');
    await env.DB.prepare(
      `CREATE TRIGGER test_api_remove_received_item_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'receive'
         AND NEW.entity_type = 'order_item'
         AND NEW.entity_id = ${removedItem.orderItemId}
       BEGIN
         DELETE FROM order_items WHERE id = NEW.entity_id;
       END`,
    ).run();
    let removedItemResponse: Response;
    try {
      removedItemResponse = await apiRequest(
        `/api/purchase-orders/${removedItem.orderId}/items/${removedItem.orderItemId}/receive`,
        sessionToken,
        { method: 'POST', body: JSON.stringify({ qty: 1 }) },
      );
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_api_remove_received_item_before_readback',
      ).run();
    }
    expect(removedItemResponse.status).toBe(200);
    await expect(removedItemResponse.json()).resolves.toEqual({
      ok: true,
      data: {
        order: expect.objectContaining({
          id: removedItem.orderId,
          status: 'fully_received',
        }),
        order_item: null,
      },
    });

    const removedOrder = await createFixture('removed order readback');
    const holdingOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('receipt API readback holding order').run();
    await env.DB.prepare(
      `CREATE TRIGGER test_api_remove_received_order_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'receive'
         AND NEW.entity_type = 'order_item'
         AND NEW.entity_id = ${removedOrder.orderItemId}
       BEGIN
         UPDATE order_items
            SET order_id = ${Number(holdingOrder.meta.last_row_id)}
          WHERE id = NEW.entity_id;
         DELETE FROM purchase_orders WHERE id = ${removedOrder.orderId};
       END`,
    ).run();
    let removedOrderResponse: Response;
    try {
      removedOrderResponse = await apiRequest(
        `/api/purchase-orders/${removedOrder.orderId}/items/${removedOrder.orderItemId}/receive`,
        sessionToken,
        { method: 'POST', body: JSON.stringify({ qty: 1, note: '' }) },
      );
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_api_remove_received_order_before_readback',
      ).run();
    }
    expect(removedOrderResponse.status).toBe(200);
    await expect(removedOrderResponse.json()).resolves.toEqual({
      ok: true,
      data: {
        order: null,
        order_item: {
          id: removedOrder.orderItemId,
          item_id: removedOrder.itemId,
          ordered_qty: 1,
          received_qty: 1,
          memo: 'removed order readback memo',
        },
      },
    });
  });
});

describe('발주서 삭제 제한', () => {
  it('초안만 삭제하고 확정되거나 입고가 시작된 발주서는 보존한다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 1, 0)`
    )
      .bind('삭제제한 원두')
      .run();

    const createOrder = async (title: string, status: string, receivedQty: number) => {
      const order = await env.DB.prepare(
        'INSERT INTO purchase_orders (title, status) VALUES (?, ?)'
      ).bind(title, status).run();
      await env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
         VALUES (?, ?, 3, ?)`
      ).bind(order.meta.last_row_id, item.meta.last_row_id, receivedQty).run();
      return Number(order.meta.last_row_id);
    };

    const draftId = await createOrder('삭제 가능한 초안', 'draft', 0);
    const orderedId = await createOrder('삭제 불가 확정', 'ordered', 0);
    const receivedId = await createOrder('삭제 불가 입고', 'partially_received', 1);

    const [draftResponse, orderedResponse, receivedResponse] = await Promise.all([
      apiRequest(`/api/purchase-orders/${draftId}`, sessionToken, { method: 'DELETE' }),
      apiRequest(`/api/purchase-orders/${orderedId}`, sessionToken, { method: 'DELETE' }),
      apiRequest(`/api/purchase-orders/${receivedId}`, sessionToken, { method: 'DELETE' }),
    ]);

    expect(draftResponse.status).toBe(200);
    expect(orderedResponse.status).toBe(409);
    expect(receivedResponse.status).toBe(409);

    const listResponse = await apiRequest('/api/purchase-orders', sessionToken);
    const list = await listResponse.json() as {
      ok: true;
      data: Array<{ id: number; status: string }>;
    };
    expect(list.ok).toBe(true);
    expect(list.data).toEqual([
      expect.objectContaining({ id: receivedId, status: 'partially_received' }),
      expect.objectContaining({ id: orderedId, status: 'ordered' }),
    ]);
  });
});

describe('발주 상태 머신', () => {
  it('draft 생성과 정방향 확정만 허용하고 확정·종료 상태의 역전을 거부한다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`
    )
      .bind('상태전이 원두')
      .run();

    const orderedCreate = await apiRequest('/api/purchase-orders', sessionToken, {
      method: 'POST',
      body: JSON.stringify({ title: '잘못된 즉시확정', status: 'ordered' }),
    });
    expect(orderedCreate.status).toBe(400);

    const emptyDraftResponse = await apiRequest('/api/purchase-orders', sessionToken, {
      method: 'POST',
      body: JSON.stringify({ title: '빈 초안' }),
    });
    const emptyDraft = await emptyDraftResponse.json() as {
      ok: true;
      data: { id: number };
    };
    const emptyConfirm = await apiRequest(
      `/api/purchase-orders/${emptyDraft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'ordered' }) },
    );
    expect(emptyConfirm.status).toBe(400);

    const draftResponse = await apiRequest('/api/purchase-orders/with-items', sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        title: '정상 초안',
        items: [{ item_id: item.meta.last_row_id, ordered_qty: 2 }],
      }),
    });
    const draft = await draftResponse.json() as {
      ok: true;
      data: { id: number };
    };
    const confirm = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'ordered' }) },
    );
    expect(confirm.status).toBe(200);

    const reverseToDraft = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) },
    );
    expect(reverseToDraft.status).toBe(400);

    const fullyReceived = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'fully_received')`
    ).bind('완료 발주').run();
    const canceled = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'canceled')`
    ).bind('취소 발주').run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
         VALUES (?, ?, 1, 1)`
      ).bind(fullyReceived.meta.last_row_id, item.meta.last_row_id),
      env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
         VALUES (?, ?, 1, 0)`
      ).bind(canceled.meta.last_row_id, item.meta.last_row_id),
    ]);

    const [fullyReverse, canceledReverse] = await Promise.all([
      apiRequest(
        `/api/purchase-orders/${fullyReceived.meta.last_row_id}`,
        sessionToken,
        { method: 'PATCH', body: JSON.stringify({ status: 'canceled' }) },
      ),
      apiRequest(
        `/api/purchase-orders/${canceled.meta.last_row_id}`,
        sessionToken,
        { method: 'PATCH', body: JSON.stringify({ status: 'ordered' }) },
      ),
    ]);
    expect(fullyReverse.status).toBe(400);
    expect(canceledReverse.status).toBe(400);

    const detailResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
    );
    const detail = await detailResponse.json() as {
      ok: true;
      data: { status: string };
    };
    expect(detail.data.status).toBe('ordered');
  });

  it('앞선 필드를 검증한 뒤 나중 필드를 coercion한다', async () => {
    const sessionToken = await createSession();
    const response = await apiRequest('/api/purchase-orders/1', sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({ title: '', status: { toString: null } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: '발주명은 빈 값이 될 수 없습니다.',
      },
    });
  });
});

describe('재고 원장 강제', () => {
  it('품목 PATCH로 current_stock을 직접 바꾸지 못하고 기존 재고를 보존한다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 2, 0)`
    )
      .bind('원장보호 원두')
      .run();

    const patchResponse = await apiRequest(
      `/api/items/${item.meta.last_row_id}`,
      sessionToken,
      {
        method: 'PATCH',
        body: JSON.stringify({ current_stock: 9 }),
      },
    );
    expect(patchResponse.status).toBe(400);

    const itemsResponse = await apiRequest('/api/items', sessionToken);
    const items = await itemsResponse.json() as {
      ok: true;
      data: Array<{ id: number; current_stock: number }>;
    };
    expect(items.data).toEqual([
      expect.objectContaining({
        id: Number(item.meta.last_row_id),
        current_stock: 2,
      }),
    ]);
  });
});

describe('핵심 변경과 감사로그 원자성', () => {
  it('감사로그 기록이 실패하면 품목 메타데이터 변경도 롤백한다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`
    )
      .bind('변경 전 이름')
      .run();

    await env.DB.prepare(
      `CREATE TRIGGER test_fail_audit_insert
       BEFORE INSERT ON audit_logs
       BEGIN
         SELECT RAISE(ABORT, 'TEST_AUDIT_FAILURE');
       END`
    ).run();

    let patchStatus = 0;
    let items: Array<{ id: number; name: string }> = [];
    try {
      const patchResponse = await apiRequest(
        `/api/items/${item.meta.last_row_id}`,
        sessionToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ name: '변경 후 이름' }),
        },
      );
      patchStatus = patchResponse.status;

      const itemsResponse = await apiRequest('/api/items', sessionToken);
      const body = await itemsResponse.json() as {
        ok: true;
        data: Array<{ id: number; name: string }>;
      };
      items = body.data;
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_audit_insert').run();
    }

    expect(patchStatus).toBe(500);
    expect(items).toEqual([
      expect.objectContaining({
        id: Number(item.meta.last_row_id),
        name: '변경 전 이름',
      }),
    ]);
  });
});

describe('초기 재고 원장', () => {
  it('품목 생성의 초기 현재고를 ADJUST 원장과 함께 기록한다', async () => {
    const sessionToken = await createSession();
    const createResponse = await apiRequest('/api/items', sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        name: '초기재고 원두',
        current_stock: 5,
        safety_stock: 0,
        min_stock: 0,
        unit_price: 0,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      ok: true;
      data: { id: number; current_stock: number };
    };
    expect(created.data.current_stock).toBe(5);

    const ledgerResponse = await apiRequest(
      `/api/stock/ledger/${created.data.id}`,
      sessionToken,
    );
    const ledger = await ledgerResponse.json() as {
      ok: true;
      data: Array<{ movement_type: string; quantity: number; reason: string }>;
    };
    expect(ledger.data).toEqual([
      expect.objectContaining({
        movement_type: 'ADJUST',
        quantity: 5,
        reason: '초기 재고',
      }),
    ]);
  });
});

describe('비밀번호 초기화 세션 폐기', () => {
  it('관리자가 비밀번호를 초기화하면 대상 사용자의 기존 세션을 모두 만료시킨다', async () => {
    const adminSession = await createSession('admin');
    const staffSession = 'reset-target-session';
    const staff = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, name, role)
       VALUES (?, ?, ?, 'staff')`
    )
      .bind('reset-target', 'legacy-placeholder', '초기화 대상')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+1 hour'))`
    ).bind(staffSession, staff.meta.last_row_id).run();

    const beforeReset = await apiRequest('/api/users/me', staffSession);
    expect(beforeReset.status).toBe(200);

    const resetResponse = await apiRequest(
      `/api/users/${staff.meta.last_row_id}/password`,
      adminSession,
      {
        method: 'PATCH',
        body: JSON.stringify({ new_password: 'new-secure-password' }),
      },
    );
    expect(resetResponse.status).toBe(200);

    const afterReset = await apiRequest('/api/users/me', staffSession);
    expect(afterReset.status).toBe(401);
    await expect(afterReset.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: '로그인이 필요합니다.',
      },
    });
  });
});

describe('발주 compatibility characterization', () => {
  it('생성과 추가의 memo 병합 차이와 전체 활성 항목 반환을 보존한다', async () => {
    const sessionToken = await createSession();
    const firstItem = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('memo 원두').run();
    const secondItem = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('memo 우유').run();

    const populatedResponse = await apiRequest('/api/purchase-orders/with-items', sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        title: '생성 병합',
        status: 'ordered',
        items: [
          { item_id: firstItem.meta.last_row_id, ordered_qty: 1, memo: '첫 memo' },
          { item_id: firstItem.meta.last_row_id, ordered_qty: 2, memo: '' },
        ],
      }),
    });
    expect(populatedResponse.status).toBe(201);
    const populated = await populatedResponse.json() as {
      ok: true;
      data: { id: number; status: string };
    };
    expect(populated.data.status).toBe('draft');

    const populatedDetailResponse = await apiRequest(
      `/api/purchase-orders/${populated.data.id}`,
      sessionToken,
    );
    const populatedDetail = await populatedDetailResponse.json() as {
      ok: true;
      data: { items: Array<{ ordered_qty: number; memo: string | null }> };
    };
    expect(populatedDetail.data.items).toEqual([
      expect.objectContaining({ ordered_qty: 3, memo: '' }),
    ]);

    const draftResponse = await apiRequest('/api/purchase-orders', sessionToken, {
      method: 'POST',
      body: JSON.stringify({ title: '추가 병합' }),
    });
    const draft = await draftResponse.json() as { ok: true; data: { id: number } };

    const addResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}/items`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { item_id: firstItem.meta.last_row_id, ordered_qty: 1, memo: '유지 memo' },
            { item_id: firstItem.meta.last_row_id, ordered_qty: 2, memo: '' },
            { item_id: secondItem.meta.last_row_id, ordered_qty: 1, memo: '두 번째' },
          ],
        }),
      },
    );
    const added = await addResponse.json() as {
      ok: true;
      data: { items: Array<{ item_id: number; ordered_qty: number; memo: string | null }> };
    };
    expect(added.data.items).toHaveLength(2);
    expect(added.data.items).toContainEqual(
      expect.objectContaining({
        item_id: Number(firstItem.meta.last_row_id),
        ordered_qty: 3,
        memo: '유지 memo',
      }),
    );

    const clearMemoResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}/items`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({
          item_id: firstItem.meta.last_row_id,
          ordered_qty: 1,
          memo: null,
        }),
      },
    );
    const cleared = await clearMemoResponse.json() as {
      ok: true;
      data: { items: Array<{ item_id: number; ordered_qty: number; memo: string | null }> };
    };
    expect(cleared.data.items).toContainEqual(
      expect.objectContaining({
        item_id: Number(firstItem.meta.last_row_id),
        ordered_qty: 4,
        memo: null,
      }),
    );
  });

  it('동일 status, 종료 metadata, 삭제 충돌, receipt reason과 audit facts를 보존한다', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('호환성 원두').run();

    const draftResponse = await apiRequest('/api/purchase-orders/with-items', sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        title: '호환성 발주',
        items: [{ item_id: item.meta.last_row_id, ordered_qty: 2 }],
      }),
    });
    const draft = await draftResponse.json() as { ok: true; data: { id: number } };

    const confirmResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'ordered' }) },
    );
    expect(confirmResponse.status).toBe(200);

    const sameStatusResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'ordered' }) },
    );
    expect(sameStatusResponse.status).toBe(200);

    const orderedAuditsResponse = await apiRequest(
      `/api/audit-logs?action=update&entity_type=purchase_order&entity_id=${draft.data.id}`,
      sessionToken,
    );
    const orderedAudits = await orderedAuditsResponse.json() as {
      ok: true;
      data: Array<{ before_json: string; after_json: string }>;
    };
    expect(orderedAudits.data).toHaveLength(2);
    expect(JSON.parse(orderedAudits.data[0].after_json)).toEqual(
      expect.objectContaining({ id: draft.data.id, status: 'ordered' }),
    );

    const detailResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
    );
    const detail = await detailResponse.json() as {
      ok: true;
      data: { items: Array<{ id: number }> };
    };
    const receiveResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}/items/${detail.data.items[0].id}/receive`,
      sessionToken,
      { method: 'POST', body: JSON.stringify({ qty: 2, note: null }) },
    );
    expect(receiveResponse.status).toBe(200);

    const ledgerResponse = await apiRequest(
      `/api/stock/ledger/${item.meta.last_row_id}`,
      sessionToken,
    );
    const ledger = await ledgerResponse.json() as {
      ok: true;
      data: Array<{ reason: string | null }>;
    };
    expect(ledger.data[0].reason).toBe('부분입고 처리');

    const metadataResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      {
        method: 'PATCH',
        body: JSON.stringify({
          title: '완료 후 수정',
          note: '종료 상태 memo',
          external_order_ref: 'external-1',
        }),
      },
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        id: draft.data.id,
        status: 'fully_received',
        title: '완료 후 수정',
        note: '종료 상태 memo',
        external_order_ref: 'external-1',
      }),
    });

    const terminalStatusResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ status: 'fully_received' }) },
    );
    expect(terminalStatusResponse.status).toBe(400);
    await expect(terminalStatusResponse.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_STATUS_TRANSITION',
        message: '부분입고/입고완료 상태는 입고 처리에서 자동으로 변경됩니다.',
      },
    });

    const deletionOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('삭제 충돌').run();
    await env.DB.prepare(
      `INSERT INTO order_items
       (order_id, item_id, ordered_qty, received_qty, is_deleted, deleted_at)
     VALUES (?, ?, 1, 1, 1, datetime('now'))`,
    ).bind(deletionOrder.meta.last_row_id, item.meta.last_row_id).run();
    const deleteResponse = await apiRequest(
      `/api/purchase-orders/${deletionOrder.meta.last_row_id}`,
      sessionToken,
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(409);
    await expect(deleteResponse.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'ORDER_DELETE_CONFLICT',
        message: '발주 상태가 변경되어 삭제할 수 없습니다.',
      },
    });
  });

  it('preserves create, item mutation, and cascade-delete audit JSON facts', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('audit 원두').run();
    const draftResponse = await apiRequest('/api/purchase-orders', sessionToken, {
      method: 'POST',
      body: JSON.stringify({ title: 'audit 초안', note: 'audit note' }),
    });
    const draft = await draftResponse.json() as { ok: true; data: { id: number } };

    const orderCreateResponse = await apiRequest(
      `/api/audit-logs?action=create&entity_type=purchase_order&entity_id=${draft.data.id}`,
      sessionToken,
    );
    const orderCreate = await orderCreateResponse.json() as {
      ok: true;
      data: Array<{ before_json: string | null; after_json: string }>;
    };
    expect(orderCreate.data).toHaveLength(1);
    expect(orderCreate.data[0].before_json).toBeNull();
    expect(JSON.parse(orderCreate.data[0].after_json)).toEqual({
      title: 'audit 초안',
      status: 'draft',
      note: 'audit note',
    });

    const addResponse = await apiRequest(
      `/api/purchase-orders/${draft.data.id}/items`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({
          item_id: item.meta.last_row_id,
          ordered_qty: 2,
          memo: 'item memo',
        }),
      },
    );
    const added = await addResponse.json() as {
      ok: true;
      data: { items: Array<{ id: number }> };
    };
    const orderItemId = added.data.items[0].id;

    const itemCreateResponse = await apiRequest(
      `/api/audit-logs?action=create&entity_type=order_item&entity_id=${orderItemId}`,
      sessionToken,
    );
    const itemCreate = await itemCreateResponse.json() as {
      ok: true;
      data: Array<{ before_json: string | null; after_json: string }>;
    };
    expect(itemCreate.data[0].before_json).toBeNull();
    expect(JSON.parse(itemCreate.data[0].after_json)).toEqual({
      order_id: draft.data.id,
      item_id: Number(item.meta.last_row_id),
      ordered_qty: 2,
      received_qty: 0,
      memo: 'item memo',
    });

    await apiRequest(
      `/api/purchase-orders/${draft.data.id}/items/${orderItemId}`,
      sessionToken,
      {
        method: 'PATCH',
        body: JSON.stringify({ ordered_qty: 3, memo: 'revised memo' }),
      },
    );
    const itemUpdateResponse = await apiRequest(
      `/api/audit-logs?action=update&entity_type=order_item&entity_id=${orderItemId}`,
      sessionToken,
    );
    const itemUpdate = await itemUpdateResponse.json() as {
      ok: true;
      data: Array<{ before_json: string; after_json: string }>;
    };
    expect(JSON.parse(itemUpdate.data[0].before_json)).toEqual({
      id: orderItemId,
      order_id: draft.data.id,
      item_id: Number(item.meta.last_row_id),
      ordered_qty: 2,
      received_qty: 0,
      memo: 'item memo',
    });
    expect(JSON.parse(itemUpdate.data[0].after_json)).toEqual({
      id: orderItemId,
      order_id: draft.data.id,
      item_id: Number(item.meta.last_row_id),
      ordered_qty: 3,
      received_qty: 0,
      memo: 'revised memo',
    });

    const beforeDelete = await env.DB.prepare(
      `SELECT * FROM purchase_orders WHERE id = ?`,
    ).bind(draft.data.id).first<Record<string, unknown>>();
    if (!beforeDelete) throw new Error('expected Purchase Order before deletion');
    await apiRequest(
      `/api/purchase-orders/${draft.data.id}`,
      sessionToken,
      { method: 'DELETE' },
    );
    const deleteAuditResponse = await apiRequest(
      `/api/audit-logs?action=soft_delete&entity_type=purchase_order&entity_id=${draft.data.id}`,
      sessionToken,
    );
    const deleteAudit = await deleteAuditResponse.json() as {
      ok: true;
      data: Array<{ before_json: string; after_json: string }>;
    };
    expect(JSON.parse(deleteAudit.data[0].before_json)).toEqual(beforeDelete);
    expect(JSON.parse(deleteAudit.data[0].after_json)).toEqual({
      ...beforeDelete,
      is_deleted: 1,
    });
    const itemDeleteAuditResponse = await apiRequest(
      `/api/audit-logs?action=soft_delete&entity_type=order_item&entity_id=${orderItemId}`,
      sessionToken,
    );
    await expect(itemDeleteAuditResponse.json()).resolves.toEqual({ ok: true, data: [] });
  });

  it('preflights missing and non-draft orders before malformed item bodies', async () => {
    const sessionToken = await createSession();
    const ordered = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
    ).bind('preflight 발주').run();
    const orderedId = Number(ordered.meta.last_row_id);

    const cases = [
      {
        path: '/api/purchase-orders/999999999/items',
        method: 'POST',
        status: 404,
        code: 'NOT_FOUND',
        message: '발주서를 찾지 못했습니다.',
      },
      {
        path: '/api/purchase-orders/999999999/items/1',
        method: 'PATCH',
        status: 404,
        code: 'NOT_FOUND',
        message: '발주서를 찾지 못했습니다.',
      },
      {
        path: `/api/purchase-orders/${orderedId}/items`,
        method: 'POST',
        status: 400,
        code: 'INVALID_STATUS',
        message: '초안 상태에서만 발주 항목을 추가할 수 있습니다.',
      },
      {
        path: `/api/purchase-orders/${orderedId}/items/1`,
        method: 'PATCH',
        status: 400,
        code: 'INVALID_STATUS',
        message: '초안 상태에서만 발주 항목을 수정할 수 있습니다.',
      },
    ] as const;

    for (const testCase of cases) {
      const response = await apiRequest(testCase.path, sessionToken, {
        method: testCase.method,
        body: '{malformed',
      });
      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: testCase.code, message: testCase.message },
      });
    }
  });

  it('preserves add container precedence and null-versus-primitive failures', async () => {
    const sessionToken = await createSession();
    const firstItem = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('container 원두').run();
    const secondItem = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('container 우유').run();
    const order = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('container 초안').run();
    const path = `/api/purchase-orders/${order.meta.last_row_id}/items`;

    const precedenceResponse = await apiRequest(path, sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        item_id: firstItem.meta.last_row_id,
        ordered_qty: 1,
        items: [{ item_id: secondItem.meta.last_row_id, ordered_qty: 9 }],
      }),
    });
    expect(precedenceResponse.status).toBe(200);
    await expect(precedenceResponse.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({
          item_id: Number(firstItem.meta.last_row_id),
          ordered_qty: 1,
        })],
      },
    });

    for (const body of ['{malformed', '7', '[7]']) {
      const response = await apiRequest(path, sessionToken, { method: 'POST', body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: '항목과 수량을 확인해주세요.',
        },
      });
    }

    for (const body of ['null', '[null]']) {
      const response = await apiRequest(path, sessionToken, { method: 'POST', body });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '서버 오류가 발생했습니다.',
        },
      });
    }
  });

  it('preserves add numeric coercion and item-before-quantity validation outcomes', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('coercion 원두').run();
    const order = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('coercion 초안').run();
    const path = `/api/purchase-orders/${order.meta.last_row_id}/items`;
    const itemId = Number(item.meta.last_row_id);

    const hexadecimal = await apiRequest(path, sessionToken, {
      method: 'POST',
      body: JSON.stringify({ item_id: `  ${itemId}  `, ordered_qty: '0x2' }),
    });
    expect(hexadecimal.status).toBe(200);
    await expect(hexadecimal.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({ item_id: itemId, ordered_qty: 2 })],
      },
    });

    const exponent = await apiRequest(path, sessionToken, {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, ordered_qty: '1e1' }),
    });
    expect(exponent.status).toBe(200);
    await expect(exponent.json()).resolves.toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({ item_id: itemId, ordered_qty: 12 })],
      },
    });

    for (const missingItemId of [0, -7]) {
      const response = await apiRequest(path, sessionToken, {
        method: 'POST',
        body: JSON.stringify({ item_id: missingItemId, ordered_qty: 1 }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `존재하지 않는 품목입니다. (id=${missingItemId})`,
        },
      });
    }

    const invalidQuantity = await apiRequest(path, sessionToken, {
      method: 'POST',
      body: JSON.stringify({ item_id: -9, ordered_qty: 0 }),
    });
    expect(invalidQuantity.status).toBe(400);
    await expect(invalidQuantity.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: '항목과 수량을 확인해주세요.',
      },
    });
  });

  it('preserves edit validation order and array numeric coercion', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('edit coercion 원두').run();
    const order = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('edit coercion 초안').run();
    const orderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 3, 2)`,
    ).bind(order.meta.last_row_id, item.meta.last_row_id).run();
    const orderId = Number(order.meta.last_row_id);
    const orderItemId = Number(orderItem.meta.last_row_id);
    const path = `/api/purchase-orders/${orderId}/items/${orderItemId}`;

    const arrayQuantity = await apiRequest(path, sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({ ordered_qty: [3] }),
    });
    expect(arrayQuantity.status).toBe(200);
    await expect(arrayQuantity.json()).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({ id: orderItemId, ordered_qty: 3 }),
    });

    const belowReceived = await apiRequest(path, sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({ ordered_qty: [1] }),
    });
    expect(belowReceived.status).toBe(400);
    await expect(belowReceived.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: '수정하려는 수량이 이미 입고된 수량보다 작을 수 없습니다.',
      },
    });

    const missingItemPath = `/api/purchase-orders/${orderId}/items/999999999`;
    const invalidQuantity = await apiRequest(missingItemPath, sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({ ordered_qty: 0, memo: 'ignored' }),
    });
    expect(invalidQuantity.status).toBe(400);
    await expect(invalidQuantity.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'ordered_qty는 1 이상의 정수여야 합니다.',
      },
    });

    const emptyPatch = await apiRequest(missingItemPath, sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);
    await expect(emptyPatch.json()).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: '수정할 데이터가 없습니다.' },
    });

    const missingItem = await apiRequest(missingItemPath, sessionToken, {
      method: 'PATCH',
      body: JSON.stringify({ memo: 'missing' }),
    });
    expect(missingItem.status).toBe(404);
    await expect(missingItem.json()).resolves.toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '발주 항목을 찾지 못했습니다.' },
    });
  });

  it('preserves add conflict mapping and uncaught edit batch failures', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('batch failure 원두').run();
    const addOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('add batch failure').run();
    const editOrder = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('edit batch failure').run();
    const orderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 1, 0)`,
    ).bind(editOrder.meta.last_row_id, item.meta.last_row_id).run();

    await env.DB.prepare(
      `CREATE TRIGGER test_fail_order_item_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.entity_type = 'order_item'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_ORDER_ITEM_AUDIT_FAILURE');
       END`,
    ).run();

    try {
      const addResponse = await apiRequest(
        `/api/purchase-orders/${addOrder.meta.last_row_id}/items`,
        sessionToken,
        {
          method: 'POST',
          body: JSON.stringify({
            item_id: item.meta.last_row_id,
            ordered_qty: 1,
          }),
        },
      );
      expect(addResponse.status).toBe(409);
      await expect(addResponse.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: '발주 상태 또는 항목이 변경되었습니다. 다시 시도해주세요.',
        },
      });

      const editResponse = await apiRequest(
        `/api/purchase-orders/${editOrder.meta.last_row_id}/items/${orderItem.meta.last_row_id}`,
        sessionToken,
        { method: 'PATCH', body: JSON.stringify({ ordered_qty: 2 }) },
      );
      expect(editResponse.status).toBe(500);
      await expect(editResponse.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '서버 오류가 발생했습니다.',
        },
      });
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_order_item_audit').run();
    }

    const rows = await env.DB.prepare(
      `SELECT order_id, ordered_qty FROM order_items ORDER BY id ASC`,
    ).all<{ order_id: number; ordered_qty: number }>();
    expect(rows.results).toEqual([
      {
        order_id: Number(editOrder.meta.last_row_id),
        ordered_qty: 1,
      },
    ]);
  });

  it('preserves conditional-token conflict messages and nullable edit readback', async () => {
    const sessionToken = await createSession();
    const item = await env.DB.prepare(
      `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
       VALUES (?, '개', 0, 0, 0, 0)`,
    ).bind('conditional conflict 원두').run();
    const order = await env.DB.prepare(
      `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
    ).bind('conditional conflict 초안').run();
    const orderItem = await env.DB.prepare(
      `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty)
       VALUES (?, ?, 1, 0)`,
    ).bind(order.meta.last_row_id, item.meta.last_row_id).run();
    const orderId = Number(order.meta.last_row_id);
    const orderItemId = Number(orderItem.meta.last_row_id);

    await env.DB.prepare(
      `CREATE TRIGGER test_ignore_item_mutation_token
       BEFORE UPDATE OF creation_token ON purchase_orders
       WHEN NEW.creation_token IS NOT NULL
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    try {
      const addResponse = await apiRequest(
        `/api/purchase-orders/${orderId}/items`,
        sessionToken,
        {
          method: 'POST',
          body: JSON.stringify({ item_id: item.meta.last_row_id, ordered_qty: 1 }),
        },
      );
      expect(addResponse.status).toBe(409);
      await expect(addResponse.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: '초안 상태에서만 발주 항목을 추가할 수 있습니다.',
        },
      });

      const editResponse = await apiRequest(
        `/api/purchase-orders/${orderId}/items/${orderItemId}`,
        sessionToken,
        { method: 'PATCH', body: JSON.stringify({ ordered_qty: 2 }) },
      );
      expect(editResponse.status).toBe(409);
      await expect(editResponse.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: '발주 상태 또는 항목이 변경되었습니다.',
        },
      });
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_ignore_item_mutation_token').run();
    }

    await env.DB.prepare(
      `CREATE TRIGGER test_remove_api_revised_item_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'update' AND NEW.entity_type = 'order_item'
       BEGIN
         DELETE FROM order_items WHERE id = NEW.entity_id;
       END`,
    ).run();

    try {
      const response = await apiRequest(
        `/api/purchase-orders/${orderId}/items/${orderItemId}`,
        sessionToken,
        { method: 'PATCH', body: JSON.stringify({ memo: 'deleted on audit' }) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, data: null });
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_remove_api_revised_item_before_readback',
      ).run();
    }
  });
});
