# Wave 1B Runtime Verification 설계

작성일: 2026-07-13

상태: Wave 1 delivery/recovery guardrail의 첫 번째 구현 단위

## 1. 결론

Wave 1B는 운영 데이터 변경 여부를 기준으로 두 단위로 나눈다.

1. **Wave 1B-R — runtime verification**
   - public liveness인 `GET /health`는 그대로 유지한다.
   - public readiness인 `GET /ready`가 실제 D1에서 required schema를 compile-only read로 검증한다.
   - API Worker의 persisted invocation logs를 명시적으로 활성화하고, application failure log는 고정된 event allowlist만 남긴다.
   - API/web를 repository가 pin한 Wrangler CLI로 배포하고 exact git SHA를 version message로 기록한다.
   - smoke 전에 Wrangler deploy NDJSON과 Cloudflare REST deployment/version을 대조한다.
2. **Wave 1B-S — authenticated business smoke**
   - 고정된 최소권한 `staff` identity의 lifecycle과 secret 설정을 별도 운영 변경으로 승인받는다.
   - same-origin web 경로에서 login → me → business read → logout → revoked 401을 검증한다.

이 문서의 구현 범위는 production row를 바꾸지 않는 Wave 1B-R이다. Wave 1B-S가 운영에서 통과하기 전까지 Wave 1 전체는 완료가 아니며 Wave 2 Identity/Session 변경을 시작하지 않는다.

## 2. 현재 위험

- `GET /health`는 정적 JSON만 반환하므로 D1 binding, table 또는 column이 깨져도 200이다.
- API Worker의 `wrangler.toml`에는 observability가 없고 raw exception을 `console.error`로 기록한다.
- Wrangler deploy 성공과 URL 200만으로는 현재 100% traffic version이 요청한 commit인지 증명할 수 없다.
- 인증 smoke 계정 생성·회전·비활성화는 `users`, `sessions`, `audit_logs`를 바꾸는 production data mutation이다.
- 현재 `staff`는 최소 role이지만 business write가 가능하므로 진정한 read-only role은 아니다. 새 role 도입은 Wave 2 authorization 범위다.

## 3. D1 readiness

### 3.1 Probe 소유권

새 `src/readiness.ts` deep Module이 다음을 소유한다.

- `d1-required-schema-v1` contract 이름
- required table/column의 고정 compile probe SQL
- D1 result의 exact safe projection 검증
- 성공/실패를 data row 없이 판정하는 함수

Probe는 모든 required table에 대해 `WHERE 0`인 subquery를 한 statement에서 실행한다. SQLite는 statement 준비 단계에서 table/column을 해석하지만 조건 때문에 production row는 반환하지 않는다. 다음 runtime surface를 현재 migration 기준으로 검사한다.

- `users`
- `sessions`
- `item_categories`
- `items`
- `stock_transactions`
- `purchase_orders`
- `order_items`
- `audit_logs`

Extra column은 forward-compatible하므로 허용한다. Binding 누락, prepare/bind/query 실패, table/column 누락, empty/multiple/malformed result는 모두 동일하게 not ready다.

### 3.2 HTTP contract

`GET /ready`는 `/api/*` 인증 middleware 밖의 public operational endpoint다.

성공:

```json
{
  "ok": true,
  "data": {
    "ready": true,
    "schemaVersion": "d1-required-schema-v1"
  }
}
```

실패는 HTTP 503과 다음 exact public envelope만 반환한다.

```json
{
  "ok": false,
  "error": {
    "code": "NOT_READY",
    "message": "서비스가 준비되지 않았습니다."
  }
}
```

성공과 실패 모두 `Cache-Control: no-store`를 설정한다. SQL, table/column 이름, D1 error, stack 또는 binding detail은 응답과 log에 남기지 않는다.

API deployment smoke는 `/health` 다음 `/ready`를 같은 HTTPS origin에서 확인한다. `/ready`가 통과하기 전에는 배포를 성공으로 기록하지 않는다.

## 4. Observability와 안전한 application log

API `wrangler.toml`을 source of truth로 다음을 명시한다.

- observability enabled
- logs enabled/persisted
- invocation logs enabled
- logs head sampling rate 1

이번 단위에서는 trace를 새로 활성화하지 않는다. 비용과 데이터 수집 범위를 별도 검토하지 않은 채 확장하지 않기 위해서다.

Application code는 raw exception 대신 다음 고정 event만 기록한다.

- `unhandled_request_error`
- `expired_session_cleanup_failed`
- `d1_readiness_failed`

Event payload에는 request body, URL/query/path parameter, cookie, user/row, SQL, exception message/stack을 넣지 않는다. Cloudflare invocation metadata가 request/runtime 상관관계를 담당한다.

## 5. Expected active Worker version 검증

### 5.1 Deployment annotation

Wrangler Action은 version ID를 output으로 제공하지 않으므로 두 Worker는 lockfile의 exact Wrangler CLI로 직접 배포한다. Deploy command는 다음 invariant를 가진다.

- `--message $GITHUB_SHA`
- `--strict`
- fixed `WRANGLER_OUTPUT_FILE_PATH`에 machine-readable NDJSON 기록
- SHA는 GitHub가 제공한 exact 40 lowercase hex만 허용

### 5.2 독립적인 두 관측 경로

새 `scripts/verify-worker-deployment.mjs` deep Module은 고정 target `api` 또는 `web`만 받는다. 임의 worker name, URL, config, version ID를 CLI input으로 받지 않는다.

먼저 NDJSON에서 exact Wrangler version/command, fixed Worker name, version ID와 clean HTTPS deployment origin을 검증한다. 그 뒤 각 read-only verification attempt에서 다음을 수행한다.

1. Cloudflare REST deployments endpoint에서 fixed Worker의 newest active deployment를 읽는다.
2. active deployment가 Wrangler NDJSON의 version ID 하나에 100% traffic을 할당했는지 확인한다.
3. deployment annotation `workers/message`가 exact `GITHUB_SHA`인지 확인한다.
4. REST versions endpoint에서 exact active version을 읽는다.
5. version ID와 version annotation `workers/message`가 Wrangler evidence와 exact `GITHUB_SHA`에 일치하는지 확인한다.

Eventual consistency를 위해 read-only verification만 유한 재시도한다. 모든 attempt가 실패하면 generic failure로 종료하고 URL smoke를 실행하지 않는다.

### 5.3 Whitelist evidence

성공 log와 job summary에는 다음만 남긴다.

```json
{
  "verificationVersion": "worker-active-version-verification-v1",
  "executedAt": "RFC3339 timestamp",
  "gitSha": "40 lowercase hex",
  "runId": "GitHub numeric run id",
  "runAttempt": 1,
  "target": "api",
  "workerName": "hereisorder",
  "deploymentId": "UUID",
  "versionId": "UUID",
  "trafficPercentage": 100,
  "deploymentUrl": "https://fixed-worker-origin.example",
  "outcome": "verified"
}
```

Wrangler/REST raw JSON, author email, account ID, token, binding/resource metadata, exception detail은 log나 summary에 남기지 않는다. 검증된 API deployment URL만 GitHub step output으로 넘겨 web build의 fixed proxy origin으로 사용한다.

Workflow 순서는 다음과 같다.

```text
API deploy
  -> API expected active version verify
  -> API /health + /ready smoke
  -> web build/deploy
  -> web expected active version verify
  -> web login page + unauthenticated proxy smoke
```

## 6. Authenticated smoke의 후속 경계

Wave 1B-S는 다음 별도 변경으로 진행한다.

- fixed username의 dedicated `staff` identity만 provision/rotate/disable하는 fail-closed operator Module
- credential/hash를 migration, seed, argv, repository, log에 저장하지 않음
- rotate/disable 시 모든 session revoke와 audit fact 기록
- repository secret을 해당 workflow step에만 노출
- same-origin web에서 `/login`, login, `/api/users/me`, runtime-validated `GET /api/purchase-orders?q=<sentinel>`, logout, old-cookie 401 순서 검증
- password, cookie, identity projection, business row를 evidence에 남기지 않음

Login/logout은 session/audit mutation을 발생시키므로 business read만 read-only다. Identity lifecycle과 secret 설치는 별도 운영 승인 뒤 실행한다.

## 7. 실패 분류

| 실패 | public/runtime 결과 | 배포 조치 |
| --- | --- | --- |
| `/health` 실패 | Worker 자체가 응답 불가 | forward fix 또는 호환성 확인 뒤 Worker rollback 검토 |
| `/ready` 503 | D1 binding/query/required schema 불일치 | migration 상태와 binding 확인, 기본은 forward repair |
| Wrangler evidence/REST deployment 불일치 | active state가 아직 수렴하지 않았거나 예상 밖 split | bounded retry 뒤 실패, smoke 금지 |
| active version message 불일치 | 요청 commit이 100% active임을 증명 못함 | 실패 처리, 재배포/traffic 상태 확인 |
| observability config 검증 실패 | 운영 진단 근거 없음 | deploy 전 CI 실패 |

자동 rollback이나 D1 restore는 추가하지 않는다.

## 8. 완료 조건

Wave 1B-R 완료:

- real Miniflare D1에서 healthy `/ready`가 200이다.
- binding/query/table/column/result 이상은 detail 없는 exact 503이다.
- API smoke가 `/health`와 `/ready`를 모두 검증한다.
- API observability와 safe event-only application logs가 config/test로 고정된다.
- 두 Worker의 deploy message가 exact SHA이며 post-deploy verifier가 CLI/REST/annotation을 대조한다.
- 전체 root/frontend 검증과 독립 리뷰를 통과한다.
- main 병합 뒤 실제 production readiness, active version evidence, 기존 web smoke가 통과한다.

Wave 1 전체 완료에는 위 조건에 더해 Wave 1B-S의 dedicated identity lifecycle과 authenticated business smoke production 통과가 필요하다.
