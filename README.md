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

### 비밀번호를 잊어버렸을 때

Cloudflare D1 콘솔에서 직접 비밀번호를 초기화할 수 있습니다.

1. [dash.cloudflare.com](https://dash.cloudflare.com)에 로그인합니다.
2. 좌측 메뉴에서 **Storage & Databases → D1 SQL Database**를 클릭합니다.
3. **hereisorder** 데이터베이스를 클릭합니다.
4. 상단 **Console** 탭을 클릭합니다.
5. 새 비밀번호의 SHA-256 해시를 구합니다. 예: [SHA-256 온라인 도구](https://emn178.github.io/online-tools/sha256.html)에 새 비밀번호를 입력하면 해시값이 나옵니다.
6. 아래 SQL을 입력하고 **Execute** 버튼을 누릅니다.

```sql
UPDATE users
SET password_hash = '여기에_SHA256_해시값_붙여넣기'
WHERE username = '아이디';
```

7. 앱으로 돌아와 새 비밀번호로 로그인합니다.

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
- `db:bootstrap`, `db:bootstrap:remote`: migration + 관리자 seed
- `db:bootstrap:from-notion`, `db:bootstrap:remote:from-notion`: Notion 품목 seed 포함
- `npm run build:cloudflare --prefix frontend`: OpenNext Worker 산출물 검증
- `npm run deploy --prefix frontend`: 웹 Worker 배포
- `npm run deploy`: API Worker 배포

## Cloudflare 자동 배포

GitHub Actions에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID` repository secret을 한 번 등록한 뒤에는 `main` push만으로 배포됩니다.

```bash
git push origin main
```

Workflow는 검증 → production D1 migration → API Worker 배포/health check → API URL을 주입한 웹 Worker 배포 → 웹/API proxy smoke test 순서로 실행됩니다. 별도 `PRODUCTION_API_PROXY_URL` 변수나 GitHub Environment 승인은 필요하지 않습니다.

### 수동 복구 배포

GitHub Actions를 사용할 수 없는 장애 상황에서는 API Worker를 먼저 배포한 뒤 해당 origin을 웹 빌드의 서버 전용 `API_PROXY_URL`로 전달합니다. 관리자 계정이 없는 최초 bootstrap에서만 `ADMIN_PASSWORD` 명령을 먼저 실행합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:remote
npm run deploy
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run deploy --prefix frontend
```

세부 권한과 최초 설정은 [Cloudflare 배포 가이드](docs/design/cloudflare-deploy-guide.md)를 참고하세요.
