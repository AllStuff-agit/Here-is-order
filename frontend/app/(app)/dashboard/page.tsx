'use client';

import * as React from 'react';
import { ChevronDown, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, apiPatch, ApiError } from '@/lib/api';
import type { DashboardData } from '@/lib/types';
import { getStockStatus, stockStatusLabel } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ShoppingCart } from 'lucide-react';

type MetricTone = 'default' | 'secondary' | 'destructive';

function todayDate() {
  return new Date().toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

function MetricCard({
  title,
  value,
  description,
  tone = 'default',
}: {
  title: string;
  value: number;
  description: string;
  tone?: MetricTone;
}) {
  return (
    <Card className="metric-card">
      <CardHeader className="pb-2">
        <CardDescription className="metric-label">{title}</CardDescription>
        <CardTitle className="metric-kpi">{value.toLocaleString('ko-KR')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={`metric-note ${
            tone === 'destructive' ? 'border-destructive/30 text-destructive' : tone === 'secondary' ? 'border-primary/20 text-primary' : ''
          }`}
        >
          {tone === 'destructive' ? (
            <TrendingDown className="size-3" />
          ) : tone === 'secondary' ? (
            <TrendingUp className="size-3" />
          ) : (
            <Minus className="size-3" />
          )}
          <span>{description}</span>
        </div>
      </CardContent>
    </Card>
  );
}

type RowState = { selected: boolean; qty: string };

function QuickOrderDialog({
  items,
  open,
  onOpenChange,
  onSuccess,
}: {
  items: DashboardData['low_stock_items'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (orderId: number) => void;
}) {
  const [rows, setRows] = React.useState<Record<number, RowState>>({});
  const [title, setTitle] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    const initial: Record<number, RowState> = {};
    for (const item of items) {
      const needsMore = Number(item.suggested_qty || 0) > 0;
      initial[item.id] = { selected: needsMore, qty: String(Math.max(1, Number(item.suggested_qty || 1))) };
    }
    setRows(initial);
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    setTitle(`${yy}${mm}${dd} 발주`);
    setError('');
  }, [open, items]);

  const selectableItems = items.filter((item) => Number(item.suggested_qty || 0) > 0);
  const selectedCount = items.filter((item) => rows[item.id]?.selected).length;
  const allSelected = selectedCount === selectableItems.length && selectableItems.length > 0;
  const someSelected = selectedCount > 0 && !allSelected;

  function toggleAll(checked: boolean | 'indeterminate') {
    const next = checked === true;
    setRows((prev) => {
      const updated = { ...prev };
      for (const item of selectableItems) updated[item.id] = { ...updated[item.id], selected: next };
      return updated;
    });
  }

  function toggleRow(id: number) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], selected: !prev[id]?.selected } }));
  }

  function setQty(id: number, value: string) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], qty: value } }));
  }

  async function handleSubmit(confirm: boolean) {
    const selectedItems = items
      .filter((item) => rows[item.id]?.selected)
      .map((item) => ({
        item_id: item.id,
        ordered_qty: Math.max(1, parseInt(rows[item.id]?.qty || '1', 10) || 1),
        memo: null,
      }));

    if (!selectedItems.length) { setError('품목을 1개 이상 선택해주세요.'); return; }
    if (!title.trim()) { setError('발주명을 입력해주세요.'); return; }

    setSubmitting(true);
    setError('');
    try {
      const order = await apiPost<{ id: number; title: string }>('/api/purchase-orders/with-items', {
        title: title.trim(),
        items: selectedItems,
      });
      if (confirm) {
        await apiPatch(`/api/purchase-orders/${order.id}`, { status: 'ordered' });
      }
      onSuccess(order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '발주 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>바로 발주</DialogTitle>
          <DialogDescription>선택한 품목으로 발주서를 즉시 생성합니다.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="quick-order-title">발주명</Label>
            <Input
              id="quick-order-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="quick-order-all"
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={toggleAll}
              disabled={submitting}
            />
            <Label htmlFor="quick-order-all" className="cursor-pointer font-normal">
              전체 선택 ({selectedCount}/{items.length})
            </Label>
          </div>

          <div className="max-h-[40vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>품목명</TableHead>
                  <TableHead className="text-right">현재고</TableHead>
                  <TableHead className="w-24 text-right">발주수량</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  const statusOrder = { critical: 0, warning: 1, normal: 2 } as const;
                  const sortedItems = [...items].sort((a, b) => {
                    const sugA = Number(a.suggested_qty || 0);
                    const sugB = Number(b.suggested_qty || 0);
                    if (sugA === 0 && sugB > 0) return 1;
                    if (sugB === 0 && sugA > 0) return -1;
                    const stA = getStockStatus(a.current_stock, a.safety_stock, a.min_stock);
                    const stB = getStockStatus(b.current_stock, b.safety_stock, b.min_stock);
                    return statusOrder[stA] - statusOrder[stB];
                  });
                  return sortedItems.map((item) => {
                    const row = rows[item.id];
                    const selected = row?.selected ?? false;
                    const suggestedQty = Number(item.suggested_qty || 0);
                    const onOrderQty = Math.max(0, (Number(item.safety_stock) - Number(item.current_stock)) - suggestedQty);
                    const fullyCovered = suggestedQty === 0;
                    const status = getStockStatus(item.current_stock, item.safety_stock, item.min_stock);
                    return (
                      <TableRow key={item.id} className={fullyCovered ? 'opacity-40' : selected ? '' : 'opacity-50'}>
                        <TableCell>
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => toggleRow(item.id)}
                            disabled={submitting || fullyCovered}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 font-medium">
                            {item.name}
                            {status === 'critical' && !fullyCovered ? (
                              <Badge variant="destructive" className="px-1 py-0 text-[10px]">위험</Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {item.category_name ? (
                              <span className="text-xs text-muted-foreground">{item.category_name}</span>
                            ) : null}
                            {onOrderQty > 0 ? (
                              <span className="text-xs text-blue-600 dark:text-blue-400">발주중 {onOrderQty.toLocaleString('ko-KR')}개</span>
                            ) : null}
                            {fullyCovered ? (
                              <span className="text-xs text-muted-foreground">발주 처리 중</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {Number(item.current_stock || 0).toLocaleString('ko-KR')}{item.unit || '개'}
                        </TableCell>
                        <TableCell className="text-right">
                          {fullyCovered ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <Input
                              type="number"
                              min="1"
                              value={row?.qty ?? '1'}
                              onChange={(e) => setQty(item.id, e.target.value)}
                              disabled={!selected || submitting}
                              className="h-8 w-20 text-right"
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  });
                })()}
              </TableBody>
            </Table>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            취소
          </Button>
          <Button variant="outline" onClick={() => void handleSubmit(false)} disabled={submitting || selectedCount === 0}>
            {submitting ? '처리 중...' : '발주초안 저장'}
          </Button>
          <Button onClick={() => void handleSubmit(true)} disabled={submitting || selectedCount === 0}>
            {submitting ? '처리 중...' : `발주 확정 (${selectedCount}개 품목)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getDefaultFrom() {
  const date = new Date();
  date.setDate(date.getDate() - 29);
  return date.toISOString().slice(0, 10);
}

function getDefaultTo() {
  return new Date().toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const router = useRouter();
  const [from, setFrom] = React.useState(getDefaultFrom());
  const [to, setTo] = React.useState(getDefaultTo());
  const [loading, setLoading] = React.useState(true);
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [error, setError] = React.useState('');
  const [quickOrderOpen, setQuickOrderOpen] = React.useState(false);

  const loadDashboard = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      const loaded = await apiGet<DashboardData>(`/api/dashboard${query ? `?${query}` : ''}`);
      setData(loaded);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/login');
        return;
      }
      setError(err instanceof Error ? err.message : '데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [from, to, router]);

  React.useEffect(() => {
    if (!from || !to) {
      return;
    }
    void loadDashboard();
  }, [from, to, loadDashboard]);

  const onResetPeriod = () => {
    setFrom(getDefaultFrom());
    setTo(getDefaultTo());
  };

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">대시보드</h1>
          <p className="page-subtitle">오늘 {todayDate()} 기준 운영 현황</p>
        </div>
        <div className="toolbar">
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9 w-36" />
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 w-36" />
          <Button variant="outline" size="sm" onClick={onResetPeriod}>
            <ChevronDown className="size-4" />
            기본 30일
          </Button>
          <Button size="sm" onClick={() => void loadDashboard()}>
            조회
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadDashboard()}>
              다시 시도
            </Button>
          </div>
        </Card>
      ) : null}

      {loading || !data ? (
        <div className="metric-grid">
          <Card className="h-24 animate-pulse" />
          <Card className="h-24 animate-pulse" />
          <Card className="h-24 animate-pulse" />
          <Card className="h-24 animate-pulse" />
        </div>
      ) : (
        <>
          {(() => {
            const criticalCount = data.low_stock_items.filter(i => getStockStatus(i.current_stock, i.safety_stock, i.min_stock) === 'critical').length;
            const warningCount = data.low_stock_items.filter(i => getStockStatus(i.current_stock, i.safety_stock, i.min_stock) === 'warning').length;
            return (
          <div className="metric-grid">
            <MetricCard title="위험 품목" value={criticalCount} description="최소재고 미만 (즉시 발주 필요)" tone={criticalCount > 0 ? 'destructive' : 'default'} />
            <MetricCard title="주의 품목" value={warningCount} description="안전재고 미만 (발주 권장)" tone="default" />
            <MetricCard
              title="등록 품목"
              value={data.item_count}
              description={`현재 분류 ${data.category_count}개 그룹`}
              tone="secondary"
            />
            <MetricCard
              title="미완료 발주 수량"
              value={data.monthly_summary.open_qty}
              description="아직 입고되지 않은 수량"
            />
          </div>
            );
          })()}

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>발주 필요 품목</CardTitle>
                  <CardDescription>현재고가 안전재고보다 낮은 항목입니다.</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => router.push('/alerts')}>
                    전체 보기
                  </Button>
                  {data.low_stock_items.some((i) => Number(i.suggested_qty || 0) > 0) ? (
                    <Button size="sm" onClick={() => setQuickOrderOpen(true)}>
                      <ShoppingCart className="size-4" />
                      바로 발주
                    </Button>
                  ) : null}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap gap-1.5">
                <Badge variant={data.low_stock_count > 0 ? 'destructive' : 'secondary'}>
                  발주 필요 {data.low_stock_count}건
                </Badge>
                <Badge variant="outline">
                  미입고 발주 {Number(data.monthly_summary.orders_open).toLocaleString('ko-KR')}건
                </Badge>
                <Badge variant="secondary">
                  기간: {data.monthly_summary.period_from} ~ {data.monthly_summary.period_to}
                </Badge>
              </div>
              {data.low_stock_items.length === 0 ? (
                <p className="data-empty">현재 발주가 필요한 품목이 없습니다.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>품목명</TableHead>
                        <TableHead className="text-right">현재고</TableHead>
                        <TableHead className="text-right">안전재고</TableHead>
                        <TableHead className="text-right">최소재고</TableHead>
                        <TableHead className="text-right">발주대기</TableHead>
                        <TableHead className="text-right">추가 필요</TableHead>
                        <TableHead className="text-right">상태</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const statusOrder = { critical: 0, warning: 1, normal: 2 } as const;
                        const sortedItems = [...data.low_stock_items].sort((a, b) => {
                          const stA = getStockStatus(a.current_stock, a.safety_stock, a.min_stock);
                          const stB = getStockStatus(b.current_stock, b.safety_stock, b.min_stock);
                          return statusOrder[stA] - statusOrder[stB];
                        });
                        return sortedItems.slice(0, 8).map((item) => {
                          const unit = item.unit || '개';
                          const suggestedQty = Number(item.suggested_qty || 0);
                          const onOrderQty = Math.max(0, (Number(item.safety_stock) - Number(item.current_stock)) - suggestedQty);
                          const fullyCovered = suggestedQty === 0 && onOrderQty > 0;
                          const status = getStockStatus(item.current_stock, item.safety_stock, item.min_stock);
                          return (
                            <TableRow key={item.id} className={status === 'critical' ? 'bg-destructive/5' : ''}>
                              <TableCell>
                                <div>{item.name}</div>
                                {item.category_name ? <div className="text-xs text-muted-foreground">{item.category_name}</div> : null}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{Number(item.current_stock || 0).toLocaleString('ko-KR')}{unit}</TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">{Number(item.safety_stock || 0).toLocaleString('ko-KR')}{unit}</TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">{Number(item.min_stock || 0).toLocaleString('ko-KR')}{unit}</TableCell>
                              <TableCell className="text-right tabular-nums text-blue-600 dark:text-blue-400">
                                {onOrderQty > 0 ? `${onOrderQty.toLocaleString('ko-KR')}${unit}` : '—'}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {suggestedQty > 0 ? `${suggestedQty.toLocaleString('ko-KR')}${unit}` : '—'}
                              </TableCell>
                              <TableCell className="text-right">
                                {fullyCovered ? (
                                  <Badge variant="outline">발주중</Badge>
                                ) : (
                                  <Badge variant={status === 'critical' ? 'destructive' : status === 'warning' ? 'secondary' : 'outline'}>
                                    {stockStatusLabel(status)}
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        });
                      })()}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

        </>
      )}

      {data ? (
        <QuickOrderDialog
          items={data.low_stock_items}
          open={quickOrderOpen}
          onOpenChange={setQuickOrderOpen}
          onSuccess={(orderId) => {
            setQuickOrderOpen(false);
            router.push(`/orders/${orderId}`);
          }}
        />
      ) : null}
    </div>
  );
}
