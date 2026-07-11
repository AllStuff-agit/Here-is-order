# Dashboard Quick Order Implementation Plan

> **상태: 구현 완료된 역사 문서.** 이 문서는 더 이상 실행 계획이 아닙니다. 현재 동작과 API 계약은 `frontend/app/(app)/dashboard/page.tsx`, `src/index.ts`, `docs/design/api-spec-v1.md`를 기준으로 확인하세요.
>
> 구현은 이 초안 이후 발전했습니다. 현재는 진행 중 발주가 부족분을 이미 충당한 품목을 선택하지 않으며, 생성한 발주서를 초안으로 저장하거나 즉시 확정할 수 있습니다. 아래 코드 조각은 최초 구현 당시의 설계 기록으로 보존합니다.

**Goal:** 대시보드의 발주 필요 품목 테이블에 "바로 발주" 버튼을 추가하고, 클릭 시 모달이 열려 품목을 선택(기본 전체 선택)·수량 조정 후 즉시 발주서를 생성하는 기능.

**Architecture:** `QuickOrderDialog` 컴포넌트를 `dashboard/page.tsx`와 같은 파일에 추가. 이미 존재하는 `POST /api/purchase-orders/with-items` 엔드포인트를 그대로 사용. 발주 성공 시 생성된 발주서 상세 페이지(`/orders/{id}`)로 이동.

**Tech Stack:** Next.js 16 (App Router), React 19, shadcn/ui (Dialog, Checkbox, Table, Input), `apiPost` from `@/lib/api`, `useRouter` from `next/navigation`

---

## File Map

| 파일 | 변경 내용 |
|------|---------|
| `frontend/app/(app)/dashboard/page.tsx` | `QuickOrderDialog` 컴포넌트 추가, 발주 필요 품목 카드에 버튼 추가 |

새로 만들 파일 없음. 기존 엔드포인트(`POST /api/purchase-orders/with-items`) 그대로 사용.

---

## Task 1: QuickOrderDialog 컴포넌트 구현

**Files:**
- Modify: `frontend/app/(app)/dashboard/page.tsx`

### QuickOrderDialog 스펙

**Props:**
```ts
type QuickOrderDialogProps = {
  items: DashboardData['low_stock_items'];  // low_stock_items 배열
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (orderId: number) => void;
};
```

**내부 상태:**
```ts
type RowState = {
  selected: boolean;
  qty: string; // 입력값 (string → 제출 시 parseInt)
};
// key: item.id
const [rows, setRows] = useState<Record<number, RowState>>({});
const [title, setTitle] = useState('');
const [submitting, setSubmitting] = useState(false);
const [error, setError] = useState('');
```

**초기화 로직 (`useEffect` on `items` + `open`):**
- `open`이 true가 되면:
  - `rows`: 모든 item을 `{ selected: true, qty: String(item.suggested_qty || 1) }` 로 초기화
  - `title`: `긴급 발주 ${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}` (예: "긴급 발주 3월 20일")
  - `error`: `''`

**제출 로직:**
```ts
async function handleSubmit() {
  const selectedItems = items
    .filter(item => rows[item.id]?.selected)
    .map(item => ({
      item_id: item.id,
      ordered_qty: Math.max(1, parseInt(rows[item.id]?.qty || '1', 10) || 1),
      memo: null,
    }));

  if (!selectedItems.length) {
    setError('품목을 1개 이상 선택해주세요.');
    return;
  }
  if (!title.trim()) {
    setError('발주명을 입력해주세요.');
    return;
  }

  setSubmitting(true);
  setError('');
  try {
    const order = await apiPost<{ id: number }>('/api/purchase-orders/with-items', {
      title: title.trim(),
      items: selectedItems,
    });
    onSuccess(order.id);
  } catch (err) {
    setError(err instanceof Error ? err.message : '발주 생성에 실패했습니다.');
  } finally {
    setSubmitting(false);
  }
}
```

**UI 구조:**
```
Dialog
  DialogHeader
    DialogTitle: "바로 발주"
    DialogDescription: "선택한 품목으로 발주서를 즉시 생성합니다."

  DialogContent (space-y-4)
    // 발주명 입력
    Label: "발주명"
    Input: value={title}, onChange, disabled={submitting}, autoFocus

    // 전체 선택 체크박스
    div.flex.items-center.gap-2
      Checkbox: checked={allSelected}, onCheckedChange={toggleAll}
      Label: "전체 선택 ({선택된수}/{전체수})"

    // 품목 테이블 (스크롤 가능)
    div.max-h-[40vh].overflow-y-auto
      Table
        TableHeader: 선택 | 품목명 | 현재고 | 권장입고 (수량 수정 가능)
        TableBody:
          foreach item:
            TableRow (opacity-50 if !selected)
              TableCell: Checkbox selected
              TableCell: item.name + (item.spec if exists, 작은 텍스트)
              TableCell: {current_stock}개
              TableCell: Input type="number" min="1" value={rows[id].qty}
                         disabled={!rows[id].selected || submitting}

    // 에러 메시지
    if (error): p.text-sm.text-destructive {error}

  DialogFooter
    Button variant="outline" onClick={close} disabled={submitting}: 취소
    Button onClick={handleSubmit} disabled={submitting || no selected}:
      {submitting ? '발주 생성 중...' : `발주서 생성 (${selectedCount}개 품목)`}
```

**전체 선택 체크박스 상태:**
- `allSelected`: 모든 행의 `selected === true`
- `someSelected`: 일부만 선택
- `onCheckedChange(true)`: 모든 행 선택
- `onCheckedChange(false)`: 모든 행 해제
- `checked` prop: `allSelected ? true : someSelected ? 'indeterminate' : false`

---

- [x] **Step 1.1: import 추가**

`dashboard/page.tsx` 상단에 필요한 import 추가:

```ts
import { apiPost, ApiError } from '@/lib/api';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ShoppingCart } from 'lucide-react';
```

(이미 import된 것: `Input`, `Button`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow` — 중복 추가 금지)

- [x] **Step 1.2: RowState 타입 및 QuickOrderDialog 컴포넌트 작성**

`MetricCard` 컴포넌트 정의 **아래**, `DashboardPage` 함수 **위**에 삽입:

```tsx
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

  // open될 때마다 상태 초기화
  React.useEffect(() => {
    if (!open) return;
    const initial: Record<number, RowState> = {};
    for (const item of items) {
      initial[item.id] = { selected: true, qty: String(Math.max(1, Number(item.suggested_qty || 1))) };
    }
    setRows(initial);
    setTitle(
      `긴급 발주 ${new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}`
    );
    setError('');
  }, [open, items]);

  const selectedCount = items.filter((item) => rows[item.id]?.selected).length;
  const allSelected = selectedCount === items.length;
  const someSelected = selectedCount > 0 && !allSelected;

  function toggleAll(checked: boolean | 'indeterminate') {
    const next = checked === true;
    setRows((prev) => {
      const updated = { ...prev };
      for (const item of items) {
        updated[item.id] = { ...updated[item.id], selected: next };
      }
      return updated;
    });
  }

  function toggleRow(id: number) {
    setRows((prev) => ({
      ...prev,
      [id]: { ...prev[id], selected: !prev[id]?.selected },
    }));
  }

  function setQty(id: number, value: string) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], qty: value } }));
  }

  async function handleSubmit() {
    const selectedItems = items
      .filter((item) => rows[item.id]?.selected)
      .map((item) => ({
        item_id: item.id,
        ordered_qty: Math.max(1, parseInt(rows[item.id]?.qty || '1', 10) || 1),
        memo: null,
      }));

    if (!selectedItems.length) {
      setError('품목을 1개 이상 선택해주세요.');
      return;
    }
    if (!title.trim()) {
      setError('발주명을 입력해주세요.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const order = await apiPost<{ id: number; title: string }>('/api/purchase-orders/with-items', {
        title: title.trim(),
        items: selectedItems,
      });
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
                {items.map((item) => {
                  const row = rows[item.id];
                  const selected = row?.selected ?? true;
                  return (
                    <TableRow
                      key={item.id}
                      className={selected ? '' : 'opacity-40'}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleRow(item.id)}
                          disabled={submitting}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.name}</div>
                        {item.category_name ? (
                          <div className="text-xs text-muted-foreground">{item.category_name}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {Number(item.current_stock || 0).toLocaleString('ko-KR')}개
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min="1"
                          value={row?.qty ?? '1'}
                          onChange={(e) => setQty(item.id, e.target.value)}
                          disabled={!selected || submitting}
                          className="h-8 w-20 text-right"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            취소
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || selectedCount === 0}>
            {submitting ? '생성 중...' : `발주서 생성 (${selectedCount}개 품목)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [x] **Step 1.3: DashboardPage에 모달 상태 추가 및 버튼 연결**

`DashboardPage` 함수 안에 상태 추가:
```ts
const [quickOrderOpen, setQuickOrderOpen] = React.useState(false);
```

발주 필요 품목 카드의 `CardHeader` 부분을 수정. 기존의 "전체 보기" 버튼 옆에 "바로 발주" 버튼 추가:

**수정 전:**
```tsx
<Button variant="outline" onClick={() => router.push('/alerts')}>
  전체 보기
</Button>
```

**수정 후:**
```tsx
<div className="flex gap-2">
  <Button variant="outline" onClick={() => router.push('/alerts')}>
    전체 보기
  </Button>
  {data.low_stock_items.length > 0 ? (
    <Button size="sm" onClick={() => setQuickOrderOpen(true)}>
      <ShoppingCart className="size-4" />
      바로 발주
    </Button>
  ) : null}
</div>
```

`DashboardPage` return 내부 최하단(빈 상태 처리 후)에 `QuickOrderDialog` 마운트:

```tsx
<QuickOrderDialog
  items={data.low_stock_items}
  open={quickOrderOpen}
  onOpenChange={setQuickOrderOpen}
  onSuccess={(orderId) => {
    setQuickOrderOpen(false);
    router.push(`/orders/${orderId}`);
  }}
/>
```

- [x] **Step 1.4: TypeScript 타입 체크**

```bash
cd /home/wl/workspace/projects/hereisorder/frontend && npx tsc --noEmit
```

Expected: 출력 없음 (에러 없음)

- [x] **Step 1.5: 동작 검증**

http://localhost:3000/dashboard 접속 후:
1. 발주 필요 품목 카드에 "바로 발주" 버튼 노출 확인
2. 클릭 → 모달 열림, 발주명 자동 입력, 전체 선택 확인
3. 일부 품목 체크 해제 → 해당 행 흐려짐 확인
4. 수량 변경 가능 확인
5. "발주서 생성" 클릭 → `/orders/{id}` 이동 확인
6. 발주 필요 품목이 0개일 때 버튼 미표시 확인

- [x] **Step 1.6: 커밋**

```bash
git add frontend/app/\(app\)/dashboard/page.tsx
git commit -m "feat: add quick order dialog to dashboard for low-stock items"
```
