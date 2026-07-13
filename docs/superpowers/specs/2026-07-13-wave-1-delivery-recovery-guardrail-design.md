# Wave 1 Delivery / Recovery Guardrail 설계

작성일: 2026-07-13

상태: 승인된 위험 우선 포트폴리오의 상세 설계

대상: production D1 migration, API Worker, web Worker의 자동 배포와 복구 절차

## 1. 결론

Wave 1은 production 변경 전에 복구 가능한 기준점을 증명하고, 배포 뒤에는 D1과 인증 경로를 실제로 확인하는 두 개의 독립 배포 단위로 진행한다.

1. **Wave 1A — immutable production preflight와 recovery evidence**
   - GitHub Actions와 Node/Wrangler toolchain을 불변 버전으로 고정한다.
   - production D1 identity, Time Travel bookmark, applied/pending migration을 mutation 전에 검증한다.
   - API/web의 현재 active deployment ID와 전체 traffic allocation을 mutation 전에 기록한다.
   - 실패 phase별 forward repair와 선택적 Worker rollback 절차를 실행 가능한 명령으로 고정한다.
2. **Wave 1B — D1 readiness와 authenticated business smoke**
   - required schema를 실제 D1에서 읽는 readiness를 추가한다.
   - 전용 최소권한 smoke identity로 login, current user, business read, logout, revoked-session 확인을 자동화한다.
   - API Worker observability와 배포 후 active version 검증을 완료한다.

Wave 1 전체가 완료되어 Wave 1B의 production readiness와 authenticated business smoke까지 통과하기 전에는 Wave 2 Identity / Session 변경을 시작하지 않는다. Wave 1B의 production smoke identity 생성은 별도 구현 계획에서 최소권한·감사·폐기 방식을 명시한 뒤 수행한다.

## 2. 현재 기준선

이미 완료된 안전장치:

- pull request와 `main`의 API/web 전체 검증 및 local migration 적용
- 같은 ref의 배포 직렬화와 실행 중 취소 금지
- disposable remote D1의 failure batch rollback 증명 및 cleanup
- production migration → API deploy/smoke → web build/deploy/smoke 순서
- HTTPS deployment origin 검증과 bounded retry
- Wave 0D read-only 운영 감사와 SHA-pinned workflow

남은 핵심 위험:

- disposable D1 contract는 production backup이 아니다. 현재 workflow는 production bookmark를 기록하지 않고 migration을 적용한다.
- `wrangler d1 migrations list --remote`는 migration table을 생성할 수 있으므로 strict read-only preflight로 사용할 수 없다.
- `/health`는 정적 JSON이며 D1을 읽지 않는다. cookie 없는 `/api/users/me`도 D1 조회 전에 401을 반환한다.
- workflow summary는 deployment URL만 남기므로 실패 뒤 정확한 이전 Worker version을 알 수 없다.
- deploy workflow의 Action tag와 Node major selector는 mutable하다.
- web Worker만 observability가 명시되어 있고 API Worker는 없다.

## 3. 선택한 접근법

### 3.1 Production D1 preflight는 strict REST adapter로 수행한다

저장소의 `wrangler.toml`을 source of truth로 읽고 Cloudflare REST API에서 같은 이름의 D1이 정확히 하나이며 UUID도 일치하는지 확인한다. 그 뒤 다음 read만 수행한다.

- D1 Time Travel current bookmark 조회
- `d1_migrations`의 `id`, `name`, `applied_at` 조회
- API/web Worker의 current deployment와 전체 traffic allocation 조회

로컬 `migrations/*.sql` manifest와 production applied migration은 정확한 prefix 관계여야 한다. production에만 있는 migration, 순서가 바뀐 migration, 잘못된 ID, malformed response, bookmark 부재는 모두 fail closed한다.

선택 이유:

- Wrangler의 human-readable output parsing을 피한다.
- `migrations list`가 migration table을 만드는 숨은 write를 피한다.
- 허용한 endpoint와 fixed SQL만 사용하는 작은 실제 Cloudflare adapter를 유지한다.
- row data 대신 migration 이름과 opaque bookmark만 기록할 수 있다.

### 3.2 Export artifact 대신 Time Travel bookmark를 사용한다

Cloudflare D1 Time Travel은 production storage에서 자동으로 유지되며 bookmark로 point-in-time restore 위치를 식별한다. CI에서 전체 D1 export를 artifact로 만들지 않는다.

- production row가 GitHub artifact나 log로 복제되지 않는다.
- migration 직전 위치를 정확히 기록한다.
- bookmark 조회 실패 시 production mutation을 시작하지 않는다.

Time Travel restore는 destructive operation이므로 workflow가 자동 실행하지 않는다. 별도 승인, 업무 영향 확인, 현재 bookmark 재기록, exact target bookmark 확인 뒤 운영자가 실행한다. Bookmark는 보존 기간 안에서만 유효하며 Cloudflare 문서 기준 Workers Free는 7일, Paid는 30일이다.

근거:

- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare D1 Time Travel API](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/)

### 3.3 Worker rollback은 code-only 실패에만 선택적으로 사용한다

Cloudflare Worker rollback은 연결된 D1을 되돌리지 않는다. 따라서 production migration이 적용된 뒤에는 forward repair가 기본이다.

- migration 전 실패: production mutation 없음
- migration 적용 뒤 API deploy 실패: 기존 API가 새 schema와 호환되는지 확인하고 forward repair
- API deploy 뒤 readiness 실패: migration이 없거나 이전 Worker와 schema가 호환될 때만 이전 API version rollback 가능
- web deploy/smoke 실패: 이전 web version rollback 가능; API rollback은 schema/contract 호환성을 별도 확인
- D1 restore: Worker rollback과 결합해 자동화하지 않으며 별도 승인 필요

근거:

- [Cloudflare Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare Worker deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list)

### 3.4 Supply chain과 runtime은 exact version으로 고정한다

- 모든 external Action은 검증한 full commit SHA를 사용한다.
- checkout은 credentials를 persist하지 않는다.
- Node는 `.node-version`과 workflow에서 exact patch를 공유한다.
- Node 배포판에 포함된 npm version을 `packageManager` metadata로 고정한다.
- root/frontend Wrangler는 같은 exact version과 lockfile을 사용한다.
- `npm ci`만 사용하며 lockfile을 workflow에서 생성하지 않는다.

GitHub는 full-length commit SHA가 Action을 immutable하게 참조하는 유일한 방식이라고 안내한다.

근거: [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)

## 4. Wave 1A 상세 설계

### 4.1 Preflight report

로그와 job summary에는 다음 whitelist만 남긴다.

```json
{
  "preflightVersion": "production-deployment-preflight-v1",
  "executedAt": "RFC3339 timestamp",
  "gitSha": "40 lowercase hex",
  "runId": "GitHub numeric run id",
  "runAttempt": 1,
  "databaseName": "hereisorder",
  "databaseId": "configured UUID",
  "bookmark": "opaque Cloudflare bookmark",
  "appliedMigrations": ["001_init.sql", "002_integrity_and_roles.sql"],
  "pendingMigrations": [],
  "previousDeployments": {
    "api": {
      "deploymentId": "UUID",
      "createdOn": "RFC3339 timestamp",
      "versions": [{ "versionId": "UUID", "percentage": 100 }]
    },
    "web": {
      "deploymentId": "UUID",
      "createdOn": "RFC3339 timestamp",
      "versions": [{ "versionId": "UUID", "percentage": 100 }]
    }
  },
  "outcome": "ready"
}
```

Cloudflare API가 반환한 deployment 목록은 `created_on` 내림차순으로 결정적으로 정렬해 최신 항목을 선택한다. 빈 목록, malformed timestamp/UUID/allocation, 두 개 이상의 active version, 또는 정확히 100%가 아닌 allocation은 기존 gradual deployment를 실수로 덮어쓰지 않도록 fail closed한다.

다음을 기록하지 않는다.

- production table row
- user, item, order, session data
- Cloudflare token 또는 request header
- Worker author email
- raw Cloudflare error envelope

### 4.2 Workflow ordering

```text
verify
  -> disposable D1 rollback contract
  -> production preflight/checkpoint
  -> production migration
  -> API deploy/smoke
  -> web build/deploy/smoke
```

`production-preflight`가 실패하면 production migration, API deploy, web deploy는 모두 실행되지 않는다. Preflight output은 후속 job input이 아니라 recovery evidence다. production target은 repository config의 fixed database/Worker 이름만 사용하며 workflow input으로 받지 않는다.

### 4.3 Failure phase classification

| 마지막 성공 phase | production 상태 | 기본 조치 |
| --- | --- | --- |
| `verified` | production mutation 없음 | CI/config/token 문제를 수정하고 재실행 |
| `remote_contract_verified` | production mutation 없음 | preflight response/identity 문제를 수정 |
| `checkpointed` | mutation 전 bookmark와 이전 version 확보 | migration 실패 원인 확인 후 forward fix |
| `migrated` | schema 일부 또는 전체 변경 가능 | 이전 Worker 호환성 확인, 기본은 forward repair |
| `api_deployed` | 새 API가 traffic 처리 | readiness 실패 원인 확인; 안전할 때만 이전 API rollback |
| `api_health_smoked` | API public health 통과 | web build/deploy를 재시도 |
| `web_deployed` | 새 web이 traffic 처리 | web smoke 실패 시 이전 web rollback 또는 forward fix |
| `web_proxy_smoked` | 기존 login page와 unauthenticated proxy smoke 통과 | Wave 1B readiness/business smoke가 별도 gate |

Workflow가 실패 phase에서 자동 rollback 또는 D1 restore를 실행하지 않는다.

## 5. Wave 1B 상세 방향

### 5.1 D1 readiness

새 readiness adapter는 required schema를 최소 read로 확인한다. D1 binding 누락, query 실패, required table/column 부재는 503을 반환하고 내부 error detail은 public response에 노출하지 않는다. liveness 성격의 기존 `/health`는 그대로 둘 수 있다.

### 5.2 Authenticated business smoke

전용 최소권한 identity를 사용해 same-origin web URL에서 다음 순서를 검증한다.

1. login page 200
2. login 200과 session cookie 획득
3. `/api/users/me` 200과 exact role projection
4. read-only business endpoint 200과 runtime envelope 검증
5. logout 200
6. 이전 cookie로 `/api/users/me` 401

password, cookie, response row는 log와 summary에 남기지 않는다. 중간 read가 실패해도 `finally`에서 logout을 시도한다. 전용 identity의 생성·비밀번호 rotation·폐기는 Wave 1B plan에서 별도 승인 가능한 production change로 다룬다.

### 5.3 Observability와 post-deploy verification

API Worker도 explicit observability를 활성화한다. 배포 명령은 git SHA를 version message로 넣고, Wrangler machine output과 Cloudflare active deployment/version을 대조한다. URL 200만으로 배포 성공을 판정하지 않는다.

근거: [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

## 6. 제외 범위

Wave 1에서 하지 않는 일:

- production D1 자동 restore
- migration 뒤 무조건적인 Worker 자동 rollback
- production row export를 CI artifact로 보관
- dashboard에서 수동 변경된 config를 source of truth로 채택
- Identity / Session deep module, rate limit, password policy 통합
- 관리자 bootstrap 동작 변경
- staging environment 신설
- gradual deployment 도입

## 7. 완료 gate

Wave 1A 완료:

- external Actions, Node, npm, root/frontend Wrangler가 exact version으로 고정된다.
- production D1 identity/bookmark/migration divergence가 strict test로 검증된다.
- preflight 실패 시 production mutation job이 시작되지 않는다.
- 이전 API/web active deployment ID, 전체 traffic allocation과 D1 bookmark를 배포 전에 기록한다.
- phase별 recovery 명령과 forward-repair 기본값이 문서화된다.
- PR 검증, main 배포, production preflight summary, API/web smoke가 실제로 통과한다.

Wave 1 전체 완료:

- readiness가 D1 required schema를 실제로 읽는다.
- 전용 최소권한 identity의 login → me → business read → logout → revoked 401 smoke가 통과한다.
- API observability와 expected active Worker version 검증이 켜져 있다.
- failure fixture가 안전한 recovery 분류 하나로 결정된다.
- Wave 1A와 1B가 각각 독립 PR/배포 증거를 가진다.
