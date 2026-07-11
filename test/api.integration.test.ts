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
