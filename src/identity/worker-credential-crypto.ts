import {
  createIdentityCredential,
  type IdentityCredentialCrypto,
} from '@here-is-order/identity-credential';

export const workerCredentialCrypto: IdentityCredentialCrypto = Object.freeze({
  randomBytes(length: number) {
    return crypto.getRandomValues(new Uint8Array(length));
  },

  async sha256(value: Uint8Array) {
    const digest = await crypto.subtle.digest('SHA-256', value as BufferSource);
    return new Uint8Array(digest);
  },

  async pbkdf2Sha256(
    value: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
  ) {
    const key = await crypto.subtle.importKey(
      'raw',
      value as BufferSource,
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        iterations,
      },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  },
});

export const workerIdentityCredential = createIdentityCredential(workerCredentialCrypto);
