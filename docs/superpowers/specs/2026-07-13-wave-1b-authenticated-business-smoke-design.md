# Wave 1B-S Authenticated Business Smoke 설계

작성일: 2026-07-13

상태: 사용자 승인 완료, 구현 전 상세 설계

대상: production smoke identity lifecycle, GitHub Actions secret, same-origin authenticated business smoke

## 1. 결론

Wave 1B-S는 production identity 생성과 자동 배포 gate 활성화를 두 개의 독립 PR로 전달한다.

1. **Wave 1B-S1 — dedicated identity lifecycle**
   - fixed username `deployment-smoke`, fixed display name `Deployment Smoke`, fixed role `staff`만 관리한다.
   - manual-only operator workflow와 fail-closed Node Module이 `provision`, `rotate`, `disable`만 수행한다.
   - lifecycle mutation은 대상 검증, atomic D1 batch, 전체 session revoke, audit fact, exact postflight를 모두 통과해야 성공이다.
   - S1을 main에 병합하고 기존 배포가 통과한 뒤 48-byte random credential을 repository secret에 설치하고 identity를 한 번 provision한다.
2. **Wave 1B-S2 — authenticated business smoke gate**
   - verified web deployment origin에서 login page → login → current user → purchase-order read → logout → revoked-session 401을 검증한다.
   - deploy workflow에서는 credential을 authenticated smoke step에만 노출하며 password, cookie, identity projection, business row를 log와 summary에 남기지 않는다.
   - identity가 준비된 뒤에만 S2를 병합하므로 첫 gated deployment가 missing account 때문에 실패하는 전환 상태를 만들지 않는다.

Dedicated identity는 배포 사이에도 active 상태를 유지한다. 배포마다 enable/disable하지 않는다. Workflow 취소나 runner 강제 종료가 cleanup을 건너뛸 때 계정이 active로 남는 불명확한 lifecycle을 피하고, 고정된 강한 secret과 명시적인 rotation/disable 절차로 운영한다.

## 2. 현재 제약과 잔여 위험

- 현재 role은 `admin`과 `staff`뿐이다. `staff`는 사용자 관리와 audit 조회는 할 수 없지만 카테고리, 품목, 재고, 발주 write는 가능하다.
- 진정한 read-only `smoke` role을 추가하면 authorization contract와 전체 route matrix가 바뀐다. 이는 Wave 2 Identity / Session 범위다.
- session lifetime은 30일이고 token은 production D1 `sessions`에 저장된다.
- 정상 smoke는 logout으로 현재 session을 삭제한다. 그러나 login 직후 process가 강제 종료되면 orphan session이 남을 수 있다.
- login과 logout은 각각 `sessions`와 `audit_logs`를 변경하며, expired/invalid session cleanup이 추가로 실행될 수 있다.
- `users.username`은 deleted row까지 포함한 global unique이고 다른 table이 user를 참조한다. Dedicated identity는 hard delete하지 않는다.

이번 범위의 방어선은 다음과 같다.

- repository에 고정한 username과 `staff` role 외에는 lifecycle 대상으로 받지 않는다.
- credential은 48 random bytes를 URL-safe encoding한 값으로 생성하고 최소 32 characters 정책을 적용한다.
- credential/hash는 argv, migration, seed, file, repository, artifact, log, summary에 저장하지 않는다.
- rotate와 disable은 해당 identity의 모든 session을 폐기한다.
- 모든 lifecycle mutation은 actor가 없는 operator audit fact를 남긴다.
- smoke는 business write를 호출하지 않고 random sentinel을 사용한 purchase-order read만 수행한다.
- Wave 2에서 read-only role과 session storage/lifetime을 별도 재설계한다.

## 3. 검토한 접근법

### 3.1 선택: persistent fixed identity와 2단계 전달

S1에서 lifecycle을 먼저 배포·검증하고 production identity와 secret을 준비한 뒤 S2에서 smoke를 필수 gate로 연결한다.

선택 이유:

- identity가 없어서 첫 deployment가 의도적으로 실패하지 않는다.
- production identity mutation과 일반 application deployment 증거를 분리한다.
- lifecycle workflow와 smoke workflow가 각각 최소 secret만 받는다.
- disable이 자동으로 되돌려지거나 missing identity가 자동 재생성되지 않는다.

### 3.2 제외: 한 PR에서 deployment 전 자동 provision

첫 main run이 identity를 자동 생성한 뒤 같은 run에서 배포와 smoke를 수행하는 방식이다. PR 수는 줄지만 production account 생성이 일반 deployment path에 결합된다. 이후 identity가 의도적으로 disable 또는 제거되어도 자동 provision 정책과 충돌한다.

### 3.3 제외: 매 deployment마다 enable 후 finally disable

평상시 계정이 inactive라는 장점은 있지만 cancellation, runner termination, timeout이 `finally` cleanup을 보장하지 않는다. 실패 뒤 active 상태인지 외부에서 재확인해야 하며 lifecycle mutation과 audit noise도 모든 배포에 추가된다.

## 4. S1 dedicated identity lifecycle

### 4.1 고정 contract

Operator Module은 다음 값을 코드 상수로 소유한다.

```json
{
  "username": "deployment-smoke",
  "name": "Deployment Smoke",
  "role": "staff",
  "databaseBinding": "DB",
  "databaseName": "hereisorder"
}
```

CLI는 username, role, database name/UUID, SQL 또는 audit action을 input으로 받지 않는다. 유효한 command는 exact `provision --remote`, `rotate --remote`, `disable --remote`뿐이다. Production target은 repository `wrangler.toml`의 fixed `DB` binding에서 읽고 expected database name과 일치해야 한다.

`provision`과 `rotate`는 `PRODUCTION_SMOKE_PASSWORD` environment secret을 요구한다. `disable`에는 password를 전달하지 않는다. Password는 32 characters 이상이어야 하고 PBKDF2-SHA256 100,000 iterations, 16-byte salt, 32-byte digest의 현재 application format으로 process memory에서만 hash한다.

### 4.2 action semantics

#### `provision`

- fixed username row가 0개인지 preflight한다.
- 같은 username의 active, inactive, deleted 또는 다른 role row가 하나라도 있으면 overwrite하지 않고 실패한다.
- exact fixed user를 active, not-deleted `staff`로 생성한다.
- `provision_smoke_identity` audit fact를 같은 D1 batch에 기록한다.
- 생성된 row, password hash match, hash scheme, session count 0, latest exact audit을 postflight한다.

#### `rotate`

- fixed username/name/role이고 not-deleted인 row가 정확히 하나인지 preflight한다.
- 다른 role/name 또는 deleted row는 takeover하지 않고 실패한다.
- 새 salted hash를 설정하고 identity를 active로 만든다.
- 해당 user의 모든 session을 삭제하고 `rotate_smoke_identity` audit fact를 같은 D1 batch에 기록한다.
- exact identity, active state, password hash match, hash scheme, session count 0, latest exact audit을 postflight한다.

`rotate`가 inactive identity를 다시 active로 만드는 유일한 경로다.

#### `disable`

- exact active fixed identity가 하나인지 preflight한다.
- identity를 inactive로 바꾸고 모든 session을 삭제한다.
- `disable_smoke_identity` audit fact를 같은 D1 batch에 기록한다.
- exact inactive state, session count 0, latest exact audit을 postflight한다.
- row는 delete하거나 `is_deleted`로 바꾸지 않는다.

이미 disabled인 identity를 다시 disable하거나 missing identity를 disable하는 요청은 성공으로 가장하지 않는다.

### 4.3 atomicity와 concurrency

각 action은 preflight read 뒤 mutation statement를 하나의 D1 REST batch로 보낸다. Update predicate는 preflight에서 확인한 exact immutable identity shape를 다시 포함하고, affected user row와 audit row가 각각 정확히 한 건인지 검사한다. Session delete count는 0 이상을 허용한다.

REST write outcome이 transport 관점에서 ambiguous하면 동일 process가 read-only postflight로 의도한 exact state를 재확인한다. Exact state와 latest audit을 모두 증명하지 못하면 generic failure이며 자동으로 다른 action을 실행하지 않는다.

Manual lifecycle workflow와 main deployment workflow는 같은 repository/ref concurrency group과 `cancel-in-progress: false`를 사용한다. 따라서 lifecycle mutation과 authenticated deployment smoke가 겹치지 않는다. Pull request ref는 서로 다른 group을 유지한다.

### 4.4 operator workflow

새 manual-only workflow는 `workflow_dispatch`의 fixed choice `provision`, `rotate`, `disable`과 action에 대응하는 non-secret exact confirmation을 받는다.

- `MANAGE hereisorder deployment-smoke provision`
- `MANAGE hereisorder deployment-smoke rotate`
- `MANAGE hereisorder deployment-smoke disable`

Main ref가 아니면 실행하지 않는다. Postflight는 stored password hash 자체를 읽거나 출력하지 않고 SQL이 계산한 `hash_matches`와 `hash_scheme_ok` boolean만 허용한다.

- external Action은 현재 repository가 사용하는 full commit SHA를 재사용한다.
- Node/npm version과 install 방식은 deploy workflow와 동일하다.
- shell command에 workflow input을 interpolation하지 않고 action별 static step을 사용한다.
- provision/rotate step만 Cloudflare credentials와 `PRODUCTION_SMOKE_PASSWORD`를 받는다.
- disable step은 Cloudflare credentials만 받는다.
- success summary는 version, timestamp, fixed database name, action, outcome만 포함한다.
- raw D1 envelope, user id/row, password/hash, account id/token, audit JSON은 출력하지 않는다.

Audit `after_json`은 password/hash 없이 fixed source, fixed username, role, resulting active state만 기록한다.

## 5. Secret 설치와 rotation

S1 main deployment 성공 뒤 local shell에서 48 random bytes를 생성해 stdout이나 argv에 노출하지 않고 stdin으로 GitHub repository secret `PRODUCTION_SMOKE_PASSWORD`에 저장한다. Secret value를 file, chat, issue, PR, commit 또는 terminal output에 남기지 않는다.

Initial setup 순서:

1. S1 PR checks, review, merge, 기존 public production smoke 성공
2. random credential 생성과 repository secret 설치
3. main의 manual lifecycle workflow에서 `provision` 실행
4. whitelist summary와 exact postflight 성공 확인
5. S2 PR 시작

Rotation 순서:

1. shared production concurrency가 비어 있는지 확인
2. `disable` 실행으로 identity inactive 및 모든 session revoke
3. 새 random credential을 repository secret에 설치
4. `rotate` 실행으로 새 hash와 함께 identity 재활성화
5. deployment workflow를 dispatch해 authenticated smoke 확인

중간 단계에서 deployment가 시작되더라도 shared concurrency가 lifecycle run과 겹치지 않는다. Identity가 disabled인 동안 smoke는 fail closed한다. Disable한 identity를 일반 deploy가 자동 재생성하지 않는다.

## 6. S2 authenticated business smoke

### 6.1 실행 위치와 environment

Authenticated smoke는 web Worker의 active version과 기존 unauthenticated login/proxy smoke가 통과한 직후 같은 `deploy-web` job에서 실행한다. Origin은 web deployment verifier가 반환한 clean HTTPS origin만 사용한다.

CLI entrypoint는 main push 또는 main `workflow_dispatch` GitHub Actions metadata만 허용한다. Arbitrary username/origin path, cookie 또는 endpoint를 CLI input으로 받지 않는다. Workflow step에는 다음만 노출한다.

- verified deployment origin
- `PRODUCTION_SMOKE_PASSWORD`
- exact Git SHA/run metadata

Cloudflare API credentials는 authenticated smoke step에 전달하지 않는다.

### 6.2 exact request sequence

한 번의 smoke transaction은 다음 순서다.

1. `GET /login`
   - redirect를 따르지 않고 HTTP 200을 요구한다.
2. `POST /api/auth/login`
   - fixed username과 environment password를 JSON body로 보낸다.
   - HTTP 200, exact success envelope, positive user id, fixed username/name, exact `staff` role을 검증한다.
   - exactly one usable `isorder_sid` cookie pair만 process memory에 보관한다.
3. `GET /api/users/me`
   - 같은 cookie로 HTTP 200과 login response에 일치하는 exact identity projection을 검증한다.
4. `GET /api/purchase-orders?q=<random-sentinel>`
   - sentinel은 매 run 생성하며 credential이나 identity를 포함하지 않는다.
   - HTTP 200, exact API envelope와 shared runtime purchase-order summary schema를 검증한다.
   - 결과가 empty인지 여부와 무관하게 row를 출력하거나 evidence로 저장하지 않는다.
5. `POST /api/auth/logout`
   - 같은 cookie로 HTTP 200과 exact `{ loggedOut: true }` projection을 검증한다.
6. `GET /api/users/me`
   - 이전 cookie가 exact HTTP 401 `UNAUTHORIZED` envelope를 반환해야 한다.

Login 뒤에는 전체 transaction을 retry하지 않는다. Retry로 여러 live session을 만들 수 있기 때문이다. 각 request는 bounded timeout과 `redirect: manual`을 사용한다.

Cookie를 얻은 뒤 중간 검증이 실패하면 `finally`에서 logout을 한 번 시도한다. Cleanup 성공이 본래 실패를 성공으로 바꾸지 않으며 cleanup 실패도 전체 smoke를 실패시킨다. Process termination은 `finally`를 보장하지 않으므로 orphan 가능성은 잔여 위험으로 유지하고 rotation/disable이 전체 revoke 경로를 제공한다.

### 6.3 evidence와 redaction

성공 log와 GitHub step summary는 다음 whitelist만 포함한다.

```json
{
  "smokeVersion": "authenticated-business-smoke-v1",
  "executedAt": "RFC3339 timestamp",
  "gitSha": "40 lowercase hex",
  "runId": "GitHub numeric run id",
  "runAttempt": 1,
  "target": "web",
  "outcome": "verified"
}
```

다음은 성공·실패 어느 쪽에서도 log, error message, summary 또는 artifact에 남기지 않는다.

- deployment response body와 header
- username/name/user id/role projection
- password, password hash, cookie/token
- request JSON body와 query sentinel
- purchase-order row 또는 count
- raw exception, URL, Cloudflare envelope

실패는 phase를 외부에 구분하지 않는 fixed generic message로 종료한다. 기존 application invocation log가 runtime correlation을 담당한다.

## 7. 테스트 전략

모든 production code는 TDD로 구현한다.

### S1 tests

- CLI가 exact three actions와 `--remote` 외 input을 거부한다.
- fixed target, password policy와 confirmation 실패는 config read/fetch 전에 중단한다.
- provision conflict, rotate/disable identity mismatch, malformed/ambiguous D1 result가 fail closed한다.
- 각 action batch가 parameter binding, exact predicate, session revoke, fixed audit만 포함한다.
- write count와 postflight identity/hash/session/audit mismatch를 거부한다.
- ambiguous write는 exact postflight 외에는 성공하지 않는다.
- password/hash/token/account/user row가 output, summary와 thrown public error에 없다.
- manual workflow가 main-only, fixed action steps, shared concurrency, exact secret scoping을 유지한다.

### S2 tests

- exact six-step same-origin request sequence와 strict response projection을 검증한다.
- login page/login/me/business read/logout/revoked 401 각각의 status, redirect, malformed JSON, extra/missing field 실패를 검사한다.
- cookie 없음/복수/잘못된 name과 identity mismatch를 거부한다.
- business result를 shared runtime schema로 검증한다.
- login 뒤 실패 시 logout을 한 번 시도하고 전체 transaction을 retry하지 않는다.
- logout 또는 revoked-session 검증 실패를 성공으로 처리하지 않는다.
- secret, cookie, response row, sentinel, raw transport error가 console/summary에 없다.
- deploy workflow에서 active web version verify와 public smoke 뒤에 실행되며 secret은 해당 step에만 존재한다.

Full gate는 root Node tests, Vitest/Miniflare, typecheck, Worker dry-run, frontend tests/lint/build/OpenNext build, workflow/docs contract와 `git diff --check`다.

## 8. 전달, 실패와 복구

### S1 전달

- lifecycle code와 workflow를 독립 PR로 review한다.
- PR checks와 full local gate가 통과한 뒤 merge한다.
- merge SHA의 기존 API/web deployment가 성공했는지 확인한다.
- secret을 설치하고 manual `provision` run의 safe evidence를 확인한다.
- provision 실패 시 S2로 진행하지 않는다.

### S2 전달

- authenticated smoke engine과 deploy gate를 두 번째 PR로 review한다.
- identity가 active이고 provision evidence가 존재할 때만 merge한다.
- merge SHA의 API/web active version, readiness, public proxy smoke, authenticated business smoke를 모두 확인한다.
- smoke 실패를 `continue-on-error`, conditional skip 또는 secret 부재 허용으로 우회하지 않는다.

Lifecycle workflow가 잘못되면 먼저 마지막 검증된 workflow로 identity를 disable하고 code를 forward-fix 또는 revert한다. S2를 revert하더라도 dedicated identity는 자동 삭제되지 않는다. Authenticated gate를 중단하기로 결정하면 별도 승인된 `disable`을 실행해 session을 revoke한다.

## 9. 제외 범위

- read-only `smoke` role 또는 route별 authorization matrix 추가
- session token hashing, lifetime 변경, rate limiting, password policy 통합
- identity 자동 enable/disable 또는 매 deploy password rotation
- production user hard delete
- business write smoke
- production row export나 response artifact
- Cloudflare API credential을 authenticated smoke step에 전달
- smoke 실패 자동 Worker rollback 또는 D1 restore

## 10. 완료 조건

Wave 1B-S 완료:

- S1과 S2가 각각 독립 PR, review, merge SHA와 production run evidence를 가진다.
- fixed dedicated `staff` identity가 audited operator Module로 provision된다.
- repository secret이 lifecycle의 provision/rotate step과 deploy의 authenticated smoke step에만 노출되고 repository/log/artifact에 credential이 없다.
- verified web origin에서 login → me → runtime-validated purchase-order read → logout → old-cookie 401이 통과한다.
- automated lifecycle tests가 rotate/disable의 모든 dedicated session revoke와 exact audit을 증명하고, production에서는 provision postflight evidence를 확인한다.
- 전체 local/CI gate와 production active-version/readiness/public/authenticated smoke가 통과한다.

위 조건이 충족되면 Wave 1 전체를 완료하고 Wave 2 Identity / Session 설계를 시작할 수 있다.
