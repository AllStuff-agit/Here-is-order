'use client';

import * as React from 'react';
import { ArrowRightCircle, Bell, ClipboardList, PackageCheck, PackageSearch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet, ApiError } from '@/lib/api';
import { ALL_CATEGORY_VALUE } from '@/lib/constants';
import type { Category, Item } from '@/lib/types';

function num(value: number) {
  return Number(value || 0).toLocaleString('ko-KR');
}

export default function AlertsPage() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [keyword, setKeyword] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [onlyCritical, setOnlyCritical] = React.useState(false);
  const [orders, setOrders] = React.useState<Item[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rows, categoryRows] = await Promise.all([
        apiGet<Item[]>('/api/items?needReorder=true&includeDeleted=false'),
        apiGet<Category[]>('/api/categories'),
      ]);
      setOrders((rows || []).map((row) => ({ ...row, unit: String(row.unit || '개') })));
      setCategories(categoryRows || []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : '알림 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const filtered = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return orders
      .filter((item) => {
        if (categoryId && String(item.category_id || '') !== categoryId) return false;
        if (!q) return true;
        return (
          item.name.toLowerCase().includes(q) ||
          (item.spec || '').toLowerCase().includes(q) ||
          (item.category_name || '').toLowerCase().includes(q)
        );
      })
      .filter((item) => {
        if (!onlyCritical) return true;
        return Number(item.current_stock || 0) <= Number(item.min_stock || 0);
      });
  }, [orders, categoryId, keyword, onlyCritical]);

  const urgentCount = orders.filter((item) => Number(item.current_stock || 0) <= Number(item.min_stock || 0)).length;

  const goToOrderDraft = (item: Item) => {
    const qty = Math.max(1, Number(item.suggested_qty || 1));
    const query = new URLSearchParams({
      prefillItemId: String(item.id),
      prefillQty: String(qty),
      from: 'alerts',
    });
    router.push(`/orders?${query.toString()}`);
  };

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">발주 알림</h1>
          <p className="page-subtitle">안전재고 이하 품목을 중심으로 누락 없이 확인합니다.</p>
        </div>
        <div className="toolbar">
          <Button variant="outline" onClick={() => router.push('/orders')}>
            <ClipboardList className="size-4" />
            발주로 이동
          </Button>
          <Button variant="outline" onClick={() => router.push('/items')}>
            <PackageSearch className="size-4" />
            품목으로 이동
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>알림 집계</CardTitle>
            <CardDescription>
              총 {orders.length}개 중 <strong>{urgentCount}개</strong>가 즉시 필요입니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="toolbar">
            <Badge variant={urgentCount > 0 ? 'destructive' : 'secondary'}>
              <Bell className="size-3" />
              즉시필요 {urgentCount}개
            </Badge>
            <Badge variant="outline">
              <PackageCheck className="size-3" />
              정렬 대상 {orders.length}개
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>필터</CardTitle>
            <CardDescription>검색어/분류/임계치 기준으로 알림 목록을 좁힙니다.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              className="h-9"
              placeholder="품목명/규격/분류 검색"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              value={categoryId}
              onValueChange={(value) => setCategoryId(value === ALL_CATEGORY_VALUE ? '' : value)}
            >
              <SelectTrigger className="h-9">
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
                id="onlyCritical"
                checked={onlyCritical}
                onCheckedChange={(value) => setOnlyCritical(Boolean(value))}
              />
              <Label htmlFor="onlyCritical">매우 긴급(현재고 ≤ 최소재고)만 보기</Label>
            </label>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="space-y-2 py-2">
              <div className="h-12 animate-pulse rounded bg-muted" />
              <div className="h-12 animate-pulse rounded bg-muted" />
            </div>
          ) : error ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => void loadData()}>
                다시 시도
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="data-empty">현재 조건에 해당하는 발주 알림이 없습니다.</p>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {filtered.map((item) => {
                  const isCritical = Number(item.current_stock || 0) <= Number(item.min_stock || 0);
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
                          <Badge variant={isCritical ? 'destructive' : 'secondary'}>
                            {isCritical ? '긴급' : '주의'}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <p className="text-muted-foreground">현재고: <span className="font-medium text-foreground">{num(item.current_stock)}개</span></p>
                          <p className="text-muted-foreground">안전재고: <span className="font-medium text-foreground">{num(item.safety_stock)}개</span></p>
                          <p className="text-muted-foreground">최소재고: <span className="font-medium text-foreground">{num(item.min_stock)}개</span></p>
                          <p className="text-muted-foreground">권장입고: <span className="font-semibold text-primary">{num(item.suggested_qty)}개</span></p>
                        </div>
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => goToOrderDraft(item)}
                        >
                          <ArrowRightCircle className="size-4" />
                          발주 초안으로 추가
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
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
                      <TableHead className="text-right">상태</TableHead>
                      <TableHead className="text-right">작업</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((item) => {
                      const isCritical = Number(item.current_stock || 0) <= Number(item.min_stock || 0);
                      return (
                        <TableRow key={item.id}>
                          <TableCell>{item.name}</TableCell>
                          <TableCell>{item.spec || '-'}</TableCell>
                          <TableCell>{item.category_name || '-'}</TableCell>
                          <TableCell>{num(item.current_stock)}개</TableCell>
                          <TableCell>{num(item.safety_stock)}개</TableCell>
                          <TableCell>{num(item.min_stock)}개</TableCell>
                          <TableCell>{num(item.suggested_qty)}개</TableCell>
                          <TableCell className="text-right">
                            <Badge variant={isCritical ? 'destructive' : 'secondary'}>
                              {isCritical ? '긴급' : '주의'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => goToOrderDraft(item)}
                            >
                              <ArrowRightCircle className="size-4" />
                              발주초안
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
