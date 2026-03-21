# 카페 발주 관리 웹 MVP 설계 (Cloudflare + D1)
작성일: 2026-03-02
버전: v1.0

## 0) 결론
- Notion은 사용 중단, **웹 단일 앱**으로 전환
- 대상: **관리자 1명, 매장 1개, 모바일+PC 동시 사용**
- 핵심 가치: 재고 부족 품목 놓침 방지(발주 필요 알림 배지), 발주 수량/재고 수동 조정/입고 처리
- 외부 발주 사용: 앱 내 발주는 생성/수량관리만 (주문 전송은 외부 앱)

## 1) 기능 범위 (v1 확정)
1. 재고 갱신
   - 품목별 현재고 수동 조정(입고/사용/기타 조정)
   - 재고변동 이력 조회
2. 발주 필요 목록
   - 규칙: `현재고 <= 안전재고`면 발주 필요
   - 추천 수량: `안전재고 - 현재고` (0 미만이면 0)
3. 발주서 관리
   - 발주서 생성/상태변경
   - 품목별 주문 수량 입력
   - 부분입고 허용(회차별)
4. 집계/대시보드
   - 발주 필요 알림 배지
   - 기간별 발주/입고 집계(최근 30일 기본)
5. 감사로그 + Soft Delete
   - 모든 핵심 데이터 변경 이력 저장
   - 삭제는 soft-delete (`is_deleted`, `deleted_at`)

## 2) 제외(향후)
- 사용자/권한 다중관리 제외(관리자 1명 고정)
- 공지/푸시/문자/이메일 알림 제외
- 외부 API 연동/거래처 관리 미구현
- 파일 업로드, 고급 분석 제외

## 3) 데이터 모델(요약)
### 핵심 엔티티
- `users`: 단일 관리자 인증
- `item_categories`: 품목 분류
- `items`: 재고 대상(단위 고정='개')
- `stock_transactions`: 재고 변동 이력(입고/사용/조정)
- `purchase_orders`: 발주서
- `order_items`: 발주 항목 + 누적 입고
- `audit_logs`: 변경 이력

### 필수 필드
- `items`: `name`, `category_id`, `spec`, `unit='개'`, `safety_stock`, `min_stock`, `current_stock`, `unit_price`, `memo`, soft-delete
- `stock_transactions`: `item_id`, `movement_type(IN/OUT/ADJUST)`, `quantity`, `reason`, `order_item_id`, `created_by`
- `purchase_orders`: `title`, `status(draft|ordered|partially_received|fully_received|canceled)`, `external_order_ref`, `note`
- `order_items`: `order_id`, `item_id`, `ordered_qty`, `received_qty`, `memo`

## 4) 알림 규칙
- 서버가 주기적으로 계산 후 화면 배지 반영(매 요청 시 계산 가능)
- 배지 카운트 = `발주 필요` 상태 품목 수
- 발주 필요 리스트는 기본 화면 우선 노출

## 5) 화면 설계 (Stitch 결과)
Stitch 프로젝트 ID: `1996042492071941320`
- 대시보드: screen `72d1da41775848448bbcfa78dff22f0e`
- 품목관리: screen `0f001f6bc7cb4b41aa706f7427c111d5`
- 발주관리: screen `3c5d200b6bfd442bb966121f513eb139`
- 관리자 로그인: screen `211bd9cf008f41248336d4ad53279174`

추후 개발 시 각 화면의 HTML 산출물은 Stitch에서 추가로 내보내서 컴포넌트화 예정

## 6) 우선 작업 순서(당장 시작)
1. DB 스키마 + migration
2. Notion export 데이터 임포트(분류/품목)
3. 인증/세션
4. 재고 갱신 API + 품목 CRUD
5. 대시보드/알림 API
6. 발주관리 API
7. 감사로그 + soft-delete
8. 배포(D1 생성/연결/Pages 배포)

## 7) 다음 단계(이후 단계)
- 입고 알림 시나리오 강화(미입고 연장, D-day)
- 거래처/주문 참조/정합성 규칙 강화
- 모바일 홈 탭 UX 개선


## 8) 운영 환경(인터넷/모바일)
- 서비스는 **Cloudflare 인터넷 배포**(HTTPS 도메인)로 운영
- **모바일 우선 레이아웃** 기반, PC 반응형 지원
- 사용자 진입: 링크/QR/북마크로 스마트폰 브라우저 접속
- 로그인 후 대시보드로 이동, 배지 알림은 앱 진입 시 즉시 표시
