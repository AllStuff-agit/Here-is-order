export type StockStatus = 'normal' | 'warning' | 'critical';

export function getStockStatus(
  currentStock: number | null | undefined,
  safetyStock: number | null | undefined,
  minStock: number | null | undefined,
): StockStatus {
  const cur = Number(currentStock ?? 0);
  const safety = Number(safetyStock ?? 0);
  const min = Number(minStock ?? 0);
  if (cur < min) return 'critical';
  if (cur < safety) return 'warning';
  return 'normal';
}

export function stockStatusLabel(status: StockStatus) {
  if (status === 'critical') return '위험';
  if (status === 'warning') return '주의';
  return '정상';
}

export function formatNumber(value: number | string | null | undefined) {
  const n = Number(value ?? 0);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    return '0';
  }
  return n.toLocaleString('ko-KR');
}

export function formatWithUnit(value: number | string | null | undefined, unit = '개') {
  return `${formatNumber(value)}${unit}`;
}

export function parseDateLike(value: string | null | undefined) {
  if (!value) return '-';
  return value.slice(0, 10);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value.slice(0, 16).replace('T', ' ');
    return d.toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value.slice(0, 16).replace('T', ' ');
  }
}
