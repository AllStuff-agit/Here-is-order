# Cloudflare 배포 가이드 (MVP)

이 프로젝트는 Cloudflare에 두 개의 Worker를 따로 배포합니다.

- API Worker: 루트 `wrangler.toml`, Worker 이름 `hereisorder`, D1 바인딩 `DB`
- 웹 Worker: `frontend/wrangler.jsonc`, Worker 이름 `hereisorder-web`, OpenNext 기반 Next.js 앱

브라우저는 웹 Worker의 상대 경로 `/api/*`만 호출합니다. 웹 Worker가 빌드 시 설정된 `API_PROXY_URL`을 사용해 API Worker로 요청을 전달하므로, 브라우저 관점에서는 화면과 API가 같은 origin에 있습니다. 이 경로를 유지해야 `HttpOnly` 세션 쿠키 인증이 정상 동작합니다.

## 0. 준비 사항

- Node.js 22
- Cloudflare 계정
- D1과 두 Worker를 배포할 수 있는 API token
- 루트와 프론트엔드 의존성

```bash
npm ci
npm ci --prefix frontend
npx wrangler whoami
```

인증되지 않았다면 `npx wrangler login`을 실행합니다.

## 1. D1 준비

최초 한 번 D1을 만들고 출력된 `database_id`를 루트 `wrangler.toml`의 top-level D1 바인딩에 반영합니다. API 배포와 원격 migration은 별도 `--env` 없이 이 바인딩을 사용합니다.

```bash
npx wrangler d1 create hereisorder
```

DB 구조의 단일 적용 경로는 `migrations/`입니다. 새 DB나 기존 DB 모두 `db/schema.sql`을 직접 실행하지 않고 Wrangler migration 명령을 사용합니다.

```bash
# 로컬
npm run db:migrate

# 원격
npm run db:migrate:remote
```

## 2. 초기 관리자 생성

fresh clone에는 관리자 seed가 포함되지 않습니다. 12자 이상의 비밀번호를 환경변수로 전달하면 PBKDF2 해시가 담긴 `data/seed_admin.sql`을 로컬에서 생성한 뒤 D1에 적용합니다. `data/` 생성물은 계속 Git 추적 대상이 아니므로 커밋하지 않습니다.

```bash
# 로컬 DB: migration + 관리자 생성
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap

# 원격 DB: migration + 관리자 생성
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:remote
```

아이디와 표시 이름의 기본값은 각각 `admin`, `관리자`입니다. 필요하면 `ADMIN_USERNAME`, `ADMIN_NAME`도 함께 지정합니다.

Notion export로 카테고리/품목까지 적재하려면 저장소 루트에 `notion-export/` 입력을 준비한 뒤 다음 명령을 사용합니다.

```bash
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:bootstrap:from-notion
```

이 결합 bootstrap은 로컬 D1용으로 계속 제공됩니다. 생성부터 적용까지 한 번에 실행하던 원격 Notion 결합 bootstrap 기능은 제거했습니다. 운영에서는 생성물 검토가 적용보다 반드시 먼저이며 다음 순서만 사용합니다.

```bash
npm run import:notion
# data/seed_categories_items.sql, data/seed_items.csv,
# data/import-report.json과 seedSha256을 검토합니다.
npm run db:migrate:remote
npm run db:seed:remote -- --expected-sha <검토한-64자리-SHA-256>
# 최초 bootstrap에서만 실행합니다.
ADMIN_PASSWORD='12자-이상의-비밀번호' npm run db:seed:admin:remote
```

원격 품목 seed 명령은 검토자가 전달한 SHA-256, report의 `seedSha256`, 실제 SQL의 SHA-256이 모두 일치할 때만 Wrangler를 호출합니다. 운영 품목 seed SQL을 Wrangler로 직접 적용하지 않습니다.

### 운영 비밀번호 복구

로그인 가능한 관리자가 있으면 앱의 **설정 → 계정 관리**에서 다른 사용자의 비밀번호를 초기화합니다. 모든 관리자가 잠긴 경우에만 신뢰할 수 있는 운영자가 저장소 루트의 interactive TTY에서 다음 명령을 실행합니다.

```bash
npm run db:recover-password -- --remote --username admin
```

작업자 환경에는 대상 계정의 `CLOUDFLARE_ACCOUNT_ID`와 D1 읽기·쓰기가 가능한 `CLOUDFLARE_API_TOKEN`이 필요합니다. Cloudflare custom token은 대상 계정의 **Account / D1 / Edit** 권한으로 제한합니다.

명령은 대상 데이터베이스와 사용자 이름을 표시하고 `RECOVER hereisorder admin`을 정확히 입력받습니다. 이어서 12자 이상의 새 비밀번호와 확인값을 echo 없이 입력받아 일치 여부를 확인하고, 성공하면 대상 사용자의 모든 세션을 폐기한 뒤 운영자 비밀번호 복구 감사를 기록합니다.

복구할 비밀번호는 웹 hash 도구, 채팅, 이슈 또는 shell argument에 입력하지 않습니다. D1 콘솔에서 계정을 직접 수정하는 방식도 복구 경로가 아닙니다.

## 3. 수동 배포

API를 먼저 배포합니다.

```bash
npm run deploy
```

그다음 API Worker의 공개 origin을 `API_PROXY_URL`로 주입해 웹 Worker를 빌드·배포합니다. Production 값은 credential, path, query string, hash가 없는 HTTPS origin이어야 합니다. 로컬 개발의 `http://127.0.0.1:8787` 프록시는 허용합니다.

```bash
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run deploy --prefix frontend
```

OpenNext 산출물만 검증하거나 로컬 preview를 실행할 때는 다음 명령을 사용합니다.

```bash
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run build:cloudflare --prefix frontend
API_PROXY_URL='https://hereisorder.<subdomain>.workers.dev' npm run preview --prefix frontend
```

기존의 `wrangler pages deploy .vercel/output/static` 방식은 사용하지 않습니다. 현재 Next.js 앱은 `@opennextjs/cloudflare`가 생성하는 `.open-next/worker.js`와 `.open-next/assets`를 Cloudflare Worker로 배포합니다.

## 4. GitHub Actions 자동 배포

`.github/workflows/deploy-worker.yml`은 모든 pull request와 `main` push에서 다음 품질 게이트를 실행합니다.

1. 루트 `npm ci`, API typecheck/test, Worker dry-run build
2. 로컬 D1 migration 적용 검증
3. 프론트엔드 `npm ci`, lint, Next.js build
4. OpenNext Cloudflare build

위 품질 게이트는 `verify` job에서 실행됩니다. 검증이 성공한 `main` push는 별도 입력이나 승인 없이 아래 순서로 production에 반영됩니다. `workflow_dispatch`는 같은 workflow를 다시 실행하는 복구 경로입니다.

1. `verify` 완료
2. 일회용 원격 D1 rollback contract에서 named CHECK 실패와 선행 update rollback을 확인하고 데이터베이스 삭제
3. 현재 D1 bookmark, migration 이력, API/web version을 검증하는 production recovery checkpoint
4. production D1 migration 적용
5. API Worker 배포
6. API active version 검증: Wrangler deploy evidence와 Cloudflare의 단일 100% version 및 exact Git SHA message 대조
7. API `GET /health`와 `GET /ready` 200 및 응답 계약 확인
8. 검증된 API `deploymentUrl`을 `API_PROXY_URL`로 주입해 웹 Worker build/deploy
9. 웹 active version 검증: Wrangler deploy evidence와 Cloudflare의 단일 100% version 및 exact Git SHA message 대조
10. 웹/API proxy smoke: 웹 `GET /login` 200과 세션 없는 `GET /api/users/me` 401로 same-origin proxy 확인

rollback contract가 production migration보다 먼저 일회용 데이터베이스를 만들고 `finally`에서 삭제하므로, repository token에는 Workers 배포와 migration 권한 외에 D1 생성·삭제 권한이 필요합니다. production recovery checkpoint는 같은 token으로 D1 Time Travel bookmark와 Worker deployment 상태를 읽습니다. 생성·삭제·조회 권한이 없거나 정확한 rollback/checkpoint 증거를 확인하지 못하면 운영 migration 전에 배포가 중단됩니다.

GitHub Actions repository secret에는 배포용으로 다음 두 값을 설정합니다. 운영 무결성 감사에 권장하는 별도 read token은 6절을 따릅니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Workers 배포/조회, D1 migration/조회, 일회용 D1 생성·삭제 권한을 가진 API token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 대상 Cloudflare account ID |

`main`의 모든 push가 production 배포를 시작합니다. API는 root lockfile의 exact Wrangler CLI를 직접 실행하고, 웹은 frontend lockfile의 exact OpenNext CLI를 직접 실행해 내부의 pinned Wrangler에 `--message "$GITHUB_SHA" --strict`를 전달합니다. OpenNext 프로젝트에서 바깥 `wrangler deploy`를 호출하면 Wrangler가 다시 OpenNext로 위임해 같은 output file에 outer/inner session을 중복 기록하므로 사용하지 않습니다. API Worker의 실제 URL은 검증된 deploy evidence의 `deployment-url` output으로만 웹 job에 전달되므로 `PRODUCTION_API_PROXY_URL` 변수와 GitHub Environment 승인은 설정하지 않습니다. 브라우저 코드에도 API origin을 직접 넣지 않습니다.

## 5. 배포 후 확인

- 자동 smoke test에서 API Worker의 `GET /health`가 200과 `ok: true`를 반환하는지 확인
- 자동 smoke test에서 API Worker의 `GET /ready`가 200, `ready: true`, `d1-required-schema-v1`을 반환하는지 확인
- 자동 smoke test에서 웹 Worker의 세션 없는 `GET /api/users/me`가 401을 반환하는지 확인
- 웹 Worker에서 로그인 후 새로고침해도 세션이 유지되는지 확인
- `/api/dashboard`, 품목 수정, 발주 생성과 부분입고를 smoke test
- 휴대폰 브라우저에서 레이아웃과 로그인 쿠키 동작 확인
- 관리자 계정으로 계정 관리와 감사로그 접근, staff 계정의 관리자 API `403` 확인

### 5.1 Production checkpoint 증거

`production-preflight` job의 `$GITHUB_STEP_SUMMARY`가 checkpoint의 단일 authoritative evidence입니다. **Production deployment checkpoint** 제목 아래 JSON에서 다음 허용 필드만 확인합니다. raw Cloudflare response, author email, credential, production row는 evidence가 아닙니다.

- `bookmark`: migration 직전 D1 Time Travel 위치
- `appliedMigrations`, `pendingMigrations`: repository manifest와 대조한 migration 이름
- `previousDeployments.api.deploymentId`와 `previousDeployments.api.versions[]`
- `previousDeployments.web.deploymentId`와 `previousDeployments.web.versions[]`
- 각 `versions[]`의 전체 `versionId`, `percentage` traffic allocation

Incident 기록에는 workflow run URL, exact Git SHA, `executedAt`, D1 name/UUID, 위 bookmark와 두 Worker의 deployment/version allocation만 옮깁니다. 이 JSON이 없거나 `outcome`이 `ready`가 아니면 checkpoint가 없는 것으로 보고 production mutation을 시작하지 않습니다.

각 deploy job의 `$GITHUB_STEP_SUMMARY`에는 **Worker active version verification** JSON도 남습니다. API와 web 각각 다음 허용 필드만 확인합니다.

- `verificationVersion`: verifier contract version
- `gitSha`: 배포를 요청한 exact commit
- `deploymentId`, `versionId`, `trafficPercentage`: Cloudflare에서 확인한 단일 100% active allocation
- `deploymentUrl`: Wrangler deploy NDJSON에서 검증한 clean HTTPS origin
- `outcome`이 `verified`

Verifier는 Wrangler deploy NDJSON의 exact Wrangler version/command/Worker/version을 확인한 뒤 Cloudflare REST의 deployment와 version annotation을 대조합니다. API의 direct Wrangler와 웹의 direct OpenNext → inner Wrangler 모두 정확히 `wrangler-session + deploy` 두 record만 생성해야 하며, outer/inner session이 중복된 파일은 거부합니다. Wrangler deploy NDJSON과 raw Cloudflare response, author email, account ID, token, binding/resource metadata는 evidence나 artifact로 남기지 않습니다. 이 JSON이 없거나 exact SHA/`verified`가 아니면 URL 200 여부와 관계없이 해당 Worker 배포는 검증되지 않은 상태입니다. API의 `GET /ready`는 production row를 반환하지 않는 고정 probe로 required table/column을 실제 D1에서 해석하며, 503이면 migration/binding을 forward repair한 뒤 재검증합니다.

### 5.2 Failure phase별 복구

아래 phase는 “마지막으로 성공한 단계”입니다. migration이 시작된 뒤에는 schema가 일부 또는 전부 변경됐을 수 있으므로 forward repair가 기본입니다.

| 마지막 성공 phase | 확인된 production 상태 | 기본 조치 |
| --- | --- | --- |
| `verified` | production mutation 없음 | CI/config/token 문제를 수정하고 같은 SHA의 workflow 재실행 |
| `remote_contract_verified` | production mutation 없음 | D1/Worker identity, 조회 권한 또는 malformed response를 해결하고 preflight 재실행 |
| `checkpointed` | mutation 전 bookmark와 이전 Worker allocation 확보 | migration 실패·중단 여부를 확인하고 적용 이력을 기준으로 forward fix; 자동 restore 금지 |
| `migrated` | schema가 일부 또는 전부 변경됐을 수 있음 | 기존 Worker의 schema 호환성을 확인하고 forward repair |
| `api_deployed` | 새 API version이 생성됐지만 expected active state는 미확인 | verifier의 REST 수렴/traffic/message 실패를 확인하고 forward repair; smoke 금지 |
| `api_version_verified` | exact Git SHA의 API version이 100% active | `GET /health`와 D1-backed `GET /ready` 실행 |
| `api_ready_smoked` | API liveness와 required D1 schema 통과 | 검증된 동일 API URL로 web build/deploy 재시도 |
| `web_deployed` | 새 web version이 생성됐지만 expected active state는 미확인 | verifier의 REST 수렴/traffic/message 실패를 확인하고 API/D1은 유지 |
| `web_version_verified` | exact Git SHA의 web version이 100% active | login page와 unauthenticated proxy smoke 실행 |
| `web_proxy_smoked` | login page와 unauthenticated proxy smoke 통과 | 독립 smoke를 수행하고 run evidence 보존; authenticated business smoke는 Wave 1B gate |

Workflow는 Worker rollback이나 D1 restore를 자동 실행하지 않습니다. 실패한 run을 재실행하기 전 실제 Cloudflare 상태와 마지막 성공 phase를 다시 확인합니다.

### 5.3 Worker 상태 확인과 선택적 rollback

Worker rollback은 D1을 복원하지 않습니다. migration 이후에는 이전 Worker가 현재 schema/API contract와 호환된다는 근거가 있을 때만 code-only rollback을 선택합니다. 그렇지 않으면 forward repair가 기본입니다. `production-preflight` summary의 이전 `versionId`를 정확히 사용하고 deployment ID와 혼동하지 않습니다.

먼저 현재 상태와 incident용 비민감 식별자를 준비합니다.

```bash
INCIDENT_ID='replace-with-non-secret-incident-id'
API_VERSION_ID='replace-with-previousDeployments.api.versions[0].versionId'
WEB_VERSION_ID='replace-with-previousDeployments.web.versions[0].versionId'

npm exec -- wrangler deployments status --name hereisorder
npm exec -- wrangler deployments status --cwd frontend --name hereisorder-web
```

호환성 검토와 운영자 승인이 끝난 대상만 version-specific rollback합니다. 확인 prompt를 유지하기 위해 `--yes`를 사용하지 않습니다.

```bash
npm exec -- wrangler rollback "$API_VERSION_ID" --name hereisorder --message "$INCIDENT_ID"
npm exec -- wrangler rollback "$WEB_VERSION_ID" --cwd frontend --name hereisorder-web --message "$INCIDENT_ID"
```

API와 web은 독립 대상입니다. 장애가 난 Worker만 되돌리고, 각 명령 뒤 `deployments status`와 해당 smoke를 다시 실행합니다. API rollback 뒤에는 `GET /health`, web rollback 뒤에는 웹/API proxy smoke를 확인합니다.

### 5.4 예외적인 D1 Time Travel restore

D1 restore는 현재 database 상태를 과거 시점으로 되돌리는 파괴적 작업입니다. forward repair가 더 위험하다는 incident 분석, 업무 영향 확인, 별도 승인, 정확한 D1 UUID와 target bookmark 대조가 모두 끝나기 전에는 실행하지 않습니다. Worker rollback과 묶어서 실행하지도 않습니다.

Time Travel bookmark의 유효 기간은 Cloudflare plan 기준 Free 7일, Paid 30일입니다. 기간이 지났거나 target run의 **Production deployment checkpoint**에서 exact `bookmark`를 찾지 못하면 restore하지 않습니다.

승인된 restore 직전에도 현재 상태로 되돌아올 수 있도록 새 current bookmark를 먼저 조회해 보호된 incident 기록에 보존합니다. 이 명령은 항상 remote D1에 동작합니다.

```bash
npm exec -- wrangler d1 time-travel info hereisorder --json
```

새 current bookmark 기록을 별도 작업자가 확인한 뒤에만 target을 설정하고 restore합니다. placeholder나 deployment ID를 bookmark로 사용하지 않습니다.

```bash
TARGET_BOOKMARK='replace-with-exact-preflight-bookmark'
npm exec -- wrangler d1 time-travel restore hereisorder --bookmark "$TARGET_BOOKMARK"
```

Restore 뒤에는 migration 이력, 핵심 데이터 무결성, API와 web의 schema/contract 호환성을 별도로 검증합니다. 필요하면 restore 전에 기록한 current bookmark로 되돌리는 작업도 새로운 별도 승인을 받습니다. 어떤 경우에도 credential 값, raw database row, raw Cloudflare error를 GitHub summary나 incident 채팅에 복사하지 않습니다.

## 6. 운영 발주 품목 무결성 감사

이 감사는 배포와 migration에서 분리된 수동 read-only 절차입니다. GitHub Actions에서 **Audit production order item integrity** workflow를 `main` 대상으로 실행하고, 필수 `request_id`에는 이 실행을 추적할 비민감 식별자(예: `wave-0d-20260713-01`)를 입력합니다. `request_id`는 실행 간 상관관계 확인용일 뿐 승인, 권한 부여 또는 SQL 입력이 아닙니다. secret이나 개인정보를 넣지 않습니다.

Workflow는 저장소에 고정된 다음 summary 명령만 실행하며 row details나 raw Wrangler 출력을 artifact로 만들지 않습니다.

```bash
npm run db:audit:order-items -- --remote --summary
```

실행 URL, `request_id`, `queryVersion`, `executedAt`, aggregate summary를 함께 보관하고 결과를 다음처럼 판정합니다.

- `clean`: 모든 active defect count와 `maskedOrders`가 0입니다. `deletedOverreceivedRows`는 삭제된 legacy row에 대한 참고값이므로 단독으로 수선을 요구하지 않습니다.
- `repair_required`: CLI가 exit 2를 반환해 workflow가 실패로 표시될 수 있지만 이는 감사 발견 사항입니다. 배포된 0A–0C hotfix를 유지하고 ledger와 업무 증거를 검토하는 별도 승인 repair spec을 만듭니다.
- `outcome`을 포함한 허용 목록 summary JSON 없이 실패한 경우에는 판정하지 않습니다. credential 또는 실행 오류를 해결한 뒤 새 `request_id`로 다시 실행합니다.

감사 workflow에는 Account / D1 / Read로 제한한 repository secret `CLOUDFLARE_D1_READ_TOKEN`을 권장합니다. Workflow는 `${{ secrets.CLOUDFLARE_D1_READ_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}` 순서로 token을 선택하므로, read token이 없으면 더 넓은 mutation 권한을 가진 기존 배포 token으로 fallback합니다. 고정·검토된 read-only SQL, 수동 main workflow와 버전 고정 Actions는 코드 수준 보호 장치이지 credential 최소권한을 대신하지 않습니다.

Row 단위 증거가 꼭 필요할 때만 CI 밖의 보호된 운영자 terminal에서 details를 실행합니다. `CLOUDFLARE_ACCOUNT_ID`와 전용 D1 Read token을 준비하고, 저장소 밖의 mode `0700` 디렉터리와 아직 존재하지 않는 절대 출력 경로를 사용합니다.

```bash
DETAIL_DIR="$HOME/.local/share/hereisorder-audit"
AUDIT_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DETAIL_DIR"
chmod 700 "$DETAIL_DIR"

CLOUDFLARE_API_TOKEN="$CLOUDFLARE_D1_READ_TOKEN" \
npm run db:audit:order-items -- \
  --remote --details \
  --output "$DETAIL_DIR/order-item-integrity-$AUDIT_TIMESTAMP.json"
```

Details 명령은 CI, 상대 경로, 저장소 내부 경로와 기존 파일 덮어쓰기를 거부하며 새 파일을 mode `0600`으로 만듭니다. 파일을 GitHub artifact, Git commit, PR, issue, chat 또는 공용 terminal log에 올리지 않습니다. 승인된 암호화 저장소에서 필요한 기간만 보관한 뒤 운영 보존 정책에 따라 삭제합니다.

Summary와 details는 수선 증거일 뿐 mutation 승인이 아닙니다. 이 결과만으로 `received_qty`를 clamp하거나 `stock_transactions`를 삭제·수정하거나 `items.current_stock`을 재계산해 덮어쓰지 않습니다. 모든 production 수선은 별도 spec, 승인, backup 및 ledger·업무 증거를 거쳐야 합니다.
