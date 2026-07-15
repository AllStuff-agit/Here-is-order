# Wave 2 Identity / Session Deep Module Design

- Date: 2026-07-15
- Status: written specification approved
- Baseline: `main` at `69a9f68dc54d94faab5261fc924a2b57d9caa3bc`
- Portfolio source: `docs/superpowers/specs/2026-07-12-risk-first-refactoring-portfolio-design.md`
- Prior delivery gate: Wave 1 authenticated business smoke completed in production

## 1. Summary

Wave 2 turns the current authentication choreography into one deep Identity / Session Module, preserves the existing 30-day cookie session contract during extraction, and then hardens credential verification, password mutation, login abuse controls, session storage, browser session behavior, and the production smoke identity in independently deployable slices.

This is not a cosmetic extraction. The current Implementation has four concrete risk classes:

1. missing or inactive accounts and wrong passwords return different public messages and take visibly different work;
2. self-service password change can overwrite a concurrent administrator reset because its write does not compare the observed password hash;
3. reusable bearer session tokens are stored verbatim in D1;
4. password policy, hash-envelope knowledge, Identity HTTP projections, and browser session decisions are duplicated across Worker, Node operator commands, frontend, production smoke, tests, and documentation.

The selected strategy is staged deepening. No big-bang schema replacement or forced logout is permitted. Every slice must pass repository verification and, when merged to `main`, the existing checkpointed production deployment workflow.

## 2. Current system facts

The current authentication and user-management Implementation is concentrated in `src/index.ts`:

- credential constants and password hashing: `src/index.ts:50-56,119-213`;
- raw-cookie parsing, session resolution, expiry cleanup, and cookie serialization: `src/index.ts:89-101,215-279`;
- authentication middleware: `src/index.ts:308-314`;
- login and logout: `src/index.ts:329-417`;
- user create/list/current-user/password mutation: `src/index.ts:419-539`.

The current system also has valuable invariants that Wave 2 must preserve:

- login verifies the observed password hash again when inserting a session, so a stale login cannot create a session or success audit;
- successful login, success audit, and an optional legacy-hash upgrade are executed in one D1 batch;
- expiry comparison uses D1 time with `unixepoch()`, accepting legacy ISO and canonical SQLite timestamps while rejecting invalid or expired values;
- cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` on HTTPS;
- password reset, operator recovery, and smoke-identity lifecycle operations revoke sessions;
- the authenticated principal is joined to the current user row on every request, so role and active-state changes affect existing sessions immediately;
- the deployment workflow already verifies local migrations, a remote disposable-D1 rollback contract, a production recovery checkpoint, exact active Worker versions, readiness, the web/API proxy, and an authenticated business flow.

No `CONTEXT.md` or ADR directory exists. This specification and the approved risk-first portfolio are therefore authoritative for Wave 2.

## 3. Goals

Wave 2 must:

1. expose Identity and Session through a small intent-level Interface;
2. hide credential format, D1 statements, CAS predicates, session expiry/revoke, and auth audit choreography inside the Implementation;
3. make the Identity HTTP contract executable and shared by Worker, browser, production smoke, and tests;
4. eliminate the password-change/reset TOCTOU behavior;
5. make all invalid credential outcomes account-enumeration resistant;
6. add bounded login-abuse mitigation before PBKDF2 and D1 work;
7. record useful success/failure security facts without storing submitted identifiers or secrets;
8. converge human password setters on one Unicode policy without invalidating existing passwords;
9. stop storing new reusable browser session tokens in D1 after a compatibility deployment;
10. make the fixed deployment smoke identity unable to perform business mutations;
11. give admin and staff users an accessible self-password-change flow;
12. preserve production availability with additive migrations, explicit compatibility windows, and evidence-gated forward-only transitions.

## 4. Non-goals

Wave 2 does not introduce:

- a generic repository abstraction over D1;
- generic clock, UUID, transaction, or audit ports;
- a general RBAC or capability framework;
- tenant/store separation;
- arbitrary roles beyond `admin` and `staff`;
- general user deletion, activation, deactivation, or role-management UI;
- sliding sessions, refresh tokens, or a change to the 30-day absolute lifetime;
- a Durable Object session store or login limiter;
- D1 login-attempt counters on the login hot path;
- a complete browser E2E framework;
- unrelated conversion of Catalog, Inventory, or Purchase Order browser callers to executable contracts;
- immediate removal of legacy SHA verification or the raw-session compatibility path without production aggregate evidence.

## 5. Architectural decision

### 5.1 Module relationship

```text
Hono HTTP Adapter
        |
        v
Identity / Session Module ---- Portable Credential Module
        |                              |-- Worker crypto Adapter
        |                              `-- Node crypto Adapter
        |-- D1 choreography
        |-- session issue/resolve/revoke
        |-- observed-state CAS
        |-- auth audit
        `-- LoginLimiter Adapter

Executable Identity HTTP Contract
        |-- Worker Adapter
        |-- Browser Adapter
        `-- Production smoke Adapter
```

The Identity / Session Module is deep because deleting it would redistribute password, session, CAS, D1 batch, audit, and error policy across login, logout, current-user, list-user, create-user, self-password-change, admin-reset, middleware, and test fixtures. D1 remains a direct Implementation dependency because there is no second persistence Implementation.

### 5.2 Runtime Identity Interface

The public runtime Interface expresses user intent and returns discriminated results. It does not expose SQL, password hashes, session-table rows, Hono contexts, or HTTP status codes.

| Intent | Input known to caller | Successful result | Important internal ownership |
| --- | --- | --- | --- |
| `authenticate` | submitted username/password | raw cookie token plus session-user projection | limiter, lookup, equalized verification, CAS, issue, upgrade, audit |
| `resolveSession` | raw cookie token | internal principal with session id and absolute expiry | digest/legacy lookup, expiry, active/deleted checks |
| `logout` | optional raw cookie token | whether a live session was revoked | digest/legacy lookup, authoritative delete, best-effort audit |
| `currentUser` | authenticated principal | session-user projection | no storage shape exposure |
| `listUsers` | admin principal | admin-user rows | authorization and projection |
| `createUser` | admin principal and validated input | admin-user row | policy, unique-conflict mapping, hash, audit |
| `changeOwnPassword` | principal, current password, new password | replacement token with the prior absolute expiry | observed-hash CAS, revoke-all, replacement issue, audit |
| `resetPassword` | admin principal, target id, new password | success | target-state CAS, revoke-all, audit |
| `canWriteBusiness` | authenticated principal | boolean | `access_mode` interpretation |

The internal principal includes `sessionId`, `sessionExpiresAt`, `userId`, `username`, `name`, `role`, and `accessMode`. `sessionId`, `sessionExpiresAt`, and `accessMode` are not public fields.

There are two intentionally distinct public projections:

- `SessionUserProjection = { id, username, name, role }` for login and current-user, with a positive integer id, canonical trimmed U+0000-free username/name at the 128/200-code-point limits, and exact `admin | staff` role;
- `AdminUserProjection = { id, username, name, role, is_active, created_at }` for list-user and create-user, extending the same fields with `is_active: 0 | 1` and the existing canonical SQLite UTC `YYYY-MM-DD HH:MM:SS` string.

Both projections exclude `access_mode`, password material, and session material. Keeping the projections distinct preserves the current administrator settings UI without leaking internal authorization state into the session contract.

Expected failures use a closed Identity error taxonomy. Unexpected D1 or programming failures remain exceptional and are mapped by the HTTP Adapter to the existing generic `500 INTERNAL_ERROR` envelope.

### 5.3 Portable Credential Module

A new workspace package at `packages/identity-credential`, published locally as `@here-is-order/identity-credential`, owns:

- the canonical PBKDF2 hash envelope and strict parser;
- current versioned KDF parameters;
- human and automation password policies;
- hash creation;
- verification and `needsUpgrade` decisions;
- exact legacy SHA recognition;
- dummy PBKDF2 verification for failure-path equalization;
- known-answer and malformed-envelope conformance vectors.

The recognized stored formats in Wave 2 are an exact allowlist:

- legacy SHA-256: exactly 64 lowercase hexadecimal characters;
- current PBKDF2: exactly `pbkdf2_sha256$100000$<32 lowercase hexadecimal salt characters>$<64 lowercase hexadecimal digest characters>`.

There is no open-ended iteration parser in Wave 2. Extra segments, partial decimal parsing, uppercase hexadecimal, wrong lengths, unknown schemes, and any PBKDF2 work factor other than `100000` are unsupported. A future work-factor version must add a new explicit envelope and equal-work conformance vectors before it is recognized.

Every login verification attempt performs exactly one SHA-256 operation, one PBKDF2-SHA256/100000 derivation, one 16-byte salt generation, and fixed-length constant-time comparisons. Every primitive processes the same submitted password bytes; only the salt and expected digest are real or dummy:

- a PBKDF2 row compares the real PBKDF2 result and compares the SHA result to a fixed dummy digest;
- a legacy row compares the real SHA result and uses the one PBKDF2 derivation with the generated salt as the upgrade candidate, comparing that result to a fixed dummy digest as well;
- a missing, inactive, deleted, or malformed row compares both results to fixed dummy digests and discards the generated PBKDF2 candidate.

The legacy path therefore reuses its single PBKDF2 result as the replacement envelope after a valid SHA comparison; it never performs a second derivation, even if the later login CAS becomes stale. Both digest comparisons operate on exactly 64 lowercase-hex characters, accumulate every character difference without early return, and reject unequal lengths before the fixed-width comparison. Tests assert primitive/salt/comparison calls and data lengths rather than brittle wall-clock timing.

The package exports `src/index.mjs` plus `src/index.d.ts`, with package exports for JavaScript and types. The Worker Adapter is `src/identity/worker-credential-crypto.ts`; the Node Adapter is `scripts/node-credential-crypto.mjs`. A shared conformance test lives under `scripts/` so the existing root Node test glob executes it. The root file dependency and lockfile are updated in the same slice. Neither runtime requires a new package build step.

Extraction keeps `pbkdf2_sha256$100000$<salt>$<digest>` as the current write format. A work-factor change is not bundled with extraction. As of this specification, OWASP lists 600,000 iterations for PBKDF2-HMAC-SHA256; the approved 100,000 factor is therefore an explicit six-times-lower residual risk, not a claim of current best-in-class strength. Slice 2C records a repeatable Worker CPU benchmark and the risk decision; it does not silently change the factor. A later versioned envelope can raise it only with equal-work vectors and a production migration plan. See [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### 5.4 Hono HTTP Adapter

The Hono Adapter owns only:

- strict JSON, path, and cookie parsing;
- binding the D1 and limiter Implementations;
- calling Identity intents;
- converting Identity results to exact HTTP envelopes and status codes;
- setting or clearing cookies;
- attaching the internal principal to authenticated request context.

It must not contain password-format parsing, PBKDF2 policy, session SQL, password mutation SQL, or audit SQL.

Malformed percent-encoding in a cookie is treated as an invalid cookie, not an unhandled exception. When a request presents an invalid, unknown, inactive, or expired session cookie, the Adapter returns `401 UNAUTHORIZED` and expires that cookie. A missing cookie returns the same error but does not need an additional clear header.

Logout is an idempotent authentication intent and does not require a currently valid authenticated context. An absent, unknown, expired, or concurrently deleted session returns success and expires the cookie. For a live session, deletion is authoritative and a later audit write is best effort so audit failure cannot resurrect the session. If D1 lookup or deletion itself fails, the Adapter returns `500 INTERNAL_ERROR` and does **not** clear the cookie, allowing the user to retry.

Every Identity response and every response containing `Set-Cookie` carries `Cache-Control: no-store`.

### 5.5 Executable Identity HTTP Contract

`packages/http-contract` gains `./identity` backed by `src/identity.ts`, containing strict runtime schemas, inferred types, route patterns, allowed error/status pairs, and safe path builders. The exact public route table is:

| Method and path | Strict request | Success | Allowed public errors |
| --- | --- | --- | --- |
| `POST /api/auth/login` | `{ username, password }` | `200`, `{ user: SessionUserProjection }`, new-session `Set-Cookie` | `400 INVALID_INPUT`; `401 INVALID_CREDENTIALS`; `429 TOO_MANY_ATTEMPTS`; `503 AUTH_TEMPORARILY_UNAVAILABLE`; `500 INTERNAL_ERROR` |
| `POST /api/auth/logout` | no parsed body; incidental body ignored | `200`, `{ loggedOut: true }`, clearing `Set-Cookie` | `500 INTERNAL_ERROR` |
| `GET /api/users/me` | no parsed body | `200`, `SessionUserProjection` | `401 UNAUTHORIZED`; `500 INTERNAL_ERROR` |
| `PATCH /api/users/me/password` | `{ current_password, new_password }` | `200`, `{ ok: true }`, rotated `Set-Cookie` | `400 INVALID_INPUT`; `400 PASSWORD_POLICY_VIOLATION`; `401 INVALID_CREDENTIALS`; `401 UNAUTHORIZED`; `409 AUTH_STATE_CHANGED`; `500 INTERNAL_ERROR` |
| `GET /api/users` | no parsed body | `200`, `AdminUserProjection[]` | `401 UNAUTHORIZED`; `403 FORBIDDEN`; `500 INTERNAL_ERROR` |
| `POST /api/users` | `{ username, name?, password, role? }` | `201`, `AdminUserProjection` | `400 INVALID_INPUT`; `400 PASSWORD_POLICY_VIOLATION`; `401 UNAUTHORIZED`; `403 FORBIDDEN`; `403 READ_ONLY_ACCESS`; `409 DUPLICATE_USERNAME`; `500 INTERNAL_ERROR` |
| `PATCH /api/users/:id/password` | `{ new_password }`, positive integer path id | `200`, `{ ok: true }` | `400 INVALID_INPUT`; `400 PASSWORD_POLICY_VIOLATION`; `400 SELF_RESET_NOT_ALLOWED`; `401 UNAUTHORIZED`; `403 FORBIDDEN`; `403 READ_ONLY_ACCESS`; `404 NOT_FOUND`; `409 TARGET_STATE_CHANGED`; `500 INTERNAL_ERROR` |

All bodies use the existing `{ ok: true, data } | { ok: false, error }` envelope. Identity decoders validate the HTTP status, envelope branch, and route-specific code as one unit. A mismatched status/code pair, an unknown code, an unexpected success status, or an invalid projection becomes the browser/smoke-local `INVALID_RESPONSE`; it is never accepted merely because the generic envelope parses.

Every `401 UNAUTHORIZED` caused by a presented invalid/expired cookie includes the exact clearing `Set-Cookie`; a missing cookie need not. Self-password `409 AUTH_STATE_CHANGED` includes the same clearing header after verified server-side revocation. `TARGET_STATE_CHANGED` never clears the administrator cookie, and logout `500` never clears it. Contract and integration tests assert these header rules, not only bodies.

For `POST /api/users`, all supplied fields must be strings and extra fields are rejected. `username` and `name` are trimmed while `password` is never trimmed. An omitted `role` defaults to `staff`; a supplied role is trimmed and must be exactly `admin` or `staff`. An omitted or trimmed-empty `name` becomes the canonical trimmed username. An empty supplied role is invalid rather than defaulted.

Strict input limits apply before credential work and never truncate values:

- JSON-bearing Identity request body: at most 32 KiB of UTF-8;
- trimmed U+0000-free username: 1 to 128 Unicode code points;
- trimmed U+0000-free display name: at most 200 Unicode code points;
- submitted password field: at most 4,096 Unicode code points;
- new human password: 12 to 4,096 Unicode code points.

JSON-bearing routes require `Content-Type: application/json` with an optional charset. The Adapter rejects an over-limit `Content-Length` immediately and also reads an unknown/chunked body through a capped stream, cancels it as soon as the accumulated UTF-8 bytes exceed 32 KiB, and only then parses JSON. It does not first buffer an unbounded body. A missing/unsupported media type, over-limit body or field is `400 INVALID_INPUT`; a below-policy new password is `400 PASSWORD_POLICY_VIOLATION`. Existing-password verification does not apply the new 12-character minimum, but still applies the 4,096-code-point request safety cap.

The export contains strict schemas for:

- login request and result;
- logout result;
- current-user result;
- user-list and user-create request/results;
- self-password-change request/result;
- admin-password-reset request/result;
- the canonical `admin | staff` role literal.

The Worker validates successful Identity projections before serialization. Identity browser callers use route-specific decoded HTTP Adapters instead of unchecked casts; business callers adopt the strict non-2xx decoder without expanding every success contract in Wave 2. Production smoke reuses the shared Identity success/error schemas but retains its stronger fixed username/name/role checks, cookie checks, same-origin constraints, request-count constraints, cleanup behavior, and safe evidence whitelist.

### 5.6 Browser authenticated-session Module

The browser implementation consists of a pure `frontend/lib/auth-session.ts` state machine plus one React provider/hook boundary. It owns:

- authenticated, anonymous, loading, and recoverable-error state;
- current-user loading independent of dashboard data;
- exact `UNAUTHORIZED` classification;
- login and logout ordering;
- redirect decisions;
- self-password-change intent.

The provider does not render protected children until the initial `/api/users/me` decision completes. A generation/cancellation guard prevents a stale `/me` response from restoring authenticated state after logout or navigation. Every business non-2xx response is first decoded as a strict `{ ok: false, error: { code, message } }` envelope; only exact `status = 401`, `code = UNAUTHORIZED`, and the canonical message can enter the shared auth-transition classifier. `UNAUTHORIZED` at another status, a malformed 401, or a non-error envelope becomes `INVALID_RESPONSE` and never redirects. Business success payloads need not all gain new Wave 2 contracts. `409 AUTH_STATE_CHANGED` is recognized only by the self-password route decoder, never by a generic business caller.

The Module does not turn every `401` into a login redirect. `401 INVALID_CREDENTIALS` from a wrong current password remains in the password form. Only `401 UNAUTHORIZED`, and `409 AUTH_STATE_CHANGED` where the response requires reauthentication, clear local authenticated state and navigate to login.

The login page disables its form while `/me` is pending. Exact `401 UNAUTHORIZED` enables login; `200` redirects; network, malformed, and `5xx` results show retry UI without exposing the form. The settings route is reachable by admin and staff. Its security section is shared. The account-management section requests and renders user data only for admins. The admin-reset action does not target the current admin; the self-password flow is the only in-app way to change one's own password and transparently rotate the current browser credential.

## 6. Data model and migration design

Only `migrations/` applies schema changes. `db/schema.sql` remains an updated snapshot, not an application path.

### 6.1 Migration 003: session digest expansion

Migration `003_session_digest_expand.sql` adds:

```sql
ALTER TABLE sessions
  ADD COLUMN token_hash TEXT
  CHECK (
    token_hash IS NULL
    OR (
      typeof(token_hash) = 'text'
      AND
      length(token_hash) = 64
      AND token_hash NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE sessions
  ADD COLUMN token_storage TEXT NOT NULL DEFAULT 'legacy'
  CHECK (
    token_storage IN ('legacy', 'digest')
    AND (token_storage = 'legacy' OR token_hash IS NOT NULL)
  );
CREATE UNIQUE INDEX uq_sessions_token_hash
  ON sessions(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE TABLE identity_rollout_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  minimum_session_writer TEXT NOT NULL DEFAULT 'legacy-compatible-v1'
    CHECK (minimum_session_writer IN ('legacy-compatible-v1', 'digest-only-v1')),
  digest_only_activated_at TEXT,
  digest_only_git_sha TEXT,
  CHECK (
    (
      minimum_session_writer = 'legacy-compatible-v1'
      AND digest_only_activated_at IS NULL
      AND digest_only_git_sha IS NULL
    )
    OR (
      minimum_session_writer = 'digest-only-v1'
      AND typeof(digest_only_activated_at) = 'text'
      AND digest_only_activated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(digest_only_activated_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', digest_only_activated_at)
          = digest_only_activated_at
      AND typeof(digest_only_git_sha) = 'text'
      AND length(digest_only_git_sha) = 40
      AND digest_only_git_sha NOT GLOB '*[^0-9a-f]*'
    )
  )
);
INSERT INTO identity_rollout_state(singleton_id) VALUES (1);

CREATE TRIGGER trg_identity_rollout_state_no_delete
BEFORE DELETE ON identity_rollout_state
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_ROLLOUT_STATE_REQUIRED');
END;

CREATE TRIGGER trg_identity_rollout_state_no_reinsert
BEFORE INSERT ON identity_rollout_state
WHEN EXISTS (SELECT 1 FROM identity_rollout_state WHERE singleton_id = 1)
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_ROLLOUT_STATE_EXISTS');
END;

CREATE TRIGGER trg_identity_rollout_state_writer_marker_immutable
BEFORE UPDATE OF
  minimum_session_writer,
  digest_only_activated_at,
  digest_only_git_sha
ON identity_rollout_state
WHEN OLD.minimum_session_writer = 'digest-only-v1'
 AND (
   NEW.minimum_session_writer IS NOT OLD.minimum_session_writer
   OR NEW.digest_only_activated_at IS NOT OLD.digest_only_activated_at
   OR NEW.digest_only_git_sha IS NOT OLD.digest_only_git_sha
 )
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_WRITER_MARKER_IMMUTABLE');
END;

CREATE TRIGGER trg_sessions_enforce_writer_floor_insert
BEFORE INSERT ON sessions
WHEN NEW.token_storage = 'legacy'
 AND (SELECT minimum_session_writer
        FROM identity_rollout_state
       WHERE singleton_id = 1) = 'digest-only-v1'
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_SESSION_WRITER_RETIRED');
END;

CREATE TRIGGER trg_sessions_enforce_writer_floor_update
BEFORE UPDATE ON sessions
WHEN NEW.token_storage = 'legacy'
 AND (SELECT minimum_session_writer
        FROM identity_rollout_state
       WHERE singleton_id = 1) = 'digest-only-v1'
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_SESSION_WRITER_RETIRED');
END;
```

Existing rows and rows written by an old Worker remain `legacy` while the floor is at its default. The existing non-null unique `token` column is not rebuilt in Wave 2. The singleton is a production capability floor, not a feature flag: after it advances, it cannot be lowered by any normal workflow, and the conditional triggers make any subsequent legacy insert/update fail inside D1 even if application preflight is bypassed.

Session digest is lowercase hexadecimal SHA-256 over the high-entropy raw cookie token. It is not a password hash and does not use PBKDF2. The cookie token remains a canonical lowercase UUIDv4 during Wave 2 to avoid changing cookie syntax in the same rollout.

The compatibility Implementation resolves sessions in this order:

1. compute the cookie-token digest and look for `token_hash`;
2. if no digest row exists, look for a `legacy` row whose `token` equals the cookie token;
3. apply the same user-active, user-not-deleted, and DB-time expiry predicates;
4. return the internal session id rather than the persistence token.

The first post-migration Worker writes the raw token, its digest, and `token_storage = 'legacy'`. This exercises digest lookup while preserving rollback compatibility with the previous Worker.

After compatibility evidence succeeds, the cutover Worker writes:

- raw browser token only to the cookie;
- its SHA-256 digest to `token_hash`;
- a domain-marked independent surrogate, `digest$<UUIDv4>`, to the legacy non-null `token` column;
- `token_storage = 'digest'`.

The new Worker accepts raw-token lookup only for rows explicitly marked `legacy`, so it never accepts the surrogate. A pre-003 raw-token-only Worker still performs `WHERE sessions.token = ?`; therefore a leaked surrogate would be a bearer credential to that code. The 2E compatibility Worker can resolve digest rows, but would issue fresh `legacy` rows and restart the retirement clock. The persistent capability floor in section 6.6 prohibits both candidates after cutover, and production recovery is forward-fix only.

Self-password change identifies the current session by internal `sessionId`, not by comparing a submitted raw token to a persistence column.

### 6.2 Legacy-session retirement

The raw-token fallback remains for at least the unchanged maximum 30-day absolute session lifetime. The clock starts at the immutable D1 `digest_only_activated_at` written after the exact digest-only version/readiness became active, not at merge time or merely when 2F-a deployment began. This is conservative relative to actual activation. Deployment preflight forbids any legacy-capable writer after this timestamp.

A fixed read-only production aggregate must prove:

```text
active_legacy_session_count = 0
```

The count includes only `token_storage = 'legacy'` rows whose expiry is valid and later than D1 current time. Immediately before retirement, the fixed aggregate is rerun and must still be zero. Migration `005_session_legacy_retirement_guard.sql` additionally enforces that invariant inside the migration:

```sql
CREATE TRIGGER trg_sessions_block_active_legacy_delete
BEFORE DELETE ON sessions
WHEN OLD.token_storage = 'legacy'
 AND unixepoch(OLD.expires_at) > unixepoch('now')
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_LEGACY_SESSION');
END;

DELETE FROM sessions WHERE token_storage = 'legacy';
DROP TRIGGER trg_sessions_block_active_legacy_delete;
```

Only after that guarded delete does the migration install permanent insert/update triggers that reject `token_storage = 'legacy'`. Wrangler rolls back a migration file when any statement fails, so an active fixture must leave both rows and schema unchanged; the local and remote-disposable migration tests prove this behavior. See [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/).

On success the migration:

1. expired and remaining legacy rows are deleted;
2. the conditional writer-floor triggers are replaced by `trg_sessions_reject_legacy_insert` (`BEFORE INSERT`) and `trg_sessions_reject_legacy_update` (`BEFORE UPDATE`, with no column filter), which abort with `LEGACY_SESSION_WRITE_RETIRED` whenever `NEW.token_storage = 'legacy'`;
3. `token`, `token_storage`, and the compatibility schema remain physically present rather than rebuilding the table.

The same slice removes the fallback lookup and proves that no session Interface depends on raw `token`. The fixed aggregate runs again after deployment and must remain zero. A legacy-capable Worker cannot be a recovery target once these guards exist.

No active session is deleted merely to accelerate retirement.

### 6.3 Migration 004: read-only access mode

Migration `004_user_access_mode.sql` adds:

```sql
ALTER TABLE users
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (access_mode IN ('standard', 'read_only'));
ALTER TABLE identity_rollout_state
  ADD COLUMN minimum_access_enforcement TEXT NOT NULL DEFAULT 'standard-only-v1'
  CHECK (minimum_access_enforcement IN ('standard-only-v1', 'read-only-v1'));
CREATE TRIGGER trg_identity_rollout_state_no_access_downgrade
BEFORE UPDATE OF minimum_access_enforcement ON identity_rollout_state
WHEN OLD.minimum_access_enforcement = 'read-only-v1'
 AND NEW.minimum_access_enforcement <> 'read-only-v1'
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_ACCESS_FLOOR_DOWNGRADE');
END;
```

All existing and newly created human users default to `standard`. The fixed production smoke identity remains role `staff` but is changed to `read_only` by its dedicated lifecycle command.

The old `admin | staff` CHECK remains untouched. This avoids a users-table rebuild and keeps browser and smoke role projections compatible. The verified `restrict` operation advances `minimum_access_enforcement` to `read-only-v1` in the same batch as access-mode mutation, session revoke, and audit; it never lowers that floor.

### 6.4 Access decision

For an authenticated `read_only` principal, every non-safe `/api/*` method is denied by default before body parsing or D1 business lookup, except these explicit Identity intents:

- `POST /api/auth/logout`;
- `PATCH /api/users/me/password`.

Login is public and evaluated before authenticated write policy. Admin account mutations and all business mutations remain denied to a hypothetical read-only admin. No read-only admin is provisioned by Wave 2.

| Principal | Business reads | Business writes | Admin reads | Admin/user writes | Self password | Logout |
| --- | --- | --- | --- | --- | --- | --- |
| `admin + standard` | allow | allow | allow | allow | allow | allow |
| `staff + standard` | allow | allow | deny | deny | allow | allow |
| `staff + read_only` | allow | deny | deny | deny | allow | allow |
| any `read_only` admin anomaly | allow | deny | allow | deny | allow | allow |

The browser role remains a UX projection. Server-side Identity and write policy remain the authorization authority.

### 6.5 Password data compatibility

Password policy is applied only when a new password is set:

| Intent | Minimum |
| --- | --- |
| human create/change/reset/bootstrap/recovery | 12 Unicode code points |
| production automation credential | 32 Unicode code points |
| verification of an existing password | no new length rejection |

Existing shorter passwords remain valid. Successful login upgrades an exactly recognized legacy SHA hash to the current PBKDF2 format. There is no bulk password migration because plaintext is unavailable.

The 4,096-code-point request cap can reject a pathological pre-existing password above that size, which cannot be inferred from a stored one-way hash. This bounded-input DoS protection is an explicit security tradeoff. Repository generators and operator documentation adopt the same maximum; any externally managed account known to exceed it must be reset before rollout.

Before the strict parser is deployed, the production `identity-compatibility-v1` preflight must prove `unsupportedPasswordHashCount = 0`. The count covers every non-deleted account, active or inactive, and recognizes only the two exact stored formats in section 5.3. Any positive value stops deployment and is remediated through a verified administrator or operator reset; the workflow never outputs the account or hash.

Legacy-verification removal requires a fixed aggregate `legacy_password_hash_count = 0`. The aggregate exposes neither username nor hash. Accounts that cannot naturally upgrade are reset through the existing administrator or operator recovery intent before removal.

### 6.6 Persistent deployment capability floor

The Identity contract exports one checked-in `identityDeploymentCapabilities` object used by the Worker, readiness response, build tests, and `production-preflight.mjs`:

```text
version = identity-deployment-capabilities-v1
sessionWriter = legacy-compatible-v1 | digest-only-v1
sessionReader = raw-only-v1 | digest-and-legacy-v1 | digest-only-v1
accessEnforcement = standard-only-v1 | read-only-v1
```

Tests couple these declarations to real issue/resolve/authorization behavior; readiness exposes only the safe capability literals. The production preflight reads the singleton D1 floor and rejects a candidate when its `sessionWriter` or `accessEnforcement` is below that floor.

Slice 2F-a changes the candidate writer to `digest-only-v1`. After the exact version and readiness capabilities are active, but before authenticated smoke, a fixed idempotent cutover operation advances the singleton from `legacy-compatible-v1` to `digest-only-v1`, sets `digest_only_activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, and stores the exact merged SHA. Its predicate requires the original floor and both null marker fields. A `changes()`-guarded audit makes the first transition atomic. The D1 triggers reject marker-only rewrites, reinsertion/replace, deletion, and downgrade. A rerun performs a read-only verification of the original marker instead of updating it. Its only evidence is one exact five-field report:

```text
operationVersion, activatedAt, gitSha, minimumSessionWriter, outcome
```

The exact values are `identity-session-cutover-v1`, the stored ISO timestamp/SHA, `digest-only-v1`, and `active`. That stored timestamp is the conservative start of the 30-day retirement clock.

An older workflow does not know how to read this floor. Before 2F-a is merged, maintainers therefore provision the least-privilege `CLOUDFLARE_FORWARD_DEPLOY_TOKEN`, update every deploy/migration/lifecycle step to use only that secret, revoke the old Cloudflare token, and remove `CLOUDFLARE_API_TOKEN` at every GitHub repository/environment/organization scope visible to this repository. A rerun of an older workflow then fails authentication before deployment. The forward token is available only to the protected GitHub production environment; direct local deploys and copying it to an old workflow are prohibited.

At `restrict`, the same atomic lifecycle batch advances `minimum_access_enforcement` to `read-only-v1`. Neither floor has a normal downgrade operation. Thus current workflows are blocked by the D1 floor, while historical workflow reruns are blocked by credential revocation.

Terminology is strict: the 2E Worker is a digest-aware reader but a **legacy-capable writer**; a pre-003 Worker is both a **raw-token-only reader** and legacy-capable writer. After 2F-a, both are prohibited, but for different reasons.

## 7. Core flows and concurrency rules

### 7.1 Login

The exact order is:

1. location circuit-breaker limiter;
2. request-envelope and required-field validation;
3. digest of trimmed, case-preserving username and account limiter;
4. active, non-deleted user lookup;
5. the exact one-SHA plus one-PBKDF2 verification schedule;
6. conditional session insert using observed user id, password hash, active state, and deleted state;
7. immediate `changes()` guard/success audit and optional password-hash upgrade in the same D1 batch;
8. cookie serialization;
9. best-effort expired-session cleanup.

Missing, inactive, deleted, malformed-hash, wrong-password, and stale-observed-hash outcomes expose the same invalid-credentials response and the verification schedule defined in section 5.3.

Session issuance and success audit fail together. D1 `batch()` does not fail merely because a conditional statement changes zero rows, so the statement immediately after the conditional insert is also the guard: its non-null `action` uses `CASE WHEN changes() = 1 THEN 'login' ELSE NULL END`. A zero-row insert deliberately violates the audit table's non-null constraint and rolls the batch back before any upgrade. After a batch error, the Module rereads the observed user state: a changed state maps to the generic invalid-credentials result, while unchanged state proves an infrastructure/audit failure and maps to `INTERNAL_ERROR`.

### 7.2 Session resolution

Session resolution:

- rejects absent, malformed, unknown, invalid-expiry, current-time-expiry, and past-expiry credentials;
- reads user state and access mode on every request;
- uses D1 time for expiry;
- returns an internal principal including the session id and observed absolute expiry;
- never returns or logs the persistence token or digest.

Absolute lifetime remains 30 days. Session access does not extend expiry.

### 7.3 Logout

Logout uses a credential locator distinct from authenticated session resolution. It matches digest-first and legacy-fallback storage rules but joins no user lifecycle predicate and locates a matching row even when its expiry is invalid or past. Thus a soft-deleted/inactive user's cookie removes the server row and cannot revive after later reactivation. An absent, malformed, unknown, expired, or already-deleted cookie clears and returns `{ loggedOut: true }`.

For a located row, the Module deletes by internal session id and checks the change count. A zero-row concurrent delete is still idempotent success. A one-row delete is committed before a best-effort logout audit is attempted, so audit failure cannot roll revocation back; it emits a fixed observability event. A D1 lookup or delete failure returns `500` without a clearing cookie so the browser can retry.

### 7.4 Self-password change

The Module:

1. reads the current user password hash/active/deleted state and the principal's session id/absolute expiry;
2. verifies the submitted current password;
3. validates and hashes the new password;
4. updates only where the observed hash and active/deleted state still match **and** the same session id/user/observed expiry row still exists with `unixepoch(expires_at) > unixepoch('now')`;
5. immediately inserts the success audit with a `changes() = 1` non-null guard;
6. revokes every old session, including the current session id;
7. inserts a new session with a new raw credential and the current session's unchanged absolute `expires_at`;
8. treats CAS, guard/audit, revoke-all, and replacement issue as one atomic D1 operation.

The successful result returns the replacement raw token and remaining cookie lifetime. `Set-Cookie` replaces the browser credential with `Max-Age` derived from the prior absolute expiry; the lifetime is neither reset nor extended. The old cookie must immediately return `401`, while the replacement cookie resolves normally. This rotates the credential without interrupting the current browser experience and signs every other session out.

If the guarded batch fails, the Module rereads both observed user and session state. A missing, replaced, invalid, or expired current session with otherwise unchanged user state maps to `401 UNAUTHORIZED` with no password mutation. When the hash or lifecycle state changed, the Module must revoke the caller's current server-side session before returning `AUTH_STATE_CHANGED`; only then does the HTTP Adapter clear the cookie. Clearing the cookie alone is insufficient because it could leave a live server session. If that revocation cannot be established, the result is `500` without cookie clearing so the caller can retry. If both observed states are unchanged and valid, the original failure is internal rather than a false conflict. This prevents a stale self-change request from overwriting an administrator reset or succeeding after concurrent logout/revoke.

### 7.5 Administrator reset

The reset path reads the target's observed hash and active/deleted state and uses them in the update predicate. The immediate audit statement uses `CASE WHEN changes() = 1 THEN 'reset_password' ELSE NULL END` as the transaction guard, followed by revoke-all. After any batch error, a reread distinguishes a real `TARGET_STATE_CHANGED` conflict from an internal/audit failure. This target conflict does not invalidate the administrator's own session; the browser refreshes the user list. A successful reset revokes every target session and records the audit atomically.

An administrator cannot use the admin-reset path on their own account. The public error directs them to the self-password intent, which verifies their current password and transparently rotates their current session credential.

### 7.6 User creation

The database unique constraint is authoritative. A convenience pre-read may improve normal UX, but the Module must catch and map the actual concurrent unique violation to `409 DUPLICATE_USERNAME`. Hashing, insert, and a no-PII create audit retain one transactional success meaning. The audit records the administrator actor and new user entity id but no username, display name, or password-derived value.

## 8. Login rate limiting

Wave 2 uses two Cloudflare Workers Rate Limiting bindings:

| Binding | Key | Limit |
| --- | --- | --- |
| `LOGIN_LOCATION_CIRCUIT_BREAKER` | constant `login` | 100 per 60 seconds per Cloudflare location |
| `LOGIN_ACCOUNT_LIMITER` | SHA-256 of trimmed case-preserving username | 10 per 60 seconds |

The exact production configuration is:

```toml
[[ratelimits]]
name = "LOGIN_LOCATION_CIRCUIT_BREAKER"
namespace_id = "731401"

  [ratelimits.simple]
  limit = 100
  period = 60

[[ratelimits]]
name = "LOGIN_ACCOUNT_LIMITER"
namespace_id = "731402"

  [ratelimits.simple]
  limit = 10
  period = 60
```

The Cloudflare account reserves these two distinct namespace ids for this Worker. Slice 2C updates `wrangler.toml`, the handwritten Worker `Env`, and `test/env.d.ts` together and tests their exact agreement.

Both calls occur before user lookup and PBKDF2. Malformed or empty input consumes only the location budget. Successful and failed attempts consume the account budget; there is no success reset or durable account lockout.

IP address is neither a key nor an audit field because the application is likely to be used behind shared networks and the platform recommends stable actor/resource keys instead of IP-based keys. The application never persists or emits the username digest; Cloudflare's counter infrastructure necessarily processes that pseudonymous key for the configured window. A secret HMAC key is not added because Cloudflare is already the trusted edge processor and another production secret would not remove its access to the submitted identifier. The residual offline-dictionary risk of a leaked counter key is accepted and documented.

The binding is location-local, permissive, and eventually consistent. The 100/minute control is therefore a location circuit breaker, not a mathematically global bound. It is an abuse-mitigation Adapter, not an exact counter, billing control, or permanent account lock. Tests verify Adapter calls and checked-in configuration rather than claiming Cloudflare hard-bound behavior. See the [Cloudflare Workers Rate Limiting binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

The selected account threshold permits a targeted actor to deny that account's login temporarily, and the location threshold can deny logins at one edge location temporarily. This residual availability risk is accepted; no account is durably locked and existing sessions are unaffected.

If either limiter call throws or returns an unusable result, login fails closed with `503 AUTH_TEMPORARILY_UNAVAILABLE`. Existing authenticated sessions and non-login routes remain available.

Tests use a deterministic fake LoginLimiter Adapter. Production uses the two Cloudflare bindings. D1 is not used as a hot-path limiter because per-attempt writes would turn attack traffic into database write amplification; D1 databases execute queries through a single-threaded processing model. See [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## 9. Public error contract

| Situation | HTTP | Code | Public message/behavior |
| --- | ---: | --- | --- |
| malformed JSON, over-limit input, or missing required login field | 400 | `INVALID_INPUT` | login missing fields: `아이디와 비밀번호를 입력해주세요.` |
| new password below policy | 400 | `PASSWORD_POLICY_VIOLATION` | `새 비밀번호는 12자 이상이어야 합니다.` |
| missing/inactive/deleted user, wrong password, malformed stored hash, stale login state | 401 | `INVALID_CREDENTIALS` | `아이디 또는 비밀번호가 올바르지 않습니다.` |
| wrong current password | 401 | `INVALID_CREDENTIALS` | `현재 비밀번호가 올바르지 않습니다.`; stays on form |
| missing/expired/unknown/malformed session | 401 | `UNAUTHORIZED` | `로그인이 필요합니다.` and clear presented cookie |
| account/location login budget exceeded | 429 | `TOO_MANY_ATTEMPTS` | `로그인 시도가 너무 많습니다. 60초 후 다시 시도해주세요.` and `Retry-After: 60` |
| authenticated non-admin on admin intent | 403 | `FORBIDDEN` | `관리자 권한이 필요합니다.` |
| read-only principal attempts mutation | 403 | `READ_ONLY_ACCESS` | `읽기 전용 계정은 변경 작업을 할 수 없습니다.` |
| self-reset through admin route | 400 | `SELF_RESET_NOT_ALLOWED` | `본인 비밀번호는 보안 설정에서 변경해주세요.` |
| observed password/account state changed | 409 | `AUTH_STATE_CHANGED` | `계정 상태가 변경되었습니다. 다시 로그인해주세요.` |
| observed admin-reset target state changed | 409 | `TARGET_STATE_CHANGED` | `사용자 상태가 변경되었습니다. 다시 확인해주세요.` |
| concurrent duplicate username | 409 | `DUPLICATE_USERNAME` | `이미 사용 중인 아이디입니다.` |
| login limiter unavailable | 503 | `AUTH_TEMPORARILY_UNAVAILABLE` | `로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.` |
| missing admin-reset target | 404 | `NOT_FOUND` | `사용자를 찾을 수 없습니다.` |
| unexpected D1/programming failure, including failed live-session logout delete | 500 | `INTERNAL_ERROR` | `서버 오류가 발생했습니다.` |

The exact status, code, message, body shape, and PBKDF2-work class for all invalid login credentials are the same. Internal reason details are not returned.

## 10. Audit and observability

### 10.1 D1 audit facts

| Event | Actor/entity | Atomicity | Allowed detail |
| --- | --- | --- | --- |
| login success | actor and entity are the authenticated user id | same batch as session issue/optional upgrade | fixed `password_upgraded` boolean only |
| create user | administrator actor and new user entity id | same batch as insert | no username, name, or submitted value |
| logout | known user id only when session deleted | best effort after authoritative deletion | no submitted value |
| self password change | current user id | same operation as CAS and revoke | no password/hash |
| admin reset | admin actor and target entity | same operation as CAS and revoke | no password/hash |
| digest-only cutover | operator actor null, system entity | same batch as immutable writer-floor activation | fixed capability, activation timestamp, merged SHA |
| read-only smoke restrict | operator actor null and fixed smoke entity | lifecycle atomic batch | fixed source/action/access state/operation id |

Credential denials and rate-limited attempts do not write D1 audit rows. This avoids turning hostile login volume into single-threaded D1 write amplification. Conversely, a login-success audit failure prevents session issuance because success facts are atomic. A logout-audit failure cannot reverse an already committed revocation.

No security decision relies on exact failure-log counts; Cloudflare rate-limit counters are the aggregate control, and sampled fixed observability events provide diagnostic signal.

### 10.2 Fixed observability events

An injected `AuthTelemetrySampler` makes sampling deterministic in tests. Production uses cryptographic randomness with probability `0.01` and emits at most one fixed event per selected denial invocation. The observability whitelist is extended with fixed, non-parameterized events for:

- sampled invalid credentials;
- sampled login rate limited;
- login limiter unavailable;
- logout audit unavailable;
- Identity unexpected failure;
- existing expired-session cleanup failure.

No event includes username, username digest, user id, IP, password, password hash, cookie, session token, session digest, D1 response, account id, or binding metadata.

These events remain only in native Cloudflare Workers Logs: no Logpush, artifact, or third-party sink is added. Access is limited to maintainers with production Cloudflare observability permission. Retention follows the account plan's native limit—currently 3 days on Workers Free or 7 days on Workers Paid, never more than 7 days—and the deployment guide records the active plan without copying log contents. See [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

### 10.3 Fixed read-only compatibility and hardening audits

Before strict credential parsing/projection serialization ships, a manual, `main`-only `identity-compatibility-v1` workflow uses the least-privilege D1 read credential and one fixed query. Its exact ordered output is:

```text
auditVersion, executedAt, gitSha, requestId,
legacyPasswordHashCount, unsupportedPasswordHashCount,
invalidIdentityProjectionCount, outcome
```

To prevent queued stale-main evidence, the workflow uses only the built-in `github.token` and immediately before the fixed query reads live remote `main`, requiring that SHA to equal `GITHUB_SHA`; it repeats the same comparison immediately after the audit command. Either mismatch fails closed. Wave 2B must re-read live remote `main` and require the same merged SHA immediately before it consumes this report.

`unsupportedPasswordHashCount` and `invalidIdentityProjectionCount` must both be zero. All three counts cover every non-deleted user, active and inactive. The projection count is positive when a row violates any public serializer invariant: positive integer id; U+0000-free username equal to its trimmed form with length 1–128; U+0000-free name equal to its trimmed form with length 1–200; exact role; `is_active IN (0, 1)`; or canonical SQLite UTC `created_at`. The report exposes only the aggregate; a positive result stops rollout for a separately approved private diagnostic/remediation path.

After migration 003, `identity-hardening-audit-v1` uses this exact ordered output:

```text
auditVersion, executedAt, gitSha, requestId,
activeLegacySessionCount, legacyPasswordHashCount,
unsupportedPasswordHashCount, invalidIdentityProjectionCount, outcome
```

After migration 004, `identity-hardening-audit-v2` adds only `smokeReadOnly` immediately before `outcome`. This sequencing avoids querying `access_mode` before that column exists.

All versions require an exact ISO timestamp, the exact 40-character lowercase merged SHA, a generated UUIDv4 request id, non-negative safe-integer counts, and `outcome = 'verified'`. They internally validate the rollout singleton; v2 additionally requires `digest-only-v1` and `read-only-v1` floors. `smokeReadOnly` is true only when exactly one active, non-deleted fixed identity has the expected username, name, `staff` role, and `read_only` access mode. `activeLegacySessionCount` uses D1 current time and counts only valid future expiries. Later audit versions retain `invalidIdentityProjectionCount` so data drift cannot silently reintroduce serializer failures.

Every audit accepts no SQL, username, role, database id, or arbitrary action input. Each validates the exact production binding and main SHA internally, but its report exposes only the fields above. Raw D1 envelopes, user/session rows, hashes, tokens, and digests are never artifacts, logs, summaries, or errors.

## 11. Production smoke identity

The fixed identity remains:

```text
username = deployment-smoke
name = Deployment Smoke
role = staff
access_mode = read_only
```

The lifecycle command gains a fixed `restrict` action. The report version advances to `production-smoke-identity-operation-v2` while preserving the exact five ordered fields `operationVersion`, `executedAt`, `databaseName`, `action`, and `outcome`. It:

1. verifies the exact fixed identity;
2. changes only `access_mode` from `standard` to `read_only` and the capability floor from `standard-only-v1` to `read-only-v1`, with an immediate non-null guard after each conditional update;
3. revokes all sessions;
4. writes a correlated fixed audit;
5. postflights exact identity, access mode, capability floor, zero sessions, and exact audit;
6. emits exactly one five-field whitelist report and no raw production response.

After the read-only transition, `provision` creates the fixed identity as `read_only`; `rotate` and `disable` preserve and verify its access mode. No lifecycle action can return it to `standard`.

After restriction, authenticated smoke version `authenticated-business-smoke-v3` performs exactly seven same-origin HTTP requests:

1. `GET /login`, requiring `200 text/html`;
2. `POST /api/auth/login` exactly once;
3. `GET /api/users/me`;
4. the existing representative purchase-order GET;
5. empty `POST /api/stock/adjust`, requiring exact `403 READ_ONLY_ACCESS` before validation;
6. `POST /api/auth/logout`;
7. `GET /api/users/me` with the old cookie, requiring exact `401 UNAUTHORIZED`.

The denial probe uses no valid mutation body and must create no business row or audit. Login is attempted once; the smoke never exercises limiter thresholds.

From 2F-a onward, authenticated smoke v2 and later also perform fixed D1 read attestations with a dedicated least-privilege `CLOUDFLARE_D1_READ_TOKEN`. They do not fall back to the deploy token. The runner validates the checked-in binding and exact remote database and executes one literal, no-input aggregate query. It returns exactly one row with exactly these ordered safe-integer fields:

```text
exact_identity_count, live_session_count, canonical_digest_session_count
```

`exact_identity_count` counts the one active/non-deleted fixed username only when name and `staff` role also match. A live row requires `unixepoch(expires_at) > unixepoch('now')`. A canonical digest row is live and additionally requires:

- `token_storage = 'digest'`;
- text `token_hash` of 64 lowercase hexadecimal characters;
- text `token` of length 43 with prefix `digest$`;
- UUID dashes at token positions 16/21/26/31, version `4` at position 22, variant `[89ab]` at position 27, and only lowercase hexadecimal characters after removing those dashes.

The strict state sequence is:

| Phase | `exact_identity_count` | `live_session_count` | `canonical_digest_session_count` |
| --- | ---: | ---: | ---: |
| before login | 1 | 0 | 0 |
| after login and business GET, before denial/logout | 1 | 1 | 1 |
| after logout | 1 | 0 | 0 |

The normal runner makes exactly one D1 target-validation call and three fixed aggregate-query calls. These control-plane calls are not part of the six/v2 or seven/v3 application-origin request count. The runner never sends the raw cookie to the D1 API or compares it in SQL. Only this three-count projection enters process logic; the raw D1 envelope never enters logs or summaries. The literal SQL and exact result decoder are snapshot-tested. After any post-login failure, `finally` attempts logout and still requires the final zero state. If cleanup or post-zero proof fails, no evidence is emitted and the next operation is verified lifecycle `disable` before retry.

The authenticated report always retains the exact seven ordered fields `smokeVersion`, `executedAt`, `gitSha`, `runId`, `runAttempt`, `target`, and `outcome`. The only version values are `authenticated-business-smoke-v1`, `authenticated-business-smoke-v2`, and `authenticated-business-smoke-v3`. Version v1 means the existing six HTTP requests passed without D1 storage attestations; v2 means those same six requests plus the required attestations passed; v3 means all seven HTTP requests plus the same attestations passed.

Read-only activation is deliberately separated from code deployment:

1. apply migration 004 and deploy the read-only-aware API, readiness v3, and lifecycle v2;
2. let the six-request authenticated smoke v2, whose business probe is GET-only, finish for the exact active version;
3. dispatch `restrict` manually and require its exact five-field evidence;
4. run `identity-hardening-audit-v2` and require `smokeReadOnly = true`;
5. only then merge the smoke-v3 denial-probe PR and require its seven-request production result.

If `restrict`, its postflight, or the aggregate check fails, the next action is the verified `disable` lifecycle operation and its exact evidence. Further deployment stops until the fixed identity is safely disabled and the failure is understood.

Once production data marks the smoke identity read-only, an old Worker would ignore the new access mode and re-enable writes. A raw-token-only Worker could also authenticate a leaked surrogate, while the 2E compatibility Worker could issue new legacy sessions. These are forward-only boundaries with no old-Worker break-glass in Wave 2. Recovery is forward repair only. If forward repair is genuinely impossible, deployment stops for a separately designed and explicitly approved incident procedure; this specification does not pre-authorize old code, session mass revocation, ad hoc SQL, or capability-floor downgrade.

## 12. Browser behavior

### 12.1 App shell

Current-user loading and dashboard/low-stock loading become independent. Inventory refresh events reload business projections but do not refetch the current user. A dashboard failure can show its own error without discarding a valid authenticated identity.

### 12.2 Login

The login screen uses the executable contract. A valid login stores no browser-readable token and navigates only after the decoded success result. An already authenticated user visiting `/login` is sent to the authenticated landing page without issuing a second session.

### 12.3 Logout

The browser does not pretend logout succeeded when the request was aborted before reaching the server. A decoded idempotent success clears authenticated state and navigates. The Wave 2 server contract has no normal logout `401`; during slices 2D–2E only, the client may treat an exact `401 UNAUTHORIZED` as logged out for compatibility with a pre-Wave 2 Worker. Slice 2F-a removes that branch and its test when old deployment credentials are revoked and the forward capability floor activates. A network, malformed, or generic server error remains visible and offers retry because a live-session delete may not have completed.

### 12.4 Settings and password UX

Admin and staff can reach the settings security section. The form:

- requires current, new, and confirmation values;
- checks confirmation locally;
- displays the server-authoritative 12-code-point policy;
- keeps `INVALID_CREDENTIALS` on the form;
- treats `AUTH_STATE_CHANGED` as a reauthentication transition;
- clears password fields after success;
- explains that other sessions were signed out and the current browser credential was safely rotated.

Only an admin loads the account-management list. The admin-reset control excludes the current admin and explains that the target's sessions will be revoked.

An admin-reset `TARGET_STATE_CHANGED` keeps the administrator authenticated, shows the fixed conflict message, and refreshes the account list. It is not passed to the session-clearing classifier used for self-change `AUTH_STATE_CHANGED`.

Login, self-change, user-create, admin-reset, and logout-error UI use associated labels, appropriate username/current/new-password autocomplete tokens, an `aria-live` status region, deterministic focus on the first invalid field or response summary, and no password value in URL, storage, log, or error telemetry at either viewport. On a wrong current password only that field is cleared and focused; on policy/confirmation errors the new fields remain for correction; on success all password fields are cleared.

## 13. Test strategy

### 13.1 Contract and credential tests

Tests cover:

- strict request and result schemas for every Identity route;
- exact status/envelope/code coherence and `INVALID_RESPONSE` on every mismatch;
- distinct session-user/admin-user projection exactness;
- path builders and positive id validation;
- malformed success and error envelopes;
- 32-KiB body, 128-code-point username, 200-code-point name, and 4,096-code-point password boundaries without truncation;
- PBKDF2 known-answer vectors in both runtime Adapters;
- exact canonical hash parsing;
- extra segments, every iteration value other than `100000`, odd/invalid/uppercase hex, incorrect salt/digest length, unknown schemes;
- Unicode code-point password policy at 11/12 and 31/32 boundaries;
- legacy SHA recognition, successful upgrade, and malformed non-legacy rejection;
- instrumentation proving exactly one SHA and one PBKDF2 call per verification class without wall-clock assertions;
- `Cache-Control: no-store` on all Identity and `Set-Cookie` responses;
- exact cookie-clear headers for presented-cookie `UNAUTHORIZED` and self-change `AUTH_STATE_CHANGED`, and their absence on logout `500`/admin target conflict.

### 13.2 D1 Identity integration tests

Real migrated Miniflare D1 tests cover:

- canonical 30-day issue and existing expiry-format compatibility;
- exact HTTPS cookie attributes and canonical lowercase UUIDv4 credential shape;
- equal missing/inactive/deleted/wrong/malformed-hash public response;
- stale login CAS triggering the deliberate guard failure and producing no session, upgrade, or success audit;
- stale legacy-login CAS still executing exactly one SHA and one PBKDF2 and discarding its upgrade candidate;
- a real audit/storage failure with unchanged observed state mapping to `500`, not a false conflict;
- self-change racing with admin reset;
- concurrent admin resets;
- unique username race mapping;
- self-change atomically revoking all old sessions, rotating the current credential, and preserving the prior absolute expiry;
- the old self-change cookie returning `401` and the replacement cookie succeeding;
- self-change conflict revoking the caller's current server-side session before `AUTH_STATE_CHANGED`;
- self-change racing with current-session logout/revoke or crossing the observed expiry boundary, returning `401` without mutation;
- admin reset revoking all target sessions;
- success-audit failure rolling back mutation and session changes;
- credential denial writing no D1 audit row;
- absent/unknown/concurrently deleted logout returning success and clearing the cookie;
- live logout audit failure leaving the session deleted;
- live logout lookup/delete failure returning `500` without clearing the cookie;
- inactive/deleted user logout deleting the matching row so later reactivation cannot revive the cookie;
- malformed cookie returning `401` instead of `500`;
- legacy and digest session lookup during compatibility;
- new Worker rejection of a digest-row surrogate and old-Worker surrogate exposure captured as a rollback-prohibition regression;
- digest-issued rows containing no raw cookie value and satisfying exact hash/surrogate shape;
- no-PII create-user audit atomicity;
- expired/invalid cleanup remaining isolated from the main response.

General business tests stop inserting raw session rows directly. A shared Identity test fixture issues an authenticated cookie through the Module or login HTTP Adapter. Operator recovery and smoke-lifecycle integration tests may keep direct session inserts because session-deletion SQL is their subject under test.

### 13.3 Limiter tests

A deterministic fake Adapter and exact configuration tests prove:

- location 100/60 and account 10/60 Adapter boundaries;
- malformed input consumes only the location budget;
- random usernames cannot bypass the location circuit breaker in the fake;
- a limited request performs no D1 lookup or PBKDF2;
- every lookup result executes the exact one-SHA/one-PBKDF2 schedule after both limiters;
- limiter failures return the fixed `503` and expose no key;
- `429` response and `Retry-After` are identical for location and account denial;
- the two distinct namespace ids, limits, periods, Worker `Env`, and test `Env` agree;
- the telemetry sampler emits only whitelisted fixed events at injected decisions.

Tests do not claim an exact production count because Cloudflare documents location-local, permissive enforcement.

### 13.4 Authorization tests

The authenticated write policy defaults to denying every non-safe method for `read_only`. Tests enumerate every current business `POST`, `PATCH`, and `DELETE` route and prove:

- `403 READ_ONLY_ACCESS` precedes malformed-body validation and entity lookup;
- no business row or audit is changed;
- business GETs still work;
- logout and self-password change remain allowed;
- staff still cannot use admin read/write intents;
- a read-only admin anomaly cannot mutate admin or business state.

The production denial probe is covered with the same exact response contract.

### 13.5 Browser tests

The pure state machine remains a `frontend/lib` test surface compatible with the current Node Vitest environment. Tests cover decoded responses; status/code/canonical-message mismatch becoming `INVALID_RESPONSE` without redirect; identity/dashboard independence; generation cancellation; shared business-error classification; navigation ordering; logout failure; authenticated `/login`; self-password success/failure; and admin-only account-management loading. Through 2E they characterize the temporary logout-401 branch; 2F-a replaces that with a regression proving the branch no longer exists.

Pure tests do not prove React wiring. A repeatable browser checklist therefore verifies the actual provider, login, app shell, staff settings, admin settings, password forms, focus/`aria-live`, stale `/me`, and redirect behavior with admin and staff identities at desktop `1280x800` and mobile `390x844`. Screenshots or a short recording are attached to the UI PR. A general persistent E2E framework remains a Wave 3 decision.

### 13.6 Migration and readiness tests

Tests apply all migrations to:

- an empty database;
- a legacy database through `001`, `002`, `003`, `004`, and `005`;
- fixtures containing legacy sessions and password hashes.

They prove old Worker SQL remains valid through additive migrations 003 and 004 while floors are inactive; migration 003 hash/storage constraints reject malformed text and a 64-byte BLOB; writer-floor activation immediately rejects legacy insert and any update of a still-legacy row, including token/expiry-only changes; the singleton rejects delete, reinsert/`INSERT OR REPLACE`, downgrade, and marker-only timestamp/SHA rewrite; migration 004 access floor cannot be downgraded; migration 005 deliberately rejects every legacy insert/update; an active-legacy fixture makes all of migration 005 roll back with rows/schema unchanged; and readiness fails when any required column, rollout-state field, or floor/retirement trigger is missing.

Readiness versions advance with schema requirements:

- `d1-required-schema-v2` after migration 003;
- `d1-required-schema-v3` after migration 004;
- `d1-required-schema-v4` after migration 005.

Smoke and readiness tests update exact expected versions in the same slice.

### 13.7 Capability, audit, and deployment evidence tests

Tests prove:

- compatibility/hardening reports have their exact versioned ordered fields and expose no row or submitted identifier;
- `invalidIdentityProjectionCount` detects every serializer-invalid fixture without identifying it;
- cutover activation is atomic/idempotent, preserves its original D1 timestamp/SHA, and cannot lower the writer floor;
- preflight rejects every writer/access capability below the stored floor and readiness matches the candidate declaration;
- an old-workflow fixture using the revoked/deleted secret name cannot reach a deploy command;
- `identity-hardening-audit-v1` occurs only after migration 003/readiness, while retirement has both pre- and post-deploy zero gates;
- the storage attestation literal SQL, exact three-count projection, `1/0/0 → 1/1/1 → 1/0/0` sequence, and cleanup failure behavior are fixed;
- lifecycle `restrict` advances the access floor atomically and its report remains exactly five fields;
- authenticated smoke v1/v2/v3 have respectively six/no-attestation, six/attestation, and seven/attestation HTTP semantics while retaining exactly seven report fields.

## 14. Delivery slices

Each slice uses a separate branch and pull request, passes the full verification gate, merges to `main`, and is allowed to complete its production workflow before the next production-affecting slice merges.

### 2A. Characterization and executable contract

- lock safe cookie, expiry, login/logout, user projection, role, and revoke behavior;
- add Identity HTTP schemas and Adapter contract tests;
- document the enumeration, CAS, logout, and session-rotation red matrix, but merge only passing characterization/contract tests—no `todo`, expected-failure, or deliberately failing CI test;
- add the fixed `identity-compatibility-v1` read-only workflow and run it against production before 2B;
- no production behavior or schema change.

Recovery: code rollback is safe.

### 2B. Portable credential and Runtime Identity extraction

- add the portable credential package and conformance corpus;
- move D1 Identity choreography behind the intent Interface;
- thin the Hono Adapter;
- change general business test authentication to the Identity fixture;
- preserve cookie, 30-day lifetime, hash write format, public behavior, and raw session storage.

Entry gate: the production compatibility report for the exact `main` SHA has `unsupportedPasswordHashCount = 0` and `invalidIdentityProjectionCount = 0`. The 2C regression cases are introduced only when their fixes make them green.

Recovery: code rollback is safe.

### 2C. Identity hardening

- guarded observed-hash CAS for login, self-change, and reset;
- self-change revoke-all plus same-expiry current-session rotation;
- equal invalid-credential response and exact one-SHA/one-PBKDF2 schedule;
- exact Cloudflare bindings/config/types and deterministic limiter fake;
- D1 success/state-change audits plus sampled fixed denial observability;
- duplicate username conflict mapping;
- authoritative-delete idempotent logout and invalid-cookie clearing;
- 32-KiB/field caps and human 12-code-point setter policy;
- repeatable Worker CPU benchmark and explicit 100,000-iteration residual-risk note.

Recovery: code rollback is safe. Existing password hashes and sessions remain compatible.

### 2D. Browser adoption and self-password UX

- decoded Identity browser Adapter;
- authenticated-session state machine and React provider/hook;
- replacement of duplicate frontend `LoginResult`/current-user/app-user types with inferred shared contract types;
- current-user/dashboard separation;
- removal of page-local blanket-401 redirects in favor of the shared classifier;
- shared security settings and admin-only account management;
- the exact desktop/mobile, admin/staff browser checklist and PR visual evidence.

Recovery: web Worker can be rolled back independently while the HTTP contract remains compatible.

### 2E. Session digest expansion and compatibility

- migration 003 and schema snapshot;
- readiness v2;
- digest-first, legacy-fallback lookup;
- dual raw+digest writes marked `legacy`;
- run `identity-hardening-audit-v1` after migration/readiness for the exact active SHA;
- production compatibility evidence.

Recovery: the prior Worker remains compatible with the additive schema and dual-written session token.

### 2F. Forward-only hardening transitions

Three ordered changes avoid coupling independent forward-only transitions:

#### 2F-a. Digest-only issuance

- provision the protected forward deploy token, revoke/delete the historical deploy credential, and test that an old-workflow fixture cannot authenticate;
- set the checked-in/runtime session-writer capability to `digest-only-v1`;
- new sessions store only a digest of the cookie credential;
- the required `token` field receives a `digest$<UUIDv4>` surrogate;
- legacy lookup remains;
- after exact active-version/readiness verification, atomically activate and evidence the persistent writer floor before authenticated login;
- authenticated smoke v2 proves the six-request login/read/logout/revoke flow with one business GET plus fixed live-session storage attestations;
- remove the temporary browser logout-401 compatibility branch and its test;
- the stored cutover marker records when the final legacy-capable writer became inactive and activates the retirement clock.

Recovery: forward repair. The 2E Worker can read digest sessions but is rejected because it can write new legacy sessions; pre-003 Workers are additionally raw-token-only readers with surrogate exposure.

#### 2F-b1. Read-only capability and lifecycle

- migration 004 and readiness v3;
- read-only authenticated write policy;
- lifecycle v2 with `restrict` and read-only-preserving `provision`/`rotate`/`disable`;
- deploy first while authenticated smoke v2 remains the six-request flow with only a business GET probe;
- after exact active-version verification, manually run `restrict`, then `identity-hardening-audit-v2`.

Recovery before `restrict`: the 2F-a Worker remains a schema-compatible target. Recovery after `restrict`: verified `disable` first, otherwise forward repair.

#### 2F-b2. Read-only denial gate

- enable authenticated smoke v3's seventh, empty `POST /api/stock/adjust` denial probe;
- require exact `403 READ_ONLY_ACCESS`, no business/audit mutation, storage attestations, logout, and revoked-cookie verification;
- retain the exact seven-field authenticated evidence shape.

Recovery: run verified `disable` when the fixed identity may be unsafe, then forward repair. No old-Worker rollback is authorized.

### 2G. Time-gated retirement

This PR is not opened until at least 30 days after immutable `digest_only_activated_at` and a fresh `identity-hardening-audit-v2` reports zero active legacy sessions.

- rerun the fixed zero-count preflight immediately before mutation;
- apply migration 005 to delete remaining legacy rows and install legacy-rejection triggers;
- advance readiness to v4;
- remove raw-token fallback;
- prove all session tests use digest storage;
- rerun the zero-count aggregate after deployment;
- remove legacy SHA verification only if its independent aggregate count is also zero; otherwise password legacy support remains as a separately tracked closeout.

Recovery: forward repair. No active legacy session is intentionally invalidated.

## 15. Verification and deployment gates

Every PR runs:

```text
npm test
npm run typecheck
npm --prefix frontend test
npm run web:lint
npm run web:build
npm run build
npm --prefix frontend run build:cloudflare
```

Migration slices also apply the full local migration chain to fresh and upgrade fixtures.

The existing production workflow remains authoritative and ordered:

1. Verify API, migrations, and web;
2. Verify remote D1 REST batch rollback;
3. Capture production recovery checkpoint;
4. run any slice-specific fixed pre-mutation compatibility/retirement gate;
5. apply production migration and deploy/verify/smoke the API at the exact merged SHA;
6. run any required post-migration audit, including v1 in 2E;
7. deploy/verify/smoke the web Worker at the exact merged SHA;
8. activate/evidence a capability floor when the slice crosses one;
9. run the versioned authenticated business/read-only flow as the literal final gate;
10. retain only the versioned exact whitelist evidence.

Before 2B, the identity compatibility report must be for the exact `main` SHA and show zero unsupported hashes and projection-invalid rows. From 2F-a onward, the final authenticated step alone receives `CLOUDFLARE_ACCOUNT_ID` and the dedicated `CLOUDFLARE_D1_READ_TOKEN` in addition to the existing smoke password; workflow structure tests prohibit the deploy token, arbitrary SQL, artifact upload, and credential output in that step.

The 2F-a deployment records the conservative legacy-writer retirement timestamp after exact active-version/readiness verification and before authenticated smoke. Every later preflight reads the D1 floor and rejects any legacy-capable writer; readiness proves the deployed capability. Historical workflow reruns lack the forward secret because the old Cloudflare token is revoked. The 2F-b1 workflow does not mutate the smoke identity automatically: verified `restrict` atomically advances the access floor, and aggregate audit remains an explicit lifecycle gate between b1 and b2.

No manual D1 console change, ad hoc production SQL, secret output, or bypass deployment is part of Wave 2.

## 16. Recovery rules

Migrations 003 and 004 are additive. Until 2F-a permits the first digest row, the previous Worker remains schema-compatible; after migration 004 it is a rollback candidate only while the smoke identity is still `standard`. Code-only rollback may be selected using the existing verified version-specific runbook within those boundaries.

After 2F-a advances the writer floor, any legacy-capable writer is prohibited. A 2E Worker would restart legacy issuance; a pre-003 Worker would also fail to resolve raw browser credentials for digest rows and could authenticate a leaked surrogate. Forward repair is the only Wave 2 recovery.

After 2F-b1 restricts the production smoke identity and advances the access floor, a pre-access-mode Worker is prohibited because it would silently remove read-only enforcement. A failed transition uses verified `disable` and forward repair, never an access-floor downgrade.

After migration 005, legacy writes are rejected by D1 and no legacy-capable Worker is a recovery candidate. Retirement failures are forward-fixed and the before/after aggregate evidence is retained.

D1 migration failure is handled by forward repair using migration history and the pre-mutation Time Travel bookmark. Automatic D1 restore remains prohibited. Exceptional Time Travel restore retains the existing incident-analysis, current-bookmark, separate-approval, and post-restore verification requirements. A restore never restores a revoked deploy token; if it regresses a rollout marker, deployment stays stopped until the current capability is reasserted through a fixed forward operation, and the 30-day retirement clock restarts from the later verified timestamp.

## 17. Documentation updates

The implementing slices update, as applicable:

- `docs/design/api-spec-v1.md` for exact Identity requests, responses, errors, cookies, password policy, and logout behavior;
- `docs/design/web-inventory-mvp-spec.md` for shared security settings and read-only access;
- `docs/design/cloudflare-deploy-guide.md` for limiter bindings, readiness/capability versions, deploy-token cutover, immutable floors, lifecycle restrict, aggregate audit, and retirement gate;
- `docs/design/er-diagram.md` for `sessions.token_hash`, `sessions.token_storage`, `users.access_mode`, `identity_rollout_state`, and retirement triggers;
- `docs/design/implementation-checklist-v1.md` for the Wave 2 gates;
- `README.md` where bootstrap password policy or operator commands are described.

## 18. Acceptance criteria

Wave 2 implementation is accepted when:

1. Hono Identity routes contain no credential-format or session/password mutation SQL;
2. the Runtime Identity Interface owns every documented Identity intent;
3. Worker and Node credential Adapters pass one conformance corpus;
4. Worker, browser, smoke, and tests reject every route-specific status/envelope/code mismatch;
5. the two public user projections are exact and expose no access, credential, or session internals;
6. every invalid login credential has one exact public result and executes exactly one SHA plus one PBKDF2/100000 derivation;
7. guarded CAS prevents stale login, self-change, and reset success, and does not misreport an unchanged-state audit failure as conflict;
8. self-password change rotates the current credential without extending expiry, revokes all old sessions, and cannot overwrite a concurrent reset;
9. logout clears the cookie for every determinate idempotent outcome, but retains it when D1 cannot establish revocation;
10. limiter checks precede D1/PBKDF2, exact config/type tests pass, and limiter failure closes only login;
11. D1 audit and sampled observability contain none of the prohibited submitted or secret fields;
12. new human password setters enforce 12 Unicode code points while recognized old credentials remain login-compatible;
13. production preflight proves there are no unsupported stored password formats or serializer-invalid identity projections before strict parsing/serialization;
14. new post-cutover sessions store no reusable cookie token in D1, and live storage attestation passes without exposing a row;
15. the immutable D1 floor plus deploy-secret rotation prevents every legacy-capable writer after 2F-a, and legacy fallback remains until the exact 30-day, zero-count, trigger, and before/after evidence gates pass;
16. the production smoke identity is `staff + read_only`, every business mutation is denied before validation, and the b1/restrict/b2 sequence passes;
17. admin and staff can change their own password through the actual browser provider at both required viewports;
18. all repository, migration, deployment, readiness, proxy, and versioned authenticated smoke gates pass for the exact merged SHA;
19. every forward-only boundary has the evidence and recovery behavior specified above.

## 19. Explicit decisions

- Strategy: staged deepening, not big-bang replacement or patch-only deferral.
- Session lifetime: unchanged 30-day absolute expiry.
- New session storage: SHA-256 digest at rest after compatibility deployment.
- Existing sessions: no migration-forced logout; successful self-password change rotates only the current browser credential and revokes the old sessions.
- Human password setters: 12 Unicode code points.
- Automation credential: 32 Unicode code points.
- Identity request safety cap: 32-KiB JSON and 4,096 password code points, with no truncation.
- PBKDF2 stored allowlist/write work factor during extraction: exact version 100,000, with a mandatory measurement/risk gate.
- Login limits: account 10/minute and per-location circuit breaker 100/minute.
- Limiter failure: login-only fail closed with 503.
- Login key: digest of trimmed case-preserving username; no IP key.
- Invalid login credentials: one exact 401 response and one-SHA/one-PBKDF2 work schedule.
- Credential-denial observability: no D1 write; fixed identifier-free event sampled at 1%.
- Logout: public and idempotent; clear on every determinate outcome, retain on D1 lookup/delete failure.
- Self admin reset: prohibited; use self-password change.
- Smoke role: remains `staff`; additive `access_mode = read_only` supplies write denial.
- Smoke activation: deploy capability, verified manual restrict, aggregate proof, then denial-gate deployment.
- Authorization architecture: narrow authenticated write policy, not generic RBAC.
- Forward-boundary enforcement: immutable D1 capability floors plus historical deploy-token revocation; no Wave 2 old-code break-glass.
- Schema recovery: additive compatibility first, then forward repair only after explicit floors advance.
- Legacy retirement: clocked from final legacy-writer inactivity, aggregate/time gated, and protected by D1 rejection triggers.

There are no unresolved design placeholders in this specification. Implementation begins only after the user reviews this written version and an implementation plan is produced from it.
