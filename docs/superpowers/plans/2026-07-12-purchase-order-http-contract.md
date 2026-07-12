# Purchase Order HTTP Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce an executable, portable Purchase Order HTTP Contract Module used by the Worker producer and browser consumer, while correcting the detail-total, create-payload, and nullable-readback drift found on `main`.

**Architecture:** Add a private local package, `@here-is-order/http-contract`, containing Zod runtime schemas, inferred wire types, envelope decoding, route patterns, and browser path builders for Purchase Orders only. Hono keeps legacy request coercion and validation precedence in its Adapter, but validates every successful Purchase Order projection before serialization. The browser fetch Adapter validates envelopes and endpoint data before returning them to the four Purchase Order views.

**Tech Stack:** TypeScript 5.x, Zod 3.24.1, Hono 4, Next.js 16, Vitest 4, Cloudflare Workers/D1.

## Global Constraints

- Preserve every existing HTTP status, error code, Korean error message, request coercion rule, validation order, nullable success race, D1 batch, audit fact, and Purchase Order lifecycle invariant unless this plan explicitly adds detail totals.
- `GET /api/purchase-orders/:id` must add top-level `ordered_qty` and `received_qty`, each equal to the sum across active detail items; this is an additive wire change.
- Runtime validation is limited to Purchase Order success projections and decoded browser responses in this delivery; non-Purchase-Order endpoints remain unchanged.
- The portable Contract Module must not import Hono, React, Next.js, Cloudflare bindings, Node-only modules, or browser globals.
- The portable `RuntimeSchema<T>` Interface exposes only `parse(input: unknown): T`; Zod remains private to the Contract Module Implementation so different consumer Zod versions cannot expand across the public type boundary.
- Preserve both npm lockfiles. The frontend must install the external local package as packed content with `install-links=true`, not as an out-of-root symlink.
- Do not introduce a generic D1 repository, clock, UUID, audit, or fetch Interface.
- Use 2-space indentation, single quotes, and semicolons in TypeScript.
- Follow RED → GREEN → REFACTOR for every behavior change, and record the failing and passing command in the task report.
- Every commit message must follow Conventional Commits.

---

### Task 1: Add canonical detail totals at the Purchase Order Module Interface

**Files:**
- Modify: `test/purchase-orders.integration.test.ts`
- Modify: `src/purchase-orders.ts:57-68, 344-365`

**Interfaces:**
- Consumes: existing `PurchaseOrderModule.getDetail(orderId)`.
- Produces: `PurchaseOrderDetail` with required numeric `ordered_qty` and `received_qty` fields derived from its active `items` rows.

- [x] **Step 1: Write the failing detail-total assertion**

In the existing test `atomically merges populated draft rows and preserves create memo precedence`, extend the detail assertion exactly as follows:

```ts
expect(detail).toEqual({
  ok: true,
  value: expect.objectContaining({
    ordered_qty: 3,
    received_qty: 0,
    items: [expect.objectContaining({ item_id: itemId, ordered_qty: 3, memo: '' })],
  }),
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/purchase-orders.integration.test.ts -t "atomically merges populated draft rows"
```

Expected: FAIL because `value.ordered_qty` and `value.received_qty` are absent.

- [x] **Step 3: Add totals to the detail projection**

Extend the exported type and the return value from `getDetail`:

```ts
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
```

After reading `items`, calculate totals only from those active rows and return them with the order:

```ts
const orderedQty = items.reduce((sum, item) => sum + Number(item.ordered_qty), 0);
const receivedQty = items.reduce((sum, item) => sum + Number(item.received_qty), 0);

return success({
  ...(order as PurchaseOrderRow),
  ordered_qty: orderedQty,
  received_qty: receivedQty,
  items,
});
```

- [x] **Step 4: Verify GREEN and the direct Module suite**

Run:

```bash
npx vitest run test/purchase-orders.integration.test.ts
```

Expected: 17 tests pass.

- [x] **Step 5: Commit the independently observable wire fix**

```bash
git add src/purchase-orders.ts test/purchase-orders.integration.test.ts
git commit -m "fix: include totals in purchase order details"
```

---

### Task 2: Create the portable executable Contract Module

**Files:**
- Create: `packages/http-contract/package.json`
- Create: `packages/http-contract/src/envelope.ts`
- Create: `packages/http-contract/src/purchase-orders.ts`
- Create: `test/http-contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the Purchase Order wire projections documented in `docs/design/api-spec-v1.md` plus the detail totals from Task 1.
- Produces: `RuntimeSchema<T>`, `decodeApiEnvelope`, Purchase Order schemas/types, `purchaseOrderRoutePatterns`, and `purchaseOrderPaths`.

- [x] **Step 1: Write the failing Contract Module tests**

Create `test/http-contract.test.ts` with these behaviors:

```ts
import { describe, expect, it } from 'vitest';
import { decodeApiEnvelope } from '../packages/http-contract/src/envelope';
import {
  createPurchaseOrderWithItemsRequestSchema,
  purchaseOrderDetailSchema,
  purchaseOrderPaths,
  purchaseOrderRowResultSchema,
  purchaseOrderSummaryListSchema,
} from '../packages/http-contract/src/purchase-orders';

const orderRow = {
  id: 7,
  title: '원두 발주',
  status: 'draft',
  order_date: '2026-07-12',
  external_order_ref: null,
  note: null,
  is_deleted: 0,
  deleted_at: null,
  created_at: '2026-07-12 10:00:00',
  updated_at: '2026-07-12 10:00:00',
} as const;

describe('Purchase Order executable HTTP contract', () => {
  it('decodes exact summary and detail projections', () => {
    expect(purchaseOrderSummaryListSchema.parse([{
      id: orderRow.id,
      title: orderRow.title,
      status: orderRow.status,
      order_date: orderRow.order_date,
      external_order_ref: orderRow.external_order_ref,
      note: orderRow.note,
      created_at: orderRow.created_at,
      updated_at: orderRow.updated_at,
      ordered_qty: 3,
      received_qty: 1,
    }]))
      .toHaveLength(1);
    expect(purchaseOrderDetailSchema.parse({
      ...orderRow,
      ordered_qty: 3,
      received_qty: 1,
      items: [{
        id: 11,
        item_id: 2,
        item_name: '원두',
        spec: null,
        ordered_qty: 3,
        received_qty: 1,
        remaining_qty: 2,
        memo: null,
      }],
    }).received_qty).toBe(1);
  });

  it('rejects malformed success data and accepts documented nullable readbacks', () => {
    expect(() => decodeApiEnvelope(purchaseOrderDetailSchema, {
      ok: true,
      data: { ...orderRow, ordered_qty: 0, received_qty: 0 },
    })).toThrow();
    expect(decodeApiEnvelope(purchaseOrderRowResultSchema, { ok: true, data: null }))
      .toEqual({ ok: true, data: null });
  });

  it('rejects populated draft requests without title', () => {
    expect(createPurchaseOrderWithItemsRequestSchema.safeParse({
      items: [{ item_id: 2, ordered_qty: 3, memo: null }],
    }).success).toBe(false);
  });

  it('owns browser paths and validates positive identifiers', () => {
    expect(purchaseOrderPaths.detail(7)).toBe('/api/purchase-orders/7');
    expect(purchaseOrderPaths.item(7, 11)).toBe('/api/purchase-orders/7/items/11');
    expect(purchaseOrderPaths.receive(7, 11)).toBe('/api/purchase-orders/7/items/11/receive');
    expect(() => purchaseOrderPaths.detail(0)).toThrow('positive integer');
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/http-contract.test.ts
```

Expected: FAIL because the portable package modules do not exist.

- [x] **Step 3: Add the local package metadata and dependency**

Create `packages/http-contract/package.json`:

```json
{
  "name": "@here-is-order/http-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./envelope": "./src/envelope.ts",
    "./purchase-orders": "./src/purchase-orders.ts"
  },
  "dependencies": {
    "zod": "3.24.1"
  }
}
```

Install it in the Worker project so `package.json` and `package-lock.json` record the local package:

```bash
npm install ./packages/http-contract
```

- [x] **Step 4: Implement exact envelope decoding**

Create `packages/http-contract/src/envelope.ts`:

```ts
import { z } from 'zod';

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
}

export const apiErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
}).strict();

export const apiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: apiErrorPayloadSchema,
}).strict();

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type ApiSuccessEnvelope<T> = { ok: true; data: T };
export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

const rawApiEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  apiErrorEnvelopeSchema,
]);

export function apiEnvelopeSchema<T>(dataSchema: RuntimeSchema<T>): RuntimeSchema<ApiEnvelope<T>> {
  return {
    parse(input: unknown): ApiEnvelope<T> {
      const envelope = rawApiEnvelopeSchema.parse(input);
      if (!envelope.ok) {
        return envelope;
      }
      return { ok: true, data: dataSchema.parse(envelope.data) };
    },
  };
}

export function decodeApiEnvelope<T>(
  dataSchema: RuntimeSchema<T>,
  input: unknown,
): ApiEnvelope<T> {
  return apiEnvelopeSchema(dataSchema).parse(input);
}
```

- [x] **Step 5: Implement Purchase Order paths, schemas, and inferred types**

Create `packages/http-contract/src/purchase-orders.ts` with strict schemas for:

```ts
import { z } from 'zod';

const positiveId = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

export const purchaseOrderStatusSchema = z.enum([
  'draft',
  'ordered',
  'partially_received',
  'fully_received',
  'canceled',
]);

export const purchaseOrderRowSchema = z.object({
  id: positiveId,
  title: z.string(),
  status: purchaseOrderStatusSchema,
  order_date: z.string(),
  external_order_ref: z.string().nullable(),
  note: z.string().nullable(),
  is_deleted: z.number().int().min(0).max(1),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const purchaseOrderSummarySchema = purchaseOrderRowSchema.omit({
  is_deleted: true,
  deleted_at: true,
}).extend({
  ordered_qty: nonNegativeInteger,
  received_qty: nonNegativeInteger,
}).strict();

export const purchaseOrderDetailItemSchema = z.object({
  id: positiveId,
  item_id: positiveId,
  item_name: z.string().nullable(),
  spec: z.string().nullable(),
  ordered_qty: positiveId,
  received_qty: nonNegativeInteger,
  remaining_qty: z.number().int(),
  memo: z.string().nullable(),
}).strict();

export const purchaseOrderDetailSchema = purchaseOrderRowSchema.extend({
  ordered_qty: nonNegativeInteger,
  received_qty: nonNegativeInteger,
  items: z.array(purchaseOrderDetailItemSchema),
}).strict().superRefine((detail, context) => {
  const ordered = detail.items.reduce((sum, item) => sum + item.ordered_qty, 0);
  const received = detail.items.reduce((sum, item) => sum + item.received_qty, 0);
  if (detail.ordered_qty !== ordered) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ordered_qty'], message: 'detail total mismatch' });
  }
  if (detail.received_qty !== received) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['received_qty'], message: 'detail total mismatch' });
  }
});

export const purchaseOrderItemInputSchema = z.object({
  item_id: positiveId,
  ordered_qty: positiveId,
  memo: z.string().nullable(),
}).strict();

export const createPurchaseOrderRequestSchema = z.object({
  title: z.string().trim().min(1),
  note: z.string().nullable().optional(),
  status: z.literal('draft').optional(),
}).strict();

export const createPurchaseOrderWithItemsRequestSchema = z.object({
  title: z.string().trim().min(1),
  note: z.string().nullable().optional(),
  items: z.array(purchaseOrderItemInputSchema).min(1),
}).strict();
```

Continue the same file with the remaining request/result schemas, inferred types, route patterns, and positive-integer browser path builders:

```ts
export const purchaseOrderSummaryListSchema = z.array(purchaseOrderSummarySchema);
export const purchaseOrderRowResultSchema = purchaseOrderRowSchema.nullable();

export const purchaseOrderItemRowSchema = z.object({
  id: positiveId,
  order_id: positiveId,
  item_id: positiveId,
  ordered_qty: positiveId,
  received_qty: nonNegativeInteger,
  memo: z.string().nullable(),
}).strict();

export const receivedPurchaseOrderItemSchema = purchaseOrderItemRowSchema.omit({
  order_id: true,
}).strict();

export const deletePurchaseOrderResultSchema = z.object({
  deleted: z.literal(true),
}).strict();

export const addPurchaseOrderItemsResultSchema = z.object({
  items: z.array(purchaseOrderItemRowSchema),
}).strict();

export const editPurchaseOrderItemResultSchema = purchaseOrderItemRowSchema.nullable();

export const receivePurchaseOrderItemResultSchema = z.object({
  order: purchaseOrderRowResultSchema,
  order_item: receivedPurchaseOrderItemSchema.nullable(),
}).strict();

export const revisePurchaseOrderRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  note: z.string().nullable().optional(),
  external_order_ref: z.string().nullable().optional(),
  status: z.enum(['draft', 'ordered', 'canceled']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'at least one field is required',
});

export const addPurchaseOrderItemsRequestSchema = z.object({
  items: z.array(purchaseOrderItemInputSchema).min(1),
}).strict();

export const editPurchaseOrderItemRequestSchema = z.object({
  ordered_qty: positiveId.optional(),
  memo: z.string().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'at least one field is required',
});

export const receivePurchaseOrderItemRequestSchema = z.object({
  qty: positiveId,
  note: z.string().optional(),
}).strict();

export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;
export type PurchaseOrderRow = z.infer<typeof purchaseOrderRowSchema>;
export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummarySchema>;
export type PurchaseOrderDetailItem = z.infer<typeof purchaseOrderDetailItemSchema>;
export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetailSchema>;
export type PurchaseOrderItemRow = z.infer<typeof purchaseOrderItemRowSchema>;
export type ReceivedPurchaseOrderItem = z.infer<typeof receivedPurchaseOrderItemSchema>;
export type PurchaseOrderItemInput = z.infer<typeof purchaseOrderItemInputSchema>;
export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderRequestSchema>;
export type CreatePurchaseOrderWithItemsRequest = z.infer<typeof createPurchaseOrderWithItemsRequestSchema>;
export type RevisePurchaseOrderRequest = z.infer<typeof revisePurchaseOrderRequestSchema>;
export type AddPurchaseOrderItemsRequest = z.infer<typeof addPurchaseOrderItemsRequestSchema>;
export type EditPurchaseOrderItemRequest = z.infer<typeof editPurchaseOrderItemRequestSchema>;
export type ReceivePurchaseOrderItemRequest = z.infer<typeof receivePurchaseOrderItemRequestSchema>;

export const purchaseOrderRoutePatterns = {
  collection: '/api/purchase-orders',
  withItems: '/api/purchase-orders/with-items',
  detail: '/api/purchase-orders/:id',
  items: '/api/purchase-orders/:id/items',
  item: '/api/purchase-orders/:id/items/:itemId',
  receive: '/api/purchase-orders/:id/items/:itemId/receive',
} as const;

function positivePathId(name: string, value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return String(value);
}

export const purchaseOrderPaths = {
  collection: purchaseOrderRoutePatterns.collection,
  withItems: purchaseOrderRoutePatterns.withItems,
  detail(orderId: number) {
    return `/api/purchase-orders/${positivePathId('orderId', orderId)}`;
  },
  items(orderId: number) {
    return `/api/purchase-orders/${positivePathId('orderId', orderId)}/items`;
  },
  item(orderId: number, orderItemId: number) {
    return `/api/purchase-orders/${positivePathId('orderId', orderId)}/items/${positivePathId('orderItemId', orderItemId)}`;
  },
  receive(orderId: number, orderItemId: number) {
    return `/api/purchase-orders/${positivePathId('orderId', orderId)}/items/${positivePathId('orderItemId', orderItemId)}/receive`;
  },
} as const;
```

- [x] **Step 6: Verify GREEN and type-check the portable source**

Run:

```bash
npx vitest run test/http-contract.test.ts
npm run typecheck
```

Expected: 4 contract tests pass and TypeScript exits 0.

- [x] **Step 7: Commit the portable Contract Module**

```bash
git add package.json package-lock.json packages/http-contract test/http-contract.test.ts
git commit -m "feat: add purchase order HTTP contracts"
```

---

### Task 3: Add a runtime-validating browser fetch Adapter

**Files:**
- Create: `frontend/vitest.config.ts`
- Create: `frontend/lib/api.test.ts`
- Create: `frontend/.npmrc`
- Modify: `frontend/lib/api.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/next.config.mjs`
- Modify: `packages/http-contract/src/envelope.ts`
- Modify: `.github/workflows/deploy-worker.yml`
- Modify: `scripts/deploy-workflow.test.mjs`

**Interfaces:**
- Consumes: `RuntimeSchema<T>` and `decodeApiEnvelope` from Task 2.
- Produces: `apiGetDecoded`, `apiPostDecoded`, `apiPatchDecoded`, and `apiDeleteDecoded`, each returning schema-inferred data or throwing `ApiError`.

- [x] **Step 1: Install frontend test support and the local package**

Run:

```bash
npm install --prefix frontend --save-dev vitest@^4.1.10
npm install --prefix frontend ../packages/http-contract
```

Add the script `"test": "vitest run"` to `frontend/package.json`. Create `frontend/vitest.config.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
```

- [x] **Step 2: Write failing browser Adapter tests**

Create `frontend/lib/api.test.ts` with a real `Response` and a stubbed network Seam:

```ts
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetDecoded } from '@/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('decoded browser HTTP Adapter', () => {
  it('returns data only after envelope and endpoint validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: 7 },
    }), { status: 200 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .resolves.toEqual({ id: 7 });
  });

  it('maps malformed success data to INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: '7' },
    }), { status: 200 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
  });

  it('preserves a valid error envelope and HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'CONFLICT', message: '상태가 변경되었습니다.' },
    }), { status: 409 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
        message: '상태가 변경되었습니다.',
      });
  });
});
```

- [x] **Step 3: Run frontend tests and verify RED**

Run:

```bash
npm run test --prefix frontend -- lib/api.test.ts
```

Expected: FAIL because `apiGetDecoded` is not exported.

- [x] **Step 4: Implement the decoded Adapter family**

Refactor `frontend/lib/api.ts` so the existing loose functions retain behavior and the decoded family uses `decodeApiEnvelope`. All four decoded functions must share one internal fetch/JSON reader. A malformed or non-JSON success must throw:

```ts
new ApiError('응답 계약이 올바르지 않습니다.', response.status, 'INVALID_RESPONSE')
```

A valid `{ ok: false, error }` envelope must preserve its message, code, and HTTP status. The public signatures are:

```ts
export function apiGetDecoded<T>(
  path: string,
  schema: RuntimeSchema<T>,
  signal?: AbortSignal,
): Promise<T>;

export function apiPostDecoded<T>(
  path: string,
  schema: RuntimeSchema<T>,
  body?: unknown,
): Promise<T>;

export function apiPatchDecoded<T>(
  path: string,
  schema: RuntimeSchema<T>,
  body?: unknown,
): Promise<T>;

export function apiDeleteDecoded<T>(
  path: string,
  schema: RuntimeSchema<T>,
): Promise<T>;
```

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm run test --prefix frontend
```

Expected: 3 tests pass.

- [x] **Step 6: Add the frontend test gate to CI with a failing workflow assertion first**

Extend `scripts/deploy-workflow.test.mjs` with a test asserting that `npm run test --prefix frontend` appears after `npm ci --prefix frontend` and before lint/build. Run:

```bash
node --test scripts/deploy-workflow.test.mjs
```

Expected: FAIL until `.github/workflows/deploy-worker.yml` includes a `Test web contract adapters` step immediately after frontend install. Add that workflow step and rerun until all deployment workflow tests pass.

- [x] **Step 7: Make the external local Contract Module buildable by Next and OpenNext**

Create `frontend/.npmrc` so npm installs the external directory dependency as packed package content instead of a symlink outside the frontend root:

```ini
install-links=true
```

Regenerate `frontend/package-lock.json` from the frontend project with install-links enabled. Add `transpilePackages: ['@here-is-order/http-contract']` to `frontend/next.config.mjs`, keep `turbopack.root` at the existing `frontendRoot`, and preserve every proxy-origin validation and rewrite.

Run a fresh install and prove the package is a real directory rather than a symlink:

```bash
npm ci --prefix frontend
test ! -L frontend/node_modules/@here-is-order/http-contract
test -f frontend/node_modules/@here-is-order/http-contract/src/envelope.ts
```

Then run:

```bash
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
```

Expected: both builds exit 0 and resolve `@here-is-order/http-contract` from packed content inside the frontend root, while OpenNext keeps its frontend output-tracing root.

- [x] **Step 8: Commit the browser Adapter and CI gate**

```bash
git add frontend/.npmrc frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/lib/api.ts frontend/lib/api.test.ts frontend/next.config.mjs packages/http-contract/src/envelope.ts .github/workflows/deploy-worker.yml scripts/deploy-workflow.test.mjs
git commit -m "test: validate browser HTTP contracts"
```

---

### Task 4: Connect Worker and browser Purchase Order Adapters to the Contract Module

**Files:**
- Modify: `src/index.ts:1-75, 1121-1407`
- Modify: `frontend/lib/types.ts:1-114`
- Modify: `frontend/app/(app)/orders/page.tsx`
- Modify: `frontend/app/(app)/orders/[id]/page.tsx`
- Modify: `frontend/app/(app)/dashboard/page.tsx`
- Modify: `test/api.integration.test.ts`

**Interfaces:**
- Consumes: every schema, inferred type, route pattern, browser path builder, and decoded fetch function produced in Tasks 2 and 3.
- Produces: runtime-validated Purchase Order success responses on both sides of the HTTP Seam, with exact legacy errors and parsing behavior preserved.

- [x] **Step 1: Extend the HTTP characterization test with the executable schema**

Import `purchaseOrderDetailSchema` in `test/api.integration.test.ts`. In the populated-detail characterization, decode `populatedDetail.data` and assert totals:

```ts
const decodedDetail = purchaseOrderDetailSchema.parse(populatedDetail.data);
expect(decodedDetail).toEqual(expect.objectContaining({
  ordered_qty: 3,
  received_qty: 0,
}));
```

Run:

```bash
npx vitest run test/api.integration.test.ts -t "생성과 추가의 memo 병합 차이"
```

Expected: PASS only if Task 1's additive wire contract is visible through Hono; this is a characterization gate before rewiring the Adapters.

- [x] **Step 2: Validate every Worker Purchase Order success projection**

Import `RuntimeSchema`, the exact success schemas, and `purchaseOrderRoutePatterns` into `src/index.ts`. Change `purchaseOrderResponse` to accept a `RuntimeSchema<T>` and call `schema.parse(result.value)` only on success. Supply the matching schema at every Purchase Order route and parse the list query result with `purchaseOrderSummaryListSchema` before `apiOk`.

Replace only the seven Purchase Order route literals with `purchaseOrderRoutePatterns`. Do not replace non-Purchase-Order routes and do not move raw request coercion into Zod.

- [x] **Step 3: Re-export canonical browser types**

Replace the local Purchase Order type declarations in `frontend/lib/types.ts` with aliases imported from `@here-is-order/http-contract/purchase-orders`:

```ts
import type {
  PurchaseOrderDetail as ContractPurchaseOrderDetail,
  PurchaseOrderDetailItem,
  PurchaseOrderItemInput,
  PurchaseOrderSummary,
} from '@here-is-order/http-contract/purchase-orders';

export type PurchaseOrder = PurchaseOrderSummary;
export type PurchaseOrderBatchItemPayload = PurchaseOrderItemInput;
export type PurchaseOrderItem = PurchaseOrderDetailItem;
export type PurchaseOrderDetail = ContractPurchaseOrderDetail;
```

Task 3 already configured Next and Turbopack to resolve and transpile the linked Contract Module; preserve that configuration.

- [x] **Step 4: Use decoded functions, schemas, and path builders in every Purchase Order view**

Update dashboard, orders list, and order detail imports. Every Purchase Order HTTP call must use a decoded function, a matching schema, and `purchaseOrderPaths`. Next.js page navigation such as `/orders`, `/orders/:id`, and the alert prefill query is not an HTTP contract and must remain outside this Module.

For a nullable create response, check for `null` before reading `id` and throw:

```ts
throw new ApiError(
  '생성된 발주서를 확인할 수 없습니다. 목록을 새로고침해주세요.',
  502,
  'INVALID_RESPONSE',
);
```

Delete the unused `PrefillItem` type and the unreachable populated-items branch from `createDraftOrderAndOpen`; alert prefill remains the existing two-request workflow for Task 2 of the architecture queue.

Use `satisfies CreatePurchaseOrderRequest`, `satisfies CreatePurchaseOrderWithItemsRequest`, `satisfies RevisePurchaseOrderRequest`, `satisfies AddPurchaseOrderItemsRequest`, `satisfies EditPurchaseOrderItemRequest`, and `satisfies ReceivePurchaseOrderItemRequest` on browser request objects so missing or misspelled fields fail frontend compilation.

- [x] **Step 5: Run targeted contract, API, frontend test, and type gates**

Run:

```bash
npx vitest run test/http-contract.test.ts test/api.integration.test.ts
npm run test --prefix frontend
npm run typecheck
npm run lint --prefix frontend
npm run build --prefix frontend
```

Expected: all selected tests pass; TypeScript, ESLint, and Next build exit 0.

- [x] **Step 6: Commit the Adapter integration**

```bash
git add src/index.ts test/api.integration.test.ts frontend/next.config.mjs frontend/lib/types.ts frontend/app
git commit -m "refactor: enforce purchase order HTTP contracts"
```

---

### Task 5: Align documentation and verify the full delivery

**Files:**
- Modify: `docs/design/api-spec-v1.md`
- Modify: `docs/architecture-review-2026-07-12.md`
- Modify: `docs/superpowers/plans/2026-07-12-purchase-order-http-contract.md`

**Interfaces:**
- Consumes: the final observable contract and verification commands from Tasks 1-4.
- Produces: accurate operator/developer documentation and full CI-equivalent evidence.

- [x] **Step 1: Update the HTTP specification**

Document that Purchase Order success projections are runtime-validated by the portable Contract Module, raw Hono request coercion remains Adapter-owned, detail now includes top-level `ordered_qty` and `received_qty`, and those totals equal the active item sums. Keep the documented nullable create/revise/readback races unchanged.

- [x] **Step 2: Mark the previous architecture review recommendation complete**

Update `docs/architecture-review-2026-07-12.md` so its Purchase Order lifecycle recommendation is labeled completed and its stale line-count baseline is not presented as current. Link the new implementation plan as the current follow-up.

- [x] **Step 3: Run full CI-equivalent verification from a clean dependency state**

Run exactly:

```bash
npm ci
npm ci --prefix frontend
npm run typecheck
npm test
npm run build
rm -rf /tmp/hereisorder-contract-ci
npm exec -- wrangler d1 migrations apply hereisorder --local --persist-to /tmp/hereisorder-contract-ci
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
git status --short
```

Expected: every command exits 0; 0 test failures; `git diff --check` has no output; `git status --short` lists only intended source, lockfile, test, workflow, and documentation changes.

- [x] **Step 4: Update this plan checklist and commit documentation**

Mark every completed step `[x]`, then commit:

```bash
git add docs/design/api-spec-v1.md docs/architecture-review-2026-07-12.md docs/superpowers/plans/2026-07-12-purchase-order-http-contract.md
git commit -m "docs: document executable purchase order contracts"
```

- [x] **Step 5: Prepare review evidence**

Record:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected: a clean named feature branch with only the planned commits, ready for independent task and whole-branch review.
