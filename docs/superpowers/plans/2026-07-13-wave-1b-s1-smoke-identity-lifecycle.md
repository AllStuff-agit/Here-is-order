# Wave 1B-S1 Smoke Identity Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely provision, rotate, and disable one fixed production `staff` identity before authenticated deployment smoke becomes mandatory.

**Architecture:** A small shared contract Module owns the immutable identity and CLI contract. A pure lifecycle Module owns D1 preflight, atomic mutation batches, exact write/postflight validation, and reconciliation; a thin GitHub-Actions-only adapter owns environment validation, Cloudflare REST wiring, safe evidence, and CLI exit behavior. A manual-only workflow serializes lifecycle mutations with main deployments.

**Tech Stack:** Node.js 22.23.1, npm 10.9.8, Node test runner, Cloudflare D1 REST API, PBKDF2-SHA256, GitHub Actions, GitHub CLI.

## Global Constraints

- Fixed identity is exactly username `deployment-smoke`, display name `Deployment Smoke`, role `staff`.
- Fixed production target is `DB` / `hereisorder` from repository `wrangler.toml`; no arbitrary username, role, database, UUID, SQL, or audit action input.
- Valid CLI invocations are exactly `provision --remote`, `rotate --remote`, and `disable --remote`.
- `provision` is create-only; it never overwrites an existing username row.
- `rotate` accepts only the exact not-deleted fixed identity, writes a new PBKDF2 hash, activates it, revokes all sessions, and audits the fact atomically.
- `disable` accepts only the exact active fixed identity, keeps the row not-deleted, revokes all sessions, and audits the fact atomically.
- Every accepted existing identity has `is_deleted = 0` and `deleted_at IS NULL`; lifecycle code rejects inconsistent soft-delete state instead of repairing or taking it over.
- Every action batch ends with a fixed-target session delete; provision verifies the new identity has zero sessions through the same contract.
- Password must contain at least 32 Unicode characters; the installed credential is 48 random bytes encoded URL-safely.
- Password/hash must never appear in argv, migration, seed, file, repository, artifact, log, summary, or public error.
- Stored password hash is never selected; postflight receives only SQL-computed `hash_matches` and `hash_scheme_ok` integers.
- Lifecycle workflow runs only by `workflow_dispatch` on `refs/heads/main`, shares main deployment concurrency, and never bypasses failure.
- No application route, schema migration, role model, session lifetime, business row, Worker rollback, or D1 restore change is in S1.

---

## File Responsibility Map

- Create `scripts/smoke-identity-contract.mjs`: immutable identity, action/argv/confirmation/password validation shared by S1 and S2.
- Create `scripts/smoke-identity-lifecycle.mjs`: fixed SQL, strict Cloudflare result projections, mutation state machine, ambiguous-write reconciliation.
- Create `scripts/manage-smoke-identity.mjs`: main-only Actions environment, production binding/client/hash wiring, whitelist report/summary, CLI.
- Create `scripts/smoke-identity-contract.test.mjs`: exact contract validation and secret-safe error behavior.
- Create `scripts/smoke-identity-lifecycle.test.mjs`: SQL/batch/preflight/write/postflight/reconciliation state-machine tests.
- Create `test/smoke-identity-lifecycle.integration.test.ts`: real Miniflare D1 transaction rollback, session revoke, audit, and Worker-login compatibility tests.
- Create `scripts/manage-smoke-identity.test.mjs`: adapter ordering, target validation, safe evidence, and redaction tests.
- Create `scripts/smoke-identity-workflow.test.mjs`: manual workflow, secret scoping, static commands, and shared concurrency contract.
- Create `.github/workflows/manage-smoke-identity.yml`: manual production lifecycle workflow only.
- Modify `.github/workflows/deploy-worker.yml`: replace workflow-name concurrency with shared repository/ref production concurrency.
- Modify `package.json`: expose the fixed operator command.
- Modify `README.md`: document the secret and two-stage rollout at operator level.
- Modify `docs/design/cloudflare-deploy-guide.md`: exact provision/rotation/disable runbook and failure handling.
- Modify `scripts/delivery-recovery-docs.test.mjs`: lock the runbook’s fixed names, ordering, and no-direct-SQL rule.

---

### Task 1: Add the immutable smoke identity contract

**Files:**

- Create: `scripts/smoke-identity-contract.mjs`
- Test: `scripts/smoke-identity-contract.test.mjs`

**Interfaces:**

- Produces: `SMOKE_IDENTITY`, `SMOKE_IDENTITY_ACTIONS`, `parseSmokeIdentityArgs(argv)`, `expectedSmokeIdentityConfirmation(action)`, `validateSmokeIdentityPassword(value)`.
- Consumed by: lifecycle adapter in Task 3 and authenticated smoke in the S2 plan.

- [ ] **Step 1: Write the failing contract tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SMOKE_IDENTITY,
  SMOKE_IDENTITY_ACTIONS,
  expectedSmokeIdentityConfirmation,
  parseSmokeIdentityArgs,
  validateSmokeIdentityPassword,
} from './smoke-identity-contract.mjs';

test('smoke identity contract is fixed and immutable', () => {
  assert.deepEqual(SMOKE_IDENTITY, {
    username: 'deployment-smoke',
    name: 'Deployment Smoke',
    role: 'staff',
    databaseBinding: 'DB',
    databaseName: 'hereisorder',
  });
  assert.equal(Object.isFrozen(SMOKE_IDENTITY), true);
  assert.deepEqual(SMOKE_IDENTITY_ACTIONS, ['provision', 'rotate', 'disable']);
  assert.equal(Object.isFrozen(SMOKE_IDENTITY_ACTIONS), true);
});

test('only exact remote lifecycle invocations are accepted', () => {
  for (const action of SMOKE_IDENTITY_ACTIONS) {
    assert.deepEqual(parseSmokeIdentityArgs([action, '--remote']), {
      action,
      remote: true,
    });
    assert.equal(
      expectedSmokeIdentityConfirmation(action),
      `MANAGE hereisorder deployment-smoke ${action}`,
    );
  }

  for (const argv of [
    [], ['provision'], ['--remote', 'provision'], ['provision', '--remote', '--remote'],
    ['status', '--remote'], ['provision', '--username', 'admin'],
  ]) {
    assert.throws(() => parseSmokeIdentityArgs(argv), /command was invalid/);
  }
  assert.throws(() => expectedSmokeIdentityConfirmation('status'), /action was invalid/);
});

test('password validation requires 32 Unicode characters without exposing the value', () => {
  const secret = `sensitive-${'가'.repeat(22)}`;
  assert.equal(Array.from(secret).length, 32);
  assert.equal(validateSmokeIdentityPassword(secret), secret);
  for (const value of [undefined, '', 'x'.repeat(31), `valid${String.fromCharCode(0)}secret${'x'.repeat(32)}`]) {
    assert.throws(
      () => validateSmokeIdentityPassword(value),
      (error) => error.message === 'Smoke identity password was invalid.'
        && !error.message.includes(String(value)),
    );
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/smoke-identity-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `smoke-identity-contract.mjs`.

- [ ] **Step 3: Implement the minimal immutable contract**

```js
export const SMOKE_IDENTITY = Object.freeze({
  username: 'deployment-smoke',
  name: 'Deployment Smoke',
  role: 'staff',
  databaseBinding: 'DB',
  databaseName: 'hereisorder',
});

export const SMOKE_IDENTITY_ACTIONS = Object.freeze([
  'provision',
  'rotate',
  'disable',
]);

export function parseSmokeIdentityArgs(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 2
    || argv[1] !== '--remote'
    || !SMOKE_IDENTITY_ACTIONS.includes(argv[0])) {
    throw new Error('Smoke identity command was invalid.');
  }
  return Object.freeze({ action: argv[0], remote: true });
}

export function expectedSmokeIdentityConfirmation(action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity action was invalid.');
  }
  return `MANAGE ${SMOKE_IDENTITY.databaseName} ${SMOKE_IDENTITY.username} ${action}`;
}

export function validateSmokeIdentityPassword(value) {
  if (typeof value !== 'string'
    || Array.from(value).length < 32
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Smoke identity password was invalid.');
  }
  return value;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test scripts/smoke-identity-contract.test.mjs`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit the contract**

```bash
git add scripts/smoke-identity-contract.mjs scripts/smoke-identity-contract.test.mjs
git commit -m "feat: define production smoke identity contract"
```

---

### Task 2: Implement the fail-closed D1 lifecycle state machine

**Files:**

- Create: `scripts/smoke-identity-lifecycle.mjs`
- Test: `scripts/smoke-identity-lifecycle.test.mjs`

**Interfaces:**

- Consumes: `SMOKE_IDENTITY` and `SMOKE_IDENTITY_ACTIONS` from Task 1.
- Produces: `buildSmokeIdentityPreflightQuery()`, `parseSmokeIdentityPreflight(results, action)`, `buildSmokeIdentityMutation({ action, target, passwordHash })`, `assertSmokeIdentityWrite(results, action)`, `buildSmokeIdentityPostflightQuery({ action, target, passwordHash })`, `assertSmokeIdentityPostflight(results, { action, auditJson })`, `runSmokeIdentityLifecycle({ client, databaseId, action, passwordHash })`.

- [ ] **Step 1: Write failing preflight and mutation-contract tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSmokeIdentityMutation,
  buildSmokeIdentityPreflightQuery,
  parseSmokeIdentityPreflight,
} from './smoke-identity-lifecycle.mjs';

const HASH = `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const ACTIVE_ROW = {
  id: 41,
  username: 'deployment-smoke',
  name: 'Deployment Smoke',
  role: 'staff',
  is_active: 1,
  is_deleted: 0,
  deleted_at: null,
};
const queryResult = (rows) => [{ success: true, results: rows, meta: {} }];

test('preflight uses one fixed parameterized username query', () => {
  assert.deepEqual(buildSmokeIdentityPreflightQuery(), {
    sql: `SELECT id, username, name, role, is_active, is_deleted, deleted_at
            FROM users
           WHERE username = ?`,
    params: ['deployment-smoke'],
  });
  assert.equal(parseSmokeIdentityPreflight(queryResult([]), 'provision'), null);
  assert.deepEqual(
    parseSmokeIdentityPreflight(queryResult([ACTIVE_ROW]), 'rotate'),
    { id: 41, observedActive: 1 },
  );
  assert.deepEqual(
    parseSmokeIdentityPreflight(queryResult([ACTIVE_ROW]), 'disable'),
    { id: 41, observedActive: 1 },
  );
});

test('preflight rejects conflict, takeover, malformed and already-disabled states', () => {
  const disabled = { ...ACTIVE_ROW, is_active: 0 };
  const invalidRows = [
    { ...ACTIVE_ROW, username: 'other' },
    { ...ACTIVE_ROW, name: 'Admin' },
    { ...ACTIVE_ROW, role: 'admin' },
    { ...ACTIVE_ROW, is_deleted: 1 },
    { ...ACTIVE_ROW, deleted_at: '2026-07-13 18:00:00' },
    { ...ACTIVE_ROW, is_active: 2 },
  ];
  assert.throws(() => parseSmokeIdentityPreflight(queryResult([ACTIVE_ROW]), 'provision'));
  assert.deepEqual(
    parseSmokeIdentityPreflight(queryResult([disabled]), 'rotate'),
    { id: 41, observedActive: 0 },
  );
  assert.throws(() => parseSmokeIdentityPreflight(queryResult([disabled]), 'disable'));
  for (const row of invalidRows) {
    assert.throws(() => parseSmokeIdentityPreflight(queryResult([row]), 'rotate'));
  }
  for (const malformed of [null, [], [{ success: false }], queryResult([ACTIVE_ROW, ACTIVE_ROW])]) {
    assert.throws(() => parseSmokeIdentityPreflight(malformed, 'rotate'));
  }
});

test('rotate batch performs exact CAS update, session revoke and fixed audit', () => {
  const mutation = buildSmokeIdentityMutation({
    action: 'rotate',
    target: { id: 41, observedActive: 0 },
    passwordHash: HASH,
  });
  assert.equal(mutation.batch.length, 3);
  assert.match(mutation.batch[0].sql, /^UPDATE users SET password_hash = \?/);
  assert.match(mutation.batch[0].sql, /id = \? AND username = \? AND name = \?/);
  assert.match(mutation.batch[0].sql, /role = 'staff' AND is_active = \? AND is_deleted = 0/);
  assert.match(mutation.batch[0].sql, /deleted_at IS NULL/);
  assert.deepEqual(mutation.batch[0].params, [
    HASH, 41, 'deployment-smoke', 'Deployment Smoke', 0,
  ]);
  assert.match(mutation.batch[1].sql, /rotate_smoke_identity/);
  assert.deepEqual(mutation.batch[2], {
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    params: [41],
  });
  assert.equal(JSON.parse(mutation.auditJson).active, true);
  assert.equal(JSON.stringify(mutation).includes('admin'), false);
  const provision = buildSmokeIdentityMutation({
    action: 'provision', target: null, passwordHash: HASH,
  });
  assert.equal(provision.batch.length, 3);
  assert.match(provision.batch[1].sql, /CASE\s+WHEN changes\(\) = 1/);
  assert.match(provision.batch[1].sql, /SELECT COUNT\(\*\) FROM users/);
  assert.match(provision.batch[1].sql, /ELSE NULL/);
  assert.match(provision.batch[2].sql, /^DELETE FROM sessions/);
  assert.match(mutation.batch[1].sql, /CASE\s+WHEN changes\(\) = 1/);
  assert.match(mutation.batch[1].sql, /SELECT COUNT\(\*\) FROM users/);
  assert.match(mutation.batch[1].sql, /ELSE NULL/);
  assert.throws(() => buildSmokeIdentityMutation({
    action: 'disable', target: { id: 41, observedActive: 0 }, passwordHash: undefined,
  }));
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test scripts/smoke-identity-lifecycle.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement fixed SQL builders and strict preflight projection**

Use these exact fixed predicates and audit facts:

```js
import { SMOKE_IDENTITY, SMOKE_IDENTITY_ACTIONS } from './smoke-identity-contract.mjs';

const HASH_PATTERN = /^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const AUDIT_ACTIONS = Object.freeze({
  provision: 'provision_smoke_identity',
  rotate: 'rotate_smoke_identity',
  disable: 'disable_smoke_identity',
});

export function buildSmokeIdentityPreflightQuery() {
  return {
    sql: `SELECT id, username, name, role, is_active, is_deleted, deleted_at
            FROM users
           WHERE username = ?`,
    params: [SMOKE_IDENTITY.username],
  };
}

function exactRows(results, message) {
  if (!Array.isArray(results)
    || results.length !== 1
    || results[0]?.success !== true
    || !Array.isArray(results[0].results)) {
    throw new Error(message);
  }
  return results[0].results;
}

export function parseSmokeIdentityPreflight(results, action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity preflight was invalid.');
  }
  const rows = exactRows(results, 'Smoke identity preflight was invalid.');
  if (action === 'provision') {
    if (rows.length !== 0) throw new Error('Smoke identity preflight was invalid.');
    return null;
  }
  if (rows.length !== 1) throw new Error('Smoke identity preflight was invalid.');
  const row = rows[0];
  if (!row
    || Object.keys(row).sort().join(',') !== 'deleted_at,id,is_active,is_deleted,name,role,username'
    || !Number.isSafeInteger(row.id)
    || row.id <= 0
    || row.username !== SMOKE_IDENTITY.username
    || row.name !== SMOKE_IDENTITY.name
    || row.role !== SMOKE_IDENTITY.role
    || ![0, 1].includes(row.is_active)
    || row.is_deleted !== 0
    || row.deleted_at !== null
    || (action === 'disable' && row.is_active !== 1)) {
    throw new Error('Smoke identity preflight was invalid.');
  }
  return Object.freeze({ id: row.id, observedActive: row.is_active });
}
```

Implement `buildSmokeIdentityMutation` with the following exact shapes:

```js
function auditJson(active) {
  return JSON.stringify({
    source: 'deployment_smoke_operator',
    username: SMOKE_IDENTITY.username,
    role: SMOKE_IDENTITY.role,
    active,
  });
}

export function buildSmokeIdentityMutation({ action, target, passwordHash }) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const needsHash = action !== 'disable';
  if ((needsHash && !HASH_PATTERN.test(passwordHash))
    || (!needsHash && passwordHash !== undefined)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const afterJson = auditJson(action !== 'disable');
  if (action === 'provision') {
    if (target !== null) throw new Error('Smoke identity mutation was invalid.');
    return Object.freeze({
      auditJson: afterJson,
      batch: Object.freeze([
        {
          sql: `INSERT INTO users
                  (username, password_hash, name, role, is_active, is_deleted, deleted_at)
                SELECT ?, ?, ?, 'staff', 1, 0, NULL
                 WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ?)`,
          params: [SMOKE_IDENTITY.username, passwordHash, SMOKE_IDENTITY.name, SMOKE_IDENTITY.username],
        },
        {
          sql: `INSERT INTO audit_logs
                  (actor_user_id, action, entity_type, entity_id, before_json, after_json)
                VALUES (
                  NULL,
                  CASE
                    WHEN changes() = 1 AND (
                      SELECT COUNT(*) FROM users
                       WHERE username = ? AND name = ? AND role = 'staff'
                         AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL
                    ) = 1
                    THEN 'provision_smoke_identity'
                    ELSE NULL
                  END,
                  'user',
                  (SELECT id FROM users
                    WHERE username = ? AND name = ? AND role = 'staff'
                      AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL),
                  NULL, ?
                )`,
          params: [
            SMOKE_IDENTITY.username, SMOKE_IDENTITY.name,
            SMOKE_IDENTITY.username, SMOKE_IDENTITY.name, afterJson,
          ],
        },
        {
          sql: `DELETE FROM sessions
                 WHERE user_id = (
                   SELECT id FROM users
                    WHERE username = ? AND name = ? AND role = 'staff'
                      AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL
                 )`,
          params: [SMOKE_IDENTITY.username, SMOKE_IDENTITY.name],
        },
      ]),
    });
  }

  if (!target
    || !Number.isSafeInteger(target.id)
    || target.id <= 0
    || ![0, 1].includes(target.observedActive)
    || (action === 'disable' && target.observedActive !== 1)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const update = action === 'rotate'
    ? {
        sql: `UPDATE users SET password_hash = ?, is_active = 1,
                  updated_at = datetime('now')
                WHERE id = ? AND username = ? AND name = ?
                  AND role = 'staff' AND is_active = ? AND is_deleted = 0
                  AND deleted_at IS NULL`,
        params: [passwordHash, target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name, target.observedActive],
      }
    : {
        sql: `UPDATE users SET is_active = 0, updated_at = datetime('now')
                WHERE id = ? AND username = ? AND name = ?
                  AND role = 'staff' AND is_active = 1 AND is_deleted = 0
                  AND deleted_at IS NULL`,
        params: [target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name],
      };
  const resultingActive = action === 'disable' ? 0 : 1;
  return Object.freeze({
    auditJson: afterJson,
    batch: Object.freeze([
      update,
      {
        sql: `INSERT INTO audit_logs
                (actor_user_id, action, entity_type, entity_id, before_json, after_json)
              VALUES (
                NULL,
                CASE
                  WHEN changes() = 1 AND (
                    SELECT COUNT(*) FROM users
                     WHERE id = ? AND username = ? AND name = ?
                       AND role = 'staff' AND is_active = ? AND is_deleted = 0
                       AND deleted_at IS NULL
                  ) = 1
                  THEN '${AUDIT_ACTIONS[action]}'
                  ELSE NULL
                END,
                'user', ?, NULL, ?
              )`,
        params: [
          target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name,
          resultingActive, target.id, afterJson,
        ],
      },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [target.id] },
    ]),
  });
}
```

Both audit statements deliberately assign `NULL` to `audit_logs.action` when the immediately preceding user mutation did not change exactly one exact target. The `NOT NULL` constraint aborts and rolls back the entire D1 batch instead of committing a partial user/session mutation.

- [ ] **Step 4: Run tests and verify the preflight/mutation slice is GREEN**

Run: `node --test --test-name-pattern='preflight|rotate batch' scripts/smoke-identity-lifecycle.test.mjs`

Expected: selected tests pass, 0 fail.

- [ ] **Step 5: Add failing write/postflight/reconciliation tests**

Replace the lifecycle import in `scripts/smoke-identity-lifecycle.test.mjs` with the complete Task 2 interface before adding the tests:

```js
import {
  assertSmokeIdentityPostflight,
  assertSmokeIdentityWrite,
  buildSmokeIdentityMutation,
  buildSmokeIdentityPostflightQuery,
  buildSmokeIdentityPreflightQuery,
  parseSmokeIdentityPreflight,
  runSmokeIdentityLifecycle,
} from './smoke-identity-lifecycle.mjs';
```

```js
test('write validation requires exact statement count and exact changed rows', () => {
  const ok = (changes) => ({ success: true, results: [], meta: { changes } });
  assert.doesNotThrow(() => assertSmokeIdentityWrite([ok(1), ok(1), ok(0)], 'provision'));
  assert.doesNotThrow(() => assertSmokeIdentityWrite([ok(1), ok(1), ok(4)], 'rotate'));
  assert.doesNotThrow(() => assertSmokeIdentityWrite([ok(1), ok(1), ok(0)], 'disable'));
  assert.throws(() => assertSmokeIdentityWrite([ok(1), ok(1), ok(0)], 'status'));
  for (const value of [[], [ok(0), ok(1), ok(0)], [ok(1), ok(0), ok(0)], [ok(1), ok(-1), ok(1)]]) {
    assert.throws(() => assertSmokeIdentityWrite(value, 'rotate'));
  }
});

test('postflight compares hash only through booleans and requires zero sessions and exact audit', () => {
  const mutation = buildSmokeIdentityMutation({ action: 'rotate', target: { id: 41, observedActive: 1 }, passwordHash: HASH });
  const query = buildSmokeIdentityPostflightQuery({
    action: 'rotate', target: { id: 41, observedActive: 1 }, passwordHash: HASH,
  });
  assert.equal(query.sql.includes('password_hash = ? AS hash_matches'), true);
  assert.equal(query.sql.includes('password_hash,'), false);
  const row = {
    ...ACTIVE_ROW,
    hash_matches: 1,
    hash_scheme_ok: 1,
    session_count: 0,
    latest_audit_action: 'rotate_smoke_identity',
    latest_audit_actor_user_id: null,
    latest_audit_before_json: null,
    latest_audit_after_json: mutation.auditJson,
  };
  assert.doesNotThrow(() => assertSmokeIdentityPostflight(queryResult([row]), {
    action: 'rotate', auditJson: mutation.auditJson,
  }));
  for (const patch of [{ hash_matches: 0 }, { hash_scheme_ok: 0 }, { session_count: 1 }, { latest_audit_after_json: '{}' }]) {
    assert.throws(() => assertSmokeIdentityPostflight(queryResult([{ ...row, ...patch }]), {
      action: 'rotate', auditJson: mutation.auditJson,
    }));
  }
  assert.throws(() => buildSmokeIdentityPostflightQuery({
    action: 'status', target: { id: 41, observedActive: 1 }, passwordHash: HASH,
  }));
});

test('ambiguous write succeeds only when exact postflight proves intended state', async () => {
  const calls = [];
  const mutation = buildSmokeIdentityMutation({ action: 'rotate', target: { id: 41, observedActive: 1 }, passwordHash: HASH });
  const client = {
    async query(_databaseId, body) {
      calls.push(body);
      if (calls.length === 1) return queryResult([ACTIVE_ROW]);
      if (calls.length === 2) {
        const error = new Error('sensitive transport detail');
        Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
        throw error;
      }
      return queryResult([{
        ...ACTIVE_ROW, hash_matches: 1, hash_scheme_ok: 1,
        session_count: 0,
        latest_audit_action: 'rotate_smoke_identity', latest_audit_actor_user_id: null,
        latest_audit_before_json: null, latest_audit_after_json: mutation.auditJson,
      }]);
    },
  };
  await assert.doesNotReject(runSmokeIdentityLifecycle({
    client, databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839', action: 'rotate', passwordHash: HASH,
  }));
  assert.equal(calls.length, 3);

  let mismatchCalls = 0;
  client.query = async (_databaseId, body) => {
    mismatchCalls += 1;
    if (body.sql?.startsWith('SELECT id, username')) return queryResult([ACTIVE_ROW]);
    if (body.batch) {
      const error = new Error('sensitive ambiguous write detail');
      Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
      throw error;
    }
    return queryResult([{
      ...ACTIVE_ROW, hash_matches: 0, hash_scheme_ok: 1, session_count: 0,
      latest_audit_action: 'rotate_smoke_identity', latest_audit_actor_user_id: null,
      latest_audit_before_json: null, latest_audit_after_json: mutation.auditJson,
    }]);
  };
  await assert.rejects(
    runSmokeIdentityLifecycle({ client, databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839', action: 'rotate', passwordHash: HASH }),
    (error) => error.message === 'Smoke identity lifecycle failed.' && !error.message.includes('sensitive'),
  );
  assert.equal(mismatchCalls, 3);

  let nonAmbiguousCalls = 0;
  client.query = async (_databaseId, body) => {
    nonAmbiguousCalls += 1;
    if (body.sql?.startsWith('SELECT id, username')) return queryResult([ACTIVE_ROW]);
    throw new Error('sensitive non-ambiguous write detail');
  };
  await assert.rejects(
    runSmokeIdentityLifecycle({ client, databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839', action: 'rotate', passwordHash: HASH }),
    (error) => error.message === 'Smoke identity lifecycle failed.' && !error.message.includes('sensitive'),
  );
  assert.equal(nonAmbiguousCalls, 2);
});
```

- [ ] **Step 6: Implement write validation, boolean-only postflight, and reconciliation**

```js
export function assertSmokeIdentityWrite(results, action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)
    || !Array.isArray(results)
    || results.length !== 3
    || results.some((result) => result?.success !== true
      || !Number.isSafeInteger(result.meta?.changes)
      || result.meta.changes < 0)
    || results[0].meta.changes !== 1
    || results[1].meta.changes !== 1) {
    throw new Error('Smoke identity write result was invalid.');
  }
}

export function buildSmokeIdentityPostflightQuery({ action, target, passwordHash }) {
  const targetIsValid = action === 'provision'
    ? target === null
    : target
      && Number.isSafeInteger(target.id)
      && target.id > 0
      && [0, 1].includes(target.observedActive)
      && (action !== 'disable' || target.observedActive === 1);
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)
    || !targetIsValid
    || (action === 'disable' && passwordHash !== undefined)
    || (action !== 'disable' && !HASH_PATTERN.test(passwordHash))) {
    throw new Error('Smoke identity postflight was invalid.');
  }
  const where = target?.id
    ? 'u.id = ? AND u.username = ?'
    : 'u.username = ?';
  const identityParams = target?.id
    ? [target.id, SMOKE_IDENTITY.username]
    : [SMOKE_IDENTITY.username];
  const hashProjection = action === 'disable'
    ? ''
    : `, u.password_hash = ? AS hash_matches,
         instr(u.password_hash, ?) = 1 AS hash_scheme_ok`;
  const params = action === 'disable'
    ? identityParams
    : [passwordHash, 'pbkdf2_sha256$100000$', ...identityParams];
  return {
    sql: `SELECT u.id, u.username, u.name, u.role, u.is_active, u.is_deleted, u.deleted_at
                 ${hashProjection},
                 (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
                 (SELECT action FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_action,
                 (SELECT actor_user_id FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_actor_user_id,
                 (SELECT before_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_before_json,
                 (SELECT after_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_after_json
            FROM users u WHERE ${where}`,
    params,
  };
}

export function assertSmokeIdentityPostflight(results, { action, auditJson }) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action) || typeof auditJson !== 'string') {
    throw new Error('Smoke identity postflight was invalid.');
  }
  const rows = exactRows(results, 'Smoke identity postflight was invalid.');
  if (rows.length !== 1) throw new Error('Smoke identity postflight was invalid.');
  const row = rows[0];
  const expectedActive = action === 'disable' ? 0 : 1;
  const expectedKeys = action === 'disable'
    ? [
        'id', 'username', 'name', 'role', 'is_active', 'is_deleted', 'session_count',
        'deleted_at',
        'latest_audit_action', 'latest_audit_actor_user_id',
        'latest_audit_before_json', 'latest_audit_after_json',
      ]
    : [
        'id', 'username', 'name', 'role', 'is_active', 'is_deleted',
        'deleted_at',
        'hash_matches', 'hash_scheme_ok', 'session_count',
        'latest_audit_action', 'latest_audit_actor_user_id',
        'latest_audit_before_json', 'latest_audit_after_json',
      ];
  if (!row
    || Object.keys(row).sort().join(',') !== expectedKeys.sort().join(',')
    || !Number.isSafeInteger(row.id)
    || row.id <= 0
    || row.username !== SMOKE_IDENTITY.username
    || row.name !== SMOKE_IDENTITY.name
    || row.role !== SMOKE_IDENTITY.role
    || row.is_active !== expectedActive
    || row.is_deleted !== 0
    || row.deleted_at !== null
    || row.session_count !== 0
    || row.latest_audit_action !== AUDIT_ACTIONS[action]
    || row.latest_audit_actor_user_id !== null
    || row.latest_audit_before_json !== null
    || row.latest_audit_after_json !== auditJson
    || (action !== 'disable' && (row.hash_matches !== 1 || row.hash_scheme_ok !== 1))) {
    throw new Error('Smoke identity postflight was invalid.');
  }
  return Object.freeze({ id: row.id, active: row.is_active === 1 });
}

export async function runSmokeIdentityLifecycle({ client, databaseId, action, passwordHash }) {
  try {
    if (!client || typeof client.query !== 'function') throw new Error('invalid client');
    const target = parseSmokeIdentityPreflight(
      await client.query(databaseId, buildSmokeIdentityPreflightQuery()),
      action,
    );
    const mutation = buildSmokeIdentityMutation({ action, target, passwordHash });
    try {
      assertSmokeIdentityWrite(
        await client.query(databaseId, { batch: mutation.batch }),
        action,
      );
    } catch (error) {
      let mayHaveSucceeded = false;
      try {
        mayHaveSucceeded = error?.requestMayHaveSucceeded === true;
      } catch {
        mayHaveSucceeded = false;
      }
      if (!mayHaveSucceeded) throw error;
    }
    const postflight = buildSmokeIdentityPostflightQuery({
      action, target, passwordHash,
    });
    return assertSmokeIdentityPostflight(
      await client.query(databaseId, { sql: postflight.sql, params: postflight.params }),
      { action, auditJson: mutation.auditJson },
    );
  } catch {
    throw new Error('Smoke identity lifecycle failed.');
  }
}
```

- [ ] **Step 7: Run lifecycle tests and verify GREEN**

Run: `node --test scripts/smoke-identity-contract.test.mjs scripts/smoke-identity-lifecycle.test.mjs`

Expected: all contract/lifecycle tests pass; the tests assert that no stored hash column or sensitive error detail is returned.

- [ ] **Step 8: Add real-D1 atomicity integration tests**

Create `test/smoke-identity-lifecycle.integration.test.ts`. Use `env.DB`, clear `sessions`, `audit_logs`, and `users` before each test, convert each `{ sql, params }` entry to `env.DB.prepare(sql).bind(...params)`, and cover these exact cases:

```ts
it('lost rotate CAS rolls back audit and preserves every existing session', async () => {
  const passwordHash = createPasswordHash('x'.repeat(64), Buffer.alloc(16, 7));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', 1, 0)`,
  ).bind(passwordHash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('preserved-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();

  const mutation = buildSmokeIdentityMutation({
    action: 'rotate',
    target: { id: userId, observedActive: 0 },
    passwordHash: createPasswordHash('y'.repeat(64), Buffer.alloc(16, 8)),
  });
  await expect(env.DB.batch(mutation.batch.map(({ sql, params }) =>
    env.DB.prepare(sql).bind(...params)))).rejects.toThrow();

  const state = await env.DB.prepare(
    `SELECT u.is_active,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.entity_id = u.id) AS audit_count
       FROM users u WHERE u.id = ?`,
  ).bind(userId).first();
  expect(state).toEqual({ is_active: 1, session_count: 1, audit_count: 0 });
});
```

Use these exact sibling tests. A small local helper converts the fixed statement objects to D1 prepared statements.

```ts
import { env, exports } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';

import { createPasswordHash } from '../scripts/generate-admin-seed.mjs';
import { buildSmokeIdentityMutation } from '../scripts/smoke-identity-lifecycle.mjs';

beforeEach(async () => {
  await env.DB.batch([
    'stock_transactions', 'order_items', 'audit_logs', 'sessions',
    'purchase_orders', 'items', 'item_categories', 'users',
  ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

const executeMutation = (mutation: ReturnType<typeof buildSmokeIdentityMutation>) =>
  env.DB.batch(mutation.batch.map(({ sql, params }) =>
    env.DB.prepare(sql).bind(...params)));

it('provision creates one exact active staff row and one operator audit', async () => {
  const hash = createPasswordHash('x'.repeat(64), Buffer.alloc(16, 1));
  const mutation = buildSmokeIdentityMutation({ action: 'provision', target: null, passwordHash: hash });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT username, name, role, is_active, is_deleted, deleted_at,
            password_hash = ? AS hash_matches,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
            (SELECT action FROM audit_logs a WHERE a.entity_id = u.id ORDER BY a.id DESC LIMIT 1) AS audit_action,
            (SELECT after_json FROM audit_logs a WHERE a.entity_id = u.id ORDER BY a.id DESC LIMIT 1) AS audit_after
       FROM users u WHERE username = ?`,
  ).bind(hash, 'deployment-smoke').first();
  expect(row).toEqual({
    username: 'deployment-smoke', name: 'Deployment Smoke', role: 'staff',
    is_active: 1, is_deleted: 0, deleted_at: null, hash_matches: 1, session_count: 0,
    audit_action: 'provision_smoke_identity', audit_after: mutation.auditJson,
  });
});

it.each([0, 1])('rotate from active=%i writes the new hash and revokes all sessions', async (isActive) => {
  const oldHash = createPasswordHash('x'.repeat(64), Buffer.alloc(16, 2));
  const nextHash = createPasswordHash('y'.repeat(64), Buffer.alloc(16, 3));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', ?, 0)`,
  ).bind(oldHash, isActive).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES
       ('rotate-one', ?, datetime('now', '+1 hour')),
       ('rotate-two', ?, datetime('now', '+1 hour'))`,
  ).bind(userId, userId).run();
  const mutation = buildSmokeIdentityMutation({
    action: 'rotate', target: { id: userId, observedActive: isActive }, passwordHash: nextHash,
  });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT is_active, password_hash = ? AS hash_matches,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1) AS audit_action
       FROM users WHERE id = ?`,
  ).bind(nextHash, userId, userId, userId).first();
  expect(row).toEqual({
    is_active: 1, hash_matches: 1, session_count: 0,
    audit_action: 'rotate_smoke_identity',
  });
});

it('disable preserves the hash, deactivates the row and revokes all sessions', async () => {
  const hash = createPasswordHash('x'.repeat(64), Buffer.alloc(16, 4));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', 1, 0)`,
  ).bind(hash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('disable-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();
  const mutation = buildSmokeIdentityMutation({
    action: 'disable', target: { id: userId, observedActive: 1 }, passwordHash: undefined,
  });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT is_active, password_hash = ? AS hash_preserved,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1) AS audit_action
       FROM users WHERE id = ?`,
  ).bind(hash, userId, userId, userId).first();
  expect(row).toEqual({
    is_active: 0, hash_preserved: 1, session_count: 0,
    audit_action: 'disable_smoke_identity',
  });
});

it('audit insert failure rolls back the user update and preserves the session', async () => {
  const oldHash = createPasswordHash('x'.repeat(64), Buffer.alloc(16, 5));
  const nextHash = createPasswordHash('y'.repeat(64), Buffer.alloc(16, 6));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff')`,
  ).bind(oldHash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('audit-failure-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();
  await env.DB.prepare(
    `CREATE TRIGGER test_fail_smoke_audit BEFORE INSERT ON audit_logs
     WHEN NEW.action = 'rotate_smoke_identity'
     BEGIN SELECT RAISE(ABORT, 'TEST_FAIL_SMOKE_AUDIT'); END`,
  ).run();
  try {
    const mutation = buildSmokeIdentityMutation({
      action: 'rotate', target: { id: userId, observedActive: 1 }, passwordHash: nextHash,
    });
    await expect(executeMutation(mutation)).rejects.toThrow();
  } finally {
    await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_smoke_audit').run();
  }
  const row = await env.DB.prepare(
    `SELECT password_hash = ? AS old_hash_preserved,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT COUNT(*) FROM audit_logs WHERE entity_id = ?) AS audit_count
       FROM users WHERE id = ?`,
  ).bind(oldHash, userId, userId, userId).first();
  expect(row).toEqual({ old_hash_preserved: 1, session_count: 1, audit_count: 0 });
});

it('provisioned Node hash authenticates through the real Worker as staff', async () => {
  const password = 'x'.repeat(64);
  const hash = createPasswordHash(password, Buffer.alloc(16, 9));
  await executeMutation(buildSmokeIdentityMutation({
    action: 'provision', target: null, passwordHash: hash,
  }));
  const response = await exports.default.fetch(new Request('https://example.com/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'deployment-smoke', password }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: { user: { username: 'deployment-smoke', name: 'Deployment Smoke', role: 'staff' } },
  });
});
```

Do not select or print the stored hash except SQL equality booleans.

- [ ] **Step 9: Run the integration safety verification**

Run: `npm exec -- vitest run test/smoke-identity-lifecycle.integration.test.ts`

Expected: all integration cases pass. The lost-CAS and trigger cases prove that the guarded audit aborts the batch and leaves user/session/audit state unchanged. Do not weaken production code merely to manufacture a RED result after the unit-driven guarded implementation already exists.

- [ ] **Step 10: Commit the lifecycle state machine**

```bash
git add scripts/smoke-identity-lifecycle.mjs scripts/smoke-identity-lifecycle.test.mjs test/smoke-identity-lifecycle.integration.test.ts
git commit -m "feat: manage smoke identity lifecycle atomically"
```

---

### Task 3: Add the main-only operator adapter and safe evidence

**Files:**

- Create: `scripts/manage-smoke-identity.mjs`
- Test: `scripts/manage-smoke-identity.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 1 contract, Task 2 `runSmokeIdentityLifecycle`, existing `createCloudflareD1RestClient`, `createPasswordHash`, and `readProductionD1Binding`.
- Produces: `parseSmokeIdentityEnvironment({ env, action })`, `assertSmokeIdentityRemoteTarget(matches, binding)`, `buildSmokeIdentityOperationReport(input)`, `renderSmokeIdentityOperationSummary(report)`, `runManageSmokeIdentity(options)` and one of the three literal CLI commands ending in `provision --remote`, `rotate --remote`, or `disable --remote`.

- [ ] **Step 1: Write failing adapter tests**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSmokeIdentityRemoteTarget,
  buildSmokeIdentityOperationReport,
  parseSmokeIdentityEnvironment,
  renderSmokeIdentityOperationSummary,
  runManageSmokeIdentity,
} from './manage-smoke-identity.mjs';

const PASSWORD = 'x'.repeat(64);
const BASE_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'cloudflare-token-sensitive',
  PRODUCTION_SMOKE_PASSWORD: PASSWORD,
  SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke provision',
  GITHUB_STEP_SUMMARY: '/tmp/smoke-summary.md',
};

test('environment is exact main workflow_dispatch and disable rejects password exposure', () => {
  const parsed = parseSmokeIdentityEnvironment({ env: BASE_ENV, action: 'provision' });
  assert.equal(parsed.password, PASSWORD);
  assert.equal(parsed.accountId, 'a'.repeat(32));

  for (const patch of [
    { CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_RUN_ID: '0' },
    { SMOKE_IDENTITY_CONFIRMATION: 'wrong' }, { GITHUB_STEP_SUMMARY: 'relative.md' },
  ]) {
    assert.throws(() => parseSmokeIdentityEnvironment({ env: { ...BASE_ENV, ...patch }, action: 'provision' }));
  }
  assert.throws(() => parseSmokeIdentityEnvironment({
    env: { ...BASE_ENV, SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke disable' },
    action: 'disable',
  }));
  const { PRODUCTION_SMOKE_PASSWORD: _removed, ...withoutPassword } = BASE_ENV;
  assert.doesNotThrow(() => parseSmokeIdentityEnvironment({
    env: { ...withoutPassword, SMOKE_IDENTITY_CONFIRMATION: 'MANAGE hereisorder deployment-smoke disable' },
    action: 'disable',
  }));
});

test('validation precedes config, hashing, client and fetch', async () => {
  const calls = [];
  await assert.rejects(runManageSmokeIdentity({
    argv: ['provision'],
    env: {},
    readBinding: () => calls.push('binding'),
    createHash: () => calls.push('hash'),
    createClient: () => calls.push('client'),
  }), /operation failed/);
  assert.deepEqual(calls, []);
});

test('remote D1 exact-name lookup must match the configured UUID', () => {
  const binding = {
    binding: 'DB', databaseName: 'hereisorder',
    databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
  };
  assert.deepEqual(assertSmokeIdentityRemoteTarget([
    { name: 'hereisorder', uuid: binding.databaseId },
  ], binding), {
    databaseName: 'hereisorder', databaseId: binding.databaseId,
  });
  for (const matches of [
    [],
    [null],
    [{ name: 'hereisorder', uuid: '11111111-1111-4111-8111-111111111111' }],
    [{ name: 'other', uuid: binding.databaseId }],
    [{ name: 'hereisorder', uuid: binding.databaseId }, { name: 'hereisorder', uuid: binding.databaseId }],
  ]) {
    assert.throws(() => assertSmokeIdentityRemoteTarget(matches, binding));
  }
});

test('adapter accepts only exact binding, writes summary before safe log, and redacts secrets', async () => {
  const events = [];
  const lifecycleCalls = [];
  const report = await runManageSmokeIdentity({
    argv: ['provision', '--remote'],
    env: BASE_ENV,
    now: () => new Date('2026-07-13T18:00:00.000Z'),
    readBinding: () => ({ binding: 'DB', databaseName: 'hereisorder', databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839' }),
    createHash: (password) => {
      assert.equal(password, PASSWORD);
      return `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
    },
    createClient: () => ({
      marker: 'client',
      async listDatabasesByExactName() {
        return [{ name: 'hereisorder', uuid: '6de5b982-fd82-4e0a-a56d-9e7bde948839' }];
      },
    }),
    runLifecycle: async (input) => { lifecycleCalls.push(input); return { id: 41, active: true }; },
    appendSummary: async (_path, contents) => events.push(['summary', contents]),
    log: async (contents) => events.push(['log', contents]),
  });
  assert.deepEqual(Object.keys(report), ['operationVersion', 'executedAt', 'databaseName', 'action', 'outcome']);
  assert.deepEqual(events.map(([kind]) => kind), ['summary', 'log']);
  assert.equal(lifecycleCalls[0].action, 'provision');
  const serialized = JSON.stringify({ report, events });
  for (const sensitive of [PASSWORD, 'cloudflare-token-sensitive', '6de5b982-fd82-4e0a-a56d-9e7bde948839', 'deployment-smoke']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `node --test scripts/manage-smoke-identity.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement strict environment, adapter, and report**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { createPasswordHash } from './generate-admin-seed.mjs';
import { readProductionD1Binding } from './recover-password.mjs';
import {
  SMOKE_IDENTITY,
  SMOKE_IDENTITY_ACTIONS,
  expectedSmokeIdentityConfirmation,
  parseSmokeIdentityArgs,
  validateSmokeIdentityPassword,
} from './smoke-identity-contract.mjs';
import { runSmokeIdentityLifecycle } from './smoke-identity-lifecycle.mjs';

export const SMOKE_IDENTITY_OPERATION_VERSION = 'production-smoke-identity-operation-v1';
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function nonblank(value) {
  return typeof value === 'string' && value.length > 0
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseSmokeIdentityEnvironment({ env, action }) {
  try {
    const needsPassword = action !== 'disable';
    if (!env
      || env.CI !== 'true'
      || env.GITHUB_ACTIONS !== 'true'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_REF !== 'refs/heads/main'
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ID)
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
      || !ACCOUNT_ID_PATTERN.test(env.CLOUDFLARE_ACCOUNT_ID)
      || !nonblank(env.CLOUDFLARE_API_TOKEN)
      || env.SMOKE_IDENTITY_CONFIRMATION !== expectedSmokeIdentityConfirmation(action)
      || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)
      || path.normalize(env.GITHUB_STEP_SUMMARY) !== env.GITHUB_STEP_SUMMARY
      || (!needsPassword && env.PRODUCTION_SMOKE_PASSWORD !== undefined)) {
      throw new Error('invalid environment');
    }
    return Object.freeze({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      password: needsPassword
        ? validateSmokeIdentityPassword(env.PRODUCTION_SMOKE_PASSWORD)
        : undefined,
      summaryPath: env.GITHUB_STEP_SUMMARY,
    });
  } catch {
    throw new Error('Smoke identity environment was invalid.');
  }
}

export function buildSmokeIdentityOperationReport({ executedAt, action }) {
  const report = {
    operationVersion: SMOKE_IDENTITY_OPERATION_VERSION,
    executedAt,
    databaseName: SMOKE_IDENTITY.databaseName,
    action,
    outcome: 'completed',
  };
  if (typeof executedAt !== 'string'
    || new Date(executedAt).toISOString() !== executedAt
    || !SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity report was invalid.');
  }
  return Object.freeze(report);
}

export function assertSmokeIdentityRemoteTarget(matches, binding) {
  if (!Array.isArray(matches)
    || matches.length !== 1
    || !matches[0]
    || typeof matches[0] !== 'object'
    || Array.isArray(matches[0])
    || Object.keys(matches[0]).sort().join(',') !== 'name,uuid'
    || matches[0].name !== SMOKE_IDENTITY.databaseName
    || matches[0].uuid !== binding.databaseId) {
    throw new Error('Smoke identity remote target was invalid.');
  }
  return Object.freeze({
    databaseName: SMOKE_IDENTITY.databaseName,
    databaseId: binding.databaseId,
  });
}

export function renderSmokeIdentityOperationSummary(report) {
  const expectedKeys = ['operationVersion', 'executedAt', 'databaseName', 'action', 'outcome'];
  if (!report
    || Object.keys(report).join(',') !== expectedKeys.join(',')
    || report.operationVersion !== SMOKE_IDENTITY_OPERATION_VERSION
    || report.databaseName !== SMOKE_IDENTITY.databaseName
    || !SMOKE_IDENTITY_ACTIONS.includes(report.action)
    || report.outcome !== 'completed'
    || new Date(report.executedAt).toISOString() !== report.executedAt) {
    throw new Error('Smoke identity report was invalid.');
  }
  return `## Production smoke identity operation\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

export async function runManageSmokeIdentity({
  argv = process.argv.slice(2), env = process.env, now = () => new Date(),
  configPath = 'wrangler.toml', readBinding = readProductionD1Binding,
  createHash = createPasswordHash, createClient = createCloudflareD1RestClient,
  runLifecycle = runSmokeIdentityLifecycle,
  appendSummary = (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8'),
  log = (contents) => console.log(contents),
} = {}) {
  try {
    const { action } = parseSmokeIdentityArgs(argv);
    const environment = parseSmokeIdentityEnvironment({ env, action });
    const binding = readBinding({ configPath, binding: SMOKE_IDENTITY.databaseBinding });
    if (binding.binding !== SMOKE_IDENTITY.databaseBinding
      || binding.databaseName !== SMOKE_IDENTITY.databaseName
      || !DATABASE_ID_PATTERN.test(binding.databaseId)) {
      throw new Error('invalid binding');
    }
    const client = createClient({ accountId: environment.accountId, apiToken: environment.apiToken });
    assertSmokeIdentityRemoteTarget(
      await client.listDatabasesByExactName(SMOKE_IDENTITY.databaseName),
      binding,
    );
    const passwordHash = environment.password === undefined
      ? undefined
      : createHash(environment.password);
    await runLifecycle({ client, databaseId: binding.databaseId, action, passwordHash });
    const currentTime = now();
    const report = buildSmokeIdentityOperationReport({
      executedAt: currentTime.toISOString(), action,
    });
    await appendSummary(environment.summaryPath, renderSmokeIdentityOperationSummary(report));
    await log(JSON.stringify(report));
    return report;
  } catch {
    throw new Error('Smoke identity operation failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runManageSmokeIdentity().catch(() => {
    console.error('Smoke identity operation failed.');
    process.exitCode = 1;
  });
}
```

Add the package script:

```json
"db:manage-smoke-identity": "node scripts/manage-smoke-identity.mjs"
```

- [ ] **Step 4: Add failure/redaction cases before GREEN**

Use one exact valid dependency set, then override one dependency per case. Every public rejection must be exactly `Smoke identity operation failed.`.

```js
const validDependencies = {
  argv: ['provision', '--remote'],
  env: BASE_ENV,
  now: () => new Date('2026-07-13T18:00:00.000Z'),
  readBinding: () => ({
    binding: 'DB', databaseName: 'hereisorder',
    databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
  }),
  createHash: () => `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`,
  createClient: () => ({
    async listDatabasesByExactName() {
      return [{ name: 'hereisorder', uuid: '6de5b982-fd82-4e0a-a56d-9e7bde948839' }];
    },
  }),
  runLifecycle: async () => ({ id: 41, active: true }),
  appendSummary: async () => {},
  log: async () => {},
};

test('binding, remote target, hash and lifecycle failures are generic', async (t) => {
  const cases = [
    ['wrong binding', {
      readBinding: () => ({ binding: 'DB', databaseName: 'other', databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839' }),
    }],
    ['wrong remote UUID', {
      createClient: () => ({
        async listDatabasesByExactName() {
          return [{ name: 'hereisorder', uuid: '11111111-1111-4111-8111-111111111111' }];
        },
      }),
    }],
    ['hash failure', {
      createHash: () => { throw new Error(`hash ${PASSWORD}`); },
    }],
    ['lifecycle failure', {
      runLifecycle: async () => { throw new Error('raw production user row'); },
    }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runManageSmokeIdentity({ ...validDependencies, ...override }),
        (error) => error.message === 'Smoke identity operation failed.'
          && !error.message.includes(PASSWORD)
          && !error.message.includes('production user row'),
      );
    });
  }
});

test('summary failure leaves no success log', async () => {
  const logs = [];
  await assert.rejects(runManageSmokeIdentity({
    ...validDependencies,
    readBinding: () => ({ binding: 'DB', databaseName: 'hereisorder', databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839' }),
    appendSummary: async () => { throw new Error(`summary ${PASSWORD}`); },
    log: async (value) => logs.push(value),
  }), (error) => error.message === 'Smoke identity operation failed.');
  assert.deepEqual(logs, []);
});
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test scripts/smoke-identity-contract.test.mjs scripts/smoke-identity-lifecycle.test.mjs scripts/manage-smoke-identity.test.mjs`

Expected: all tests pass, 0 fail, and serialized reports contain none of the test secrets.

- [ ] **Step 6: Commit the operator adapter**

```bash
git add package.json scripts/manage-smoke-identity.mjs scripts/manage-smoke-identity.test.mjs
git commit -m "feat: add production smoke identity operator"
```

---

### Task 4: Add the manual lifecycle workflow and shared production concurrency

**Files:**

- Create: `.github/workflows/manage-smoke-identity.yml`
- Create: `scripts/smoke-identity-workflow.test.mjs`
- Modify: `.github/workflows/deploy-worker.yml:14-16`

**Interfaces:**

- Consumes: the three literal fixed-action package commands from Task 3.
- Produces: one manual main-only mutation surface and concurrency group `hereisorder-production-${{ github.ref }}` shared with deploy workflow.

- [ ] **Step 1: Write the failing workflow contract test**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const lifecycle = fs.readFileSync('.github/workflows/manage-smoke-identity.yml', 'utf8');
const deploy = fs.readFileSync('.github/workflows/deploy-worker.yml', 'utf8');

test('lifecycle and deployment share non-cancelling repository/ref concurrency', () => {
  for (const workflow of [lifecycle, deploy]) {
    assert.match(workflow, /concurrency:\n  group: hereisorder-production-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/);
  }
});

test('manual workflow is main-only with fixed choice and static action commands', () => {
  assert.match(lifecycle, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(lifecycle, /^  (?:push|pull_request):/m);
  assert.match(lifecycle, /type: choice\n        options:\n          - provision\n          - rotate\n          - disable/);
  assert.match(
    lifecycle,
    /- name: Reject a non-main ref\n        if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/,
  );
  assert.doesNotMatch(lifecycle, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  const refGuard = lifecycle.indexOf('- name: Reject a non-main ref');
  assert.ok(refGuard < lifecycle.indexOf('- uses: actions/checkout@'));
  assert.ok(refGuard < lifecycle.indexOf('secrets.CLOUDFLARE_API_TOKEN'));
  for (const action of ['provision', 'rotate', 'disable']) {
    assert.match(lifecycle, new RegExp(`run: npm run db:manage-smoke-identity -- ${action} --remote`));
  }
  assert.doesNotMatch(lifecycle, /run:.*\$\{\{.*inputs/);
  assert.match(
    lifecycle,
    /if: inputs\.action != 'provision' && inputs\.action != 'rotate' && inputs\.action != 'disable'\n        run: exit 1/,
  );
  assert.doesNotMatch(lifecycle, /continue-on-error|always\(|failure\(|\|\|\s*true|set\s+\+e/);
});

test('password is scoped only to provision and rotate static steps', () => {
  const occurrences = lifecycle.match(/PRODUCTION_SMOKE_PASSWORD: \$\{\{ secrets\.PRODUCTION_SMOKE_PASSWORD \}\}/g) ?? [];
  assert.equal(occurrences.length, 2);
  const disableBlock = lifecycle.slice(lifecycle.indexOf('- name: Disable'), lifecycle.length);
  assert.doesNotMatch(disableBlock, /PRODUCTION_SMOKE_PASSWORD/);
  assert.doesNotMatch(lifecycle, /^env:/m);
  assert.doesNotMatch(lifecycle, /^    env:/m);
});
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `node --test scripts/smoke-identity-workflow.test.mjs`

Expected: FAIL because `.github/workflows/manage-smoke-identity.yml` does not exist.

- [ ] **Step 3: Add the exact manual workflow**

```yaml
name: Manage production smoke identity

on:
  workflow_dispatch:
    inputs:
      action:
        description: Fixed lifecycle operation
        required: true
        type: choice
        options:
          - provision
          - rotate
          - disable
      confirmation:
        description: Type the exact MANAGE confirmation for the selected action
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: hereisorder-production-${{ github.ref }}
  cancel-in-progress: false

jobs:
  manage:
    name: Manage fixed production smoke identity
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Reject a non-main ref
        if: github.ref != 'refs/heads/main'
        run: exit 1

      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: '22.23.1'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Provision fixed smoke identity
        if: inputs.action == 'provision'
        run: npm run db:manage-smoke-identity -- provision --remote
        env:
          CI: 'true'
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}
          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}

      - name: Rotate fixed smoke identity
        if: inputs.action == 'rotate'
        run: npm run db:manage-smoke-identity -- rotate --remote
        env:
          CI: 'true'
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}
          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}

      - name: Disable fixed smoke identity
        if: inputs.action == 'disable'
        run: npm run db:manage-smoke-identity -- disable --remote
        env:
          CI: 'true'
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          SMOKE_IDENTITY_CONFIRMATION: ${{ inputs.confirmation }}

      - name: Reject an invalid lifecycle action
        if: inputs.action != 'provision' && inputs.action != 'rotate' && inputs.action != 'disable'
        run: exit 1
```

The non-main guard is the first step, before checkout, dependency installation, and every secret-bearing step. A feature-ref dispatch therefore fails instead of becoming a successful skipped job and never exposes repository secrets to code from that ref. The runner supplies `GITHUB_ACTIONS`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and `GITHUB_STEP_SUMMARY`; do not redeclare them.

- [ ] **Step 4: Change deployment concurrency to the same fixed group**

In `.github/workflows/deploy-worker.yml`, replace only:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false
```

with:

```yaml
concurrency:
  group: hereisorder-production-${{ github.ref }}
  cancel-in-progress: false
```

- [ ] **Step 5: Run workflow contracts and full Node tests**

Run: `node --test scripts/smoke-identity-workflow.test.mjs scripts/deploy-workflow.test.mjs scripts/d1-rest-batch-contract.test.mjs`

Expected: all selected tests pass. Existing deploy order and failure-bypass assertions remain green.

Run: `npm test`

Expected: all root Node and Vitest tests pass.

- [ ] **Step 6: Commit the workflow**

```bash
git add .github/workflows/manage-smoke-identity.yml .github/workflows/deploy-worker.yml scripts/smoke-identity-workflow.test.mjs
git commit -m "ci: add smoke identity lifecycle workflow"
```

---

### Task 5: Document the lifecycle runbook and S1/S2 handoff

**Files:**

- Modify: `README.md:123-147`
- Modify: `docs/design/cloudflare-deploy-guide.md:105-155`
- Modify: `scripts/delivery-recovery-docs.test.mjs`

**Interfaces:**

- Consumes: fixed workflow/secret/action names from Tasks 1-4.
- Produces: exact operator setup, rotation, disable, evidence, and stop conditions required before S2.

- [ ] **Step 1: Write failing documentation contract tests**

```js
test('delivery docs define the fixed smoke identity lifecycle without direct D1 edits', () => {
  for (const file of ['README.md', 'docs/design/cloudflare-deploy-guide.md']) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const required of [
      'deployment-smoke',
      'PRODUCTION_SMOKE_PASSWORD',
      'manage-smoke-identity.yml',
      'MANAGE hereisorder deployment-smoke provision',
      'MANAGE hereisorder deployment-smoke disable',
      'MANAGE hereisorder deployment-smoke rotate',
      '모든 세션',
    ]) {
      assert.ok(contents.includes(required), `${file} must include ${required}`);
    }
    const sectionStart = contents.indexOf('운영 smoke identity');
    assert.ok(sectionStart >= 0, `${file} must contain the lifecycle section`);
    const section = contents.slice(sectionStart, sectionStart + 5000);
    assert.ok(section.indexOf('disable') < section.indexOf('rotate'));
    assert.doesNotMatch(section, /UPDATE users|DELETE FROM sessions|wrangler d1 execute/);
  }
});
```

- [ ] **Step 2: Run the docs test and verify RED**

Run: `node --test scripts/delivery-recovery-docs.test.mjs`

Expected: FAIL because the lifecycle section and secret are absent.

- [ ] **Step 3: Add exact README operator summary**

Add a `### 운영 smoke identity` subsection after the automatic deployment sequence. It must state:

```markdown
Authenticated business smoke는 fixed `deployment-smoke` staff identity를 사용합니다. Identity lifecycle은 main의 `Manage production smoke identity` 수동 workflow만 사용하며 D1 콘솔이나 임의 SQL로 변경하지 않습니다. Repository secret `PRODUCTION_SMOKE_PASSWORD`에는 stdout·argv·파일을 거치지 않고 생성한 48-byte random credential을 저장합니다.

최초 설정은 S1 merge/deploy 성공 → secret 설치 → `manage-smoke-identity.yml`의 `provision`과 `MANAGE hereisorder deployment-smoke provision` 확인 → postflight evidence 확인 순서입니다. Rotation은 `disable`/`MANAGE hereisorder deployment-smoke disable`로 모든 세션을 폐기한 뒤 새 secret을 설치하고 `rotate`/`MANAGE hereisorder deployment-smoke rotate`로 재활성화합니다. Lifecycle run이 실패하면 authenticated smoke gate를 병합하지 않습니다.
```

- [ ] **Step 4: Add the full deployment-guide runbook**

Insert this exact section in `docs/design/cloudflare-deploy-guide.md` after the existing public-smoke deployment procedure:

````markdown
### 운영 smoke identity lifecycle

Authenticated business smoke는 fixed `deployment-smoke` staff identity를 사용한다. Identity lifecycle은 main의 `manage-smoke-identity.yml` 수동 workflow로만 수행하며 D1 콘솔이나 임의 SQL로 변경하지 않는다. 각 성공 작업은 user mutation, operator audit, 모든 세션 revoke를 하나의 atomic batch로 검증한다.

#### 최초 provision

S1 merge deployment가 성공한 뒤 trusted local shell에서만 repository secret을 설치한다. Shell tracing을 켜지 않고 secret value를 stdout, argv, file, chat, issue, PR 또는 commit에 남기지 않는다.

```bash
set -euo pipefail
smoke_password="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
test "${#smoke_password}" -ge 32
printf '%s' "$smoke_password" | gh secret set PRODUCTION_SMOKE_PASSWORD --repo AllStuff-agit/Here-is-order
unset smoke_password

gh workflow run manage-smoke-identity.yml --ref main \
  -f action=provision \
  -f confirmation='MANAGE hereisorder deployment-smoke provision'
```

Provision은 create-only다. 실패한 run을 맹목적으로 재시도하지 않고 safe evidence로 상태를 판정한다. `production-smoke-identity-operation-v1` report의 `databaseName: hereisorder`, `action: provision`, `outcome: completed`가 모두 확인되기 전에는 S2를 시작하지 않는다.

#### Credential rotation과 긴급 비활성화

Rotation은 먼저 다음 `disable` 작업으로 identity를 inactive로 만들고 모든 세션을 폐기한다.

```bash
gh workflow run manage-smoke-identity.yml --ref main \
  -f action=disable \
  -f confirmation='MANAGE hereisorder deployment-smoke disable'
```

그다음 위의 stdin 절차로 `PRODUCTION_SMOKE_PASSWORD`를 새 48-byte credential로 교체하고 다음 `rotate` 작업으로 새 hash를 저장해 identity를 재활성화한다.

```bash
gh workflow run manage-smoke-identity.yml --ref main \
  -f action=rotate \
  -f confirmation='MANAGE hereisorder deployment-smoke rotate'
```

Password, hash, user/session row, raw D1 envelope는 evidence가 아니다. 허용 evidence는 `production-smoke-identity-operation-v1`의 `operationVersion`, `executedAt`, fixed database name, action, `outcome: completed`뿐이다. Lifecycle run이 실패하거나 whitelist evidence가 exact하지 않으면 배포 gate 변경을 중단하고 raw production response를 출력하지 않은 채 진단한다.
````

- [ ] **Step 5: Run docs and focused workflow tests**

Run: `node --test scripts/delivery-recovery-docs.test.mjs scripts/smoke-identity-workflow.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit the runbook**

```bash
git add README.md docs/design/cloudflare-deploy-guide.md scripts/delivery-recovery-docs.test.mjs
git commit -m "docs: add smoke identity lifecycle runbook"
```

---

### Task 6: Verify and deliver the S1 pull request

**Files:**

- Verify only; no new source file is expected.

**Interfaces:**

- Produces: reviewed S1 PR, merge SHA, and a successful unchanged public production deployment before any identity mutation.

- [ ] **Step 1: Run the complete local gate**

```bash
set -euo pipefail
npm ci
npm test
npm run typecheck
npm run build
npm ci --prefix frontend
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
test -z "$(git status --short)"
```

Expected: every command exits 0 and `git status --short` is empty. Record the exact commands and pass/fail results in the PR body; do not invent test counts.

- [ ] **Step 2: Request two-stage independent review**

Use `superpowers:requesting-code-review`. First review spec compliance, then code quality/security. Required focus:

- fixed target and no takeover path;
- atomic mutation/write-count/postflight correctness;
- ambiguous-write reconciliation false positives;
- password/hash/row/log leakage;
- workflow input shell injection and secret scope;
- shared concurrency and no failure bypass.

Expected: no unresolved blocker, high, or medium finding. Fix findings with TDD and rerun Step 1.

- [ ] **Step 3: Publish the S1 branch and PR**

Use `github:yeet` only after the complete gate and review pass.

```bash
set -euo pipefail
git push -u origin feat/wave-1b-authenticated-smoke
pr_body="$(printf '%s\n' \
  '## Summary' \
  '- Adds the fixed production smoke identity contract and fail-closed atomic lifecycle.' \
  '- Adds a manual main-only lifecycle workflow with shared production concurrency.' \
  '- Documents provision, disable, rotation, and S2 handoff.' \
  '' \
  '## Verification' \
  '- `npm ci` — passed' \
  '- `npm test` — passed' \
  '- `npm run typecheck` — passed' \
  '- `npm run build` — passed' \
  '- `npm ci --prefix frontend` — passed' \
  '- `npm run test --prefix frontend` — passed' \
  '- `npm run lint --prefix frontend` — passed' \
  '- `npm run build --prefix frontend` — passed' \
  '- `npm run build:cloudflare --prefix frontend` — passed' \
  '- `git diff --check` — passed' \
  '- `git status --short` — clean' \
  '' \
  '## Data impact' \
  '- DB change: production users/sessions/audit_logs only when manual workflow later runs' \
  '- Migration change: none')"
pr_url="$(gh pr create \
  --base main \
  --head feat/wave-1b-authenticated-smoke \
  --title 'feat: add production smoke identity lifecycle' \
  --body "$pr_body")"
unset pr_body
pr_number="${pr_url##*/}"
test -n "$pr_number"
```

Expected: `pr_url` identifies one PR and its body contains the literal pass results and data-impact statements above. Do not add a credential, password hash, user/session projection, account ID, database UUID, or raw response.

- [ ] **Step 4: Wait for required checks and merge**

```bash
set -euo pipefail
pr_number="$(gh pr list --head feat/wave-1b-authenticated-smoke --state open --limit 2 \
  --json number --jq 'if length == 1 then .[0].number else empty end')"
test -n "$pr_number"
gh pr checks "$pr_number" --watch
gh pr merge "$pr_number" --squash
merge_sha=''
for attempt in {1..30}; do
  pr_state="$(gh pr view "$pr_number" --json state --jq '.state')"
  if [ "$pr_state" = 'MERGED' ]; then
    merge_sha="$(gh pr view "$pr_number" --json mergeCommit --jq '.mergeCommit.oid')"
    break
  fi
  sleep 10
done
test -n "$merge_sha"
git -C /home/ubuntu/workspace/projects/Here-is-order pull --ff-only origin main
test "$(git -C /home/ubuntu/workspace/projects/Here-is-order rev-parse HEAD)" = "$merge_sha"
if git ls-remote --exit-code --heads origin feat/wave-1b-authenticated-smoke >/dev/null 2>&1; then
  git push origin --delete feat/wave-1b-authenticated-smoke
fi
```

Expected: checks pass, the PR reaches exact `MERGED` state within five minutes, and local main equals both `origin/main` and the PR merge commit. Do not provision before the S1 merge deployment succeeds.

- [ ] **Step 5: Verify the merge deployment without identity mutation**

```bash
set -euo pipefail
pr_number="$(gh pr list --head feat/wave-1b-authenticated-smoke --state merged --limit 2 \
  --json number --jq 'if length == 1 then .[0].number else empty end')"
test -n "$pr_number"
merge_sha="$(gh pr view "$pr_number" --json mergeCommit --jq '.mergeCommit.oid')"
test "$(git -C /home/ubuntu/workspace/projects/Here-is-order rev-parse HEAD)" = "$merge_sha"
merge_run_id=''
for attempt in {1..30}; do
  merge_run_ids="$(gh run list --workflow deploy-worker.yml --branch main --event push --limit 50 \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$merge_sha\") | .databaseId")"
  merge_run_count="$(printf '%s\n' "$merge_run_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$merge_run_count" -gt 1 ]; then
    exit 1
  fi
  if [ "$merge_run_count" -eq 1 ]; then
    merge_run_id="$merge_run_ids"
    break
  fi
  sleep 10
done
test -n "$merge_run_id"
gh run watch "$merge_run_id" --exit-status
gh run view "$merge_run_id" --log
```

Expected: verify, D1 contract, preflight, API/web exact-version verification, readiness, and existing public web proxy smoke pass for the exact merge SHA.

- [ ] **Step 6: Retire the merged S1 worktree**

Use `superpowers:finishing-a-development-branch`, then run from the main checkout rather than from inside the feature worktree:

```bash
set -euo pipefail
cd /home/ubuntu/workspace/projects/Here-is-order
git worktree remove .worktrees/wave-1b-authenticated-smoke
git branch -D feat/wave-1b-authenticated-smoke
test -z "$(git status --short)"
git status --short --branch
```

Expected: the merged worktree and local feature branch are gone; main is clean and matches `origin/main` before the external secret/provision steps.

---

### Task 7: Install the repository secret and provision production identity

**Files:**

- External production state only: GitHub repository secret, production `users`, `audit_logs`; `sessions` remains empty for the new identity.

**Interfaces:**

- Consumes: merged S1 workflow and the user’s explicit approval for this production mutation.
- Produces: `PRODUCTION_SMOKE_PASSWORD` secret and one active audited fixed `staff` identity, ready for S2.

- [ ] **Step 1: Confirm no production workflow is running**

```bash
set -euo pipefail
for run_status in in_progress queued; do
  active_run_ids="$(gh run list --status "$run_status" --limit 100 \
    --json databaseId,headBranch,workflowName \
    --jq '.[] | select(.headBranch == "main" and (.workflowName == "Verify and deploy" or .workflowName == "Manage production smoke identity")) | .databaseId')"
  test -z "$active_run_ids"
done
```

Expected: no `Verify and deploy` or `Manage production smoke identity` run for `main` is active. If one exists, wait; do not cancel it.

- [ ] **Step 2: Generate and install the secret without stdout, argv, or file exposure**

Run one non-echoing shell command in a trusted terminal:

```bash
set -euo pipefail
smoke_password="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
test "${#smoke_password}" -ge 32
printf '%s' "$smoke_password" | gh secret set PRODUCTION_SMOKE_PASSWORD --repo AllStuff-agit/Here-is-order
unset smoke_password
```

Expected: `gh secret set` exits 0 and prints no secret value. Never enable shell tracing. Verify name/timestamp only:

```bash
gh secret list --repo AllStuff-agit/Here-is-order | rg '^PRODUCTION_SMOKE_PASSWORD\b'
```

- [ ] **Step 3: Dispatch the create-only provision action**

```bash
set -euo pipefail
lifecycle_run_url="$(gh workflow run manage-smoke-identity.yml --ref main \
  -f action=provision \
  -f confirmation='MANAGE hereisorder deployment-smoke provision')"
if [[ ! "$lifecycle_run_url" =~ ^https://github\.com/AllStuff-agit/Here-is-order/actions/runs/([1-9][0-9]*)$ ]]; then
  exit 1
fi
lifecycle_run_id="${BASH_REMATCH[1]}"
gh run watch "$lifecycle_run_id" --exit-status
test "$(gh run view "$lifecycle_run_id" --json databaseId --jq '.databaseId')" = "$lifecycle_run_id"
test "$(gh run view "$lifecycle_run_id" --json event --jq '.event')" = 'workflow_dispatch'
test "$(gh run view "$lifecycle_run_id" --json headBranch --jq '.headBranch')" = 'main'
test "$(gh run view "$lifecycle_run_id" --json workflowName --jq '.workflowName')" = 'Manage production smoke identity'
test "$(gh run view "$lifecycle_run_id" --json url --jq '.url')" = "$lifecycle_run_url"
safe_report_matches="$(gh run view "$lifecycle_run_id" --log | rg -o '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"provision","outcome":"completed"\}')"
safe_report_count="$(printf '%s\n' "$safe_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"
test "$safe_report_count" -eq 1
unset safe_report_matches
```

Expected: `gh workflow run` returns one exact repository run URL, that exact run succeeds with main/workflow-dispatch metadata, and its log contains one exact completed whitelist report. Logs must not contain `password_hash`, `isorder_sid`, raw `users`/`sessions` rows, Cloudflare account ID/token, or a D1 response envelope. If URL capture or evidence is absent/malformed, do not dispatch again: a write may have completed, so stop before S2 and reconcile without dumping raw production responses.

- [ ] **Step 4: Mark the S1 handoff complete**

Record only the lifecycle run URL, merge SHA, `operationVersion`, `executedAt`, database name, action, and outcome in the Wave 1 delivery record. Do not record username/user ID because the fixed identity is already source-controlled and projection evidence is excluded.

Expected: S2 may now branch from the updated, clean `main`; no S2 workflow gate has been merged yet.
