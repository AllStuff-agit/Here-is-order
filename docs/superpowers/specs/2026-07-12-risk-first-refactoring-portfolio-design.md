# 위험 우선 리팩터링 포트폴리오 설계

작성일: 2026-07-12

상태: 설계 승인됨 · 문서 리뷰 대기

대상: Here-is-order 전체 저장소의 단계적 리팩터링

## 1. 결론

Here-is-order는 **위험 우선 단계형 리팩터링**으로 개선한다.

정상 운영 데이터와 기존 HTTP 동작은 기본적으로 보존한다. 다만 재현된 보안·정확성 결함은 호환성보다 수정을 우선한다. 전체 작업을 한 번에 배포하지 않고, 각 Wave를 독립된 설계·계획·Pull Request·배포 단위로 진행한다.

이 문서는 전체 순서와 공통 원칙을 고정하는 포트폴리오다. 하나의 implementation plan으로 전체 Wave를 실행하지 않는다. 각 Wave는 별도 spec과 plan을 가진다.

실행 순서는 다음과 같다.

1. Wave 0: 보안·정확성 safety gate
2. Wave 1: 배포·복구 guardrail
3. Wave 2: Identity / Session deep module
4. Wave 3: 브라우저 Purchase Order workflow module
5. Wave 4: Reorder projection / policy module
6. Wave 5: Stock Movement deep module
7. Wave 6: Catalog 심화와 남은 도메인별 HTTP contract
8. Wave 7: latest-only resource와 invalidation
9. Wave 8: 접근성과 사용하지 않는 UI·의존성 삭제
10. Wave 9: 운영 계측 후 성능·시간대·동시성 투자 결정

## 2. 배경

전체 저장소의 Worker API, D1 schema와 migration, seed/import script, Next.js frontend, shared HTTP contract, CI/CD와 운영 문서를 함께 검토했다.

검토 결과 기존 Purchase Order 서버 module과 Purchase Order HTTP contract는 실제 depth와 leverage를 가진다. 반면 인증, 세션, 재주문 정책, 재고 movement, 브라우저 발주 workflow는 정책이 여러 caller에 반복되어 변경 locality가 낮다.

또한 구조 개선보다 먼저 닫아야 하는 위험이 확인되었다.

- Notion Markdown 값으로 실행 가능한 seed SQL을 주입할 수 있다.
- 만료 시각을 서로 다른 TEXT 형식으로 비교해 만료된 세션이 허용될 수 있다.
- 문서와 관리자 화면이 운영 비밀번호를 외부 SHA-256 웹 도구에 입력하도록 안내한다.
- 초기 migration을 통과한 초과입고 행이 후속 trigger 적용 뒤에도 남을 수 있다.

이 결함을 남긴 채 큰 module을 이동하면 회귀 여부를 판단하기 어렵고 배포 위험도 커진다. 따라서 safety gate와 delivery guardrail을 먼저 완료한다.

## 3. 선택한 접근법

### 3.1 선택: 위험 우선 단계형

재현된 위험을 먼저 제거하고, 이후 delivery와 핵심 domain 순서로 deep module을 만든다.

장점:

- 가장 위험한 결함의 노출 시간을 줄인다.
- 각 Wave가 다음 Wave의 검증 기반을 강화한다.
- 회귀가 생기면 변경 범위를 한 Wave로 제한할 수 있다.
- 사용자에게 보이는 개선과 내부 구조 개선을 균형 있게 진행한다.

단점:

- 초기에 눈에 보이는 UI 변화가 적다.
- Identity 구조 개선 전에 일부 인증 hotfix를 먼저 적용하므로 작은 중간 단계가 생긴다.

### 3.2 제외: 구조 우선

Wave 0 직후 Identity와 Stock Movement를 먼저 전면 개편하는 방식은 구조적 locality를 빠르게 높인다. 그러나 delivery guardrail이 약한 상태에서 핵심 write path를 크게 바꾸므로 운영 위험이 높다.

### 3.3 제외: 화면 가치 우선

Wave 0 직후 발주와 재주문 화면부터 개선하면 가시적 가치는 빠르다. 그러나 인증과 배포 안전 부채가 더 오래 남고, 이후 contract 변경 때 화면 workflow를 다시 조정할 가능성이 크다.

## 4. 공통 설계 원칙

### 4.1 Deep module만 추가한다

새 module은 deletion test를 통과해야 한다. module을 삭제했을 때 여러 caller에 정책 복잡성이 다시 퍼져야 한다. 파일명만 바꾸거나 D1 statement를 그대로 노출하는 shallow wrapper는 만들지 않는다.

### 4.2 기존의 깊은 Module을 보존한다

다음 자산은 새로 만들지 않고 확장한다.

- `src/purchase-orders.ts`의 Purchase Order lifecycle Implementation
- `packages/http-contract`의 Purchase Order HTTP contract
- Miniflare D1을 사용하는 module·HTTP integration test

### 4.3 실제 Seam만 둔다

Production D1과 Miniflare D1은 현재 필요한 local substitute다. 두 번째 persistence Implementation이 없으므로 generic repository Interface를 만들지 않는다. Hono와 browser fetch는 executable HTTP contract를 사용하는 실제 Adapter다.

### 4.4 Contract와 invariant를 먼저 검증한다

동작 변경은 다음 순서를 따른다.

1. 현재 정상 동작과 수정할 결함을 test로 구분한다.
2. 실패하는 regression test를 추가한다.
3. 가장 작은 Implementation으로 test를 통과시킨다.
4. duplication과 locality를 개선한다.
5. HTTP contract, 문서, smoke test를 같은 Wave에서 맞춘다.

### 4.5 운영 데이터는 추정으로 고치지 않는다

읽기 감사에서 이상 행이 발견되면 자동 clamp나 삭제를 하지 않는다. backup을 확보하고 각 행의 업무 의미를 확인한 별도 repair 설계와 migration으로 처리한다.

### 4.6 각 배포 단위는 독립적으로 되돌릴 수 있어야 한다

큰 Wave는 하나 이상의 하위 배포 단위로 나눌 수 있다. 각 하위 단위는 하나의 명확한 목적만 가지며 독립 PR로 검증한다. schema 변경은 직전 코드와도 호환되는 expand-first 형태를 사용한다. migration이 포함되면 rollback이 아니라 forward recovery를 기본으로 한다.

## 5. Wave 설계

### Wave 0: 보안·정확성 safety gate

목표:

- Notion seed SQL 주입 차단
- 기존·신규 세션 만료 판정 정상화
- 외부 해시 도구를 사용하는 복구 절차 제거
- 로컬 PBKDF2 기반 운영자 복구 경로 제공
- 운영 D1의 legacy 초과입고 읽기 감사
- legacy 초과입고가 다른 미입고 행을 가리지 않도록 상태 파생 방어

완료 gate:

- 악성 Markdown fixture가 안전한 literal로 저장된다.
- ISO와 SQLite 형식 세션 모두 만료 전후가 정확히 판정된다.
- 저장소 문서와 UI에 외부 비밀번호 해시 링크가 없다.
- 복구는 PBKDF2를 사용하고 대상 세션을 폐기하며 audit를 남긴다.
- 운영 감사 결과가 0건이거나 별도 repair 작업으로 격리된다.
- 발주 상태는 품목별 잔량을 기준으로 파생된다.

상세 설계는 `2026-07-12-wave-0-safety-gate-design.md`에 둔다.

Wave 0은 0A import, 0B session/recovery, 0C status defense, 0D production audit의 독립 PR로 배포한다. 데이터 감사 결과가 보안 hotfix 배포를 막지 않게 0A–0C를 먼저 완료한다.

### Wave 1: Delivery / Recovery guardrail

목표:

- production 변경 전 backup·preflight 절차
- API readiness와 최소 인증 business smoke
- API Worker 관측 설정과 배포 후 확인
- recovery runbook과 배포 실패 분류
- GitHub Action과 toolchain의 재현 가능한 고정

완료 gate:

- migration, API, web 단계별 중단 조건이 실행 가능하다.
- 단순 health가 아니라 인증 경로와 D1 read를 smoke test한다.
- 배포 실패 시 이전 Worker 또는 forward repair 경로가 문서화되어 있다.

### Wave 2: Identity / Session deep module

목표:

- password policy, PBKDF2와 legacy upgrade, session issue/expiry/revoke를 한 Module에 집중
- login route와 auth middleware를 얇은 HTTP Adapter로 축소
- 존재하지 않는 계정과 잘못된 비밀번호의 public 오류 통일
- 로그인 실패 rate limit과 성공·실패 audit
- Identity executable HTTP contract와 실제 login/logout integration test

Interface는 로그인, 현재 사용자 조회, 비밀번호 변경, 관리자 초기화 같은 사용자 의도를 표현한다. hash 형식과 D1 choreography는 Implementation 뒤에 숨긴다.

### Wave 3: Browser Purchase Order workflow module

목표:

- Alerts부터 원자적 populated draft 생성 사용
- Dashboard create/confirm의 부분 실패와 재시도 의미 명시
- 상태별 action capability 단일화
- add/receive 중복 클릭과 stale revalidation 차단
- detail 초기 오류, retry, cancel, delete 노출 정확화

기존 Purchase Order 서버 Module과 HTTP contract는 수정 대상이 아니라 협력 대상이다.

### Wave 4: Reorder projection / policy module

목표:

- `outstandingQty`, `suggestedQty`, eligibility, severity를 한 Projection Interface로 제공
- items와 dashboard의 중복 SQL 제거
- dashboard, alerts, items의 부족재고 기준 통일
- 진행 중 발주가 수요를 충족한 품목의 주문 생성 차단

### Wave 5: Stock Movement deep module

목표:

- 초기 재고, 수동 조정, Purchase Order 입고의 공통 불변식 집중
- 현재고, stock ledger, audit의 원자성 보장
- IN/OUT/ADJUST 의미와 음수 방지 규칙 단일화

Interface는 raw D1 batch가 아니라 의미 있는 stock movement intent를 받는다.

### Wave 6: Catalog와 남은 domain HTTP contracts

목표:

- category/item write policy와 error mapping 집중
- soft-deleted category 이름 재사용 정책 명시
- Catalog, Inventory, Dashboard 순서로 executable HTTP contract 확장
- server와 browser의 수동 type·parsing drift 제거

모든 도메인을 한 번에 바꾸지 않고 contract 하나씩 독립 전환한다.

### Wave 7: Latest-only resource / invalidation

목표:

- 검색과 ledger의 오래된 응답이 최신 state를 덮지 못하게 한다.
- loading, error, data, retry 상태를 명시한다.
- mutation 뒤 invalidate/revalidate 규칙을 통일한다.
- 영구 skeleton과 숨겨진 오류 화면을 제거한다.

HTTP contract가 안정된 뒤 적용하며 SWR 도입 여부는 이 Wave 설계에서 비교한다.

### Wave 8: 접근성과 source surface 축소

목표:

- sortable table의 keyboard interaction과 `aria-sort`
- 관리자 전용 화면의 route-level UX 보호
- DOM 기반 접근성·interaction test 기반
- 참조되지 않는 UI source, 중복 hook, unused dependency 삭제
- frontend lint가 `hooks`를 포함하도록 범위 수정

삭제는 참조 그래프와 build로 확인하며 사용 중인 shadcn Implementation은 보존한다.

### Wave 9: Measure-first 결정

다음 항목은 현재 추정만으로 구현하지 않는다.

- pagination과 query index: production 행 수와 query plan을 측정한다.
- business timezone: KST 영업일 요구를 명시한다.
- optimistic revision: 실제 동시 편집 빈도와 피해를 확인한다.
- long-list rendering: 실제 렌더링 계측 뒤 결정한다.

측정 결과 기준을 넘는 항목만 별도 spec으로 승격한다.

## 6. 데이터와 요청 흐름

각 도메인의 목표 흐름은 다음과 같다.

```text
View / operator command
        │
        ▼
Intent-specific Adapter
        │
        ▼
Executable Interface / contract
        │
        ▼
Deep domain Module
        │
        ▼
D1-specific atomic Implementation
```

브라우저는 서버 불변식을 재구현하지 않는다. 서버는 화면 상태를 추정하지 않는다. HTTP contract가 두 쪽의 공통 Seam이 되고, domain Module이 write invariant의 최종 권위를 가진다.

## 7. 오류 처리

- 사용자 입력 오류, not found, conflict, unexpected infrastructure error를 구분한다.
- D1 예외 전체를 `409`로 변환하지 않는다.
- public 인증 오류는 계정 존재 여부를 노출하지 않는다.
- 부분 성공 가능성이 있는 browser workflow는 success/failure 이분법 대신 완료 단계와 복구 action을 표현한다.
- unexpected error는 사용자에게 안전한 메시지를 반환하고 관측 로그에는 correlation 가능한 사실을 남긴다.

## 8. 검증 전략

각 Wave의 최소 검증은 다음을 포함한다.

- 새 결함을 재현하는 regression test
- domain Module의 intent Interface test
- 변경된 route의 HTTP integration test
- 변경된 browser Adapter/workflow test
- migration이 있으면 빈 DB와 legacy fixture 적용 test
- `npm test`, `npm run typecheck`, `npm run build`
- `npm run test --prefix frontend`, `npm run lint --prefix frontend`, `npm run build --prefix frontend`, Cloudflare build
- 배포 뒤 해당 Wave의 business smoke

테스트 수 자체보다 public contract와 불변식을 검증하는지를 완료 기준으로 삼는다.

## 9. 전달과 리뷰 방식

각 Wave는 다음 순서를 반복한다.

1. Wave별 spec 승인
2. 상세 implementation plan 작성
3. isolated branch/worktree에서 test-first 구현
4. 전체 검증
5. 코드 리뷰와 발견 사항 반영
6. PR 생성과 CI 확인
7. main 병합과 자동 배포
8. production smoke와 관측 확인
9. 문서와 architecture review 상태 갱신

다음 Wave는 직전 Wave의 production 검증이 끝난 뒤 시작한다.

## 10. 포트폴리오 성공 기준

- 재현된 P0/P1 결함이 regression test와 함께 제거된다.
- 인증, 재고, 재주문, 발주 workflow 정책이 각각 한 deep Module에 모인다.
- 주요 도메인의 Worker와 browser가 executable HTTP contract를 공유한다.
- write invariant가 D1 batch와 test로 원자성을 보장한다.
- 실패한 배포와 운영 데이터 이상에 실행 가능한 recovery 경로가 있다.
- 핵심 browser 흐름에 loading/error/retry와 중복 실행 방지가 있다.
- 접근성과 source navigability가 자동 검증된다.
- 성능 최적화는 production 계측으로 정당화된다.
