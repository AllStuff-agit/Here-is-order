# 카페 발주 관리 웹 MVP 설계 (Cloudflare + D1)

작성일: 2026-07-11

버전: v1.1

## 0. 결론

- 대상은 매장 1곳이며 여러 계정을 `admin`과 `staff`로 나눠 사용합니다.
- 모바일 우선 Next.js 웹에서 재고, 부족재고, 발주와 부분입고를 관리합니다.
- 외부 주문 전송은 하지 않습니다. 앱은 발주 수량·상태·입고 기록만 관리합니다.
- API와 웹은 별도 Cloudflare Worker로 배포하되, 웹의 `/api/*` same-origin proxy를 통해 세션 쿠키를 사용합니다.

## 1. 기능 범위

1. 재고 갱신
   - 품목별 입고(`IN`), 사용(`OUT`), 절대재고 조정(`ADJUST`)
   - 현재고와 재고변동 원장을 함께 기록
   - 품목 수정 API에서 현재고 직접 변경 금지
2. 발주 필요 목록
   - 후보 기준: `safety_stock > 0 AND current_stock < safety_stock`
   - 진행 중 미입고 수량: 삭제되지 않은 발주 항목의 `ordered_qty - received_qty` 합계. 취소/입고완료 발주 제외
   - 추천수량: `MAX(0, safety_stock - current_stock - 진행 중 미입고 수량)`
3. 발주서 관리
   - 발주서는 초안으로 생성하고 항목이 있을 때만 발주 확정
   - 발주 항목 추가/수정은 초안에서만 허용
   - 부분입고 시 발주 항목 누적 입고량, 현재고, 재고 원장, 발주 상태를 함께 갱신
   - `partially_received` / `fully_received`는 입고 처리 결과로만 자동 전환
   - 발주서 삭제는 초안에서만 허용
4. 집계/대시보드
   - 발주 필요 배지와 추천수량
   - 기간별 진행 발주, 미입고 수량, 입고 수량
5. 변경 추적
   - 품목·분류·발주 데이터는 soft-delete
   - 로그인, 계정, 품목, 재고, 발주 등 핵심 변경 감사로그

## 2. 사용자와 권한

모든 계정은 같은 매장 데이터를 사용합니다.

| 기능 | admin | staff |
| --- | --- | --- |
| 재고·품목·발주 사용 | 가능 | 가능 |
| 내 비밀번호 변경 | 가능 | 가능 |
| 계정 목록/생성 | 가능 | 불가 |
| 다른 계정 비밀번호 초기화 | 가능 | 불가 |
| 감사로그 조회 | 가능 | 불가 |

관리자 전용 API에 staff가 접근하면 `403 FORBIDDEN`을 반환합니다. v1에는 매장 분리, 세분화된 권한, 사용자 삭제/비활성 관리가 포함되지 않습니다.

## 3. 데이터 모델

- `users`: 사용자와 `admin|staff` 역할
- `sessions`: 30일 만료 세션
- `item_categories`: 품목 분류
- `items`: 단위가 `개`인 재고 대상과 현재고
- `stock_transactions`: IN/OUT/ADJUST 재고 원장과 선택적 발주 항목 참조
- `purchase_orders`: 발주서와 상태
- `order_items`: 발주 품목, 주문수량, 누적 입고수량
- `audit_logs`: 행위자와 변경 전/후 JSON

DB 적용의 단일 source는 `migrations/`입니다. `db/schema.sql`은 최종 구조를 읽기 쉽게 모아 둔 reference snapshot일 뿐이며, bootstrap과 배포에서는 실행하지 않습니다.

## 4. 발주 상태

```text
draft --발주 확정--> ordered --일부 입고--> partially_received --전량 입고--> fully_received
  └------- 취소 ------> canceled
ordered --입고 전 취소--> canceled
```

- `draft`: 발주 항목 추가·수정 및 발주서 soft-delete 가능. 발주서 제목·메모는 상태와 무관하게 수정 가능
- `ordered`: 입고 가능
- `partially_received`: 남은 수량만 추가 입고 가능
- `fully_received`: 모든 활성 항목의 입고 완료
- `canceled`: 입고 불가

`partially_received`, `fully_received`, `canceled`는 종료 방향으로만 진행하며 이전 상태로 되돌릴 수 없습니다. 취소는 입고가 시작되기 전의 초안/확정 발주에서만 허용합니다.

URL의 발주 항목 식별자 `/items/:itemId`는 품목의 `items.id`가 아니라 발주 항목의 `order_items.id`입니다.

## 5. 화면

- `/login`: 로그인
- `/dashboard`: 부족재고, 추천발주, 기간 집계
- `/items`: 품목 CRUD, 현재고 조정, 원장
- `/alerts`: 발주 필요 품목과 빠른 발주
- `/orders`: 발주 목록과 생성
- `/orders/[id]`: 발주 항목 편집, 확정, 부분입고
- `/settings`: 계정 관리와 비밀번호 변경 안내

모바일 레이아웃을 우선하며 PC 반응형 화면도 지원합니다.

## 6. 구현·배포 구조

```text
Browser
  └─ hereisorder-web (Next.js + OpenNext)
       └─ relative /api/* rewrite
            └─ hereisorder API Worker (Hono)
                 └─ Cloudflare D1
```

- 로컬: `npm run dev:api`와 `npm run web:dev:local`
- 웹 빌드: 일반 Next.js `npm run web:build`, Cloudflare 산출물 `npm run build:cloudflare --prefix frontend`
- production: D1 migration → API Worker → 웹 Worker 순서
- CI: API typecheck/test/build, migration 적용, 웹 lint/build, OpenNext build를 통과해야 배포

## 7. 제외/향후

- 거래처와 외부 발주 API 연동
- 푸시·문자·이메일 알림
- 파일 업로드와 고급 분석
- 여러 매장/tenant 분리
- 세분화된 역할·권한과 사용자 lifecycle 관리
- 입고 D-day, 미입고 연장, 거래처별 성과 분석
