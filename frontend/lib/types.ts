import type {
  PurchaseOrderDetail as ContractPurchaseOrderDetail,
  PurchaseOrderDetailItem,
  PurchaseOrderItemInput,
  PurchaseOrderSummary,
} from '@here-is-order/http-contract/purchase-orders';

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

export type PurchaseOrder = PurchaseOrderSummary;
export type PurchaseOrderBatchItemPayload = PurchaseOrderItemInput;
export type PurchaseOrderItem = PurchaseOrderDetailItem;
export type PurchaseOrderDetail = ContractPurchaseOrderDetail;

export type UserRole = 'admin' | 'staff';

export type AppUser = {
  id: number;
  username: string;
  name: string;
  role: UserRole;
  is_active: number;
  created_at: string;
};

export type CurrentUser = Pick<AppUser, 'id' | 'username' | 'name' | 'role'>;
