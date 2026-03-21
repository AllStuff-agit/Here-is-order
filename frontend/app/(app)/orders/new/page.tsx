'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api';
import { PurchaseOrder } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewOrderPage() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  const createDraftAndMove = React.useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const created = await apiPost<PurchaseOrder>('/api/purchase-orders', {
        title: '새 발주서',
        note: null,
        status: 'draft',
      });
      router.replace(`/orders/${created.id}?editMeta=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '새 발주서 생성에 실패했습니다.');
      setLoading(false);
    }
  }, [router]);

  return (
    <div className="section-gap">
      <Card>
        <CardHeader>
          <CardTitle>{loading ? '새 발주서 생성 중...' : '새 발주서 생성'}</CardTitle>
          <CardDescription>
            {loading ? '잠시만 기다려주세요. 발주 상세 페이지로 이동합니다.' : '확인 버튼을 누르면 빈 초안을 만들고 상세 페이지로 이동합니다.'}
          </CardDescription>
        </CardHeader>
        {!loading ? (
          <CardContent className="space-y-3">
            {error ? (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => router.push('/orders')}>
                목록으로
              </Button>
              <Button onClick={() => void createDraftAndMove()}>
                생성하기
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
