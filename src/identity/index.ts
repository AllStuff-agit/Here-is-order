import type {
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
  });
}
