# 카페 발주 관리 웹 MVP (Cloudflare D1 + Workers)

> 매장 1곳의 재고·발주·부분입고를 관리하는 모바일 우선 웹 서비스

## 현재 구현

- `admin` / `staff` 역할과 30일 세션 로그인
- 카테고리·품목 조회/등록/수정/soft-delete
- IN / OUT / ADJUST 재고 조정과 원장
- 부족재고 알림: `current_stock < safety_stock`
- 진행 중 발주의 미입고 수량을 뺀 추천발주 수량
- 발주 초안, 일괄 항목 생성, 확정, 부분입고, 상태 자동 전환
- 핵심 변경 감사로그
- Next.js 모바일/PC 반응형 화면
- API/웹 품질 게이트와 Cloudflare 분리 배포

## 구조

```text
Browser
  └─ hereisorder-web (Next.js + OpenNext Worker)
       └─ same-origin /api/* proxy
            └─ hereisorder (Hono API Worker)
                 └─ Cloudflare D1
```

## 빠른 시작 (로컬)

Node.js 22가 필요합니다. 루트와 `frontend/`는 별도 npm 프로젝트이므로 두 lockfile을 각각 설치합니다.

```bash
npm ci
npm ci --prefix frontend
```

fresh clone에서는 12자 이상의 관리자 비밀번호를 직접 지정해 migration과 관리자 seed를 적용합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap
```

기본 관리자 아이디는 `admin`, 표시 이름은 `관리자`입니다. 필요하면 bootstrap 명령에 `ADMIN_USERNAME`, `ADMIN_NAME`도 전달할 수 있습니다. 비밀번호가 포함된 `data/seed_admin.sql`은 실행 시 생성되며 Git에 포함하지 않습니다.

API와 웹 개발 서버를 각각 실행합니다.

```bash
# 터미널 1
npm run dev:api

# 터미널 2
npm run web:dev:local
```

`web:dev:local`은 브라우저의 상대 `/api/*` 요청을 `http://127.0.0.1:8787`로 프록시해 쿠키 기반 인증을 유지합니다.

Notion export로 카테고리/품목도 초기화하려면 저장소 루트에 `notion-export/`를 준비한 뒤 다음 명령을 사용합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:from-notion
```

이 로컬 결합 bootstrap은 계속 제공됩니다. `notion-export/`와 생성된 `data/`는 계속 Git 추적 대상이 아니므로 커밋하지 않습니다.

운영 D1에서는 생성부터 적용까지 한 번에 실행하던 원격 Notion 결합 bootstrap 기능을 제거했습니다. 생성물을 적용하기 전에 반드시 검토하고 다음 순서로 분리해 실행합니다.

```bash
npm run import:notion
# data/seed_categories_items.sql, data/seed_items.csv,
# data/import-report.json과 seedSha256을 검토합니다.
npm run db:migrate:remote
npm run db:seed:remote -- --expected-sha <검토한-64자리-SHA-256>
# 최초 bootstrap에서만 실행합니다.
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:seed:admin:remote
```

원격 품목 seed 명령은 검토자가 전달한 SHA-256, report의 `seedSha256`, 실제 SQL의 SHA-256이 모두 일치할 때만 D1 적용을 시작합니다. 운영 품목 seed를 Wrangler로 직접 적용하지 않습니다.

### 운영 비밀번호 복구

복구 경로는 다음 두 가지뿐입니다.

1. 로그인 가능한 관리자가 있으면 앱의 **설정 → 계정 관리**에서 다른 사용자의 비밀번호를 초기화합니다.
2. 모든 관리자가 잠겼으면 저장소 루트의 interactive TTY에서 신뢰할 수 있는 운영자가 다음 명령을 실행합니다.

```bash
npm run db:recover-password -- --remote --username admin
```

작업자 환경에는 대상 계정의 `CLOUDFLARE_ACCOUNT_ID`와 D1 읽기·쓰기가 가능한 `CLOUDFLARE_API_TOKEN`이 필요합니다. Cloudflare custom token 권한은 대상 계정의 **Account / D1 / Edit**로 제한합니다.

명령은 대상 데이터베이스와 사용자 이름을 표시하고 `RECOVER hereisorder admin`을 정확히 입력받은 뒤, 12자 이상의 새 비밀번호를 echo 없이 두 번 입력받습니다. 성공하면 대상 사용자의 모든 세션을 폐기하고 운영자 비밀번호 복구 감사를 기록합니다.

복구할 비밀번호를 웹 hash 도구, 채팅, 이슈 또는 shell argument에 입력하지 마세요. D1 콘솔에서 계정을 직접 수정하는 방식도 사용하지 않습니다.

## 주요 API

- 인증/사용자: `POST /api/auth/login`, `GET /api/users/me`, `GET|POST /api/users`
- 대시보드: `GET /api/dashboard`
- 품목: `GET /api/items?needReorder=true`, `POST|PATCH|DELETE /api/items/*`
- 재고: `POST /api/stock/adjust`, `GET /api/stock/ledger/:item_id`
- 발주: `GET|POST /api/purchase-orders`, `POST /api/purchase-orders/with-items`
- 발주 항목/입고: `POST /api/purchase-orders/:id/items`, `PATCH /api/purchase-orders/:id/items/:itemId`, `POST .../:itemId/receive`
- 감사로그: `GET /api/audit-logs` (admin)

`/purchase-orders/:id/items/:itemId`의 `:itemId`는 품목 ID가 아니라 `order_items.id`입니다. 전체 요청·응답 계약은 [API 설계](docs/design/api-spec-v1.md)를 참고하세요.

## 프로젝트 스크립트

- `dev:api`, `web:dev:local`: API Worker와 로컬 API proxy 웹 실행
- `typecheck`, `test`, `build`: API typecheck, test, Worker dry-run
- `web:lint`, `web:build`: Next.js lint/build
- `db:migrate`, `db:migrate:remote`: `migrations/` 로컬/원격 적용
- `db:seed`, `db:seed:remote`: Notion 품목 seed 로컬 적용 / 검토한 세 SHA-256 일치 후 원격 적용
- `db:seed:admin`, `db:seed:admin:remote`: 관리자 seed 로컬/원격 적용
- `db:bootstrap`, `db:bootstrap:remote`: migration + 관리자 seed
- `db:bootstrap:from-notion`: Notion 변환 + migration + 품목/관리자 seed를 로컬 D1에 적용
- `import:notion`: `notion-export/`를 검토용 `data/` 생성물로 변환
- `deploy:preflight`: GitHub Actions에서 production D1/Worker recovery checkpoint 검증
- `npm run build:cloudflare --prefix frontend`: OpenNext Worker 산출물 검증
- `npm run deploy --prefix frontend`: 웹 Worker 배포
- `npm run deploy`: API Worker 배포

## Cloudflare 자동 배포

GitHub Actions에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID` repository secret을 한 번 등록한 뒤에는 `main` push만으로 배포됩니다.

```bash
git push origin main
```

Workflow는 다음 순서를 벗어나지 않습니다.

1. `verify`
2. 일회용 원격 D1 rollback contract
3. production recovery checkpoint
4. production D1 migration
5. API Worker 배포
6. API active version 검증
7. API `GET /health`와 `GET /ready` smoke
8. 검증된 API URL을 주입한 웹 Worker build/deploy
9. 웹 active version 검증
10. 웹/API proxy smoke
11. authenticated business smoke: `login → me → purchase-order read → logout → old-cookie 401`

Repository secret `PRODUCTION_SMOKE_PASSWORD`는 S1 merge/deploy 성공 뒤 stdin-only로 설치해 lifecycle workflow의 create-only provision step에 먼저 전달합니다. create-only provision exact whitelist evidence를 확인한 뒤에만 S2/deploy gate가 이 secret을 사용합니다. 이후에도 deploy workflow의 마지막 authenticated business smoke step과 lifecycle workflow의 provision/rotate step에만 전달하며 disable에는 전달하지 않습니다. 성공 증거는 `authenticated-business-smoke-v1` seven-field whitelist evidence만 남기고 secret value는 문서, log 또는 artifact에 남기지 않습니다.

rollback contract는 일회용 D1에서 named CHECK 실패와 선행 update의 rollback을 확인하고 데이터베이스를 삭제합니다. production recovery checkpoint는 현재 D1 Time Travel bookmark, migration 적용 이력, 기존 API/web Worker version을 읽어 GitHub job summary에 남깁니다. 두 gate가 모두 성공해야 production D1 migration이 시작됩니다. 각 Worker는 lockfile의 exact Wrangler로 배포하고, machine deploy evidence의 version ID와 Cloudflare의 단일 100% active version 및 exact Git SHA message가 일치해야 smoke를 시작합니다. API readiness는 실제 D1 required schema를 compile-only read로 확인합니다. 따라서 배포 token에는 Workers 배포와 migration 권한뿐 아니라 D1 생성·삭제 권한과 D1/Worker 상태 조회 권한도 필요합니다. 별도 `PRODUCTION_API_PROXY_URL` 변수나 GitHub Environment 승인은 필요하지 않습니다.

실패 단계별 forward repair, Worker rollback, 예외적인 D1 restore 판단은 [Cloudflare 배포 가이드의 배포 복구 runbook](docs/design/cloudflare-deploy-guide.md#52-failure-phase별-복구)을 따릅니다. Workflow는 Worker rollback이나 D1 restore를 자동 실행하지 않습니다.

### 운영 smoke identity

Authenticated business smoke는 fixed `deployment-smoke` staff identity를 사용합니다. Identity lifecycle은 main의 `Manage production smoke identity` 수동 workflow만 사용하며 D1 콘솔이나 임의 SQL로 변경하지 않습니다. Repository secret `PRODUCTION_SMOKE_PASSWORD`에는 stdout·argv·파일을 거치지 않고 생성한 48-byte random credential을 저장합니다.

최초 설정은 S1 merge/deploy 성공 → secret 설치 → `manage-smoke-identity.yml`의 `provision`과 `MANAGE hereisorder deployment-smoke provision` dispatch → provision run 성공 → provision exact whitelist evidence 확인 → S1 ready 기록 후 S2 허용 순서입니다.

Rotation은 `disable`/`MANAGE hereisorder deployment-smoke disable` dispatch → disable run 성공 → disable exact whitelist evidence로 모든 세션을 폐기했음을 확인 → 새 secret 설치 → `rotate`/`MANAGE hereisorder deployment-smoke rotate` dispatch → rotate run 성공 → rotate exact whitelist evidence 확인 순서입니다. Disable run과 evidence가 모두 성공하기 전에는 secret을 교체하지 않습니다. Password, hash, user/session row, raw production response는 evidence가 아닙니다. Lifecycle run이 실패하거나 whitelist evidence가 없거나 malformed이면 authenticated smoke gate 병합과 S2 진행을 중단합니다.

### 수동 복구 배포

GitHub Actions를 사용할 수 없는 장애 상황에서는 곧바로 production mutation을 실행하지 않습니다. 먼저 [배포 복구 runbook](docs/design/cloudflare-deploy-guide.md#52-failure-phase별-복구)에서 현재 phase와 checkpoint를 확인하고, 기존 D1 bookmark와 API/web Worker version을 별도 incident 기록에 보존합니다. 아래 명령은 새 환경의 최초 bootstrap 또는 그 기록과 복구 판단을 마친 뒤에만 사용합니다. API Worker를 먼저 배포한 다음 해당 origin을 웹 빌드의 서버 전용 `API_PROXY_URL`로 전달합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:remote
npm run deploy
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run deploy --prefix frontend
```

세부 권한과 최초 설정은 [Cloudflare 배포 가이드](docs/design/cloudflare-deploy-guide.md)를 참고하세요.
