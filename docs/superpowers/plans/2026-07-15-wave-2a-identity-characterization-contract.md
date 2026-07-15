# Wave 2A Identity Characterization and Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a no-runtime-change Wave 2A slice that freezes the safe Identity behavior already in production, publishes the executable target Identity HTTP contract, and produces a fixed read-only production compatibility gate for Wave 2B.

**Architecture:** Keep `src/index.ts`, D1 migrations, and runtime configuration unchanged in this slice. Add the target Identity wire contract to the existing portable HTTP package, record current/target differences without introducing failing CI cases, and run one fixed aggregate through a zero-argument Node adapter and a manual main-only workflow. The compatibility report is the only valid entry evidence for the later Identity Module extraction.

**Tech Stack:** TypeScript 5.6, Hono, Zod 3.24.1, Cloudflare Workers Vitest/Miniflare, Node.js 22.23.1, Cloudflare D1 REST API, GitHub Actions, npm 10.9.8.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-15-wave-2-identity-session-deep-module-design.md`; this plan implements only delivery slice 2A.
- Do not modify `src/index.ts`, `migrations/`, `db/schema.sql`, `wrangler.toml`, runtime bindings, cookie behavior, password behavior, or production D1 rows in the implementation PR.
- Preserve the 30-day absolute session, current raw-token storage, legacy/PBKDF2 login compatibility, HTTP(S) cookie attributes, role behavior, current password mutation behavior, and existing public responses until their owning later slice.
- Characterization tests must pass on the baseline. Current defects belong in the red matrix, not in skipped, expected-failure, or deliberately failing CI tests.
- The target request limits are 32 KiB UTF-8 JSON, 128 username code points, 200 name code points, 4,096 submitted-password code points, and 12–4,096 new-human-password code points; no value is truncated.
- Public projections remain exact: `SessionUserProjection = { id, username, name, role }`; `AdminUserProjection` adds only `is_active` and `created_at`. Neither exposes `access_mode`, password data, or session data.
- Identity response decoding validates success status, strict envelope, projection, and route-specific error status/code together. Any mismatch throws a local error whose code is exactly `INVALID_RESPONSE`.
- Identity header assertion requires exact `Cache-Control: no-store` on every response, `Retry-After: 60` only for login throttling, exact cookie set/clear attributes where required, and no unexpected `Set-Cookie`.
- The compatibility query is one parameter-free, read-only statement over every `is_deleted = 0` user, including inactive users.
- `identity-compatibility-v1` evidence has exactly eight ordered fields: `auditVersion`, `executedAt`, `gitSha`, `requestId`, `legacyPasswordHashCount`, `unsupportedPasswordHashCount`, `invalidIdentityProjectionCount`, `outcome`.
- A valid report requires an exact lowercase 40-character main SHA, UUIDv4 request id, exact ISO timestamp, non-negative safe-integer counts, and `outcome = 'verified'`.
- Wave 2B cannot begin unless the exact current `main` report has `unsupportedPasswordHashCount = 0` and `invalidIdentityProjectionCount = 0`.
- The audit accepts no SQL, username, role, database id, action, or other workflow input. It uses only `CLOUDFLARE_D1_READ_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; there is no deploy-token fallback.
- Never print or persist user rows, usernames, names, roles, password hashes, session rows/tokens, database ids, account ids, Cloudflare envelopes, credentials, or raw errors.
- Every implementation task follows a focused test cycle and ends in a reviewable commit. The final gate uses the exact commands in Task 5.

## Follow-on plan boundary

Wave 2B, 2C, 2D, 2E, 2F-a, 2F-b1, 2F-b2, and 2G each receive their own implementation plan after the preceding production gate passes. This keeps later file paths and interfaces tied to the exact merged repository state and prevents a stale all-wave plan from authorizing a forward-only transition.

## Execution prerequisite

Before Task 1, invoke `superpowers:using-git-worktrees` and create an isolated worktree on branch `refactor/wave-2a-identity-contract` from the commit containing this plan. Run `npm ci`, `npm --prefix frontend ci`, `npm test`, and `npm --prefix frontend test` there before editing. The implementation remains in that worktree through Task 5; Task 6 uses `superpowers:finishing-a-development-branch` for review, PR, merge, and cleanup.

## File responsibility map

**Create**

- `packages/http-contract/src/identity.ts` — strict Identity schemas, inferred types, paths, route matrix, and the single status-aware decoder.
- `packages/http-contract/tsconfig.json` — a dedicated compiler boundary that includes every portable contract source.
- `test/identity-http-contract.test.ts` — executable target-contract tests independent of current Worker behavior.
- `scripts/sql/identity-compatibility-v1.sql` — the only production compatibility query.
- `test/identity-compatibility.integration.test.ts` — real migrated-D1 proof of hash/projection classification.
- `scripts/identity-compatibility-audit.mjs` — fixed SQL loader, D1 result decoder, environment/target validation, whitelist report, summary, and zero-argument CLI.
- `scripts/identity-compatibility-audit.test.mjs` — pure adapter, result, evidence, and redaction tests.
- `.github/workflows/audit-identity-compatibility.yml` — manual, main-only, read-token-only audit.
- `scripts/identity-compatibility-workflow.test.mjs` — canonical and semantic workflow safety tests.
- `scripts/identity-compatibility-docs.test.mjs` — permanent documentation contract for the 2B entry gate.

**Modify**

- `test/api.integration.test.ts` — add only missing green characterization cases; retain existing expiry/cookie/login-CAS/logout coverage.
- `packages/http-contract/package.json` — export `./identity`.
- `package.json` — expose the zero-argument audit script.
- `docs/design/api-spec-v1.md` — add a clearly future-owned Wave 2 red matrix without rewriting current production behavior as already shipped.
- `docs/design/cloudflare-deploy-guide.md` — document secret provisioning, dispatch, exact evidence, failure, and 2B entry.
- `docs/design/implementation-checklist-v1.md` — add the Wave 2A merge/deploy/audit gates.
- `README.md` — add only the short operator entry point and link to the deployment guide.

**Explicitly unchanged**

- `src/index.ts`, `src/readiness.ts`, `src/observability.ts`
- `migrations/001_init.sql`, `migrations/002_integrity_and_roles.sql`
- `wrangler.toml`, `test/env.d.ts`
- all frontend application files

---

### Task 1: Freeze current safe Identity behavior and record the red matrix

**Files:**

- Modify: `test/api.integration.test.ts`
- Modify: `docs/design/api-spec-v1.md`

**Interfaces:**

- Consumes: existing `loginRequest`, `apiRequest`, `expectApiError`, `createSessionWithExpiry`, `createPasswordHash`, and migrated `env.DB` helpers in `test/api.integration.test.ts`.
- Produces: a green compatibility baseline and a named red matrix whose owner column is one of `2C`, `2D`, `2E`, or `2F`.

- [ ] **Step 1: Add green projection, lifecycle, and revocation characterization**

Add this focused block before the business-route describes in `test/api.integration.test.ts`. Use unique values exactly as shown so the tests remain isolated under the existing `beforeEach` cleanup.

```ts
describe('Wave 2A Identity compatibility characterization', () => {
  it('current-user and admin-user projections stay exact and role changes affect a live session', async () => {
    const token = `projection-${crypto.randomUUID()}`;
    const username = `projection-${crypto.randomUUID()}`;
    const inserted = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, name, role)
       VALUES (?, 'unused', 'Projection User', 'admin')`,
    ).bind(username).run();
    const userId = Number(inserted.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+1 hour'))`,
    ).bind(token, userId).run();

    const me = await apiRequest('/api/users/me', token);
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({
      ok: true,
      data: { id: userId, username, name: 'Projection User', role: 'admin' },
    });

    const list = await apiRequest('/api/users', token);
    expect(list.status).toBe(200);
    const listBody = await list.json() as {
      ok: true;
      data: Array<Record<string, unknown>>;
    };
    expect(Object.keys(listBody.data[0]).sort()).toEqual([
      'created_at', 'id', 'is_active', 'name', 'role', 'username',
    ]);
    expect(listBody.data[0]).toMatchObject({
      id: userId,
      username,
      name: 'Projection User',
      role: 'admin',
      is_active: 1,
    });
    expect(listBody.data[0].created_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );

    await env.DB.prepare("UPDATE users SET role = 'staff' WHERE id = ?")
      .bind(userId).run();
    await expectApiError(
      await apiRequest('/api/users', token),
      403,
      'FORBIDDEN',
      '관리자 권한이 필요합니다.',
    );
  });

  it('user creation defaults name and role while preserving the exact admin projection', async () => {
    const adminToken = await createSession('admin');
    const username = `created-${crypto.randomUUID()}`;
    const response = await apiRequest('/api/users', adminToken, {
      method: 'POST',
      body: JSON.stringify({ username, password: 'current-six-char-policy' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      ok: true;
      data: Record<string, unknown>;
    };
    expect(Object.keys(body.data).sort()).toEqual([
      'created_at', 'id', 'is_active', 'name', 'role', 'username',
    ]);
    expect(body.data).toMatchObject({
      username,
      name: username,
      role: 'staff',
      is_active: 1,
    });
    expect(body.data.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('self-change revokes sibling sessions', async () => {
    const username = `self-change-${crypto.randomUUID()}`;
    const currentPassword = 'current-password-value';
    const inserted = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, name, role)
       VALUES (?, ?, 'Self Change', 'staff')`,
    ).bind(username, createPasswordHash(currentPassword)).run();
    const userId = Number(inserted.meta.last_row_id);
    const currentToken = `current-${crypto.randomUUID()}`;
    const siblingToken = `sibling-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
      ).bind(currentToken, userId),
      env.DB.prepare(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
      ).bind(siblingToken, userId),
    ]);

    const changed = await apiRequest('/api/users/me/password', currentToken, {
      method: 'PATCH',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: 'replacement-password-value',
      }),
    });
    expect(changed.status).toBe(200);
    expect((await apiRequest('/api/users/me', siblingToken)).status).toBe(401);
  });

  it('admin reset revokes every target session', async () => {
    const adminToken = await createSession('admin');
    const username = `reset-target-${crypto.randomUUID()}`;
    const inserted = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, name, role)
       VALUES (?, ?, 'Reset Target', 'staff')`,
    ).bind(username, createPasswordHash('target-current-password')).run();
    const targetUserId = Number(inserted.meta.last_row_id);
    const firstToken = `target-first-${crypto.randomUUID()}`;
    const secondToken = `target-second-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
      ).bind(firstToken, targetUserId),
      env.DB.prepare(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
      ).bind(secondToken, targetUserId),
    ]);

    const changed = await apiRequest(
      `/api/users/${targetUserId}/password`,
      adminToken,
      {
        method: 'PATCH',
        body: JSON.stringify({ new_password: 'replacement-password-value' }),
      },
    );
    expect(changed.status).toBe(200);
    expect((await apiRequest('/api/users/me', firstToken)).status).toBe(401);
    expect((await apiRequest('/api/users/me', secondToken)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the characterization file and confirm the baseline is green**

Run:

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:$PATH
npm exec -- vitest run test/api.integration.test.ts
```

Expected: `test/api.integration.test.ts` passes. A failure means the assertion does not describe the current baseline and must be reconciled before continuing; production code is not changed in this task.

- [ ] **Step 3: Add the explicit red matrix to the API specification**

Append a `### Wave 2 전환 red matrix` subsection under `## 2. 인증과 사용자` in `docs/design/api-spec-v1.md` with this exact table and note:

```markdown
### Wave 2 전환 red matrix

이 표는 현재 production과 승인된 Wave 2 계약의 차이를 기록합니다. 2A에서는 아래 동작을 바꾸거나 실패 테스트로 병합하지 않습니다. 각 owning slice가 구현과 회귀 테스트를 같은 커밋에서 추가합니다.

| Current production behavior | Approved target | Owning slice |
| --- | --- | --- |
| 없는/비활성 계정은 잘못된 비밀번호와 다른 메시지·작업량을 사용 | 모든 invalid login credential은 같은 401/message와 one-SHA/one-PBKDF2 schedule | 2C |
| Identity JSON과 필드가 coercion되고 명시적 32-KiB/128/200/4096 cap이 없음 | strict content type/body/field cap, extra-field rejection, no truncation | 2C |
| human password setter가 6자 minimum을 사용 | 새 human password는 12 Unicode code points 이상 | 2C |
| self change가 observed hash/session expiry를 CAS하지 않고 현재 raw token을 유지 | observed-state CAS, revoke-all, same-expiry replacement token rotation | 2C |
| admin reset이 target observed state를 CAS하지 않고 self reset도 허용 | target CAS, concurrent conflict, self-reset prohibition | 2C |
| logout이 valid authenticated context를 요구하고 audit와 delete를 한 batch에 묶음 | public idempotent locator, authoritative delete, best-effort audit, retryable D1 failure | 2C |
| presented invalid cookie 401이 항상 cookie를 clear하지 않음 | determinate invalid/expired cookie clears; D1 uncertainty does not | 2C |
| 브라우저 페이지가 개별적으로 broad 401 redirect를 수행 | strict route decoder와 shared authenticated-session classifier | 2D |
| reusable session token을 D1 `sessions.token`에 저장 | compatibility deployment 뒤 새 token은 SHA-256 digest만 재사용 가능 | 2E/2F-a |
| production smoke identity가 일반 staff write 권한을 가짐 | additive `read_only` access mode로 모든 business mutation을 server에서 거부 | 2F-b1/2F-b2 |

현재 API 설명은 owning slice가 production에 배포되기 전까지 current behavior를 계속 나타냅니다. Target wire contract의 실행 가능한 정의는 `@here-is-order/http-contract/identity`입니다.
```

- [ ] **Step 4: Re-run the focused characterization**

Run: `npm exec -- vitest run test/api.integration.test.ts`

Expected: PASS with no skipped or expected-failure tests.

- [ ] **Step 5: Commit the characterization boundary**

```bash
git add test/api.integration.test.ts docs/design/api-spec-v1.md
git commit -m "test: characterize identity compatibility"
```

---

### Task 2: Publish the executable Identity HTTP contract

**Files:**

- Create: `packages/http-contract/src/identity.ts`
- Create: `packages/http-contract/tsconfig.json`
- Create: `test/identity-http-contract.test.ts`
- Modify: `packages/http-contract/package.json`

**Interfaces:**

- Consumes: `ApiEnvelope`, `RuntimeSchema`, and `apiEnvelopeSchema` from `packages/http-contract/src/envelope.ts`.
- Produces:

```ts
export type IdentityOperation =
  | 'login' | 'logout' | 'currentUser' | 'listUsers'
  | 'createUser' | 'changeOwnPassword' | 'resetPassword';

export function decodeIdentityHttpResponse<K extends IdentityOperation>(
  operation: K,
  status: number,
  input: unknown,
): IdentityHttpResponse<K>;

export interface HeaderReader {
  get(name: string): string | null;
}

export interface IdentityHeaderContext {
  secure: boolean;
  sessionCookiePresented: boolean;
}

export function assertIdentityResponseHeaders<K extends IdentityOperation>(
  operation: K,
  status: number,
  envelope: IdentityHttpResponse<K>,
  headers: HeaderReader,
  context: IdentityHeaderContext,
): void;

export const identityPaths: {
  login: '/api/auth/login';
  logout: '/api/auth/logout';
  currentUser: '/api/users/me';
  users: '/api/users';
  ownPassword: '/api/users/me/password';
  userPassword(userId: number): string;
};
```

- [ ] **Step 1: Write the failing contract tests**

Create `test/identity-http-contract.test.ts`. The file must use table-driven tests for every operation and the following concrete fixtures:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  IDENTITY_JSON_BODY_LIMIT_BYTES,
  IdentityResponseContractError,
  adminPasswordResetRequestSchema,
  adminUserProjectionSchema,
  assertIdentityResponseHeaders,
  createUserRequestSchema,
  decodeIdentityHttpResponse,
  identityAllowedErrorPairs,
  identityMessages,
  identityPaths,
  loginRequestSchema,
  newHumanPasswordSchema,
  selfPasswordChangeRequestSchema,
  sessionUserProjectionSchema,
  type IdentityAllowedErrorPair,
  type IdentityHttpResponse,
  type IdentityOperation,
} from '@here-is-order/http-contract/identity';

const sessionUser = {
  id: 7,
  username: 'staff-7',
  name: '직원 7',
  role: 'staff',
} as const;
const adminUser = {
  ...sessionUser,
  is_active: 1,
  created_at: '2026-07-15 12:34:56',
} as const;

const successes = [
  { operation: 'login', status: 200, data: { user: sessionUser } },
  { operation: 'logout', status: 200, data: { loggedOut: true } },
  { operation: 'currentUser', status: 200, data: sessionUser },
  { operation: 'listUsers', status: 200, data: [adminUser] },
  { operation: 'createUser', status: 201, data: adminUser },
  { operation: 'changeOwnPassword', status: 200, data: { ok: true } },
  { operation: 'resetPassword', status: 200, data: { ok: true } },
] as const;

const expectedErrors = {
  login: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 401, code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' },
    { status: 429, code: 'TOO_MANY_ATTEMPTS', message: '로그인 시도가 너무 많습니다. 60초 후 다시 시도해주세요.' },
    { status: 503, code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: '로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  logout: [
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  currentUser: [
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  listUsers: [
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  createUser: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 403, code: 'READ_ONLY_ACCESS', message: '읽기 전용 계정은 변경 작업을 할 수 없습니다.' },
    { status: 409, code: 'DUPLICATE_USERNAME', message: '이미 사용 중인 아이디입니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  changeOwnPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 401, code: 'INVALID_CREDENTIALS', message: '현재 비밀번호가 올바르지 않습니다.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 409, code: 'AUTH_STATE_CHANGED', message: '계정 상태가 변경되었습니다. 다시 로그인해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  resetPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 400, code: 'SELF_RESET_NOT_ALLOWED', message: '본인 비밀번호는 보안 설정에서 변경해주세요.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 403, code: 'READ_ONLY_ACCESS', message: '읽기 전용 계정은 변경 작업을 할 수 없습니다.' },
    { status: 404, code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' },
    { status: 409, code: 'TARGET_STATE_CHANGED', message: '사용자 상태가 변경되었습니다. 다시 확인해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
} as const satisfies Record<IdentityOperation, readonly IdentityAllowedErrorPair[]>;

const operations = Object.keys(expectedErrors) as IdentityOperation[];
const allErrors = operations.flatMap((operation) => expectedErrors[operation].map((error) => ({
  operation,
  ...error,
})));
const allErrorDefinitions = Array.from(new Map(
  allErrors.map(({ status, code, message }) => [
    JSON.stringify([status, code, message]),
    { status, code, message },
  ]),
).values());
const knownErrorStatuses = Array.from(new Set(
  allErrors.map(({ status }) => status),
));
const mismatchedErrorPairs = operations.flatMap((operation) => knownErrorStatuses
  .flatMap((status) => allErrorDefinitions
    .filter((candidate) => !expectedErrors[operation].some((allowed) => (
      allowed.status === status && allowed.code === candidate.code
    )))
    .map((candidate) => ({ operation, ...candidate, status }))));

function errorEnvelope(error: IdentityAllowedErrorPair) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message ?? '입력값이 올바르지 않습니다.',
    },
  };
}

function expectInvalid(operation: IdentityOperation, status: number, input: unknown) {
  try {
    decodeIdentityHttpResponse(operation, status, input);
    throw new Error('expected contract failure');
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityResponseContractError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
  }
}

function headers(values: Readonly<Record<string, string | undefined>> = {}) {
  const normalized = new Map(
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
}

function sessionCookie(value: string, maxAge: number, secure = false) {
  return `isorder_sid=${value}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict${
    secure ? '; Secure' : ''
  }`;
}

function expectInvalidHeaders(
  operation: IdentityOperation,
  status: number,
  input: unknown,
  values: Readonly<Record<string, string | undefined>>,
  context: { secure: boolean; sessionCookiePresented: boolean },
) {
  const envelope = decodeIdentityHttpResponse(operation, status, input);
  expect(() => assertIdentityResponseHeaders(
    operation,
    status,
    envelope,
    headers(values),
    context,
  )).toThrowError(IdentityResponseContractError);
}

describe('Identity executable HTTP contract', () => {
  it('is consumed through the package export and keeps error codes route-closed', () => {
    expectTypeOf<Extract<IdentityHttpResponse<'login'>, { ok: false }>['error']['code']>()
      .toEqualTypeOf<
        'INVALID_INPUT' | 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS'
        | 'AUTH_TEMPORARILY_UNAVAILABLE' | 'INTERNAL_ERROR'
      >();
    expect(identityMessages.unauthorized).toBe('로그인이 필요합니다.');
  });

  it.each(successes)('decodes exact $operation success', ({ operation, status, data }) => {
    expect(decodeIdentityHttpResponse(operation, status, { ok: true, data }))
      .toEqual({ ok: true, data });
  });

  it('keeps session/admin projections exact and validates canonical SQLite UTC', () => {
    expect(sessionUserProjectionSchema.parse(sessionUser)).toEqual(sessionUser);
    expect(adminUserProjectionSchema.parse(adminUser)).toEqual(adminUser);
    expect(() => sessionUserProjectionSchema.parse(adminUser)).toThrow();
    expect(() => adminUserProjectionSchema.parse({ ...adminUser, access_mode: 'read_only' }))
      .toThrow();
    expect(() => sessionUserProjectionSchema.parse({ ...sessionUser, username: ' staff-7' }))
      .toThrow();
    for (const created_at of [
      '0000-01-01 00:00:00',
      '0099-12-31 23:59:59',
      '2024-02-29 12:34:56',
    ]) {
      expect(adminUserProjectionSchema.parse({ ...adminUser, created_at }).created_at)
        .toBe(created_at);
    }
    for (const created_at of ['2025-02-29 12:34:56', '2026-02-30 12:34:56']) {
      expect(() => adminUserProjectionSchema.parse({ ...adminUser, created_at })).toThrow();
    }
  });

  it('normalizes only documented fields and locks both sides of every field limit', () => {
    expect(IDENTITY_JSON_BODY_LIMIT_BYTES).toBe(32 * 1_024);
    expect(loginRequestSchema.parse({
      username: ` ${'u'.repeat(128)} `,
      password: '  secret  ',
    })).toEqual({ username: 'u'.repeat(128), password: '  secret  ' });
    expect(loginRequestSchema.safeParse({
      username: 'u'.repeat(129),
      password: 'p',
    }).success).toBe(false);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '😀'.repeat(4_096),
    }).success).toBe(true);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '',
    }).success).toBe(true);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '😀'.repeat(4_097),
    }).success).toBe(false);

    const nameAtLimit = createUserRequestSchema.parse({
      username: 'new-user',
      name: ` ${'가'.repeat(200)} `,
      password: '123456789012',
    });
    expect(nameAtLimit.name).toBe('가'.repeat(200));
    expect(createUserRequestSchema.safeParse({
      username: 'new-user',
      name: '가'.repeat(201),
      password: '123456789012',
    }).success).toBe(false);
    expect(createUserRequestSchema.parse({
      username: ' new-user ',
      name: '   ',
      password: '123456789012',
    })).toEqual({
      username: 'new-user',
      name: 'new-user',
      password: '123456789012',
      role: 'staff',
    });

    expect(newHumanPasswordSchema.safeParse('😀'.repeat(11)).success).toBe(false);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(12)).success).toBe(true);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(4_096)).success).toBe(true);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(4_097)).success).toBe(false);
    expect(loginRequestSchema.safeParse({
      username: 'u', password: 'p', extra: true,
    }).success).toBe(false);
    expect(createUserRequestSchema.safeParse({
      username: 'u', password: '123456789012', role: '',
    }).success).toBe(false);
    expect(createUserRequestSchema.safeParse({
      username: 1, password: '123456789012',
    }).success).toBe(false);
    expect(selfPasswordChangeRequestSchema.safeParse({
      current_password: 'old', new_password: '가'.repeat(12),
    }).success).toBe(true);
    expect(adminPasswordResetRequestSchema.safeParse({
      new_password: '가'.repeat(12),
    }).success).toBe(true);
  });

  it('owns paths and rejects non-positive reset ids', () => {
    expect(identityPaths.userPassword(9)).toBe('/api/users/9/password');
    expect(() => identityPaths.userPassword(0)).toThrow('positive integer');
    expect(() => identityPaths.userPassword(1.5)).toThrow('positive integer');
  });

  it('publishes the complete status/code/canonical-message matrix', () => {
    expect(identityAllowedErrorPairs).toEqual(expectedErrors);
  });

  it.each(allErrors)('accepts $operation $status/$code with its message', (fixture) => {
    const input = errorEnvelope(fixture);
    expect(decodeIdentityHttpResponse(fixture.operation, fixture.status, input)).toEqual(input);
  });

  it.each(successes)('rejects every $operation success at another status', (fixture) => {
    expectInvalid(
      fixture.operation,
      fixture.status === 200 ? 201 : 200,
      { ok: true, data: fixture.data },
    );
  });

  it.each(allErrors)('rejects every $operation error at the success status', (fixture) => {
    const successStatus = successes.find(({ operation }) => operation === fixture.operation)!.status;
    expectInvalid(fixture.operation, successStatus, errorEnvelope(fixture));
  });

  it.each(mismatchedErrorPairs)(
    'rejects every unlisted $operation $status/$code combination',
    (fixture) => expectInvalid(fixture.operation, fixture.status, errorEnvelope(fixture)),
  );

  it.each(allErrors.filter(({ message }) => message !== null))(
    'rejects the wrong canonical message for $operation $status/$code',
    (fixture) => expectInvalid(fixture.operation, fixture.status, {
      ok: false,
      error: { code: fixture.code, message: `${fixture.message}x` },
    }),
  );

  it.each([
    ['login', 401, { ok: false, error: { code: 'UNKNOWN', message: 'x' } }],
    ['login', 400, { ok: false, error: { code: 'INVALID_INPUT', message: '' } }],
    ['currentUser', 401, { ok: false, error: { code: 'UNAUTHORIZED' } }],
    ['currentUser', 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.', extra: true } }],
    ['currentUser', 200, { ok: true, data: { ...sessionUser, access_mode: 'read_only' } }],
    ['currentUser', 200, { ok: true, data: sessionUser, extra: true }],
    ['resetPassword', 200, { ok: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' } }],
  ] as const)('rejects malformed or incoherent %s response', (operation, status, input) => {
    expectInvalid(operation, status, input);
  });

  it.each(successes)('requires no-store and the exact $operation success cookie rule', (fixture) => {
    const envelope = decodeIdentityHttpResponse(
      fixture.operation,
      fixture.status,
      { ok: true, data: fixture.data },
    );
    const setCookie = fixture.operation === 'login'
      ? sessionCookie('new-token', 2_592_000)
      : fixture.operation === 'logout'
        ? sessionCookie('', 0)
        : fixture.operation === 'changeOwnPassword'
          ? sessionCookie('rotated-token', 37)
          : undefined;
    assertIdentityResponseHeaders(
      fixture.operation,
      fixture.status,
      envelope,
      headers({
        'cache-control': 'no-store',
        ...(setCookie ? { 'set-cookie': setCookie } : {}),
      }),
      { secure: false, sessionCookiePresented: true },
    );
  });

  it.each(allErrors)('requires exact headers for $operation $status/$code', (fixture) => {
    const envelope = decodeIdentityHttpResponse(
      fixture.operation,
      fixture.status,
      errorEnvelope(fixture),
    );
    const mustClear = fixture.code === 'UNAUTHORIZED' || fixture.code === 'AUTH_STATE_CHANGED';
    assertIdentityResponseHeaders(
      fixture.operation,
      fixture.status,
      envelope,
      headers({
        'cache-control': 'no-store',
        ...(mustClear ? { 'set-cookie': sessionCookie('', 0) } : {}),
        ...(fixture.operation === 'login' && fixture.code === 'TOO_MANY_ATTEMPTS'
          ? { 'retry-after': '60' }
          : {}),
      }),
      { secure: false, sessionCookiePresented: true },
    );
  });

  it('allows either omission or an exact clear for missing-cookie UNAUTHORIZED', () => {
    const unauthorized = decodeIdentityHttpResponse('currentUser', 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    });
    assertIdentityResponseHeaders(
      'currentUser',
      401,
      unauthorized,
      headers({ 'cache-control': 'no-store' }),
      { secure: false, sessionCookiePresented: false },
    );
    assertIdentityResponseHeaders(
      'currentUser',
      401,
      unauthorized,
      headers({
        'cache-control': 'no-store',
        'set-cookie': sessionCookie('', 0),
      }),
      { secure: false, sessionCookiePresented: false },
    );
  });

  it('accepts exact Secure cookie attributes', () => {
    const login = decodeIdentityHttpResponse('login', 200, {
      ok: true,
      data: { user: sessionUser },
    });
    assertIdentityResponseHeaders(
      'login',
      200,
      login,
      headers({
        'cache-control': 'no-store',
        'set-cookie': sessionCookie('new-secure-token', 2_592_000, true),
      }),
      { secure: true, sessionCookiePresented: false },
    );
  });

  it.each([
    {
      label: 'presented-cookie UNAUTHORIZED without clear',
      operation: 'currentUser',
      status: 401,
      input: { ok: false, error: { code: 'UNAUTHORIZED', message: identityMessages.unauthorized } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'AUTH_STATE_CHANGED without clear',
      operation: 'changeOwnPassword',
      status: 409,
      input: { ok: false, error: { code: 'AUTH_STATE_CHANGED', message: identityMessages.authStateChanged } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'TARGET_STATE_CHANGED with clear',
      operation: 'resetPassword',
      status: 409,
      input: { ok: false, error: { code: 'TARGET_STATE_CHANGED', message: identityMessages.targetStateChanged } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('', 0) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'logout 500 with clear',
      operation: 'logout',
      status: 500,
      input: { ok: false, error: { code: 'INTERNAL_ERROR', message: identityMessages.internalError } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('', 0) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'login success missing cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'login success wrong cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('new-token', 37) },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'logout success missing cookie',
      operation: 'logout',
      status: 200,
      input: { ok: true, data: { loggedOut: true } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'logout success wrong cookie',
      operation: 'logout',
      status: 200,
      input: { ok: true, data: { loggedOut: true } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('new-token', 2_592_000) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'self-change success missing cookie',
      operation: 'changeOwnPassword',
      status: 200,
      input: { ok: true, data: { ok: true } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'self-change success wrong cookie',
      operation: 'changeOwnPassword',
      status: 200,
      input: { ok: true, data: { ok: true } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('rotated-token', 2_592_001) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'login 429 missing Retry-After',
      operation: 'login',
      status: 429,
      input: { ok: false, error: { code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'login 429 wrong Retry-After',
      operation: 'login',
      status: 429,
      input: { ok: false, error: { code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts } },
      values: { 'cache-control': 'no-store', 'retry-after': '61' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'Secure context with non-Secure cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('new-token', 2_592_000) },
      context: { secure: true, sessionCookiePresented: false },
    },
    {
      label: 'Identity response missing no-store',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'set-cookie': sessionCookie('new-token', 2_592_000) },
      context: { secure: false, sessionCookiePresented: false },
    },
  ] as const)('rejects $label', ({ operation, status, input, values, context }) => {
    expectInvalidHeaders(operation, status, input, values, context);
  });
});
```

The `32 KiB` constant is executable in 2A, while streaming enforcement is intentionally owned by the 2C Hono Adapter (`src/identity/http-input.ts`). A parsed Zod value cannot prove `Content-Length` rejection, capped UTF-8 streaming, or cancellation; those current runtime gaps remain only in Task 1's red matrix until 2C adds Adapter tests.

- [ ] **Step 2: Run the focused test and verify the missing contract failure**

Run: `npm exec -- vitest run test/identity-http-contract.test.ts`

Expected: FAIL because the `@here-is-order/http-contract/identity` package subpath is not exported and its source does not exist.

- [ ] **Step 3: Implement the schemas, path builders, and status-aware decoder**

Create `packages/http-contract/src/identity.ts` with these exact public names, operation/error/message matrix, status-aware body decoder, and server/smoke header assertion. Use `Array.from(value).length` for code-point limits, compare projection strings to `value.trim()`, and validate SQLite UTC fields by reconstructing UTC parts and comparing them to the source string. A present submitted-password string has only the safety maximum (zero length is not reclassified as the new-human-password policy); an absent or non-string field still fails the strict request schema. The timestamp reconstruction deliberately uses `setUTCFullYear` so SQLite years `0000` through `0099` are not remapped to 1900–1999 by `Date.UTC`.

```ts
import { z } from 'zod';
import {
  apiEnvelopeSchema,
  type RuntimeSchema,
} from './envelope';

export const IDENTITY_JSON_BODY_LIMIT_BYTES = 32 * 1_024;
const SESSION_SECONDS = 2_592_000;

function codePointLength(value: string) {
  return Array.from(value).length;
}

function boundedString(min: number, max: number) {
  return z.string().refine((value) => {
    const length = codePointLength(value);
    return length >= min && length <= max;
  }, `must contain ${min}-${max} Unicode code points`);
}

function canonicalString(min: number, max: number) {
  return boundedString(min, max).refine((value) => value === value.trim(),
    'must already be trimmed');
}

function normalizedString(min: number, max: number) {
  return z.string().transform((value) => value.trim()).pipe(boundedString(min, max));
}

function isCanonicalSqliteUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return Number.isFinite(date.getTime())
    && date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

export const userRoleSchema = z.enum(['admin', 'staff']);
export const submittedPasswordSchema = boundedString(0, 4_096);
export const newHumanPasswordSchema = boundedString(12, 4_096);

export const sessionUserProjectionSchema = z.object({
  id: z.number().int().positive(),
  username: canonicalString(1, 128),
  name: canonicalString(1, 200),
  role: userRoleSchema,
}).strict();

export const adminUserProjectionSchema = sessionUserProjectionSchema.extend({
  is_active: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string().refine(isCanonicalSqliteUtc, 'invalid SQLite UTC timestamp'),
}).strict();

export const loginRequestSchema = z.object({
  username: normalizedString(1, 128),
  password: submittedPasswordSchema,
}).strict();
export const loginResultSchema = z.object({ user: sessionUserProjectionSchema }).strict();
export const logoutResultSchema = z.object({ loggedOut: z.literal(true) }).strict();
export const currentUserResultSchema = sessionUserProjectionSchema;
export const listUsersResultSchema = z.array(adminUserProjectionSchema);

const optionalNormalizedNameSchema = z.string()
  .transform((value) => value.trim())
  .refine((value) => codePointLength(value) <= 200, 'name is too long')
  .optional();
const optionalNormalizedRoleSchema = z.string()
  .transform((value) => value.trim())
  .pipe(userRoleSchema)
  .optional();

export const createUserRequestSchema = z.object({
  username: normalizedString(1, 128),
  name: optionalNormalizedNameSchema,
  password: newHumanPasswordSchema,
  role: optionalNormalizedRoleSchema,
}).strict().transform((value) => ({
  username: value.username,
  name: value.name || value.username,
  password: value.password,
  role: value.role ?? 'staff',
}));
export const createUserResultSchema = adminUserProjectionSchema;

export const selfPasswordChangeRequestSchema = z.object({
  current_password: submittedPasswordSchema,
  new_password: newHumanPasswordSchema,
}).strict();
export const adminPasswordResetRequestSchema = z.object({
  new_password: newHumanPasswordSchema,
}).strict();
export const passwordMutationResultSchema = z.object({ ok: z.literal(true) }).strict();

export type UserRole = z.infer<typeof userRoleSchema>;
export type SessionUserProjection = z.infer<typeof sessionUserProjectionSchema>;
export type AdminUserProjection = z.infer<typeof adminUserProjectionSchema>;
export type LoginRequest = z.input<typeof loginRequestSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type LogoutResult = z.infer<typeof logoutResultSchema>;
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;
export type NormalizedCreateUserRequest = z.output<typeof createUserRequestSchema>;
export type SelfPasswordChangeRequest = z.infer<typeof selfPasswordChangeRequestSchema>;
export type AdminPasswordResetRequest = z.infer<typeof adminPasswordResetRequestSchema>;
export type PasswordMutationResult = z.infer<typeof passwordMutationResultSchema>;

export const identityRoutePatterns = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  currentUser: '/api/users/me',
  users: '/api/users',
  ownPassword: '/api/users/me/password',
  userPassword: '/api/users/:id/password',
} as const;

function positivePathId(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('userId must be a positive integer');
  }
  return String(value);
}

export const identityPaths = {
  login: identityRoutePatterns.login,
  logout: identityRoutePatterns.logout,
  currentUser: identityRoutePatterns.currentUser,
  users: identityRoutePatterns.users,
  ownPassword: identityRoutePatterns.ownPassword,
  userPassword(userId: number) {
    return `/api/users/${positivePathId(userId)}/password`;
  },
} as const;

export type IdentityOperation =
  | 'login' | 'logout' | 'currentUser' | 'listUsers'
  | 'createUser' | 'changeOwnPassword' | 'resetPassword';

interface IdentitySuccessByOperation {
  login: LoginResult;
  logout: LogoutResult;
  currentUser: SessionUserProjection;
  listUsers: AdminUserProjection[];
  createUser: AdminUserProjection;
  changeOwnPassword: PasswordMutationResult;
  resetPassword: PasswordMutationResult;
}

export const identityMessages = {
  loginMissingFields: '아이디와 비밀번호를 입력해주세요.',
  passwordPolicyViolation: '새 비밀번호는 12자 이상이어야 합니다.',
  loginInvalidCredentials: '아이디 또는 비밀번호가 올바르지 않습니다.',
  currentPasswordInvalid: '현재 비밀번호가 올바르지 않습니다.',
  unauthorized: '로그인이 필요합니다.',
  tooManyAttempts: '로그인 시도가 너무 많습니다. 60초 후 다시 시도해주세요.',
  forbidden: '관리자 권한이 필요합니다.',
  readOnlyAccess: '읽기 전용 계정은 변경 작업을 할 수 없습니다.',
  selfResetNotAllowed: '본인 비밀번호는 보안 설정에서 변경해주세요.',
  authStateChanged: '계정 상태가 변경되었습니다. 다시 로그인해주세요.',
  targetStateChanged: '사용자 상태가 변경되었습니다. 다시 확인해주세요.',
  duplicateUsername: '이미 사용 중인 아이디입니다.',
  authTemporarilyUnavailable: '로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.',
  notFound: '사용자를 찾을 수 없습니다.',
  internalError: '서버 오류가 발생했습니다.',
} as const;

export interface IdentityAllowedErrorPair {
  readonly status: number;
  readonly code: string;
  readonly message: string | null;
}

export const identityAllowedErrorPairs = {
  login: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 401, code: 'INVALID_CREDENTIALS', message: identityMessages.loginInvalidCredentials },
    { status: 429, code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts },
    { status: 503, code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: identityMessages.authTemporarilyUnavailable },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  logout: [
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  currentUser: [
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  listUsers: [
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  createUser: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 403, code: 'READ_ONLY_ACCESS', message: identityMessages.readOnlyAccess },
    { status: 409, code: 'DUPLICATE_USERNAME', message: identityMessages.duplicateUsername },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  changeOwnPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 401, code: 'INVALID_CREDENTIALS', message: identityMessages.currentPasswordInvalid },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 409, code: 'AUTH_STATE_CHANGED', message: identityMessages.authStateChanged },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  resetPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 400, code: 'SELF_RESET_NOT_ALLOWED', message: identityMessages.selfResetNotAllowed },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 403, code: 'READ_ONLY_ACCESS', message: identityMessages.readOnlyAccess },
    { status: 404, code: 'NOT_FOUND', message: identityMessages.notFound },
    { status: 409, code: 'TARGET_STATE_CHANGED', message: identityMessages.targetStateChanged },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
} as const satisfies Record<IdentityOperation, readonly IdentityAllowedErrorPair[]>;

type IdentityErrorDefinition<K extends IdentityOperation> =
  (typeof identityAllowedErrorPairs)[K][number];
type IdentityErrorPayload<D> = D extends {
  code: infer C extends string;
  message: infer M;
} ? {
    code: C;
    message: M extends string ? M : string;
  } : never;

export type IdentityErrorByOperation<K extends IdentityOperation> = {
  ok: false;
  error: IdentityErrorPayload<IdentityErrorDefinition<K>>;
};
export type IdentityHttpResponse<K extends IdentityOperation> =
  | { ok: true; data: IdentitySuccessByOperation[K] }
  | IdentityErrorByOperation<K>;

const operationContracts: Record<IdentityOperation, {
  successStatus: number;
  successSchema: RuntimeSchema<unknown>;
}> = {
  login: { successStatus: 200, successSchema: loginResultSchema },
  logout: { successStatus: 200, successSchema: logoutResultSchema },
  currentUser: { successStatus: 200, successSchema: currentUserResultSchema },
  listUsers: { successStatus: 200, successSchema: listUsersResultSchema },
  createUser: { successStatus: 201, successSchema: createUserResultSchema },
  changeOwnPassword: { successStatus: 200, successSchema: passwordMutationResultSchema },
  resetPassword: { successStatus: 200, successSchema: passwordMutationResultSchema },
};

export class IdentityResponseContractError extends Error {
  readonly code = 'INVALID_RESPONSE';

  constructor() {
    super('Identity response contract was invalid.');
    this.name = 'IdentityResponseContractError';
  }
}

export function decodeIdentityHttpResponse<K extends IdentityOperation>(
  operation: K,
  status: number,
  input: unknown,
): IdentityHttpResponse<K> {
  try {
    const contract = operationContracts[operation];
    const envelope = apiEnvelopeSchema(contract.successSchema).parse(input);
    if (envelope.ok) {
      if (status !== contract.successStatus) throw new Error('status mismatch');
    } else {
      const allowed = (identityAllowedErrorPairs[operation] as readonly IdentityAllowedErrorPair[])
        .find((candidate) => (
          candidate.status === status && candidate.code === envelope.error.code
        ));
      if (!allowed || envelope.error.message.trim().length === 0) {
        throw new Error('error mismatch');
      }
      if (allowed.message !== null && envelope.error.message !== allowed.message) {
        throw new Error('message mismatch');
      }
    }
    return envelope as IdentityHttpResponse<K>;
  } catch {
    throw new IdentityResponseContractError();
  }
}

export interface HeaderReader {
  get(name: string): string | null;
}

export interface IdentityHeaderContext {
  secure: boolean;
  sessionCookiePresented: boolean;
}

function assertNewSessionCookie(
  value: string | null,
  secure: boolean,
  exactMaxAge: number | null,
) {
  const match = /^isorder_sid=([^;\s]+); HttpOnly; Path=\/; Max-Age=([1-9]\d*); SameSite=Strict(; Secure)?$/
    .exec(value ?? '');
  if (!match) throw new IdentityResponseContractError();
  const maxAge = Number(match[2]);
  const hasSecure = match[3] !== undefined;
  if (hasSecure !== secure
    || !Number.isSafeInteger(maxAge)
    || (exactMaxAge === null
      ? maxAge < 1 || maxAge > SESSION_SECONDS
      : maxAge !== exactMaxAge)) {
    throw new IdentityResponseContractError();
  }
}

export function assertIdentityResponseHeaders<K extends IdentityOperation>(
  operation: K,
  status: number,
  envelope: IdentityHttpResponse<K>,
  headers: HeaderReader,
  context: IdentityHeaderContext,
): void {
  const decoded = decodeIdentityHttpResponse(operation, status, envelope);
  if (headers.get('cache-control') !== 'no-store') {
    throw new IdentityResponseContractError();
  }

  const retryAfter = !decoded.ok
    && operation === 'login'
    && decoded.error.code === 'TOO_MANY_ATTEMPTS'
    ? '60'
    : null;
  if (headers.get('retry-after') !== retryAfter) {
    throw new IdentityResponseContractError();
  }

  const cookie = headers.get('set-cookie');
  if (decoded.ok && operation === 'login') {
    assertNewSessionCookie(cookie, context.secure, SESSION_SECONDS);
    return;
  }
  if (decoded.ok && operation === 'changeOwnPassword') {
    assertNewSessionCookie(cookie, context.secure, null);
    return;
  }

  const mustClear = (decoded.ok && operation === 'logout')
    || (!decoded.ok && decoded.error.code === 'AUTH_STATE_CHANGED')
    || (!decoded.ok
      && decoded.error.code === 'UNAUTHORIZED'
      && context.sessionCookiePresented);
  const mayClear = !decoded.ok
    && decoded.error.code === 'UNAUTHORIZED'
    && !context.sessionCookiePresented;
  const secureSuffix = context.secure ? '; Secure' : '';
  const clearCookie = `isorder_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secureSuffix}`;
  if (mustClear) {
    if (cookie !== clearCookie) {
      throw new IdentityResponseContractError();
    }
    return;
  }
  if (mayClear) {
    if (cookie !== null && cookie !== clearCookie) {
      throw new IdentityResponseContractError();
    }
    return;
  }
  if (cookie !== null) throw new IdentityResponseContractError();
}
```

Modify the complete package manifest to add the public export and its dedicated compiler command:

```json
{
  "name": "@here-is-order/http-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "exports": {
    "./envelope": "./src/envelope.ts",
    "./identity": "./src/identity.ts",
    "./purchase-orders": "./src/purchase-orders.ts"
  },
  "dependencies": {
    "zod": "3.24.1"
  }
}
```

Create `packages/http-contract/tsconfig.json` so the new package is typechecked even before the Worker or frontend adopts it:

```json
{
  "extends": "../../tsconfig.json",
  "include": [
    "src/**/*.ts",
    "../../test/identity-http-contract.test.ts"
  ],
  "exclude": ["../../node_modules"]
}
```

- [ ] **Step 4: Run contract tests and package consumers**

Run:

```bash
set -euo pipefail
npm exec -- vitest run test/identity-http-contract.test.ts test/http-contract.test.ts
npm --prefix packages/http-contract run typecheck
npm run typecheck
npm run build
npm --prefix frontend run build
```

Expected: all five commands PASS. The focused test resolves the package specifier, and the dedicated compiler includes every `packages/http-contract/src/**/*.ts` file plus the compile-time `expectTypeOf` assertions in `test/identity-http-contract.test.ts`. `src/index.ts` and frontend remain unmodified consumers.

- [ ] **Step 5: Commit the portable target contract**

```bash
git add packages/http-contract/package.json packages/http-contract/src/identity.ts \
  packages/http-contract/tsconfig.json test/identity-http-contract.test.ts
git commit -m "feat: add identity HTTP contract"
```

---

### Task 3: Add the fixed compatibility aggregate and strict result model

**Files:**

- Create: `scripts/sql/identity-compatibility-v1.sql`
- Create: `test/identity-compatibility.integration.test.ts`
- Create: `scripts/identity-compatibility-audit.mjs`
- Create: `scripts/identity-compatibility-audit.test.mjs`

**Interfaces:**

- Consumes: the existing D1 schema and `createCloudflareD1RestClient` result shape.
- Produces: `IDENTITY_COMPATIBILITY_AUDIT_VERSION`, `IDENTITY_COMPATIBILITY_SQL`, `assertReadOnlyIdentityAuditSql`, `parseIdentityCompatibilityResult`, `buildIdentityCompatibilityReport`, `identityCompatibilityGatePassed`, and `renderIdentityCompatibilitySummary`.

- [ ] **Step 1: Write failing SQL and report tests**

Create `test/identity-compatibility.integration.test.ts` using `import auditSql from '../scripts/sql/identity-compatibility-v1.sql?raw'`. Its tests must:

```ts
const currentHash = `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const legacyHash = 'c'.repeat(64);

// clean active PBKDF2 + inactive legacy => 1/0/0
expect(await runAudit()).toEqual({
  legacy_password_hash_count: 1,
  unsupported_password_hash_count: 0,
  invalid_identity_projection_count: 0,
});

// deleted rows do not affect any count
// uppercase SHA, PBKDF2 99999/600000, wrong salt/digest lengths,
// extra segments, unknown scheme, BLOB and NULL-like malformed values each add 1 unsupported.
// id <= 0, ECMAScript-edge whitespace around username/name, empty/over-limit fields,
// non-admin/staff role, non-integer/out-of-range is_active, and non-round-trip created_at
// each add 1 invalid projection without exposing the row.
```

Use `PRAGMA ignore_check_constraints = ON` only around the invalid-role fixture, restore it immediately, and reset `sessions`, `audit_logs`, and `users` before every case. Do not add a migration or weaken a production constraint.

Create `scripts/identity-compatibility-audit.test.mjs` with exact rows:

```js
const cleanRow = {
  audit_version: 'identity-compatibility-v1',
  legacy_password_hash_count: 3,
  unsupported_password_hash_count: 0,
  invalid_identity_projection_count: 0,
};
const cleanEnvelope = [{ success: true, results: [cleanRow], meta: {} }];

assert.deepEqual(parseIdentityCompatibilityResult(cleanEnvelope), cleanRow);
assert.deepEqual(buildIdentityCompatibilityReport({
  row: cleanRow,
  executedAt: '2026-07-15T12:34:56.000Z',
  gitSha: 'a'.repeat(40),
  requestId: '123e4567-e89b-42d3-a456-426614174000',
}), {
  auditVersion: 'identity-compatibility-v1',
  executedAt: '2026-07-15T12:34:56.000Z',
  gitSha: 'a'.repeat(40),
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  legacyPasswordHashCount: 3,
  unsupportedPasswordHashCount: 0,
  invalidIdentityProjectionCount: 0,
  outcome: 'verified',
});
```

Add table cases that reject missing/extra rows, missing/extra row fields, booleans, numeric strings, negative/non-safe counts, wrong version, malformed ISO/SHA/UUID, extra report fields, mutation/multiple SQL statements, inherited/enumerable property tricks, and any rendered field-order change.

- [ ] **Step 2: Run focused tests and verify both missing-file failures**

Run:

```bash
node --test scripts/identity-compatibility-audit.test.mjs
npm exec -- vitest run test/identity-compatibility.integration.test.ts
```

Expected: both commands FAIL because the audit module and SQL file do not exist.

- [ ] **Step 3: Implement the exact aggregate SQL**

Create `scripts/sql/identity-compatibility-v1.sql` as one statement. The explicit trim character set mirrors ECMAScript whitespace/line terminators instead of relying on SQLite's space-only default trim.

```sql
WITH constants AS (
  SELECT char(
    9, 10, 11, 12, 13, 32, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279
  ) AS trim_chars
), classified AS (
  SELECT
    CASE
      WHEN typeof(password_hash) = 'text'
       AND length(password_hash) = 64
       AND password_hash NOT GLOB '*[^0-9a-f]*'
      THEN 1 ELSE 0
    END AS is_legacy_hash,
    CASE
      WHEN typeof(password_hash) = 'text'
       AND length(password_hash) = 118
       AND substr(password_hash, 1, 21) = 'pbkdf2_sha256$100000$'
       AND substr(password_hash, 22, 32) NOT GLOB '*[^0-9a-f]*'
       AND substr(password_hash, 54, 1) = '$'
       AND substr(password_hash, 55, 64) NOT GLOB '*[^0-9a-f]*'
      THEN 1 ELSE 0
    END AS is_current_hash,
    CASE
      WHEN typeof(id) <> 'integer' OR id <= 0
        OR typeof(username) <> 'text'
        OR username <> trim(username, trim_chars)
        OR length(username) < 1 OR length(username) > 128
        OR typeof(name) <> 'text'
        OR name <> trim(name, trim_chars)
        OR length(name) < 1 OR length(name) > 200
        OR typeof(role) <> 'text' OR role NOT IN ('admin', 'staff')
        OR typeof(is_active) <> 'integer' OR is_active NOT IN (0, 1)
        OR typeof(created_at) <> 'text' OR length(created_at) <> 19
        OR strftime('%Y-%m-%d %H:%M:%S', created_at) IS NULL
        OR strftime('%Y-%m-%d %H:%M:%S', created_at) <> created_at
      THEN 1 ELSE 0
    END AS is_invalid_projection
  FROM users
  CROSS JOIN constants
  WHERE is_deleted = 0
)
SELECT
  'identity-compatibility-v1' AS audit_version,
  COALESCE(SUM(is_legacy_hash), 0) AS legacy_password_hash_count,
  COALESCE(SUM(CASE WHEN is_legacy_hash = 0 AND is_current_hash = 0 THEN 1 ELSE 0 END), 0)
    AS unsupported_password_hash_count,
  COALESCE(SUM(is_invalid_projection), 0) AS invalid_identity_projection_count
FROM classified;
```

- [ ] **Step 4: Implement the pure decoder and evidence model**

In `scripts/identity-compatibility-audit.mjs`, load the SQL only from the fixed URL and implement the exported functions with these exact keys:

```js
export const IDENTITY_COMPATIBILITY_AUDIT_VERSION = 'identity-compatibility-v1';
export const IDENTITY_COMPATIBILITY_SQL = fs.readFileSync(
  new URL('./sql/identity-compatibility-v1.sql', import.meta.url),
  'utf8',
);
const QUERY_FIELDS = [
  'audit_version',
  'legacy_password_hash_count',
  'unsupported_password_hash_count',
  'invalid_identity_projection_count',
];
const REPORT_FIELDS = [
  'auditVersion',
  'executedAt',
  'gitSha',
  'requestId',
  'legacyPasswordHashCount',
  'unsupportedPasswordHashCount',
  'invalidIdentityProjectionCount',
  'outcome',
];
```

`assertReadOnlyIdentityAuditSql(sql)` must remove comments/string literals, require exactly one `WITH|SELECT` statement, and reject `INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER` outside string literals. `parseIdentityCompatibilityResult(results)` requires one successful D1 result and one exact row. `buildIdentityCompatibilityReport(...)` creates a new object in `REPORT_FIELDS` order and freezes it. `identityCompatibilityGatePassed(report)` returns true only when unsupported and invalid-projection counts are both zero. `renderIdentityCompatibilitySummary(report)` returns only:

```js
`## Identity compatibility audit\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
```

- [ ] **Step 5: Run the SQL/model tests and commit**

Run:

```bash
set -euo pipefail
node --test scripts/identity-compatibility-audit.test.mjs
npm exec -- vitest run test/identity-compatibility.integration.test.ts
```

Expected: both PASS; the fixture containing one legacy and one current hash returns `1/0/0`.

```bash
git add scripts/sql/identity-compatibility-v1.sql \
  scripts/identity-compatibility-audit.mjs \
  scripts/identity-compatibility-audit.test.mjs \
  test/identity-compatibility.integration.test.ts
git commit -m "feat: add identity compatibility audit"
```

---

### Task 4: Add the zero-input production adapter and protected workflow

**Files:**

- Modify: `scripts/identity-compatibility-audit.mjs`
- Modify: `scripts/identity-compatibility-audit.test.mjs`
- Create: `.github/workflows/audit-identity-compatibility.yml`
- Create: `scripts/identity-compatibility-workflow.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `createCloudflareD1RestClient`, `readProductionD1Binding`, the fixed SQL/result/report functions from Task 3, and the `DB` binding in `wrangler.toml`.
- Produces: `parseIdentityCompatibilityEnvironment`, `assertIdentityCompatibilityRemoteTarget`, `runIdentityCompatibilityAudit(deps = {})`, and `npm run db:audit:identity-compatibility` with zero arguments.

- [ ] **Step 1: Add failing environment/orchestration tests**

Extend `scripts/identity-compatibility-audit.test.mjs` with a valid environment containing only:

```js
const validEnvironment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_STEP_SUMMARY: '/tmp/identity-summary.md',
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
  CLOUDFLARE_D1_READ_TOKEN: 'dedicated-read-token',
};
```

Prove each missing/extra-sensitive credential variant fails before config read/client creation; argv is empty; binding is exactly `DB/hereisorder/<UUID>`; exact-name lookup returns exactly that name/id; query is called once with `{ sql: IDENTITY_COMPATIBILITY_SQL }`; report time/SHA/UUID are injected; summary then one-line JSON are the only outputs; dependency failures become `Identity compatibility audit failed.` without raw detail. A positive unsupported/projection count may emit the same safe eight-field report but must return `gatePassed: false`, causing the CLI to exit nonzero.

- [ ] **Step 2: Add a failing canonical workflow safety test**

Create `scripts/identity-compatibility-workflow.test.mjs` using the repository's `yaml` parser pattern. It must require the exact top-level keys `name,on,permissions,concurrency,jobs`, plain duplicate-free YAML, no dispatch inputs, the shared non-cancelling production concurrency, pinned action SHAs, Node `22.23.1`, `npm ci`, a one-line exact `git rev-parse HEAD`/`GITHUB_SHA` equality check, and one fixed package command. It must reject any occurrence of deploy-token fallback, `CLOUDFLARE_API_TOKEN`, user-controlled input, arbitrary SQL, direct Wrangler, artifacts, outputs, multiline shell, `continue-on-error`, `always()`, `failure()`, or `|| true`.

Run:

```bash
node --test scripts/identity-compatibility-audit.test.mjs \
  scripts/identity-compatibility-workflow.test.mjs
```

Expected: FAIL because orchestration exports and workflow do not exist.

- [ ] **Step 3: Implement the zero-input adapter**

In `runIdentityCompatibilityAudit`, perform this exact order:

```js
if (argv.length !== 0) throw new Error('invalid arguments');
const environment = parseIdentityCompatibilityEnvironment(env);
const binding = readBinding({ configPath, binding: 'DB' });
assertExactBinding(binding); // DB, hereisorder, canonical UUID
const client = createClient({
  accountId: environment.accountId,
  apiToken: environment.readToken,
});
assertIdentityCompatibilityRemoteTarget(
  await client.listDatabasesByExactName('hereisorder'),
  binding,
);
assertReadOnlyIdentityAuditSql(IDENTITY_COMPATIBILITY_SQL);
const row = parseIdentityCompatibilityResult(await client.query(
  binding.databaseId,
  { sql: IDENTITY_COMPATIBILITY_SQL },
));
const report = buildIdentityCompatibilityReport({
  row,
  executedAt: now().toISOString(),
  gitSha: environment.gitSha,
  requestId: randomUUID(),
});
await appendSummary(environment.summaryPath, renderIdentityCompatibilitySummary(report));
await log(JSON.stringify(report));
return Object.freeze({
  report,
  gatePassed: identityCompatibilityGatePassed(report),
});
```

The CLI calls this function once. It sets `process.exitCode = 1` for `gatePassed: false`; on any thrown failure it prints only `Identity compatibility audit failed.` and sets exit code 1. It never prints the target lookup or query envelope.

Add the exact root script:

```json
"db:audit:identity-compatibility": "node scripts/identity-compatibility-audit.mjs"
```

- [ ] **Step 4: Implement the exact workflow**

Create `.github/workflows/audit-identity-compatibility.yml`:

```yaml
name: Audit production identity compatibility

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: hereisorder-production-${{ github.ref }}
  cancel-in-progress: false
  queue: max

jobs:
  audit:
    name: Run fixed identity compatibility audit
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Reject a non-main ref
        if: github.ref != 'refs/heads/main'
        run: exit 1

      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false

      - name: Verify exact checked-out SHA
        run: test "$(git rev-parse HEAD)" = "$GITHUB_SHA"

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: '22.23.1'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Audit production identity compatibility
        run: npm run db:audit:identity-compatibility
        env:
          CI: 'true'
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_D1_READ_TOKEN: ${{ secrets.CLOUDFLARE_D1_READ_TOKEN }}
```

- [ ] **Step 5: Run workflow and CLI contract tests, then commit**

Run:

```bash
set -euo pipefail
node --test scripts/identity-compatibility-audit.test.mjs \
  scripts/identity-compatibility-workflow.test.mjs
npm test
```

Expected: all tests PASS and no test output contains fixture token, account id, database id, row data, or raw failure strings.

```bash
git add package.json scripts/identity-compatibility-audit.mjs \
  scripts/identity-compatibility-audit.test.mjs \
  scripts/identity-compatibility-workflow.test.mjs \
  .github/workflows/audit-identity-compatibility.yml
git commit -m "ci: add identity compatibility gate"
```

---

### Task 5: Lock the runbook and pass the complete repository gate

**Files:**

- Create: `scripts/identity-compatibility-docs.test.mjs`
- Modify: `docs/design/cloudflare-deploy-guide.md`
- Modify: `docs/design/implementation-checklist-v1.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the fixed workflow filename, eight-field report, dedicated read secret, and Wave 2B zero-count entry rule.
- Produces: an operator procedure with no ad hoc SQL or broad-token fallback.

- [ ] **Step 1: Write the failing documentation contract**

Create `scripts/identity-compatibility-docs.test.mjs` with file-specific contracts. Provide an `assertInOrder(text, markers)` helper and an `extractH2(text, heading)` helper that returns only the bounded H2 section or throws. Enforce these scopes rather than requiring every marker in every document:

```js
const deployGuideRequired = [
  'CLOUDFLARE_D1_READ_TOKEN',
  'audit-identity-compatibility.yml',
  'identity-compatibility-v1',
  'auditVersion',
  'executedAt',
  'gitSha',
  'requestId',
  'legacyPasswordHashCount',
  'unsupportedPasswordHashCount',
  'invalidIdentityProjectionCount',
  'outcome',
  'unsupportedPasswordHashCount = 0',
  'invalidIdentityProjectionCount = 0',
  'Wave 2B',
];

const checklistRequired = [
  'CLOUDFLARE_D1_READ_TOKEN',
  'merge',
  'deploy',
  'exact main SHA',
  'audit-identity-compatibility.yml',
  'unsupportedPasswordHashCount = 0',
  'invalidIdentityProjectionCount = 0',
  'Wave 2B',
];

const readmeRequired = [
  'audit-identity-compatibility.yml',
  'zero-count gate',
  'docs/design/cloudflare-deploy-guide.md#identity-compatibility-audit',
];
```

Apply `deployGuideRequired` only to the bounded `## Identity compatibility audit` section and require its marker order. Apply `checklistRequired` only to the new Wave 2A checklist subsection. Require README to contain only the short `readmeRequired` entry, not a duplicate eight-field runbook. In the bounded deployment section, reject `wrangler d1`, `SELECT`, `--command`, `--file`, `actions/upload-artifact`, a `${{ secrets.CLOUDFLARE_API_TOKEN }}` fallback, and example token values.

Extract the section's first shell fence as `secretInstallBlock`; after blank/comment lines are removed, require its first executable line to equal `set +x`, and require these later lines in order:

```bash
set -euo pipefail
IFS= read -r -s D1_READ_TOKEN
printf '%s' "$D1_READ_TOKEN" | gh secret set CLOUDFLARE_D1_READ_TOKEN --repo AllStuff-agit/Here-is-order
unset D1_READ_TOKEN
```

The test rejects `echo`, a token value in argv, a missing `unset`, or a provisioning block that lacks `set +x`. This makes the copyable path safe even if the operator entered the shell with xtrace enabled.

Run: `node --test scripts/identity-compatibility-docs.test.mjs`

Expected: FAIL because the runbook section is not present.

- [ ] **Step 2: Document provisioning, dispatch, evidence, and failure**

Add a `## Identity compatibility audit` section to `docs/design/cloudflare-deploy-guide.md` with this exact operational order:

1. Create a Cloudflare API token scoped only to this account and production D1 read access; do not reuse `CLOUDFLARE_API_TOKEN`.
2. Install it without shell tracing or argv exposure. The only copyable secret-install fence is:

   ```bash
   set +x
   set -euo pipefail
   IFS= read -r -s D1_READ_TOKEN
   printf '%s' "$D1_READ_TOKEN" | gh secret set CLOUDFLARE_D1_READ_TOKEN --repo AllStuff-agit/Here-is-order
   unset D1_READ_TOKEN
   ```

3. Confirm `gh secret list --repo AllStuff-agit/Here-is-order` contains the secret name; never print its value.
4. Dispatch only `gh workflow run audit-identity-compatibility.yml --ref main --repo AllStuff-agit/Here-is-order`.
5. Require a successful exact-main run and exactly one eight-field JSON report.
6. Require `unsupportedPasswordHashCount = 0` and `invalidIdentityProjectionCount = 0`; `legacyPasswordHashCount` may be nonzero.
7. If the run, exact report, SHA, or zero-count gate fails, do not start Wave 2B. Do not query rows in Actions; use a separately approved private remediation procedure.

Update `docs/design/implementation-checklist-v1.md` with unchecked 2A PR/production-evidence items, and add a short README link. Do not claim the audit has run until Task 6 succeeds.

- [ ] **Step 3: Run documentation and full verification**

Run the documentation test first, then the exact repository gate:

```bash
set -euo pipefail
export PATH=/home/ubuntu/.nvm/versions/node/v22.23.1/bin:$PATH
node --test scripts/identity-compatibility-docs.test.mjs
npm test
npm run typecheck
npm --prefix packages/http-contract run typecheck
npm --prefix frontend test
npm run web:lint
npm run web:build
npm run build
npm --prefix frontend run build:cloudflare
```

Expected:

- documentation test PASS;
- all Node and Vitest suites PASS with zero failures/skips;
- root and portable-contract TypeScript plus ESLint exit 0;
- Next.js production build lists all expected routes;
- Worker dry-run exits without deployment;
- OpenNext ends with `OpenNext build complete.`.

- [ ] **Step 4: Review the slice against the no-runtime-change boundary**

Run:

```bash
set -euo pipefail
git diff --name-only 6e3554a...HEAD
git diff --check 6e3554a...HEAD
git status --short
if git diff --name-only 6e3554a...HEAD \
  | rg -q '^(src/|migrations/|db/schema\.sql$|wrangler\.toml$|frontend/(app|components|hooks|lib)/)'; then
  echo 'Wave 2A no-runtime-change boundary violated' >&2
  exit 1
fi
```

Expected: only the files listed in this plan, this plan document, and the approved-spec status line changed; the explicit boundary assertion exits 0; diff check is silent; worktree contains no uncommitted source change.

Request two independent reviews:

- contract review: route/status/error/type/limit coverage against design sections 5.2, 5.5, 9, and 13.1;
- delivery review: SQL classification, redaction, workflow secret scope, exact evidence, and 2B entry against sections 10.3, 13.7, and 14/2A.

Resolve every blocking finding and rerun the affected focused test plus the full gate.

- [ ] **Step 5: Commit the runbook**

```bash
git add README.md docs/design/cloudflare-deploy-guide.md \
  docs/design/implementation-checklist-v1.md \
  scripts/identity-compatibility-docs.test.mjs
git commit -m "docs: document identity compatibility gate"
```

---

### Task 6: Merge, deploy, and produce the Wave 2B entry evidence

**Files:** none; GitHub and production are the evidence systems.

**Interfaces:**

- Consumes: a clean verified feature branch, repository PR checks, the normal `main` deployment workflow, and the dedicated D1 read secret.
- Produces: the exact deployed main SHA plus one successful `identity-compatibility-v1` report with both required zero counts.
- Preserves: the workflow's built-in `github.token` pre-audit and post-audit live-main guards, plus a fresh live-main equality check immediately before Wave 2B consumes the report.

- [ ] **Step 1: Push the feature branch and open the PR**

```bash
set -euo pipefail
git status --short
test -z "$(git status --short)"
pr_body=$'## Summary\n- characterize current Identity compatibility without runtime changes\n- add the executable Identity HTTP contract\n- add a fixed read-only identity compatibility workflow\n- record current/target differences in docs/design/api-spec-v1.md#Wave-2-전환-red-matrix\n\n## Verification\n- npm test — PASS\n- npm run typecheck — PASS\n- npm --prefix packages/http-contract run typecheck — PASS\n- npm --prefix frontend test — PASS\n- npm run web:lint — PASS\n- npm run web:build — PASS\n- npm run build — PASS\n- npm --prefix frontend run build:cloudflare — PASS\n\n## Delivery\n- DB/migration/runtime behavior change: none\n- recovery: code rollback is safe\n- Wave 2B remains blocked until the exact-main identity-compatibility-v1 report has unsupportedPasswordHashCount=0 and invalidIdentityProjectionCount=0\n- dedicated prerequisite: CLOUDFLARE_D1_READ_TOKEN'
git push -u origin HEAD
gh pr create --repo AllStuff-agit/Here-is-order \
  --base main \
  --title "feat: add Wave 2A identity compatibility gate" \
  --body "$pr_body"
```

Create the PR only after Task 5 produced the eight PASS results shown in `pr_body`; do not include raw logs, credentials, row data, or production identifiers.

- [ ] **Step 2: Require reviewed green checks and merge**

```bash
set -euo pipefail
pr_number="$(gh pr view --repo AllStuff-agit/Here-is-order --json number --jq '.number')"
gh pr checks "$pr_number" --repo AllStuff-agit/Here-is-order --watch
head_sha="$(git rev-parse HEAD)"
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]
gh pr merge "$pr_number" --repo AllStuff-agit/Here-is-order \
  --squash --match-head-commit "$head_sha"
merge_sha="$(gh pr view "$pr_number" --repo AllStuff-agit/Here-is-order \
  --json mergeCommit --jq '.mergeCommit.oid')"
[[ "$merge_sha" =~ ^[0-9a-f]{40}$ ]]
```

Expected: all required checks pass, the reviewed head cannot change between checks and merge, and `merge_sha` is an exact lowercase 40-character SHA. Do not use `--delete-branch` while the branch is checked out by the linked worktree; branch cleanup occurs only after production evidence and worktree removal.

- [ ] **Step 3: Require the normal production deployment for the merge SHA**

Poll GitHub's eventually consistent run index for the unique push run at `merge_sha`, then revalidate its metadata before watching it:

```bash
set -euo pipefail
pr_number="$(gh pr view --repo AllStuff-agit/Here-is-order --json number --jq '.number')"
merge_sha="$(gh pr view "$pr_number" --repo AllStuff-agit/Here-is-order \
  --json mergeCommit --jq '.mergeCommit.oid')"
[[ "$merge_sha" =~ ^[0-9a-f]{40}$ ]]
deploy_candidates='[]'
for attempt in $(seq 1 30); do
  deploy_candidates="$(gh run list --repo AllStuff-agit/Here-is-order \
    --workflow deploy-worker.yml --event push --commit "$merge_sha" \
    --limit 20 --json databaseId,headSha,event,workflowName \
    | jq --arg sha "$merge_sha" \
      '[.[] | select(.headSha == $sha and .event == "push" and .workflowName == "Verify and deploy")]')"
  deploy_count="$(printf '%s' "$deploy_candidates" | jq 'length')"
  test "$deploy_count" -le 1
  test "$deploy_count" -eq 0 || break
  test "$attempt" -eq 30 || sleep 2
done
test "$deploy_count" -eq 1
deploy_run_id="$(printf '%s' "$deploy_candidates" | jq -r '.[0].databaseId')"
deploy_metadata="$(gh run view "$deploy_run_id" \
  --repo AllStuff-agit/Here-is-order --json headSha,event,workflowName)"
printf '%s' "$deploy_metadata" | jq -e --arg sha "$merge_sha" \
  '.headSha == $sha and .event == "push" and .workflowName == "Verify and deploy"' >/dev/null
gh run watch "$deploy_run_id" --repo AllStuff-agit/Here-is-order --exit-status
```

Expected: indexing may take up to 60 seconds, but exactly one matching run is selected. Zero or multiple candidates fail closed. Verify, remote rollback contract, recovery checkpoint, API deploy/readiness, web deploy/proxy, and authenticated business smoke all succeed for `merge_sha`.

- [ ] **Step 4: Stop if the dedicated read secret is absent**

```bash
set -euo pipefail
secret_matches="$(gh secret list --repo AllStuff-agit/Here-is-order \
  | awk '$1 == "CLOUDFLARE_D1_READ_TOKEN" { count += 1 } END { print count + 0 }')"
test "$secret_matches" -eq 1
```

Expected: exactly one secret name exists. If absent, install the least-privilege token through the documented stdin procedure; do not substitute the deployment token.

- [ ] **Step 5: Dispatch and verify the exact compatibility report**

```bash
set -euo pipefail
pr_number="$(gh pr view --repo AllStuff-agit/Here-is-order --json number --jq '.number')"
merge_sha="$(gh pr view "$pr_number" --repo AllStuff-agit/Here-is-order \
  --json mergeCommit --jq '.mergeCommit.oid')"
[[ "$merge_sha" =~ ^[0-9a-f]{40}$ ]]
remote_main_sha="$(gh api repos/AllStuff-agit/Here-is-order/git/ref/heads/main \
  --jq '.object.sha')"
test "$remote_main_sha" = "$merge_sha"
dispatch_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
audit_dispatch_output="$(gh workflow run audit-identity-compatibility.yml \
  --ref main --repo AllStuff-agit/Here-is-order)"
audit_run_id="$(printf '%s\n' "$audit_dispatch_output" \
  | sed -nE 's#^.*/actions/runs/([0-9]+)$#\1#p')"
if test -n "$audit_dispatch_output" && test -z "$audit_run_id"; then
  echo 'Unexpected workflow dispatch output' >&2
  exit 1
fi

if test -z "$audit_run_id"; then
  audit_candidates='[]'
  for attempt in $(seq 1 30); do
    audit_candidates="$(gh run list --repo AllStuff-agit/Here-is-order \
      --workflow audit-identity-compatibility.yml --event workflow_dispatch \
      --limit 50 --json databaseId,headSha,event,workflowName,createdAt \
      | jq --arg sha "$merge_sha" --arg boundary "$dispatch_started_at" \
        '[.[] | select(.headSha == $sha and .event == "workflow_dispatch" and .workflowName == "Audit production identity compatibility" and .createdAt >= $boundary)]')"
    audit_count="$(printf '%s' "$audit_candidates" | jq 'length')"
    test "$audit_count" -le 1
    test "$audit_count" -eq 0 || break
    test "$attempt" -eq 30 || sleep 2
  done
  test "$audit_count" -eq 1
  audit_run_id="$(printf '%s' "$audit_candidates" | jq -r '.[0].databaseId')"
fi

audit_metadata=''
for attempt in $(seq 1 30); do
  audit_metadata="$(gh run view "$audit_run_id" \
    --repo AllStuff-agit/Here-is-order \
    --json headSha,event,workflowName,createdAt 2>/dev/null || true)"
  test -z "$audit_metadata" || break
  test "$attempt" -eq 30 || sleep 2
done
test -n "$audit_metadata"
printf '%s' "$audit_metadata" \
  | jq -e --arg sha "$merge_sha" --arg boundary "$dispatch_started_at" \
    '.headSha == $sha and .event == "workflow_dispatch" and .workflowName == "Audit production identity compatibility" and .createdAt >= $boundary' >/dev/null
gh run watch "$audit_run_id" --repo AllStuff-agit/Here-is-order --exit-status
audit_report_matches="$(gh run view "$audit_run_id" \
  --repo AllStuff-agit/Here-is-order --log \
  | rg -o "\{\"auditVersion\":\"identity-compatibility-v1\",\"executedAt\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z\",\"gitSha\":\"$merge_sha\",\"requestId\":\"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\",\"legacyPasswordHashCount\":[0-9]+,\"unsupportedPasswordHashCount\":0,\"invalidIdentityProjectionCount\":0,\"outcome\":\"verified\"\}")"
test "$(printf '%s\n' "$audit_report_matches" | sed '/^$/d' | wc -l)" -eq 1
remote_main_after_audit="$(gh api repos/AllStuff-agit/Here-is-order/git/ref/heads/main \
  --jq '.object.sha')"
test "$remote_main_after_audit" = "$merge_sha"
```

Expected: dispatch happens exactly once. A returned URL is validated; if no URL is returned, bounded discovery selects exactly one run created after the recorded UTC boundary. Zero/multiple candidates, metadata mismatch, a moved `main` before dispatch, inside the workflow's pre/post audit guards, or after report extraction, and any nonzero gate all fail closed and never trigger a second dispatch. The successful exact-SHA run emits exactly one valid report. Do not retain raw run logs as repository artifacts.

- [ ] **Step 6: Mark the 2A gate complete and hand off to a new 2B plan**

Before consuming the report as Wave 2B entry evidence, re-read live remote `main` and require the same merge SHA:

```bash
set -euo pipefail
pr_number="$(gh pr view --repo AllStuff-agit/Here-is-order --json number --jq '.number')"
merge_sha="$(gh pr view "$pr_number" --repo AllStuff-agit/Here-is-order \
  --json mergeCommit --jq '.mergeCommit.oid')"
[[ "$merge_sha" =~ ^[0-9a-f]{40}$ ]]
wave2b_main_sha="$(gh api repos/AllStuff-agit/Here-is-order/git/ref/heads/main \
  --jq '.object.sha')"
test "$wave2b_main_sha" = "$merge_sha"
```

The Wave 2B plan must repeat this exact check before consuming the report.

Update only the working plan/checklist state used by the agent. Do not retroactively place production values or run URLs in source documentation. Invoke `superpowers:finishing-a-development-branch`, remove the linked worktree, and only then delete the merged local/remote feature branch. Create the Wave 2B implementation plan from the merged `main` tree, using the approved design and the zero-count report as its entry evidence only after the fresh equality check passes.
