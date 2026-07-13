const ACTIVE_ADMIN_PREDICATE = `username = ?
  AND role = 'admin'
  AND is_active = 1
  AND is_deleted = 0`;

export function parseRecoveryArgs(argv) {
  let remote = false;
  let username;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--remote') {
      if (remote) throw new Error('--remote는 한 번만 사용할 수 있습니다.');
      remote = true;
    } else if (value === '--username') {
      if (username !== undefined) {
        throw new Error('--username은 한 번만 사용할 수 있습니다.');
      }
      const candidate = argv[index + 1];
      if (!candidate || candidate.startsWith('--')) {
        throw new Error('--username 값이 필요합니다.');
      }
      username = candidate;
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${value}`);
    }
  }
  if (!remote) throw new Error('password recovery에는 --remote가 필요합니다.');
  if (!username?.trim()) throw new Error('--username을 입력해야 합니다.');
  return { remote: true, username: username.trim() };
}

export function expectedRecoveryConfirmation(databaseName, username) {
  return `RECOVER ${databaseName} ${username}`;
}

export function validateRecoveryPassword(password, confirmation) {
  if (Array.from(password).length < 12) {
    throw new Error('새 비밀번호는 12자 이상이어야 합니다.');
  }
  if (password !== confirmation) {
    throw new Error('새 비밀번호 확인이 일치하지 않습니다.');
  }
  return password;
}

export function buildRecoveryPreflightQuery(username) {
  return {
    sql: `SELECT id, username FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}`,
    params: [username],
  };
}

function exactSingleQueryRow(results, errorMessage) {
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(errorMessage);
  }
  const [result] = results;
  if (!result
    || result.success !== true
    || !Array.isArray(result.results)
    || result.results.length !== 1) {
    throw new Error(errorMessage);
  }
  const [row] = result.results;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(errorMessage);
  }
  return row;
}

export function assertRecoverableAdmin(results, username) {
  const errorMessage = '정확히 한 active admin을 찾을 수 없습니다.';
  const row = exactSingleQueryRow(results, errorMessage);
  if (!Number.isSafeInteger(row.id)
    || row.id <= 0
    || row.username !== username) {
    throw new Error(errorMessage);
  }
  return { id: row.id, username: row.username };
}

export function buildRecoveryBatch({ username, passwordHash }) {
  const auditJson = JSON.stringify({ source: 'operator_recovery', username });
  return {
    auditJson,
    batch: [
      {
        sql: `UPDATE users SET password_hash = ?, updated_at = datetime('now')
              WHERE ${ACTIVE_ADMIN_PREDICATE}`,
        params: [passwordHash, username],
      },
      {
        sql: `DELETE FROM sessions WHERE user_id IN (
                SELECT id FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}
              )`,
        params: [username],
      },
      {
        sql: `INSERT INTO audit_logs
                (actor_user_id, action, entity_type, entity_id, before_json, after_json)
              SELECT NULL, 'recover_password', 'user', id, NULL, ?
                FROM users WHERE ${ACTIVE_ADMIN_PREDICATE}`,
        params: [auditJson, username],
      },
    ],
  };
}

export function buildRecoveryPostflightQuery(username) {
  return {
    sql: `SELECT u.id, u.username,
                 instr(u.password_hash, ?) = 1 AS hash_scheme_ok,
                 (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
                 (SELECT after_json FROM audit_logs a
                   WHERE a.entity_type = 'user' AND a.entity_id = u.id
                     AND a.action = 'recover_password'
                   ORDER BY a.id DESC LIMIT 1) AS latest_recovery_audit
            FROM users u WHERE ${ACTIVE_ADMIN_PREDICATE}`,
    params: ['pbkdf2_sha256$100000$', username],
  };
}

export function assertRecoveryWriteResults(results) {
  if (!Array.isArray(results)
    || results.length !== 3
    || results.some((result) => !result || result.success !== true)) {
    throw new Error('password recovery D1 batch가 완전히 성공하지 않았습니다.');
  }
  if (results[0].meta?.changes !== 1) {
    throw new Error('password recovery가 정확히 한 admin을 변경하지 않았습니다.');
  }
}

export function assertRecoveryPostflight(results, username, auditJson) {
  const errorMessage = 'password recovery postflight 검증에 실패했습니다.';
  const row = exactSingleQueryRow(results, errorMessage);
  if (row.username !== username
    || row.hash_scheme_ok !== 1
    || row.session_count !== 0) {
    throw new Error(errorMessage);
  }
  if (row.latest_recovery_audit !== auditJson) {
    throw new Error('password recovery audit fact가 일치하지 않습니다.');
  }
}
