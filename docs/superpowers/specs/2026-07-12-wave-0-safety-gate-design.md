# Wave 0 보안·정확성 Safety Gate 설계

작성일: 2026-07-12

상태: 문서 승인됨

대상: Notion import, 세션 만료, 비밀번호 복구, legacy 초과입고 감사

상위 설계: `2026-07-12-risk-first-refactoring-portfolio-design.md`

## 1. 결론

첫 구현 단위는 구조 개편이 아니라 재현된 보안·정확성 결함을 닫는 safety gate다.

Wave 0은 네 하위 배포 단위로 처리한다.

1. 0A — Notion export의 모든 text를 SQLite literal로 안전하게 직렬화한다.
2. 0B — 세션 만료를 정상화하고 위험한 복구 안내를 로컬 PBKDF2 운영 명령으로 대체한다.
3. 0C — 상태 계산에서 legacy 초과입고가 다른 미입고를 가리지 않게 한다.
4. 0D — production D1의 legacy 초과입고 행을 읽기 전용으로 감사한다.

0A, 0B, 0C는 각각 검증 직후 독립 PR로 배포한다. 0D는 그 뒤 별도 read-only workflow로 실행한다. 이상 행이 발견되어도 이미 검증된 보안 hotfix를 되돌리거나 이후 repair 외 변경을 자동 차단하지 않는다. 다만 Wave 0 전체 완료 표시는 승인된 data repair 또는 이상 없음 확인 전까지 보류한다.

Wave 0은 public HTTP path와 정상 응답 shape를 바꾸지 않는다. 만료된 세션 거부와 안전한 복구처럼 기존 결함에 의존한 동작만 바뀐다.

## 2. 확인된 결함

### 2.1 Notion seed SQL 주입

`scripts/import-notion-export.mjs`는 Markdown의 제목과 `분류:` 값을 읽고 `JSON.stringify` 결과를 SQLite statement에 직접 삽입한다. JSON의 double-quoted string은 SQLite에서 안전한 text literal이 아니다.

조작된 제목 `x"); DROP TABLE users; --`를 포함한 export로 생성한 SQL을 local D1에 적용했을 때 `users` table 삭제가 재현되었다. 따라서 이 문제는 이론적 escape 문제가 아니라 실행 가능한 SQL injection이다.

### 2.2 세션 만료 형식 불일치

로그인은 `Date#toISOString()`으로 `YYYY-MM-DDTHH:mm:ss.sssZ`를 저장한다. 인증과 cleanup query는 이 값을 SQLite의 `datetime('now')`, 즉 `YYYY-MM-DD HH:mm:ss`와 TEXT 비교한다.

같은 UTC 날짜에서는 `T`가 공백보다 뒤에 정렬되므로 실제 시각상 만료된 ISO token이 유효하다고 판정될 수 있다. 기존 integration fixture는 SQLite 형식만 삽입해 이 결함을 가린다.

### 2.3 위험한 비밀번호 복구 안내

README와 관리자 설정 화면은 새 운영 비밀번호를 제3자 SHA-256 웹 도구에 입력하고 D1에서 `password_hash`만 직접 갱신하도록 안내한다.

이 흐름은 다음 문제를 가진다.

- cleartext 비밀번호를 제3자 origin에 전달한다.
- 현재 PBKDF2 policy 대신 legacy unsalted SHA-256을 만든다.
- 대상 사용자의 기존 sessions를 폐기하지 않는다.
- `audit_logs`에 복구 사실을 남기지 않는다.

### 2.4 legacy 초과입고 행

`migrations/001_init.sql`은 `received_qty > ordered_qty`를 막지 않는다. `migrations/002_integrity_and_roles.sql`의 trigger는 이후 insert/update만 막고 기존 행을 backfill하지 않는다.

초과입고 행은 Purchase Order 상태 집계에서 다른 품목의 미입고를 상쇄할 수 있으므로 상태 정확성에 영향을 줄 수 있다.

## 3. 목표

- import 입력을 SQL code가 아니라 data로만 취급한다.
- 악성 title/category/spec/memo가 원문 그대로 저장되어도 statement 구조를 바꾸지 못하게 한다.
- legacy ISO session과 SQLite datetime session을 모두 정확히 판정한다.
- 신규 session 저장과 cleanup이 하나의 UTC 의미를 사용한다.
- 비밀번호 복구 과정에서 cleartext를 외부 서비스에 보내지 않는다.
- 복구된 credential은 현재 Worker와 같은 PBKDF2 format을 사용한다.
- 복구 시 대상 sessions를 모두 폐기하고 audit fact를 남긴다.
- production legacy data를 mutation 없이 검사한다.
- 발주 상태를 총합 상쇄가 아니라 품목별 잔량으로 파생한다.
- 각 결함에 자동 regression test를 둔다.

## 4. 비목표

- Identity / Session deep module 전체 구현
- 로그인 account enumeration 수정
- 로그인 rate limit
- legacy SHA-256 검증 제거
- 공통 password policy 전면 통일
- production 이상 행의 자동 clamp·삭제
- generic SQL builder 또는 ORM 도입
- CI/CD backup·rollback 전체 개편
- 정상 데이터의 Purchase Order 상태 의미 변경

로그인 account enumeration, rate limit, legacy hash 제거, 6자/12자로 갈린 password policy는 Wave 2에서 함께 처리한다. CI/CD 복구는 Wave 1, production 이상 행의 수정은 별도 data repair spec에서 처리한다.

## 5. Notion import 설계

### 5.1 Interface

실행 진입점, 순수 변환 Module, SQLite literal helper를 다음처럼 분리한다.

- `scripts/sqlite-sql.mjs`: `sqlText`와 text validation
- `scripts/notion-import-core.mjs`: Markdown record parsing, 전체 validation, SQL/CSV/report 생성
- `scripts/import-notion-export.mjs`: filesystem을 읽고 결과를 atomic write하는 CLI Adapter

`scripts/generate-admin-seed.mjs`도 같은 `sqlText`를 사용하되 기존 public export와 test는 보존한다.

```js
sqlText(value): string
parseNotionRecords(files): ImportItem[]
buildCategorySeedSql(categories): string[]
buildItemSeedSql(items): string[]
generateNotionImport({ sourceDir, outDir, generatedAt, log }): ImportReport
```

`sqlText`는 기존 관리자 seed와 Notion import가 함께 사용하는 작은 SQLite text literal Interface가 된다.

규칙:

- text는 single quote로 감싼다.
- 내부 single quote는 두 번 써서 escape한다.
- NUL 문자는 명확한 validation error로 거부한다.
- backslash, double quote, semicolon, newline, SQL comment marker는 특별한 code 의미 없이 text로 보존한다.
- number는 검증된 number로만 출력하고 text helper를 통과시키지 않는다.
- category가 없으면 빈 문자열 subquery가 아니라 SQL `NULL`을 출력한다.
- CSV cell은 첫 non-whitespace 문자가 `=`, `+`, `-`, `@`이면 spreadsheet formula로 실행되지 않도록 앞에 single quote를 붙인다. SQL에 저장되는 원문은 바꾸지 않는다.

generic query builder는 만들지 않는다. 이 Interface는 생성 SQL에 text literal을 안전하게 넣는 한 가지 목적만 가진다.

### 5.2 출력과 결정성

- Markdown file과 category는 Node/ICU locale에 의존하지 않는 code-point comparator로 정렬한다.
- category와 item 순서를 고정한다.
- SQL과 CSV는 같은 입력에 같은 결과를 낸다.
- `import-report.json.generatedAt`만 주입된 clock 값에 따라 달라질 수 있다.
- report에 생성 SQL의 SHA-256을 `seedSha256`으로 기록한다.
- 빈 export와 최종 `(name, spec)` identity 충돌은 조용히 무시하지 않고 source file 목록과 함께 실패한다.
- 수량과 가격은 safe integer이면서 0 이상인지 전체 검증한다.
- output은 모든 입력 검증과 생성이 성공한 뒤 기록한다.
- SQL과 CSV를 임시 파일에서 rename한 뒤 report를 마지막 commit marker로 기록한다.
- 적용 명령은 실제 SQL SHA-256과 report의 `seedSha256`이 일치하지 않으면 거부하므로 중간 쓰기 실패 결과를 승인된 artifact로 취급하지 않는다.

### 5.3 회귀 검증

fixture는 최소 다음 값을 포함한다.

- `x"); DROP TABLE users; --`
- `O'Brien`
- newline과 `-- comment`
- category subquery를 닫으려는 payload
- NUL을 포함한 invalid input
- `=HYPERLINK(...)` 형태의 CSV formula payload

검증은 두 층으로 한다.

1. unit test가 모든 literal의 exact escaping과 실패 원자성을 확인한다.
2. 생성 SQL을 migration이 적용된 local D1에 실행하고 test sentinel table 보존, 악성 문자열 원문 저장, category/item 수를 확인한다.

로컬 `db:bootstrap:from-notion`은 안전한 generator가 성공한 뒤에만 seed 적용으로 진행한다.

원격 composite인 `db:bootstrap:remote:from-notion`은 제거한다. 운영 import는 다음 단계를 분리해 검토한 artifact와 적용 artifact가 같음을 확인한다.

1. `npm run import:notion`
2. SQL, CSV, report, `seedSha256` 검토
3. remote migration
4. `npm run db:seed:remote -- --expected-sha <검토한 SHA-256>`으로 검토된 seed 적용
5. 최초 bootstrap에서만 admin seed 적용

로컬 composite는 피해 범위가 local D1이므로 유지한다.

`scripts/apply-notion-seed.mjs`가 SHA-256 비교와 Wrangler 호출을 소유하며 `db:seed:remote`는 이 Adapter를 호출한다. SHA-256 불일치, report 부재, `--remote` 부재 중 하나라도 있으면 D1 호출 전에 종료한다.

## 6. 세션 만료 설계

### 6.1 저장 형식

신규 session의 `expires_at`은 D1에서 `datetime('now', '+' || ? || ' seconds')`로 계산해 SQLite UTC datetime text로 저장한다.

이 방식은 Worker process clock serialization과 SQLite text format 차이를 없앤다. cookie의 `Max-Age`는 기존 `SESSION_SECONDS`를 그대로 사용한다.

schema type과 public HTTP contract는 바꾸지 않는다.

### 6.2 호환 가능한 판정

기존 production에는 ISO session과 SQLite datetime session이 함께 있을 수 있다. 인증과 cleanup은 raw TEXT 비교를 중단하고 다음 의미를 사용한다.

```sql
unixepoch(expires_at) > unixepoch('now')
unixepoch(expires_at) IS NULL OR unixepoch(expires_at) <= unixepoch('now')
```

SQLite가 해석하지 못하는 `expires_at`은 유효 session으로 취급하지 않는다. cleanup 대상에도 포함해 invalid session이 계속 남지 않게 한다.

따라서 cleanup 조건은 “만료되었거나 파싱할 수 없음”이다.

### 6.3 적용 지점

같은 predicate를 다음 위치에 적용한다.

- `getSessionUser`의 session join
- login 성공 뒤 background cleanup
- logout 성공 뒤 background cleanup
- session을 검사하거나 정리하는 새 test helper

predicate 문자열을 무리하게 public abstraction으로 만들지 않는다. Wave 2의 Identity / Session Module이 ownership을 가져갈 때 한곳으로 이동한다.

cleanup은 `c.executionCtx.waitUntil()`에 등록한다. 응답 성공 여부와 cleanup 성공 여부는 분리하지만 Worker가 응답 직후 promise를 폐기하지 않게 한다. cleanup 실패는 expired session의 인증 거부에는 영향을 주지 않는다.

### 6.4 회귀 검증

integration test는 실제 auth middleware를 거쳐 다음을 확인한다.

- 미래 ISO session: 허용
- 과거 ISO session: `401`
- 미래 SQLite datetime session: 허용
- 과거 SQLite datetime session: `401`
- exact-now 또는 이미 만료된 session: `401`
- 해석 불가능한 timestamp: `401` 후 cleanup 대상
- 실제 login이 만든 session: SQLite UTC datetime 형식이고 즉시 사용 가능
- logout: session 삭제와 cookie clear 유지

기존 정상 cookie flags와 response envelope는 그대로 유지한다.

## 7. 안전한 비밀번호 복구 설계

### 7.1 사용자 경로

로그인한 admin이 다른 사용자의 비밀번호를 초기화하는 기존 UI/API는 유지한다. 이 경로는 이미 PBKDF2, session revoke, audit를 수행한다.

로그인할 수 있는 admin에게 emergency D1 절차를 노출할 이유가 없으므로 설정 화면의 “비밀번호를 잊어버렸을 때” card는 제거한다.

### 7.2 운영자 emergency 경로

모든 admin credential을 잃은 경우를 위해 repository-local recovery command를 제공한다.

```text
operator TTY / protected environment
        │ cleartext password
        ▼
local recovery command
        │ parameterized D1 batch
        ▼
Cloudflare D1 REST API
        │
        ▼
production D1
  ├─ target password_hash update
  ├─ all target sessions delete
  └─ actor_user_id NULL recovery audit
```

구체적 규칙:

- username은 명시적으로 받으며 active, non-deleted admin 한 명만 대상으로 한다.
- 새 비밀번호는 12자 이상이다.
- cleartext password를 CLI argument, log, file, HTTP response에 넣지 않는다.
- primary interactive 경로는 TTY에서 echo 없이 비밀번호와 확인값을 읽는다.
- PBKDF2 scheme, iteration, salt, byte 수는 Worker와 관리자 seed의 현재 format을 재사용한다.
- random salt를 사용하며 credential-equivalent SQL 파일을 만들지 않는다.
- 명령은 `npm run db:recover-password -- --remote --username <name>` 형태이며 `--remote`가 없으면 mutation을 실행하지 않는다.
- production 변경은 database name과 username을 화면에 표시하고 `RECOVER hereisorder <name>`을 정확히 다시 입력해야 시작한다.
- target preflight는 Cloudflare API의 parameter binding을 사용하고 정확히 한 active admin인지 확인한다.
- target이 없거나 staff/inactive/deleted이면 credential을 변경하지 않고 실패를 표시한다.
- write batch의 각 statement는 username, `role = 'admin'`, `is_active = 1`, `is_deleted = 0` 조건을 다시 검사한다. preflight 결과만 write 권한으로 사용하지 않는다.
- password update, 모든 target session 삭제, `recover_password` audit insert는 parameterized D1 REST batch 한 번으로 보낸다. session delete와 audit insert는 같은 조건의 target subquery를 사용한다.
- update result는 `changes = 1`, 나머지 result는 `success = true`여야 한다. 하나라도 다르면 성공으로 보고하지 않고 postflight로 실제 hash scheme, session count, audit를 다시 확인한다.
- recovery audit의 `actor_user_id`는 인증된 앱 사용자가 아니므로 `NULL`이며 `after_json`에 `{ source: 'operator_recovery', username }`을 남긴다.
- 적용 뒤 대상 hash scheme, 남은 session 수, audit 존재를 확인한다. hash 본문은 출력하지 않는다.
- Cloudflare API token과 account ID는 기존 protected environment에서만 읽고 저장하거나 출력하지 않는다.

Cloudflare의 Worker binding `D1Database.batch()`는 statement 실패 시 전체 sequence rollback을 공식 보장하지만, D1 REST query 문서는 batch 입력을 설명할 뿐 같은 rollback 의미를 명시하지 않는다. 따라서 production recovery를 활성화하기 전에 CI가 disposable remote D1을 만들고 최소 schema를 적용한 뒤 failure-injected REST batch의 앞선 update가 rollback되는지 확인하고 database를 `finally`에서 삭제해야 한다. 이 remote contract test가 통과하지 않으면 recovery command는 구현 완료로 보지 않는다. `wrangler d1 execute --file`의 원자성도 가정하지 않는다. 근거는 [D1 `batch()` 공식 문서](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)와 [D1 REST query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)다.

새로운 public recovery endpoint나 장기 recovery secret은 추가하지 않는다.

### 7.3 문서 변경

README와 Cloudflare 배포 가이드에는 다음만 남긴다.

- 로그인 가능한 admin은 설정 화면에서 사용자 초기화를 수행한다.
- admin 전체 lockout일 때만 local recovery command를 사용한다.
- 비밀번호를 웹 해시 도구, 채팅, issue, shell argument에 입력하지 않는다.
- recovery 뒤 모든 기존 session이 폐기됨을 알린다.
- production recovery 명령은 remote 대상 재확인을 요구함을 알린다.

외부 SHA-256 link, raw `UPDATE users`, legacy hash 생성 예시는 모두 삭제한다.

### 7.4 회귀 검증

- Worker와 같은 PBKDF2 format 생성
- random salt로 같은 비밀번호가 다른 hash 생성
- username의 quote와 SQL payload를 parameter로 안전 처리
- password minimum과 confirmation 검증
- cleartext와 hash가 log·file·response에 없음
- remote flag와 exact confirmation 없이는 write 없음
- Miniflare D1에서 password update, session 전부 삭제, audit insert가 함께 성공
- disposable remote D1에서 failure-injected REST batch가 전체 rollback
- 없는/staff/inactive/deleted username은 write 없음
- audit insert가 실패하면 password와 session 변경도 남지 않음
- 생성한 hash로 실제 Worker login이 성공하는 Node/Worker 호환 검증
- README와 frontend에 외부 hash domain 또는 raw `UPDATE users`가 다시 생기면 실패하는 정적 검사

legacy SHA-256 login upgrade는 Wave 2까지 유지해 기존 계정을 잠그지 않는다.

## 8. Production legacy data audit 설계

### 8.1 읽기 전용 query

배포를 차단하는 요약 감사는 최소 다음 값을 출력한다.

- active·deleted `received_qty > ordered_qty` 행 수
- active 초과입고 총 excess quantity
- 초과입고가 있는 발주 수
- 총합으로는 완료지만 품목별 잔량이 남은 masked order 수

상세 감사는 해당 order/item의 ordered/received quantity, 연결된 IN ledger 합계, active/deleted 상태, 저장 status와 품목별 파생 status를 출력한다. 추가 integrity query는 `ordered_qty <= 0`, `received_qty < 0`, active duplicate, missing/deleted parent 참조를 검사한다.

출력에는 진단에 필요한 ID, 수량, 상태만 포함한다. 사용자 credential, session token, 자유 입력 memo는 출력하지 않는다.

### 8.2 실행 원칙

- production query는 `SELECT`와 read-only CTE만 사용한다.
- 결과를 repository에 commit하거나 공개 CI artifact로 업로드하지 않는다.
- 실행 시각, query version, 집계 count만 운영 기록에 남긴다.
- active invalid와 masked order가 0건이면 Wave 0 전체를 완료 처리한다. deleted legacy count는 정보로 기록한다.
- active invalid 또는 masked order가 1건 이상이면 보안 hotfix는 유지하고 data repair spec을 만든다. Wave 0 전체 완료 표시만 repair까지 보류한다.

초과입고를 `ordered_qty`로 clamp하지 않는다. 실제 납품량, 발주량 또는 ledger 중 어느 값이 잘못됐는지 query만으로 알 수 없기 때문이다.

### 8.3 Local 검증

001 schema에 invalid legacy fixture를 넣고 002 migration을 적용한 뒤 audit가 해당 행을 찾는지 확인한다. 정상 fixture는 0건이어야 한다.

감사 SQL은 `scripts/sql/audit-order-item-integrity.sql`, 실행·요약 판정은 `scripts/audit-order-item-integrity.mjs`가 소유한다. 별도 `workflow_dispatch` read-only job이 0A–0C 배포 뒤 production summary를 실행한다. 상세 row는 CI log나 artifact에 남기지 않고 운영자가 별도 명령으로 확인한다.

### 8.4 상태 파생 방어

Purchase Order 입고 뒤 상태는 `SUM(received_qty) >= SUM(ordered_qty)`로 판단하지 않는다.

- active item 중 `received_qty < ordered_qty`가 없으면 `fully_received`
- 잔량이 있고 하나라도 `received_qty > 0`이면 `partially_received`
- 모든 `received_qty = 0`이면 `ordered`

이 변경은 정상 행에서는 기존 결과와 같다. legacy 초과입고가 다른 품목의 잔량을 상쇄하는 결함만 수정한다. module regression test는 한 품목의 초과입고와 다른 품목의 미입고가 함께 있을 때 `partially_received`가 되는지 확인한다.

## 9. 오류 처리와 원자성

- import validation 실패는 source file과 field를 식별하되 전체 raw content를 log하지 않는다.
- import generation 실패 시 seed SQL을 적용하지 않는다.
- session timestamp parse 실패는 인증 실패로 처리한다.
- cleanup은 `executionCtx.waitUntil()`로 수명만 보장하고 실패가 로그인·로그아웃 성공 응답을 바꾸지 않는 best-effort 의미를 유지한다. 관측 보강은 Wave 1에서 처리한다.
- recovery target 검증 실패는 write 전에 종료한다.
- recovery password update, session revoke, audit는 parameterized D1 REST batch의 원자성을 사용한다.
- production audit 이상은 자동 repair가 아니라 명시적 stop condition이다.

## 10. 변경 예상 위치

- `scripts/import-notion-export.mjs`
- `scripts/notion-import-core.mjs`
- `scripts/notion-import-core.test.mjs`
- `scripts/sqlite-sql.mjs`와 test
- `src/index.ts`의 login/session query
- `test/api.integration.test.ts`의 실제 auth/session test
- `scripts/recover-password-core.mjs`
- `scripts/recover-password.mjs` CLI Adapter와 test
- `scripts/apply-notion-seed.mjs`와 test
- `package.json` recovery/audit command
- `README.md`
- `docs/design/cloudflare-deploy-guide.md`
- `frontend/app/(app)/settings/page.tsx`
- production integrity audit SQL/script와 test fixture
- `.github/workflows/deploy-worker.yml` 또는 별도 workflow의 production read-only dispatch job

## 11. 검증과 배포

### 11.1 자동 검증

- `npm test`
- `npm run typecheck`
- `npm run build`
- 빈 local D1 migration 적용
- 악성 Notion fixture seed를 local D1에 적용
- recovery D1 batch의 local atomicity test
- `npm run test --prefix frontend`
- `npm run lint --prefix frontend`
- `npm run build --prefix frontend`
- `npm run build:cloudflare --prefix frontend`

### 11.2 배포 전

1. 각 하위 PR의 CI와 코드 리뷰를 완료한다.
2. 0A–0C를 순서대로 배포한다.
3. production integrity audit를 read-only workflow로 실행한다.
4. 이상 행이 없음을 확인하거나 별도 repair 작업으로 격리한다.

### 11.3 배포 후

- API와 web health/proxy smoke 유지
- 정상 admin login과 현재 사용자 조회
- logout 뒤 token 재사용 거부
- 비밀번호 recovery를 production smoke로 실행하지 않는다. 검증된 local D1 test와 문서 절차만 확인한다.
- 배포 과정에 test credential이나 credential-equivalent artifact가 없음을 확인한다.

## 12. 완료 기준

- 악성 Notion input이 table을 삭제하지 못하고 원문 text로 저장된다.
- import SQL의 모든 text가 SQLite literal Interface를 사용한다.
- ISO와 SQLite 형식의 만료 session이 모두 `401`로 거부된다.
- 신규 session은 SQLite UTC datetime으로 저장된다.
- README, frontend, docs에 외부 hash 도구와 raw password update 안내가 없다.
- operator recovery는 PBKDF2, session revoke, audit를 함께 수행한다.
- production legacy audit 결과가 기록되고 이상 행은 자동 수정되지 않는다.
- legacy 초과입고는 다른 품목의 미입고를 상태 계산에서 가리지 못한다.
- 전체 root/frontend/Cloudflare 검증이 통과한다.
- public 정상 HTTP contract에는 의도하지 않은 변화가 없다.
