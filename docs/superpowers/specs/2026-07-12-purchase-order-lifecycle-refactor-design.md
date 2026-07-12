# Purchase Order Lifecycle Refactor Design

작성일: 2026-07-12

상태: 승인됨
대상: Cloudflare Worker의 Purchase Order 생명주기 implementation

## 1. 결론

`src/index.ts`에 섞여 있는 Purchase Order 생성, 수정, 상태 전이, Order Item 변경, 삭제, 부분입고 implementation을 하나의 deep module로 옮긴다.

첫 단계는 동작 보존형 서버 리팩터링이다. HTTP 요청·응답 shape, 상태 코드, 오류 코드와 메시지, DB schema, migration trigger, frontend 동작을 바꾸지 않는다.

새 module은 intent별 method와 공통 `PurchaseOrderResult<T>` interface를 제공한다. Purchase Order 생명주기와 detail Hono route는 인증, HTTP 파싱, module 호출, envelope 직렬화만 담당한다. 목록 projection route는 첫 단계의 명시적 예외로 `src/index.ts`에 남긴다. D1 batch, 상태 규칙, 충돌 판정, stock movement/ledger, audit log는 module implementation 안에 둔다.

## 2. 배경과 문제

현재 `src/index.ts`는 2,016줄이며 다음 책임을 한 module에서 수행한다.

- Hono route 등록과 인증
- HTTP 입력 파싱과 응답 직렬화
- Purchase Order 상태 전이
- Order Item 검증과 중복 병합
- D1 query와 batch 구성
- optimistic conflict 판정
- partial receipt에 따른 재고·원장·상태 갱신
- audit log before/after 구성

Purchase Order mutation은 `src/index.ts:1170-1948`에 집중되어 있지만 규칙은 JavaScript 분기, SQL predicate, `changes()`, token, migration trigger에 중복되어 있다. 이 때문에 한 상태 전이를 이해하거나 변경하려면 여러 route와 SQL statement를 함께 읽어야 한다.

단순히 route별 파일로 분할하면 같은 interface와 invariant가 여러 shallow module에 남는다. 이번 설계는 route 수를 파일 수로 치환하지 않고, Purchase Order intent 뒤에 implementation 복잡성을 숨겨 depth, leverage, locality를 높인다.

## 3. 목표

- Purchase Order 생명주기 지식을 한 deep module에 집중한다.
- Purchase Order 생명주기와 detail Hono route를 얇은 HTTP adapter로 만든다.
- module interface를 주 test surface로 만든다.
- 현재 HTTP contract와 D1 동작을 보존한다.
- 기존 동시성 및 원자성 보장을 유지한다.
- 향후 stock movement module을 심화할 수 있는 locality를 만든다.

## 4. 비목표

- frontend 변경
- HTTP path, payload, envelope 또는 public row shape 변경
- DB schema 또는 migration 변경
- Purchase Order 목록 projection 리팩터링
- generic repository port 도입
- clock, UUID 또는 audit log port 도입
- 현재 발견된 UI 오류 수정
- 재주문 projection 또는 User/session module 리팩터링

## 5. Architecture

새 파일 `src/purchase-orders.ts`가 Purchase Order interface와 D1-specific implementation을 함께 소유한다.

```text
Hono route adapters (src/index.ts)
        │
        ▼
Purchase Order interface
        │
        ▼
deep Purchase Order module (src/purchase-orders.ts)
  ├─ domain validation and normalization
  ├─ lifecycle decisions
  ├─ optimistic conflict classification
  ├─ D1 batch choreography
  ├─ partial receipt stock movement/ledger
  └─ audit facts
        │
        ▼
D1 in production / Miniflare D1 in tests
```

### 5.1 Hono adapter 책임

`src/index.ts`에 다음 책임을 남긴다.

- 인증된 `SessionUser` 획득
- JSON과 path parameter 파싱
- snake_case 요청을 module input으로 매핑
- `POST .../items`의 단일 객체, 배열, `{ items }` 형식 수용
- `PurchaseOrderResult<T>`의 `kind`를 HTTP 상태로 매핑
- 기존 `{ ok, data }`와 `{ ok: false, error }` envelope 직렬화
- Purchase Order 목록 query

### 5.2 Deep module 책임

`src/purchase-orders.ts`가 다음을 소유한다.

- 빈 값, 수량, 상태, 활성 품목 검증
- Order Item 정규화와 중복 병합
- Purchase Order 상태 전이와 동일 상태 요청의 현재 동작
- draft-only Order Item 추가·수정과 `deleteDraft`의 Order Item cascade soft-delete
- `creation_token` 생성·정리와 `operation_token` 생성·영구 보존
- D1 batch statement 구성과 순서
- conditional write와 `changes()` 기반 conflict 판정
- partial receipt의 stock movement/ledger, 현재고, 누적 입고량, 상태 갱신
- audit log action, entity, before/after facts
- 기존 public row shape 재조회

### 5.3 Dependency 전략

D1은 module implementation이 직접 사용한다. Production D1과 Miniflare D1은 이미 local-substitutable adapters다. 별도의 generic repository seam은 실제 두 번째 persistence adapter가 없고 D1 batch semantics를 interface 밖으로 누출하므로 만들지 않는다.

SQLite `date('now')`, `datetime('now')`와 `crypto.randomUUID()`도 implementation detail로 유지한다. deterministic test를 위해 필요해질 때만 private internal seam을 검토한다.

## 6. Interface

interface는 현재 route intent에 맞춘 method를 제공한다.

```ts
type PurchaseOrderFailure =
  | {
      kind: 'invalid';
      code: 'INVALID_INPUT' | 'INVALID_STATUS' | 'INVALID_STATUS_TRANSITION';
      message: string;
    }
  | {
      kind: 'not_found';
      code: 'NOT_FOUND';
      message: string;
    }
  | {
      kind: 'conflict';
      code: 'CONFLICT' | 'ORDER_DELETE_CONFLICT' | 'RECEIVE_CONFLICT';
      message: string;
    };

type PurchaseOrderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PurchaseOrderFailure };

type PurchaseOrderStatus =
  | 'draft'
  | 'ordered'
  | 'partially_received'
  | 'fully_received'
  | 'canceled';

type PurchaseOrderRow = {
  id: number;
  title: string;
  status: PurchaseOrderStatus;
  order_date: string;
  external_order_ref: string | null;
  note: string | null;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type OrderItemInput = {
  itemId: number;
  orderedQty: number;
  memo: string | null;
};

type OrderItemRow = {
  id: number;
  order_id: number;
  item_id: number;
  ordered_qty: number;
  received_qty: number;
  memo: string | null;
};

type PurchaseOrderDetail = PurchaseOrderRow & {
  items: Array<{
    id: number;
    item_id: number;
    item_name: string | null;
    spec: string | null;
    ordered_qty: number;
    received_qty: number;
    remaining_qty: number;
    memo: string | null;
  }>;
};

type CreateDraftInput = {
  title: string;
  note: string | null;
  requestedStatus?: string;
};

type CreateDraftWithItemsInput = {
  title: string;
  note: string | null;
  items: readonly OrderItemInput[];
};

type PurchaseOrderRevision = {
  title?: string;
  note?: string | null;
  externalOrderRef?: string | null;
  requestedStatus?: string;
};

type OrderItemRevision = {
  orderedQty?: number;
  memo?: string | null;
};

type PartialReceiptInput = {
  quantity: number;
  note?: string | null;
};

type PartialReceiptResult = {
  order: PurchaseOrderRow;
  order_item: Pick<
    OrderItemRow,
    'id' | 'item_id' | 'ordered_qty' | 'received_qty' | 'memo'
  >;
};

interface PurchaseOrderModule {
  createDraft(input: CreateDraftInput): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  createDraftWithItems(input: CreateDraftWithItemsInput): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  getDetail(orderId: number): Promise<PurchaseOrderResult<PurchaseOrderDetail>>;
  revise(orderId: number, change: PurchaseOrderRevision): Promise<PurchaseOrderResult<PurchaseOrderRow>>;
  deleteDraft(orderId: number): Promise<PurchaseOrderResult<{ deleted: true }>>;
  addItemsToDraft(orderId: number, items: readonly OrderItemInput[]): Promise<PurchaseOrderResult<{ items: OrderItemRow[] }>>;
  editDraftItem(orderId: number, orderItemId: number, change: OrderItemRevision): Promise<PurchaseOrderResult<OrderItemRow>>;
  receive(orderId: number, orderItemId: number, receipt: PartialReceiptInput): Promise<PurchaseOrderResult<PartialReceiptResult>>;
}

function purchaseOrders(db: D1Database, actorUserId: number): PurchaseOrderModule;
```

### 6.1 Interface 선택 이유

- 단일 `execute(command)`는 method 수는 적지만 caller가 전체 command union과 result mapping을 알아야 한다.
- facet/builder interface는 확장성보다 현재 필요한 TypeScript surface를 크게 늘린다.
- intent별 method는 각 route가 한 동작만 알게 하면서 validation, concurrency, D1 batch, audit facts를 숨긴다.
- `revise`는 metadata와 상태를 한 요청에서 함께 바꾸는 현재 atomic behavior를 보존한다. 이를 `updateMetadata`, `confirm`, `cancel`로 분리하지 않는다.
- 성공 row는 현재 snake_case public shape를 유지하여 frontend와 HTTP contract를 바꾸지 않는다.
- input type의 optional property는 HTTP payload에서 해당 field가 실제로 존재할 때만 설정한다. `null`은 nullable field를 지우는 명시적 값이다.

## 7. Domain invariants

### 7.1 생성

- 모든 Purchase Order는 `draft`로 생성한다.
- plain draft 생성의 status가 생략되거나 빈 문자열이면 `draft`로 정규화하며, 다른 값은 현재 오류로 거부한다.
- plain draft 생성은 Order Item이 없어도 허용한다.
- populated draft 생성은 비어 있지 않은 Order Item 목록을 요구한다.
- populated draft HTTP payload의 `status` field는 현재 동작대로 무시하며 항상 `draft`를 생성한다. 이 field는 module input에 포함하지 않는다.
- 하나라도 유효하지 않은 Order Item이 있으면 전체 생성을 거부한다.
- 활성 품목만 참조할 수 있다.
- 같은 품목이 여러 번 들어오면 수량을 합쳐 활성 Order Item 하나로 만든다.
- populated draft 생성의 memo는 마지막 non-null 값을 사용하며 빈 문자열도 값으로 취급한다.

### 7.2 Order Item 추가와 수정

- Order Item 추가와 수정은 활성 `draft`에서만 허용한다.
- 기존 활성 Order Item에 같은 품목을 추가하면 주문수량을 누적한다.
- 한 추가 요청 안의 duplicate memo는 현재 동작대로 마지막 truthy 값을 사용하며 빈 문자열은 앞선 input memo를 덮지 않는다.
- duplicate 병합 결과의 memo가 `null`이고 기존 활성 Order Item을 갱신하는 경우에는 DB의 기존 memo를 `null`로 지운다.
- `addItemsToDraft` 성공 결과의 `items`는 변경된 행만이 아니라 해당 Purchase Order의 활성 Order Item 전체다. 순서는 contract로 보장하지 않는다.
- `ordered_qty`는 1 이상의 정수다.
- 수정된 `ordered_qty`는 이미 입고된 수량보다 작을 수 없다.
- URL의 `:itemId`는 inventory Item ID가 아니라 `order_items.id`다.

### 7.3 상태 전이

- 제목, note, external order reference는 활성 Purchase Order의 상태와 무관하게 수정할 수 있다. `fully_received`와 `canceled`도 metadata-only revise를 허용한다.
- `revise`는 metadata와 requested status를 한 번에 받아 하나의 update와 하나의 Purchase Order `update` audit fact로 처리한다.
- Order Item이 하나 이상인 `draft`만 `ordered`로 확정할 수 있다.
- 확정 시 `order_date = date('now')`를 설정한다.
- `draft`와 입고 전 `ordered`만 `canceled`로 전이할 수 있다.
- 활성 Order Item의 `received_qty`가 하나라도 0보다 크면 취소할 수 없다.
- `partially_received`와 `fully_received`는 partial receipt 결과로만 정한다.
- 종료 상태를 이전 상태로 되돌리지 않는다.
- `draft → draft`, `ordered → ordered`, `canceled → canceled` 같은 동일 status 요청은 현재 동작대로 성공하며 `updated_at`과 Purchase Order `update` audit fact를 갱신한다.
- `ordered → ordered`도 활성 Order Item이 하나 이상이어야 하며 `order_date`는 다시 설정하지 않는다.
- `canceled → canceled`도 입고 수량이 없어야 한다.
- `partially_received`와 `fully_received`는 요청 자체가 금지되므로 동일 status 요청도 `INVALID_STATUS_TRANSITION`으로 거부한다.
- migration trigger는 허용된 status edge만 방어하는 최종 integrity guard로 유지한다. Order Item 존재 같은 추가 invariant는 module의 conditional SQL이 계속 보장한다.

### 7.4 삭제

- 활성 `draft`만 soft-delete할 수 있다.
- Purchase Order와 활성 Order Item을 같은 batch에서 soft-delete한다.
- 활성 여부와 무관하게 해당 Purchase Order의 Order Item 중 `received_qty > 0`인 행이 하나라도 있으면 삭제를 거부한다.
- 현재 동작과 같이 Purchase Order `soft_delete` audit fact만 기록한다.

### 7.5 Partial receipt

- `ordered` 또는 `partially_received`에서만 허용한다.
- 수량은 1 이상의 정수이며 남은 수량을 넘을 수 없다.
- 활성 Order Item과 활성 inventory Item을 요구한다.
- receipt `note`는 stock movement/ledger의 `reason`이 된다. 생략하거나 명시적으로 `null`이면 `부분입고 처리`를 사용하고, 빈 문자열은 그대로 보존한다.
- 성공하면 누적 입고량, 현재고, stock movement/ledger, Purchase Order 상태, audit log가 함께 반영된다.
- 모든 활성 Order Item의 누적 입고량 합이 주문수량 합과 같으면 `fully_received`, 일부만 입고되면 `partially_received`로 정한다.

## 8. Data flow

mutation intent는 적용 가능한 범위에서 다음 순서를 따른다.

1. Hono adapter가 JSON과 path를 파싱한다.
2. module이 semantic input을 검증하고 Order Item을 정규화한다.
3. 기존 row를 변경하는 intent는 현재 상태를 pre-read하여 구체적인 오류 메시지를 만든다.
4. 생성 intent는 token-correlated D1 batch를, 기존 row mutation은 상태 predicate를 포함한 D1 batch를 구성한다.
5. module이 batch를 실행한다.
6. conditional write가 있는 intent는 `changes()` 결과로 stale state와 concurrent mutation을 판정한다.
7. 성공 row를 기존 public shape로 다시 조회한다.
8. `PurchaseOrderResult<T>`를 반환한다.
9. Hono adapter가 기존 envelope와 상태 코드로 직렬화한다.

pre-read는 메시지와 사전 검증을 위한 것이며 write authorization의 근거가 아니다. 동시성 안전성은 batch 내부 predicate, unique token, `changes()`가 보장한다.

`getDetail`은 read-only 흐름을 사용한다: Hono adapter가 ID를 파싱하고, module이 활성 Purchase Order와 활성 Order Item을 조회한 뒤 success 또는 `NOT_FOUND`를 반환하며, Hono adapter가 직렬화한다. D1 batch와 `changes()`는 사용하지 않는다.

### 8.1 Partial receipt batch 순서

1. 조건부 `IN` stock movement/ledger row 생성
2. Order Item `received_qty` 누적
3. inventory Item `current_stock` 증가
4. 모든 활성 Order Item을 기준으로 Purchase Order 상태 계산
5. Order Item `receive` audit log 기록

첫 statement가 적용되지 않으면 뒤 statement도 token 존재 조건을 통과하지 못한다. audit log insert가 실패하면 D1 batch 전체가 rollback된다.

## 9. Error handling

예상 가능한 domain 실패는 throw하지 않고 `PurchaseOrderResult<T>`의 failure로 반환한다.

| Failure kind | HTTP status |
| --- | ---: |
| `invalid` | 400 |
| `not_found` | 404 |
| `conflict` | 409 |

Hono adapter가 `kind`를 상태 코드로 변환하고 기존 code와 한국어 message를 그대로 envelope에 넣는다. HTTP status 자체는 module interface에 포함하지 않는다.

예상하지 못한 실패는 throw하여 기존 `app.onError`의 `500 INTERNAL_ERROR`로 처리한다.

현재 compatibility를 위해 다음 broad catch 동작을 보존한다.

- populated draft 생성 중 D1 batch 실패: `409 CONFLICT`
- Order Item 추가 중 D1 batch 실패: `409 CONFLICT`
- partial receipt 중 D1 batch 실패: `409 RECEIVE_CONFLICT`
- 그 외 예상 밖 D1 실패: 500

conditional write의 변경 행이 0이면 intent별 `CONFLICT`, `ORDER_DELETE_CONFLICT`, `RECEIVE_CONFLICT`를 반환한다.

Hono adapter는 malformed JSON을 현재처럼 빈 payload로 취급하고, 유효하지 않은 path ID, row가 object가 아닌 경우, `POST .../items`의 container 선택, 숫자 coercion 실패처럼 typed module input을 만들 수 없는 wire 오류를 현재 code와 message로 처리한다. Module은 typed지만 신뢰하지 않는 string/number 값을 받아 빈 제목, 0 이하 수량, 활성 품목, 상태 전이 같은 semantic 오류를 다시 검증한다.

## 10. Testing

### 10.1 Characterization

리팩터링 전에 현재 HTTP contract와 의도적인 compatibility behavior를 고정한다.

- plain/populated draft 생성 shape와 201 상태
- populated draft payload의 `status` 무시
- invalid populated draft의 전체 rollback
- create와 add에서 서로 다른 duplicate memo 우선순위
- 기존 Order Item에 null로 병합된 memo를 추가할 때 기존 memo가 지워지는 동작
- `addItemsToDraft`가 활성 Order Item 전체를 반환하는 shape
- metadata와 status를 함께 revise하는 atomic behavior
- 종료 상태의 metadata-only revise 허용
- `draft`, `ordered`, `canceled` 동일 status 재요청의 성공·audit behavior
- `partially_received`, `fully_received` 동일 status 재요청 거부
- draft-only Order Item 추가·수정과 Purchase Order cascade soft-delete
- 삭제된 Order Item을 포함해 입고량이 있는 draft의 삭제 거부
- receipt note의 ledger reason mapping과 기본값
- 기존 한국어 오류 message와 code
- partial receipt preflight의 구체적인 message와 concurrent loser의 `RECEIVE_CONFLICT` code

### 10.2 Audit compatibility matrix

`GET /api/audit-logs`가 JSON facts를 공개하므로 다음 action, entity, before/after field set을 characterization한다.

| Intent | Action / entity | Before | After |
| --- | --- | --- | --- |
| plain draft 생성 | `create / purchase_order` | `null` | `title`, `status`, `note` |
| populated draft 생성 | 각 `create / order_item`, 이후 `create / purchase_order` | `null` | Order Item fields, 이후 normalized `items`를 포함한 Purchase Order facts |
| revise·confirm·cancel·동일 status | `update / purchase_order` | 기존 full row JSON | 현재 public audit field set |
| deleteDraft | `soft_delete / purchase_order` | 기존 full row JSON | 기존 row에 `is_deleted: 1`을 반영한 facts |
| 기존·신규 Order Item 추가 | `update` 또는 `create / order_item` | 기존 quantity fields 또는 `null` | 현재 Order Item audit field set |
| Order Item 수정 | `update / order_item` | 기존 Order Item row | 현재 Order Item audit field set |
| partial receipt | `receive / order_item` | receipt 이전 누적수량 facts | receipt 이후 누적수량 facts |

JSON key 이름과 null 처리까지 현재 응답을 fixture로 고정한다. Token 값과 timestamp는 fixture 대상이 아니다.

### 10.3 Module interface tests

Miniflare D1과 실제 migrations를 적용하고 `PurchaseOrderModule` interface를 직접 호출한다.

- 생성과 duplicate merge
- Order Item 추가·수정
- 확정·취소·종료 상태 역전 거부
- soft-delete
- partial/full receipt 상태 계산
- 동시에 남은 수량을 초과한 receipt 중 하나만 성공
- stock movement/ledger와 현재고 일치
- audit facts와 mutation의 원자성
- audit insert 실패 시 전체 rollback

테스트는 SQL 문자열, private helper, statement count, UUID/token 값을 검사하지 않는다. public result와 안정된 domain facts만 검사한다.

### 10.4 Hono adapter contract tests

- 기존 snake_case 요청과 응답
- 200/201 success status
- 기존 envelope
- failure kind의 400/404/409 mapping
- 예상 밖 실패의 500 mapping

기존 `test/api.integration.test.ts`는 HTTP 안전망으로 유지한다. 상세 생명주기 matrix는 module interface test로 이동하여 같은 implementation을 중복 검증하지 않는다.

### 10.5 Verification gates

```bash
npm test
npm run typecheck
npm run build
npm run web:lint
npm run web:build
npm run db:migrate
npm run build:cloudflare --prefix frontend
```

## 11. 예상 파일 변경

- 추가: `src/purchase-orders.ts`
- 추가: `test/purchase-orders.integration.test.ts`
- 수정: `src/index.ts`
- 필요 시 수정: `test/api.integration.test.ts`
- 변경 없음: `migrations/`, `db/schema.sql`, `frontend/`

## 12. 구현 순서 개요

1. HTTP characterization test를 보강한다.
2. 실패하는 `PurchaseOrderModule` interface test를 작성한다.
3. public type, Result, interface를 추가한다.
4. 생성과 detail read를 module로 옮긴다.
5. revise, delete, Order Item mutation을 옮긴다.
6. partial receipt를 옮긴다.
7. Hono route를 thin adapter로 정리한다.
8. 중복된 기존 implementation을 삭제한다.
9. 전체 verification gates를 실행한다.

세부 task와 red-green 순서는 별도 implementation plan에서 정한다.

## 13. 성공 기준

- 기존 HTTP contract와 frontend 동작이 변하지 않는다.
- migration과 DB schema가 변하지 않는다.
- Purchase Order 생명주기 SQL과 상태 규칙이 `src/index.ts`에서 제거된다.
- Purchase Order 생명주기와 detail Hono route는 인증, 파싱, module 호출, 직렬화만 수행한다. 목록 projection route는 `src/index.ts`에 남는다.
- module interface test가 상태, concurrency, atomicity를 검증한다.
- 기존 integration test와 verification gates가 모두 통과한다.
- module에 generic repository, public transaction primitive, clock/UUID port가 추가되지 않는다.

## 14. Deletion test

이 module을 삭제하면 상태 전이, 두 duplicate merge 규칙, token choreography, conditional conflict 판정, draft-only delete, partial receipt, stock movement/ledger, audit facts가 일곱 mutation route로 다시 퍼진다. complexity가 사라지지 않고 caller에 재등장하므로 module은 충분한 depth와 leverage를 제공하며 locality를 개선한다.
