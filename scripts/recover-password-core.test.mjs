import assert from 'node:assert/strict';
import test from 'node:test';

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

const USERNAME_PAYLOAD = "admin' OR 1=1 --";
const PASSWORD_HASH_PAYLOAD = 'pbkdf2-hash-with-sensitive-payload';

test('remote와 username을 각각 정확히 한 번 명시해야 한다', () => {
  assert.throws(() => parseRecoveryArgs([]), /--remote/);
  assert.throws(() => parseRecoveryArgs(['--remote']), /--username/);
  assert.throws(() => parseRecoveryArgs(['--remote', '--username']), /--username 값/);
  assert.throws(
    () => parseRecoveryArgs(['--username', '--remote']),
    /--username 값/,
  );
  assert.throws(
    () => parseRecoveryArgs(['--remote', '--remote', '--username', 'admin']),
    /--remote는 한 번만/,
  );
  assert.throws(
    () => parseRecoveryArgs([
      '--remote',
      '--username',
      'admin',
      '--username',
      'other-admin',
    ]),
    /--username은 한 번만/,
  );
  assert.throws(
    () => parseRecoveryArgs(['--remote', '--username', 'admin', '--unknown']),
    /알 수 없는 옵션/,
  );
  assert.throws(
    () => parseRecoveryArgs(['--remote', '--username', 'admin', 'positional']),
    /알 수 없는 옵션/,
  );
  assert.throws(
    () => parseRecoveryArgs(['--remote', '--username', '   ']),
    /--username/,
  );
  assert.deepEqual(
    parseRecoveryArgs(['--username', `  ${USERNAME_PAYLOAD}  `, '--remote']),
    { remote: true, username: USERNAME_PAYLOAD },
  );
});

test('confirmation 문자열과 Unicode 기준 12자 password policy를 검증한다', () => {
  assert.equal(
    expectedRecoveryConfirmation('hereisorder', 'admin'),
    'RECOVER hereisorder admin',
  );
  assert.notEqual(
    expectedRecoveryConfirmation('hereisorder', 'Admin'),
    'RECOVER hereisorder admin',
  );
  assert.throws(() => validateRecoveryPassword('short', 'short'), /12자/);
  assert.throws(
    () => validateRecoveryPassword('twelve-chars!', 'different-pass'),
    /일치/,
  );
  assert.throws(
    () => validateRecoveryPassword('🔒'.repeat(11), '🔒'.repeat(11)),
    /12자/,
  );
  assert.equal(
    validateRecoveryPassword('🔒'.repeat(12), '🔒'.repeat(12)),
    '🔒'.repeat(12),
  );
  assert.equal(
    validateRecoveryPassword('twelve-chars!', 'twelve-chars!'),
    'twelve-chars!',
  );
});

test('preflight는 active non-deleted admin을 username param으로만 조회한다', () => {
  const statement = buildRecoveryPreflightQuery(USERNAME_PAYLOAD);

  assert.deepEqual(statement.params, [USERNAME_PAYLOAD]);
  assert.ok(!statement.sql.includes(USERNAME_PAYLOAD));
  assert.match(statement.sql, /^SELECT id, username FROM users WHERE/);
  assert.match(statement.sql, /username = \?/);
  assert.match(statement.sql, /role = 'admin'/);
  assert.match(statement.sql, /is_active = 1/);
  assert.match(statement.sql, /is_deleted = 0/);
});

test('recovery batch는 payload를 SQL에 보간하지 않고 모든 write에서 target을 재검사한다', () => {
  const { batch, auditJson } = buildRecoveryBatch({
    username: USERNAME_PAYLOAD,
    passwordHash: PASSWORD_HASH_PAYLOAD,
  });

  assert.equal(batch.length, 3);
  assert.deepEqual(JSON.parse(auditJson), {
    source: 'operator_recovery',
    username: USERNAME_PAYLOAD,
  });
  assert.deepEqual(batch.map((statement) => statement.params), [
    [PASSWORD_HASH_PAYLOAD, USERNAME_PAYLOAD],
    [USERNAME_PAYLOAD],
    [auditJson, USERNAME_PAYLOAD],
  ]);
  assert.match(batch[0].sql, /^UPDATE users SET password_hash = \?/);
  assert.match(batch[1].sql, /^DELETE FROM sessions/);
  assert.match(batch[2].sql, /^INSERT INTO audit_logs/);

  for (const statement of batch) {
    assert.ok(!statement.sql.includes(USERNAME_PAYLOAD));
    assert.ok(!statement.sql.includes(PASSWORD_HASH_PAYLOAD));
    assert.ok(!statement.sql.includes(auditJson));
    assert.match(statement.sql, /username = \?/);
    assert.match(statement.sql, /role = 'admin'/);
    assert.match(statement.sql, /is_active = 1/);
    assert.match(statement.sql, /is_deleted = 0/);
  }
});

test('postflight는 hash를 반환하지 않고 PBKDF2, session, audit fact만 조회한다', () => {
  const statement = buildRecoveryPostflightQuery(USERNAME_PAYLOAD);

  assert.deepEqual(statement.params, [
    'pbkdf2_sha256$100000$',
    USERNAME_PAYLOAD,
  ]);
  assert.ok(!statement.sql.includes(USERNAME_PAYLOAD));
  assert.ok(!statement.sql.includes('pbkdf2_sha256$100000$'));
  assert.match(statement.sql, /instr\(u\.password_hash, \?\) = 1 AS hash_scheme_ok/);
  assert.match(statement.sql, /COUNT\(\*\).*AS session_count/s);
  assert.match(statement.sql, /after_json.*AS latest_recovery_audit/s);
  assert.match(statement.sql, /username = \?/);
  assert.match(statement.sql, /role = 'admin'/);
  assert.match(statement.sql, /is_active = 1/);
  assert.match(statement.sql, /is_deleted = 0/);
  assert.doesNotMatch(statement.sql, /SELECT\s+u\.password_hash/);
});

test('target은 요청 username과 일치하는 정확히 한 admin row여야 한다', () => {
  assert.throws(() => assertRecoverableAdmin([], 'admin'), /active admin/);
  assert.throws(
    () => assertRecoverableAdmin([
      { id: 7, username: 'admin' },
      { id: 8, username: 'admin' },
    ], 'admin'),
    /active admin/,
  );
  assert.throws(
    () => assertRecoverableAdmin([{ id: 7, username: 'other-admin' }], 'admin'),
    /active admin/,
  );
  assert.deepEqual(
    assertRecoverableAdmin([{ id: '7', username: 'admin' }], 'admin'),
    { id: 7, username: 'admin' },
  );
});

test('write result는 세 statement 모두 성공하고 update가 한 row를 바꿔야 한다', () => {
  const successfulResults = [
    { success: true, meta: { changes: 1 } },
    { success: true, meta: { changes: 4 } },
    { success: true, meta: { changes: 1 } },
  ];

  assert.doesNotThrow(() => assertRecoveryWriteResults(successfulResults));
  assert.throws(
    () => assertRecoveryWriteResults(successfulResults.slice(0, 2)),
    /완전히 성공/,
  );
  assert.throws(
    () => assertRecoveryWriteResults([...successfulResults, successfulResults[0]]),
    /완전히 성공/,
  );
  for (let index = 0; index < successfulResults.length; index += 1) {
    const failedResults = structuredClone(successfulResults);
    failedResults[index].success = false;
    assert.throws(
      () => assertRecoveryWriteResults(failedResults),
      /완전히 성공/,
    );
  }
  for (const changes of [undefined, 0, 2]) {
    const wrongUpdateCount = structuredClone(successfulResults);
    wrongUpdateCount[0].meta.changes = changes;
    assert.throws(
      () => assertRecoveryWriteResults(wrongUpdateCount),
      /정확히 한 admin/,
    );
  }
});

test('postflight는 PBKDF2 scheme, session 0건, exact audit JSON을 모두 요구한다', () => {
  const auditJson = JSON.stringify({
    source: 'operator_recovery',
    username: 'admin',
  });
  const verifiedRow = {
    username: 'admin',
    hash_scheme_ok: 1,
    session_count: 0,
    latest_recovery_audit: auditJson,
  };

  assert.doesNotThrow(() => assertRecoveryPostflight(verifiedRow, auditJson));
  assert.throws(
    () => assertRecoveryPostflight(undefined, auditJson),
    /postflight/,
  );
  assert.throws(
    () => assertRecoveryPostflight({ ...verifiedRow, hash_scheme_ok: 0 }, auditJson),
    /postflight/,
  );
  assert.throws(
    () => assertRecoveryPostflight({ ...verifiedRow, session_count: 1 }, auditJson),
    /postflight/,
  );
  assert.throws(
    () => assertRecoveryPostflight({
      ...verifiedRow,
      latest_recovery_audit: JSON.stringify({
        username: 'admin',
        source: 'operator_recovery',
      }),
    }, auditJson),
    /audit fact/,
  );
});
