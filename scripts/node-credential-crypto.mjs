import { createHash, pbkdf2, randomBytes } from 'node:crypto';

import {
  createIdentityCredential,
} from '@here-is-order/identity-credential';

export const nodeCredentialCrypto = Object.freeze({
  randomBytes(length) {
    return new Uint8Array(randomBytes(length));
  },

  sha256(value) {
    return new Uint8Array(createHash('sha256').update(value).digest());
  },

  pbkdf2Sha256(value, salt, iterations, length) {
    return new Promise((resolve, reject) => {
      pbkdf2(value, salt, iterations, length, 'sha256', (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new Uint8Array(derivedKey));
      });
    });
  },
});

export const nodeIdentityCredential = createIdentityCredential(nodeCredentialCrypto);

export async function createPasswordHash(password, salt) {
  return nodeIdentityCredential.createPasswordHash(password, salt);
}
