import { describe, expect, it } from 'vitest';

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
} from '../scripts/identity-credential-conformance.mjs';
import {
  workerCredentialCrypto,
  workerIdentityCredential,
} from '../src/identity/worker-credential-crypto';

function knownAnswerSalt() {
  return Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
}

function trackingCredential() {
  const calls = {
    randomByteLengths: [] as number[],
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
      return workerCredentialCrypto.sha256(value);
    },
    pbkdf2Sha256(value, salt, iterations, length) {
      calls.pbkdf2 += 1;
      return workerCredentialCrypto.pbkdf2Sha256(value, salt, iterations, length);
    },
  });
  return { calls, credential };
}

describe('Worker identity credential conformance', () => {
  it('exports the exact immutable credential contract constants', () => {
    expect(PASSWORD_HASH_SCHEME).toBe('pbkdf2_sha256');
    expect(PASSWORD_HASH_ITERATIONS).toBe(100_000);
    expect(PASSWORD_SALT_BYTES).toBe(16);
    expect(PASSWORD_HASH_BYTES).toBe(32);
    expect(CURRENT_PASSWORD_HASH_PREFIX).toBe('pbkdf2_sha256$100000$');
    expect(passwordPolicies).toEqual({
      human: { minimumCodePoints: 12, maximumCodePoints: 4_096 },
      automation: { minimumCodePoints: 32, maximumCodePoints: 4_096 },
    });
    expect(Object.isFrozen(passwordPolicies)).toBe(true);
    expect(Object.isFrozen(passwordPolicies.human)).toBe(true);
    expect(Object.isFrozen(passwordPolicies.automation)).toBe(true);
    expect(Object.isFrozen(credentialKnownAnswer)).toBe(true);
    expect(Object.isFrozen(malformedStoredPasswordHashes)).toBe(true);
  });

  it('classifies only the two exact stored password hash formats', () => {
    const parsedCurrent = parseStoredPasswordHash(credentialKnownAnswer.currentHash);
    const parsedLegacy = parseStoredPasswordHash(credentialKnownAnswer.legacyHash);

    expect(parsedCurrent).toEqual({
      kind: 'pbkdf2_sha256',
      saltHex: credentialKnownAnswer.saltHex,
      digestHex: credentialKnownAnswer.digestHex,
    });
    expect(parsedLegacy).toEqual({
      kind: 'legacy_sha256',
      digestHex: credentialKnownAnswer.legacyHash,
    });
    expect(Object.isFrozen(parsedCurrent)).toBe(true);
    expect(Object.isFrozen(parsedLegacy)).toBe(true);
    expect(isCurrentPasswordHash(credentialKnownAnswer.currentHash)).toBe(true);
    expect(isCurrentPasswordHash(credentialKnownAnswer.legacyHash)).toBe(false);
  });

  it('rejects every malformed stored password hash in the shared corpus', () => {
    for (const malformed of malformedStoredPasswordHashes) {
      expect(parseStoredPasswordHash(malformed), malformed).toBeNull();
      expect(isCurrentPasswordHash(malformed), malformed).toBe(false);
    }
    for (const malformed of [null, undefined, 0, {}, new Uint8Array(32)]) {
      expect(parseStoredPasswordHash(malformed)).toBeNull();
      expect(isCurrentPasswordHash(malformed)).toBe(false);
    }
  });

  it('creates the same literal current hash with the Worker adapter', async () => {
    await expect(workerIdentityCredential.createPasswordHash(
      credentialKnownAnswer.password,
      knownAnswerSalt(),
    )).resolves.toBe(credentialKnownAnswer.currentHash);
  });

  it('verifies current hashes once and never upgrades them', async () => {
    const correct = trackingCredential();
    const valid = await correct.credential.verifyPassword(
      credentialKnownAnswer.password,
      credentialKnownAnswer.currentHash,
    );

    expect(valid).toEqual({
      valid: true,
      needsUpgrade: false,
      upgradedHash: null,
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(correct.calls).toEqual({
      randomByteLengths: [],
      sha256: 0,
      pbkdf2: 1,
    });

    const wrong = trackingCredential();
    const invalid = await wrong.credential.verifyPassword(
      credentialKnownAnswer.wrongPassword,
      credentialKnownAnswer.currentHash,
    );

    expect(invalid).toEqual({
      valid: false,
      needsUpgrade: false,
      upgradedHash: null,
    });
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(wrong.calls).toEqual({
      randomByteLengths: [],
      sha256: 0,
      pbkdf2: 1,
    });
  });

  it('upgrades one valid legacy hash with one generated 16-byte salt', async () => {
    const correct = trackingCredential();
    const valid = await correct.credential.verifyPassword(
      credentialKnownAnswer.password,
      credentialKnownAnswer.legacyHash,
    );

    expect(valid).toEqual({
      valid: true,
      needsUpgrade: true,
      upgradedHash: credentialKnownAnswer.currentHash,
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(correct.calls).toEqual({
      randomByteLengths: [16],
      sha256: 1,
      pbkdf2: 1,
    });

    const wrong = trackingCredential();
    const invalid = await wrong.credential.verifyPassword(
      credentialKnownAnswer.wrongPassword,
      credentialKnownAnswer.legacyHash,
    );

    expect(invalid).toEqual({
      valid: false,
      needsUpgrade: false,
      upgradedHash: null,
    });
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(wrong.calls).toEqual({
      randomByteLengths: [],
      sha256: 1,
      pbkdf2: 0,
    });
  });

  it('returns invalid without hashing unsupported stored input', async () => {
    const tracked = trackingCredential();
    const result = await tracked.credential.verifyPassword(
      credentialKnownAnswer.password,
      malformedStoredPasswordHashes[0],
    );

    expect(result).toEqual({
      valid: false,
      needsUpgrade: false,
      upgradedHash: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(tracked.calls).toEqual({
      randomByteLengths: [],
      sha256: 0,
      pbkdf2: 0,
    });
  });

  it('the Worker random adapter returns exactly the requested salt length', () => {
    const salt = workerCredentialCrypto.randomBytes(PASSWORD_SALT_BYTES);

    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.byteLength).toBe(16);
  });
});
