export type ApiErrorPayload = {
  code: string;
  message: string;
};

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload };

export type Category = {
  id: number;
  name: string;
  description: string | null;
};

export type Item = {
  id: number;
  category_id: number | null;
  category_name: string | null;
  name: string;
  unit: string;
  safety_stock: number;
  min_stock: number;
  current_stock: number;
  unit_price: number;
  memo: string | null;
  suggested_qty: number;
  created_at?: string;
  updated_at?: string;
};

export type StockAdjustPayload = {
  item_id: number;
  movement_type: 'IN' | 'OUT' | 'ADJUST';
  quantity: number;
  reason?: string;
};

export type StockTransaction = {
  id: number;
  item_id: number;
  movement_type: 'IN' | 'OUT' | 'ADJUST';
  quantity: number;
  reason: string | null;
  created_at: string;
};

export type DashboardData = {
  today: string;
  low_stock_count: number;
  low_stock_items: Array<{
    id: number;
    name: string;
    unit: string;
    current_stock: number;
    safety_stock: number;
    min_stock: number;
    suggested_qty: number;
    category_name?: string | null;
  }>;
  item_count: number;
  category_count: number;
  monthly_summary: {
    period_from: string;
    period_to: string;
    orders_open: number;
    open_qty: number;
    received_qty: number;
  };
};

export type PurchaseOrder = {
  id: number;
  title: string;
  status: 'draft' | 'ordered' | 'partially_received' | 'fully_received' | 'canceled';
  order_date: string | null;
  external_order_ref: string | null;
  note: string | null;
  ordered_qty: number;
  received_qty: number;
  created_at: string;
  updated_at: string;
};

export type PurchaseOrderBatchItemPayload = {
  item_id: number;
  ordered_qty: number;
  memo: string | null;
};

export type PurchaseOrderItem = {
  id: number;
  item_id: number;
  item_name: string;
  ordered_qty: number;
  received_qty: number;
  remaining_qty: number;
  memo: string | null;
};

export type PurchaseOrderDetail = PurchaseOrder & {
  items: PurchaseOrderItem[];
};

export type AppUser = {
  id: number;
  username: string;
  name: string;
  is_active: number;
  created_at: string;
};
