# Wave 2B Portable Credential and Runtime Identity Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the current production credential, user, and raw-session choreography into a portable credential package and one deep Runtime Identity Module without changing public HTTP behavior, cookie semantics, D1 schema, or stored session format.

**Architecture:** A runtime-neutral `@here-is-order/identity-credential` package owns the exact legacy/current stored-hash allowlist and credential orchestration through injected Node and Worker crypto adapters. A D1-specific `src/identity/index.ts` factory owns current Identity intents and SQL directly—there is no generic repository—while `src/index.ts` remains the Hono HTTP adapter for current parsing, public error mapping, cookies, context attachment, and `waitUntil` scheduling. General business tests authenticate through a shared Identity fixture instead of inserting session rows directly.

**Tech Stack:** TypeScript 5.6, JavaScript ESM, Hono 4.12, Cloudflare Workers Web Crypto, Node.js 22.23.1 `node:crypto`, Cloudflare D1, Vitest/Miniflare, Node test runner, npm file dependencies.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-15-wave-2-identity-session-deep-module-design.md`; this plan implements only delivery slice 2B.
- The implementation branch starts from exact live `origin/main` SHA `b6a416e34acb6aa980de9dafcb33ac10b1ad8878`.
- The exact-main `identity-compatibility-v1` entry gate has already produced `unsupportedPasswordHashCount = 0` and `invalidIdentityProjectionCount = 0`; live remote `main` must still equal the baseline immediately before implementation begins.
- Preserve every checked-in Wave 2A characterization. Do not change current public messages, status codes, JSON coercion, field limits, password minimums, cookie clearing, or route protection.
- Preserve the exact 30-day absolute session lifetime, D1 `unixepoch()` expiry decisions, raw UUID session token in `sessions.token`, and no sliding extension.
- Preserve current self-password behavior: keep the presented token, revoke only sibling sessions, and emit no replacement `Set-Cookie`.
- Preserve current logout behavior: a valid authenticated context is required; delete and audit remain one D1 batch; invalid presented cookies are not newly cleared.
- Preserve current user creation and password-setter minimum of six JavaScript string code units. The 12-code-point policy, strict request body limits, and input non-coercion belong to 2C.
- Preserve current missing/inactive-account and wrong-password message/work differences. Equalized one-SHA/one-PBKDF2 verification, limiters, new telemetry, and unified public denial belong to 2C.
- Preserve the observed-hash predicate, statement order, `changes()` guard, session issue, success audit, and optional legacy upgrade of the current login batch.
- The exact recognized stored formats are lowercase 64-hex legacy SHA-256 and `pbkdf2_sha256$100000$<32 lowercase hex salt>$<64 lowercase hex digest>`. No other PBKDF2 work factor is accepted by the extracted parser.
- Preserve successful legacy login upgrade to the current PBKDF2/100000 write format.
- Use public projection types from `@here-is-order/http-contract/identity`, but do not activate its future request/header semantics in 2B. Runtime field-limit parsing and `Cache-Control: no-store` expansion remain 2C-owned.
- Public session-user output contains exactly `id`, `username`, `name`, and `role`; public admin-user output adds only `is_active` and `created_at`.
- The internal principal contains `sessionId`, `sessionExpiresAt`, `userId`, `username`, `name`, and `role`. Do not invent `accessMode` before migration 004.
- D1 is a direct Runtime Identity implementation dependency. Do not add generic persistence, clock, UUID, transaction, or audit ports.
- Do not modify `migrations/`, `db/schema.sql`, `wrangler.toml`, readiness versions, runtime bindings, frontend application code, production smoke versions, or deployment workflows.
- Do not add skipped, todo, expected-failure, or deliberately failing 2C regression tests.
- Never emit credentials, password material, hashes, cookies, session rows/tokens, D1 envelopes, or production identifiers into logs, summaries, fixtures, or committed documentation.
- Each implementation task follows RED → GREEN → REFACTOR, ends with focused tests, and produces one reviewable Conventional Commit.
- Recovery is code rollback; this slice contains no schema or production-row mutation outside normal application behavior.

## File Responsibility Map

### Create

- `packages/identity-credential/package.json` — local ESM package metadata and direct JS/type exports.
- `packages/identity-credential/src/index.mjs` — strict stored-hash parser, canonical formatter, credential service, policy metadata, and runtime-neutral byte helpers.
- `packages/identity-credential/src/index.d.ts` — exact public types for the package and crypto adapter.
- `scripts/node-credential-crypto.mjs` — Node `node:crypto` adapter and configured credential service.
- `scripts/identity-credential-conformance.mjs` — one shared known-answer and malformed-envelope corpus.
- `scripts/identity-credential-conformance.test.mjs` — Node adapter execution of the shared corpus.
- `src/identity/worker-credential-crypto.ts` — Web Crypto adapter and configured credential service.
- `test/identity-credential-worker.test.ts` — Worker adapter execution of the same corpus.
- `src/identity/index.ts` — D1-specific Runtime Identity Interface and all current Identity/session SQL choreography.
- `test/identity-runtime.integration.test.ts` — real migrated-D1 intent tests independent of Hono.
- `src/identity/http-cookie.ts` — current Hono cookie parsing and exact set/clear serialization, unchanged in behavior.
- `test/identity-extraction-structure.test.ts` — ownership regression proving Identity SQL/credential logic is absent from Hono routes.
- `test/helpers/identity-fixture.ts` — module-issued authenticated identity for general business HTTP tests.
- `scripts/identity-extraction-docs.test.mjs` — bounded documentation/checklist ownership test.

### Modify

- `package.json`, `package-lock.json` — add `file:packages/identity-credential`.
- `scripts/generate-admin-seed.mjs` and its test — consume the Node credential adapter asynchronously while preserving deterministic salt injection and CLI behavior.
- `scripts/recover-password.mjs`, `scripts/recover-password-core.mjs`, and tests — consume the shared adapter/prefix without changing recovery semantics.
- `scripts/manage-smoke-identity.mjs`, `scripts/smoke-identity-lifecycle.mjs`, and tests — consume the shared adapter/parser without changing lifecycle semantics.
- `test/api.integration.test.ts`, `test/password-recovery.integration.test.ts`, `test/smoke-identity-lifecycle.integration.test.ts` — await the shared hash API and preserve existing assertions.
- `src/index.ts` — delete credential and Identity SQL implementation; call Runtime Identity intents and retain current HTTP mapping.
- `docs/design/api-spec-v1.md` — record that 2B changes implementation ownership only and leaves every red-matrix behavior assigned to its later slice.
- `docs/design/implementation-checklist-v1.md` — add the Wave 2B verification/delivery gate.

### Explicitly Unchanged

- `packages/http-contract/src/identity.ts` and its target-contract tests.
- `migrations/001_init.sql`, `migrations/002_integrity_and_roles.sql`, `db/schema.sql`.
- `src/readiness.ts`, `wrangler.toml`, `test/env.d.ts`.
- `frontend/`.
- `.github/workflows/`.

---

### Task 1: Add the portable credential package and dual-runtime conformance corpus

**Files:**

- Create: `packages/identity-credential/package.json`
- Create: `packages/identity-credential/src/index.mjs`
- Create: `packages/identity-credential/src/index.d.ts`
- Create: `scripts/node-credential-crypto.mjs`
- Create: `scripts/identity-credential-conformance.mjs`
- Create: `scripts/identity-credential-conformance.test.mjs`
- Create: `src/identity/worker-credential-crypto.ts`
- Create: `test/identity-credential-worker.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces:

```ts
export interface IdentityCredentialCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(value: Uint8Array): Uint8Array | Promise<Uint8Array>;
  pbkdf2Sha256(
    value: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
  ): Uint8Array | Promise<Uint8Array>;
}

export type ParsedStoredPasswordHash =
  | Readonly<{ kind: 'legacy_sha256'; digestHex: string }>
  | Readonly<{ kind: 'pbkdf2_sha256'; saltHex: string; digestHex: string }>;

export type PasswordVerification = Readonly<{
  valid: boolean;
  needsUpgrade: boolean;
  upgradedHash: string | null;
}>;

export interface IdentityCredential {
  createPasswordHash(password: string, salt?: Uint8Array): Promise<string>;
  verifyPassword(password: string, storedHash: string): Promise<PasswordVerification>;
}

export const PASSWORD_HASH_SCHEME: 'pbkdf2_sha256';
export const PASSWORD_HASH_ITERATIONS: 100000;
export const PASSWORD_SALT_BYTES: 16;
export const PASSWORD_HASH_BYTES: 32;
export const CURRENT_PASSWORD_HASH_PREFIX: 'pbkdf2_sha256$100000$';
export const passwordPolicies: Readonly<{
  human: Readonly<{ minimumCodePoints: 12; maximumCodePoints: 4096 }>;
  automation: Readonly<{ minimumCodePoints: 32; maximumCodePoints: 4096 }>;
}>;

export function parseStoredPasswordHash(value: unknown): ParsedStoredPasswordHash | null;
export function isCurrentPasswordHash(value: unknown): boolean;
export function createIdentityCredential(crypto: IdentityCredentialCrypto): IdentityCredential;
```

- `scripts/node-credential-crypto.mjs` produces `nodeCredentialCrypto`, `nodeIdentityCredential`, and async `createPasswordHash`.
- `src/identity/worker-credential-crypto.ts` produces `workerCredentialCrypto` and `workerIdentityCredential`.
- `scripts/identity-credential-conformance.mjs` produces immutable `credentialKnownAnswer` and `malformedStoredPasswordHashes`.

- [ ] **Step 1: Write the shared corpus and failing Node/Worker adapter tests**

The shared corpus must contain literal Node/WebCrypto known-answer digests for the password `correct horse battery staple` and salt `00112233445566778899aabbccddeeff`; expected values must not be calculated by the implementation under test.

The malformed corpus must include empty input, uppercase scheme/hex, work factors `99999` and `100001`, wrong salt/digest lengths, extra segments, unknown scheme, and 63-character legacy SHA.

Both runtime tests must assert:

- exact parser classification for current and legacy;
- every malformed case returns `null`;
- deterministic-salt creation equals the literal current hash;
- correct current verification succeeds without upgrade;
- wrong current verification fails without upgrade;
- correct legacy verification succeeds with one canonical upgraded hash;
- wrong legacy verification fails without an upgraded hash;
- generated salt is exactly 16 bytes;
- Node and Worker results equal the same literal corpus.

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
node --test scripts/identity-credential-conformance.test.mjs
npm exec -- vitest run test/identity-credential-worker.test.ts
```

Expected: both fail because `@here-is-order/identity-credential` and the adapters do not exist. A syntax or fixture error is not an acceptable RED.

- [ ] **Step 3: Implement the package and adapters**

`packages/identity-credential/package.json` must be:

```json
{
  "name": "@here-is-order/identity-credential",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.d.ts",
      "import": "./src/index.mjs"
    }
  }
}
```

Implementation rules:

- encode submitted passwords once with `TextEncoder`;
- copy and validate every supplied/generated salt as exactly 16 bytes;
- accept only the two exact regex forms from the global constraints;
- decode hex with exact lowercase-pair validation, never permissive `parseInt` over malformed input;
- compare equal-length lowercase digest strings by accumulating every character difference;
- use the adapter PBKDF2 with exactly 100000 iterations and 32 output bytes;
- current verification derives once and never upgrades;
- legacy verification hashes once; only a valid legacy comparison creates a fresh current hash;
- unsupported stored input returns the frozen invalid result without treating it as legacy;
- return newly frozen result objects; never return password bytes, salt bytes, or derived bytes;
- do not import `node:*`, Cloudflare types, or application files from the portable package.

The Node adapter wraps `randomBytes`, `createHash('sha256')`, and async `pbkdf2`. The Worker adapter wraps `crypto.getRandomValues`, `crypto.subtle.digest`, and `crypto.subtle.deriveBits`.

- [ ] **Step 4: Add the local dependency and refresh only the root lockfile**

Add `"@here-is-order/identity-credential": "file:packages/identity-credential"` to root dependencies.

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
```

Expected: the lockfile contains the package path and a `node_modules/@here-is-order/identity-credential` link; zero vulnerabilities are reported.

- [ ] **Step 5: Verify GREEN and package isolation**

Run:

```bash
node --test scripts/identity-credential-conformance.test.mjs
npm exec -- vitest run test/identity-credential-worker.test.ts
npm run typecheck
```

Expected: both conformance files pass and TypeScript resolves `src/index.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/identity-credential \
  scripts/node-credential-crypto.mjs \
  scripts/identity-credential-conformance.mjs \
  scripts/identity-credential-conformance.test.mjs \
  src/identity/worker-credential-crypto.ts \
  test/identity-credential-worker.test.ts
git commit -m "feat(identity): add portable credential module"
```

---

### Task 2: Move Node credential consumers onto the shared module

**Files:**

- Create: `scripts/identity-credential-ownership.test.mjs`
- Modify: `scripts/generate-admin-seed.mjs`
- Modify: `scripts/generate-admin-seed.test.mjs`
- Modify: `scripts/recover-password.mjs`
- Modify: `scripts/recover-password-core.mjs`
- Modify: `scripts/recover-password-core.test.mjs`
- Modify: `scripts/manage-smoke-identity.mjs`
- Modify: `scripts/smoke-identity-lifecycle.mjs`
- Modify: `scripts/smoke-identity-lifecycle.test.mjs`
- Modify: `test/password-recovery.integration.test.ts`
- Modify: `test/smoke-identity-lifecycle.integration.test.ts`
- Modify: `test/api.integration.test.ts`

**Interfaces:**

- Consumes async `createPasswordHash` and `nodeIdentityCredential` from `scripts/node-credential-crypto.mjs`; consumes `CURRENT_PASSWORD_HASH_PREFIX` and `isCurrentPasswordHash` from the package.
- Preserves deterministic caller-provided salt, current operator validation messages, recovery/lifecycle batches, and exact safe evidence.

- [ ] **Step 1: Add a failing ownership regression**

`scripts/identity-credential-ownership.test.mjs` must assert:

- `scripts/generate-admin-seed.mjs` does not import `node:crypto`;
- `scripts/recover-password.mjs` and `scripts/manage-smoke-identity.mjs` import `node-credential-crypto.mjs`;
- `scripts/recover-password-core.mjs` and `scripts/smoke-identity-lifecycle.mjs` do not declare their own PBKDF2 regex/prefix;
- the fixed compatibility audit SQL may retain its independent versioned literal.

Run `node --test scripts/identity-credential-ownership.test.mjs`.

Expected: FAIL because Node credential ownership is currently duplicated.

- [ ] **Step 2: Convert seed generation to the async Node adapter**

`generateAdminSeed` becomes async, awaits `createPasswordHash`, and otherwise preserves current config validation, SQL creation, private atomic write, safe log, and return path. `runCli` becomes async and the direct entry branch catches it with the current sanitized failure prefix.

All success tests await `createPasswordHash` and `generateAdminSeed`; synchronous validation failures test `readAdminConfig` before any output write.

- [ ] **Step 3: Point recovery and smoke lifecycle at the shared adapter/parser**

- `recover-password.mjs` and `manage-smoke-identity.mjs` import `createPasswordHash` from `node-credential-crypto.mjs`.
- `recover-password-core.mjs` imports `CURRENT_PASSWORD_HASH_PREFIX` for postflight params.
- `smoke-identity-lifecycle.mjs` imports `CURRENT_PASSWORD_HASH_PREFIX` and `isCurrentPasswordHash`.
- Do not alter SQL, batch order, confirmation, audit JSON, or evidence fields.
- Update every test callsite to `await createPasswordHash(...)`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node --test \
  scripts/identity-credential-ownership.test.mjs \
  scripts/generate-admin-seed.test.mjs \
  scripts/recover-password-core.test.mjs \
  scripts/recover-password.test.mjs \
  scripts/smoke-identity-lifecycle.test.mjs \
  scripts/manage-smoke-identity.test.mjs
npm exec -- vitest run \
  test/password-recovery.integration.test.ts \
  test/smoke-identity-lifecycle.integration.test.ts \
  test/api.integration.test.ts
```

Expected: all pass with no changed public response or operation evidence.

- [ ] **Step 5: Commit**

```bash
git add scripts test/api.integration.test.ts \
  test/password-recovery.integration.test.ts \
  test/smoke-identity-lifecycle.integration.test.ts
git commit -m "refactor(identity): share credential ownership"
```

---

### Task 3: Extract session resolution and authentication into Runtime Identity

**Files:**

- Create: `src/identity/index.ts`
- Create: `test/identity-runtime.integration.test.ts`

**Interfaces:**

```ts
export type IdentityPrincipal = Readonly<{
  sessionId: number;
  sessionExpiresAt: string;
  userId: number;
  username: string;
  name: string;
  role: UserRole;
}>;

export type IdentityFailure<K extends string> =
  Readonly<{ ok: false; error: Readonly<{ kind: K }> }>;
export type IdentitySuccess<T> = Readonly<{ ok: true; value: T }>;

export interface RuntimeIdentity {
  authenticate(input: Readonly<{
    username: string;
    password: string;
  }>): Promise<
    | IdentitySuccess<Readonly<{ token: string; user: SessionUserProjection }>>
    | IdentityFailure<'account_unavailable' | 'invalid_credentials'>
  >;
  resolveSession(rawToken: string): Promise<IdentityPrincipal | null>;
  currentUser(principal: IdentityPrincipal): SessionUserProjection;
  cleanupExpiredSessions(): Promise<void>;
}

export function identity(db: D1Database): RuntimeIdentity;
export const SESSION_SECONDS: 2592000;
```

- [ ] **Step 1: Write direct migrated-D1 intent tests**

Prove:

1. `resolveSession` returns internal session id/absolute expiry and current user state, while `currentUser` returns only four public fields.
2. Role and active-state changes are observed on the next resolution.
3. Future ISO and SQLite expiries resolve; invalid/current/past expiries do not.
4. Legacy login returns a canonical lowercase UUIDv4 token, writes a raw 30-day session and login audit, and upgrades the hash.
5. Current PBKDF2 login writes the same raw session format without hash upgrade.
6. Stale observed hash leaves zero sessions/audits/upgrades and returns `invalid_credentials`.
7. Missing/inactive user returns `account_unavailable`, while wrong password returns `invalid_credentials`.
8. Cleanup deletes invalid/expired rows and rejects on D1 failure for the Hono adapter to sanitize.

Use real migrated D1. A Proxy may inject the existing stale-hash race immediately before `db.batch`; do not add generic ports.

- [ ] **Step 2: Run and verify RED**

Run `npm exec -- vitest run test/identity-runtime.integration.test.ts`.

Expected: FAIL because `src/identity/index.ts` does not exist.

- [ ] **Step 3: Implement the minimum deep module**

- call `workerIdentityCredential.verifyPassword` and `crypto.randomUUID()` directly;
- query `s.id`, `s.expires_at`, and current user fields in one join;
- keep D1 `unixepoch(s.expires_at) > unixepoch('now')`;
- construct new exact public projection objects typed with `satisfies`;
- do not activate target request/header contract or code-point caps;
- keep the login statements/order equivalent;
- retain observed `id/password_hash/is_active/is_deleted` predicates;
- retain current login audit JSON and optional upgrade;
- check first batch `meta.changes === 1`;
- return frozen result projections without hashes/session rows;
- keep cleanup SQL inside this module and let failures reject without logging.

- [ ] **Step 4: Run focused and characterization tests**

```bash
npm exec -- vitest run \
  test/identity-runtime.integration.test.ts \
  test/api.integration.test.ts \
  test/identity-http-contract.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/identity/index.ts test/identity-runtime.integration.test.ts
git commit -m "refactor(identity): extract authentication runtime"
```

---

### Task 4: Move logout, user management, and password choreography behind intents

**Files:**

- Modify: `src/identity/index.ts`
- Modify: `test/identity-runtime.integration.test.ts`

**Interfaces:**

Extend `RuntimeIdentity` with:

```ts
logout(input: Readonly<{
  principal: IdentityPrincipal;
  rawToken: string;
}>): Promise<IdentitySuccess<Readonly<{ loggedOut: true }>>>;

listUsers(principal: IdentityPrincipal): Promise<
  IdentitySuccess<AdminUserProjection[]> | IdentityFailure<'forbidden'>
>;

createUser(
  principal: IdentityPrincipal,
  input: Readonly<{
    username: string;
    name: string;
    password: string;
    role: UserRole;
  }>,
): Promise<
  IdentitySuccess<AdminUserProjection>
  | IdentityFailure<'forbidden' | 'duplicate_username'>
>;

changeOwnPassword(
  principal: IdentityPrincipal,
  input: Readonly<{
    currentPassword: string;
    newPassword: string;
    currentRawToken: string;
  }>,
): Promise<
  IdentitySuccess<Readonly<{ ok: true }>>
  | IdentityFailure<'not_found' | 'invalid_credentials'>
>;

resetPassword(
  principal: IdentityPrincipal,
  input: Readonly<{ targetId: number; newPassword: string }>,
): Promise<
  IdentitySuccess<Readonly<{ ok: true }>>
  | IdentityFailure<'forbidden' | 'not_found'>
>;
```

`canWriteBusiness` is intentionally deferred until `access_mode` has migration-backed meaning in 2F-b1.

- [ ] **Step 1: Add failing intent tests**

Cover staff forbidden paths, exact admin list, create/readback/duplicate behavior, current logout batch, self-change current-token preservation and sibling revoke, reset target revoke-all, self-reset remaining allowed, and unchanged exceptional concurrent/audit failures.

- [ ] **Step 2: Run and verify RED**

Run `npm exec -- vitest run test/identity-runtime.integration.test.ts`.

Expected: new tests fail because intent methods are absent.

- [ ] **Step 3: Implement current choreography exactly**

Move `auditStatement` into the module. Preserve admin authorization, pre-read duplicate behavior, current insert/audit/readback order, self-change no-CAS/sibling-only delete, reset no-CAS/self-reset, and logout valid-principal atomic delete+audit.

- [ ] **Step 4: Verify GREEN**

```bash
npm exec -- vitest run \
  test/identity-runtime.integration.test.ts \
  test/api.integration.test.ts \
  test/password-recovery.integration.test.ts \
  test/smoke-identity-lifecycle.integration.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/identity/index.ts test/identity-runtime.integration.test.ts
git commit -m "refactor(identity): encapsulate user session intents"
```

---

### Task 5: Thin the Hono Identity adapter without changing HTTP behavior

**Files:**

- Create: `src/identity/http-cookie.ts`
- Create: `test/identity-extraction-structure.test.ts`
- Modify: `src/index.ts`
- Modify: `scripts/identity-credential-ownership.test.mjs`

**Interfaces:**

```ts
export const AUTH_COOKIE = 'isorder_sid';
export function parseAuthCookie(cookieHeader: string | undefined): string | undefined;
export function authSetCookie(token: string, secure: boolean): readonly ['Set-Cookie', string];
export function authClearCookie(secure: boolean): readonly ['Set-Cookie', string];
```

Malformed percent encoding continues throwing into the current global 500 path. Hono context changes from public `user` to internal `principal: IdentityPrincipal`.

- [ ] **Step 1: Write the failing structural ownership test**

Bound `src/index.ts` from the login route through the line before categories and reject credential primitives, `password_hash`, Identity `sessions/users/audit_logs` SQL, and direct `.prepare`/`.batch`. Reject the former top-level credential constants/helpers. Require calls to all seven current Runtime Identity intents. Do not scan unrelated business routes.

Run:

```bash
npm exec -- vitest run test/identity-extraction-structure.test.ts
node --test scripts/identity-credential-ownership.test.mjs
```

Expected: FAIL because Hono still owns credential and Identity SQL.

- [ ] **Step 2: Move current cookie code unchanged**

Preserve cookie name, 30-day `Max-Age`, encoding, `HttpOnly`, `Path=/`, `SameSite=Strict`, HTTPS-only `Secure`, and current decode failure behavior. Do not add `Cache-Control`.

- [ ] **Step 3: Rewire middleware and routes**

Construct `identity(c.env.DB)` per request.

- `requireAuth` parses the raw cookie, calls `resolveSession`, returns the current exact 401 without clearing, or attaches principal.
- `requireAdmin` inspects principal role and remains used by `/api/audit-logs`.
- Login keeps current coercion/missing response, maps both internal failure kinds to their current distinct messages, sets current cookie, schedules module cleanup, and returns exact data.
- Logout remains protected, calls current intent, clears only on success, schedules cleanup, and returns exact data.
- User routes retain current request parsing, six-character checks, role/path checks, messages and statuses.
- Business routes use `principal.userId` and `principal.role`; internal session fields are never returned.
- Cleanup logs only `expired_session_cleanup_failed`.

- [ ] **Step 4: Run extraction and full API tests**

```bash
npm exec -- vitest run \
  test/identity-extraction-structure.test.ts \
  test/identity-runtime.integration.test.ts \
  test/api.integration.test.ts \
  test/observability.test.ts \
  test/identity-http-contract.test.ts
node --test scripts/identity-credential-ownership.test.mjs
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/identity/http-cookie.ts \
  test/identity-extraction-structure.test.ts \
  scripts/identity-credential-ownership.test.mjs
git commit -m "refactor(identity): thin Hono identity adapter"
```

---

### Task 6: Replace general business session inserts with the Identity fixture

**Files:**

- Create: `test/helpers/identity-fixture.ts`
- Modify: `test/api.integration.test.ts`
- Modify: `test/identity-extraction-structure.test.ts`

**Interfaces:**

```ts
export async function createAuthenticatedIdentity(options?: Readonly<{
  role?: UserRole;
  username?: string;
  name?: string;
}>): Promise<Readonly<{
  user: SessionUserProjection;
  principal: IdentityPrincipal;
  rawToken: string;
  cookie: string;
}>>;
```

The helper may insert only its bootstrap user row with a checked-in canonical test hash. It calls `identity(env.DB).authenticate` to create the session and may not insert into `sessions`.

- [ ] **Step 1: Add a failing fixture ownership assertion**

Bound `createSession` in `test/api.integration.test.ts`, reject `INSERT INTO sessions`, and require `createAuthenticatedIdentity`.

Run `npm exec -- vitest run test/identity-extraction-structure.test.ts`.

Expected: FAIL because the general business helper inserts a raw session.

- [ ] **Step 2: Implement the shared fixture**

Use a fixed test password/literal canonical hash, insert a unique active user, authenticate through Runtime Identity, resolve the returned token, and return the exact user/principal/raw-token/cookie projection. Throw only a generic setup error and never log values.

- [ ] **Step 3: Switch only general business authentication**

Replace `createSession(role)` with the fixture while keeping its raw-token return shape. Keep direct session setup for expiry, stale state, logout/cleanup, sibling revoke, reset target sessions, operator recovery, and smoke lifecycle. Keep Purchase Order domain actor setup unchanged.

- [ ] **Step 4: Verify GREEN**

```bash
npm exec -- vitest run \
  test/identity-extraction-structure.test.ts \
  test/api.integration.test.ts \
  test/identity-runtime.integration.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add test/helpers/identity-fixture.ts \
  test/api.integration.test.ts \
  test/identity-extraction-structure.test.ts
git commit -m "test(identity): authenticate business fixtures"
```

---

### Task 7: Document the ownership boundary and run the complete repository gate

**Files:**

- Create: `scripts/identity-extraction-docs.test.mjs`
- Modify: `docs/design/api-spec-v1.md`
- Modify: `docs/design/implementation-checklist-v1.md`

- [ ] **Step 1: Add a failing bounded docs contract**

Require both documents to state:

- extracted modules own credential formats and Identity/session D1 choreography;
- Hono owns current parsing/HTTP/cookie mapping;
- 2B has no D1 schema or public runtime behavior change;
- raw token storage, 30-day lifetime, current self-change/logout behavior, and later-slice red-matrix assignments remain;
- 2C starts only after exact 2B production deploy/smoke success.

Reject claims that 2B added digest sessions, 12-character HTTP enforcement, idempotent logout, token rotation, limiter bindings, read-only access, or migration 003.

- [ ] **Step 2: Run and verify RED**

Run `node --test scripts/identity-extraction-docs.test.mjs`.

Expected: FAIL because the bounded 2B sections do not exist.

- [ ] **Step 3: Update the documents**

Add a concise “Wave 2B implementation ownership” section next to the red matrix and a Wave 2B checklist. Do not include production run URLs, request IDs, user data, cookies, or raw audit output.

- [ ] **Step 4: Run complete gate from clean dependencies**

```bash
npm ci
npm --prefix frontend ci
npm test
npm run typecheck
npm --prefix packages/http-contract run typecheck
npm --prefix frontend test
npm run web:lint
npm run web:build
npm run build
npm --prefix frontend run build:cloudflare
git diff --check
git status --short
```

Expected: every command exits 0, there are no skipped/todo/failing tests, and build gates succeed.

- [ ] **Step 5: Commit**

```bash
git add docs/design/api-spec-v1.md \
  docs/design/implementation-checklist-v1.md \
  scripts/identity-extraction-docs.test.mjs
git commit -m "docs(identity): record Wave 2B extraction gate"
```

---

### Task 8: Review, publish, merge, deploy, and close Wave 2B

- [ ] **Step 1: Re-run fresh completion evidence**

Use `superpowers:verification-before-completion` and repeat the Task 7 complete gate.

- [ ] **Step 2: Perform two-stage review**

Use `superpowers:requesting-code-review`: first exact spec/slice compliance, then code quality, security, concurrency preservation, test quality, and scope drift. Reproduce every real finding with a failing test before fixing it.

- [ ] **Step 3: Push and open a ready PR**

```bash
git push -u origin refactor/wave-2b-identity-extraction
gh pr create \
  --base main \
  --head refactor/wave-2b-identity-extraction \
  --title "refactor(identity): extract Wave 2B runtime module" \
  --body-file /tmp/wave-2b-pr-body.md
```

The PR body includes summary, exact verification results, `DB/migration/runtime public behavior change: none`, `session storage: raw token preserved`, and `recovery: code rollback safe`. It excludes all credentials, identity rows/projections, token values, database/account IDs, and raw logs.

- [ ] **Step 4: Require CI and merge exact reviewed head**

Confirm PR head equals local `HEAD`, required checks pass, and no review request is unresolved. Merge with the repository’s normal squash flow and capture the merge SHA.

- [ ] **Step 5: Verify exact production deployment**

Find exactly one `Verify and deploy` push run for the merge SHA. Require success of verify, remote D1 rollback contract, recovery checkpoint, API deploy/version/readiness/proxy smoke, web deploy/version/proxy smoke, and authenticated business smoke. Confirm 2B introduces no migration or capability-floor operation.

- [ ] **Step 6: Clean merged branch/worktree**

Use `superpowers:finishing-a-development-branch`. Require merged PR, deployed merge SHA, equal feature/`origin/main` trees, and clean worktree. Remove the owned worktree, prune, and delete local/remote feature branches. Do not force-reset the user’s divergent local `main`.

- [ ] **Step 7: Record handoff**

Report merge SHA, PR/deployment URLs, exact verification results, no DB/public behavior/storage-format change, cleanup, and Wave 2C as the next separately planned slice.
