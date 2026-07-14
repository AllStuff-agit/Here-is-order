import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSmokeIdentityPostflight,
  assertSmokeIdentityWrite,
  buildSmokeIdentityMutation,
  buildSmokeIdentityPostflightQuery,
  buildSmokeIdentityPreflightQuery,
  parseSmokeIdentityPreflight,
  runSmokeIdentityLifecycle,
} from './smoke-identity-lifecycle.mjs';

const HASH = `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const OPERATION_ID = 'a1111111-b111-4111-8111-c11111111111';
const OTHER_OPERATION_ID = 'd2222222-e222-4222-a222-f22222222222';
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
const writeResult = () => [
  { success: true, results: [], meta: { changes: 1 } },
  { success: true, results: [], meta: { changes: 1 } },
  { success: true, results: [], meta: { changes: 0 } },
];
const rotatePostflightRow = (auditJson, patch = {}) => ({
  ...ACTIVE_ROW,
  hash_matches: 1,
  hash_scheme_ok: 1,
  session_count: 0,
  latest_audit_action: 'rotate_smoke_identity',
  latest_audit_actor_user_id: null,
  latest_audit_before_json: null,
  latest_audit_after_json: auditJson,
  ...patch,
});

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

test('rotate batch performs exact CAS update, session revoke and correlated fixed audit', () => {
  const mutation = buildSmokeIdentityMutation({
    action: 'rotate',
    target: { id: 41, observedActive: 0 },
    passwordHash: HASH,
    operationId: OPERATION_ID,
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
  assert.deepEqual(JSON.parse(mutation.auditJson), {
    source: 'deployment_smoke_operator',
    username: 'deployment-smoke',
    role: 'staff',
    active: true,
    operationId: OPERATION_ID,
  });
  assert.equal(JSON.stringify(mutation).includes('admin'), false);
  const provision = buildSmokeIdentityMutation({
    action: 'provision', target: null, passwordHash: HASH, operationId: OPERATION_ID,
  });
  assert.equal(provision.batch.length, 3);
  assert.match(provision.batch[1].sql, /CASE\s+WHEN changes\(\) = 1/);
  assert.match(provision.batch[1].sql, /SELECT COUNT\(\*\) FROM users/);
  assert.match(provision.batch[1].sql, /ELSE NULL/);
  assert.match(provision.batch[2].sql, /^DELETE FROM sessions/);
  assert.match(mutation.batch[1].sql, /CASE\s+WHEN changes\(\) = 1/);
  assert.match(mutation.batch[1].sql, /SELECT COUNT\(\*\) FROM users/);
  assert.match(mutation.batch[1].sql, /ELSE NULL/);
  const otherMutation = buildSmokeIdentityMutation({
    action: 'rotate',
    target: { id: 41, observedActive: 0 },
    passwordHash: HASH,
    operationId: OTHER_OPERATION_ID,
  });
  assert.notEqual(mutation.auditJson, otherMutation.auditJson);
  assert.throws(() => buildSmokeIdentityMutation({
    action: 'disable', target: { id: 41, observedActive: 0 }, passwordHash: undefined,
    operationId: OPERATION_ID,
  }));
  for (const operationId of [
    undefined,
    OPERATION_ID.toUpperCase(),
    '11111111-1111-1111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    `${OPERATION_ID}\n`,
  ]) {
    assert.throws(
      () => buildSmokeIdentityMutation({
        action: 'rotate', target: { id: 41, observedActive: 1 }, passwordHash: HASH, operationId,
      }),
      (error) => error.message === 'Smoke identity mutation was invalid.'
        && !error.message.includes(String(operationId)),
    );
  }
});

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

test('postflight compares hash only through booleans and requires correlated exact audit', () => {
  const target = { id: 41, observedActive: 1 };
  const mutation = buildSmokeIdentityMutation({
    action: 'rotate', target, passwordHash: HASH, operationId: OPERATION_ID,
  });
  const query = buildSmokeIdentityPostflightQuery({
    action: 'rotate', target, passwordHash: HASH,
  });
  assert.equal(query.sql.includes('u.password_hash = ? AS hash_matches'), true);
  assert.equal(query.sql.includes('instr(u.password_hash, ?) = 1 AS hash_scheme_ok'), true);
  assert.deepEqual(query.params, [
    HASH, 'pbkdf2_sha256$100000$', 41, 'deployment-smoke',
  ]);
  assert.doesNotMatch(query.sql, /(?:SELECT|,)\s*u\.password_hash\s*(?:,|\s+FROM\b)/);
  assert.doesNotMatch(query.sql, /a\.id\s+AS\s+latest_audit_id/);
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
  for (const patch of [
    { hash_matches: 0 }, { hash_scheme_ok: 0 }, { session_count: 1 },
    { latest_audit_after_json: '{}' },
  ]) {
    assert.throws(() => assertSmokeIdentityPostflight(queryResult([{ ...row, ...patch }]), {
      action: 'rotate', auditJson: mutation.auditJson,
    }));
  }
  assert.throws(() => buildSmokeIdentityPostflightQuery({
    action: 'status', target, passwordHash: HASH,
  }));
});

test('ambiguous write succeeds only when exact invocation audit proves intended state', async () => {
  const calls = [];
  let submittedAuditJson;
  const client = {
    async query(_databaseId, body) {
      calls.push(body);
      if (calls.length === 1) return queryResult([ACTIVE_ROW]);
      if (calls.length === 2) {
        submittedAuditJson = body.batch[1].params.at(-1);
        const error = new Error('sensitive transport detail');
        Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
        throw error;
      }
      return queryResult([rotatePostflightRow(submittedAuditJson)]);
    },
  };
  const result = await runSmokeIdentityLifecycle({
    client, databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839', action: 'rotate', passwordHash: HASH,
  });
  assert.deepEqual(result, { id: 41, active: true });
  assert.match(JSON.parse(submittedAuditJson).operationId, OPERATION_ID_PATTERN);
  assert.equal(JSON.stringify(result).includes(JSON.parse(submittedAuditJson).operationId), false);
  assert.equal(calls.length, 3);

  let mismatchCalls = 0;
  let mismatchAuditJson;
  client.query = async (_databaseId, body) => {
    mismatchCalls += 1;
    if (body.sql?.startsWith('SELECT id, username')) return queryResult([ACTIVE_ROW]);
    if (body.batch) {
      mismatchAuditJson = body.batch[1].params.at(-1);
      const error = new Error('sensitive ambiguous write detail');
      Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
      throw error;
    }
    return queryResult([rotatePostflightRow(mismatchAuditJson, { hash_matches: 0 })]);
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

test('lifecycle generates a fresh private operation id for every invocation', async () => {
  const submittedAudits = [];
  const client = {
    async query(_databaseId, body) {
      if (body.sql?.startsWith('SELECT id, username')) return queryResult([ACTIVE_ROW]);
      if (body.batch) {
        submittedAudits.push(body.batch[1].params.at(-1));
        return writeResult();
      }
      return queryResult([rotatePostflightRow(submittedAudits.at(-1))]);
    },
  };

  await runSmokeIdentityLifecycle({
    client,
    databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
    action: 'rotate',
    passwordHash: HASH,
    operationId: OPERATION_ID,
  });
  await runSmokeIdentityLifecycle({
    client,
    databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
    action: 'rotate',
    passwordHash: HASH,
    operationId: OTHER_OPERATION_ID,
  });

  const generatedIds = submittedAudits.map((auditJson) => JSON.parse(auditJson).operationId);
  assert.equal(generatedIds.length, 2);
  assert.match(generatedIds[0], OPERATION_ID_PATTERN);
  assert.match(generatedIds[1], OPERATION_ID_PATTERN);
  assert.notEqual(generatedIds[0], generatedIds[1]);
  assert.notEqual(generatedIds[0], OPERATION_ID);
  assert.notEqual(generatedIds[1], OTHER_OPERATION_ID);
});

test('ambiguous pre-send failure rejects an equivalent concurrent correlated action', async () => {
  let calls = 0;
  let submittedAuditJson;
  let concurrentAuditJson;
  const client = {
    async query(_databaseId, body) {
      calls += 1;
      if (body.sql?.startsWith('SELECT id, username')) return queryResult([ACTIVE_ROW]);
      if (body.batch) {
        submittedAuditJson = body.batch[1].params.at(-1);
        const submittedOperationId = JSON.parse(submittedAuditJson).operationId;
        const concurrentOperationId = submittedOperationId === OPERATION_ID
          ? OTHER_OPERATION_ID
          : OPERATION_ID;
        concurrentAuditJson = buildSmokeIdentityMutation({
          action: 'disable',
          target: { id: 41, observedActive: 1 },
          passwordHash: undefined,
          operationId: concurrentOperationId,
        }).auditJson;
        const error = new Error('sensitive pre-send transport detail');
        Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
        throw error;
      }
      return queryResult([{
        ...ACTIVE_ROW,
        is_active: 0,
        session_count: 0,
        latest_audit_action: 'disable_smoke_identity',
        latest_audit_actor_user_id: null,
        latest_audit_before_json: null,
        latest_audit_after_json: concurrentAuditJson,
      }]);
    },
  };

  await assert.rejects(
    runSmokeIdentityLifecycle({
      client,
      databaseId: '6de5b982-fd82-4e0a-a56d-9e7bde948839',
      action: 'disable',
      passwordHash: undefined,
    }),
    (error) => error.message === 'Smoke identity lifecycle failed.'
      && !error.message.includes('sensitive'),
  );
  assert.notEqual(submittedAuditJson, concurrentAuditJson);
  assert.equal(calls, 3);
});
