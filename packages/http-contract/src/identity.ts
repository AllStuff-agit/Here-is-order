import { z } from 'zod';
import {
  apiEnvelopeSchema,
  type RuntimeSchema,
} from './envelope';

export const IDENTITY_JSON_BODY_LIMIT_BYTES = 32 * 1_024;
const SESSION_SECONDS = 2_592_000;

function codePointLength(value: string) {
  return Array.from(value).length;
}

function boundedString(min: number, max: number) {
  return z.string().refine((value) => {
    const length = codePointLength(value);
    return length >= min && length <= max;
  }, `must contain ${min}-${max} Unicode code points`);
}

function canonicalString(min: number, max: number) {
  return boundedString(min, max).refine((value) => value === value.trim(),
    'must already be trimmed');
}

function normalizedString(min: number, max: number) {
  return z.string().transform((value) => value.trim()).pipe(boundedString(min, max));
}

function isCanonicalSqliteUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return Number.isFinite(date.getTime())
    && date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

export const userRoleSchema = z.enum(['admin', 'staff']);
export const submittedPasswordSchema = boundedString(0, 4_096);
export const newHumanPasswordSchema = boundedString(12, 4_096);

export const sessionUserProjectionSchema = z.object({
  id: z.number().int().positive(),
  username: canonicalString(1, 128),
  name: canonicalString(1, 200),
  role: userRoleSchema,
}).strict();

export const adminUserProjectionSchema = sessionUserProjectionSchema.extend({
  is_active: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string().refine(isCanonicalSqliteUtc, 'invalid SQLite UTC timestamp'),
}).strict();

export const loginRequestSchema = z.object({
  username: normalizedString(1, 128),
  password: submittedPasswordSchema,
}).strict();
export const loginResultSchema = z.object({ user: sessionUserProjectionSchema }).strict();
export const logoutResultSchema = z.object({ loggedOut: z.literal(true) }).strict();
export const currentUserResultSchema = sessionUserProjectionSchema;
export const listUsersResultSchema = z.array(adminUserProjectionSchema);

const optionalNormalizedNameSchema = z.string()
  .transform((value) => value.trim())
  .refine((value) => codePointLength(value) <= 200, 'name is too long')
  .optional();
const optionalNormalizedRoleSchema = z.string()
  .transform((value) => value.trim())
  .pipe(userRoleSchema)
  .optional();

export const createUserRequestSchema = z.object({
  username: normalizedString(1, 128),
  name: optionalNormalizedNameSchema,
  password: newHumanPasswordSchema,
  role: optionalNormalizedRoleSchema,
}).strict().transform((value) => ({
  username: value.username,
  name: value.name || value.username,
  password: value.password,
  role: value.role ?? 'staff',
}));
export const createUserResultSchema = adminUserProjectionSchema;

export const selfPasswordChangeRequestSchema = z.object({
  current_password: submittedPasswordSchema,
  new_password: newHumanPasswordSchema,
}).strict();
export const adminPasswordResetRequestSchema = z.object({
  new_password: newHumanPasswordSchema,
}).strict();
export const passwordMutationResultSchema = z.object({ ok: z.literal(true) }).strict();

export type UserRole = z.infer<typeof userRoleSchema>;
export type SessionUserProjection = z.infer<typeof sessionUserProjectionSchema>;
export type AdminUserProjection = z.infer<typeof adminUserProjectionSchema>;
export type LoginRequest = z.input<typeof loginRequestSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type LogoutResult = z.infer<typeof logoutResultSchema>;
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;
export type NormalizedCreateUserRequest = z.output<typeof createUserRequestSchema>;
export type SelfPasswordChangeRequest = z.infer<typeof selfPasswordChangeRequestSchema>;
export type AdminPasswordResetRequest = z.infer<typeof adminPasswordResetRequestSchema>;
export type PasswordMutationResult = z.infer<typeof passwordMutationResultSchema>;

export const identityRoutePatterns = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  currentUser: '/api/users/me',
  users: '/api/users',
  ownPassword: '/api/users/me/password',
  userPassword: '/api/users/:id/password',
} as const;

function positivePathId(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('userId must be a positive integer');
  }
  return String(value);
}

export const identityPaths = {
  login: identityRoutePatterns.login,
  logout: identityRoutePatterns.logout,
  currentUser: identityRoutePatterns.currentUser,
  users: identityRoutePatterns.users,
  ownPassword: identityRoutePatterns.ownPassword,
  userPassword(userId: number) {
    return `/api/users/${positivePathId(userId)}/password`;
  },
} as const;

export type IdentityOperation =
  | 'login' | 'logout' | 'currentUser' | 'listUsers'
  | 'createUser' | 'changeOwnPassword' | 'resetPassword';

interface IdentitySuccessByOperation {
  login: LoginResult;
  logout: LogoutResult;
  currentUser: SessionUserProjection;
  listUsers: AdminUserProjection[];
  createUser: AdminUserProjection;
  changeOwnPassword: PasswordMutationResult;
  resetPassword: PasswordMutationResult;
}

export const identityMessages = {
  loginMissingFields: '아이디와 비밀번호를 입력해주세요.',
  passwordPolicyViolation: '새 비밀번호는 12자 이상이어야 합니다.',
  loginInvalidCredentials: '아이디 또는 비밀번호가 올바르지 않습니다.',
  currentPasswordInvalid: '현재 비밀번호가 올바르지 않습니다.',
  unauthorized: '로그인이 필요합니다.',
  tooManyAttempts: '로그인 시도가 너무 많습니다. 60초 후 다시 시도해주세요.',
  forbidden: '관리자 권한이 필요합니다.',
  readOnlyAccess: '읽기 전용 계정은 변경 작업을 할 수 없습니다.',
  selfResetNotAllowed: '본인 비밀번호는 보안 설정에서 변경해주세요.',
  authStateChanged: '계정 상태가 변경되었습니다. 다시 로그인해주세요.',
  targetStateChanged: '사용자 상태가 변경되었습니다. 다시 확인해주세요.',
  duplicateUsername: '이미 사용 중인 아이디입니다.',
  authTemporarilyUnavailable: '로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.',
  notFound: '사용자를 찾을 수 없습니다.',
  internalError: '서버 오류가 발생했습니다.',
} as const;

export interface IdentityAllowedErrorPair {
  readonly status: number;
  readonly code: string;
  readonly message: string | null;
}

export const identityAllowedErrorPairs = {
  login: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 401, code: 'INVALID_CREDENTIALS', message: identityMessages.loginInvalidCredentials },
    { status: 429, code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts },
    { status: 503, code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: identityMessages.authTemporarilyUnavailable },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  logout: [
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  currentUser: [
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  listUsers: [
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  createUser: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 403, code: 'READ_ONLY_ACCESS', message: identityMessages.readOnlyAccess },
    { status: 409, code: 'DUPLICATE_USERNAME', message: identityMessages.duplicateUsername },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  changeOwnPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 401, code: 'INVALID_CREDENTIALS', message: identityMessages.currentPasswordInvalid },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 409, code: 'AUTH_STATE_CHANGED', message: identityMessages.authStateChanged },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
  resetPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: identityMessages.passwordPolicyViolation },
    { status: 400, code: 'SELF_RESET_NOT_ALLOWED', message: identityMessages.selfResetNotAllowed },
    { status: 401, code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    { status: 403, code: 'FORBIDDEN', message: identityMessages.forbidden },
    { status: 403, code: 'READ_ONLY_ACCESS', message: identityMessages.readOnlyAccess },
    { status: 404, code: 'NOT_FOUND', message: identityMessages.notFound },
    { status: 409, code: 'TARGET_STATE_CHANGED', message: identityMessages.targetStateChanged },
    { status: 500, code: 'INTERNAL_ERROR', message: identityMessages.internalError },
  ],
} as const satisfies Record<IdentityOperation, readonly IdentityAllowedErrorPair[]>;

type IdentityErrorDefinition<K extends IdentityOperation> =
  (typeof identityAllowedErrorPairs)[K][number];
type IdentityErrorPayload<D> = D extends {
  code: infer C extends string;
  message: infer M;
} ? {
    code: C;
    message: M extends string ? M : string;
  } : never;

export type IdentityErrorByOperation<K extends IdentityOperation> = {
  ok: false;
  error: IdentityErrorPayload<IdentityErrorDefinition<K>>;
};
export type IdentityHttpResponse<K extends IdentityOperation> =
  | { ok: true; data: IdentitySuccessByOperation[K] }
  | IdentityErrorByOperation<K>;

const operationContracts: Record<IdentityOperation, {
  successStatus: number;
  successSchema: RuntimeSchema<unknown>;
}> = {
  login: { successStatus: 200, successSchema: loginResultSchema },
  logout: { successStatus: 200, successSchema: logoutResultSchema },
  currentUser: { successStatus: 200, successSchema: currentUserResultSchema },
  listUsers: { successStatus: 200, successSchema: listUsersResultSchema },
  createUser: { successStatus: 201, successSchema: createUserResultSchema },
  changeOwnPassword: { successStatus: 200, successSchema: passwordMutationResultSchema },
  resetPassword: { successStatus: 200, successSchema: passwordMutationResultSchema },
};

export class IdentityResponseContractError extends Error {
  readonly code = 'INVALID_RESPONSE';

  constructor() {
    super('Identity response contract was invalid.');
    this.name = 'IdentityResponseContractError';
  }
}

export function decodeIdentityHttpResponse<K extends IdentityOperation>(
  operation: K,
  status: number,
  input: unknown,
): IdentityHttpResponse<K> {
  try {
    const contract = operationContracts[operation];
    const envelope = apiEnvelopeSchema(contract.successSchema).parse(input);
    if (envelope.ok) {
      if (status !== contract.successStatus) throw new Error('status mismatch');
    } else {
      const allowed = (identityAllowedErrorPairs[operation] as readonly IdentityAllowedErrorPair[])
        .find((candidate) => (
          candidate.status === status && candidate.code === envelope.error.code
        ));
      if (!allowed || envelope.error.message.trim().length === 0) {
        throw new Error('error mismatch');
      }
      if (allowed.message !== null && envelope.error.message !== allowed.message) {
        throw new Error('message mismatch');
      }
    }
    return envelope as IdentityHttpResponse<K>;
  } catch {
    throw new IdentityResponseContractError();
  }
}

export interface HeaderReader {
  get(name: string): string | null;
}

export interface IdentityHeaderContext {
  secure: boolean;
  sessionCookiePresented: boolean;
}

function assertNewSessionCookie(
  value: string | null,
  secure: boolean,
  exactMaxAge: number | null,
) {
  const match = /^isorder_sid=([^;\s]+); HttpOnly; Path=\/; Max-Age=([1-9]\d*); SameSite=Strict(; Secure)?$/
    .exec(value ?? '');
  if (!match) throw new IdentityResponseContractError();
  const maxAge = Number(match[2]);
  const hasSecure = match[3] !== undefined;
  if (hasSecure !== secure
    || !Number.isSafeInteger(maxAge)
    || (exactMaxAge === null
      ? maxAge < 1 || maxAge > SESSION_SECONDS
      : maxAge !== exactMaxAge)) {
    throw new IdentityResponseContractError();
  }
}

export function assertIdentityResponseHeaders<K extends IdentityOperation>(
  operation: K,
  status: number,
  envelope: IdentityHttpResponse<K>,
  headers: HeaderReader,
  context: IdentityHeaderContext,
): void {
  const decoded = decodeIdentityHttpResponse(operation, status, envelope);
  if (headers.get('cache-control') !== 'no-store') {
    throw new IdentityResponseContractError();
  }

  const retryAfter = !decoded.ok
    && operation === 'login'
    && decoded.error.code === 'TOO_MANY_ATTEMPTS'
    ? '60'
    : null;
  if (headers.get('retry-after') !== retryAfter) {
    throw new IdentityResponseContractError();
  }

  const cookie = headers.get('set-cookie');
  if (decoded.ok && operation === 'login') {
    assertNewSessionCookie(cookie, context.secure, SESSION_SECONDS);
    return;
  }
  if (decoded.ok && operation === 'changeOwnPassword') {
    assertNewSessionCookie(cookie, context.secure, null);
    return;
  }

  const mustClear = (decoded.ok && operation === 'logout')
    || (!decoded.ok && decoded.error.code === 'AUTH_STATE_CHANGED')
    || (!decoded.ok
      && decoded.error.code === 'UNAUTHORIZED'
      && context.sessionCookiePresented);
  const mayClear = !decoded.ok
    && decoded.error.code === 'UNAUTHORIZED'
    && !context.sessionCookiePresented;
  const secureSuffix = context.secure ? '; Secure' : '';
  const clearCookie = `isorder_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secureSuffix}`;
  if (mustClear) {
    if (cookie !== clearCookie) {
      throw new IdentityResponseContractError();
    }
    return;
  }
  if (mayClear) {
    if (cookie !== null && cookie !== clearCookie) {
      throw new IdentityResponseContractError();
    }
    return;
  }
  if (cookie !== null) throw new IdentityResponseContractError();
}
