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
