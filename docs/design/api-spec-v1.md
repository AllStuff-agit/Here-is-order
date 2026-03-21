# API 설계 v1 (카페 발주 관리)

모든 API는 JSON + 세션 기반 인증(관리자 1명). 추후 인증 방식은 Cloudflare Session/Cookie 기반으로 고정.

## 공통 응답

```ts
{ "ok": true, "data": any }
{ "ok": false, "error": { "code": "ERR_CODE", "message": "설명" } }
```

## 인증

- `POST /api/auth/login`
  - body: `{ username, password }`
  - 응답: `{ token? | sessionToken }` (운영 설계에 따라)
- `POST /api/auth/logout`

## 대시보드

- `GET /api/dashboard`

응답:

```json
{
  "today": "2026-03-02",
  "low_stock_count": 12,
  "low_stock_items": [
    { "item_id": 3, "name": "레몬", "current_stock": 3, "safety_stock": 5, "suggested_qty": 2 }
  ],
  "monthly_summary": {
    "orders_open": 4,
    "open_qty": 120,
    "received_today": 35
  }
}
```

## 품목(Category + Items)

- `GET /api/categories`
- `POST /api/categories`
- `PATCH /api/categories/:id`
- `DELETE /api/categories/:id` (soft-delete)

- `GET /api/items`
  - query: `q`(검색), `categoryId`, `needReorder=true`, `includeDeleted=true|false`
- `POST /api/items`
- `PATCH /api/items/:id`
- `DELETE /api/items/:id` (soft-delete)

## 재고 조정

- `POST /api/stock/adjust`

요청:
```json
{
  "item_id": 3,
  "movement_type": "IN|OUT|ADJUST",
  "quantity": 20,
  "reason": "발주 입고"
}
```

응답에 `items.current_stock`, `stock_transactions` 신규 row를 반환.

- `GET /api/stock/ledger/:item_id`
  - 최근 변경 내역 조회

## 발주 관리

- `GET /api/purchase-orders`
  - query: `status`, `from`, `to`, `q`
- `POST /api/purchase-orders`
  - `{ title, note, status='draft' }`
- `PATCH /api/purchase-orders/:id`
  - 상태/제목/메모 수정
- `POST /api/purchase-orders/:id/items`
  - `{ item_id, ordered_qty, memo }`
- `PATCH /api/purchase-orders/:id/items/:item_id`
  - `{ ordered_qty?, memo? }`
- `POST /api/purchase-orders/:id/items/:item_id/receive`
  - `{ qty, received_at?, note? }`

- `GET /api/purchase-orders/:id`

응답의 `items`는 `ordered_qty`, `received_qty`, `remaining_qty`, 상태 계산값 포함

## 감사 로그

- `GET /api/audit-logs`
  - query: `entity_type`, `entity_id`, `from`, `to`, `action`, `actor`

## 운영 메모
- 삭제는 모두 소프트딜리트(`is_deleted=1`, `deleted_at`)
- 단일 관리자라서 기본적으로 owner 권한 고정
