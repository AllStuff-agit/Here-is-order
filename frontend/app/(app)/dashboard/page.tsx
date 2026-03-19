'use client';

import * as React from 'react';
import { ChevronDown, Minus, PackageSearch, ReceiptText, TrendingDown, TrendingUp, Warehouse } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiGet, ApiError } from '@/lib/api';
import type { DashboardData } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
          <div className="metric-grid">
            <MetricCard
              title="발주 필요 품목"
              value={data.low_stock_count}
              description={`임계치 미만 품목 (${from} ~ ${to})`}
              tone={data.low_stock_count >= 8 ? 'destructive' : 'default'}
            />
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
            <MetricCard
              title="최근 입고 수량"
              value={data.monthly_summary.received_qty}
              description={`${data.monthly_summary.period_from} ~ ${data.monthly_summary.period_to}`}
            />
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>발주 필요 품목</CardTitle>
                  <CardDescription>현재고가 안전재고보다 낮은 항목입니다.</CardDescription>
                </div>
                <Button variant="outline" onClick={() => router.push('/alerts')}>
                  전체 보기
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {data.low_stock_items.length === 0 ? (
                <p className="data-empty">현재 발주가 필요한 품목이 없습니다.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>품목명</TableHead>
                        <TableHead>현재고</TableHead>
                        <TableHead>안전재고</TableHead>
                        <TableHead>권장 입고</TableHead>
                        <TableHead className="text-right">상태</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.low_stock_items.slice(0, 8).map((item) => {
                        const isCritical =
                          Number(item.current_stock || 0) <= Number(item.min_stock);
                        return (
                          <TableRow key={item.id}>
                            <TableCell>{item.name}</TableCell>
                            <TableCell>{Number(item.current_stock || 0).toLocaleString('ko-KR')}개</TableCell>
                            <TableCell>{Number(item.safety_stock || 0).toLocaleString('ko-KR')}개</TableCell>
                            <TableCell>{Number(item.suggested_qty || 0).toLocaleString('ko-KR')}개</TableCell>
                            <TableCell className="text-right">
                              <Badge variant={isCritical ? 'destructive' : 'secondary'}>
                                {isCritical ? '임계치 미만' : '주의'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">바로가기</CardTitle>
                <CardDescription>자주 쓰는 업무로 바로 이동</CardDescription>
              </CardHeader>
              <CardContent className="toolbar">
                <Button variant="outline" onClick={() => router.push('/items')}>
                  <PackageSearch className="size-4" />
                  품목관리로 이동
                </Button>
                <Button variant="outline" onClick={() => router.push('/orders')}>
                  <ReceiptText className="size-4" />
                  발주관리로 이동
                </Button>
                <Button variant="outline" onClick={() => router.push('/alerts')}>
                  <Warehouse className="size-4" />
                  알림으로 이동
                </Button>
              </CardContent>
            </Card>

            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">알림 요약</CardTitle>
                <CardDescription>최근 기간 기준 발주 알림 상태</CardDescription>
              </CardHeader>
              <CardContent className="toolbar">
                <Badge variant={data.low_stock_count > 0 ? 'destructive' : 'secondary'}>
                  발주 필요 {data.low_stock_count}건
                </Badge>
                <Badge variant="outline">
                  미입고 발주 {Number(data.monthly_summary.orders_open).toLocaleString('ko-KR')}건
                </Badge>
                <Badge variant="secondary">
                  안전재고 임계치 계산 기준: 현재고 ≤ 안전재고
                </Badge>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
