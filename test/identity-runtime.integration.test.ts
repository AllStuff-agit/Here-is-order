import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  identity,
  SESSION_SECONDS,
  type IdentityFailure,
  type IdentityPrincipal,
  type IdentitySuccess,
  type RuntimeIdentity,
} from '../src/identity';
import { workerIdentityCredential } from '../src/identity/worker-credential-crypto';
import { withTestTrigger } from './helpers/test-trigger';

type AuthenticationResult = Awaited<ReturnType<RuntimeIdentity['authenticate']>>;
type UserRole = 'admin' | 'staff';
type IntentOutcome<T = unknown> = IdentitySuccess<T> | IdentityFailure<string>;

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

function expectFrozenIntentFailure(
  result: IntentOutcome,
  kind: string,
) {
  expect(result).toEqual({ ok: false, error: { kind } });
  expectExactFrozenObject(result, ['ok', 'error']);
  if (result.ok) throw new Error(`Expected ${kind} intent failure.`);
  expectExactFrozenObject(result.error, ['kind']);
}

function requireFrozenIntentSuccess<T>(result: IntentOutcome<T>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected successful identity intent.');
  expectExactFrozenObject(result, ['ok', 'value']);
  return result.value;
}

function principalFor(
  user: Readonly<{
    id: number;
    username: string;
    name: string;
    role: UserRole;
  }>,
  session: Readonly<{
    id?: number;
    expiresAt?: string;
  }> = {},
) {
  return Object.freeze({
    sessionId: session.id ?? 9_001,
    sessionExpiresAt: session.expiresAt ?? '2999-01-01 00:00:00',
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
  } satisfies IdentityPrincipal);
}

type AuditRow = Readonly<{
  actor_user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  before_json: string | null;
  after_json: string | null;
}>;

async function auditRows() {
  const rows = await env.DB.prepare(
    `SELECT actor_user_id, action, entity_type, entity_id, before_json, after_json
       FROM audit_logs
      ORDER BY id ASC`,
  ).all<AuditRow>();
  return rows.results;
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

function afterBatchBeforeFirstProxy(
  inject: (db: D1Database) => Promise<void>,
) {
  let batchCompleted = false;
  let injected = false;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          batchCompleted = true;
          return results;
        };
      }
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'bind') {
                return (...values: unknown[]) => {
                  const bound = statementTarget.bind(...values);
                  return new Proxy(bound, {
                    get(boundTarget, boundProperty) {
                      if (boundProperty === 'first') {
                        return async (columnName?: string) => {
                          if (batchCompleted && !injected) {
                            injected = true;
                            await inject(target);
                          }
                          return columnName === undefined
                            ? await boundTarget.first()
                            : await boundTarget.first(columnName);
                        };
                      }
                      const value = Reflect.get(boundTarget, boundProperty, boundTarget);
                      return typeof value === 'function' ? value.bind(boundTarget) : value;
                    },
                  });
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
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

describe('Runtime Identity Task 4 intent surface', () => {
  it('rejects staff list access before touching D1', async () => {
    const staff = principalFor({
      id: 41,
      username: 'staff-no-db',
      name: 'Staff No DB',
      role: 'staff',
    });
    let accessed = false;
    const guardedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare' || property === 'batch') {
          accessed = true;
          throw new Error('TEST_STAFF_LIST_TOUCHED_D1');
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await identity(guardedDb).listUsers(staff);

    expectFrozenIntentFailure(result, 'forbidden');
    expect(accessed).toBe(false);
  });

  it('lists exact frozen nondeleted admin projections in id order including inactive users', async () => {
    const admin = await insertUser({
      username: 'list-admin',
      name: 'List Admin',
      role: 'admin',
    });
    const inactive = await insertUser({
      username: 'list-inactive',
      name: 'List Inactive',
      role: 'staff',
      isActive: 0,
    });
    const deleted = await insertUser({
      username: 'list-deleted',
      name: 'List Deleted',
      role: 'staff',
      isDeleted: 1,
    });
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET created_at = ? WHERE id = ?')
        .bind('2001-01-01 00:00:01', admin.id),
      env.DB.prepare('UPDATE users SET created_at = ? WHERE id = ?')
        .bind('2001-01-01 00:00:02', inactive.id),
      env.DB.prepare('UPDATE users SET created_at = ? WHERE id = ?')
        .bind('2001-01-01 00:00:03', deleted.id),
    ]);

    const rows = requireFrozenIntentSuccess(
      await identity(env.DB).listUsers(principalFor(admin)),
    );

    expect(rows).toEqual([
      {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: 'admin',
        is_active: 1,
        created_at: '2001-01-01 00:00:01',
      },
      {
        id: inactive.id,
        username: inactive.username,
        name: inactive.name,
        role: 'staff',
        is_active: 0,
        created_at: '2001-01-01 00:00:02',
      },
    ]);
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expectExactFrozenObject(row, [
        'id',
        'username',
        'name',
        'role',
        'is_active',
        'created_at',
      ]);
    }
  });

  it('lets an unexpected admin list lookup failure reject', async () => {
    const admin = principalFor({
      id: 45,
      username: 'list-failure-admin',
      name: 'List Failure Admin',
      role: 'admin',
    });
    const failingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return () => {
            throw new Error('TEST_LIST_LOOKUP_FAILURE');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(identity(failingDb).listUsers(admin))
      .rejects.toThrow('TEST_LIST_LOOKUP_FAILURE');
  });

  it('logs out the presented user token, preserves siblings, and writes exact SQL NULL audit JSON', async () => {
    const user = await insertUser({
      username: 'logout-user',
      name: 'Logout User',
      role: 'staff',
    });
    const current = await insertSession(user.id, '2999-01-01 00:00:00', 'logout-current');
    const sibling = await insertSession(user.id, '2999-01-02 00:00:00', 'logout-sibling');

    const value = requireFrozenIntentSuccess(await identity(env.DB).logout({
      principal: principalFor(user, current),
      rawToken: current.token,
    }));

    expect(value).toEqual({ loggedOut: true });
    expectExactFrozenObject(value, ['loggedOut']);
    const sessions = await env.DB.prepare(
      'SELECT token, expires_at FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string; expires_at: string }>();
    expect(sessions.results).toEqual([
      { token: sibling.token, expires_at: sibling.expiresAt },
    ]);
    expect(await auditRows()).toEqual([{
      actor_user_id: user.id,
      action: 'logout',
      entity_type: 'user',
      entity_id: user.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('creates an exact user and maps only the subsequent nondeleted duplicate pre-read', async () => {
    const admin = await insertUser({
      username: 'create-admin',
      name: 'Create Admin',
      role: 'admin',
    });
    const runtime = identity(env.DB);
    const input = Object.freeze({
      username: 'create-normal',
      name: '',
      password: 'create-password',
      role: 'staff' as const,
    });

    const createResult = await withTestTrigger(
      env.DB,
      'test_require_user_before_create_audit',
      `CREATE TRIGGER test_require_user_before_create_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'create'
        AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.entity_id)
       BEGIN
         SELECT RAISE(ABORT, 'TEST_CREATE_AUDIT_BEFORE_USER');
       END`,
      async () => await runtime.createUser(principalFor(admin), input),
    );
    const created = requireFrozenIntentSuccess(createResult);
    expect(created).toMatchObject({
      username: input.username,
      name: input.name,
      role: input.role,
      is_active: 1,
    });
    if (!created) throw new Error('Expected create readback projection.');
    expectExactFrozenObject(created, [
      'id',
      'username',
      'name',
      'role',
      'is_active',
      'created_at',
    ]);
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(created.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(CURRENT_HASH_PATTERN);
    expect((await workerIdentityCredential.verifyPassword(
      input.password,
      stored?.password_hash ?? '',
    )).valid).toBe(true);

    const noDuplicateBatch = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async () => {
            throw new Error('TEST_DUPLICATE_CREATE_REACHED_BATCH');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const duplicate = await identity(noDuplicateBatch)
      .createUser(principalFor(admin), input);
    expectFrozenIntentFailure(duplicate, 'duplicate_username');
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'create',
      entity_type: 'user',
      entity_id: created.id,
      before_json: null,
      after_json: JSON.stringify({ username: input.username, role: input.role }),
    }]);
  });

  it('exposes every Task 4 method and admits null as a successful create readback', () => {
    const runtime = identity(env.DB);
    expect(runtime.logout).toBeTypeOf('function');
    expect(runtime.listUsers).toBeTypeOf('function');
    expect(runtime.createUser).toBeTypeOf('function');
    expect(runtime.changeOwnPassword).toBeTypeOf('function');
    expect(runtime.resetPassword).toBeTypeOf('function');

    type CreateResult = Awaited<ReturnType<RuntimeIdentity['createUser']>>;
    const nullReadback: CreateResult = Object.freeze({ ok: true, value: null });
    expect(nullReadback).toEqual({ ok: true, value: null });
  });
});

describe('Runtime Identity user creation exceptions', () => {
  it('rejects staff creation before touching D1', async () => {
    const staff = principalFor({
      id: 42,
      username: 'staff-create-no-db',
      name: 'Staff Create No DB',
      role: 'staff',
    });
    let accessed = false;
    const guardedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare' || property === 'batch') {
          accessed = true;
          throw new Error('TEST_STAFF_CREATE_TOUCHED_D1');
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await identity(guardedDb).createUser(staff, {
      username: 'staff-cannot-create',
      name: '',
      password: '',
      role: 'admin',
    });

    expectFrozenIntentFailure(result, 'forbidden');
    expect(accessed).toBe(false);
  });

  it('rejects a concurrent unique collision injected immediately before batch', async () => {
    const admin = await insertUser({ username: 'create-race-admin', role: 'admin' });
    const username = `create-race-${crypto.randomUUID()}`;
    const externalHash = await workerIdentityCredential.createPasswordHash(
      'external-create-password',
      new Uint8Array(16).fill(11),
    );
    const racing = beforeBatchProxy(async (db) => {
      await db.prepare(
        `INSERT INTO users (username, password_hash, name, role)
         VALUES (?, ?, 'External Winner', 'staff')`,
      ).bind(username, externalHash).run();
    });

    await expect(identity(racing.db).createUser(principalFor(admin), {
      username,
      name: 'Losing Create',
      password: 'losing-create-password',
      role: 'admin',
    })).rejects.toThrow();

    expect(racing.wasInjected()).toBe(true);
    const winner = await env.DB.prepare(
      'SELECT username, password_hash, name, role FROM users WHERE username = ?',
    ).bind(username).first<{
      username: string;
      password_hash: string;
      name: string;
      role: UserRole;
    }>();
    expect(winner).toEqual({
      username,
      password_hash: externalHash,
      name: 'External Winner',
      role: 'staff',
    });
    expect(await auditRows()).toEqual([]);
  });

  it('rejects a soft-deleted username collision instead of mapping it to duplicate_username', async () => {
    const admin = await insertUser({ username: 'soft-collision-admin', role: 'admin' });
    const username = `soft-collision-${crypto.randomUUID()}`;
    const deleted = await insertUser({
      username,
      passwordHash: 'soft-deleted-sentinel-hash',
      name: 'Soft Deleted',
      role: 'staff',
      isDeleted: 1,
    });

    await expect(identity(env.DB).createUser(principalFor(admin), {
      username,
      name: 'Replacement',
      password: 'replacement-password',
      role: 'admin',
    })).rejects.toThrow();

    const stored = await env.DB.prepare(
      'SELECT id, password_hash, is_deleted FROM users WHERE username = ?',
    ).bind(username).first<{
      id: number;
      password_hash: string;
      is_deleted: number;
    }>();
    expect(stored).toEqual({
      id: deleted.id,
      password_hash: deleted.passwordHash,
      is_deleted: 1,
    });
    expect(await auditRows()).toEqual([]);
  });

  it('rolls the user insert back when the create audit fails', async () => {
    const admin = await insertUser({ username: 'create-audit-admin', role: 'admin' });
    const username = `create-audit-failure-${crypto.randomUUID()}`;

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_create_audit',
      `CREATE TRIGGER test_fail_runtime_create_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'create'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_CREATE_AUDIT_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).createUser(principalFor(admin), {
          username,
          name: 'Create Audit Failure',
          password: 'create-audit-password',
          role: 'staff',
        })).rejects.toThrow();
      },
    );

    const created = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ?',
    ).bind(username).first<{ id: number }>();
    expect(created).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('preserves a frozen success with null when separate readback observes a hard delete', async () => {
    const admin = await insertUser({ username: 'create-null-admin', role: 'admin' });
    const username = `create-null-${crypto.randomUUID()}`;
    let createdId: number | null = null;
    const concurrent = afterBatchBeforeFirstProxy(async (db) => {
      const created = await db.prepare(
        'SELECT id FROM users WHERE username = ?',
      ).bind(username).first<{ id: number }>();
      if (!created) throw new Error('Expected committed create before null readback race.');
      createdId = created.id;
      await db.prepare('DELETE FROM users WHERE id = ?').bind(created.id).run();
    });

    const result = await identity(concurrent.db).createUser(principalFor(admin), {
      username,
      name: 'Create Null Readback',
      password: 'create-null-password',
      role: 'staff',
    });

    const value = requireFrozenIntentSuccess(result);
    expect(value).toBeNull();
    expect(concurrent.wasInjected()).toBe(true);
    expect(createdId).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username).first()).toBeNull();
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'create',
      entity_type: 'user',
      entity_id: createdId,
      before_json: null,
      after_json: JSON.stringify({ username, role: 'staff' }),
    }]);
  });

  it('rejects a readback failure after keeping the committed insert and audit', async () => {
    const admin = await insertUser({ username: 'readback-failure-admin', role: 'admin' });
    const username = `readback-failure-${crypto.randomUUID()}`;
    const failingReadback = afterBatchBeforeFirstProxy(async () => {
      throw new Error('TEST_CREATE_READBACK_FAILURE');
    });

    await expect(identity(failingReadback.db).createUser(principalFor(admin), {
      username,
      name: 'Readback Failure',
      password: 'readback-failure-password',
      role: 'admin',
    })).rejects.toThrow('TEST_CREATE_READBACK_FAILURE');

    expect(failingReadback.wasInjected()).toBe(true);
    const created = await env.DB.prepare(
      `SELECT id, username, name, role, is_active, created_at
         FROM users
        WHERE username = ?`,
    ).bind(username).first<{
      id: number;
      username: string;
      name: string;
      role: UserRole;
      is_active: number;
      created_at: string;
    }>();
    expect(created).toMatchObject({
      username,
      name: 'Readback Failure',
      role: 'admin',
      is_active: 1,
    });
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'create',
      entity_type: 'user',
      entity_id: created?.id ?? null,
      before_json: null,
      after_json: JSON.stringify({ username, role: 'admin' }),
    }]);
  });
});

describe('Runtime Identity logout exceptions', () => {
  it('preserves a presented token owned by another user while still succeeding and auditing', async () => {
    const principalUser = await insertUser({
      username: 'logout-ownership-principal',
      role: 'staff',
    });
    const foreignUser = await insertUser({
      username: 'logout-ownership-foreign',
      role: 'staff',
    });
    const principalSession = await insertSession(
      principalUser.id,
      '2999-01-03 00:00:00',
      'logout-ownership-principal-token',
    );
    const foreignSession = await insertSession(
      foreignUser.id,
      '2999-01-04 00:00:00',
      'logout-ownership-foreign-token',
    );

    const value = requireFrozenIntentSuccess(await identity(env.DB).logout({
      principal: principalFor(principalUser, principalSession),
      rawToken: foreignSession.token,
    }));

    expect(value).toEqual({ loggedOut: true });
    const sessions = await env.DB.prepare(
      'SELECT token, user_id FROM sessions ORDER BY token ASC',
    ).all<{ token: string; user_id: number }>();
    expect(sessions.results).toEqual([
      { token: foreignSession.token, user_id: foreignUser.id },
      { token: principalSession.token, user_id: principalUser.id },
    ]);
    expect(await auditRows()).toEqual([{
      actor_user_id: principalUser.id,
      action: 'logout',
      entity_type: 'user',
      entity_id: principalUser.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('still succeeds and audits when the presented session disappears immediately before batch', async () => {
    const user = await insertUser({ username: 'logout-race-user', role: 'staff' });
    const current = await insertSession(user.id, '2999-02-01 00:00:00', 'logout-race-current');
    const sibling = await insertSession(user.id, '2999-02-02 00:00:00', 'logout-race-sibling');
    const racing = beforeBatchProxy(async (db) => {
      await db.prepare('DELETE FROM sessions WHERE token = ? AND user_id = ?')
        .bind(current.token, user.id).run();
    });

    const value = requireFrozenIntentSuccess(await identity(racing.db).logout({
      principal: principalFor(user, current),
      rawToken: current.token,
    }));

    expect(value).toEqual({ loggedOut: true });
    expectExactFrozenObject(value, ['loggedOut']);
    expect(racing.wasInjected()).toBe(true);
    const remaining = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string }>();
    expect(remaining.results).toEqual([{ token: sibling.token }]);
    expect(await auditRows()).toEqual([{
      actor_user_id: user.id,
      action: 'logout',
      entity_type: 'user',
      entity_id: user.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('rolls the token delete back when logout audit insertion fails', async () => {
    const user = await insertUser({ username: 'logout-audit-user', role: 'staff' });
    const current = await insertSession(user.id, '2999-03-01 00:00:00', 'logout-audit-current');
    const sibling = await insertSession(user.id, '2999-03-02 00:00:00', 'logout-audit-sibling');

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_logout_audit',
      `CREATE TRIGGER test_fail_runtime_logout_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'logout'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_LOGOUT_AUDIT_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).logout({
          principal: principalFor(user, current),
          rawToken: current.token,
        })).rejects.toThrow();
      },
    );

    const remaining = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string }>();
    expect(remaining.results).toEqual([
      { token: current.token },
      { token: sibling.token },
    ]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('Runtime Identity own password change', () => {
  it('writes a fresh hash, preserves the current token and expiry, revokes siblings, and audits in order', async () => {
    const currentPassword = 'own-current-password';
    const newPassword = 'own-new-password';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      currentPassword,
      new Uint8Array(16).fill(12),
    );
    const user = await insertUser({
      username: 'own-normal-user',
      passwordHash: observedHash,
      role: 'staff',
    });
    const current = await insertSession(user.id, '2999-04-01 00:00:00', 'own-normal-current');
    const sibling = await insertSession(user.id, '2999-04-02 00:00:00', 'own-normal-sibling');

    const result = await withTestTrigger(
      env.DB,
      'test_require_own_change_order',
      `CREATE TRIGGER test_require_own_change_order
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'change_password'
        AND (
          EXISTS (SELECT 1 FROM users WHERE id = ${user.id} AND password_hash = '${observedHash}')
          OR EXISTS (SELECT 1 FROM sessions WHERE token = '${sibling.token}')
          OR NOT EXISTS (SELECT 1 FROM sessions WHERE token = '${current.token}')
        )
       BEGIN
         SELECT RAISE(ABORT, 'TEST_OWN_CHANGE_ORDER');
       END`,
      async () => await identity(env.DB).changeOwnPassword(principalFor(user, current), {
        currentPassword,
        newPassword,
        currentRawToken: current.token,
      }),
    );

    const value = requireFrozenIntentSuccess(result);
    expect(value).toEqual({ ok: true });
    expectExactFrozenObject(value, ['ok']);
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(CURRENT_HASH_PATTERN);
    expect(stored?.password_hash).not.toBe(observedHash);
    expect((await workerIdentityCredential.verifyPassword(
      newPassword,
      stored?.password_hash ?? '',
    )).valid).toBe(true);
    const sessions = await env.DB.prepare(
      'SELECT token, expires_at FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string; expires_at: string }>();
    expect(sessions.results).toEqual([{
      token: current.token,
      expires_at: current.expiresAt,
    }]);
    expect(await auditRows()).toEqual([{
      actor_user_id: user.id,
      action: 'change_password',
      entity_type: 'user',
      entity_id: user.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('returns exact not_found when the principal user row is missing', async () => {
    const principal = principalFor({
      id: 8_001,
      username: 'own-missing',
      name: 'Own Missing',
      role: 'staff',
    });

    const result = await identity(env.DB).changeOwnPassword(principal, {
      currentPassword: 'missing-current',
      newPassword: 'missing-new',
      currentRawToken: 'missing-token',
    });

    expectFrozenIntentFailure(result, 'not_found');
    expect(await auditRows()).toEqual([]);
  });

  it('returns exact invalid_credentials without mutation for a wrong current password', async () => {
    const currentPassword = 'own-correct-password';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      currentPassword,
      new Uint8Array(16).fill(13),
    );
    const user = await insertUser({
      username: 'own-wrong-user',
      passwordHash: observedHash,
      role: 'staff',
    });
    const current = await insertSession(user.id, '2999-05-01 00:00:00', 'own-wrong-current');
    const sibling = await insertSession(user.id, '2999-05-02 00:00:00', 'own-wrong-sibling');

    const result = await identity(env.DB).changeOwnPassword(principalFor(user, current), {
      currentPassword: 'own-wrong-password',
      newPassword: 'must-not-be-stored',
      currentRawToken: current.token,
    });

    expectFrozenIntentFailure(result, 'invalid_credentials');
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(observedHash);
    const sessions = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string }>();
    expect(sessions.results).toEqual([
      { token: current.token },
      { token: sibling.token },
    ]);
    expect(await auditRows()).toEqual([]);
  });

  it.each(['missing', 'expired'] as const)(
    'overwrites a pre-batch hash replacement and succeeds with a %s current session',
    async (currentState) => {
      const currentPassword = `own-race-current-${currentState}`;
      const newPassword = `own-race-new-${currentState}`;
      const observedHash = await workerIdentityCredential.createPasswordHash(
        currentPassword,
        new Uint8Array(16).fill(currentState === 'missing' ? 14 : 15),
      );
      const externalHash = await workerIdentityCredential.createPasswordHash(
        `own-race-external-${currentState}`,
        new Uint8Array(16).fill(currentState === 'missing' ? 16 : 17),
      );
      const user = await insertUser({
        username: `own-race-${currentState}`,
        passwordHash: observedHash,
        role: 'staff',
      });
      const current = await insertSession(
        user.id,
        currentState === 'expired'
          ? '2000-01-01 00:00:00'
          : '2999-06-01 00:00:00',
        `own-race-${currentState}-current`,
      );
      const sibling = await insertSession(
        user.id,
        '2999-06-02 00:00:00',
        `own-race-${currentState}-sibling`,
      );
      const racing = beforeBatchProxy(async (db) => {
        await db.prepare(
          `UPDATE users
              SET password_hash = ?, updated_at = '2044-01-02 03:04:05'
            WHERE id = ?`,
        ).bind(externalHash, user.id).run();
        if (currentState === 'missing') {
          await db.prepare('DELETE FROM sessions WHERE token = ?')
            .bind(current.token).run();
        }
      });

      const value = requireFrozenIntentSuccess(
        await identity(racing.db).changeOwnPassword(principalFor(user, current), {
          currentPassword,
          newPassword,
          currentRawToken: current.token,
        }),
      );

      expect(value).toEqual({ ok: true });
      expectExactFrozenObject(value, ['ok']);
      expect(racing.wasInjected()).toBe(true);
      const stored = await env.DB.prepare(
        'SELECT password_hash FROM users WHERE id = ?',
      ).bind(user.id).first<{ password_hash: string }>();
      expect(stored?.password_hash).not.toBe(observedHash);
      expect(stored?.password_hash).not.toBe(externalHash);
      expect((await workerIdentityCredential.verifyPassword(
        newPassword,
        stored?.password_hash ?? '',
      )).valid).toBe(true);
      const sessions = await env.DB.prepare(
        'SELECT token, expires_at FROM sessions WHERE user_id = ? ORDER BY token ASC',
      ).bind(user.id).all<{ token: string; expires_at: string }>();
      expect(sessions.results).toEqual(currentState === 'expired'
        ? [{ token: current.token, expires_at: current.expiresAt }]
        : []);
      expect(sessions.results).not.toContainEqual({
        token: sibling.token,
        expires_at: sibling.expiresAt,
      });
      expect(await auditRows()).toEqual([{
        actor_user_id: user.id,
        action: 'change_password',
        entity_type: 'user',
        entity_id: user.id,
        before_json: null,
        after_json: null,
      }]);
    },
  );

  it('rolls the hash update back when sibling deletion fails', async () => {
    const currentPassword = 'own-delete-failure-current';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      currentPassword,
      new Uint8Array(16).fill(18),
    );
    const user = await insertUser({
      username: 'own-delete-failure-user',
      passwordHash: observedHash,
      role: 'staff',
    });
    const current = await insertSession(user.id, '2999-07-01 00:00:00', 'own-delete-failure-current');
    const sibling = await insertSession(user.id, '2999-07-02 00:00:00', 'own-delete-failure-sibling');

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_own_sibling_delete',
      `CREATE TRIGGER test_fail_runtime_own_sibling_delete
       BEFORE DELETE ON sessions
       WHEN OLD.token = '${sibling.token}'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_OWN_SIBLING_DELETE_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).changeOwnPassword(principalFor(user, current), {
          currentPassword,
          newPassword: 'own-delete-failure-new',
          currentRawToken: current.token,
        })).rejects.toThrow();
      },
    );

    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(observedHash);
    const sessions = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string }>();
    expect(sessions.results).toEqual([
      { token: current.token },
      { token: sibling.token },
    ]);
    expect(await auditRows()).toEqual([]);
  });

  it('rolls the hash update and sibling delete back when own-change audit fails', async () => {
    const currentPassword = 'own-audit-failure-current';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      currentPassword,
      new Uint8Array(16).fill(19),
    );
    const user = await insertUser({
      username: 'own-audit-failure-user',
      passwordHash: observedHash,
      role: 'staff',
    });
    const current = await insertSession(user.id, '2999-08-01 00:00:00', 'own-audit-failure-current');
    const sibling = await insertSession(user.id, '2999-08-02 00:00:00', 'own-audit-failure-sibling');

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_own_change_audit',
      `CREATE TRIGGER test_fail_runtime_own_change_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'change_password'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_OWN_CHANGE_AUDIT_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).changeOwnPassword(principalFor(user, current), {
          currentPassword,
          newPassword: 'own-audit-failure-new',
          currentRawToken: current.token,
        })).rejects.toThrow();
      },
    );

    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(observedHash);
    const sessions = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(user.id).all<{ token: string }>();
    expect(sessions.results).toEqual([
      { token: current.token },
      { token: sibling.token },
    ]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('Runtime Identity admin password reset', () => {
  it('rejects staff reset before touching D1', async () => {
    const staff = principalFor({
      id: 43,
      username: 'staff-reset-no-db',
      name: 'Staff Reset No DB',
      role: 'staff',
    });
    let accessed = false;
    const guardedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare' || property === 'batch') {
          accessed = true;
          throw new Error('TEST_STAFF_RESET_TOUCHED_D1');
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await identity(guardedDb).resetPassword(staff, {
      targetId: 44,
      newPassword: '',
    });

    expectFrozenIntentFailure(result, 'forbidden');
    expect(accessed).toBe(false);
  });

  it('returns exact not_found for a missing target', async () => {
    const admin = await insertUser({ username: 'reset-missing-admin', role: 'admin' });

    const result = await identity(env.DB).resetPassword(principalFor(admin), {
      targetId: 7_001,
      newPassword: 'reset-missing-password',
    });

    expectFrozenIntentFailure(result, 'not_found');
    expect(await auditRows()).toEqual([]);
  });

  it('returns exact not_found for a soft-deleted target', async () => {
    const admin = await insertUser({ username: 'reset-deleted-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-deleted-target',
      passwordHash: 'reset-deleted-sentinel',
      role: 'staff',
      isDeleted: 1,
    });

    const result = await identity(env.DB).resetPassword(principalFor(admin), {
      targetId: target.id,
      newPassword: 'reset-deleted-password',
    });

    expectFrozenIntentFailure(result, 'not_found');
    const stored = await env.DB.prepare(
      'SELECT password_hash, is_deleted FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string; is_deleted: number }>();
    expect(stored).toEqual({
      password_hash: target.passwordHash,
      is_deleted: 1,
    });
    expect(await auditRows()).toEqual([]);
  });

  it('allows an inactive target and revokes all of its sessions', async () => {
    const admin = await insertUser({ username: 'reset-inactive-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-inactive-target',
      passwordHash: 'reset-inactive-observed',
      role: 'staff',
      isActive: 0,
    });
    await insertSession(target.id, '2999-09-01 00:00:00', 'reset-inactive-one');
    await insertSession(target.id, '2999-09-02 00:00:00', 'reset-inactive-two');
    const newPassword = 'reset-inactive-new';

    const value = requireFrozenIntentSuccess(
      await identity(env.DB).resetPassword(principalFor(admin), {
        targetId: target.id,
        newPassword,
      }),
    );

    expect(value).toEqual({ ok: true });
    expectExactFrozenObject(value, ['ok']);
    const stored = await env.DB.prepare(
      'SELECT password_hash, is_active FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string; is_active: number }>();
    expect(stored?.is_active).toBe(0);
    expect((await workerIdentityCredential.verifyPassword(
      newPassword,
      stored?.password_hash ?? '',
    )).valid).toBe(true);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(target.id).first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'reset_password',
      entity_type: 'user',
      entity_id: target.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('writes a fresh hash, revokes every target session, and audits after both mutations', async () => {
    const admin = await insertUser({ username: 'reset-normal-admin', role: 'admin' });
    const oldPassword = 'reset-normal-old';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      oldPassword,
      new Uint8Array(16).fill(20),
    );
    const target = await insertUser({
      username: 'reset-normal-target',
      passwordHash: observedHash,
      role: 'staff',
    });
    const first = await insertSession(target.id, '2999-10-01 00:00:00', 'reset-normal-one');
    const second = await insertSession(target.id, '2999-10-02 00:00:00', 'reset-normal-two');
    const adminSession = await insertSession(admin.id, '2999-10-03 00:00:00', 'reset-normal-admin-session');
    const newPassword = 'reset-normal-new';

    const result = await withTestTrigger(
      env.DB,
      'test_require_reset_order',
      `CREATE TRIGGER test_require_reset_order
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'reset_password'
        AND (
          EXISTS (SELECT 1 FROM users WHERE id = ${target.id} AND password_hash = '${observedHash}')
          OR EXISTS (SELECT 1 FROM sessions WHERE user_id = ${target.id})
        )
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RESET_ORDER');
       END`,
      async () => await identity(env.DB).resetPassword(
        principalFor(admin, adminSession),
        { targetId: target.id, newPassword },
      ),
    );

    const value = requireFrozenIntentSuccess(result);
    expect(value).toEqual({ ok: true });
    expectExactFrozenObject(value, ['ok']);
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).not.toBe(observedHash);
    expect((await workerIdentityCredential.verifyPassword(
      newPassword,
      stored?.password_hash ?? '',
    )).valid).toBe(true);
    const sessions = await env.DB.prepare(
      'SELECT token, user_id FROM sessions ORDER BY token ASC',
    ).all<{ token: string; user_id: number }>();
    expect(sessions.results).toEqual([{
      token: adminSession.token,
      user_id: admin.id,
    }]);
    expect(sessions.results).not.toContainEqual({ token: first.token, user_id: target.id });
    expect(sessions.results).not.toContainEqual({ token: second.token, user_id: target.id });
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'reset_password',
      entity_type: 'user',
      entity_id: target.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('allows self-reset and revokes every session including the presented one', async () => {
    const oldPassword = 'reset-self-old';
    const observedHash = await workerIdentityCredential.createPasswordHash(
      oldPassword,
      new Uint8Array(16).fill(21),
    );
    const admin = await insertUser({
      username: 'reset-self-admin',
      passwordHash: observedHash,
      role: 'admin',
    });
    const current = await insertSession(admin.id, '2999-11-01 00:00:00', 'reset-self-current');
    await insertSession(admin.id, '2999-11-02 00:00:00', 'reset-self-sibling');
    const newPassword = 'reset-self-new';

    const value = requireFrozenIntentSuccess(
      await identity(env.DB).resetPassword(principalFor(admin, current), {
        targetId: admin.id,
        newPassword,
      }),
    );

    expect(value).toEqual({ ok: true });
    expectExactFrozenObject(value, ['ok']);
    expect(await identity(env.DB).resolveSession(current.token)).toBeNull();
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(admin.id).first<{ count: number }>();
    expect(count?.count).toBe(0);
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(admin.id).first<{ password_hash: string }>();
    expect((await workerIdentityCredential.verifyPassword(
      newPassword,
      stored?.password_hash ?? '',
    )).valid).toBe(true);
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'reset_password',
      entity_type: 'user',
      entity_id: admin.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('overwrites a pre-batch target hash replacement without an observed-hash CAS', async () => {
    const admin = await insertUser({ username: 'reset-hash-race-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-hash-race-target',
      passwordHash: 'reset-hash-race-observed',
      role: 'staff',
    });
    await insertSession(target.id, '2999-12-01 00:00:00', 'reset-hash-race-session');
    const externalHash = await workerIdentityCredential.createPasswordHash(
      'reset-hash-race-external',
      new Uint8Array(16).fill(22),
    );
    const newPassword = 'reset-hash-race-new';
    const racing = beforeBatchProxy(async (db) => {
      await db.prepare(
        `UPDATE users
            SET password_hash = ?, updated_at = '2045-01-02 03:04:05'
          WHERE id = ?`,
      ).bind(externalHash, target.id).run();
    });

    const value = requireFrozenIntentSuccess(
      await identity(racing.db).resetPassword(principalFor(admin), {
        targetId: target.id,
        newPassword,
      }),
    );

    expect(value).toEqual({ ok: true });
    expect(racing.wasInjected()).toBe(true);
    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).not.toBe(externalHash);
    expect((await workerIdentityCredential.verifyPassword(
      newPassword,
      stored?.password_hash ?? '',
    )).valid).toBe(true);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(target.id).first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'reset_password',
      entity_type: 'user',
      entity_id: target.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('succeeds with zero updated rows after a pre-batch soft delete while still revoking and auditing', async () => {
    const admin = await insertUser({ username: 'reset-delete-race-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-delete-race-target',
      passwordHash: 'reset-delete-race-observed',
      role: 'staff',
    });
    await insertSession(target.id, '2999-12-02 00:00:00', 'reset-delete-race-one');
    await insertSession(target.id, '2999-12-03 00:00:00', 'reset-delete-race-two');
    const racing = beforeBatchProxy(async (db) => {
      await db.prepare(
        `UPDATE users
            SET is_deleted = 1,
                deleted_at = '2046-01-02 03:04:05',
                updated_at = '2046-01-02 03:04:05'
          WHERE id = ?`,
      ).bind(target.id).run();
    });

    const value = requireFrozenIntentSuccess(
      await identity(racing.db).resetPassword(principalFor(admin), {
        targetId: target.id,
        newPassword: 'reset-delete-race-new',
      }),
    );

    expect(value).toEqual({ ok: true });
    expect(racing.wasInjected()).toBe(true);
    const stored = await env.DB.prepare(
      'SELECT password_hash, is_deleted, deleted_at FROM users WHERE id = ?',
    ).bind(target.id).first<{
      password_hash: string;
      is_deleted: number;
      deleted_at: string | null;
    }>();
    expect(stored).toEqual({
      password_hash: target.passwordHash,
      is_deleted: 1,
      deleted_at: '2046-01-02 03:04:05',
    });
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(target.id).first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect(await auditRows()).toEqual([{
      actor_user_id: admin.id,
      action: 'reset_password',
      entity_type: 'user',
      entity_id: target.id,
      before_json: null,
      after_json: null,
    }]);
  });

  it('rolls the target hash update back when reset session deletion fails', async () => {
    const admin = await insertUser({ username: 'reset-delete-failure-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-delete-failure-target',
      passwordHash: 'reset-delete-failure-observed',
      role: 'staff',
    });
    const session = await insertSession(
      target.id,
      '2999-12-04 00:00:00',
      'reset-delete-failure-session',
    );

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_reset_session_delete',
      `CREATE TRIGGER test_fail_runtime_reset_session_delete
       BEFORE DELETE ON sessions
       WHEN OLD.token = '${session.token}'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_RESET_SESSION_DELETE_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).resetPassword(principalFor(admin), {
          targetId: target.id,
          newPassword: 'reset-delete-failure-new',
        })).rejects.toThrow();
      },
    );

    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(target.passwordHash);
    const remaining = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ?',
    ).bind(target.id).all<{ token: string }>();
    expect(remaining.results).toEqual([{ token: session.token }]);
    expect(await auditRows()).toEqual([]);
  });

  it('rolls the target hash update and session revocation back when reset audit fails', async () => {
    const admin = await insertUser({ username: 'reset-audit-failure-admin', role: 'admin' });
    const target = await insertUser({
      username: 'reset-audit-failure-target',
      passwordHash: 'reset-audit-failure-observed',
      role: 'staff',
    });
    const first = await insertSession(target.id, '2999-12-05 00:00:00', 'reset-audit-failure-one');
    const second = await insertSession(target.id, '2999-12-06 00:00:00', 'reset-audit-failure-two');

    await withTestTrigger(
      env.DB,
      'test_fail_runtime_reset_audit',
      `CREATE TRIGGER test_fail_runtime_reset_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'reset_password'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RUNTIME_RESET_AUDIT_FAILURE');
       END`,
      async () => {
        await expect(identity(env.DB).resetPassword(principalFor(admin), {
          targetId: target.id,
          newPassword: 'reset-audit-failure-new',
        })).rejects.toThrow();
      },
    );

    const stored = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(target.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toBe(target.passwordHash);
    const sessions = await env.DB.prepare(
      'SELECT token FROM sessions WHERE user_id = ? ORDER BY token ASC',
    ).bind(target.id).all<{ token: string }>();
    expect(sessions.results).toEqual([
      { token: first.token },
      { token: second.token },
    ]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('Runtime Identity password hash generation failures', () => {
  it.each(['create', 'change', 'reset'] as const)(
    'lets an unexpected %s hash generation failure reject without mutation',
    async (operation) => {
      const admin = await insertUser({
        username: `hash-failure-${operation}-admin`,
        role: 'admin',
      });
      const currentPassword = `hash-failure-${operation}-current`;
      const observedHash = await workerIdentityCredential.createPasswordHash(
        currentPassword,
        new Uint8Array(16).fill(operation === 'create' ? 23 : operation === 'change' ? 24 : 25),
      );
      const target = operation === 'create'
        ? null
        : await insertUser({
          username: `hash-failure-${operation}-target`,
          passwordHash: observedHash,
          role: 'staff',
        });
      const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(
        new Error(`TEST_${operation.toUpperCase()}_HASH_GENERATION_FAILURE`),
      );

      try {
        const runtime = identity(env.DB);
        const call = async () => {
          if (operation === 'create') {
            await runtime.createUser(principalFor(admin), {
              username: 'hash-failure-create-new',
              name: 'Hash Failure Create',
              password: 'hash-failure-create-password',
              role: 'staff',
            });
            return;
          }
          if (operation === 'change') {
            await runtime.changeOwnPassword(principalFor(target!), {
              currentPassword,
              newPassword: 'hash-failure-change-new',
              currentRawToken: 'hash-failure-change-current-token',
            });
            return;
          }
          await runtime.resetPassword(principalFor(admin), {
            targetId: target!.id,
            newPassword: 'hash-failure-reset-new',
          });
        };
        await expect(call()).rejects.toThrow(
          `TEST_${operation.toUpperCase()}_HASH_GENERATION_FAILURE`,
        );
      } finally {
        deriveBits.mockRestore();
      }

      if (operation === 'create') {
        const created = await env.DB.prepare(
          "SELECT id FROM users WHERE username = 'hash-failure-create-new'",
        ).first<{ id: number }>();
        expect(created).toBeNull();
      } else {
        const stored = await env.DB.prepare(
          'SELECT password_hash FROM users WHERE id = ?',
        ).bind(target!.id).first<{ password_hash: string }>();
        expect(stored?.password_hash).toBe(observedHash);
      }
      expect(await auditRows()).toEqual([]);
    },
  );
});

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
