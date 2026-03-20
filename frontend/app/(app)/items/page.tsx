'use client';

import * as React from 'react';
import { History, Pencil, Plus, Search, ShieldAlert, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '@/lib/api';
import { ALL_CATEGORY_VALUE, INVENTORY_REFRESH_EVENT } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import { Category, Item, StockTransaction } from '@/lib/types';
import { cn } from '@/lib/utils';

type StockMovement = {
  item_id: number;
  movement_type: 'IN' | 'OUT' | 'ADJUST';
  quantity: number;
  reason: string;
};

type StockDialogState = {
  open: boolean;
  item: Item | null;
  movementType: StockMovement['movement_type'];
  quantity: string;
  reason: string;
};

type LedgerState = {
  open: boolean;
  item: Item | null;
  rows: StockTransaction[];
  loading: boolean;
  error: string;
};

type ItemFormState = {
  name: string;
  categoryId: string;
  spec: string;
  safetyStock: string;
  minStock: string;
  currentStock: string;
  unitPrice: string;
  memo: string;
};


function notifyInventoryStateUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(INVENTORY_REFRESH_EVENT));
}

function initItemForm(item?: Item | null): ItemFormState {
  return {
    name: item?.name || '',
    categoryId: item?.category_id ? String(item.category_id) : '',
    spec: item?.spec || '',
    safetyStock: String(item?.safety_stock || 0),
    minStock: String(item?.min_stock || 0),
    currentStock: String(item?.current_stock || 0),
    unitPrice: String(item?.unit_price || 0),
    memo: item?.memo || '',
  };
}

function num(value: number) {
  return Number(value || 0).toLocaleString('ko-KR');
}

export default function ItemsPage() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [items, setItems] = React.useState<Item[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [q, setQ] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [needReorder, setNeedReorder] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingItem, setEditingItem] = React.useState<Item | null>(null);
  const [form, setForm] = React.useState<ItemFormState>(initItemForm());
  const [formSubmitting, setFormSubmitting] = React.useState(false);
  const [stockSubmitting, setStockSubmitting] = React.useState(false);

  const [stockDialog, setStockDialog] = React.useState<StockDialogState>({
    open: false,
    item: null,
    movementType: 'IN',
    quantity: '1',
    reason: '',
  });
  const [ledger, setLedger] = React.useState<LedgerState>({
    open: false,
    item: null,
    rows: [],
    loading: false,
    error: '',
  });

  const [submitMessage, setSubmitMessage] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<Item | null>(null);
  const submitMessageRef = React.useRef<number | null>(null);

  const loadSeed = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const itemParams = new URLSearchParams();
      if (q) itemParams.set('q', q);
      if (categoryId) itemParams.set('categoryId', categoryId);
      if (needReorder) itemParams.set('needReorder', 'true');

      const [itemsResult, categoryResult] = await Promise.all([
        apiGet<Item[]>(`/api/items${itemParams.toString() ? `?${itemParams.toString()}` : ''}`),
        apiGet<Category[]>('/api/categories'),
      ]);

      setItems(
        (itemsResult || []).map((item) => ({
          ...item,
          unit: String(item.unit || '개'),
        })) as Item[],
      );
      setCategories(categoryResult || []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : '목록을 가져오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [q, categoryId, needReorder, router]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void loadSeed();
    }, 220);
    return () => clearTimeout(timer);
  }, [loadSeed]);

  const closeForm = () => {
    setFormOpen(false);
    setEditingItem(null);
    setForm(initItemForm());
  };

  const openNew = () => {
    setForm(initItemForm());
    setEditingItem(null);
    setFormOpen(true);
  };

  const openEdit = (item: Item) => {
    setEditingItem(item);
    setForm(initItemForm(item));
    setFormOpen(true);
  };

  const onSubmitForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      resetSubmitMessage('품목명은 필수입니다.');
      return;
    }
    setFormSubmitting(true);
    resetSubmitMessage('');
    try {
      const payload = {
        name: form.name.trim(),
        category_id: form.categoryId ? Number(form.categoryId) : null,
        spec: form.spec.trim() || null,
        safety_stock: Number(form.safetyStock || 0),
        min_stock: Number(form.minStock || 0),
        current_stock: Number(form.currentStock || 0),
        unit_price: Number(form.unitPrice || 0),
        memo: form.memo.trim() || null,
      };

      if (editingItem) {
        await apiPatch<Item>(`/api/items/${editingItem.id}`, payload);
      } else {
        await apiPost<Item>('/api/items', payload);
      }
      closeForm();
      await loadSeed();
      notifyInventoryStateUpdated();
      resetSubmitMessage(editingItem ? '품목이 수정되었습니다.' : '품목이 생성되었습니다.');
    } catch (e) {
      resetSubmitMessage(e instanceof Error ? e.message : '저장에 실패했습니다.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const requestDeleteItem = (item: Item) => {
    setDeleteTarget(item);
  };

  const onDeleteItem = async () => {
    if (!deleteTarget) return;
    try {
      await apiDelete(`/api/items/${deleteTarget.id}`);
      await loadSeed();
      notifyInventoryStateUpdated();
      resetSubmitMessage('품목이 삭제되었습니다.');
      setDeleteTarget(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        resetSubmitMessage('미완료 발주서에 포함된 품목은 삭제할 수 없습니다. 발주서를 완료하거나 취소한 후 삭제해주세요.');
      } else {
        resetSubmitMessage(e instanceof Error ? e.message : '삭제에 실패했습니다.');
      }
    }
  };

  const openStockDialog = (item: Item) => {
    setStockDialog({
      open: true,
      item,
      movementType: 'IN',
      quantity: '1',
      reason: '',
    });
  };

  const submitStockAdjust = async () => {
    if (!stockDialog.item || stockSubmitting) return;
    const qty = Number(stockDialog.quantity);
    if (!Number.isInteger(qty) || qty === 0) {
      resetSubmitMessage('수량은 0이 아닌 정수여야 합니다.');
      return;
    }

    setStockSubmitting(true);
    try {
      const payload: StockMovement = {
        item_id: stockDialog.item.id,
        movement_type: stockDialog.movementType,
        quantity: qty,
        reason: stockDialog.reason.trim() || '재고 수동조정',
      };
      await apiPost('/api/stock/adjust', payload);
      setStockDialog((prev) => ({ ...prev, open: false, item: null }));
      resetSubmitMessage('재고가 반영되었습니다.');
      await loadSeed();
      notifyInventoryStateUpdated();
    } catch (e) {
      resetSubmitMessage(e instanceof Error ? e.message : '재고 반영 실패');
    } finally {
      setStockSubmitting(false);
    }
  };

  const openLedger = async (item: Item) => {
    setLedger({ open: true, item, rows: [], loading: true, error: '' });
    try {
      const rows = await apiGet<StockTransaction[]>(`/api/stock/ledger/${item.id}`);
      setLedger((prev) => ({ ...prev, rows, loading: false }));
    } catch (e) {
      setLedger((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : '이력을 가져오지 못했습니다.',
      }));
    }
  };

  const resetSubmitMessage = React.useCallback((message: string) => {
    setSubmitMessage(message);
    if (submitMessageRef.current) {
      window.clearTimeout(submitMessageRef.current);
    }
    if (!message) return;
    submitMessageRef.current = window.setTimeout(() => {
      setSubmitMessage('');
    }, 2200);
  }, []);

  React.useEffect(() => {
    return () => {
      if (submitMessageRef.current) {
        window.clearTimeout(submitMessageRef.current);
      }
    };
  }, []);

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">품목관리</h1>
          <p className="page-subtitle">품목 CRUD와 재고 갱신을 한 번에 처리</p>
        </div>
        <div className="toolbar">
          <Dialog open={formOpen} onOpenChange={setFormOpen}>
            <DialogTrigger asChild>
              <Button onClick={openNew}>
                <Plus className="size-4" />
                품목 추가
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>{editingItem ? '품목 수정' : '품목 추가'}</DialogTitle>
                <DialogDescription>관리자 단일 사용자를 위한 품목 데이터입니다.</DialogDescription>
              </DialogHeader>
              <form onSubmit={onSubmitForm} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="name">품목명</Label>
                  <Input
                    id="name"
                    required
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="category">분류</Label>
                    <Select
                      value={form.categoryId}
                      onValueChange={(value) => setForm((prev) => ({ ...prev, categoryId: value }))}
                    >
                      <SelectTrigger id="category">
                        <SelectValue placeholder="분류를 선택하세요" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category.id} value={String(category.id)}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="spec">규격</Label>
                    <Input
                      id="spec"
                      value={form.spec}
                      onChange={(event) => setForm((prev) => ({ ...prev, spec: event.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="safetyStock">안전재고</Label>
                    <Input
                      id="safetyStock"
                      type="number"
                      min="0"
                      value={form.safetyStock}
                      onChange={(event) => setForm((prev) => ({ ...prev, safetyStock: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="minStock">최소재고</Label>
                    <Input
                      id="minStock"
                      type="number"
                      min="0"
                      value={form.minStock}
                      onChange={(event) => setForm((prev) => ({ ...prev, minStock: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="currentStock">현재고</Label>
                    <Input
                      id="currentStock"
                      type="number"
                      min="0"
                      value={form.currentStock}
                      onChange={(event) => setForm((prev) => ({ ...prev, currentStock: event.target.value }))}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unitPrice">단가 (원)</Label>
                  <Input
                    id="unitPrice"
                    type="number"
                    min="0"
                    value={form.unitPrice}
                    onChange={(event) => setForm((prev) => ({ ...prev, unitPrice: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="memo">메모</Label>
                  <Textarea
                    id="memo"
                    rows={2}
                    value={form.memo}
                    onChange={(event) => setForm((prev) => ({ ...prev, memo: event.target.value }))}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeForm}>
                    취소
                  </Button>
                  <Button type="submit" disabled={formSubmitting}>
                    {formSubmitting ? '저장 중...' : '저장'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>품목 검색/필터</CardTitle>
          <CardDescription>품목명, 규격, 분류명을 검색하고 발주 필요 목록만 추려볼 수 있어요.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="h-9 pl-8"
              placeholder="품목명/규격/분류 검색"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          </label>
          <Select
            value={categoryId}
            onValueChange={(value) => setCategoryId(value === ALL_CATEGORY_VALUE ? '' : value)}
          >
            <SelectTrigger className="h-9 w-full sm:w-48">
              <SelectValue placeholder="전체 분류" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORY_VALUE}>전체 분류</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={needReorder}
              onCheckedChange={(value) => setNeedReorder(Boolean(value))}
            />
            <span>발주 필요만 보기</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {submitMessage ? <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm">{submitMessage}</p> : null}
          {loading ? (
            <div className="space-y-2">
              <div className="h-12 animate-pulse rounded bg-muted" />
              <div className="h-12 animate-pulse rounded bg-muted" />
            </div>
          ) : error ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => void loadSeed()}>
                다시 시도
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {items.length === 0 ? (
                  <p className="data-empty">품목이 없습니다.</p>
                ) : (
                  items.map((item) => {
                    const needOrder = Number(item.current_stock || 0) <= Number(item.safety_stock || 0);
                    const critical = Number(item.current_stock || 0) <= Number(item.min_stock || 0);
                    return (
                      <Card key={item.id} className="border-border/70">
                        <CardContent className="space-y-3 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-medium">{item.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.spec || '규격없음'} · {item.category_name || '분류없음'}
                              </p>
                            </div>
                            {critical ? (
                              <Badge variant="destructive" className="text-xs">
                                <ShieldAlert className="mr-1 size-3" />
                                긴급
                              </Badge>
                            ) : needOrder ? (
                              <Badge variant="secondary" className="text-xs">
                                주의
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">정상</Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <p className="text-muted-foreground">현재고: <span className="font-medium text-foreground">{num(item.current_stock)}개</span></p>
                            <p className="text-muted-foreground">안전재고: <span className="font-medium text-foreground">{num(item.safety_stock)}개</span></p>
                            <p className="text-muted-foreground">최소재고: <span className="font-medium text-foreground">{num(item.min_stock)}개</span></p>
                            <p className="text-muted-foreground">권장입고: <span className="font-semibold text-primary">{num(item.suggested_qty)}개</span></p>
                            <p className="col-span-2 text-muted-foreground">단가: <span className="font-medium text-foreground">{num(item.unit_price)}원</span></p>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" size="sm" onClick={() => openStockDialog(item)}>
                              {needOrder ? <TrendingDown className="size-4" /> : <TrendingUp className="size-4" />}
                              재고
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
                              <Pencil className="size-4" />
                              수정
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => openLedger(item)}>
                              <History className="size-4" />
                              이력
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => requestDeleteItem(item)}>
                              <Trash2 className="size-4" />
                              삭제
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>품목</TableHead>
                      <TableHead>규격</TableHead>
                      <TableHead>분류</TableHead>
                      <TableHead>현재고</TableHead>
                      <TableHead>안전재고</TableHead>
                      <TableHead>최소재고</TableHead>
                      <TableHead>권장입고</TableHead>
                      <TableHead>단가</TableHead>
                      <TableHead className="text-right">상태</TableHead>
                      <TableHead className="text-right">작업</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const needOrder = Number(item.current_stock || 0) <= Number(item.safety_stock || 0);
                      const critical = Number(item.current_stock || 0) <= Number(item.min_stock || 0);
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{item.name}</p>
                              <p className="text-xs text-muted-foreground">{item.memo || '-'}</p>
                            </div>
                          </TableCell>
                          <TableCell>{item.spec || '-'}</TableCell>
                          <TableCell>{item.category_name || '-'}</TableCell>
                          <TableCell>{num(item.current_stock)}개</TableCell>
                          <TableCell>{num(item.safety_stock)}개</TableCell>
                          <TableCell>{num(item.min_stock)}개</TableCell>
                          <TableCell>{num(item.suggested_qty)}개</TableCell>
                          <TableCell>{num(item.unit_price)}원</TableCell>
                          <TableCell className="text-right">
                            {critical ? (
                              <Badge variant="destructive" className="text-xs">
                                <ShieldAlert className="mr-1 size-3" />
                                긴급
                              </Badge>
                            ) : needOrder ? (
                              <Badge variant="secondary" className="text-xs">
                                주의
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">정상</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button variant="outline" size="sm" onClick={() => openStockDialog(item)}>
                                {needOrder ? <TrendingDown className="size-4" /> : <TrendingUp className="size-4" />}
                                재고
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
                                <Pencil className="size-4" />
                                수정
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openLedger(item)}>
                                <History className="size-4" />
                                이력
                              </Button>
                              <Button variant="destructive" size="sm" onClick={() => requestDeleteItem(item)}>
                                <Trash2 className="size-4" />
                                삭제
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                          품목이 없습니다.
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
            <AlertDialogTitle>품목 삭제</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" 품목을 정말 삭제할까요?` : '품목을 삭제할까요?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDeleteItem()}>삭제</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={stockDialog.open}
        onOpenChange={(open) => setStockDialog((prev) => ({ ...prev, open, ...(open ? {} : { item: null }) }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>재고 조정</DialogTitle>
            <DialogDescription>{stockDialog.item ? `${stockDialog.item.name} (${stockDialog.item.unit || '개'})` : ''}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="movementType">조정 구분</Label>
              <Select
                value={stockDialog.movementType}
                onValueChange={(value) =>
                  setStockDialog((prev) => ({ ...prev, movementType: value as StockMovement['movement_type'] }))
                }
              >
                <SelectTrigger id="movementType" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IN">IN(입고 +)</SelectItem>
                  <SelectItem value="OUT">OUT(사용 -)</SelectItem>
                  <SelectItem value="ADJUST">ADJUST(직접 조정)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="quantity">수량</Label>
              <Input
                id="quantity"
                type="number"
                value={stockDialog.quantity}
                onChange={(event) => setStockDialog((prev) => ({ ...prev, quantity: event.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reason">사유</Label>
              <Input
                id="reason"
                value={stockDialog.reason}
                onChange={(event) => setStockDialog((prev) => ({ ...prev, reason: event.target.value }))}
                placeholder="조정 사유"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStockDialog((prev) => ({ ...prev, open: false }))}>
              취소
            </Button>
            <Button onClick={() => void submitStockAdjust()} disabled={stockSubmitting}>
              {stockSubmitting ? '처리 중...' : '저장'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ledger.open}
        onOpenChange={(open) => setLedger((prev) => ({ ...prev, open, ...(open ? {} : { item: null }) }))}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>재고 이력</DialogTitle>
            <DialogDescription>{ledger.item ? ledger.item.name : ''}</DialogDescription>
          </DialogHeader>
          {ledger.loading ? (
            <p className="rounded bg-muted px-3 py-4 text-sm text-muted-foreground">불러오는 중...</p>
          ) : ledger.error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{ledger.error}</p>
          ) : ledger.rows.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">이력이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>일시</TableHead>
                    <TableHead>구분</TableHead>
                    <TableHead>수량</TableHead>
                    <TableHead>사유</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatDateTime(row.created_at)}</TableCell>
                      <TableCell>
                        <Badge variant={row.movement_type === 'IN' ? 'secondary' : 'destructive'}>
                          {row.movement_type}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn(row.quantity > 0 ? 'text-primary' : 'text-destructive')}>
                        {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
                      </TableCell>
                      <TableCell>{row.reason || '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
