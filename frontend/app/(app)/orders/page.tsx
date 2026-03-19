'use client';

import * as React from 'react';
import { Calendar, ReceiptText, SendHorizonal, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '@/lib/api';
import { formatDateTime, parseDateLike } from '@/lib/format';
import { Item, PurchaseOrder } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  BUSINESS_STATUS_FILTER_OPTIONS,
  BusinessStatusFilter,
  formatMemoPreview,
  formatQty,
  matchesBusinessStatusFilter,
  parsePrefillQty,
  statusBadgeVariant,
  toBusinessStatus,
} from '@/lib/order-ui';

type PrefillInfo = {
  itemId: number | null;
  qty: number;
};

export default function OrdersPage() {
  const router = useRouter();
  const [prefillInfo, setPrefillInfo] = React.useState<PrefillInfo>({ itemId: null, qty: 1 });

  const [loading, setLoading] = React.useState(true);
  const [creatingOrder, setCreatingOrder] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [orders, setOrders] = React.useState<PurchaseOrder[]>([]);
  const [items, setItems] = React.useState<Item[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<BusinessStatusFilter>('all');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [search, setSearch] = React.useState('');

  const [deleteTarget, setDeleteTarget] = React.useState<PurchaseOrder | null>(null);
  const [createDraftOpen, setCreateDraftOpen] = React.useState(false);
  const [newDraftTitle, setNewDraftTitle] = React.useState('새 발주서');
  const [newDraftNote, setNewDraftNote] = React.useState('');
  const [newDraftError, setNewDraftError] = React.useState('');
  const prefillHandled = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const rawItemId = Number(params.get('prefillItemId') || '');
    const rawQty = params.get('prefillQty');

    setPrefillInfo({
      itemId: Number.isInteger(rawItemId) && rawItemId > 0 ? rawItemId : null,
      qty: parsePrefillQty(rawQty),
    });
  }, []);

  const loadOrders = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (search) params.set('q', search);

      const [rows, loadedItems] = await Promise.all([
        apiGet<PurchaseOrder[]>(`/api/purchase-orders${params.toString() ? `?${params.toString()}` : ''}`),
        apiGet<Item[]>('/api/items'),
      ]);
      setOrders(rows || []);
      setItems(loadedItems || []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : '발주 목록을 가져오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [from, to, search, router]);

  React.useEffect(() => {
    const timer = setTimeout(() => void loadOrders(), 250);
    return () => clearTimeout(timer);
  }, [loadOrders]);

  React.useEffect(() => {
    const prefillItemId = prefillInfo.itemId;
    const hasPrefill = Number.isInteger(prefillItemId || 0) && (prefillItemId || 0) > 0;
    if (!hasPrefill || prefillItemId == null || prefillHandled.current) return;
    if (loading) return;

    prefillHandled.current = true;

    const run = async () => {
      try {
        const prefillTargetItemId = prefillItemId;
        const targetItem = items.find((item) => item.id === prefillTargetItemId);
        if (!targetItem) {
          setMessage('알림에서 전달된 품목을 찾지 못했습니다.');
          router.replace('/orders');
          return;
        }

        const created = await apiPost<PurchaseOrder>('/api/purchase-orders', {
          title: `${targetItem.name} 발주 초안`,
          note: '알림에서 생성된 초안',
          status: 'draft',
        });

        await apiPost(`/api/purchase-orders/${created.id}/items`, {
          item_id: prefillTargetItemId,
          ordered_qty: prefillInfo.qty,
          memo: '알림에서 자동 추가',
        });

        await loadOrders();
        router.replace(`/orders/${created.id}`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '알림 기반 발주 초안 생성에 실패했습니다.');
        router.replace('/orders');
      }
    };

    void run();
  }, [prefillInfo, loading, items, router, loadOrders]);

  const filteredOrders = React.useMemo(
    () => orders.filter((order) => matchesBusinessStatusFilter(order.status, statusFilter)),
    [orders, statusFilter],
  );

  const confirmDelete = (order: PurchaseOrder) => {
    setDeleteTarget(order);
  };

  const confirmOrder = async (orderId: number) => {
    try {
      await apiPatch(`/api/purchase-orders/${orderId}`, { status: 'ordered' });
      await loadOrders();
      setMessage('발주 상태가 변경되었습니다.');
    } catch (error) {
      setError(error instanceof Error ? error.message : '상태 변경 실패');
    }
  };

  const deleteOrder = async () => {
    if (!deleteTarget) return;

    try {
      await apiDelete(`/api/purchase-orders/${deleteTarget.id}`);
      await loadOrders();
      setMessage('발주서가 삭제되었습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '삭제 실패');
    } finally {
      setDeleteTarget(null);
    }
  };

  const createDraftOrderAndOpen = async (title: string, note: string | null) => {
    if (creatingOrder) return;
    try {
      setCreatingOrder(true);
      setNewDraftError('');
      const created = await apiPost<PurchaseOrder>('/api/purchase-orders', {
        title,
        note,
        status: 'draft',
      });
      setCreateDraftOpen(false);
      router.push(`/orders/${created.id}`);
    } catch (e) {
      setNewDraftError(e instanceof Error ? e.message : '새 발주서 생성에 실패했습니다.');
    } finally {
      setCreatingOrder(false);
    }
  };

  const openCreateDraftDialog = () => {
    setNewDraftTitle('새 발주서');
    setNewDraftNote('');
    setNewDraftError('');
    setCreateDraftOpen(true);
  };

  const confirmCreateDraft = async () => {
    const title = newDraftTitle.trim();
    if (!title) {
      setNewDraftError('발주명은 필수입니다.');
      return;
    }
    await createDraftOrderAndOpen(title, newDraftNote.trim() || null);
  };

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">발주관리</h1>
          <p className="page-subtitle">발주서 검색/확정/삭제</p>
        </div>
        <Button onClick={() => openCreateDraftDialog()} disabled={creatingOrder}>
          <Calendar className="size-4" />
          {creatingOrder ? '생성 중...' : '새 발주서'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>발주 목록 검색</CardTitle>
          <CardDescription>상태/기간/키워드로 목록을 확인</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as BusinessStatusFilter)}
          >
            <SelectTrigger className="h-9 w-full sm:w-44">
              <SelectValue placeholder="전체 상태" />
            </SelectTrigger>
            <SelectContent>
              {BUSINESS_STATUS_FILTER_OPTIONS.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9 w-full sm:w-44" />
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 w-full sm:w-44" />
          <Input
            className="min-w-[220px] md:w-[280px]"
            placeholder="발주명/메모 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </CardContent>
      </Card>

      <Dialog open={createDraftOpen} onOpenChange={setCreateDraftOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 발주서 생성</DialogTitle>
            <DialogDescription>발주명을 입력하고 필요하면 메모를 남겨주세요.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="new-order-title">발주명</Label>
              <Input
                id="new-order-title"
                value={newDraftTitle}
                onChange={(event) => setNewDraftTitle(event.target.value)}
                disabled={creatingOrder}
                placeholder="발주명을 입력하세요"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-order-note">메모</Label>
              <Textarea
                id="new-order-note"
                rows={4}
                value={newDraftNote}
                onChange={(event) => setNewDraftNote(event.target.value)}
                disabled={creatingOrder}
                placeholder="메모를 입력하세요 (선택)"
              />
            </div>
            {newDraftError ? <p className="text-sm text-destructive">{newDraftError}</p> : null}
          </div>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setCreateDraftOpen(false)} disabled={creatingOrder}>
              취소
            </Button>
            <Button onClick={() => void confirmCreateDraft()} disabled={creatingOrder}>
              {creatingOrder ? '생성 중...' : '확인'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadOrders()}>
              다시 시도
            </Button>
          </div>
        </Card>
      ) : null}
      {message ? <p className="rounded-md bg-muted px-3 py-2 text-sm">{message}</p> : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>발주 목록</CardTitle>
              <CardDescription>총 {filteredOrders.length}건</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <div className="h-12 animate-pulse rounded bg-muted" />
              <div className="h-12 animate-pulse rounded bg-muted" />
            </div>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {filteredOrders.length === 0 ? (
                  <p className="data-empty">발주서가 없습니다.</p>
                ) : (
                  filteredOrders.map((order) => (
                    <Card key={order.id} className="border-border/70">
                      <CardContent className="space-y-3 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium">{order.title}</p>
                            <p className="text-xs text-muted-foreground">
                              발주일 {parseDateLike(order.order_date)} · 수정 {formatDateTime(order.updated_at)}
                            </p>
                          </div>
                          <Badge variant={statusBadgeVariant(order.status)}>{toBusinessStatus(order.status)}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <p className="text-muted-foreground">
                            주문수량: <span className="font-medium text-foreground">{formatQty(order.ordered_qty)}개</span>
                          </p>
                          <p className="text-muted-foreground">
                            입고수량: <span className="font-medium text-foreground">{formatQty(order.received_qty)}개</span>
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button size="sm" variant="outline" onClick={() => router.push(`/orders/${order.id}`)}>
                            <ReceiptText className="size-4" />
                            상세
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void confirmOrder(order.id)}
                            disabled={order.status !== 'draft' || Number(order.ordered_qty || 0) <= 0}
                          >
                            <SendHorizonal className="size-4" />
                            발주확정
                          </Button>
                          <Button
                            className="col-span-2"
                            variant="destructive"
                            size="sm"
                            onClick={() => confirmDelete(order)}
                          >
                            <Trash2 className="size-4" />
                            삭제
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>발주명</TableHead>
                      <TableHead>발주일</TableHead>
                      <TableHead>상태</TableHead>
                      <TableHead>주문수량</TableHead>
                      <TableHead>입고수량</TableHead>
                      <TableHead>최근수정</TableHead>
                      <TableHead className="text-right">작업</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <p className="font-medium">{order.title}</p>
                          {order.note ? (
                            <p className="max-w-[260px] truncate text-xs text-muted-foreground" title={order.note}>
                              {formatMemoPreview(order.note, 32)}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>{parseDateLike(order.order_date)}</TableCell>
                        <TableCell>
                          <Badge variant={statusBadgeVariant(order.status)}>{toBusinessStatus(order.status)}</Badge>
                        </TableCell>
                        <TableCell>{formatQty(order.ordered_qty)}개</TableCell>
                        <TableCell>{formatQty(order.received_qty)}개</TableCell>
                        <TableCell>{formatDateTime(order.updated_at)}</TableCell>
                        <TableCell className="space-x-1 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => router.push(`/orders/${order.id}`)}>
                              <ReceiptText className="size-4" />
                              상세
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void confirmOrder(order.id)}
                              disabled={order.status !== 'draft' || Number(order.ordered_qty || 0) <= 0}
                            >
                              <SendHorizonal className="size-4" />
                              발주확정
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => confirmDelete(order)}>
                              <Trash2 className="size-4" />
                              삭제
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredOrders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                          발주서가 없습니다.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>발주서 삭제</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.title}" 발주서를 정말 삭제할까요?` : '발주서를 삭제할까요?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteOrder()}>삭제</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
