import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPasswordHash } from '../scripts/node-credential-crypto.mjs';
import { buildRecoveryBatch } from '../scripts/recover-password-core.mjs';
import { withTestTrigger } from './helpers/test-trigger';

const TABLES_IN_DELETE_ORDER = [
  'stock_transactions',
  'order_items',
  'audit_logs',
  'sessions',
  'purchase_orders',
  'items',
  'item_categories',
  'users',
] as const;

const RECOVERY_PASSWORD = 'new-secure-password';
const FIXED_SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const OLD_HASH = 'old-password-hash';

beforeEach(async () => {
  await env.DB.batch(
    TABLES_IN_DELETE_ORDER.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

function prepareBatch(batch: Array<{ sql: string; params: unknown[] }>) {
  return batch.map(({ sql, params }) => env.DB.prepare(sql).bind(...params));
}

async function createUser({
  username,
  passwordHash = OLD_HASH,
  role = 'admin',
  isActive = 1,
  isDeleted = 0,
  sessionCount = 0,
}: {
  username: string;
  passwordHash?: string;
  role?: 'admin' | 'staff';
  isActive?: 0 | 1;
  isDeleted?: 0 | 1;
  sessionCount?: number;
}) {
  const result = await env.DB.prepare(
    `INSERT INTO users
       (username, password_hash, name, role, is_active, is_deleted, deleted_at)
     VALUES (?, ?, '복구 테스트', ?, ?, ?, ?)`,
  ).bind(
    username,
    passwordHash,
    role,
    isActive,
    isDeleted,
    isDeleted ? '2026-01-01 00:00:00' : null,
  ).run();
  const userId = Number(result.meta.last_row_id);

  for (let index = 0; index < sessionCount; index += 1) {
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, '2999-01-01 00:00:00')`,
    ).bind(`${username}-session-${index + 1}`, userId).run();
  }

  return userId;
}

async function recoveryState() {
  const [users, sessions, audits] = await Promise.all([
    env.DB.prepare(
      `SELECT id, username, password_hash, role, is_active, is_deleted,
              deleted_at, updated_at
         FROM users ORDER BY id`,
    ).all(),
    env.DB.prepare(
      `SELECT id, token, user_id, expires_at, created_at
         FROM sessions ORDER BY id`,
    ).all(),
    env.DB.prepare(
      `SELECT id, actor_user_id, action, entity_type, entity_id,
              before_json, after_json, created_at
         FROM audit_logs ORDER BY id`,
    ).all(),
  ]);

  return {
    users: users.results,
    sessions: sessions.results,
    audits: audits.results,
  };
}

describe('operator password recovery', () => {
  it('한 active admin의 hash를 교체하고 두 session을 폐기하며 exact audit을 남긴다', async () => {
    const adminId = await createUser({ username: 'admin', sessionCount: 2 });
    const activeAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM users
        WHERE role = 'admin' AND is_active = 1 AND is_deleted = 0`,
    ).first<{ count: number }>();
    expect(Number(activeAdmins?.count)).toBe(1);
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(adminId).first()).toEqual({ count: 2 });

    const passwordHash = await createPasswordHash(RECOVERY_PASSWORD, FIXED_SALT);
    const { batch, auditJson } = buildRecoveryBatch({
      username: 'admin',
      passwordHash,
    });
    await env.DB.batch(prepareBatch(batch));

    const user = await env.DB.prepare(
      'SELECT id, password_hash FROM users WHERE username = ?',
    ).bind('admin').first<{ id: number; password_hash: string }>();
    const session = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(adminId).first<{ count: number }>();
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, action, entity_type, entity_id, after_json
         FROM audit_logs
        WHERE action = 'recover_password'
        ORDER BY id DESC LIMIT 1`,
    ).first();

    expect(user).toEqual({ id: adminId, password_hash: passwordHash });
    expect(user?.password_hash).not.toBe(OLD_HASH);
    expect(Number(session?.count)).toBe(0);
    expect(auditJson).toBe(JSON.stringify({
      source: 'operator_recovery',
      username: 'admin',
    }));
    expect(audit).toEqual({
      actor_user_id: null,
      action: 'recover_password',
      entity_type: 'user',
      entity_id: adminId,
      after_json: JSON.stringify({ source: 'operator_recovery', username: 'admin' }),
    });
  });

  it('audit insert가 실패하면 hash와 두 session을 함께 rollback한다', async () => {
    const adminId = await createUser({ username: 'admin', sessionCount: 2 });
    const passwordHash = await createPasswordHash(RECOVERY_PASSWORD, FIXED_SALT);
    const { batch } = buildRecoveryBatch({ username: 'admin', passwordHash });

    await expect(withTestTrigger(
      env.DB,
      'test_fail_operator_recovery_audit',
      `CREATE TRIGGER test_fail_operator_recovery_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'recover_password'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RECOVERY_AUDIT_FAILURE');
       END`,
      () => env.DB.batch(prepareBatch(batch)),
    )).rejects.toThrow();

    expect(await env.DB.prepare(
      'SELECT password_hash FROM users WHERE username = ?',
    ).bind('admin').first()).toEqual({ password_hash: OLD_HASH });
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
    ).bind(adminId).first()).toEqual({ count: 2 });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
        WHERE action = 'recover_password'`,
    ).first()).toEqual({ count: 0 });
  });

  it.each([
    ['missing', 'missing-admin', undefined],
    ['staff', 'staff-target', { role: 'staff' as const }],
    ['inactive', 'inactive-target', { isActive: 0 as const }],
    ['deleted', 'deleted-target', { isDeleted: 1 as const }],
    ['quote payload', "admin' OR 1=1 --", undefined],
  ])('%s username은 어떤 recovery state도 변경하지 않는다', async (
    _label,
    username,
    target,
  ) => {
    await createUser({ username: 'admin', sessionCount: 2 });
    if (target) {
      await createUser({ username, sessionCount: 1, ...target });
    }
    const before = await recoveryState();
    const passwordHash = await createPasswordHash(RECOVERY_PASSWORD, FIXED_SALT);
    const { batch } = buildRecoveryBatch({ username, passwordHash });

    await env.DB.batch(prepareBatch(batch));

    expect(await recoveryState()).toEqual(before);
  });

  it('Node에서 생성한 PBKDF2 hash로 실제 Worker login에 성공한다', async () => {
    const passwordHash = await createPasswordHash(RECOVERY_PASSWORD, FIXED_SALT);
    await createUser({ username: 'admin', passwordHash });

    const response = await exports.default.fetch(new Request(
      'http://example.com/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: RECOVERY_PASSWORD,
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT password_hash FROM users WHERE username = ?',
    ).bind('admin').first()).toEqual({ password_hash: passwordHash });
  });
});
