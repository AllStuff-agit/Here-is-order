# Purchase Order Lifecycle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every existing Purchase Order HTTP and D1 behavior while moving lifecycle, Order Item mutation, partial receipt, conflict, stock movement/ledger, and audit knowledge behind one deep module interface.

**Architecture:** `src/purchase-orders.ts` owns an actor-scoped, intent-named `PurchaseOrderModule` and its D1-specific implementation. Purchase Order lifecycle/detail routes in `src/index.ts` become shallow Hono adapters; the list projection remains in `src/index.ts`. Tests use the real migrations through Miniflare and treat the module interface as the primary behavior surface.

**Tech Stack:** TypeScript 5.6, Hono 4, Cloudflare Workers, D1/SQLite, Vitest 4 with `@cloudflare/vitest-pool-workers`, Next.js 16 verification gates.

## Implementation Compatibility Amendments

These amendments override later literal snippets where they differ from the characterized legacy behavior:

- Create and revise readbacks are `PurchaseOrderRow | null`, edit readback is `OrderItemRow | null`, and receipt `order`/`order_item` fields are independently nullable. Successful HTTP envelopes preserve those `null` values.
- The add, edit, and receive HTTP adapters intentionally use `stageAddItemsToDraft`, `stageEditDraftItem`, or `stageReceive` before body/note coercion, followed by `stage.value.execute`. This narrow compatibility protocol preserves preflight-before-body ordering and race outcomes; it is not a generic repository, transaction, clock, UUID, or audit port. Conditional token writes and batch predicates remain authorization.
- List and PATCH still need status validation. Export `isPurchaseOrderStatus` from `src/purchase-orders.ts`, reuse it in `src/index.ts`, and remove only the local `OrderStatus`, `ORDER_STATUSES`, `isOrderStatus`, dead index `ORDER_PUBLIC_COLUMNS`, and caller-free `writeAudit`. Keep the list SQL/projection byte-for-byte unchanged.
- Receipt completion uses the legacy `SUM(received_qty) >= SUM(ordered_qty)` predicate. Preserve malformed/null wire 500s and sequential earlier-error precedence characterized by the adapter tests.
- Fixed-name test triggers must be dropped before creation and protected by an outer `try/finally`, so an interrupted run cannot poison later runs.

## Global Constraints

- Preserve all current HTTP paths, accepted payload shapes, snake_case response fields, envelope shapes, success statuses, error statuses, codes, and Korean messages.
- Preserve DB schema, migrations, status trigger, token columns, D1 batch ordering, audit JSON facts, and frontend behavior.
- Keep `GET /api/purchase-orders` as the existing list projection in `src/index.ts`.
- Do not add a generic repository, clock, UUID, audit, or transaction port.
- Use D1 directly inside `src/purchase-orders.ts`; Miniflare D1 is the local test adapter.
- Clear `creation_token` where current code clears it; retain `stock_transactions.operation_token` permanently.
- Keep two spaces, single quotes, semicolons, PascalCase types, camelCase variables, and kebab-case ordinary filenames.
- Do not change `migrations/`, `db/schema.sql`, or `frontend/` implementation files.
- Follow red-green-refactor for every new module behavior and commit after every task.

---

## File Structure

- Create `src/purchase-orders.ts`: public types, `PurchaseOrderResult<T>`, actor-scoped factory, lifecycle implementation, private D1 helpers.
- Create `test/purchase-orders.integration.test.ts`: direct module-interface tests using migrated Miniflare D1.
- Modify `src/index.ts`: keep wire parsing and response mapping; replace lifecycle/detail implementation with module calls; retain list projection.
- Modify `test/api.integration.test.ts`: characterize current wire, audit, compatibility, and adapter behavior.

---

### Task 1: Characterize Existing HTTP Compatibility

**Files:**
- Modify: `test/api.integration.test.ts:1-506`

**Interfaces:**
- Consumes: existing `createSession(role?)` and `apiRequest(path, sessionToken, init?)` helpers.
- Produces: green characterization tests that later tasks must keep unchanged.

- [ ] **Step 1: Add a duplicate-merge and add-result characterization test**

Append this test block:

```ts
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
});
```

- [ ] **Step 2: Add status, terminal metadata, deletion, receipt reason, and audit characterization**

Add a second test in the same `describe` block:

```ts
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
```

- [ ] **Step 3: Add an audit JSON compatibility test**

Add a third test in the same `describe` block:

```ts
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
```

- [ ] **Step 4: Run characterization tests and confirm the baseline is green**

Run: `npx vitest run test/api.integration.test.ts`

Expected: PASS. These tests describe current behavior, so failure means the fixture or expectation is wrong; fix the test without changing production code.

- [ ] **Step 5: Commit the characterization safety net**

```bash
git add test/api.integration.test.ts
git commit -m 'test: characterize purchase order lifecycle'
```

---

### Task 2: Add the Deep Module Contract, Draft Creation, and Detail Read

**Files:**
- Create: `src/purchase-orders.ts`
- Create: `test/purchase-orders.integration.test.ts`
- Modify: `src/index.ts:17-45, 1170-1336`

**Interfaces:**
- Consumes: `D1Database`, actor user ID, migrated D1 tables, current public row shapes.
- Produces: `PurchaseOrderResult<T>`, `PurchaseOrderFailure`, `PurchaseOrderStatus`, row/input types, and `purchaseOrders(db, actorUserId)` with `createDraft`, `createDraftWithItems`, and `getDetail`.

- [ ] **Step 1: Create the module-interface test scaffold**

Create `test/purchase-orders.integration.test.ts` with this setup and first tests:

```ts
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { purchaseOrders } from '../src/purchase-orders';

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

async function createActor() {
  const result = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES (?, ?, ?, 'admin')`,
  ).bind(`actor-${crypto.randomUUID()}`, 'unused', '관리자').run();
  const actorUserId = Number(result.meta.last_row_id);
  return { actorUserId, module: purchaseOrders(env.DB, actorUserId) };
}

async function createInventoryItem(name: string) {
  const result = await env.DB.prepare(
    `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
     VALUES (?, '개', 0, 0, 0, 0)`,
  ).bind(name).run();
  return Number(result.meta.last_row_id);
}

describe('Purchase Order module draft creation', () => {
  it('creates and reads a plain draft through the module interface', async () => {
    const { module } = await createActor();
    const created = await module.createDraft({
      title: 'module 초안',
      note: null,
      requestedStatus: 'draft',
    });
    expect(created).toEqual({
      ok: true,
      value: expect.objectContaining({ title: 'module 초안', status: 'draft' }),
    });
    if (!created.ok) throw new Error('expected draft creation success');

    const detail = await module.getDetail(created.value.id);
    expect(detail).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: created.value.id,
        title: 'module 초안',
        items: [],
      }),
    });
  });

  it('atomically merges populated draft rows and preserves create memo precedence', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('module 원두');
    const created = await module.createDraftWithItems({
      title: 'module populated 초안',
      note: null,
      items: [
        { itemId, orderedQty: 1, memo: '첫 memo' },
        { itemId, orderedQty: 2, memo: '' },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected populated draft creation success');

    const detail = await module.getDetail(created.value.id);
    expect(detail).toEqual({
      ok: true,
      value: expect.objectContaining({
        items: [expect.objectContaining({ item_id: itemId, ordered_qty: 3, memo: '' })],
      }),
    });

    const audits = await env.DB.prepare(
      `SELECT action, entity_type, before_json, after_json
         FROM audit_logs ORDER BY id ASC`,
    ).all<{
      action: string;
      entity_type: string;
      before_json: string | null;
      after_json: string;
    }>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results[0]).toEqual(expect.objectContaining({
      action: 'create',
      entity_type: 'order_item',
      before_json: null,
      after_json: JSON.stringify({
        item_id: itemId,
        ordered_qty: 3,
        received_qty: 0,
        memo: '',
      }),
    }));
    expect(audits.results[1]).toEqual(expect.objectContaining({
      action: 'create',
      entity_type: 'purchase_order',
      before_json: null,
      after_json: JSON.stringify({
        title: 'module populated 초안',
        status: 'draft',
        note: null,
        items: [{ itemId, orderedQty: 3, memo: '' }],
      }),
    }));
  });

  it('rejects every row when one populated draft item is invalid', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('rollback 원두');
    const result = await module.createDraftWithItems({
      title: 'rollback 초안',
      note: null,
      items: [
        { itemId, orderedQty: 1, memo: null },
        { itemId, orderedQty: 0, memo: null },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_INPUT' }),
    });
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM purchase_orders WHERE title = ?`,
    ).bind('rollback 초안').first<{ count: number }>();
    expect(Number(row?.count ?? 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run test/purchase-orders.integration.test.ts`

Expected: FAIL with an import-resolution error for `../src/purchase-orders`.

- [ ] **Step 3: Create the public contract and private result helpers**

Create `src/purchase-orders.ts` with these shared types and the Task 2 interface. Tasks 3-5 extend this same interface without renaming existing methods:

```ts
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
  createDraft(input: CreateDraftInput): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  createDraftWithItems(
    input: CreateDraftWithItemsInput,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  getDetail(orderId: number): Promise<PurchaseOrderResult<PurchaseOrderDetail>>;
}
```

Then start the factory with these three methods:

```ts
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
  ): Promise<PurchaseOrderResult<PurchaseOrderRow>> {
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
    if (!row) throw new Error('PURCHASE_ORDER_WRITE_MISSING');
    return success(row);
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
```

Add these two helpers next to `invalid`:

```ts
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
      WHERE id = ? AND is_deleted = 0`,
  ).bind(orderId).first<PurchaseOrderRow>();
}
```

- [ ] **Step 4: Move populated draft and detail behavior into the module**

Adapt the current implementations without changing SQL semantics:

| New method | Exact source behavior to move | Required transformation |
| --- | --- | --- |
| `createDraftWithItems` | `src/index.ts` handler `POST /api/purchase-orders/with-items` | Replace `c.env.DB` with `db`, `user.id` with `actorUserId`, early `c.json` with Result helpers, and final 201 response with `success(row)` |
| `getDetail` | `src/index.ts` handler `GET /api/purchase-orders/:id` | Keep active-order predicate, detail item projection, descending Order Item ID, and return `notFound` or `success` |

For `createDraftWithItems`, keep these implementation details exactly:

```ts
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
```

Validate every original row before merging so index-specific messages remain possible. Validate every merged item against active inventory before constructing the batch. Preserve `creation_token` cleanup, per-Order Item audit insertion before Purchase Order audit insertion, and broad D1 failure mapping to `CONFLICT` with `발주서 생성 중 품목 상태가 변경되었습니다. 다시 시도해주세요.`.

- [ ] **Step 5: Add the Hono Result serializer and migrate the three routes**

Import the module types in `src/index.ts` and add:

```ts
import {
  purchaseOrders,
  type PurchaseOrderResult,
} from './purchase-orders';

function purchaseOrderResponse<T>(
  c: any,
  result: PurchaseOrderResult<T>,
  successStatus: 200 | 201 = 200,
) {
  if (result.ok) return c.json(apiOk(result.value), successStatus);
  const status = result.error.kind === 'invalid'
    ? 400
    : result.error.kind === 'not_found'
      ? 404
      : 409;
  return c.json(apiErr(result.error.code, result.error.message), status);
}
```

Replace the three handlers with thin adapters. The populated adapter must ignore payload `status`, reject non-object rows before calling the module, coerce IDs and quantities, and pass unmerged rows:

```ts
app.get('/api/purchase-orders/:id', async (c) => {
  const actor = c.get('user') as SessionUser;
  const orderId = parseIntValue(c.req.param('id'), null);
  if (!orderId) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);
  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, actor.id).getDetail(orderId),
  );
});
```

Use the same pattern for both POST handlers and success status 201. Do not retain their D1 SQL in `src/index.ts`.

- [ ] **Step 6: Run targeted tests and typecheck**

Run: `npx vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts`

Expected: PASS for both files.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit the first deep slice**

```bash
git add src/purchase-orders.ts src/index.ts test/purchase-orders.integration.test.ts
git commit -m 'refactor: deepen purchase order draft creation'
```

---

### Task 3: Move Purchase Order Revision and Draft Deletion

**Files:**
- Modify: `src/purchase-orders.ts`
- Modify: `src/index.ts` handlers `PATCH /api/purchase-orders/:id` and `DELETE /api/purchase-orders/:id`
- Modify: `test/purchase-orders.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 Result helpers, row types, actor-scoped factory, `selectPurchaseOrder`.
- Produces: `revise(orderId, change)` and `deleteDraft(orderId)` on `PurchaseOrderModule`.

- [ ] **Step 1: Write failing revision and deletion tests**

Append:

```ts
describe('Purchase Order module revision and deletion', () => {
  it('preserves same-status updates and terminal metadata revisions', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('revision 원두');
    const created = await module.createDraftWithItems({
      title: 'revision 발주',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!created.ok) throw new Error('expected creation success');

    const confirmed = await module.revise(created.value.id, { requestedStatus: 'ordered' });
    expect(confirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });
    const sameStatus = await module.revise(created.value.id, { requestedStatus: 'ordered' });
    expect(sameStatus.ok).toBe(true);

    await env.DB.prepare(
      `UPDATE purchase_orders SET status = 'fully_received' WHERE id = ?`,
    ).bind(created.value.id).run();
    const metadata = await module.revise(created.value.id, {
      title: '완료 후 수정',
      note: '완료 memo',
      externalOrderRef: 'external-2',
    });
    expect(metadata).toEqual({
      ok: true,
      value: expect.objectContaining({
        title: '완료 후 수정',
        status: 'fully_received',
        note: '완료 memo',
        external_order_ref: 'external-2',
      }),
    });
  });

  it('deletes only an unreceived draft and rejects received rows even when deleted', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('delete 원두');
    const deletable = await module.createDraft({ title: '삭제 가능', note: null });
    if (!deletable.ok) throw new Error('expected creation success');
    await expect(module.deleteDraft(deletable.value.id)).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });

    const blocked = await module.createDraftWithItems({
      title: '삭제 충돌',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!blocked.ok) throw new Error('expected creation success');
    await env.DB.prepare(
      `UPDATE order_items
          SET received_qty = 1, is_deleted = 1, deleted_at = datetime('now')
        WHERE order_id = ?`,
    ).bind(blocked.value.id).run();
    await expect(module.deleteDraft(blocked.value.id)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: 'conflict',
        code: 'ORDER_DELETE_CONFLICT',
      }),
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify the new methods fail**

Run: `npx vitest run test/purchase-orders.integration.test.ts`

Expected: FAIL because `revise` and `deleteDraft` are absent from `PurchaseOrderModule`.

- [ ] **Step 3: Extend the interface and move revision behavior**

Add the signatures from the approved spec and copy the current PATCH handler implementation into `revise`. Apply this exact mapping:

```ts
type PurchaseOrderRevision = {
  title?: string;
  note?: string | null;
  externalOrderRef?: string | null;
  requestedStatus?: string;
};

export interface PurchaseOrderModule {
  revise(
    orderId: number,
    change: PurchaseOrderRevision,
  ): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  deleteDraft(
    orderId: number,
  ): Promise<PurchaseOrderResult<{ deleted: true }>>;
}
```

- Build patches only when the corresponding optional property is present.
- Map `externalOrderRef` to `external_order_ref` and `requestedStatus` to `status` internally.
- Preserve metadata-only revision in every active status.
- Preserve combined metadata and status in one update and one Purchase Order `update` audit fact.
- Preserve same-status behavior for `draft`, `ordered`, and `canceled`, including the active-item predicate for `ordered`, no `order_date` reset, received-row predicate for `canceled`, and audit insertion.
- Reject requested `partially_received` and `fully_received` before comparing the previous status.
- Preserve conditional status predicate, `changes()` conflict mapping, exact Korean messages, before full row JSON, and current after field set.

- [ ] **Step 4: Move draft deletion behavior**

Copy the current DELETE handler into `deleteDraft`, retaining all four statements and their order:

```text
1. cascade soft-delete active Order Items if the Purchase Order is still draft
2. soft-delete the Purchase Order and set its temporary creation_token
3. insert only the Purchase Order soft_delete audit fact
4. clear creation_token
```

Both conditional UPDATE statements must reject any Order Item with `received_qty > 0` without filtering by `is_deleted`. Return `ORDER_DELETE_CONFLICT` with the existing preflight or stale-write message as appropriate.

- [ ] **Step 5: Replace PATCH and DELETE handlers with adapters**

Keep path parsing and wire-field presence checks in Hono. Construct `PurchaseOrderRevision` only with fields present in the payload, then call:

```ts
return purchaseOrderResponse(
  c,
  await purchaseOrders(c.env.DB, actor.id).revise(orderId, change),
);
```

The DELETE adapter calls `deleteDraft(orderId)`. Remove all Purchase Order revision/deletion SQL from `src/index.ts`.

- [ ] **Step 6: Run targeted tests and typecheck**

Run: `npx vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit revision and deletion**

```bash
git add src/purchase-orders.ts src/index.ts test/purchase-orders.integration.test.ts
git commit -m 'refactor: move purchase order lifecycle mutations'
```

---

### Task 4: Move Draft Order Item Addition and Revision

**Files:**
- Modify: `src/purchase-orders.ts`
- Modify: `src/index.ts` handlers `POST /api/purchase-orders/:id/items` and `PATCH /api/purchase-orders/:id/items/:itemId`
- Modify: `test/purchase-orders.integration.test.ts`

**Interfaces:**
- Consumes: Task 2/3 factory, Result helpers, `OrderItemInput`, `OrderItemRow`.
- Produces: `addItemsToDraft(orderId, items)` and `editDraftItem(orderId, orderItemId, change)`.

- [ ] **Step 1: Write failing Order Item tests**

Append:

```ts
describe('Purchase Order module draft items', () => {
  it('adds, merges, returns all active rows, clears existing memo, and revises an item', async () => {
    const { module } = await createActor();
    const firstItemId = await createInventoryItem('item 원두');
    const secondItemId = await createInventoryItem('item 우유');
    const draft = await module.createDraft({ title: 'item 초안', note: null });
    if (!draft.ok) throw new Error('expected creation success');

    const added = await module.addItemsToDraft(draft.value.id, [
      { itemId: firstItemId, orderedQty: 1, memo: '첫 memo' },
      { itemId: firstItemId, orderedQty: 2, memo: '' },
      { itemId: secondItemId, orderedQty: 1, memo: '우유 memo' },
    ]);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('expected add success');
    expect(added.value.items).toHaveLength(2);
    const first = added.value.items.find((row) => row.item_id === firstItemId);
    expect(first).toEqual(expect.objectContaining({ ordered_qty: 3, memo: '첫 memo' }));

    const cleared = await module.addItemsToDraft(draft.value.id, [
      { itemId: firstItemId, orderedQty: 1, memo: null },
    ]);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected clear memo success');
    const clearedFirst = cleared.value.items.find((row) => row.item_id === firstItemId);
    expect(clearedFirst).toEqual(expect.objectContaining({ ordered_qty: 4, memo: null }));

    const revised = await module.editDraftItem(draft.value.id, first!.id, {
      orderedQty: 5,
      memo: '수정 memo',
    });
    expect(revised).toEqual({
      ok: true,
      value: expect.objectContaining({ ordered_qty: 5, memo: '수정 memo' }),
    });
  });

  it('rejects item changes after confirmation', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('confirmed 원두');
    const draft = await module.createDraftWithItems({
      title: 'confirmed 발주',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!draft.ok) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    await module.revise(draft.value.id, { requestedStatus: 'ordered' });

    const added = await module.addItemsToDraft(draft.value.id, [
      { itemId, orderedQty: 1, memo: null },
    ]);
    expect(added).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_STATUS' }),
    });
    const edited = await module.editDraftItem(
      draft.value.id,
      detail.value.items[0].id,
      { orderedQty: 2 },
    );
    expect(edited).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_STATUS' }),
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify the methods are absent**

Run: `npx vitest run test/purchase-orders.integration.test.ts`

Expected: FAIL because `addItemsToDraft` and `editDraftItem` do not exist.

- [ ] **Step 3: Move add-item behavior into the deep module**

Extend the public interface first:

```ts
export type OrderItemRevision = {
  orderedQty?: number;
  memo?: string | null;
};

export interface PurchaseOrderModule {
  addItemsToDraft(
    orderId: number,
    items: readonly OrderItemInput[],
  ): Promise<PurchaseOrderResult<{ items: OrderItemRow[] }>>;
  editDraftItem(
    orderId: number,
    orderItemId: number,
    change: OrderItemRevision,
  ): Promise<PurchaseOrderResult<OrderItemRow>>;
}
```

Copy the current add-items handler implementation and preserve its operation-specific merge exactly:

```ts
const mergedRows = rows.reduce<Map<number, { orderedQty: number; memo: string | null }>>(
  (acc, row) => {
    const current = acc.get(row.itemId);
    acc.set(row.itemId, {
      orderedQty: (current?.orderedQty ?? 0) + row.orderedQty,
      memo: row.memo || current?.memo || null,
    });
    return acc;
  },
  new Map(),
);
```

Keep active-item validation, existing-row lookup, temporary Purchase Order token, update/create-specific audit facts, broad D1 conflict mapping, and token cleanup. The success select must return every active Order Item for the Purchase Order and must not add an ordering guarantee.

- [ ] **Step 4: Move item revision behavior**

Add `OrderItemRevision` and move the current item PATCH logic. Preserve field presence, positive quantity, `ordered_qty >= received_qty`, draft predicate inside the batch, before/after audit facts, token cleanup, stale-write conflict, and exact public row shape.

- [ ] **Step 5: Replace both Hono handlers with wire adapters**

The add adapter continues accepting a single row, an array, or `{ items }`. It rejects malformed row objects and failed numeric coercion before calling the module, but passes zero/negative integers to the module for semantic validation. The item revision adapter maps `ordered_qty` to `orderedQty` only when present and passes explicit `memo: null` through unchanged.

Use `purchaseOrderResponse` for both module results and delete their D1 SQL from `src/index.ts`.

- [ ] **Step 6: Run targeted tests and typecheck**

Run: `npx vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit Order Item mutations**

```bash
git add src/purchase-orders.ts src/index.ts test/purchase-orders.integration.test.ts
git commit -m 'refactor: move draft order item mutations'
```

---

### Task 5: Move Partial Receipt and Its Cross-Table Atomicity

**Files:**
- Modify: `src/purchase-orders.ts`
- Modify: `src/index.ts` handler `POST /api/purchase-orders/:id/items/:itemId/receive`
- Modify: `test/purchase-orders.integration.test.ts`

**Interfaces:**
- Consumes: complete draft/revision/item module from Tasks 2-4.
- Produces: `receive(orderId, orderItemId, receipt)` and final `PurchaseOrderModule` interface.

- [ ] **Step 1: Write a failing concurrency and ledger test**

Append:

```ts
describe('Purchase Order module partial receipt', () => {
  it('allows one concurrent receipt and keeps stock, ledger, status, and audit aligned', async () => {
    const { actorUserId, module } = await createActor();
    const itemId = await createInventoryItem('receive 원두');
    const draft = await module.createDraftWithItems({
      title: 'receive 발주',
      note: null,
      items: [{ itemId, orderedQty: 5, memo: null }],
    });
    if (!draft.ok) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    const orderItemId = detail.value.items[0].id;
    await module.revise(draft.value.id, { requestedStatus: 'ordered' });

    const receive = () => module.receive(draft.value.id, orderItemId, {
      quantity: 4,
      note: null,
    });
    const results = await Promise.all([receive(), receive()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'RECEIVE_CONFLICT' }),
      }),
    ]);

    const item = await env.DB.prepare(
      `SELECT current_stock FROM items WHERE id = ?`,
    ).bind(itemId).first<{ current_stock: number }>();
    expect(item?.current_stock).toBe(4);
    const ledger = await env.DB.prepare(
      `SELECT quantity, reason, order_item_id, operation_token
         FROM stock_transactions WHERE item_id = ?`,
    ).bind(itemId).all<{
      quantity: number;
      reason: string;
      order_item_id: number;
      operation_token: string | null;
    }>();
    expect(ledger.results).toEqual([
      expect.objectContaining({
        quantity: 4,
        reason: '부분입고 처리',
        order_item_id: orderItemId,
      }),
    ]);
    expect(ledger.results[0].operation_token).not.toBeNull();

    const after = await module.getDetail(draft.value.id);
    expect(after).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: 'partially_received',
        items: [expect.objectContaining({ received_qty: 4, remaining_qty: 1 })],
      }),
    });
    const audit = await env.DB.prepare(
      `SELECT action, entity_type, actor_user_id, before_json, after_json
         FROM audit_logs
        WHERE action = 'receive' AND entity_type = 'order_item'`,
    ).all();
    expect(audit.results).toEqual([
      expect.objectContaining({
        actor_user_id: actorUserId,
        before_json: JSON.stringify({
          id: orderItemId,
          item_id: itemId,
          ordered_qty: 5,
          received_qty: 0,
        }),
        after_json: JSON.stringify({
          id: orderItemId,
          item_id: itemId,
          ordered_qty: 5,
          received_qty: 4,
        }),
      }),
    ]);
  });
});
```

- [ ] **Step 2: Write a failing audit-rollback test**

Add another test:

```ts
it('rolls back receipt stock and quantities when receive audit insertion fails', async () => {
  const { module } = await createActor();
  const itemId = await createInventoryItem('rollback receive 원두');
  const draft = await module.createDraftWithItems({
    title: 'rollback receive 발주',
    note: null,
    items: [{ itemId, orderedQty: 2, memo: null }],
  });
  if (!draft.ok) throw new Error('expected creation success');
  const detail = await module.getDetail(draft.value.id);
  if (!detail.ok) throw new Error('expected detail success');
  await module.revise(draft.value.id, { requestedStatus: 'ordered' });

  await env.DB.prepare(
    `CREATE TRIGGER test_fail_receive_audit
     BEFORE INSERT ON audit_logs
     WHEN NEW.action = 'receive'
     BEGIN
       SELECT RAISE(ABORT, 'TEST_RECEIVE_AUDIT_FAILURE');
     END`,
  ).run();
  try {
    const received = await module.receive(
      draft.value.id,
      detail.value.items[0].id,
      { quantity: 1, note: '' },
    );
    expect(received).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'conflict', code: 'RECEIVE_CONFLICT' }),
    });
  } finally {
    await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_receive_audit').run();
  }

  const item = await env.DB.prepare(
    `SELECT current_stock FROM items WHERE id = ?`,
  ).bind(itemId).first<{ current_stock: number }>();
  expect(item?.current_stock).toBe(0);
  const orderItem = await env.DB.prepare(
    `SELECT received_qty FROM order_items WHERE id = ?`,
  ).bind(detail.value.items[0].id).first<{ received_qty: number }>();
  expect(orderItem?.received_qty).toBe(0);
  const ledgerCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM stock_transactions WHERE item_id = ?`,
  ).bind(itemId).first<{ count: number }>();
  expect(Number(ledgerCount?.count ?? 0)).toBe(0);
});
```

- [ ] **Step 3: Run the tests to verify receipt is absent**

Run: `npx vitest run test/purchase-orders.integration.test.ts`

Expected: FAIL because `receive` does not exist.

- [ ] **Step 4: Move the five-statement receipt batch**

Extend the public types and final interface:

```ts
export type PartialReceiptInput = {
  quantity: number;
  note?: string | null;
};

export type PartialReceiptResult = {
  order: PurchaseOrderRow;
  order_item: Pick<
    OrderItemRow,
    'id' | 'item_id' | 'ordered_qty' | 'received_qty' | 'memo'
  >;
};

export interface PurchaseOrderModule {
  receive(
    orderId: number,
    orderItemId: number,
    receipt: PartialReceiptInput,
  ): Promise<PurchaseOrderResult<PartialReceiptResult>>;
}
```

Move the current receive handler implementation into `PurchaseOrderModule.receive`. Preserve this exact order and token dependency:

```text
1. conditionally INSERT the IN stock transaction with operation_token
2. UPDATE Order Item received_qty only when that token exists
3. UPDATE inventory current_stock only when that token exists
4. derive Purchase Order status only when that token exists
5. INSERT the receive audit fact by joining the stock transaction token
```

Keep all current preflight messages. Map omitted or null `note` to `부분입고 처리`; preserve empty string. Do not clear `operation_token`. A zero-row first statement returns `RECEIVE_CONFLICT` with `남은 입고 수량 또는 발주 상태가 변경되었습니다.`. Any thrown D1 batch error returns `RECEIVE_CONFLICT` with `입고 처리 중 상태가 변경되었습니다. 다시 시도해주세요.`. Reselect the unchanged public order and order-item shapes after success.

- [ ] **Step 5: Replace the receive Hono handler**

Keep invalid path ID and quantity coercion in the adapter. Pass positive and nonpositive integers to the module for semantic validation. Preserve explicit null and empty note values:

```ts
return purchaseOrderResponse(
  c,
  await purchaseOrders(c.env.DB, actor.id).receive(orderId, orderItemId, {
    quantity: qty,
    note: payload.note == null ? null : String(payload.note),
  }),
);
```

Delete the receipt SQL and state logic from `src/index.ts`.

- [ ] **Step 6: Run targeted tests and typecheck**

Run: `npx vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit partial receipt**

```bash
git add src/purchase-orders.ts src/index.ts test/purchase-orders.integration.test.ts
git commit -m 'refactor: move purchase order receipt lifecycle'
```

---

### Task 6: Remove Legacy Lifecycle Code and Run Full Verification

**Files:**
- Modify: `src/index.ts`
- Modify: `src/purchase-orders.ts`
- Modify: `test/api.integration.test.ts`
- Modify: `test/purchase-orders.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-12-purchase-order-lifecycle-refactor-design.md`
- Modify: `docs/superpowers/plans/2026-07-12-purchase-order-lifecycle-refactor.md`

**Interfaces:**
- Consumes: complete `PurchaseOrderModule` from Tasks 2-5.
- Produces: final thin lifecycle/detail adapters, one deep module, full green verification, no legacy duplicate implementation.

- [ ] **Step 1: Add focused adapter error-mapping assertions**

Extend `test/api.integration.test.ts` so at least one route covers each Result kind and the global failure path:

```ts
it('maps Purchase Order invalid, not-found, and conflict results to existing envelopes', async () => {
  const sessionToken = await createSession();
  const invalid = await apiRequest('/api/purchase-orders', sessionToken, {
    method: 'POST',
    body: JSON.stringify({ title: '' }),
  });
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toEqual({
    ok: false,
    error: { code: 'INVALID_INPUT', message: '발주명은 필수입니다.' },
  });

  const missing = await apiRequest('/api/purchase-orders/999999', sessionToken);
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({
    ok: false,
    error: { code: 'NOT_FOUND', message: '발주서를 찾지 못했습니다.' },
  });

  const order = await env.DB.prepare(
    `INSERT INTO purchase_orders (title, status) VALUES (?, 'ordered')`,
  ).bind('삭제 conflict').run();
  const conflict = await apiRequest(
    `/api/purchase-orders/${order.meta.last_row_id}`,
    sessionToken,
    { method: 'DELETE' },
  );
  expect(conflict.status).toBe(409);
  await expect(conflict.json()).resolves.toEqual({
    ok: false,
    error: {
      code: 'ORDER_DELETE_CONFLICT',
      message: '확정되었거나 입고가 시작된 발주서는 삭제할 수 없습니다.',
    },
  });
});

it('keeps unexpected Purchase Order D1 failures on the global 500 envelope', async () => {
  const sessionToken = await createSession();
  const order = await env.DB.prepare(
    `INSERT INTO purchase_orders (title, status) VALUES (?, 'draft')`,
  ).bind('unexpected failure').run();
  await env.DB.prepare(
    'DROP TRIGGER IF EXISTS test_fail_purchase_order_update',
  ).run();

  try {
    await env.DB.prepare(
      `CREATE TRIGGER test_fail_purchase_order_update
       BEFORE UPDATE ON purchase_orders
       WHEN NEW.title = 'trigger-500'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_PURCHASE_ORDER_UPDATE_FAILURE');
       END`,
    ).run();

    const response = await apiRequest(
      `/api/purchase-orders/${order.meta.last_row_id}`,
      sessionToken,
      { method: 'PATCH', body: JSON.stringify({ title: 'trigger-500' }) },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '서버 오류가 발생했습니다.',
      },
    });
  } finally {
    await env.DB.prepare(
      'DROP TRIGGER IF EXISTS test_fail_purchase_order_update',
    ).run();
  }
});
```

- [ ] **Step 2: Run the focused tests before cleanup**

Run: `npx vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Delete legacy symbols and verify the seam**

Export `isPurchaseOrderStatus` from `src/purchase-orders.ts` and use it for list and PATCH validation. Then remove local `OrderStatus`, `ORDER_STATUSES`, `ORDER_PUBLIC_COLUMNS`, `isOrderStatus`, and caller-free `writeAudit` from `src/index.ts`. Keep used `auditStatement`, `GET /api/purchase-orders`, and its list SQL unchanged.

Run these structural checks:

```bash
! rg -n "type OrderStatus|ORDER_PUBLIC_COLUMNS|ORDER_STATUSES|isOrderStatus|writeAudit" src/index.ts
! rg -n "RECEIVE_CONFLICT|ORDER_DELETE_CONFLICT" src/index.ts
! rg -U -n "(?s)(INSERT INTO|UPDATE|DELETE FROM)\s+(purchase_orders|order_items)" src/index.ts
rg -n "app\.(get|post|patch|delete)\('/api/purchase-orders" src/index.ts
test $(rg -c "app\.(post|patch|delete)\('/api/purchase-orders" src/index.ts) -eq 7
test $(rg -c "app\.get\('/api/purchase-orders/:id'" src/index.ts) -eq 1
test "$(rg -c 'purchaseOrders\(c\.env\.DB' src/index.ts)" -eq 8
test "$(rg -c 'stage(AddItemsToDraft|EditDraftItem|Receive)' src/index.ts)" -eq 3
test "$(rg -c 'stage\.value\.execute' src/index.ts)" -eq 3
test "$(rg -c 'purchaseOrderResponse\(' src/index.ts)" -eq 11
rg -n "app\.get\('/api/purchase-orders'|SELECT po\.id, po\.title, po\.status" src/index.ts
rg -n "creation_token|operation_token|RECEIVE_CONFLICT|ORDER_DELETE_CONFLICT" src/purchase-orders.ts
```

Expected:

- The first three commands return no matches after local legacy symbols, lifecycle failures, and Purchase Order/Order Item mutation SQL move out of `src/index.ts`.
- The route command lists the retained list route, GET detail, and all seven mutation routes.
- The count assertions prove five flat adapters plus three staged adapter entry calls, all three staged executors, and all shared Result serializer calls. The approved two-phase stage protocol is not duplicate lifecycle implementation.
- The list check finds the unchanged projection in `src/index.ts`; the final check finds lifecycle token and failure implementation in `src/purchase-orders.ts`.

- [ ] **Step 4: Run all repository verification gates**

Run each command independently and require exit 0:

```bash
npm run db:migrate
npm test
npm run typecheck
npm run build
npm run web:lint
npm run web:build
npm run build:cloudflare --prefix frontend
```

Expected:

- Node tests: all pass.
- Vitest: both integration files pass with zero failures.
- TypeScript: zero errors.
- Worker dry-run: exit 0.
- Frontend lint/build/OpenNext build: exit 0.
- Local migrations: all migrations applied or already up to date.

- [ ] **Step 5: Review the final diff against the approved spec**

Run:

```bash
git diff --check
git status --short
git status --short --ignored
git diff -- src/index.ts src/purchase-orders.ts test/api.integration.test.ts test/purchase-orders.integration.test.ts docs/superpowers/specs/2026-07-12-purchase-order-lifecycle-refactor-design.md docs/superpowers/plans/2026-07-12-purchase-order-lifecycle-refactor.md
```

Confirm all of the following before committing:

- No migration, schema, frontend implementation, HTTP path, payload, response, or message changed.
- The list projection remains in `src/index.ts`.
- Every lifecycle/detail route is a thin adapter; add/edit/receive use only the approved stage plus executor compatibility protocol.
- Every expected failure is a Result and unexpected failures still reach `app.onError`.
- `creation_token` is cleared and `operation_token` persists.
- Audit JSON fields match characterization fixtures.
- No generic repository, transaction primitive, clock, UUID, or audit port exists.
- Ignored `.superpowers`, `.wrangler`, `.next`, `.open-next`, dependency, and generated build state is inspected separately and not cleaned or committed.

- [ ] **Step 6: Commit final cleanup**

```bash
git add src/index.ts src/purchase-orders.ts test/api.integration.test.ts test/purchase-orders.integration.test.ts docs/superpowers/specs/2026-07-12-purchase-order-lifecycle-refactor-design.md docs/superpowers/plans/2026-07-12-purchase-order-lifecycle-refactor.md
git commit -m 'refactor: complete purchase order lifecycle module'
```

---

## Spec Coverage Map

| Approved requirement | Implemented and verified by |
| --- | --- |
| Thin lifecycle/detail adapters; list projection retained | Tasks 2-6 |
| Intent-named Result interface | Task 2, extended Tasks 3-5 |
| Plain/populated draft and duplicate merge | Tasks 1-2 |
| Metadata/status atomic revision and same-status behavior | Tasks 1 and 3 |
| Draft delete including deleted received rows | Tasks 1 and 3 |
| Draft-only Order Item add/edit and memo quirks | Tasks 1 and 4 |
| Partial receipt, ledger reason, persistent operation token | Tasks 1 and 5 |
| Concurrency and audit rollback | Task 5 |
| Exact HTTP envelopes and statuses | Tasks 1, 2-6 |
| Audit JSON compatibility | Tasks 1, 3-5 |
| No schema/frontend behavior change | Global constraints and Task 6 |
| Full repository/CI-parity verification | Task 6 |
