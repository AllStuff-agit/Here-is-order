# Wave 0B Session and Password Recovery Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct session expiry for legacy and new timestamp formats, and replace unsafe password recovery guidance with a parameterized, audited operator recovery command whose remote D1 batch rollback semantics are proven before deployment.

**Architecture:** Keep the current authentication routes and legacy hash upgrade intact, changing only session time storage/comparison and cleanup scheduling in the Worker. Build password recovery as a repository-local Node core plus a Cloudflare D1 REST Adapter: preflight validates one active admin, the write batch rechecks authorization conditions, and postflight verifies PBKDF2 scheme, zero sessions, and exact audit facts without returning the hash.

**Tech Stack:** TypeScript 5.6, Hono 4, Cloudflare Workers/D1, Node.js 22 built-ins, Cloudflare REST API, Vitest 4, Miniflare D1, Next.js 16.

## Global Constraints

- Preserve all current auth HTTP paths, success envelopes, cookie name, 30-day lifetime, `HttpOnly`, `Path=/`, `SameSite=Strict`, and HTTPS-only `Secure` behavior.
- Preserve legacy SHA-256 login and successful PBKDF2 upgrade until Wave 2.
- Do not address account enumeration, login rate limiting, failed-login audit, or the 6/12-character policy split in this delivery.
- Accept legacy ISO and SQLite datetime session rows; invalid timestamps are never authenticated and are cleanup candidates.
- Register cleanup with `executionCtx.waitUntil`; cleanup failure must not change login/logout responses.
- Do not add a public recovery endpoint, recovery secret, SQL file, cleartext password argument, or credential-equivalent artifact.
- Recovery targets exactly one active, non-deleted admin and always rechecks those predicates inside each write statement.
- Recovery update, session revoke, and audit must behave transactionally. Do not infer D1 REST rollback from Worker binding documentation; prove it against a disposable remote D1 first.
- Never print or persist the API token, account ID, password, or password hash.
- Use only existing root dependencies and Node built-ins.
- Follow RED → GREEN → REFACTOR and commit after each independently reviewable task.

## File Map

- `src/index.ts`: session issue, validation, and lifecycle-bound cleanup.
- `test/api.integration.test.ts`: real auth middleware/login/logout session tests.
- `scripts/recover-password-core.mjs`: recovery input, SQL, result, and postflight policy.
- `test/password-recovery.integration.test.ts`: Miniflare D1 atomicity and Worker hash compatibility.
- `scripts/cloudflare-d1-rest.mjs`: secret-safe REST Adapter.
- `scripts/recover-password.mjs`: interactive operator CLI Adapter.
- `scripts/d1-rest-batch-contract.mjs`: disposable remote rollback proof.
- `.github/workflows/deploy-worker.yml`: production deployment dependency on rollback proof.
- README, deployment guide, and settings page: trusted recovery instructions only.

---

### Task 1: Normalize session expiry and bind cleanup to Worker lifetime

**Files:**
- Modify: `src/index.ts:213-231,336-350,354-369`
- Modify: `test/api.integration.test.ts:1-45` and add a focused auth describe block

**Interfaces:**
- Consumes: existing session table and `SESSION_SECONDS`.
- Produces: unchanged auth HTTP Interface with format-compatible expiry semantics and `scheduleExpiredSessionCleanup(c): void`.

- [ ] **Step 1: Add failing session-format tests through the real auth middleware**

Add these imports and helper to `test/api.integration.test.ts`:

```ts
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

async function createSessionWithExpiry(expiresAt: string) {
  const token = `expiry-${crypto.randomUUID()}`;
  const user = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES (?, 'unused', '세션 테스트', 'admin')`,
  ).bind(`expiry-${crypto.randomUUID()}`).run();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
  ).bind(token, user.meta.last_row_id, expiresAt).run();
  return { token, userId: Number(user.meta.last_row_id) };
}
```

Add this table-driven test:

```ts
describe('세션 만료 형식', () => {
  it.each([
    ['future ISO', new Date(Date.now() + 3_600_000).toISOString(), 200],
    ['past ISO', new Date(Date.now() - 3_600_000).toISOString(), 401],
    ['future SQLite', '2999-01-01 00:00:00', 200],
    ['past SQLite', '2000-01-01 00:00:00', 401],
    ['invalid', 'not-a-timestamp', 401],
  ])('%s session을 정확히 판정한다', async (_label, expiresAt, status) => {
    const { token } = await createSessionWithExpiry(expiresAt);
    const response = await apiRequest('/api/users/me', token);
    expect(response.status).toBe(status);
  });

  it('현재 SQLite 시각과 같은 session을 만료로 판정한다', async () => {
    const now = await env.DB.prepare("SELECT datetime('now') AS value")
      .first<{ value: string }>();
    const { token } = await createSessionWithExpiry(String(now?.value));
    expect((await apiRequest('/api/users/me', token)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/api.integration.test.ts -t "세션 만료 형식"
```

Expected: FAIL because the past ISO session is returned as authenticated.

- [ ] **Step 3: Normalize the authentication and cleanup predicates**

Change `getSessionUser` to:

```sql
AND unixepoch(s.expires_at) > unixepoch('now')
```

Add this private helper in `src/index.ts`:

```ts
function scheduleExpiredSessionCleanup(c: any) {
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `DELETE FROM sessions
        WHERE unixepoch(expires_at) IS NULL
           OR unixepoch(expires_at) <= unixepoch('now')`,
    )
      .run()
      .catch((error: unknown) => {
        console.error('expired session cleanup failed', error);
      }),
  );
}
```

Replace both fire-and-forget cleanup calls after login/logout with:

```ts
scheduleExpiredSessionCleanup(c);
```

- [ ] **Step 4: Store new session expiry in canonical SQLite UTC format**

Delete the JavaScript `expiresAt` variable and replace the session insert with:

```ts
c.env.DB.prepare(
  `INSERT INTO sessions (token, user_id, expires_at)
   VALUES (?, ?, datetime('now', '+' || ? || ' seconds'))`,
).bind(sid, user.id, SESSION_SECONDS)
```

- [ ] **Step 5: Add login, cookie, cleanup-lifetime, and logout regression tests**

In the same describe block, create a user with a legacy SHA-256 hash generated by `crypto.subtle.digest`, call `worker.fetch` with an explicit execution context, and assert:

```ts
const ctx = createExecutionContext();
const login = await worker.fetch(new Request('http://example.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
}), env, ctx);
expect(login.status).toBe(200);
const cookie = login.headers.get('Set-Cookie') ?? '';
expect(cookie).toContain('isorder_sid=');
expect(cookie).toContain('HttpOnly');
expect(cookie).toContain('Path=/');
expect(cookie).toContain('SameSite=Strict');
expect(cookie).not.toContain('Secure');
await waitOnExecutionContext(ctx);
```

Query the created row and assert:

```ts
expect(session?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
expect(session?.expires_at).not.toContain('T');
expect(session?.expires_at).not.toContain('Z');
```

Insert expired and invalid sessions before login, wait on the execution context, and assert both are deleted. Add an HTTPS login request and assert `Secure` is present. Add logout assertions for DB deletion, `Max-Age=0`, and token reuse returning `401`.

Add a cleanup-failure test using a trigger that aborts deletion only for token `cleanup-failure`, leaving login/logout's current-session deletion unaffected:

```ts
await env.DB.prepare(
  `INSERT INTO sessions (token, user_id, expires_at)
   VALUES ('cleanup-failure', ?, 'not-a-timestamp')`,
).bind(userId).run();
await withTestTrigger(
  env.DB,
  'test_fail_expired_session_cleanup',
  `CREATE TRIGGER test_fail_expired_session_cleanup
   BEFORE DELETE ON sessions
   WHEN OLD.token = 'cleanup-failure'
   BEGIN
     SELECT RAISE(ABORT, 'TEST_SESSION_CLEANUP_FAILURE');
   END`,
  async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(loginRequest, env, ctx);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
  },
);
```

Repeat with an authenticated logout request and assert the existing `{ ok: true, data: { loggedOut: true } }` envelope and cleared cookie remain successful while the cleanup promise settles through its caught error.

- [ ] **Step 6: Verify focused and full API suites**

Run:

```bash
npx vitest run test/api.integration.test.ts -t "세션 만료 형식"
npx vitest run test/api.integration.test.ts
```

Expected: all session cases and the full HTTP integration suite pass.

- [ ] **Step 7: Commit the session fix**

```bash
git add src/index.ts test/api.integration.test.ts
git commit -m "fix: normalize session expiry handling"
```

---

### Task 2: Define password recovery policy and parameterized D1 statements

**Files:**
- Create: `scripts/recover-password-core.mjs`
- Create: `scripts/recover-password-core.test.mjs`

**Interfaces:**
- Produces: `parseRecoveryArgs`, `expectedRecoveryConfirmation`, `validateRecoveryPassword`, `buildRecoveryPreflightQuery`, `assertRecoverableAdmin`, `buildRecoveryBatch`, `buildRecoveryPostflightQuery`, `assertRecoveryWriteResults`, `assertRecoveryPostflight`.
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Write failing core tests**

Create `scripts/recover-password-core.test.mjs` and cover exact argument, validation, SQL, and result behavior:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRecoverableAdmin,
  assertRecoveryPostflight,
  assertRecoveryWriteResults,
  buildRecoveryBatch,
  expectedRecoveryConfirmation,
  parseRecoveryArgs,
  validateRecoveryPassword,
} from './recover-password-core.mjs';

test('remote와 username을 명시해야 한다', () => {
  assert.throws(() => parseRecoveryArgs([]), /--remote/);
  assert.throws(() => parseRecoveryArgs(['--remote']), /--username/);
  assert.throws(
    () => parseRecoveryArgs(['--remote', '--username', 'admin', '--unknown']),
    /알 수 없는 옵션/,
  );
  assert.deepEqual(parseRecoveryArgs(['--remote', '--username', "admin' OR 1=1 --"]), {
    remote: true,
    username: "admin' OR 1=1 --",
  });
});

test('confirmation과 12자 password policy를 검증한다', () => {
  assert.equal(expectedRecoveryConfirmation('hereisorder', 'admin'), 'RECOVER hereisorder admin');
  assert.throws(() => validateRecoveryPassword('short', 'short'), /12자/);
  assert.throws(() => validateRecoveryPassword('twelve-chars!', 'different-pass'), /일치/);
  assert.equal(validateRecoveryPassword('twelve-chars!', 'twelve-chars!'), 'twelve-chars!');
});

test('username payload를 SQL이 아닌 params에만 둔다', () => {
  const username = "admin' OR 1=1 --";
  const { batch, auditJson } = buildRecoveryBatch({ username, passwordHash: 'pbkdf2-hash' });
  assert.equal(batch.length, 3);
  for (const statement of batch) assert.ok(!statement.sql.includes(username));
  assert.ok(batch.flatMap((statement) => statement.params).includes(username));
  assert.deepEqual(JSON.parse(auditJson), { source: 'operator_recovery', username });
});

test('target, write result, postflight를 엄격히 검증한다', () => {
  assert.throws(() => assertRecoverableAdmin([], 'admin'), /active admin/);
  assert.deepEqual(assertRecoverableAdmin([{ id: 7, username: 'admin' }], 'admin'), {
    id: 7,
    username: 'admin',
  });
  assert.throws(() => assertRecoveryWriteResults([
    { success: true, meta: { changes: 0 } },
    { success: true, meta: { changes: 0 } },
    { success: true, meta: { changes: 1 } },
  ]), /정확히 한 admin/);
  assert.doesNotThrow(() => assertRecoveryPostflight({
    username: 'admin',
    hash_scheme_ok: 1,
    session_count: 0,
    latest_recovery_audit: JSON.stringify({ source: 'operator_recovery', username: 'admin' }),
  }, JSON.stringify({ source: 'operator_recovery', username: 'admin' })));
});
```

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
node --test scripts/recover-password-core.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact preflight, batch, and postflight Interfaces**

Create `scripts/recover-password-core.mjs`:

```js
const ACTIVE_ADMIN_PREDICATE = `username = ?
  AND role = 'admin'
  AND is_active = 1
  AND is_deleted = 0`;

export function parseRecoveryArgs(argv) {
  let remote = false;
  let username;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--remote') {
      if (remote) throw new Error('--remote는 한 번만 사용할 수 있습니다.');
      remote = true;
    } else if (value === '--username') {
      if (username !== undefined) throw new Error('--username은 한 번만 사용할 수 있습니다.');
      const candidate = argv[index + 1];
      if (!candidate || candidate.startsWith('--')) throw new Error('--username 값이 필요합니다.');
      username = candidate;
      index += 1;
    } else throw new Error(`알 수 없는 옵션입니다: ${value}`);
  }
  if (!remote) throw new Error('password recovery에는 --remote가 필요합니다.');
  if (!username?.trim()) throw new Error('--username을 입력해야 합니다.');
  return { remote: true, username: username.trim() };
}

export function expectedRecoveryConfirmation(databaseName, username) {
  return `RECOVER ${databaseName} ${username}`;
}

export function validateRecoveryPassword(password, confirmation) {
  if (Array.from(password).length < 12) throw new Error('새 비밀번호는 12자 이상이어야 합니다.');
  if (password !== confirmation) throw new Error('새 비밀번호 확인이 일치하지 않습니다.');
  return password;
}

export function buildRecoveryPreflightQuery(username) {
  return {
    sql: `SELECT id, username FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}`,
    params: [username],
  };
}

export function assertRecoverableAdmin(rows, username) {
  if (rows.length !== 1 || rows[0].username !== username) {
    throw new Error('정확히 한 active admin을 찾을 수 없습니다.');
  }
  return { id: Number(rows[0].id), username: String(rows[0].username) };
}

export function buildRecoveryBatch({ username, passwordHash }) {
  const auditJson = JSON.stringify({ source: 'operator_recovery', username });
  return {
    auditJson,
    batch: [
      {
        sql: `UPDATE users SET password_hash = ?, updated_at = datetime('now')
              WHERE ${ACTIVE_ADMIN_PREDICATE}`,
        params: [passwordHash, username],
      },
      {
        sql: `DELETE FROM sessions WHERE user_id IN (
                SELECT id FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}
              )`,
        params: [username],
      },
      {
        sql: `INSERT INTO audit_logs
                (actor_user_id, action, entity_type, entity_id, before_json, after_json)
              SELECT NULL, 'recover_password', 'user', id, NULL, ?
                FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}`,
        params: [auditJson, username],
      },
    ],
  };
}

export function buildRecoveryPostflightQuery(username) {
  return {
    sql: `SELECT u.id, u.username,
                 instr(u.password_hash, ?) = 1 AS hash_scheme_ok,
                 (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
                 (SELECT after_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                     AND a.action = 'recover_password'
                   ORDER BY a.id DESC LIMIT 1) AS latest_recovery_audit
            FROM users u WHERE ${ACTIVE_ADMIN_PREDICATE}`,
    params: ['pbkdf2_sha256$100000$', username],
  };
}

export function assertRecoveryWriteResults(results) {
  if (results.length !== 3 || results.some((result) => result.success !== true)) {
    throw new Error('password recovery D1 batch가 완전히 성공하지 않았습니다.');
  }
  if (Number(results[0].meta?.changes) !== 1) {
    throw new Error('password recovery가 정확히 한 admin을 변경하지 않았습니다.');
  }
}

export function assertRecoveryPostflight(row, auditJson) {
  if (!row || Number(row.hash_scheme_ok) !== 1 || Number(row.session_count) !== 0) {
    throw new Error('password recovery postflight 검증에 실패했습니다.');
  }
  if (row.latest_recovery_audit !== auditJson) {
    throw new Error('password recovery audit fact가 일치하지 않습니다.');
  }
}
```

- [ ] **Step 4: Run core tests and verify GREEN**

Run:

```bash
node --test scripts/recover-password-core.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit recovery policy**

```bash
git add scripts/recover-password-core.mjs scripts/recover-password-core.test.mjs
git commit -m "feat: define safe password recovery policy"
```

---

### Task 3: Verify recovery atomicity and Worker hash compatibility in Miniflare

**Files:**
- Create: `test/password-recovery.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 recovery query objects and `createPasswordHash` from `scripts/generate-admin-seed.mjs`.
- Produces: direct D1 atomicity and actual `/api/auth/login` compatibility evidence.

- [ ] **Step 1: Write the integration verification suite**

Create a helper that turns REST-shaped statements into D1 prepared statements:

```ts
function prepareBatch(batch: Array<{ sql: string; params: unknown[] }>) {
  return batch.map(({ sql, params }) => env.DB.prepare(sql).bind(...params));
}
```

The success test must perform these exact writes and assertions:

```ts
const passwordHash = createPasswordHash(
  'new-secure-password',
  Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
);
const { batch, auditJson } = buildRecoveryBatch({ username: 'admin', passwordHash });
await env.DB.batch(prepareBatch(batch));

const user = await env.DB.prepare(
  'SELECT id, password_hash FROM users WHERE username = ?',
).bind('admin').first<{ id: number; password_hash: string }>();
const session = await env.DB.prepare(
  'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
).bind(user?.id).first<{ count: number }>();
const audit = await env.DB.prepare(
  `SELECT actor_user_id, action, entity_type, entity_id, after_json
     FROM audit_logs WHERE action = 'recover_password' ORDER BY id DESC LIMIT 1`,
).first();

expect(user?.password_hash).toBe(passwordHash);
expect(Number(session?.count)).toBe(0);
expect(audit).toEqual({
  actor_user_id: null,
  action: 'recover_password',
  entity_type: 'user',
  entity_id: user?.id,
  after_json: auditJson,
});
```

The rollback test must install a failing audit trigger, expect the batch to reject, and then assert the exact old hash and two sessions remain:

```ts
await expect(withTestTrigger(
  env.DB,
  'test_fail_operator_recovery_audit',
  `CREATE TRIGGER test_fail_operator_recovery_audit
   BEFORE INSERT ON audit_logs
   WHEN NEW.action = 'recover_password'
   BEGIN
     SELECT RAISE(ABORT, 'TEST_RECOVERY_AUDIT_FAILURE');
   END`,
  () => env.DB.batch(prepareBatch(batch)),
)).rejects.toThrow();
expect(await env.DB.prepare(
  'SELECT password_hash FROM users WHERE username = ?',
).bind('admin').first()).toEqual({ password_hash: oldHash });
expect(await env.DB.prepare(
  'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
).bind(adminId).first()).toEqual({ count: 2 });
```

Add separate cases that:

1. create one active admin and two sessions;
2. generate a fixed test hash with `createPasswordHash('new-secure-password', fixedSalt)`;
3. run `env.DB.batch(prepareBatch(batch))`;
4. assert hash changed, session count is 0, `actor_user_id` is null, and audit JSON is exact;
5. install an audit failure trigger and assert rejected batch leaves old hash and both sessions;
6. verify missing/staff/inactive/deleted/quote-payload usernames mutate nothing;
7. store the Node-generated hash and call the real `/api/auth/login`, expecting 200.

The success assertion must include:

```ts
expect(audit).toEqual({
  actor_user_id: null,
  action: 'recover_password',
  entity_type: 'user',
  entity_id: adminId,
  after_json: JSON.stringify({ source: 'operator_recovery', username: 'admin' }),
});
```

- [ ] **Step 2: Run the integration verification**

Run:

```bash
npx vitest run test/password-recovery.integration.test.ts
```

Expected: PASS against the Task 2 core. If it fails, correct the Task 2 SQL/result policy before committing this verification task; do not add a Worker recovery route.

- [ ] **Step 3: Complete the test harness without changing production Worker behavior**

Use the existing `withTestTrigger` helper for audit failure, the same table cleanup order as `test/api.integration.test.ts`, and `exports.default.fetch` for actual login. The login compatibility assertion is:

```ts
const response = await exports.default.fetch(new Request('http://example.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'new-secure-password' }),
}));
expect(response.status).toBe(200);
```

Do not add a Worker recovery route or export recovery functions from `src/index.ts`.

- [ ] **Step 4: Verify integration GREEN**

Run:

```bash
npx vitest run test/password-recovery.integration.test.ts test/api.integration.test.ts
```

Expected: all recovery and existing API tests pass.

- [ ] **Step 5: Commit atomicity evidence**

```bash
git add test/password-recovery.integration.test.ts
git commit -m "test: verify password recovery atomicity"
```

---

### Task 4: Add the secret-safe REST Adapter, operator CLI, and disposable rollback contract

**Files:**
- Create: `scripts/cloudflare-d1-rest.mjs`
- Create: `scripts/cloudflare-d1-rest.test.mjs`
- Create: `scripts/recover-password.mjs`
- Create: `scripts/recover-password.test.mjs`
- Create: `scripts/d1-rest-batch-contract.mjs`
- Create: `scripts/d1-rest-batch-contract.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/deploy-worker.yml`

**Interfaces:**
- Consumes: Task 2 policy, `createPasswordHash`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the `DB` block in `wrangler.toml`.
- Produces: `createCloudflareD1RestClient`, `readProductionD1Binding`, `promptHidden`, `runPasswordRecovery`, and a remote rollback contract gate.

- [ ] **Step 1: Write REST Adapter and CLI unit tests with injected fetch/TTY streams**

Test these facts before implementation:

- every request uses Bearer authorization and JSON without exposing token/account ID on failure;
- `readProductionD1Binding` returns the single `binding = "DB"` name/UUID and rejects missing/duplicate blocks;
- `runPasswordRecovery` performs no fetch or prompt without `--remote`, username, and secrets;
- read-only preflight may run before exact confirmation, but no `{ batch: ... }` mutation request may occur before exact confirmation, TTY password entry, and password validation;
- quote payload username appears only in REST `params`;
- password and hash are absent from output, errors, request URL, and postflight response;
- same password creates different random-salt hashes;
- Ctrl-C, Ctrl-D, stream `end`, and stream `error` reject and restore raw mode/listeners;
- update `changes !== 1`, failed result, session count, scheme, or audit mismatch fails postflight.

The exact-confirmation test must prove that only preflight read occurs:

```js
test('exact confirmation 전에는 mutation batch를 보내지 않는다', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hio-recovery-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'wrangler.toml');
  fs.writeFileSync(configPath, `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "hereisorder"\ndatabase_id = "db-id"\n`);
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(JSON.stringify({
      success: true,
      result: [{ success: true, results: [{ id: 1, username: 'admin' }], meta: {} }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    runPasswordRecovery({
      argv: ['--remote', '--username', 'admin'],
      env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
      fetchImpl,
      configPath,
      question: async () => 'wrong confirmation',
      hiddenPrompt: async () => assert.fail('password prompt must not run'),
      output: { write() {} },
    }),
    /확인 문구/,
  );
  assert.equal(bodies.length, 1);
  assert.equal(Object.hasOwn(bodies[0], 'batch'), false);
});
```

Run:

```bash
node --test scripts/cloudflare-d1-rest.test.mjs scripts/recover-password.test.mjs
```

Expected: FAIL with missing module errors.

- [ ] **Step 2: Implement the Cloudflare D1 REST Adapter**

`createCloudflareD1RestClient` must expose:

```js
export function createCloudflareD1RestClient({
  accountId,
  apiToken,
  fetchImpl = fetch,
  baseUrl = 'https://api.cloudflare.com/client/v4',
}) {
  async function request(pathname, init) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
    const envelope = await response.json();
    if (!response.ok || envelope?.success !== true) {
      throw new Error(`Cloudflare D1 request failed with HTTP ${response.status}.`);
    }
    return envelope;
  }

  return {
    async createDatabase(name) {
      const envelope = await request(`/accounts/${accountId}/d1/database`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return envelope.result;
    },
    async deleteDatabase(databaseId) {
      await request(`/accounts/${accountId}/d1/database/${databaseId}`, { method: 'DELETE' });
    },
    async query(databaseId, body) {
      const envelope = await request(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!Array.isArray(envelope.result) || envelope.result.some((result) => result.success !== true)) {
        throw new Error('Cloudflare D1 query did not fully succeed.');
      }
      return envelope.result;
    },
    async queryAllowingFailure(databaseId, body) {
      const response = await fetchImpl(`${baseUrl}/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { httpOk: response.ok, envelope: await response.json() };
    },
  };
}
```

- [ ] **Step 3: Implement the interactive CLI without password echo or files**

Implement `promptHidden` with `StringDecoder` and raw-mode input:

```js
import { StringDecoder } from 'node:string_decoder';

export function promptHidden({ input, output, prompt }) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('비밀번호 복구에는 interactive TTY가 필요합니다.'));
  }
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw === true;
    let value = '';
    let settled = false;
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onEnd = () => finish(null, new Error('TTY 입력이 종료되었습니다.'));
    const onError = () => finish(null, new Error('TTY 입력을 읽을 수 없습니다.'));
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') return finish(null, new Error('사용자가 취소했습니다.'));
        if (character === '\u0004') return finish(null, new Error('TTY 입력이 종료되었습니다.'));
        if (character === '\r' || character === '\n') return finish(value, null);
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
      return undefined;
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}
```

Implement the exact `DB` binding reader without a generic TOML dependency:

```js
export function readProductionD1Binding({ configPath = 'wrangler.toml', binding = 'DB' } = {}) {
  const contents = fs.readFileSync(configPath, 'utf8');
  const matches = contents
    .split('[[d1_databases]]')
    .slice(1)
    .map((block) => ({
      binding: block.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1],
      databaseName: block.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1],
      databaseId: block.match(/^\s*database_id\s*=\s*"([^"]+)"/m)?.[1],
    }))
    .filter((entry) => entry.binding === binding);
  if (matches.length !== 1 || !matches[0].databaseName || !matches[0].databaseId) {
    throw new Error(`wrangler.toml에서 ${binding} D1 binding을 정확히 하나 찾을 수 없습니다.`);
  }
  return matches[0];
}
```

Implement visible confirmation and the complete orchestration with injectable prompt/fetch dependencies:

```js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { createPasswordHash } from './generate-admin-seed.mjs';
import {
  assertRecoverableAdmin,
  assertRecoveryPostflight,
  assertRecoveryWriteResults,
  buildRecoveryBatch,
  buildRecoveryPostflightQuery,
  buildRecoveryPreflightQuery,
  expectedRecoveryConfirmation,
  parseRecoveryArgs,
  validateRecoveryPassword,
} from './recover-password-core.mjs';

async function defaultQuestion({ input, output, prompt }) {
  const terminal = readline.createInterface({ input, output, terminal: true });
  try { return await terminal.question(prompt); }
  finally { terminal.close(); }
}

export async function runPasswordRecovery({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  fetchImpl = fetch,
  configPath = 'wrangler.toml',
  question = defaultQuestion,
  hiddenPrompt = promptHidden,
  createHash = createPasswordHash,
} = {}) {
  const { username } = parseRecoveryArgs(argv);
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_API_TOKEN과 CLOUDFLARE_ACCOUNT_ID가 필요합니다.');
  }
  const binding = readProductionD1Binding({ configPath, binding: 'DB' });
  const client = createCloudflareD1RestClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    fetchImpl,
  });
  const preflight = buildRecoveryPreflightQuery(username);
  const preflightResults = await client.query(binding.databaseId, preflight);
  assertRecoverableAdmin(preflightResults[0]?.results ?? [], username);

  output.write(`Target database: ${binding.databaseName}\nTarget admin: ${username}\n`);
  const expected = expectedRecoveryConfirmation(binding.databaseName, username);
  const confirmation = await question({
    input,
    output,
    prompt: `Type ${expected} to continue: `,
  });
  if (confirmation !== expected) throw new Error('password recovery 확인 문구가 일치하지 않습니다.');

  const password = await hiddenPrompt({ input, output, prompt: 'New password: ' });
  const passwordConfirmation = await hiddenPrompt({ input, output, prompt: 'Confirm new password: ' });
  validateRecoveryPassword(password, passwordConfirmation);
  const passwordHash = createHash(password);
  const { batch, auditJson } = buildRecoveryBatch({ username, passwordHash });
  const writeResults = await client.query(binding.databaseId, { batch });
  assertRecoveryWriteResults(writeResults);

  const postflight = buildRecoveryPostflightQuery(username);
  const postflightResults = await client.query(binding.databaseId, postflight);
  assertRecoveryPostflight(postflightResults[0]?.results?.[0], auditJson);
  output.write(
    `Password recovery completed for ${binding.databaseName}/${username}; sessions revoked and audit recorded.\n`,
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runPasswordRecovery().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Password recovery failed.');
    process.exitCode = 1;
  });
}
```

Add to `package.json`:

```json
"db:recover-password": "node scripts/recover-password.mjs",
"test:d1-rest-batch-contract": "node scripts/d1-rest-batch-contract.mjs"
```

- [ ] **Step 4: Write the disposable remote rollback contract test and runner**

Unit-test the runner with an injected fake client first. The real runner must:

1. create a database named `hio-rb-<run-id>-<attempt>` with length at most 32;
2. create `contract_state(id INTEGER PRIMARY KEY, value INTEGER)` and `contract_guard(value INTEGER CHECK(value > 0))`;
3. insert `(1, 0)` into state;
4. submit this batch through `queryAllowingFailure`:

```js
{
  batch: [
    { sql: 'UPDATE contract_state SET value = 1 WHERE id = ?', params: ['1'] },
    { sql: 'INSERT INTO contract_guard(value) VALUES (?)', params: ['0'] },
  ],
}
```

5. require the batch to report failure;
6. query state separately and require `value === 0`;
7. delete the disposable database in `finally` even when assertions fail;
8. print only the disposable database name/UUID, never secrets.

Implement the runner with explicit readiness and failure semantics:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retryReady(operation, sleep = delay) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt < 10) await sleep(500);
    }
  }
  throw lastError;
}

export async function runD1RestBatchContract({
  client,
  runId,
  runAttempt,
  sleep = delay,
  log = console.log,
}) {
  const databaseName = `hio-rb-${runId}-${runAttempt}`.slice(0, 32);
  let database;
  try {
    database = await client.createDatabase(databaseName);
    await retryReady(() => client.query(database.uuid, {
      sql: 'CREATE TABLE contract_state(id INTEGER PRIMARY KEY, value INTEGER)', params: [],
    }), sleep);
    await client.query(database.uuid, {
      sql: 'CREATE TABLE contract_guard(value INTEGER CHECK(value > 0))', params: [],
    });
    await client.query(database.uuid, {
      sql: 'INSERT INTO contract_state(id, value) VALUES (?, ?)', params: ['1', '0'],
    });

    const failedBatch = await client.queryAllowingFailure(database.uuid, {
      batch: [
        { sql: 'UPDATE contract_state SET value = 1 WHERE id = ?', params: ['1'] },
        { sql: 'INSERT INTO contract_guard(value) VALUES (?)', params: ['0'] },
      ],
    });
    const batchResults = Array.isArray(failedBatch.envelope?.result)
      ? failedBatch.envelope.result
      : [];
    const failureObserved = !failedBatch.httpOk
      || failedBatch.envelope?.success !== true
      || batchResults.some((result) => result.success !== true);
    if (!failureObserved) throw new Error('D1 REST failure batch가 성공으로 보고되었습니다.');

    const verification = await client.query(database.uuid, {
      sql: 'SELECT value FROM contract_state WHERE id = ?', params: ['1'],
    });
    if (Number(verification[0]?.results?.[0]?.value) !== 0) {
      throw new Error('D1 REST batch의 선행 update가 rollback되지 않았습니다.');
    }
    log(`D1 REST batch rollback verified: ${database.name}/${database.uuid}`);
  } finally {
    if (database?.uuid) await client.deleteDatabase(database.uuid);
  }
}

async function main() {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CONTRACT_RUN_ID, CONTRACT_RUN_ATTEMPT } = process.env;
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CONTRACT_RUN_ID || !CONTRACT_RUN_ATTEMPT) {
    throw new Error('D1 REST batch contract 환경변수가 필요합니다.');
  }
  const client = createCloudflareD1RestClient({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
  });
  await runD1RestBatchContract({
    client,
    runId: CONTRACT_RUN_ID,
    runAttempt: CONTRACT_RUN_ATTEMPT,
  });
}

const isContractMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isContractMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'D1 REST batch contract failed.');
    process.exitCode = 1;
  });
}
```

Use this fake-client success/cleanup contract test, then add variants for one readiness retry, unexpected all-success batch, and nonzero post-batch state:

```js
test('remote failure batch rollback을 확인하고 disposable D1을 삭제한다', async () => {
  const deleted = [];
  let setupCall = 0;
  let readinessAttempts = 0;
  const client = {
    async createDatabase(name) { return { name, uuid: 'temporary-db-id' }; },
    async query(_databaseId, body) {
      setupCall += 1;
      if (body.sql.startsWith('CREATE TABLE contract_state')) {
        readinessAttempts += 1;
        if (readinessAttempts === 1) throw new Error('not ready');
      }
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 0 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return {
        httpOk: true,
        envelope: { success: true, result: [{ success: false, results: [], meta: {} }] },
      };
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };
  const logs = [];
  await runD1RestBatchContract({
    client, runId: '123', runAttempt: '1', sleep: async () => {},
    log: (message) => logs.push(message),
  });
  assert.ok(setupCall >= 4);
  assert.equal(readinessAttempts, 2);
  assert.deepEqual(deleted, ['temporary-db-id']);
  assert.equal(logs[0].includes('temporary-db-id'), true);
});

test('failure batch가 모두 성공으로 보고되면 contract를 실패시킨다', async () => {
  const deleted = [];
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
    async query() { return [{ success: true, results: [], meta: {} }]; },
    async queryAllowingFailure() {
      return { httpOk: true, envelope: { success: true, result: [{ success: true }] } };
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };
  await assert.rejects(
    runD1RestBatchContract({ client, runId: '123', runAttempt: '1', sleep: async () => {} }),
    /성공으로 보고/,
  );
  assert.deepEqual(deleted, ['temporary-db-id']);
});

test('rollback assertion이 실패해도 disposable D1을 삭제한다', async () => {
  const deleted = [];
  const client = {
    async createDatabase() { return { name: 'temporary', uuid: 'temporary-db-id' }; },
    async query(_databaseId, body) {
      if (body.sql.startsWith('SELECT value')) {
        return [{ success: true, results: [{ value: 1 }], meta: {} }];
      }
      return [{ success: true, results: [], meta: {} }];
    },
    async queryAllowingFailure() {
      return { httpOk: false, envelope: { success: false, result: [] } };
    },
    async deleteDatabase(databaseId) { deleted.push(databaseId); },
  };
  await assert.rejects(
    runD1RestBatchContract({ client, runId: '123', runAttempt: '1', sleep: async () => {} }),
    /rollback되지 않았습니다/,
  );
  assert.deepEqual(deleted, ['temporary-db-id']);
});
```

Run unit tests:

```bash
node --test scripts/cloudflare-d1-rest.test.mjs \
  scripts/recover-password.test.mjs \
  scripts/d1-rest-batch-contract.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Gate production deployment on the real remote rollback contract**

Add job `d1-rest-batch-contract` to `.github/workflows/deploy-worker.yml` after `verify`, restricted to the same main push/workflow-dispatch condition as deployment. It installs root dependencies and runs:

```yaml
- name: Verify D1 REST batch rollback
  run: npm run test:d1-rest-batch-contract
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CONTRACT_RUN_ID: ${{ github.run_id }}
    CONTRACT_RUN_ATTEMPT: ${{ github.run_attempt }}
```

Change `deploy-api.needs` to:

```yaml
needs:
  - verify
  - d1-rest-batch-contract
```

If the token cannot create/delete disposable D1 databases or rollback is not observed, deployment stops before production migration.

- [ ] **Step 6: Commit the operational Adapter and remote contract gate**

```bash
git add scripts/cloudflare-d1-rest.mjs scripts/cloudflare-d1-rest.test.mjs \
  scripts/recover-password.mjs scripts/recover-password.test.mjs \
  scripts/d1-rest-batch-contract.mjs scripts/d1-rest-batch-contract.test.mjs \
  package.json .github/workflows/deploy-worker.yml
git commit -m "feat: add verified operator password recovery"
```

---

### Task 5: Remove unsafe recovery guidance and verify the full delivery

**Files:**
- Modify: `frontend/app/(app)/settings/page.tsx:275-320`
- Modify: `README.md:62-79,93-103`
- Modify: `docs/design/cloudflare-deploy-guide.md:43-62,104-109`
- Create: `scripts/password-recovery-docs.test.mjs`

**Interfaces:**
- Consumes: `npm run db:recover-password -- --remote --username <name>` from Task 4.
- Produces: trusted operator instructions with no external hash tool or raw password update.

- [ ] **Step 1: Write a failing static regression test**

Create `scripts/password-recovery-docs.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const paths = [
  'README.md',
  'docs/design/cloudflare-deploy-guide.md',
  'frontend/app/(app)/settings/page.tsx',
];

test('외부 hash 도구와 raw password update 안내가 없다', () => {
  const combined = paths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const forbidden of [
    'emn178.github.io',
    'SHA-256 온라인 도구',
    'SET password_hash',
    'UPDATE users',
  ]) {
    assert.equal(combined.includes(forbidden), false, `${forbidden} 안내를 제거해야 합니다.`);
  }
});
```

- [ ] **Step 2: Run the static test and verify RED**

Run:

```bash
node --test scripts/password-recovery-docs.test.mjs
```

Expected: FAIL on the current README and settings page.

- [ ] **Step 3: Remove the settings recovery card and replace operator docs**

Delete the complete “비밀번호를 잊어버렸을 때” `Card` from the settings page. Document only these paths:

- a logged-in admin resets another user with the existing settings UI;
- total admin lockout uses:

```bash
npm run db:recover-password -- --remote --username admin
```

- the command displays database/username, requires `RECOVER hereisorder admin`, reads a 12+ character password twice without echo, revokes every target session, and records an operator recovery audit;
- passwords must never be entered into web hash tools, chat, issues, or shell arguments;
- the operator environment needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with the D1 access required by the verified Adapter.

- [ ] **Step 4: Run static, frontend, root, and Cloudflare verification**

Run:

```bash
node --test scripts/password-recovery-docs.test.mjs
npm test
npm run typecheck
npm run build
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
```

Expected: every command succeeds.

- [ ] **Step 5: Commit documentation and UI removal**

```bash
git add README.md docs/design/cloudflare-deploy-guide.md \
  'frontend/app/(app)/settings/page.tsx' scripts/password-recovery-docs.test.mjs
git commit -m "docs: replace unsafe password recovery guidance"
```

---

## Plan Completion Gate

- Past/current/invalid ISO or SQLite sessions cannot authenticate; future rows of both valid formats can.
- New sessions use `YYYY-MM-DD HH:mm:ss`, cookie behavior is unchanged, and cleanup settles through `waitUntil`.
- Recovery accepts only an active admin, parameterizes username, generates random-salt PBKDF2 locally, revokes all sessions, and writes an exact null-actor audit fact.
- Miniflare proves atomic batch rollback and Node/Worker hash compatibility.
- A disposable remote D1 proves REST batch rollback before production migration; the database is deleted in `finally`.
- No password/hash/API secret is logged or written to a file.
- External hash links and raw password SQL are absent from source/docs.
- Root, frontend, Cloudflare builds, and `git diff --check` pass.
