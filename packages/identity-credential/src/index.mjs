export const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256';
export const PASSWORD_HASH_ITERATIONS = 100_000;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 32;
export const CURRENT_PASSWORD_HASH_PREFIX = 'pbkdf2_sha256$100000$';

export const passwordPolicies = Object.freeze({
  human: Object.freeze({
    minimumCodePoints: 12,
    maximumCodePoints: 4_096,
  }),
  automation: Object.freeze({
    minimumCodePoints: 32,
    maximumCodePoints: 4_096,
  }),
});

const CURRENT_PASSWORD_HASH_PATTERN =
  /^pbkdf2_sha256\$100000\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const LEGACY_PASSWORD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOWERCASE_HEX = '0123456789abcdef';
const textEncoder = new TextEncoder();

function frozenVerification(valid, needsUpgrade, upgradedHash) {
  return Object.freeze({ valid, needsUpgrade, upgradedHash });
}

function copySalt(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== PASSWORD_SALT_BYTES) {
    throw new TypeError('Password salt must be exactly 16 bytes');
  }
  return new Uint8Array(value);
}

function copyDerivedBytes(value, expectedLength) {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    throw new TypeError('Credential crypto returned an invalid byte length');
  }
  return new Uint8Array(value);
}

function bytesToHex(value) {
  let result = '';
  for (const byte of value) {
    result += LOWERCASE_HEX[byte >>> 4] + LOWERCASE_HEX[byte & 0x0f];
  }
  return result;
}

function lowercaseHexNibble(charCode) {
  if (charCode >= 48 && charCode <= 57) return charCode - 48;
  if (charCode >= 97 && charCode <= 102) return charCode - 87;
  return -1;
}

function lowercaseHexToBytes(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 2 !== 0
  ) {
    throw new TypeError('Invalid lowercase hex');
  }

  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    const high = lowercaseHexNibble(value.charCodeAt(index * 2));
    const low = lowercaseHexNibble(value.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) {
      throw new TypeError('Invalid lowercase hex');
    }
    result[index] = (high << 4) | low;
  }
  return result;
}

function equalLowercaseDigests(actual, expected) {
  if (actual.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export function parseStoredPasswordHash(value) {
  if (typeof value !== 'string') return null;

  const currentMatch = CURRENT_PASSWORD_HASH_PATTERN.exec(value);
  if (currentMatch) {
    return Object.freeze({
      kind: 'pbkdf2_sha256',
      saltHex: currentMatch[1],
      digestHex: currentMatch[2],
    });
  }
  if (LEGACY_PASSWORD_HASH_PATTERN.test(value)) {
    return Object.freeze({
      kind: 'legacy_sha256',
      digestHex: value,
    });
  }
  return null;
}

export function isCurrentPasswordHash(value) {
  return parseStoredPasswordHash(value)?.kind === 'pbkdf2_sha256';
}

export function createIdentityCredential(crypto) {
  async function createPasswordHashBytes(passwordBytes, suppliedSalt) {
    const salt = copySalt(
      suppliedSalt === undefined
        ? crypto.randomBytes(PASSWORD_SALT_BYTES)
        : suppliedSalt,
    );
    const derivedBytes = copyDerivedBytes(
      await crypto.pbkdf2Sha256(
        passwordBytes,
        salt,
        PASSWORD_HASH_ITERATIONS,
        PASSWORD_HASH_BYTES,
      ),
      PASSWORD_HASH_BYTES,
    );
    return CURRENT_PASSWORD_HASH_PREFIX + bytesToHex(salt) + '$' + bytesToHex(derivedBytes);
  }

  return Object.freeze({
    async createPasswordHash(password, salt) {
      const passwordBytes = textEncoder.encode(password);
      return createPasswordHashBytes(passwordBytes, salt);
    },

    async verifyPassword(password, storedHash) {
      const parsedHash = parseStoredPasswordHash(storedHash);
      if (parsedHash === null) {
        return frozenVerification(false, false, null);
      }

      const passwordBytes = textEncoder.encode(password);
      if (parsedHash.kind === 'pbkdf2_sha256') {
        const derivedBytes = copyDerivedBytes(
          await crypto.pbkdf2Sha256(
            passwordBytes,
            lowercaseHexToBytes(parsedHash.saltHex),
            PASSWORD_HASH_ITERATIONS,
            PASSWORD_HASH_BYTES,
          ),
          PASSWORD_HASH_BYTES,
        );
        const valid = equalLowercaseDigests(
          bytesToHex(derivedBytes),
          parsedHash.digestHex,
        );
        return frozenVerification(valid, false, null);
      }

      const legacyBytes = copyDerivedBytes(
        await crypto.sha256(passwordBytes),
        PASSWORD_HASH_BYTES,
      );
      if (!equalLowercaseDigests(bytesToHex(legacyBytes), parsedHash.digestHex)) {
        return frozenVerification(false, false, null);
      }

      const upgradedHash = await createPasswordHashBytes(passwordBytes);
      return frozenVerification(true, true, upgradedHash);
    },
  });
}
