# API 설계 v1 (카페 발주 관리)

구현 기준: `src/index.ts`

인증 방식: 브라우저 same-origin `HttpOnly` 세션 쿠키

## 1. 공통 계약

성공과 실패는 항상 JSON envelope로 반환합니다.

```json
{ "ok": true, "data": {} }
```

```json
{
  "ok": false,
  "error": {
    "code": "ERR_CODE",
    "message": "설명"
  }
}
```

- 공개 엔드포인트: `GET /health`, `POST /api/auth/login`
- 그 외 `/api/*`: 유효한 세션 필요. 없으면 `401 UNAUTHORIZED`
- 역할: `admin | staff`
- 관리자 전용 API에 staff가 접근하면 `403 FORBIDDEN`
- 로그인 성공 시 JSON token을 반환하지 않습니다. `isorder_sid` 쿠키를 설정합니다.
- 세션 쿠키: `HttpOnly`, `SameSite=Strict`, `Path=/`, 30일 만료, HTTPS에서는 `Secure`

대표 상태 코드는 `200`, 생성 `201`, 입력 오류 `400`, 미인증 `401`, 권한 없음 `403`, 찾을 수 없음 `404`, 중복/동시성 충돌 `409`입니다.

## 2. 인증과 사용자

### 인증

#### `POST /api/auth/login`

요청:

```json
{ "username": "admin", "password": "secret" }
```

성공 응답의 `data`:

```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "name": "관리자",
    "role": "admin"
  }
}
```

#### `POST /api/auth/logout`

현재 세션을 삭제하고 쿠키를 만료시킵니다.

```json
{ "loggedOut": true }
```

### 사용자

| Method | Path | 권한 | 요청 | 성공 `data` |
| --- | --- | --- | --- | --- |
| GET | `/api/users/me` | 로그인 | - | `{ id, username, name, role }` |
| PATCH | `/api/users/me/password` | 로그인 | `{ current_password, new_password }` | `{ ok: true }` |
| GET | `/api/users` | admin | - | `User[]` |
| POST | `/api/users` | admin | `{ username, password, name?, role? }` | 생성된 `User` |
| PATCH | `/api/users/:id/password` | admin | `{ new_password }` | `{ ok: true }` |

`POST /api/users`의 `role` 기본값은 `staff`이며, 비밀번호는 6자 이상이어야 합니다. 사용자 목록/생성 응답의 `User`는 다음 필드만 포함합니다.

```json
{
  "id": 2,
  "username": "staff-1",
  "name": "직원",
  "role": "staff",
  "is_active": 1,
  "created_at": "2026-07-11 00:00:00"
}
```

- 내 비밀번호를 변경하면 현재 요청에 사용한 세션만 유지하고 같은 사용자의 다른 세션은 모두 삭제합니다.
- 관리자가 다른 사용자의 비밀번호를 초기화하면 대상 사용자의 기존 세션을 모두 삭제하므로 새 비밀번호로 다시 로그인해야 합니다.

## 3. 카테고리와 품목

### 카테고리

| Method | Path | 요청/Query | 성공 `data` |
| --- | --- | --- | --- |
| GET | `/api/categories` | `includeDeleted=true|false` | `{ id, name, description }[]` |
| POST | `/api/categories` | `{ name, description? }` | 생성된 카테고리 |
| PATCH | `/api/categories/:id` | `{ name?, description? }` | 수정된 카테고리 |
| DELETE | `/api/categories/:id` | - | `{ deleted: true }` |

활성 품목이 속한 카테고리는 삭제할 수 없습니다.

### 품목 목록

`GET /api/items`

Query:

- `q`: 품목명/spec/카테고리명 검색
- `categoryId`: 카테고리 필터
- `needReorder=true`: 안전재고가 1 이상이고 `current_stock < safety_stock`인 품목
- `includeDeleted=true|false`: soft-delete 품목 포함 여부

각 목록 행:

```json
{
  "id": 3,
  "category_id": 1,
  "category_name": "과일",
  "name": "레몬",
  "spec": null,
  "unit": "개",
  "safety_stock": 5,
  "min_stock": 0,
  "current_stock": 2,
  "unit_price": 1000,
  "memo": null,
  "created_at": "2026-07-11 00:00:00",
  "updated_at": "2026-07-11 00:00:00",
  "suggested_qty": 1
}
```

추천수량 계산:

```text
outstanding_qty =
  SUM(order_items.ordered_qty - order_items.received_qty)
  WHERE order/item이 삭제되지 않았고 order.status가 canceled/fully_received가 아님

suggested_qty =
  MAX(0, safety_stock - current_stock - outstanding_qty)
```

따라서 부족재고 후보이더라도 이미 진행 중인 발주가 부족분을 충당하면 `suggested_qty`는 0일 수 있습니다.

### 품목 변경

| Method | Path | 요청 | 성공 `data` |
| --- | --- | --- | --- |
| POST | `/api/items` | `{ category_id?, name, spec?, safety_stock?, min_stock?, current_stock?, unit_price?, memo? }` | 생성된 품목 |
| PATCH | `/api/items/:id` | `{ category_id?, name?, spec?, safety_stock?, min_stock?, unit_price?, memo? }` | 수정된 품목 |
| DELETE | `/api/items/:id` | - | `{ deleted: true }` |

- 단위는 `개`로 고정합니다.
- 수량/단가는 0 이상의 정수입니다.
- 생성 시 `current_stock > 0`이면 품목, `ADJUST` 원장(`reason: "초기 재고"`), 감사로그를 하나의 D1 batch에서 생성합니다. `current_stock = 0`이면 초기 원장 row는 만들지 않습니다.
- `PATCH /api/items/:id`에 `current_stock`을 보내면 `400 INVENTORY_LEDGER_REQUIRED`입니다. 현재고는 재고 조정 API를 사용합니다.
- 진행 중 발주에 포함된 품목은 삭제할 수 없습니다.

## 4. 재고

### `POST /api/stock/adjust`

요청:

```json
{
  "item_id": 3,
  "movement_type": "IN",
  "quantity": 20,
  "reason": "실사 반영"
}
```

수량 의미:

| movement_type | 요청 `quantity` | 원장 `quantity` |
| --- | --- | --- |
| `IN` | 추가할 양수 | 양수 delta |
| `OUT` | 차감할 양수 | 음수 delta |
| `ADJUST` | 0 이상의 목표 절대재고 | 목표값 - 변경 전 현재고 |

- 변경 후 재고는 음수가 될 수 없습니다.
- 임의 재고 조정에 `order_item_id`를 보낼 수 없습니다. 발주 입고는 전용 receive API를 사용합니다.
- 품목 현재고, 재고 원장, 감사로그는 하나의 D1 batch에서 갱신됩니다.

성공 응답의 `data`는 신규 원장 row가 아니라 변경된 품목을 감싼 객체입니다.

```json
{
  "item": {
    "id": 3,
    "current_stock": 22
  }
}
```

실제 `item`에는 품목의 공개 DB 필드가 함께 포함됩니다.

### `GET /api/stock/ledger/:item_id`

Query: `limit`(기본 100)

성공 `data`:

```json
[
  {
    "id": 10,
    "item_id": 3,
    "movement_type": "IN",
    "quantity": 20,
    "reason": "실사 반영",
    "created_at": "2026-07-11 00:00:00"
  }
]
```

## 5. 대시보드

`GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD`

`from`과 `to`를 생략하면 오늘을 포함한 최근 30일을 사용합니다.

성공 응답의 `data`:

```json
{
  "today": "2026-07-11",
  "low_stock_count": 1,
  "low_stock_items": [
    {
      "id": 3,
      "name": "레몬",
      "unit": "개",
      "current_stock": 2,
      "safety_stock": 5,
      "min_stock": 0,
      "category_name": "과일",
      "suggested_qty": 1
    }
  ],
  "item_count": 148,
  "category_count": 33,
  "monthly_summary": {
    "period_from": "2026-06-12",
    "period_to": "2026-07-11",
    "orders_open": 4,
    "open_qty": 120,
    "received_qty": 35
  }
}
```

부족재고 기준과 추천수량 공식은 `GET /api/items?needReorder=true`와 같습니다.

## 6. 발주

발주 API의 성공 `data` projection은 Worker가 직렬화하기 전과 브라우저 fetch Adapter가 envelope를 decode한 후에 포터블 `@here-is-order/http-contract` 런타임 schema로 검증합니다. 이 계약 module은 발주 path, 성공 projection, envelope, 브라우저 요청 type을 공유하지만 raw Hono 요청의 coercion과 validation 순서는 여전히 Worker Adapter가 소유합니다. 따라서 기존 HTTP status, error code·message, legacy coercion, 아래의 nullable 재조회 race는 변하지 않습니다.

발주 상태:

```text
draft | ordered | partially_received | fully_received | canceled
```

- 생성은 항상 `draft`입니다.
- 항목이 하나 이상 있는 초안만 `ordered`로 확정할 수 있습니다.
- `partially_received`와 `fully_received`는 receive API가 누적 입고량을 바탕으로 자동 설정합니다.
- 취소는 입고 전 `draft` 또는 `ordered`에서만 허용합니다.
- 확정된 발주를 `draft`로 되돌리거나 `canceled` / `fully_received` 상태를 다시 열 수 없습니다.
- 발주 항목 추가/수정과 발주서 soft-delete는 `draft`에서만 가능합니다.

### 발주서

| Method | Path | 요청/Query | 성공 `data` |
| --- | --- | --- | --- |
| GET | `/api/purchase-orders` | `status?, from?, to?, q?` | `PurchaseOrderSummary[]` |
| POST | `/api/purchase-orders` | `{ title, note?, status?: "draft" }` | `PurchaseOrderRow \| null` |
| POST | `/api/purchase-orders/with-items` | `{ title, note?, status?: unknown, items: OrderItemInput[] }` | `PurchaseOrderRow \| null` |
| GET | `/api/purchase-orders/:id` | - | 발주서 + `items` (`PurchaseOrderDetail`) |
| PATCH | `/api/purchase-orders/:id` | `{ title?, note?, external_order_ref?, status? }` | `PurchaseOrderRow \| null` |
| DELETE | `/api/purchase-orders/:id` | - | `{ deleted: true }` |

생성/수정/입고 응답의 공개 발주서 row는 `{ id, title, status, order_date, external_order_ref, note, is_deleted, deleted_at, created_at, updated_at }`입니다. 상세의 `PurchaseOrderDetail`은 이 row에 top-level `ordered_qty`, `received_qty`, `items`를 더합니다.

- `GET /api/purchase-orders/:id`는 200일 때 항상 non-null `PurchaseOrderDetail`을 반환하고, 활성 발주서가 없으면 404를 반환합니다.
- `PurchaseOrderDetail.ordered_qty`와 `PurchaseOrderDetail.received_qty`는 각각 상세에 포함된 활성 `items`의 `ordered_qty`와 `received_qty` 합계입니다. 계약 schema는 top-level 합계와 항목 합계가 다르면 성공 응답을 거부합니다.
- 생성과 PATCH는 DB 변경 성공 후 legacy 순차 재조회 사이에 대상 row가 사라지는 race를 보존하므로 드물게 200/201의 `data`가 `null`일 수 있습니다. 일반적인 미존재 성공을 뜻하지 않습니다.
- `POST /api/purchase-orders/with-items`의 `status`는 어떤 JSON 값이든 선택적으로 받을 수 있지만 무시하며, 발주서는 항상 `draft`로 생성합니다.

목록의 `PurchaseOrderSummary`:

```json
{
  "id": 12,
  "title": "7월 2주 발주",
  "status": "ordered",
  "order_date": "2026-07-11",
  "external_order_ref": null,
  "note": null,
  "created_at": "2026-07-11 00:00:00",
  "updated_at": "2026-07-11 00:00:00",
  "ordered_qty": 20,
  "received_qty": 5
}
```

`POST /api/purchase-orders/with-items` 요청 예:

```json
{
  "title": "7월 2주 발주",
  "note": null,
  "items": [
    { "item_id": 3, "ordered_qty": 10, "memo": null },
    { "item_id": 4, "ordered_qty": 5, "memo": "박스 단위 확인" }
  ]
}
```

- 모든 행의 `item_id`는 활성 품목이어야 하고 `ordered_qty`는 1 이상의 정수여야 합니다.
- 한 행이라도 잘못되면 전체 요청을 거부하고 발주서/항목을 하나도 만들지 않습니다.
- 같은 `item_id`가 여러 번 나오면 수량을 합쳐 활성 발주 항목 하나로 만듭니다.
- 발주서, 항목, 감사로그는 하나의 D1 batch에서 생성됩니다.
- 성공 `data`가 `null`이 아니면 생성된 발주서 row입니다. 상세 항목이 필요하면 `GET /api/purchase-orders/:id`를 호출합니다.

상세 응답의 각 `items` 행:

```json
{
  "id": 31,
  "item_id": 3,
  "item_name": "레몬",
  "spec": null,
  "ordered_qty": 10,
  "received_qty": 4,
  "remaining_qty": 6,
  "memo": null
}
```

### 발주 항목

| Method | Path | 요청 | 성공 `data` |
| --- | --- | --- | --- |
| POST | `/api/purchase-orders/:id/items` | 단일 `OrderItemInput`, 배열, 또는 `{ items: OrderItemInput[] }` | `{ items: OrderItem[] }` |
| PATCH | `/api/purchase-orders/:id/items/:itemId` | `{ ordered_qty?, memo? }` | `OrderItem \| null` |
| POST | `/api/purchase-orders/:id/items/:itemId/receive` | `{ qty, note? }` | `{ order: PurchaseOrderRow \| null, order_item: ReceivedOrderItem \| null }` |

`OrderItemInput`:

```json
{ "item_id": 3, "ordered_qty": 10, "memo": null }
```

`POST .../items`와 `PATCH .../items/:itemId`가 반환하는 `OrderItem` row는 `{ id, order_id, item_id, ordered_qty, received_qty, memo }`입니다. 일괄 추가 응답의 `items`에는 해당 발주서의 활성 항목 전체가 들어갑니다. 항목 PATCH도 변경 성공 후 legacy 순차 재조회 사이에 row가 사라지는 race에서는 200의 `data`가 `null`일 수 있습니다.

> 중요: 두 URL의 `:itemId`는 재고 품목의 `items.id`가 아니라 발주 상세 응답에 있는 `order_items.id`입니다.

receive 규칙:

- `draft`, `canceled`, `fully_received` 발주에는 입고할 수 없습니다.
- `qty`는 1 이상이며 해당 발주 항목의 `remaining_qty`를 넘을 수 없습니다.
- 누적 입고량, 현재고, IN 원장, 발주 상태, 감사로그가 하나의 D1 batch에서 갱신됩니다.
- 동시에 다른 입고가 남은 수량을 먼저 사용한 경우 `409 RECEIVE_CONFLICT`로 전체 요청을 거부합니다.
- 성공 `data.order_item`의 `ReceivedOrderItem`은 `{ id, item_id, ordered_qty, received_qty, memo }`입니다.
- 입고 DB 변경 후 legacy 순차 재조회 사이의 race를 보존하므로 성공 `data.order`와 `data.order_item`은 서로 독립적으로 `null`일 수 있습니다. 이는 일반적인 미존재 성공이 아닙니다.
- 성공 `data.order`가 `null`이 아니면 갱신된 발주서 row입니다.

## 7. 감사로그

`GET /api/audit-logs`는 admin 전용입니다.

Query:

- `action`
- `entity_type`
- `entity_id`
- `actor` (사용자 ID)
- `from`, `to`

최신순 최대 200건을 `AuditLog[]`로 반환합니다. 각 행에는 `id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `created_at`이 포함됩니다.

## 8. 내부 컬럼

`items.creation_token`, `purchase_orders.creation_token`, `stock_transactions.operation_token`은 D1 batch에서 생성/갱신 대상을 연결하기 위한 내부 nullable 컬럼입니다. 공개 API 응답에는 포함하지 않습니다.
