import { randomUUID } from 'node:crypto';

import { SMOKE_IDENTITY, SMOKE_IDENTITY_ACTIONS } from './smoke-identity-contract.mjs';

const HASH_PATTERN = /^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUDIT_ACTIONS = Object.freeze({
  provision: 'provision_smoke_identity',
  rotate: 'rotate_smoke_identity',
  disable: 'disable_smoke_identity',
});

export function buildSmokeIdentityPreflightQuery() {
  return {
    sql: `SELECT id, username, name, role, is_active, is_deleted, deleted_at
            FROM users
           WHERE username = ?`,
    params: [SMOKE_IDENTITY.username],
  };
}

function exactRows(results, message) {
  if (!Array.isArray(results)
    || results.length !== 1
    || results[0]?.success !== true
    || !Array.isArray(results[0].results)) {
    throw new Error(message);
  }
  return results[0].results;
}

export function parseSmokeIdentityPreflight(results, action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity preflight was invalid.');
  }
  const rows = exactRows(results, 'Smoke identity preflight was invalid.');
  if (action === 'provision') {
    if (rows.length !== 0) throw new Error('Smoke identity preflight was invalid.');
    return null;
  }
  if (rows.length !== 1) throw new Error('Smoke identity preflight was invalid.');
  const row = rows[0];
  if (!row
    || Object.keys(row).sort().join(',') !== 'deleted_at,id,is_active,is_deleted,name,role,username'
    || !Number.isSafeInteger(row.id)
    || row.id <= 0
    || row.username !== SMOKE_IDENTITY.username
    || row.name !== SMOKE_IDENTITY.name
    || row.role !== SMOKE_IDENTITY.role
    || ![0, 1].includes(row.is_active)
    || row.is_deleted !== 0
    || row.deleted_at !== null
    || (action === 'disable' && row.is_active !== 1)) {
    throw new Error('Smoke identity preflight was invalid.');
  }
  return Object.freeze({ id: row.id, observedActive: row.is_active });
}

function auditJson(active, operationId) {
  return JSON.stringify({
    source: 'deployment_smoke_operator',
    username: SMOKE_IDENTITY.username,
    role: SMOKE_IDENTITY.role,
    active,
    operationId,
  });
}

export function buildSmokeIdentityMutation({ action, target, passwordHash, operationId }) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const needsHash = action !== 'disable';
  if ((needsHash && !HASH_PATTERN.test(passwordHash))
    || (!needsHash && passwordHash !== undefined)
    || typeof operationId !== 'string'
    || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const afterJson = auditJson(action !== 'disable', operationId);
  if (action === 'provision') {
    if (target !== null) throw new Error('Smoke identity mutation was invalid.');
    return Object.freeze({
      auditJson: afterJson,
      batch: Object.freeze([
        {
          sql: `INSERT INTO users
                  (username, password_hash, name, role, is_active, is_deleted, deleted_at)
                SELECT ?, ?, ?, 'staff', 1, 0, NULL
                 WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ?)`,
          params: [SMOKE_IDENTITY.username, passwordHash, SMOKE_IDENTITY.name, SMOKE_IDENTITY.username],
        },
        {
          sql: `INSERT INTO audit_logs
                  (actor_user_id, action, entity_type, entity_id, before_json, after_json)
                VALUES (
                  NULL,
                  CASE
                    WHEN changes() = 1 AND (
                      SELECT COUNT(*) FROM users
                       WHERE username = ? AND name = ? AND role = 'staff'
                         AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL
                    ) = 1
                    THEN 'provision_smoke_identity'
                    ELSE NULL
                  END,
                  'user',
                  (SELECT id FROM users
                    WHERE username = ? AND name = ? AND role = 'staff'
                      AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL),
                  NULL, ?
                )`,
          params: [
            SMOKE_IDENTITY.username, SMOKE_IDENTITY.name,
            SMOKE_IDENTITY.username, SMOKE_IDENTITY.name, afterJson,
          ],
        },
        {
          sql: `DELETE FROM sessions
                 WHERE user_id = (
                   SELECT id FROM users
                    WHERE username = ? AND name = ? AND role = 'staff'
                      AND is_active = 1 AND is_deleted = 0 AND deleted_at IS NULL
                 )`,
          params: [SMOKE_IDENTITY.username, SMOKE_IDENTITY.name],
        },
      ]),
    });
  }

  if (!target
    || !Number.isSafeInteger(target.id)
    || target.id <= 0
    || ![0, 1].includes(target.observedActive)
    || (action === 'disable' && target.observedActive !== 1)) {
    throw new Error('Smoke identity mutation was invalid.');
  }
  const update = action === 'rotate'
    ? {
        sql: `UPDATE users SET password_hash = ?, is_active = 1,
                  updated_at = datetime('now')
                WHERE id = ? AND username = ? AND name = ?
                  AND role = 'staff' AND is_active = ? AND is_deleted = 0
                  AND deleted_at IS NULL`,
        params: [passwordHash, target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name, target.observedActive],
      }
    : {
        sql: `UPDATE users SET is_active = 0, updated_at = datetime('now')
                WHERE id = ? AND username = ? AND name = ?
                  AND role = 'staff' AND is_active = 1 AND is_deleted = 0
                  AND deleted_at IS NULL`,
        params: [target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name],
      };
  const resultingActive = action === 'disable' ? 0 : 1;
  return Object.freeze({
    auditJson: afterJson,
    batch: Object.freeze([
      update,
      {
        sql: `INSERT INTO audit_logs
                (actor_user_id, action, entity_type, entity_id, before_json, after_json)
              VALUES (
                NULL,
                CASE
                  WHEN changes() = 1 AND (
                    SELECT COUNT(*) FROM users
                     WHERE id = ? AND username = ? AND name = ?
                       AND role = 'staff' AND is_active = ? AND is_deleted = 0
                       AND deleted_at IS NULL
                  ) = 1
                  THEN '${AUDIT_ACTIONS[action]}'
                  ELSE NULL
                END,
                'user', ?, NULL, ?
              )`,
        params: [
          target.id, SMOKE_IDENTITY.username, SMOKE_IDENTITY.name,
          resultingActive, target.id, afterJson,
        ],
      },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [target.id] },
    ]),
  });
}

export function assertSmokeIdentityWrite(results, action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)
    || !Array.isArray(results)
    || results.length !== 3
    || results.some((result) => result?.success !== true
      || !Number.isSafeInteger(result.meta?.changes)
      || result.meta.changes < 0)
    || results[0].meta.changes !== 1
    || results[1].meta.changes !== 1) {
    throw new Error('Smoke identity write result was invalid.');
  }
}

export function buildSmokeIdentityPostflightQuery({ action, target, passwordHash }) {
  const targetIsValid = action === 'provision'
    ? target === null
    : target
      && Number.isSafeInteger(target.id)
      && target.id > 0
      && [0, 1].includes(target.observedActive)
      && (action !== 'disable' || target.observedActive === 1);
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)
    || !targetIsValid
    || (action === 'disable' && passwordHash !== undefined)
    || (action !== 'disable' && !HASH_PATTERN.test(passwordHash))) {
    throw new Error('Smoke identity postflight was invalid.');
  }
  const where = target?.id
    ? 'u.id = ? AND u.username = ?'
    : 'u.username = ?';
  const identityParams = target?.id
    ? [target.id, SMOKE_IDENTITY.username]
    : [SMOKE_IDENTITY.username];
  const hashProjection = action === 'disable'
    ? ''
    : `, u.password_hash = ? AS hash_matches,
         instr(u.password_hash, ?) = 1 AS hash_scheme_ok`;
  const params = action === 'disable'
    ? identityParams
    : [passwordHash, 'pbkdf2_sha256$100000$', ...identityParams];
  return {
    sql: `SELECT u.id, u.username, u.name, u.role, u.is_active, u.is_deleted, u.deleted_at
                 ${hashProjection},
                 (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
                 (SELECT action FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_action,
                 (SELECT actor_user_id FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_actor_user_id,
                 (SELECT before_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_before_json,
                 (SELECT after_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                   ORDER BY a.id DESC LIMIT 1) AS latest_audit_after_json
            FROM users u WHERE ${where}`,
    params,
  };
}

export function assertSmokeIdentityPostflight(results, { action, auditJson }) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action) || typeof auditJson !== 'string') {
    throw new Error('Smoke identity postflight was invalid.');
  }
  const rows = exactRows(results, 'Smoke identity postflight was invalid.');
  if (rows.length !== 1) throw new Error('Smoke identity postflight was invalid.');
  const row = rows[0];
  const expectedActive = action === 'disable' ? 0 : 1;
  const expectedKeys = action === 'disable'
    ? [
        'id', 'username', 'name', 'role', 'is_active', 'is_deleted', 'session_count',
        'deleted_at',
        'latest_audit_action', 'latest_audit_actor_user_id',
        'latest_audit_before_json', 'latest_audit_after_json',
      ]
    : [
        'id', 'username', 'name', 'role', 'is_active', 'is_deleted',
        'deleted_at',
        'hash_matches', 'hash_scheme_ok', 'session_count',
        'latest_audit_action', 'latest_audit_actor_user_id',
        'latest_audit_before_json', 'latest_audit_after_json',
      ];
  if (!row
    || Object.keys(row).sort().join(',') !== expectedKeys.sort().join(',')
    || !Number.isSafeInteger(row.id)
    || row.id <= 0
    || row.username !== SMOKE_IDENTITY.username
    || row.name !== SMOKE_IDENTITY.name
    || row.role !== SMOKE_IDENTITY.role
    || row.is_active !== expectedActive
    || row.is_deleted !== 0
    || row.deleted_at !== null
    || row.session_count !== 0
    || row.latest_audit_action !== AUDIT_ACTIONS[action]
    || row.latest_audit_actor_user_id !== null
    || row.latest_audit_before_json !== null
    || row.latest_audit_after_json !== auditJson
    || (action !== 'disable' && (row.hash_matches !== 1 || row.hash_scheme_ok !== 1))) {
    throw new Error('Smoke identity postflight was invalid.');
  }
  return Object.freeze({ id: row.id, active: row.is_active === 1 });
}

export async function runSmokeIdentityLifecycle({ client, databaseId, action, passwordHash }) {
  try {
    if (!client || typeof client.query !== 'function') throw new Error('invalid client');
    const target = parseSmokeIdentityPreflight(
      await client.query(databaseId, buildSmokeIdentityPreflightQuery()),
      action,
    );
    const mutation = buildSmokeIdentityMutation({
      action,
      target,
      passwordHash,
      operationId: randomUUID(),
    });
    try {
      assertSmokeIdentityWrite(
        await client.query(databaseId, { batch: mutation.batch }),
        action,
      );
    } catch (error) {
      let mayHaveSucceeded = false;
      try {
        mayHaveSucceeded = error?.requestMayHaveSucceeded === true;
      } catch {
        mayHaveSucceeded = false;
      }
      if (!mayHaveSucceeded) throw error;
    }
    const postflight = buildSmokeIdentityPostflightQuery({
      action, target, passwordHash,
    });
    return assertSmokeIdentityPostflight(
      await client.query(databaseId, { sql: postflight.sql, params: postflight.params }),
      { action, auditJson: mutation.auditJson },
    );
  } catch {
    throw new Error('Smoke identity lifecycle failed.');
  }
}
