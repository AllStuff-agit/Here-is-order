import { PurchaseOrder, PurchaseOrderBatchItemPayload } from '@/lib/types';
import { INVENTORY_REFRESH_EVENT } from '@/lib/constants';

export { INVENTORY_REFRESH_EVENT };

type OrderStatus = PurchaseOrder['status'];

export type BusinessStatusFilter = 'all' | 'draft' | 'waiting' | 'done';

export const BUSINESS_STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: BusinessStatusFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'draft', label: '발주초안' },
  { value: 'waiting', label: '입고대기' },
  { value: 'done', label: '입고완료' },
] as const;

export type AddOrderItemRow = {
  id: string;
  itemId: string;
  orderedQty: string;
  memo: string;
};

export function notifyInventoryStateUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(INVENTORY_REFRESH_EVENT));
}

export function toBusinessStatus(status: OrderStatus) {
  if (status === 'fully_received') return '✓ 입고완료';
  if (status === 'partially_received') return '부분입고';
  if (status === 'ordered') return '입고대기';
  if (status === 'draft') return '발주초안';
  return '취소';
}

export function statusBadgeVariant(status: OrderStatus) {
  if (status === 'draft') return 'default';
  if (status === 'ordered') return 'outline';
  if (status === 'partially_received') return 'secondary';
  if (status === 'fully_received') return 'secondary';
  if (status === 'canceled') return 'destructive';
  return 'secondary';
}

export function matchesBusinessStatusFilter(status: OrderStatus, filter: BusinessStatusFilter) {
  if (filter === 'all') return true;
  if (filter === 'draft') return status === 'draft';
  if (filter === 'waiting') return status === 'ordered' || status === 'partially_received';
  if (filter === 'done') return status === 'fully_received';
  return false;
}

export function createEmptyOrderItemRow(): AddOrderItemRow {
  return {
    id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    itemId: '',
    orderedQty: '1',
    memo: '',
  };
}

export function createInitialAddItemRows() {
  return [createEmptyOrderItemRow()];
}

export function normalizeAddRows(rows: AddOrderItemRow[]): PurchaseOrderBatchItemPayload[] {
  return rows
    .map((row) => {
      const itemId = Number(row.itemId);
      const orderedQty = parseInt(row.orderedQty, 10);

      if (!Number.isInteger(itemId) || itemId <= 0) return null;
      if (!Number.isInteger(orderedQty) || orderedQty <= 0) return null;

      return {
        item_id: itemId,
        ordered_qty: orderedQty,
        memo: row.memo ? row.memo.trim() : null,
      };
    })
    .filter((item): item is PurchaseOrderBatchItemPayload => item !== null);
}

export function formatQty(value: number) {
  return Number(value || 0).toLocaleString('ko-KR');
}

export function formatMemoPreview(value: string | null | undefined, maxLength = 20) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}...`;
}

export function parsePrefillQty(raw: string | null) {
  const parsed = Number(raw || '1');
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}
