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
        && (String(value).length === 0 || !error.message.includes(String(value))),
    );
  }
});
