import type {
  AdminUserProjection,
  SessionUserProjection,
  UserRole,
} from '@here-is-order/http-contract/identity';
import { workerIdentityCredential } from './worker-credential-crypto';

export const SESSION_SECONDS = 2_592_000;

export type IdentityPrincipal = Readonly<{
  sessionId: number;
  sessionExpiresAt: string;
  userId: number;
  username: string;
  name: string;
  role: UserRole;
}>;

export type IdentityFailure<K extends string> = Readonly<{
  ok: false;
  error: Readonly<{ kind: K }>;
}>;

export type IdentitySuccess<T> = Readonly<{
  ok: true;
  value: T;
}>;

export interface RuntimeIdentity {
  authenticate(input: Readonly<{
    username: string;
    password: string;
  }>): Promise<
    | IdentitySuccess<Readonly<{
      token: string;
      user: SessionUserProjection;
    }>>
    | IdentityFailure<'account_unavailable' | 'invalid_credentials'>
  >;
  resolveSession(rawToken: string): Promise<IdentityPrincipal | null>;
  currentUser(principal: IdentityPrincipal): SessionUserProjection;
  cleanupExpiredSessions(): Promise<void>;
  logout(input: Readonly<{
    principal: IdentityPrincipal;
    rawToken: string;
  }>): Promise<IdentitySuccess<Readonly<{ loggedOut: true }>>>;
  listUsers(principal: IdentityPrincipal): Promise<
    IdentitySuccess<AdminUserProjection[]>
    | IdentityFailure<'forbidden'>
  >;
  createUser(
    principal: IdentityPrincipal,
    input: Readonly<{
      username: string;
      name: string;
      password: string;
      role: UserRole;
    }>,
  ): Promise<
    IdentitySuccess<AdminUserProjection | null>
    | IdentityFailure<'forbidden' | 'duplicate_username'>
  >;
  changeOwnPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      currentPassword: string;
      newPassword: string;
      currentRawToken: string;
    }>,
  ): Promise<
    IdentitySuccess<Readonly<{ ok: true }>>
    | IdentityFailure<'not_found' | 'invalid_credentials'>
  >;
  resetPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      targetId: number;
      newPassword: string;
    }>,
  ): Promise<
    IdentitySuccess<Readonly<{ ok: true }>>
    | IdentityFailure<'forbidden' | 'not_found'>
  >;
}

type SessionResolutionRow = Readonly<{
  session_id: number;
  session_expires_at: string;
  user_id: number;
  username: string;
  name: string;
  role: UserRole;
}>;

type AuthenticationUserRow = Readonly<{
  user_id: number;
  username: string;
  password_hash: string;
  name: string;
  role: UserRole;
  is_active: number;
  is_deleted: number;
}>;

type AdminUserRow = Readonly<{
  id: number;
  username: string;
  name: string;
  role: UserRole;
  is_active: 0 | 1;
  created_at: string;
}>;

type PasswordHashRow = Readonly<{
  password_hash: string;
}>;

function failure<K extends string>(kind: K): IdentityFailure<K> {
  const error = Object.freeze({ kind });
  return Object.freeze({ ok: false as const, error });
}

function success<T>(value: T): IdentitySuccess<T> {
  return Object.freeze({ ok: true as const, value });
}

function sessionUserProjection(
  id: number,
  username: string,
  name: string,
  role: UserRole,
) {
  const user = {
    id,
    username,
    name,
    role,
  } satisfies SessionUserProjection;
  return Object.freeze(user);
}

function adminUserProjection(row: AdminUserRow) {
  const user = {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
  } satisfies AdminUserProjection;
  return Object.freeze(user);
}

function auditStatement(
  db: D1Database,
  actorUserId: number | null,
  action: string,
  entityType: string,
  entityId: number | null,
  before?: unknown,
  after?: unknown,
) {
  return db.prepare(
    `INSERT INTO audit_logs
       (actor_user_id, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    actorUserId,
    action,
    entityType,
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
}

export function identity(db: D1Database): RuntimeIdentity {
  async function resolveSession(rawToken: string) {
    const row = await db.prepare(
      `SELECT s.id AS session_id,
              s.expires_at AS session_expires_at,
              u.id AS user_id,
              u.username AS username,
              u.name AS name,
              u.role AS role
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
        WHERE s.token = ?
          AND u.is_active = 1
          AND u.is_deleted = 0
          AND unixepoch(s.expires_at) > unixepoch('now')`,
    ).bind(rawToken).first<SessionResolutionRow>();

    if (!row) return null;

    const principal = {
      sessionId: row.session_id,
      sessionExpiresAt: row.session_expires_at,
      userId: row.user_id,
      username: row.username,
      name: row.name,
      role: row.role,
    } satisfies IdentityPrincipal;
    return Object.freeze(principal);
  }

  function currentUser(principal: IdentityPrincipal) {
    return sessionUserProjection(
      principal.userId,
      principal.username,
      principal.name,
      principal.role,
    );
  }

  async function logout(input: Readonly<{
    principal: IdentityPrincipal;
    rawToken: string;
  }>) {
    await db.batch([
      db.prepare(
        'DELETE FROM sessions WHERE token = ? AND user_id = ?',
      ).bind(input.rawToken, input.principal.userId),
      auditStatement(
        db,
        input.principal.userId,
        'logout',
        'user',
        input.principal.userId,
      ),
    ]);

    return success(Object.freeze({ loggedOut: true as const }));
  }

  async function listUsers(principal: IdentityPrincipal) {
    if (principal.role !== 'admin') return failure('forbidden');

    const rows = await db.prepare(
      `SELECT id AS id,
              username AS username,
              name AS name,
              role AS role,
              is_active AS is_active,
              created_at AS created_at
         FROM users
        WHERE is_deleted = 0
        ORDER BY id ASC`,
    ).all<AdminUserRow>();
    const users: AdminUserProjection[] = rows.results.map((row) => (
      adminUserProjection(row)
    ));
    Object.freeze(users);
    return success(users);
  }

  async function createUser(
    principal: IdentityPrincipal,
    input: Readonly<{
      username: string;
      name: string;
      password: string;
      role: UserRole;
    }>,
  ) {
    if (principal.role !== 'admin') return failure('forbidden');

    const existing = await db.prepare(
      `SELECT id
         FROM users
        WHERE username = ?
          AND is_deleted = 0`,
    ).bind(input.username).first<{ id: number }>();
    if (existing) return failure('duplicate_username');

    const passwordHash = await workerIdentityCredential.createPasswordHash(
      input.password,
    );
    const results = await db.batch([
      db.prepare(
        `INSERT INTO users (username, password_hash, name, role)
         VALUES (?, ?, ?, ?)`,
      ).bind(input.username, passwordHash, input.name, input.role),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         VALUES (?, 'create', 'user', last_insert_rowid(), NULL, ?)`,
      ).bind(
        principal.userId,
        JSON.stringify({ username: input.username, role: input.role }),
      ),
    ]);

    const userId = Number(results[0].meta.last_row_id);
    const row = await db.prepare(
      `SELECT id AS id,
              username AS username,
              name AS name,
              role AS role,
              is_active AS is_active,
              created_at AS created_at
         FROM users
        WHERE id = ?`,
    ).bind(userId).first<AdminUserRow>();
    return success(row === null ? null : adminUserProjection(row));
  }

  async function changeOwnPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      currentPassword: string;
      newPassword: string;
      currentRawToken: string;
    }>,
  ) {
    const row = await db.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    ).bind(principal.userId).first<PasswordHashRow>();
    if (!row) return failure('not_found');

    const passwordCheck = await workerIdentityCredential.verifyPassword(
      input.currentPassword,
      row.password_hash,
    );
    if (!passwordCheck.valid) return failure('invalid_credentials');

    const newHash = await workerIdentityCredential.createPasswordHash(
      input.newPassword,
    );
    await db.batch([
      db.prepare(
        `UPDATE users
            SET password_hash = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).bind(newHash, principal.userId),
      db.prepare(
        'DELETE FROM sessions WHERE user_id = ? AND token <> ?',
      ).bind(principal.userId, input.currentRawToken),
      auditStatement(
        db,
        principal.userId,
        'change_password',
        'user',
        principal.userId,
      ),
    ]);

    return success(Object.freeze({ ok: true as const }));
  }

  async function resetPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      targetId: number;
      newPassword: string;
    }>,
  ) {
    if (principal.role !== 'admin') return failure('forbidden');

    const target = await db.prepare(
      `SELECT id
         FROM users
        WHERE id = ?
          AND is_deleted = 0`,
    ).bind(input.targetId).first<{ id: number }>();
    if (!target) return failure('not_found');

    const newHash = await workerIdentityCredential.createPasswordHash(
      input.newPassword,
    );
    await db.batch([
      db.prepare(
        `UPDATE users
            SET password_hash = ?, updated_at = datetime('now')
          WHERE id = ?
            AND is_deleted = 0`,
      ).bind(newHash, input.targetId),
      db.prepare(
        'DELETE FROM sessions WHERE user_id = ?',
      ).bind(input.targetId),
      auditStatement(
        db,
        principal.userId,
        'reset_password',
        'user',
        input.targetId,
      ),
    ]);

    return success(Object.freeze({ ok: true as const }));
  }

  async function authenticate(input: Readonly<{
    username: string;
    password: string;
  }>) {
    const user = await db.prepare(
      `SELECT id AS user_id,
              username AS username,
              password_hash AS password_hash,
              name AS name,
              role AS role,
              is_active AS is_active,
              is_deleted AS is_deleted
         FROM users
        WHERE username = ?
          AND is_active = 1
          AND is_deleted = 0`,
    ).bind(input.username).first<AuthenticationUserRow>();

    if (!user) return failure('account_unavailable');

    const passwordCheck = await workerIdentityCredential.verifyPassword(
      input.password,
      user.password_hash,
    );
    if (!passwordCheck.valid) return failure('invalid_credentials');

    const token = crypto.randomUUID();
    const loginStatements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO sessions (token, user_id, expires_at)
         SELECT ?, id, datetime('now', '+' || ? || ' seconds')
           FROM users
          WHERE id = ?
            AND password_hash = ?
            AND is_active = ?
            AND is_deleted = ?`,
      ).bind(
        token,
        SESSION_SECONDS,
        user.user_id,
        user.password_hash,
        user.is_active,
        user.is_deleted,
      ),
      db.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'login', 'user', ?, NULL, ? WHERE changes() = 1`,
      ).bind(
        user.user_id,
        user.user_id,
        JSON.stringify({ username: user.username }),
      ),
    ];

    if (passwordCheck.upgradedHash !== null) {
      loginStatements.push(
        db.prepare(
          `UPDATE users
              SET password_hash = ?, updated_at = datetime('now')
            WHERE id = ?
              AND password_hash = ?
              AND is_active = ?
              AND is_deleted = ?`,
        ).bind(
          passwordCheck.upgradedHash,
          user.user_id,
          user.password_hash,
          user.is_active,
          user.is_deleted,
        ),
      );
    }

    const loginResult = await db.batch(loginStatements);
    if (loginResult[0].meta.changes !== 1) {
      return failure('invalid_credentials');
    }

    const userProjection = sessionUserProjection(
      user.user_id,
      user.username,
      user.name,
      user.role,
    );
    const value = Object.freeze({ token, user: userProjection });
    return success(value);
  }

  async function cleanupExpiredSessions() {
    await db.prepare(
      `DELETE FROM sessions
        WHERE unixepoch(expires_at) IS NULL
           OR unixepoch(expires_at) <= unixepoch('now')`,
    ).run();
  }

  return Object.freeze({
    authenticate,
    resolveSession,
    currentUser,
    cleanupExpiredSessions,
    logout,
    listUsers,
    createUser,
    changeOwnPassword,
    resetPassword,
  });
}
