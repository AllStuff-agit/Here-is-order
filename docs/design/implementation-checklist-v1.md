# MVP 구현 체크리스트 (v1)

체크 상태는 저장소에 구현·검증 가능한 항목과 운영자가 Cloudflare에서 직접 설정해야 하는 항목을 구분합니다.

## 저장소 구현 완료

- [x] D1 초기 스키마를 `migrations/` 단일 적용 경로로 구성
- [x] fresh clone에서 `ADMIN_PASSWORD`로 관리자 seed 생성 및 bootstrap
- [x] 세션 로그인과 PBKDF2 비밀번호 저장
- [x] 비밀번호 변경/관리자 초기화 시 기존 세션 폐기
- [x] 단일 매장 내 `admin` / `staff` 역할 분리
  - [x] 관리자 전용 계정 생성·목록·비밀번호 초기화
  - [x] 관리자 전용 감사로그 조회
  - [x] 로그인/내 계정 응답에 역할 포함
- [x] 품목·카테고리 API
  - [x] 목록/검색/등록/수정/soft-delete
  - [x] 안전재고·최소재고·단가 검증
  - [x] 초기 현재고의 ADJUST 원장 생성
  - [x] 현재고 직접 수정 차단 및 재고 원장 경유
- [x] 재고 조정 API
  - [x] IN/OUT/ADJUST 기록과 음수 재고 방지
  - [x] 품목 재고와 원장 기록의 원자적 갱신
  - [x] ledger 조회
- [x] 대시보드/알림 API
  - [x] `current_stock < safety_stock` 기준 부족재고 계산
  - [x] 추천수량에서 진행 중 발주의 미입고 수량 차감
  - [x] 기간별 발주/입고 집계
- [x] 발주 관리 API
  - [x] 초안 생성, 항목 추가/수정, 발주 확정
  - [x] 발주서+항목 원자적 일괄 생성(`with-items`)
  - [x] 부분입고와 재고/원장/상태의 원자적 갱신
  - [x] 입고 상태 자동 전환과 초안 삭제 제한
  - [x] 역방향 상태 전이 및 입고 후 취소 차단
- [x] 핵심 변경 감사로그
- [x] 로그인·대시보드·품목·알림·발주·설정 반응형 화면
- [x] API/관리자 seed 자동 테스트와 strict TypeScript typecheck
- [x] Next.js lint/build 및 Worker dry-run 검증
- [x] OpenNext 기반 Cloudflare 웹 Worker 구성
- [x] pull request/`main` 품질 게이트와 D1→API→웹 순차 배포 workflow
- [x] `main`의 모든 push에서 production 자동 배포
- [x] exact Wrangler deploy evidence에서 검증한 API URL만 웹 `API_PROXY_URL`로 전달
- [x] 웹 배포는 OpenNext CLI를 직접 호출해 inner Wrangler의 exact 2-record evidence만 생성
- [x] API health/D1 readiness 및 웹 same-origin proxy smoke test
- [x] 별도 production URL 변수와 Environment 승인 불필요

## Wave 2A identity compatibility gate

- [ ] Least-privilege repository secret `CLOUDFLARE_D1_READ_TOKEN` 설치와 secret 이름 확인
- [ ] Wave 2A PR의 검토와 `main` merge 완료
- [ ] 병합 commit의 정상 production deploy 성공과 배포된 exact main SHA 기록
- [ ] 해당 SHA에서 `audit-identity-compatibility.yml`을 한 번 dispatch하고 workflow가 audit 명령 직전과 직후 built-in `github.token`으로 live remote `main` SHA와 `GITHUB_SHA`의 동일성을 재검증한 성공 run 및 정확히 하나의 8-field report 확인
- [ ] `unsupportedPasswordHashCount = 0`과 `invalidIdentityProjectionCount = 0` production evidence 확인
- [ ] 모든 증거가 충족되고 Wave 2B가 evidence 사용 직전 live remote `main`을 다시 읽어 같은 merge SHA임을 확인한 뒤에만 Wave 2B 시작

## 운영자 설정 필요

- [ ] Cloudflare 인증 확인(`npx wrangler whoami`)
- [ ] production D1 생성 또는 기존 D1 확인
- [ ] 루트 `wrangler.toml`의 D1 `database_id` 확인
- [ ] GitHub Actions repository secret 확인
  - [ ] Secret `CLOUDFLARE_API_TOKEN`
  - [ ] Secret `CLOUDFLARE_ACCOUNT_ID`
- [ ] 12자 이상 `ADMIN_PASSWORD`로 production DB bootstrap
- [ ] 필요한 경우 Notion export를 준비해 카테고리/품목 seed 적용
- [ ] API Worker와 웹 Worker 최초 배포
- [ ] 로그인·재고 조정·발주·부분입고 production smoke test
- [ ] admin/staff 권한 경계 확인
- [ ] 모바일 실기기 접속과 세션 유지 확인
