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
