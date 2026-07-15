import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import auditSql from '../scripts/sql/identity-compatibility-v1.sql?raw';

const currentHash = `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const legacyHash = 'c'.repeat(64);

const ECMASCRIPT_TRIM_CHARACTERS = [
  ['tab', '\u0009'],
  ['line feed', '\u000a'],
  ['vertical tab', '\u000b'],
  ['form feed', '\u000c'],
  ['carriage return', '\u000d'],
  ['space', '\u0020'],
  ['no-break space', '\u00a0'],
  ['ogham space mark', '\u1680'],
  ['en quad', '\u2000'],
  ['em quad', '\u2001'],
  ['en space', '\u2002'],
  ['em space', '\u2003'],
  ['three-per-em space', '\u2004'],
  ['four-per-em space', '\u2005'],
  ['six-per-em space', '\u2006'],
  ['figure space', '\u2007'],
  ['punctuation space', '\u2008'],
  ['thin space', '\u2009'],
  ['hair space', '\u200a'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['narrow no-break space', '\u202f'],
  ['medium mathematical space', '\u205f'],
  ['ideographic space', '\u3000'],
  ['zero width no-break space', '\ufeff'],
] as const;

interface UserFixture {
  id?: number;
  username?: string | ArrayBuffer;
  passwordHash?: string | ArrayBuffer;
  name?: string | ArrayBuffer;
  role?: string;
  isActive?: number;
  isDeleted?: number;
  createdAt?: string;
}

interface AuditRow {
  audit_version: string;
  legacy_password_hash_count: number;
  unsupported_password_hash_count: number;
  invalid_identity_projection_count: number;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

async function insertUser(fixture: UserFixture = {}) {
  const columns = [
    'username',
    'password_hash',
    'name',
    'role',
    'is_active',
    'is_deleted',
    'created_at',
  ];
  const values: unknown[] = [
    fixture.username ?? 'audit-user',
    fixture.passwordHash ?? currentHash,
    fixture.name ?? 'Audit User',
    fixture.role ?? 'staff',
    fixture.isActive ?? 1,
    fixture.isDeleted ?? 0,
    fixture.createdAt ?? '2026-07-15 12:34:56',
  ];

  if (fixture.id !== undefined) {
    columns.unshift('id');
    values.unshift(fixture.id);
  }

  await env.DB.prepare(
    `INSERT INTO users (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  ).bind(...values).run();
}

async function runAudit() {
  const row = await env.DB.prepare(auditSql).first<AuditRow>();
  if (!row) throw new Error('identity compatibility audit returned no row');
  expect(Object.keys(row)).toEqual([
    'audit_version',
    'legacy_password_hash_count',
    'unsupported_password_hash_count',
    'invalid_identity_projection_count',
  ]);
  expect(row.audit_version).toBe('identity-compatibility-v1');
  return {
    legacy_password_hash_count: row.legacy_password_hash_count,
    unsupported_password_hash_count: row.unsupported_password_hash_count,
    invalid_identity_projection_count: row.invalid_identity_projection_count,
  };
}

describe('identity compatibility aggregate', () => {
  it('classifies one active current hash and one inactive legacy hash as 1/0/0', async () => {
    await insertUser({ username: 'current-user', passwordHash: currentHash });
    await insertUser({
      username: 'inactive-legacy-user',
      passwordHash: legacyHash,
      isActive: 0,
    });

    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 1,
      unsupported_password_hash_count: 0,
      invalid_identity_projection_count: 0,
    });
  });

  it('returns zero counts for an empty user table', async () => {
    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 0,
      unsupported_password_hash_count: 0,
      invalid_identity_projection_count: 0,
    });
  });

  it('does not count a deleted row with unsupported hash and invalid projection fields', async () => {
    await insertUser({
      id: 0,
      username: '',
      passwordHash: 'unsupported',
      name: '',
      isDeleted: 1,
      createdAt: 'not-a-timestamp',
    });

    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 0,
      unsupported_password_hash_count: 0,
      invalid_identity_projection_count: 0,
    });
  });

  const unsupportedHashCases: ReadonlyArray<readonly [string, string | ArrayBuffer]> = [
    ['legacy SHA with NUL suffix', `${'a'.repeat(64)}\u0000x`],
    ['current PBKDF2 with NUL suffix', `${currentHash}\u0000x`],
    ['uppercase legacy SHA', 'C'.repeat(64)],
    ['PBKDF2 iteration 99999', `pbkdf2_sha256$99999$${'a'.repeat(32)}$${'b'.repeat(64)}`],
    ['PBKDF2 iteration 600000', `pbkdf2_sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`],
    ['PBKDF2 31-character salt', `pbkdf2_sha256$100000$${'a'.repeat(31)}$${'b'.repeat(64)}`],
    ['PBKDF2 33-character salt', `pbkdf2_sha256$100000$${'a'.repeat(33)}$${'b'.repeat(64)}`],
    ['PBKDF2 63-character digest', `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(63)}`],
    ['PBKDF2 65-character digest', `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'b'.repeat(65)}`],
    ['PBKDF2 uppercase salt', `pbkdf2_sha256$100000$${'A'.repeat(32)}$${'b'.repeat(64)}`],
    ['PBKDF2 uppercase digest', `pbkdf2_sha256$100000$${'a'.repeat(32)}$${'B'.repeat(64)}`],
    ['PBKDF2 extra segment', `${currentHash}$extra`],
    ['unknown scheme', `argon2id$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`],
    ['BLOB value', new TextEncoder().encode(legacyHash).buffer],
    ['NULL-like text value', 'NULL'],
  ];

  it.each(unsupportedHashCases)('%s adds exactly one unsupported hash', async (_label, passwordHash) => {
    await insertUser({ passwordHash });

    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 0,
      unsupported_password_hash_count: 1,
      invalid_identity_projection_count: 0,
    });
  });

  const projectionCases: Array<readonly [string, UserFixture]> = [
    ['zero id', { id: 0 }],
    ['negative id', { id: -1 }],
    ['empty username', { username: '' }],
    ['short username containing NUL', { username: 'audit\u0000user' }],
    ['over-limit username', { username: 'u'.repeat(129) }],
    ['over-limit username hidden behind NUL', { username: `${'u'.repeat(128)}\u0000x` }],
    ['BLOB username', { username: new TextEncoder().encode('audit-user').buffer }],
    ['empty name', { name: '' }],
    ['short name containing NUL', { name: 'Audit\u0000User' }],
    ['over-limit name', { name: 'n'.repeat(201) }],
    ['over-limit name hidden behind NUL', { name: `${'n'.repeat(200)}\u0000x` }],
    ['BLOB name', { name: new TextEncoder().encode('Audit User').buffer }],
    ['non-integer is_active', { isActive: 0.5 }],
    ['negative is_active', { isActive: -1 }],
    ['out-of-range is_active', { isActive: 2 }],
    ['non-round-trip created_at', { createdAt: '2026-07-15T12:34:56' }],
    ['hour 24 created_at', { createdAt: '2026-07-15 24:00:00' }],
    ['wrong-length created_at', { createdAt: '2026-07-15 12:34:56Z' }],
  ];

  for (const [label, character] of ECMASCRIPT_TRIM_CHARACTERS) {
    projectionCases.push(
      [`${label} around username`, { username: `${character}audit-user${character}` }],
      [`${label} around name`, { name: `${character}Audit User${character}` }],
    );
  }

  it.each(projectionCases)('%s adds exactly one invalid projection', async (_label, fixture) => {
    await insertUser(fixture);

    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 0,
      unsupported_password_hash_count: 0,
      invalid_identity_projection_count: 1,
    });
  });

  it('counts a non-admin/staff role without weakening the production constraint', async () => {
    await env.DB.exec('PRAGMA ignore_check_constraints = ON');
    try {
      await insertUser({ role: 'owner' });
    } finally {
      await env.DB.exec('PRAGMA ignore_check_constraints = OFF');
    }

    expect(await runAudit()).toEqual({
      legacy_password_hash_count: 0,
      unsupported_password_hash_count: 0,
      invalid_identity_projection_count: 1,
    });
  });
});
