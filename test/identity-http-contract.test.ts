import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  IDENTITY_JSON_BODY_LIMIT_BYTES,
  IdentityResponseContractError,
  adminPasswordResetRequestSchema,
  adminUserProjectionSchema,
  assertIdentityResponseHeaders,
  createUserRequestSchema,
  decodeIdentityHttpResponse,
  identityAllowedErrorPairs,
  identityMessages,
  identityPaths,
  loginRequestSchema,
  newHumanPasswordSchema,
  selfPasswordChangeRequestSchema,
  sessionUserProjectionSchema,
  type IdentityAllowedErrorPair,
  type IdentityHttpResponse,
  type IdentityOperation,
} from '@here-is-order/http-contract/identity';

const sessionUser = {
  id: 7,
  username: 'staff-7',
  name: '직원 7',
  role: 'staff',
} as const;
const adminUser = {
  ...sessionUser,
  is_active: 1,
  created_at: '2026-07-15 12:34:56',
} as const;
const LOGIN_SESSION_TOKEN = '01234567-89ab-4cde-8f01-23456789abcd';
const ROTATED_SESSION_TOKEN = 'fedcba98-7654-4321-a987-6543210fedcb';
const SECURE_SESSION_TOKEN = 'abcdef01-2345-4678-9abc-def012345678';

const invalidNewSessionTokens = [
  { label: 'single-character token', token: 'x' },
  { label: 'malformed UUID', token: '01234567-89ab-4cde-8f01' },
  { label: 'uppercase UUIDv4', token: '01234567-89AB-4CDE-8F01-23456789ABCD' },
  { label: 'non-v4 UUID', token: '01234567-89ab-3cde-8f01-23456789abcd' },
  { label: 'UUIDv4 with an invalid variant', token: '01234567-89ab-4cde-7f01-23456789abcd' },
] as const;

const successes = [
  { operation: 'login', status: 200, data: { user: sessionUser } },
  { operation: 'logout', status: 200, data: { loggedOut: true } },
  { operation: 'currentUser', status: 200, data: sessionUser },
  { operation: 'listUsers', status: 200, data: [adminUser] },
  { operation: 'createUser', status: 201, data: adminUser },
  { operation: 'changeOwnPassword', status: 200, data: { ok: true } },
  { operation: 'resetPassword', status: 200, data: { ok: true } },
] as const;

const expectedErrors = {
  login: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 401, code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' },
    { status: 429, code: 'TOO_MANY_ATTEMPTS', message: '로그인 시도가 너무 많습니다. 60초 후 다시 시도해주세요.' },
    { status: 503, code: 'AUTH_TEMPORARILY_UNAVAILABLE', message: '로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  logout: [
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  currentUser: [
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  listUsers: [
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  createUser: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 403, code: 'READ_ONLY_ACCESS', message: '읽기 전용 계정은 변경 작업을 할 수 없습니다.' },
    { status: 409, code: 'DUPLICATE_USERNAME', message: '이미 사용 중인 아이디입니다.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  changeOwnPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 401, code: 'INVALID_CREDENTIALS', message: '현재 비밀번호가 올바르지 않습니다.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 409, code: 'AUTH_STATE_CHANGED', message: '계정 상태가 변경되었습니다. 다시 로그인해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
  resetPassword: [
    { status: 400, code: 'INVALID_INPUT', message: null },
    { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: '새 비밀번호는 12자 이상이어야 합니다.' },
    { status: 400, code: 'SELF_RESET_NOT_ALLOWED', message: '본인 비밀번호는 보안 설정에서 변경해주세요.' },
    { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' },
    { status: 403, code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' },
    { status: 403, code: 'READ_ONLY_ACCESS', message: '읽기 전용 계정은 변경 작업을 할 수 없습니다.' },
    { status: 404, code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' },
    { status: 409, code: 'TARGET_STATE_CHANGED', message: '사용자 상태가 변경되었습니다. 다시 확인해주세요.' },
    { status: 500, code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
  ],
} as const satisfies Record<IdentityOperation, readonly IdentityAllowedErrorPair[]>;

const operations = Object.keys(expectedErrors) as IdentityOperation[];
const allErrors = operations.flatMap((operation) => expectedErrors[operation].map((error) => ({
  operation,
  ...error,
})));
const allErrorDefinitions = Array.from(new Map(
  allErrors.map(({ status, code, message }) => [
    JSON.stringify([status, code, message]),
    { status, code, message },
  ]),
).values());
const knownErrorStatuses = Array.from(new Set(
  allErrors.map(({ status }) => status),
));
const mismatchedErrorPairs = operations.flatMap((operation) => knownErrorStatuses
  .flatMap((status) => allErrorDefinitions
    .filter((candidate) => !expectedErrors[operation].some((allowed) => (
      allowed.status === status && allowed.code === candidate.code
    )))
    .map((candidate) => ({ operation, ...candidate, status }))));

function errorEnvelope(error: IdentityAllowedErrorPair) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message ?? '입력값이 올바르지 않습니다.',
    },
  };
}

function expectInvalid(operation: IdentityOperation, status: number, input: unknown) {
  try {
    decodeIdentityHttpResponse(operation, status, input);
    throw new Error('expected contract failure');
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityResponseContractError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
  }
}

function headers(values: Readonly<Record<string, string | undefined>> = {}) {
  const normalized = new Map(
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
}

function sessionCookie(value: string, maxAge: number, secure = false) {
  return `isorder_sid=${value}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict${
    secure ? '; Secure' : ''
  }`;
}

function expectInvalidHeaders(
  operation: IdentityOperation,
  status: number,
  input: unknown,
  values: Readonly<Record<string, string | undefined>>,
  context: { secure: boolean; sessionCookiePresented: boolean },
) {
  const envelope = decodeIdentityHttpResponse(operation, status, input);
  expect(() => assertIdentityResponseHeaders(
    operation,
    status,
    envelope,
    headers(values),
    context,
  )).toThrowError(IdentityResponseContractError);
}

describe('Identity executable HTTP contract', () => {
  it('is consumed through the package export and keeps error codes route-closed', () => {
    expectTypeOf<Extract<IdentityHttpResponse<'login'>, { ok: false }>['error']['code']>()
      .toEqualTypeOf<
        'INVALID_INPUT' | 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS'
        | 'AUTH_TEMPORARILY_UNAVAILABLE' | 'INTERNAL_ERROR'
      >();
    expect(identityMessages.unauthorized).toBe('로그인이 필요합니다.');
  });

  it.each(successes)('decodes exact $operation success', ({ operation, status, data }) => {
    expect(decodeIdentityHttpResponse(operation, status, { ok: true, data }))
      .toEqual({ ok: true, data });
  });

  it('keeps session/admin projections exact and validates canonical SQLite UTC', () => {
    expect(sessionUserProjectionSchema.parse(sessionUser)).toEqual(sessionUser);
    expect(adminUserProjectionSchema.parse(adminUser)).toEqual(adminUser);
    expect(() => sessionUserProjectionSchema.parse(adminUser)).toThrow();
    expect(() => adminUserProjectionSchema.parse({ ...adminUser, access_mode: 'read_only' }))
      .toThrow();
    expect(() => sessionUserProjectionSchema.parse({ ...sessionUser, username: ' staff-7' }))
      .toThrow();
    for (const created_at of [
      '0000-01-01 00:00:00',
      '0099-12-31 23:59:59',
      '2024-02-29 12:34:56',
    ]) {
      expect(adminUserProjectionSchema.parse({ ...adminUser, created_at }).created_at)
        .toBe(created_at);
    }
    for (const created_at of ['2025-02-29 12:34:56', '2026-02-30 12:34:56']) {
      expect(() => adminUserProjectionSchema.parse({ ...adminUser, created_at })).toThrow();
    }
  });

  it.each([
    ['session username', sessionUserProjectionSchema, { ...sessionUser, username: 'staff\u00007' }],
    ['session name', sessionUserProjectionSchema, { ...sessionUser, name: '직원\u00007' }],
    ['admin username', adminUserProjectionSchema, { ...adminUser, username: 'staff\u00007' }],
    ['admin name', adminUserProjectionSchema, { ...adminUser, name: '직원\u00007' }],
  ] as const)('rejects U+0000 in %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['login username', loginRequestSchema, { username: 'login\u0000user', password: 'password' }],
    ['create-user username', createUserRequestSchema, {
      username: 'new\u0000user',
      password: '123456789012',
    }],
    ['create-user name', createUserRequestSchema, {
      username: 'new-user',
      name: 'New\u0000User',
      password: '123456789012',
    }],
  ] as const)('rejects U+0000 in %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('does not change submitted or new-password U+0000 semantics', () => {
    expect(loginRequestSchema.safeParse({
      username: 'login-user',
      password: 'pass\u0000word',
    }).success).toBe(true);
    expect(createUserRequestSchema.safeParse({
      username: 'new-user',
      password: '12345678901\u0000',
    }).success).toBe(true);
  });

  it('normalizes only documented fields and locks both sides of every field limit', () => {
    expect(IDENTITY_JSON_BODY_LIMIT_BYTES).toBe(32 * 1_024);
    expect(loginRequestSchema.parse({
      username: ` ${'u'.repeat(128)} `,
      password: '  secret  ',
    })).toEqual({ username: 'u'.repeat(128), password: '  secret  ' });
    expect(loginRequestSchema.safeParse({
      username: 'u'.repeat(129),
      password: 'p',
    }).success).toBe(false);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '😀'.repeat(4_096),
    }).success).toBe(true);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '',
    }).success).toBe(true);
    expect(loginRequestSchema.safeParse({
      username: 'u',
      password: '😀'.repeat(4_097),
    }).success).toBe(false);

    const nameAtLimit = createUserRequestSchema.parse({
      username: 'new-user',
      name: ` ${'가'.repeat(200)} `,
      password: '123456789012',
    });
    expect(nameAtLimit.name).toBe('가'.repeat(200));
    expect(createUserRequestSchema.safeParse({
      username: 'new-user',
      name: '가'.repeat(201),
      password: '123456789012',
    }).success).toBe(false);
    expect(createUserRequestSchema.parse({
      username: ' new-user ',
      name: '   ',
      password: '123456789012',
    })).toEqual({
      username: 'new-user',
      name: 'new-user',
      password: '123456789012',
      role: 'staff',
    });

    expect(newHumanPasswordSchema.safeParse('😀'.repeat(11)).success).toBe(false);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(12)).success).toBe(true);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(4_096)).success).toBe(true);
    expect(newHumanPasswordSchema.safeParse('😀'.repeat(4_097)).success).toBe(false);
    expect(loginRequestSchema.safeParse({
      username: 'u', password: 'p', extra: true,
    }).success).toBe(false);
    expect(createUserRequestSchema.safeParse({
      username: 'u', password: '123456789012', role: '',
    }).success).toBe(false);
    expect(createUserRequestSchema.safeParse({
      username: 1, password: '123456789012',
    }).success).toBe(false);
    expect(selfPasswordChangeRequestSchema.safeParse({
      current_password: 'old', new_password: '가'.repeat(12),
    }).success).toBe(true);
    expect(adminPasswordResetRequestSchema.safeParse({
      new_password: '가'.repeat(12),
    }).success).toBe(true);
  });

  it('owns paths and rejects non-positive reset ids', () => {
    expect(identityPaths.userPassword(9)).toBe('/api/users/9/password');
    expect(() => identityPaths.userPassword(0)).toThrow('positive integer');
    expect(() => identityPaths.userPassword(1.5)).toThrow('positive integer');
  });

  it('publishes the complete status/code/canonical-message matrix', () => {
    expect(identityAllowedErrorPairs).toEqual(expectedErrors);
  });

  it.each(allErrors)('accepts $operation $status/$code with its message', (fixture) => {
    const input = errorEnvelope(fixture);
    expect(decodeIdentityHttpResponse(fixture.operation, fixture.status, input)).toEqual(input);
  });

  it.each(successes)('rejects every $operation success at another status', (fixture) => {
    expectInvalid(
      fixture.operation,
      fixture.status === 200 ? 201 : 200,
      { ok: true, data: fixture.data },
    );
  });

  it.each(allErrors)('rejects every $operation error at the success status', (fixture) => {
    const successStatus = successes.find(({ operation }) => operation === fixture.operation)!.status;
    expectInvalid(fixture.operation, successStatus, errorEnvelope(fixture));
  });

  it.each(mismatchedErrorPairs)(
    'rejects every unlisted $operation $status/$code combination',
    (fixture) => expectInvalid(fixture.operation, fixture.status, errorEnvelope(fixture)),
  );

  it.each(allErrors.filter(({ message }) => message !== null))(
    'rejects the wrong canonical message for $operation $status/$code',
    (fixture) => expectInvalid(fixture.operation, fixture.status, {
      ok: false,
      error: { code: fixture.code, message: `${fixture.message}x` },
    }),
  );

  it.each([
    ['login', 401, { ok: false, error: { code: 'UNKNOWN', message: 'x' } }],
    ['login', 400, { ok: false, error: { code: 'INVALID_INPUT', message: '' } }],
    ['currentUser', 401, { ok: false, error: { code: 'UNAUTHORIZED' } }],
    ['currentUser', 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.', extra: true } }],
    ['currentUser', 200, { ok: true, data: { ...sessionUser, access_mode: 'read_only' } }],
    ['currentUser', 200, { ok: true, data: sessionUser, extra: true }],
    ['resetPassword', 200, { ok: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' } }],
  ] as const)('rejects malformed or incoherent %s response', (operation, status, input) => {
    expectInvalid(operation, status, input);
  });

  it.each(successes)('requires no-store and the exact $operation success cookie rule', (fixture) => {
    const envelope = decodeIdentityHttpResponse(
      fixture.operation,
      fixture.status,
      { ok: true, data: fixture.data },
    );
    const setCookie = fixture.operation === 'login'
      ? sessionCookie(LOGIN_SESSION_TOKEN, 2_592_000)
      : fixture.operation === 'logout'
        ? sessionCookie('', 0)
        : fixture.operation === 'changeOwnPassword'
          ? sessionCookie(ROTATED_SESSION_TOKEN, 37)
          : undefined;
    assertIdentityResponseHeaders(
      fixture.operation,
      fixture.status,
      envelope,
      headers({
        'cache-control': 'no-store',
        ...(setCookie ? { 'set-cookie': setCookie } : {}),
      }),
      { secure: false, sessionCookiePresented: true },
    );
  });

  it.each(allErrors)('requires exact headers for $operation $status/$code', (fixture) => {
    const envelope = decodeIdentityHttpResponse(
      fixture.operation,
      fixture.status,
      errorEnvelope(fixture),
    );
    const mustClear = fixture.code === 'UNAUTHORIZED' || fixture.code === 'AUTH_STATE_CHANGED';
    assertIdentityResponseHeaders(
      fixture.operation,
      fixture.status,
      envelope,
      headers({
        'cache-control': 'no-store',
        ...(mustClear ? { 'set-cookie': sessionCookie('', 0) } : {}),
        ...(fixture.operation === 'login' && fixture.code === 'TOO_MANY_ATTEMPTS'
          ? { 'retry-after': '60' }
          : {}),
      }),
      { secure: false, sessionCookiePresented: true },
    );
  });

  it('allows either omission or an exact clear for missing-cookie UNAUTHORIZED', () => {
    const unauthorized = decodeIdentityHttpResponse('currentUser', 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: identityMessages.unauthorized },
    });
    assertIdentityResponseHeaders(
      'currentUser',
      401,
      unauthorized,
      headers({ 'cache-control': 'no-store' }),
      { secure: false, sessionCookiePresented: false },
    );
    assertIdentityResponseHeaders(
      'currentUser',
      401,
      unauthorized,
      headers({
        'cache-control': 'no-store',
        'set-cookie': sessionCookie('', 0),
      }),
      { secure: false, sessionCookiePresented: false },
    );
  });

  it('accepts exact Secure cookie attributes', () => {
    const login = decodeIdentityHttpResponse('login', 200, {
      ok: true,
      data: { user: sessionUser },
    });
    assertIdentityResponseHeaders(
      'login',
      200,
      login,
      headers({
        'cache-control': 'no-store',
        'set-cookie': sessionCookie(SECURE_SESSION_TOKEN, 2_592_000, true),
      }),
      { secure: true, sessionCookiePresented: false },
    );
  });

  it.each(invalidNewSessionTokens)('rejects $label on login success', ({ token }) => {
    expectInvalidHeaders(
      'login',
      200,
      { ok: true, data: { user: sessionUser } },
      {
        'cache-control': 'no-store',
        'set-cookie': sessionCookie(token, 2_592_000),
      },
      { secure: false, sessionCookiePresented: false },
    );
  });

  it.each(invalidNewSessionTokens)(
    'rejects $label on self-password success',
    ({ token }) => {
      expectInvalidHeaders(
        'changeOwnPassword',
        200,
        { ok: true, data: { ok: true } },
        {
          'cache-control': 'no-store',
          'set-cookie': sessionCookie(token, 37),
        },
        { secure: false, sessionCookiePresented: true },
      );
    },
  );

  it.each([
    {
      label: 'presented-cookie UNAUTHORIZED without clear',
      operation: 'currentUser',
      status: 401,
      input: { ok: false, error: { code: 'UNAUTHORIZED', message: identityMessages.unauthorized } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'AUTH_STATE_CHANGED without clear',
      operation: 'changeOwnPassword',
      status: 409,
      input: { ok: false, error: { code: 'AUTH_STATE_CHANGED', message: identityMessages.authStateChanged } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'TARGET_STATE_CHANGED with clear',
      operation: 'resetPassword',
      status: 409,
      input: { ok: false, error: { code: 'TARGET_STATE_CHANGED', message: identityMessages.targetStateChanged } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('', 0) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'logout 500 with clear',
      operation: 'logout',
      status: 500,
      input: { ok: false, error: { code: 'INTERNAL_ERROR', message: identityMessages.internalError } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('', 0) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'login success missing cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'login success wrong cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie(LOGIN_SESSION_TOKEN, 37) },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'logout success missing cookie',
      operation: 'logout',
      status: 200,
      input: { ok: true, data: { loggedOut: true } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'logout success wrong cookie',
      operation: 'logout',
      status: 200,
      input: { ok: true, data: { loggedOut: true } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie('new-token', 2_592_000) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'self-change success missing cookie',
      operation: 'changeOwnPassword',
      status: 200,
      input: { ok: true, data: { ok: true } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'self-change success wrong cookie',
      operation: 'changeOwnPassword',
      status: 200,
      input: { ok: true, data: { ok: true } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie(ROTATED_SESSION_TOKEN, 2_592_001) },
      context: { secure: false, sessionCookiePresented: true },
    },
    {
      label: 'login 429 missing Retry-After',
      operation: 'login',
      status: 429,
      input: { ok: false, error: { code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts } },
      values: { 'cache-control': 'no-store' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'login 429 wrong Retry-After',
      operation: 'login',
      status: 429,
      input: { ok: false, error: { code: 'TOO_MANY_ATTEMPTS', message: identityMessages.tooManyAttempts } },
      values: { 'cache-control': 'no-store', 'retry-after': '61' },
      context: { secure: false, sessionCookiePresented: false },
    },
    {
      label: 'Secure context with non-Secure cookie',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'cache-control': 'no-store', 'set-cookie': sessionCookie(LOGIN_SESSION_TOKEN, 2_592_000) },
      context: { secure: true, sessionCookiePresented: false },
    },
    {
      label: 'Identity response missing no-store',
      operation: 'login',
      status: 200,
      input: { ok: true, data: { user: sessionUser } },
      values: { 'set-cookie': sessionCookie(LOGIN_SESSION_TOKEN, 2_592_000) },
      context: { secure: false, sessionCookiePresented: false },
    },
  ] as const)('rejects $label', ({ operation, status, input, values, context }) => {
    expectInvalidHeaders(operation, status, input, values, context);
  });
});
