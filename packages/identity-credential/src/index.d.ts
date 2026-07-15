export interface IdentityCredentialCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(value: Uint8Array): Uint8Array | Promise<Uint8Array>;
  pbkdf2Sha256(
    value: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
  ): Uint8Array | Promise<Uint8Array>;
}

export type ParsedStoredPasswordHash =
  | Readonly<{ kind: 'legacy_sha256'; digestHex: string }>
  | Readonly<{ kind: 'pbkdf2_sha256'; saltHex: string; digestHex: string }>;

export type PasswordVerification = Readonly<{
  valid: boolean;
  needsUpgrade: boolean;
  upgradedHash: string | null;
}>;

export interface IdentityCredential {
  createPasswordHash(password: string, salt?: Uint8Array): Promise<string>;
  verifyPassword(password: string, storedHash: string): Promise<PasswordVerification>;
}

export const PASSWORD_HASH_SCHEME: 'pbkdf2_sha256';
export const PASSWORD_HASH_ITERATIONS: 100000;
export const PASSWORD_SALT_BYTES: 16;
export const PASSWORD_HASH_BYTES: 32;
export const CURRENT_PASSWORD_HASH_PREFIX: 'pbkdf2_sha256$100000$';
export const passwordPolicies: Readonly<{
  human: Readonly<{ minimumCodePoints: 12; maximumCodePoints: 4096 }>;
  automation: Readonly<{ minimumCodePoints: 32; maximumCodePoints: 4096 }>;
}>;

export function parseStoredPasswordHash(value: unknown): ParsedStoredPasswordHash | null;
export function isCurrentPasswordHash(value: unknown): boolean;
export function createIdentityCredential(crypto: IdentityCredentialCrypto): IdentityCredential;
