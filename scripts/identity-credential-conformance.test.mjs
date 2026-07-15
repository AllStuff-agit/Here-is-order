import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_PASSWORD_HASH_PREFIX,
  PASSWORD_HASH_BYTES,
  PASSWORD_HASH_ITERATIONS,
  PASSWORD_HASH_SCHEME,
  PASSWORD_SALT_BYTES,
  createIdentityCredential,
  isCurrentPasswordHash,
  parseStoredPasswordHash,
  passwordPolicies,
} from '@here-is-order/identity-credential';
import {
  credentialKnownAnswer,
  malformedStoredPasswordHashes,
} from './identity-credential-conformance.mjs';
import {
  createPasswordHash,
  nodeCredentialCrypto,
  nodeIdentityCredential,
} from './node-credential-crypto.mjs';

function knownAnswerSalt() {
  return Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
}

function trackingCredential() {
  const calls = {
    randomByteLengths: [],
    sha256: 0,
    pbkdf2: 0,
  };
  const credential = createIdentityCredential({
    randomBytes(length) {
      calls.randomByteLengths.push(length);
      return knownAnswerSalt();
    },
    sha256(value) {
      calls.sha256 += 1;
      return nodeCredentialCrypto.sha256(value);
    },
    pbkdf2Sha256(value, salt, iterations, length) {
      calls.pbkdf2 += 1;
      return nodeCredentialCrypto.pbkdf2Sha256(value, salt, iterations, length);
    },
  });
  return { calls, credential };
}

test('exports the exact immutable credential contract constants', () => {
  assert.equal(PASSWORD_HASH_SCHEME, 'pbkdf2_sha256');
  assert.equal(PASSWORD_HASH_ITERATIONS, 100_000);
  assert.equal(PASSWORD_SALT_BYTES, 16);
  assert.equal(PASSWORD_HASH_BYTES, 32);
  assert.equal(CURRENT_PASSWORD_HASH_PREFIX, 'pbkdf2_sha256$100000$');
  assert.deepEqual(passwordPolicies, {
    human: { minimumCodePoints: 12, maximumCodePoints: 4_096 },
    automation: { minimumCodePoints: 32, maximumCodePoints: 4_096 },
  });
  assert.ok(Object.isFrozen(passwordPolicies));
  assert.ok(Object.isFrozen(passwordPolicies.human));
  assert.ok(Object.isFrozen(passwordPolicies.automation));
  assert.ok(Object.isFrozen(credentialKnownAnswer));
  assert.ok(Object.isFrozen(malformedStoredPasswordHashes));
});

test('classifies only the two exact stored password hash formats', () => {
  const parsedCurrent = parseStoredPasswordHash(credentialKnownAnswer.currentHash);
  const parsedLegacy = parseStoredPasswordHash(credentialKnownAnswer.legacyHash);

  assert.deepEqual(parsedCurrent, {
    kind: 'pbkdf2_sha256',
    saltHex: credentialKnownAnswer.saltHex,
    digestHex: credentialKnownAnswer.digestHex,
  });
  assert.deepEqual(parsedLegacy, {
    kind: 'legacy_sha256',
    digestHex: credentialKnownAnswer.legacyHash,
  });
  assert.ok(Object.isFrozen(parsedCurrent));
  assert.ok(Object.isFrozen(parsedLegacy));
  assert.equal(isCurrentPasswordHash(credentialKnownAnswer.currentHash), true);
  assert.equal(isCurrentPasswordHash(credentialKnownAnswer.legacyHash), false);
});

test('rejects every malformed stored password hash in the shared corpus', () => {
  for (const malformed of malformedStoredPasswordHashes) {
    assert.equal(parseStoredPasswordHash(malformed), null, malformed);
    assert.equal(isCurrentPasswordHash(malformed), false, malformed);
  }
  for (const malformed of [null, undefined, 0, {}, new Uint8Array(32)]) {
    assert.equal(parseStoredPasswordHash(malformed), null);
    assert.equal(isCurrentPasswordHash(malformed), false);
  }
});

test('creates the same literal current hash with the Node adapter', async () => {
  const salt = knownAnswerSalt();
  const exportedResult = createPasswordHash(credentialKnownAnswer.password, salt);

  assert.ok(exportedResult instanceof Promise);
  assert.equal(await exportedResult, credentialKnownAnswer.currentHash);
  assert.equal(
    await nodeIdentityCredential.createPasswordHash(credentialKnownAnswer.password, salt),
    credentialKnownAnswer.currentHash,
  );
});

test('verifies current hashes once and never upgrades them', async () => {
  const correct = trackingCredential();
  const valid = await correct.credential.verifyPassword(
    credentialKnownAnswer.password,
    credentialKnownAnswer.currentHash,
  );

  assert.deepEqual(valid, {
    valid: true,
    needsUpgrade: false,
    upgradedHash: null,
  });
  assert.ok(Object.isFrozen(valid));
  assert.deepEqual(correct.calls, {
    randomByteLengths: [],
    sha256: 0,
    pbkdf2: 1,
  });

  const wrong = trackingCredential();
  const invalid = await wrong.credential.verifyPassword(
    credentialKnownAnswer.wrongPassword,
    credentialKnownAnswer.currentHash,
  );

  assert.deepEqual(invalid, {
    valid: false,
    needsUpgrade: false,
    upgradedHash: null,
  });
  assert.ok(Object.isFrozen(invalid));
  assert.deepEqual(wrong.calls, {
    randomByteLengths: [],
    sha256: 0,
    pbkdf2: 1,
  });
});

test('upgrades one valid legacy hash with one generated 16-byte salt', async () => {
  const correct = trackingCredential();
  const valid = await correct.credential.verifyPassword(
    credentialKnownAnswer.password,
    credentialKnownAnswer.legacyHash,
  );

  assert.deepEqual(valid, {
    valid: true,
    needsUpgrade: true,
    upgradedHash: credentialKnownAnswer.currentHash,
  });
  assert.ok(Object.isFrozen(valid));
  assert.deepEqual(correct.calls, {
    randomByteLengths: [16],
    sha256: 1,
    pbkdf2: 1,
  });

  const wrong = trackingCredential();
  const invalid = await wrong.credential.verifyPassword(
    credentialKnownAnswer.wrongPassword,
    credentialKnownAnswer.legacyHash,
  );

  assert.deepEqual(invalid, {
    valid: false,
    needsUpgrade: false,
    upgradedHash: null,
  });
  assert.ok(Object.isFrozen(invalid));
  assert.deepEqual(wrong.calls, {
    randomByteLengths: [],
    sha256: 1,
    pbkdf2: 0,
  });
});

test('returns invalid without hashing unsupported stored input', async () => {
  const tracked = trackingCredential();
  const result = await tracked.credential.verifyPassword(
    credentialKnownAnswer.password,
    malformedStoredPasswordHashes[0],
  );

  assert.deepEqual(result, {
    valid: false,
    needsUpgrade: false,
    upgradedHash: null,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(tracked.calls, {
    randomByteLengths: [],
    sha256: 0,
    pbkdf2: 0,
  });
});

test('the Node random adapter returns exactly the requested salt length', () => {
  const salt = nodeCredentialCrypto.randomBytes(PASSWORD_SALT_BYTES);

  assert.ok(salt instanceof Uint8Array);
  assert.equal(salt.byteLength, 16);
});
