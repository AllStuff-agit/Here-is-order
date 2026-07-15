import { env, exports } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';

import { createPasswordHash } from '../scripts/node-credential-crypto.mjs';
import {
  assertSmokeIdentityPostflight,
  buildSmokeIdentityMutation,
  buildSmokeIdentityPostflightQuery,
  buildSmokeIdentityPreflightQuery,
  parseSmokeIdentityPreflight,
} from '../scripts/smoke-identity-lifecycle.mjs';

const OPERATION_IDS = [
  'a0000000-a000-4000-8000-a00000000001',
  'a0000000-a000-4000-8000-a00000000002',
  'a0000000-a000-4000-8000-a00000000003',
  'a0000000-a000-4000-8000-a00000000004',
  'a0000000-a000-4000-8000-a00000000005',
  'a0000000-a000-4000-8000-a00000000006',
];

beforeEach(async () => {
  await env.DB.batch([
    'stock_transactions', 'order_items', 'audit_logs', 'sessions',
    'purchase_orders', 'items', 'item_categories', 'users',
  ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

const executeMutation = (mutation: ReturnType<typeof buildSmokeIdentityMutation>) =>
  env.DB.batch(mutation.batch.map(({ sql, params }) =>
    env.DB.prepare(sql).bind(...params)));

it('provision creates one exact active staff row and one operator audit', async () => {
  const hash = await createPasswordHash('x'.repeat(64), Buffer.alloc(16, 1));
  const preflight = buildSmokeIdentityPreflightQuery();
  const emptyPreflight = await env.DB.prepare(preflight.sql).bind(...preflight.params).all();
  expect(parseSmokeIdentityPreflight([emptyPreflight], 'provision')).toBeNull();

  const mutation = buildSmokeIdentityMutation({
    action: 'provision', target: null, passwordHash: hash, operationId: OPERATION_IDS[0],
  });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT username, name, role, is_active, is_deleted, deleted_at,
            password_hash = ? AS hash_matches,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
            (SELECT action FROM audit_logs a WHERE a.entity_id = u.id ORDER BY a.id DESC LIMIT 1) AS audit_action,
            (SELECT after_json = ? FROM audit_logs a WHERE a.entity_id = u.id ORDER BY a.id DESC LIMIT 1) AS audit_matches
       FROM users u WHERE username = ?`,
  ).bind(hash, mutation.auditJson, 'deployment-smoke').first();
  expect(row).toEqual({
    username: 'deployment-smoke', name: 'Deployment Smoke', role: 'staff',
    is_active: 1, is_deleted: 0, deleted_at: null, hash_matches: 1, session_count: 0,
    audit_action: 'provision_smoke_identity', audit_matches: 1,
  });

  const existingPreflight = await env.DB.prepare(preflight.sql).bind(...preflight.params).all();
  const target = parseSmokeIdentityPreflight([existingPreflight], 'rotate');
  expect(target).toEqual({ id: Number((existingPreflight.results[0] as { id: number }).id), observedActive: 1 });

  const postflight = buildSmokeIdentityPostflightQuery({
    action: 'provision', target: null, passwordHash: hash,
  });
  const postflightResult = await env.DB.prepare(postflight.sql).bind(...postflight.params).all();
  expect(assertSmokeIdentityPostflight([postflightResult], {
    action: 'provision', auditJson: mutation.auditJson,
  })).toEqual({ id: target.id, active: true });
});

it.each([0, 1])('rotate from active=%i writes the new hash and revokes all sessions', async (isActive) => {
  const oldHash = await createPasswordHash('x'.repeat(64), Buffer.alloc(16, 2));
  const nextHash = await createPasswordHash('y'.repeat(64), Buffer.alloc(16, 3));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', ?, 0)`,
  ).bind(oldHash, isActive).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES
       ('rotate-one', ?, datetime('now', '+1 hour')),
       ('rotate-two', ?, datetime('now', '+1 hour'))`,
  ).bind(userId, userId).run();
  const mutation = buildSmokeIdentityMutation({
    action: 'rotate', target: { id: userId, observedActive: isActive }, passwordHash: nextHash,
    operationId: OPERATION_IDS[1],
  });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT is_active, password_hash = ? AS hash_matches,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1) AS audit_action
       FROM users WHERE id = ?`,
  ).bind(nextHash, userId, userId, userId).first();
  expect(row).toEqual({
    is_active: 1, hash_matches: 1, session_count: 0,
    audit_action: 'rotate_smoke_identity',
  });
});

it('disable preserves the hash, deactivates the row and revokes all sessions', async () => {
  const hash = await createPasswordHash('x'.repeat(64), Buffer.alloc(16, 4));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', 1, 0)`,
  ).bind(hash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('disable-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();
  const mutation = buildSmokeIdentityMutation({
    action: 'disable', target: { id: userId, observedActive: 1 }, passwordHash: undefined,
    operationId: OPERATION_IDS[2],
  });
  await executeMutation(mutation);
  const row = await env.DB.prepare(
    `SELECT is_active, password_hash = ? AS hash_preserved,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id DESC LIMIT 1) AS audit_action
       FROM users WHERE id = ?`,
  ).bind(hash, userId, userId, userId).first();
  expect(row).toEqual({
    is_active: 0, hash_preserved: 1, session_count: 0,
    audit_action: 'disable_smoke_identity',
  });
});

it('lost rotate CAS rolls back audit and preserves every existing session', async () => {
  const passwordHash = await createPasswordHash('x'.repeat(64), Buffer.alloc(16, 7));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, is_active, is_deleted)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff', 1, 0)`,
  ).bind(passwordHash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('preserved-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();

  const mutation = buildSmokeIdentityMutation({
    action: 'rotate',
    target: { id: userId, observedActive: 0 },
    passwordHash: await createPasswordHash('y'.repeat(64), Buffer.alloc(16, 8)),
    operationId: OPERATION_IDS[3],
  });
  await expect(env.DB.batch(mutation.batch.map(({ sql, params }) =>
    env.DB.prepare(sql).bind(...params)))).rejects.toThrow();

  const state = await env.DB.prepare(
    `SELECT u.is_active,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.entity_id = u.id) AS audit_count
       FROM users u WHERE u.id = ?`,
  ).bind(userId).first();
  expect(state).toEqual({ is_active: 1, session_count: 1, audit_count: 0 });
});

it('audit insert failure rolls back the user update and preserves the session', async () => {
  const oldHash = await createPasswordHash('x'.repeat(64), Buffer.alloc(16, 5));
  const nextHash = await createPasswordHash('y'.repeat(64), Buffer.alloc(16, 6));
  const inserted = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES ('deployment-smoke', ?, 'Deployment Smoke', 'staff')`,
  ).bind(oldHash).run();
  const userId = Number(inserted.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ('audit-failure-session', ?, datetime('now', '+1 hour'))`,
  ).bind(userId).run();
  await env.DB.prepare(
    `CREATE TRIGGER test_fail_smoke_audit BEFORE INSERT ON audit_logs
     WHEN NEW.action = 'rotate_smoke_identity'
     BEGIN SELECT RAISE(ABORT, 'TEST_FAIL_SMOKE_AUDIT'); END`,
  ).run();
  try {
    const mutation = buildSmokeIdentityMutation({
      action: 'rotate', target: { id: userId, observedActive: 1 }, passwordHash: nextHash,
      operationId: OPERATION_IDS[4],
    });
    await expect(executeMutation(mutation)).rejects.toThrow();
  } finally {
    await env.DB.prepare('DROP TRIGGER IF EXISTS test_fail_smoke_audit').run();
  }
  const row = await env.DB.prepare(
    `SELECT password_hash = ? AS old_hash_preserved,
            (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
            (SELECT COUNT(*) FROM audit_logs WHERE entity_id = ?) AS audit_count
       FROM users WHERE id = ?`,
  ).bind(oldHash, userId, userId, userId).first();
  expect(row).toEqual({ old_hash_preserved: 1, session_count: 1, audit_count: 0 });
});

it('provisioned Node hash authenticates through the real Worker as staff', async () => {
  const password = 'x'.repeat(64);
  const hash = await createPasswordHash(password, Buffer.alloc(16, 9));
  await executeMutation(buildSmokeIdentityMutation({
    action: 'provision', target: null, passwordHash: hash, operationId: OPERATION_IDS[5],
  }));
  const response = await exports.default.fetch(new Request('https://example.com/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'deployment-smoke', password }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: { user: { username: 'deployment-smoke', name: 'Deployment Smoke', role: 'staff' } },
  });
});
