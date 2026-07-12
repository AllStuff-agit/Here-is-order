'use client';

import * as React from 'react';
import { CalendarCheck, ReceiptText, SendHorizonal, ShieldAlert, Truck } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  addPurchaseOrderItemsResultSchema,
  editPurchaseOrderItemResultSchema,
  purchaseOrderDetailSchema,
  purchaseOrderPaths,
  purchaseOrderRowResultSchema,
  receivePurchaseOrderItemResultSchema,
  type AddPurchaseOrderItemsRequest,
  type EditPurchaseOrderItemRequest,
  type ReceivePurchaseOrderItemRequest,
  type RevisePurchaseOrderRequest,
} from '@here-is-order/http-contract/purchase-orders';
import {
  apiGet,
  apiGetDecoded,
  apiPatchDecoded,
  apiPostDecoded,
  ApiError,
} from '@/lib/api';
import { Item, PurchaseOrderDetail, PurchaseOrderItem } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AddOrderItemRow,
  createInitialAddItemRows,
  formatMemoPreview,
  formatQty,
  normalizeAddRows,
  notifyInventoryStateUpdated,
  statusBadgeVariant,
  toBusinessStatus,
} from '@/lib/order-ui';

type ParsedOrderId = { value: number | null };

function toOrderId(raw: string | string[] | undefined): ParsedOrderId {
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) {
    return { value: null };
  }
  return { value: id };
}

function OrderDetailPageContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldOpenMetaEdit = searchParams.get('editMeta') === '1';
  const orderId = toOrderId(params.id);

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [items, setItems] = React.useState<Item[]>([]);
  const [selectedOrder, setSelectedOrder] = React.useState<PurchaseOrderDetail | null>(null);

  const [openAddItem, setOpenAddItem] = React.useState(false);
  const [addItemRows, setAddItemRows] = React.useState<AddOrderItemRow[]>(createInitialAddItemRows());
  const [draftTitle, setDraftTitle] = React.useState('');
  const [draftNote, setDraftNote] = React.useState('');
  const [savingDraft, setSavingDraft] = React.useState(false);
  const [isMetaEditing, setIsMetaEditing] = React.useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = React.useState(false);
  const [pendingLeavePath, setPendingLeavePath] = React.useState<string | null>(null);

  const [orderItemEdit, setOrderItemEdit] = React.useState<{ open: boolean; item?: PurchaseOrderItem }>({ open: false });
  const [editOrderedQty, setEditOrderedQty] = React.useState('');
  const [editMemo, setEditMemo] = React.useState('');
  const [orderItemEditError, setOrderItemEditError] = React.useState('');

  const [receiveOpen, setReceiveOpen] = React.useState<{ open: boolean; item?: PurchaseOrderItem }>({ open: false });
  const [receiveQty, setReceiveQty] = React.useState('');
  const [receiveNote, setReceiveNote] = React.useState('');
  const [receiveError, setReceiveError] = React.useState('');

  const loadOrderDetail = React.useCallback(async (signal?: AbortSignal) => {
    if (!orderId.value) {
      setError('잘못된 발주 ID입니다.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const [detail, loadedItems] = await Promise.all([
        apiGetDecoded(
          purchaseOrderPaths.detail(orderId.value),
          purchaseOrderDetailSchema,
          signal,
        ),
        apiGet<Item[]>('/api/items', signal),
      ]);
      setSelectedOrder(detail);
      setItems(loadedItems || []);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : '발주 상세를 가져오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [orderId.value, router]);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadOrderDetail(controller.signal);
    return () => controller.abort();
  }, [loadOrderDetail]);

  React.useEffect(() => {
    if (!selectedOrder) return;
    setDraftTitle(selectedOrder.title || '');
    setDraftNote(selectedOrder.note || '');
  }, [selectedOrder]);

  React.useEffect(() => {
    if (!selectedOrder) {
      setIsMetaEditing(false);
    }
    if (shouldOpenMetaEdit) {
      setIsMetaEditing(true);
    }
  }, [shouldOpenMetaEdit, selectedOrder]);

  React.useEffect(() => {
    if (selectedOrder?.status !== 'draft' && openAddItem) {
      setOpenAddItem(false);
      setAddItemRows(createInitialAddItemRows());
    }
  }, [selectedOrder?.status, openAddItem]);

  const hasUnsavedDraft = React.useMemo(() => {
    if (!selectedOrder) return false;
    const nextTitle = draftTitle.trim();
    const nextNote = draftNote.trim() || null;
    return nextTitle !== selectedOrder.title || nextNote !== (selectedOrder.note ?? null);
  }, [selectedOrder, draftTitle, draftNote]);

  React.useEffect(() => {
    if (!hasUnsavedDraft) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedDraft]);

  React.useEffect(() => {
    if (!hasUnsavedDraft) return;

    const interceptNavigation = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      const currentUrl = new URL(window.location.href);
      const nextUrl = new URL(anchor.href, currentUrl.origin);
      if (nextUrl.origin !== currentUrl.origin) return;
      if (
        nextUrl.pathname === currentUrl.pathname &&
        nextUrl.search === currentUrl.search &&
        nextUrl.hash === currentUrl.hash
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setPendingLeavePath(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      setLeaveConfirmOpen(true);
    };

    document.addEventListener('click', interceptNavigation, true);
    return () => document.removeEventListener('click', interceptNavigation, true);
  }, [hasUnsavedDraft]);

  const updateOrderStatus = async (
    status: NonNullable<RevisePurchaseOrderRequest['status']>,
  ) => {
    if (!selectedOrder) return;

    try {
      await apiPatchDecoded(
        purchaseOrderPaths.detail(selectedOrder.id),
        purchaseOrderRowResultSchema,
        { status } satisfies RevisePurchaseOrderRequest,
      );
      await loadOrderDetail();
      setMessage('발주 상태가 변경되었습니다.');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '상태 변경 실패');
      return false;
    }
  };

  const saveDraft = async () => {
    if (!selectedOrder) return false;

    const title = draftTitle.trim();
    const note = draftNote.trim() || null;
    if (!title) {
      setMessage('발주명을 입력해주세요.');
      return false;
    }

    if (!hasUnsavedDraft) return true;

    try {
      setSavingDraft(true);
      await apiPatchDecoded(
        purchaseOrderPaths.detail(selectedOrder.id),
        purchaseOrderRowResultSchema,
        {
          title,
          note,
        } satisfies RevisePurchaseOrderRequest,
      );
      await loadOrderDetail();
      setMessage('초안 저장되었습니다.');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '초안 저장 실패');
      return false;
    } finally {
      setSavingDraft(false);
    }
  };

  const confirmOrder = async () => {
    if (!selectedOrder || selectedOrder.status !== 'draft') return;
    if (selectedOrder.items.length === 0) {
      setMessage('발주 항목이 없어 발주 확정할 수 없습니다.');
      return;
    }

    const saved = await saveDraft();
    if (!saved) return;
    await updateOrderStatus('ordered');
  };

  const cancelMetadataEdit = () => {
    if (!selectedOrder) return;
    setDraftTitle(selectedOrder.title || '');
    setDraftNote(selectedOrder.note || '');
    setIsMetaEditing(false);
  };

  const confirmMetadataEdit = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    setIsMetaEditing(false);
  };

  const goToList = () => {
    if (hasUnsavedDraft) {
      setPendingLeavePath('/orders');
      setLeaveConfirmOpen(true);
      return;
    }
    router.push('/orders');
  };

  const saveDraftAndLeave = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    const nextPath = pendingLeavePath || '/orders';
    setPendingLeavePath(null);
    setLeaveConfirmOpen(false);
    router.push(nextPath);
  };

  const discardAndLeave = () => {
    const nextPath = pendingLeavePath || '/orders';
    setPendingLeavePath(null);
    setLeaveConfirmOpen(false);
    router.push(nextPath);
  };

  const updateAddItemRow = (patch: Partial<AddOrderItemRow>) => {
    setAddItemRows((prev) => {
      const base = prev[0] ?? createInitialAddItemRows()[0];
      return [{ ...base, ...patch }];
    });
  };

  const addOrderItem = async () => {
    if (!selectedOrder) return;
    if (selectedOrder.status !== 'draft') {
      setMessage('발주 확정 이후에는 항목을 추가할 수 없습니다.');
      return;
    }

    const rows = normalizeAddRows(addItemRows);
    if (!rows.length) {
      setMessage('품목과 수량을 확인해주세요.');
      return;
    }

    try {
      await apiPostDecoded(
        purchaseOrderPaths.items(selectedOrder.id),
        addPurchaseOrderItemsResultSchema,
        { items: rows } satisfies AddPurchaseOrderItemsRequest,
      );
      setOpenAddItem(false);
      setAddItemRows(createInitialAddItemRows());
      await loadOrderDetail();
      setMessage(`선택한 ${rows.length}개 품목을 추가했습니다.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '발주 품목 추가 실패');
    }
  };

  const openItemEdit = (item: PurchaseOrderItem) => {
    if (!selectedOrder || selectedOrder.status !== 'draft') {
      setMessage('초안 상태에서만 발주 항목을 수정할 수 있습니다.');
      return;
    }
    setOrderItemEdit({ open: true, item });
    setEditOrderedQty(String(item.ordered_qty));
    setEditMemo(item.memo || '');
    setOrderItemEditError('');
  };

  const saveOrderItemEdit = async () => {
    if (!selectedOrder || !orderItemEdit.item) return;
    setOrderItemEditError('');

    const qty = Number(editOrderedQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      setOrderItemEditError('수량은 1 이상의 정수여야 합니다.');
      return;
    }

    if (qty < orderItemEdit.item.received_qty) {
      setOrderItemEditError('이미 입고된 수량보다 적게 설정할 수 없습니다.');
      return;
    }

    try {
      await apiPatchDecoded(
        purchaseOrderPaths.item(selectedOrder.id, orderItemEdit.item.id),
        editPurchaseOrderItemResultSchema,
        {
          ordered_qty: qty,
          memo: editMemo.trim() || null,
        } satisfies EditPurchaseOrderItemRequest,
      );
      setOrderItemEdit({ open: false });
      await loadOrderDetail();
      setMessage('발주 항목이 수정되었습니다.');
    } catch (e) {
      setOrderItemEditError(e instanceof Error ? e.message : '수정 실패');
      setMessage(e instanceof Error ? e.message : '수정 실패');
    }
  };

  const openReceive = (item: PurchaseOrderItem) => {
    if (!selectedOrder || selectedOrder.status === 'draft' || selectedOrder.status === 'canceled') {
      if (selectedOrder?.status === 'canceled') {
        setMessage('취소된 발주는 입고 처리할 수 없습니다.');
      } else {
        setMessage('초안 상태에서는 입고 처리할 수 없습니다.');
      }
      return;
    }

    setReceiveOpen({ open: true, item });
    setReceiveQty(String(Math.max(1, item.remaining_qty || 1)));
    setReceiveNote('');
    setReceiveError('');
  };

  const saveReceive = async () => {
    if (!selectedOrder || !receiveOpen.item) return;
    setReceiveError('');

    const qty = Number(receiveQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      setReceiveError('입고 수량은 1 이상이어야 합니다.');
      return;
    }

    if (qty > receiveOpen.item.remaining_qty) {
      setReceiveError(`최대 ${formatQty(receiveOpen.item.remaining_qty)}개까지 입고 가능합니다.`);
      return;
    }

    try {
      await apiPostDecoded(
        purchaseOrderPaths.receive(selectedOrder.id, receiveOpen.item.id),
        receivePurchaseOrderItemResultSchema,
        {
          qty,
          note: receiveNote.trim() || undefined,
        } satisfies ReceivePurchaseOrderItemRequest,
      );
      setReceiveOpen({ open: false });
      await loadOrderDetail();
      notifyInventoryStateUpdated();
      setMessage('입고 처리되었습니다.');
    } catch (e) {
      setReceiveError(e instanceof Error ? e.message : '입고 처리 실패');
      setMessage(e instanceof Error ? e.message : '입고 처리 실패');
    }
  };

  if (loading) {
    return (
      <div className="section-gap space-y-3">
        <div className="h-24 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (!orderId.value) {
    return (
      <div className="section-gap">
        <Card>
          <CardHeader>
            <CardTitle>잘못된 요청</CardTitle>
            <CardDescription>존재하지 않는 발주 ID입니다.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!selectedOrder) {
    return (
      <div className="section-gap">
        <Card>
          <CardHeader>
            <CardTitle>발주를 찾을 수 없습니다.</CardTitle>
            <CardDescription>발주 상세를 불러오지 못했습니다.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">발주서 상세</h1>
          <p className="page-subtitle">발주 관리(품목 추가·수정·입고 처리)</p>
        </div>
        <div className="toolbar">
          {!isMetaEditing ? (
            <>
              {selectedOrder.status === 'draft' ? (
                <Button
                  size="sm"
                  onClick={() => void confirmOrder()}
                  disabled={selectedOrder.items.length === 0 || savingDraft}
                >
                  <SendHorizonal className="size-4" />
                  발주 확정
                </Button>
              ) : null}
            </>
          ) : null}
          <Button variant="outline" onClick={goToList}>
            목록으로
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadOrderDetail()}>
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
              {isMetaEditing ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="order-title">발주명</Label>
                    <Input
                      id="order-title"
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="발주명을 입력하세요"
                      className="w-full min-w-0 md:min-w-[620px] xl:min-w-[760px]"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="order-note">메모</Label>
                    <Textarea
                      id="order-note"
                      rows={3}
                      value={draftNote}
                      onChange={(event) => setDraftNote(event.target.value)}
                      placeholder="메모를 입력하세요"
                      className="w-full min-h-24 min-w-0 md:min-h-36 md:min-w-[620px] xl:min-w-[760px]"
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <CardTitle>{selectedOrder.title}</CardTitle>
                  </div>
                  <CardDescription className="mt-1 text-sm text-muted-foreground">
                    {selectedOrder.note ? (
                      <span className="inline-block max-w-2xl whitespace-pre-wrap">{selectedOrder.note}</span>
                    ) : (
                      '메모 없음'
                    )}
                  </CardDescription>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              {isMetaEditing ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => cancelMetadataEdit()} disabled={savingDraft}>
                    취소
                  </Button>
                  <Button size="sm" onClick={() => void confirmMetadataEdit()} disabled={savingDraft}>
                    확인
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setIsMetaEditing(true)}>
                    수정
                  </Button>
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(selectedOrder.status)}>{toBusinessStatus(selectedOrder.status)}</Badge>
            <span className="text-xs text-muted-foreground">
              주문 {formatQty(selectedOrder.ordered_qty)}개 / 입고 {formatQty(selectedOrder.received_qty)}개
            </span>
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setOpenAddItem(true)}
              disabled={selectedOrder.status !== 'draft'}
            >
              <CalendarCheck className="size-4" />
              품목 추가
            </Button>
            <Button variant="outline" onClick={() => void loadOrderDetail()}>
              <ReceiptText className="size-4" />
              새로고침
            </Button>
          </div>

          {selectedOrder.items.length === 0 ? (
            <p className="data-empty">아직 추가된 품목이 없습니다. 품목을 추가해보세요.</p>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {selectedOrder.items.map((item) => (
                  <Card key={item.id} className="border-border/70">
                    <CardContent className="space-y-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{item.item_name}</p>
                        </div>
                        {item.remaining_qty > 0 ? (
                          <Badge variant="outline">
                            <ShieldAlert className="mr-1 size-3" />
                            잔여 {formatQty(item.remaining_qty)}개
                          </Badge>
                        ) : (
                          <Badge variant="secondary">입고완료</Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <p className="text-muted-foreground">
                          주문 <span className="font-medium text-foreground">{formatQty(item.ordered_qty)}</span>
                        </p>
                        <p className="text-muted-foreground">
                          입고 <span className="font-medium text-foreground">{formatQty(item.received_qty)}</span>
                        </p>
                        <p className="text-muted-foreground">
                          잔여 <span className="font-medium text-foreground">{formatQty(item.remaining_qty)}</span>
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <p title={item.memo || ''}>메모: {item.memo ? formatMemoPreview(item.memo, 16) : '-'}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openItemEdit(item)}
                          disabled={selectedOrder.status !== 'draft'}
                        >
                          <ReceiptText className="size-4" />
                          수정
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openReceive(item)}
                          disabled={item.remaining_qty <= 0 || selectedOrder.status === 'draft' || selectedOrder.status === 'canceled'}
                        >
                          <Truck className="size-4" />
                          입고
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>품목</TableHead>
                      <TableHead className="text-right">주문 수량</TableHead>
                      <TableHead className="text-right">입고 수량</TableHead>
                      <TableHead className="text-right">잔여 수량</TableHead>
                      <TableHead>메모</TableHead>
                      <TableHead className="text-right">작업</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedOrder.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.item_name}</TableCell>
                        <TableCell className="text-right">{formatQty(item.ordered_qty)}</TableCell>
                        <TableCell className="text-right">{formatQty(item.received_qty)}</TableCell>
                        <TableCell className="text-right">{formatQty(item.remaining_qty)}</TableCell>
                        <TableCell title={item.memo || ''}>{item.memo ? formatMemoPreview(item.memo, 20) : '-'}</TableCell>
                        <TableCell className="space-x-1 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openItemEdit(item)}
                              disabled={selectedOrder.status !== 'draft'}
                            >
                              <ReceiptText className="size-4" />
                              수정
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openReceive(item)}
                              disabled={item.remaining_qty <= 0 || selectedOrder.status === 'draft' || selectedOrder.status === 'canceled'}
                            >
                              <Truck className="size-4" />
                              입고
                            </Button>
                          </div>
                          {item.remaining_qty > 0 ? (
                            <div className="mt-1 flex justify-end">
                              <Badge variant="outline">
                                <ShieldAlert className="mr-1 size-3" />
                                잔여 {formatQty(item.remaining_qty)}개
                              </Badge>
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={leaveConfirmOpen}
        onOpenChange={(open) => {
          setLeaveConfirmOpen(open);
          if (!open) setPendingLeavePath(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>작성 중인 내용이 있어요</DialogTitle>
            <DialogDescription>
              저장하지 않고 나가면 작성 내용이 사라질 수 있습니다. 어떻게 진행할까요?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => {
                setLeaveConfirmOpen(false);
                setPendingLeavePath(null);
              }}
            >
              취소
            </Button>
            <Button variant="outline" onClick={() => void saveDraftAndLeave()} disabled={savingDraft}>
              저장 후 나가기
            </Button>
            <Button variant="destructive" onClick={discardAndLeave}>
              저장하지 않고 나가기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAddItem}
        onOpenChange={(open) => {
          setOpenAddItem(open);
          if (!open) setAddItemRows(createInitialAddItemRows());
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>발주 품목 추가</DialogTitle>
            <DialogDescription>품목 1개를 입력해서 저장하고, 필요하면 반복해서 추가하세요.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div>
              <Label>품목</Label>
              <Select value={addItemRows[0]?.itemId || ''} onValueChange={(value) => updateAddItemRow({ itemId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="품목 선택" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>발주수량</Label>
                <Input
                  type="number"
                  min="1"
                  value={addItemRows[0]?.orderedQty || '1'}
                  onChange={(event) => updateAddItemRow({ orderedQty: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>메모</Label>
                <Input value={addItemRows[0]?.memo || ''} onChange={(event) => updateAddItemRow({ memo: event.target.value })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAddItem(false)}>
              취소
            </Button>
            <Button onClick={() => void addOrderItem()}>
              저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={orderItemEdit.open}
        onOpenChange={(open) => {
          setOrderItemEdit((prev) => ({ ...prev, open }));
          if (!open) {
            setOrderItemEditError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>발주 항목 수정</DialogTitle>
            <DialogDescription>발주 수량 또는 메모를 수정합니다.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>주문 수량</Label>
            <Input type="number" min="1" value={editOrderedQty} onChange={(event) => setEditOrderedQty(event.target.value)} autoFocus />
            <Label>메모</Label>
            <Input value={editMemo} onChange={(event) => setEditMemo(event.target.value)} />
            {orderItemEditError ? <p className="text-sm text-destructive">{orderItemEditError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderItemEdit({ open: false })}>
              취소
            </Button>
            <Button onClick={() => void saveOrderItemEdit()}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={receiveOpen.open}
        onOpenChange={(open) => {
          setReceiveOpen((prev) => ({ ...prev, open }));
          if (!open) {
            setReceiveError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>부분 입고 처리</DialogTitle>
            <DialogDescription>
              {receiveOpen.item ? `${receiveOpen.item.item_name} (잔여: ${formatQty(receiveOpen.item.remaining_qty)}개)` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>입고 수량</Label>
            <Input
              type="number"
              min="1"
              value={receiveQty}
              onChange={(event) => setReceiveQty(event.target.value)}
              onFocus={(event) => event.target.select()}
              autoFocus
            />
            {receiveOpen.item ? (() => {
              const matchedItem = items.find((i) => i.id === receiveOpen.item!.item_id);
              const currentStock = matchedItem != null ? Number(matchedItem.current_stock || 0) : null;
              const enteredQty = Number(receiveQty);
              const validQty = Number.isInteger(enteredQty) && enteredQty > 0;
              if (currentStock != null) {
                return (
                  <p className="text-sm text-muted-foreground">
                    현재고 {currentStock.toLocaleString('ko-KR')}개
                    {validQty ? ` → 입고 후 ${(currentStock + enteredQty).toLocaleString('ko-KR')}개` : ''}
                  </p>
                );
              }
              return null;
            })() : null}
            <Label>메모</Label>
            <Input value={receiveNote} onChange={(event) => setReceiveNote(event.target.value)} />
            {receiveError ? <p className="text-sm text-destructive">{receiveError}</p> : null}
            <p className="text-xs text-muted-foreground">입고 처리 후에는 수정할 수 없습니다.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveOpen({ open: false })}>
              취소
            </Button>
            <Button onClick={() => void saveReceive()}>입고 확정</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function OrderDetailPage() {
  return (
    <React.Suspense>
      <OrderDetailPageContent />
    </React.Suspense>
  );
}
