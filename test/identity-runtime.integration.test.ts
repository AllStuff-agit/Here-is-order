import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  identity,
  SESSION_SECONDS,
  type RuntimeIdentity,
} from '../src/identity';
import { workerIdentityCredential } from '../src/identity/worker-credential-crypto';
import { withTestTrigger } from './helpers/test-trigger';

type AuthenticationResult = Awaited<ReturnType<RuntimeIdentity['authenticate']>>;
type UserRole = 'admin' | 'staff';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENT_HASH_PATTERN = /^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

async function legacyPasswordHash(password: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function insertUser(options: Readonly<{
  username?: string;
  passwordHash?: string;
  name?: string;
  role?: UserRole;
  isActive?: 0 | 1;
  isDeleted?: 0 | 1;
  updatedAt?: string;
}> = {}) {
  const username = options.username ?? `identity-${crypto.randomUUID()}`;
  const passwordHash = options.passwordHash ?? 'unused-in-runtime-test';
  const name = options.name ?? 'Identity Test User';
  const role = options.role ?? 'admin';
  const isActive = options.isActive ?? 1;
  const isDeleted = options.isDeleted ?? 0;
  const updatedAt = options.updatedAt ?? '2001-02-03 04:05:06';
  const result = await env.DB.prepare(
    `INSERT INTO users
       (username, password_hash, name, role, is_active, is_deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    username,
    passwordHash,
    name,
    role,
    isActive,
    isDeleted,
    updatedAt,
  ).run();

  return Object.freeze({
    id: Number(result.meta.last_row_id),
    username,
    passwordHash,
    name,
    role,
    isActive,
    isDeleted,
    updatedAt,
  });
}

async function insertSession(
  userId: number,
  expiresAt: string,
  token = `runtime-${crypto.randomUUID()}`,
) {
  const result = await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
  ).bind(token, userId, expiresAt).run();
  return Object.freeze({
    id: Number(result.meta.last_row_id),
    token,
    expiresAt,
  });
}

async function databaseTimestamp(format: 'iso' | 'sqlite') {
  const expression = format === 'iso'
    ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    : "datetime('now')";
  const row = await env.DB.prepare(`SELECT ${expression} AS value`)
    .first<{ value: string }>();
  if (!row) throw new Error('Expected a database timestamp fixture.');
  return row.value;
}

function expectExactFrozenObject(
  value: object,
  keys: readonly string[],
) {
  expect(Object.keys(value)).toEqual(keys);
  expect(Object.isFrozen(value)).toBe(true);
}

function expectFrozenFailure(
  result: AuthenticationResult,
  kind: 'account_unavailable' | 'invalid_credentials',
) {
  expect(result).toEqual({ ok: false, error: { kind } });
  expectExactFrozenObject(result, ['ok', 'error']);
  if (result.ok) throw new Error('Expected an authentication failure.');
  expectExactFrozenObject(result.error, ['kind']);
}

function requireFrozenSuccess(result: AuthenticationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected successful authentication.');
  expectExactFrozenObject(result, ['ok', 'value']);
  expectExactFrozenObject(result.value, ['token', 'user']);
  expectExactFrozenObject(result.value.user, ['id', 'username', 'name', 'role']);
  return result.value;
}

function beforeBatchProxy(
  inject: (db: D1Database) => Promise<void>,
) {
  let injected = false;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          injected = true;
          await inject(target);
          return await target.batch(statements);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return Object.freeze({
    db,
    wasInjected: () => injected,
  });
}

describe('Runtime Identity session resolution', () => {
  it('returns exact frozen principals and fresh exact frozen public projections from live user state', async () => {
    const user = await insertUser({
      username: `live-${crypto.randomUUID()}`,
      name: 'Initial Name',
      role: 'admin',
    });
    const session = await insertSession(user.id, '2999-01-01 00:00:00');
    const runtime = identity(env.DB);

    const initial = await runtime.resolveSession(session.token);
    expect(initial).toEqual({
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    });
    if (!initial) throw new Error('Expected a resolved session.');
    expectExactFrozenObject(initial, [
      'sessionId',
      'sessionExpiresAt',
      'userId',
      'username',
      'name',
      'role',
    ]);

    const firstProjection = runtime.currentUser(initial);
    const secondProjection = runtime.currentUser(initial);
    expect(firstProjection).toEqual({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    });
    expect(secondProjection).toEqual(firstProjection);
    expect(secondProjection).not.toBe(firstProjection);
    expectExactFrozenObject(firstProjection, ['id', 'username', 'name', 'role']);
    expectExactFrozenObject(secondProjection, ['id', 'username', 'name', 'role']);

    const nextUsername = `renamed-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `UPDATE users
          SET username = ?, name = 'Updated Name', role = 'staff'
        WHERE id = ?`,
    ).bind(nextUsername, user.id).run();
    const changed = await runtime.resolveSession(session.token);
    expect(changed).toEqual({
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      userId: user.id,
      username: nextUsername,
      name: 'Updated Name',
      role: 'staff',
    });
    if (!changed) throw new Error('Expected the changed user to resolve.');
    expect(Object.isFrozen(changed)).toBe(true);

    await env.DB.prepare('UPDATE users SET is_active = 0 WHERE id = ?')
      .bind(user.id).run();
    await expect(runtime.resolveSession(session.token)).resolves.toBeNull();

    await env.DB.prepare('UPDATE users SET is_active = 1 WHERE id = ?')
      .bind(user.id).run();
    const reactivated = await runtime.resolveSession(session.token);
    expect(reactivated?.sessionId).toBe(session.id);
    expect(reactivated?.sessionExpiresAt).toBe(session.expiresAt);

    await env.DB.prepare('UPDATE users SET is_deleted = 1 WHERE id = ?')
      .bind(user.id).run();
    await expect(runtime.resolveSession(session.token)).resolves.toBeNull();

    await env.DB.prepare('UPDATE users SET is_deleted = 0 WHERE id = ?')
      .bind(user.id).run();
    const restored = await runtime.resolveSession(session.token);
    expect(restored?.sessionId).toBe(session.id);
    const row = await env.DB.prepare(
      'SELECT id, token, expires_at FROM sessions WHERE token = ?',
    ).bind(session.token).first<{ id: number; token: string; expires_at: string }>();
    expect(row).toEqual({
      id: session.id,
      token: session.token,
      expires_at: session.expiresAt,
    });
  });

  it.each([
    ['future ISO', 'future_iso', true],
    ['future SQLite', 'future_sqlite', true],
    ['invalid', 'invalid', false],
    ['current ISO', 'current_iso', false],
    ['current SQLite', 'current_sqlite', false],
    ['past ISO', 'past_iso', false],
    ['past SQLite', 'past_sqlite', false],
  ] as const)('%s expiry resolves only when strictly future', async (_label, fixture, resolves) => {
    const user = await insertUser();
    const expiresAt = fixture === 'future_iso'
      ? '2999-01-01T00:00:00.000Z'
      : fixture === 'future_sqlite'
        ? '2999-01-01 00:00:00'
        : fixture === 'invalid'
          ? 'not-a-timestamp'
          : fixture === 'current_iso'
            ? await databaseTimestamp('iso')
            : fixture === 'current_sqlite'
              ? await databaseTimestamp('sqlite')
              : fixture === 'past_iso'
                ? '2000-01-01T00:00:00.000Z'
                : '2000-01-01 00:00:00';
    const session = await insertSession(user.id, expiresAt);

    const principal = await identity(env.DB).resolveSession(session.token);
    if (!resolves) {
      expect(principal).toBeNull();
      return;
    }

    expect(principal).toEqual({
      sessionId: session.id,
      sessionExpiresAt: expiresAt,
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    });
    if (!principal) throw new Error('Expected a future session to resolve.');
    expectExactFrozenObject(principal, [
      'sessionId',
      'sessionExpiresAt',
      'userId',
      'username',
      'name',
      'role',
    ]);
  });

  it('lets unexpected D1 resolution failures reject', async () => {
    const failingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return () => {
            throw new Error('TEST_RESOLVE_LOOKUP_FAILURE');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(identity(failingDb).resolveSession('token'))
      .rejects.toThrow('TEST_RESOLVE_LOOKUP_FAILURE');
  });
});

describe('Runtime Identity authentication', () => {
  it('uses the exact literal 30-day lifetime', () => {
    expect(SESSION_SECONDS).toBe(2_592_000);
  });

  it('authenticates a legacy hash with a raw UUIDv4 session, exact audit, and canonical upgrade without cleanup', async () => {
    const username = `legacy-${crypto.randomUUID()}`;
    const password = `legacy-password-${crypto.randomUUID()}`;
    const passwordHash = await legacyPasswordHash(password);
    const user = await insertUser({
      username,
      passwordHash,
      name: 'Legacy Login',
      role: 'staff',
    });
    await insertSession(user.id, 'not-a-timestamp', 'authenticate-must-not-clean');

    const result = await identity(env.DB).authenticate({ username, password });
    const value = requireFrozenSuccess(result);
    expect(value.token).toMatch(UUID_V4_PATTERN);
    expect(value.token).toBe(value.token.toLowerCase());
    expect(value.user).toEqual({
      id: user.id,
      username,
      name: 'Legacy Login',
      role: 'staff',
    });

    const session = await env.DB.prepare(
      `SELECT id, token, user_id, expires_at, created_at,
              unixepoch(expires_at) - unixepoch(created_at) AS lifetime_seconds
         FROM sessions
        WHERE token = ?`,
    ).bind(value.token).first<{
      id: number;
      token: string;
      user_id: number;
      expires_at: string;
      created_at: string;
      lifetime_seconds: number;
    }>();
    expect(session).toMatchObject({
      token: value.token,
      user_id: user.id,
      lifetime_seconds: SESSION_SECONDS,
    });
    expect(session?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(session?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, action, entity_type, entity_id, before_json, after_json
         FROM audit_logs
        WHERE actor_user_id = ?`,
    ).bind(user.id).first<{
      actor_user_id: number;
      action: string;
      entity_type: string;
      entity_id: number;
      before_json: string | null;
      after_json: string | null;
    }>();
    expect(audit).toEqual({
      actor_user_id: user.id,
      action: 'login',
      entity_type: 'user',
      entity_id: user.id,
      before_json: null,
      after_json: JSON.stringify({ username }),
    });

    const stored = await env.DB.prepare(
      'SELECT password_hash, updated_at FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string; updated_at: string }>();
    expect(stored?.password_hash).toMatch(CURRENT_HASH_PATTERN);
    expect(stored?.password_hash).not.toBe(passwordHash);
    expect(stored?.updated_at).not.toBe(user.updatedAt);

    const stale = await env.DB.prepare(
      "SELECT token FROM sessions WHERE token = 'authenticate-must-not-clean'",
    ).first<{ token: string }>();
    expect(stale?.token).toBe('authenticate-must-not-clean');
  });

  it('authenticates a current hash without changing the observed hash or sentinel updated_at', async () => {
    const username = `current-${crypto.randomUUID()}`;
    const password = `current-password-${crypto.randomUUID()}`;
    const passwordHash = await workerIdentityCredential.createPasswordHash(
      password,
      new Uint8Array(16).fill(7),
    );
    const user = await insertUser({
      username,
      passwordHash,
      name: 'Current Login',
      role: 'admin',
      updatedAt: '2002-03-04 05:06:07',
    });

    const value = requireFrozenSuccess(
      await identity(env.DB).authenticate({ username, password }),
    );
    expect(value.token).toMatch(UUID_V4_PATTERN);
    expect(value.user).toEqual({
      id: user.id,
      username,
      name: 'Current Login',
      role: 'admin',
    });

    const session = await env.DB.prepare(
      `SELECT token, user_id,
              unixepoch(expires_at) - unixepoch(created_at) AS lifetime_seconds
         FROM sessions
        WHERE token = ?`,
    ).bind(value.token).first<{
      token: string;
      user_id: number;
      lifetime_seconds: number;
    }>();
    expect(session).toEqual({
      token: value.token,
      user_id: user.id,
      lifetime_seconds: SESSION_SECONDS,
    });

    const audit = await env.DB.prepare(
      `SELECT action, entity_type, before_json, after_json
         FROM audit_logs
        WHERE actor_user_id = ?`,
    ).bind(user.id).first<{
      action: string;
      entity_type: string;
      before_json: string | null;
      after_json: string | null;
    }>();
    expect(audit).toEqual({
      action: 'login',
      entity_type: 'user',
      before_json: null,
      after_json: JSON.stringify({ username }),
    });

    const stored = await env.DB.prepare(
      'SELECT password_hash, updated_at FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string; updated_at: string }>();
    expect(stored).toEqual({
      password_hash: passwordHash,
      updated_at: user.updatedAt,
    });
  });

  it('does not activate future identity request normalization or input caps', async () => {
    const username = `x${'u'.repeat(128)}`;
    const password = `p${'w'.repeat(4_096)}`;
    const passwordHash = await legacyPasswordHash(password);
    const user = await insertUser({ username, passwordHash });

    const value = requireFrozenSuccess(
      await identity(env.DB).authenticate({ username, password }),
    );
    expect(value.user.id).toBe(user.id);
    expect(value.user.username).toBe(username);
  });

  it.each([
    ['missing', null, 'account_unavailable'],
    ['inactive', { isActive: 0 as const, isDeleted: 0 as const }, 'account_unavailable'],
    ['deleted', { isActive: 1 as const, isDeleted: 1 as const }, 'account_unavailable'],
  ] as const)('returns an exact frozen %s account failure', async (_label, state, kind) => {
    const username = `unavailable-${crypto.randomUUID()}`;
    if (state) {
      await insertUser({
        username,
        passwordHash: await legacyPasswordHash('correct-password'),
        isActive: state.isActive,
        isDeleted: state.isDeleted,
      });
    }

    const runtime = identity(env.DB);
    const first = await runtime.authenticate({ username, password: 'correct-password' });
    const second = await runtime.authenticate({ username, password: 'correct-password' });
    expectFrozenFailure(first, kind);
    expectFrozenFailure(second, kind);
    expect(second).not.toBe(first);
    if (!first.ok && !second.ok) expect(second.error).not.toBe(first.error);
  });

  it('returns an exact frozen invalid_credentials failure for a wrong password', async () => {
    const username = `wrong-${crypto.randomUUID()}`;
    const passwordHash = await legacyPasswordHash('correct-password');
    const user = await insertUser({
      username,
      passwordHash,
    });

    const result = await identity(env.DB).authenticate({
      username,
      password: 'wrong-password',
    });
    expectFrozenFailure(result, 'invalid_credentials');
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM audit_logs) AS audits`,
    ).first<{ sessions: number; audits: number }>();
    expect(counts).toEqual({ sessions: 0, audits: 0 });
    const stored = await env.DB.prepare(
      'SELECT password_hash, updated_at FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string; updated_at: string }>();
    expect(stored).toEqual({
      password_hash: passwordHash,
      updated_at: user.updatedAt,
    });
  });

  it.each([
    ['observed hash replacement', 'hash'],
    ['is_active deactivation', 'inactive'],
    ['is_deleted transition', 'deleted'],
  ] as const)('rejects a pre-batch %s race without session, audit, or upgrade', async (_label, race) => {
    const username = `race-${race}-${crypto.randomUUID()}`;
    const password = `race-password-${crypto.randomUUID()}`;
    const observedHash = await legacyPasswordHash(password);
    const user = await insertUser({ username, passwordHash: observedHash });
    const externalHash = await workerIdentityCredential.createPasswordHash(
      `external-${crypto.randomUUID()}`,
      new Uint8Array(16).fill(9),
    );
    const externalUpdatedAt = '2042-03-04 05:06:07';
    const racing = beforeBatchProxy(async (db) => {
      if (race === 'hash') {
        await db.prepare(
          'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
        ).bind(externalHash, externalUpdatedAt, user.id).run();
      } else if (race === 'inactive') {
        await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?')
          .bind(user.id).run();
      } else {
        await db.prepare('UPDATE users SET is_deleted = 1 WHERE id = ?')
          .bind(user.id).run();
      }
    });

    const result = await identity(racing.db).authenticate({ username, password });
    expect(racing.wasInjected()).toBe(true);
    expectFrozenFailure(result, 'invalid_credentials');

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS sessions,
         (SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = ?) AS audits`,
    ).bind(user.id, user.id).first<{ sessions: number; audits: number }>();
    expect(counts).toEqual({ sessions: 0, audits: 0 });
    const stored = await env.DB.prepare(
      'SELECT password_hash, is_active, is_deleted, updated_at FROM users WHERE id = ?',
    ).bind(user.id).first<{
      password_hash: string;
      is_active: number;
      is_deleted: number;
      updated_at: string;
    }>();
    expect(stored?.password_hash).toBe(race === 'hash' ? externalHash : observedHash);
    expect(stored?.is_active).toBe(race === 'inactive' ? 0 : 1);
    expect(stored?.is_deleted).toBe(race === 'deleted' ? 1 : 0);
    expect(stored?.updated_at).toBe(race === 'hash' ? externalUpdatedAt : user.updatedAt);
  });

  it('rejects and rolls back the session, audit, and legacy upgrade when login audit insertion fails', async () => {
    const username = `audit-failure-${crypto.randomUUID()}`;
    const password = `audit-password-${crypto.randomUUID()}`;
    const observedHash = await legacyPasswordHash(password);
    const user = await insertUser({ username, passwordHash: observedHash });

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_login_audit',
      `CREATE TRIGGER test_fail_runtime_login_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'login'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_LOGIN_AUDIT_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).authenticate({ username, password }))
          .rejects.toThrow();
      },
    );

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS sessions,
         (SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = ?) AS audits`,
    ).bind(user.id, user.id).first<{ sessions: number; audits: number }>();
    expect(counts).toEqual({ sessions: 0, audits: 0 });
    const stored = await env.DB.prepare(
      'SELECT password_hash, updated_at FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string; updated_at: string }>();
    expect(stored).toEqual({
      password_hash: observedHash,
      updated_at: user.updatedAt,
    });
  });

  it('executes the conditional session insert before login audit and audit before legacy upgrade', async () => {
    const username = `ordered-${crypto.randomUUID()}`;
    const password = `ordered-password-${crypto.randomUUID()}`;
    const observedHash = await legacyPasswordHash(password);
    const user = await insertUser({ username, passwordHash: observedHash });

    await withTestTrigger(
      env.DB,
      'test_require_session_before_login_audit',
      `CREATE TRIGGER test_require_session_before_login_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'login'
        AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE user_id = NEW.actor_user_id
        )
       BEGIN
         SELECT RAISE(ABORT, 'TEST_LOGIN_AUDIT_BEFORE_SESSION');
       END`,
      async () => {
        await withTestTrigger(
          env.DB,
          'test_require_audit_before_hash_upgrade',
          `CREATE TRIGGER test_require_audit_before_hash_upgrade
           BEFORE UPDATE OF password_hash ON users
           WHEN NEW.id = ${user.id}
            AND NOT EXISTS (
              SELECT 1 FROM audit_logs
               WHERE actor_user_id = NEW.id
                 AND action = 'login'
                 AND entity_type = 'user'
            )
           BEGIN
             SELECT RAISE(ABORT, 'TEST_HASH_UPGRADE_BEFORE_LOGIN_AUDIT');
           END`,
          async () => {
            requireFrozenSuccess(
              await identity(env.DB).authenticate({ username, password }),
            );
          },
        );
      },
    );

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS sessions,
         (SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = ?) AS audits`,
    ).bind(user.id, user.id).first<{ sessions: number; audits: number }>();
    expect(counts).toEqual({ sessions: 1, audits: 1 });
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(CURRENT_HASH_PATTERN);
  });

  it('lets an unexpected lookup failure reject', async () => {
    const failingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return () => {
            throw new Error('TEST_AUTH_LOOKUP_FAILURE');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(identity(failingDb).authenticate({
      username: 'lookup-failure',
      password: 'password',
    })).rejects.toThrow('TEST_AUTH_LOOKUP_FAILURE');
  });

  it('lets an unexpected batch failure reject', async () => {
    const username = `batch-failure-${crypto.randomUUID()}`;
    const password = `batch-password-${crypto.randomUUID()}`;
    await insertUser({
      username,
      passwordHash: await legacyPasswordHash(password),
    });
    const failingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async () => {
            throw new Error('TEST_AUTH_BATCH_FAILURE');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(identity(failingDb).authenticate({ username, password }))
      .rejects.toThrow('TEST_AUTH_BATCH_FAILURE');
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM audit_logs) AS audits`,
    ).first<{ sessions: number; audits: number }>();
    expect(counts).toEqual({ sessions: 0, audits: 0 });
  });

  it('lets an unexpected UUID generation failure reject', async () => {
    const username = `uuid-failure-${crypto.randomUUID()}`;
    const password = `uuid-password-${crypto.randomUUID()}`;
    await insertUser({
      username,
      passwordHash: await legacyPasswordHash(password),
    });
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('TEST_RANDOM_UUID_FAILURE');
    });

    try {
      await expect(identity(env.DB).authenticate({ username, password }))
        .rejects.toThrow('TEST_RANDOM_UUID_FAILURE');
    } finally {
      randomUuid.mockRestore();
    }
  });
});

describe('Runtime Identity expired-session cleanup', () => {
  it('deletes invalid, current, and past ISO/SQLite expiries while preserving both future formats', async () => {
    const user = await insertUser();
    const currentIso = await databaseTimestamp('iso');
    const currentSqlite = await databaseTimestamp('sqlite');
    const fixtures = [
      ['cleanup-invalid', 'not-a-timestamp'],
      ['cleanup-current-iso', currentIso],
      ['cleanup-current-sqlite', currentSqlite],
      ['cleanup-past-iso', '2000-01-01T00:00:00.000Z'],
      ['cleanup-past-sqlite', '2000-01-01 00:00:00'],
      ['cleanup-future-iso', '2999-01-01T00:00:00.000Z'],
      ['cleanup-future-sqlite', '2999-01-01 00:00:00'],
    ] as const;
    await env.DB.batch(fixtures.map(([token, expiresAt]) => env.DB.prepare(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    ).bind(token, user.id, expiresAt)));

    await identity(env.DB).cleanupExpiredSessions();

    const remaining = await env.DB.prepare(
      'SELECT token, expires_at FROM sessions ORDER BY token ASC',
    ).all<{ token: string; expires_at: string }>();
    expect(remaining.results).toEqual([
      { token: 'cleanup-future-iso', expires_at: '2999-01-01T00:00:00.000Z' },
      { token: 'cleanup-future-sqlite', expires_at: '2999-01-01 00:00:00' },
    ]);
  });

  it('rejects cleanup failures without logging and leaves the transaction state intact', async () => {
    const user = await insertUser();
    await insertSession(user.id, 'not-a-timestamp', 'cleanup-reject');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await withTestTrigger(
        env.DB,
        'test_fail_runtime_session_cleanup',
        `CREATE TRIGGER test_fail_runtime_session_cleanup
         BEFORE DELETE ON sessions
         WHEN OLD.token = 'cleanup-reject'
         BEGIN
           SELECT RAISE(ABORT, 'TEST_RUNTIME_SESSION_CLEANUP_FAILURE');
         END`,
        async () => {
          await expect(identity(env.DB).cleanupExpiredSessions()).rejects.toThrow();
        },
      );
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
    }

    const remaining = await env.DB.prepare(
      "SELECT token FROM sessions WHERE token = 'cleanup-reject'",
    ).first<{ token: string }>();
    expect(remaining?.token).toBe('cleanup-reject');
  });
});
