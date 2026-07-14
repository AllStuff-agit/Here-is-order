import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTHENTICATED_SMOKE_VERSION,
  buildAuthenticatedSmokeReport,
  parseAuthenticatedSmokeEnvironment,
  renderAuthenticatedSmokeSummary,
  runAuthenticatedBusinessSmoke,
  validateAuthenticatedSmokeOrigin,
  verifyAuthenticatedBusinessTransaction,
} from './authenticated-business-smoke.mjs';

const ORIGIN = 'https://hereisorder-web.accountslug.workers.dev';
const PASSWORD = 'x'.repeat(64);
const USER = {
  id: 41,
  username: 'deployment-smoke',
  name: 'Deployment Smoke',
  role: 'staff',
};
const COOKIE = 'isorder_sid=11111111-1111-4111-8111-111111111111';
const BASE_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_STEP_SUMMARY: '/tmp/authenticated-smoke-summary.md',
  DEPLOYMENT_URL: ORIGIN,
  PRODUCTION_SMOKE_PASSWORD: PASSWORD,
};
const REPORT_INPUT = {
  executedAt: '2026-07-13T19:00:00.000Z',
  gitSha: 'a'.repeat(40),
  runId: '12345',
  runAttempt: 2,
};
const PURCHASE_ORDER_SUMMARY = {
  id: 7,
  title: 'Sentinel collision',
  status: 'draft',
  order_date: '2026-07-14',
  external_order_ref: null,
  note: null,
  created_at: '2026-07-14 00:00:00',
  updated_at: '2026-07-14 00:00:00',
  ordered_qty: 0,
  received_qty: 0,
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});
const html = (body = 'ok') => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});

test('origin accepts only the fixed canonical production web Worker shape', () => {
  assert.equal(validateAuthenticatedSmokeOrigin(ORIGIN).origin, ORIGIN);
  for (const value of [
    'https://evil.example',
    'http://hereisorder-web.accountslug.workers.dev',
    'https://hereisorder.accountslug.workers.dev',
    'https://hereisorder-web.workers.dev',
    'https://hereisorder-web.accountslug.workers.dev/',
    'https://user:pass@hereisorder-web.accountslug.workers.dev',
    'https://hereisorder-web.accountslug.workers.dev:443',
    'https://hereisorder-web.accountslug.workers.dev:8443',
    'https://hereisorder-web.accountslug.workers.dev/login',
    'https://hereisorder-web.accountslug.workers.dev?next=evil',
  ]) {
    assert.throws(() => validateAuthenticatedSmokeOrigin(value), /origin was invalid/);
  }
});

test('environment accepts ambient keys but returns only the frozen strict CI projection', () => {
  for (const eventName of ['push', 'workflow_dispatch']) {
    const parsed = parseAuthenticatedSmokeEnvironment({
      ...BASE_ENV,
      GITHUB_EVENT_NAME: eventName,
      AMBIENT_VALUE: 'must-not-enter-the-projection',
    });
    assert.deepEqual(parsed, {
      origin: ORIGIN,
      password: PASSWORD,
      gitSha: 'a'.repeat(40),
      runId: '12345',
      runAttempt: 2,
      summaryPath: '/tmp/authenticated-smoke-summary.md',
    });
    assert.deepEqual(Object.keys(parsed), [
      'origin',
      'password',
      'gitSha',
      'runId',
      'runAttempt',
      'summaryPath',
    ]);
    assert.equal(Object.isFrozen(parsed), true);
    assert.throws(() => {
      parsed.runAttempt = 3;
    }, TypeError);
  }

  const invalidPatches = [
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'A'.repeat(40) },
    { GITHUB_SHA: 'short' },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '01' },
    { GITHUB_RUN_ID: 12345 },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ATTEMPT: '01' },
    { GITHUB_RUN_ATTEMPT: '1.5' },
    { GITHUB_RUN_ATTEMPT: 2 },
    { GITHUB_RUN_ATTEMPT: String(Number.MAX_SAFE_INTEGER + 1) },
    { GITHUB_STEP_SUMMARY: 'relative.md' },
    { GITHUB_STEP_SUMMARY: '/tmp/authenticated-smoke/../summary.md' },
    { DEPLOYMENT_URL: 'https://evil.example' },
    { PRODUCTION_SMOKE_PASSWORD: 'short' },
  ];
  for (const patch of invalidPatches) {
    assert.throws(
      () => parseAuthenticatedSmokeEnvironment({ ...BASE_ENV, ...patch }),
      (error) => error.message === 'Authenticated smoke environment was invalid.'
        && !error.message.includes(PASSWORD)
        && !error.message.includes(ORIGIN),
    );
  }
  assert.throws(
    () => parseAuthenticatedSmokeEnvironment(undefined),
    (error) => error.message === 'Authenticated smoke environment was invalid.',
  );
});

test('report and summary expose an immutable exact ordered whitelist', () => {
  const report = buildAuthenticatedSmokeReport(REPORT_INPUT);
  const expected = {
    smokeVersion: 'authenticated-business-smoke-v1',
    executedAt: '2026-07-13T19:00:00.000Z',
    gitSha: 'a'.repeat(40),
    runId: '12345',
    runAttempt: 2,
    target: 'web',
    outcome: 'verified',
  };
  assert.equal(AUTHENTICATED_SMOKE_VERSION, 'authenticated-business-smoke-v1');
  assert.deepEqual(report, expected);
  assert.deepEqual(Object.keys(report), [
    'smokeVersion',
    'executedAt',
    'gitSha',
    'runId',
    'runAttempt',
    'target',
    'outcome',
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.throws(() => {
    report.outcome = 'tampered';
  }, TypeError);

  const summary = renderAuthenticatedSmokeSummary(report);
  assert.match(summary, /^## Authenticated business smoke\n\n```json\n/);
  assert.equal(summary.endsWith('\n```\n'), true);
  assert.deepEqual(JSON.parse(summary.match(/```json\n([\s\S]+)\n```/)[1]), expected);
  for (const forbidden of [
    'deployment-smoke',
    PASSWORD,
    COOKIE,
    ORIGIN,
    'purchase-orders',
    'hio-runtime-smoke',
    'raw row',
  ]) {
    assert.equal(summary.includes(forbidden), false);
  }

  assert.throws(
    () => buildAuthenticatedSmokeReport({ ...REPORT_INPUT, secret: PASSWORD }),
    (error) => error.message === 'Authenticated smoke report was invalid.'
      && !error.message.includes(PASSWORD),
  );
  assert.throws(
    () => buildAuthenticatedSmokeReport({ ...REPORT_INPUT, executedAt: 'not-a-date' }),
    (error) => error.message === 'Authenticated smoke report was invalid.'
      && !error.message.includes('Invalid time value'),
  );
  for (const invalidInput of [
    { ...REPORT_INPUT, gitSha: 'A'.repeat(40) },
    { ...REPORT_INPUT, runId: '012345' },
    { ...REPORT_INPUT, runId: 12345 },
    { ...REPORT_INPUT, runAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { ...REPORT_INPUT, runAttempt: '2' },
    { ...REPORT_INPUT, executedAt: '2026-07-13T19:00:00Z' },
    { gitSha: REPORT_INPUT.gitSha, runId: REPORT_INPUT.runId, runAttempt: 2 },
  ]) {
    assert.throws(
      () => buildAuthenticatedSmokeReport(invalidInput),
      (error) => error.message === 'Authenticated smoke report was invalid.',
    );
  }

  const { outcome: _outcome, ...missing } = report;
  const reordered = {
    executedAt: report.executedAt,
    smokeVersion: report.smokeVersion,
    gitSha: report.gitSha,
    runId: report.runId,
    runAttempt: report.runAttempt,
    target: report.target,
    outcome: report.outcome,
  };
  for (const invalidReport of [
    { ...report, extra: 'forbidden' },
    missing,
    reordered,
    { ...report, target: 'api' },
    { ...report, outcome: 'failed' },
  ]) {
    assert.throws(
      () => renderAuthenticatedSmokeSummary(invalidReport),
      (error) => error.message === 'Authenticated smoke report was invalid.',
    );
  }
});

test('transaction performs exactly six same-origin requests and returns no sensitive projection', async () => {
  const requests = [];
  let meCalls = 0;
  const fetchImpl = async (url, init) => {
    requests.push({
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      method: init.method ?? 'GET',
      redirect: init.redirect,
      cookie: new Headers(init.headers).get('cookie'),
      body: init.body,
      signal: init.signal,
    });
    if (url.pathname === '/login') return html('<!doctype html>');
    if (url.pathname === '/api/auth/login') {
      return json({ ok: true, data: { user: USER } }, 200, {
        'set-cookie': `${COOKIE}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict; Secure`,
      });
    }
    if (url.pathname === '/api/users/me') {
      meCalls += 1;
      return meCalls === 1
        ? json({ ok: true, data: USER })
        : json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } }, 401);
    }
    if (url.pathname === '/api/purchase-orders') {
      return json({ ok: true, data: [PURCHASE_ORDER_SUMMARY] });
    }
    if (url.pathname === '/api/auth/logout') return json({ ok: true, data: { loggedOut: true } });
    throw new Error('unexpected request');
  };

  const result = await verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN,
    password: PASSWORD,
    fetchImpl,
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result, undefined);
  assert.deepEqual(requests.map(({ pathname, method }) => [pathname, method]), [
    ['/login', 'GET'],
    ['/api/auth/login', 'POST'],
    ['/api/users/me', 'GET'],
    ['/api/purchase-orders', 'GET'],
    ['/api/auth/logout', 'POST'],
    ['/api/users/me', 'GET'],
  ]);
  assert.equal(requests.every(({ origin }) => origin === ORIGIN), true);
  assert.equal(requests.every(({ redirect }) => redirect === 'manual'), true);
  assert.equal(requests.every(({ signal }) => signal instanceof AbortSignal), true);
  assert.equal(new Set(requests.map(({ signal }) => signal)).size, 6);
  assert.equal(requests[1].body, JSON.stringify({ username: 'deployment-smoke', password: PASSWORD }));
  assert.equal(requests[2].cookie, COOKIE);
  assert.equal(requests[3].cookie, COOKIE);
  assert.equal(requests[3].search, '?q=hio-runtime-smoke-22222222-2222-4222-8222-222222222222');
  assert.equal(requests[4].cookie, COOKIE);
  assert.equal(requests[5].cookie, COOKIE);
});

function makeTransactionFetch({ path, occurrence = 1, response }) {
  const calls = [];
  const seen = new Map();
  let meCalls = 0;
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url.pathname);
      const count = (seen.get(url.pathname) ?? 0) + 1;
      seen.set(url.pathname, count);
      if (url.pathname === path && count === occurrence) return response();
      if (url.pathname === '/login') return html();
      if (url.pathname === '/api/auth/login') {
        return json({ ok: true, data: { user: USER } }, 200, {
          'set-cookie': `${COOKIE}; HttpOnly; Path=/; Secure`,
        });
      }
      if (url.pathname === '/api/users/me') {
        meCalls += 1;
        return meCalls === 1
          ? json({ ok: true, data: USER })
          : json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } }, 401);
      }
      if (url.pathname === '/api/purchase-orders') return json({ ok: true, data: [] });
      if (url.pathname === '/api/auth/logout') return json({ ok: true, data: { loggedOut: true } });
      throw new Error('unexpected');
    },
  };
}

test('every strict response boundary fails closed', async (t) => {
  const loginPageFailurePaths = ['/login'];
  const loginFailurePaths = ['/login', '/api/auth/login'];
  const loginCleanupPaths = [...loginFailurePaths, '/api/auth/logout'];
  const meCleanupPaths = [...loginFailurePaths, '/api/users/me', '/api/auth/logout'];
  const businessOrLogoutFailurePaths = [
    ...loginFailurePaths,
    '/api/users/me',
    '/api/purchase-orders',
    '/api/auth/logout',
  ];
  const revokedFailurePaths = [...businessOrLogoutFailurePaths, '/api/users/me'];
  const cases = [
    ['login page redirect', '/login', 1, () => new Response(null, { status: 302, headers: { location: '/other' } }), loginPageFailurePaths],
    ['login page non-Response', '/login', 1, () => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }) }), loginPageFailurePaths],
    ['login page wrong media type', '/login', 1, () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }), loginPageFailurePaths],
    ['login missing cookie', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } }), loginFailurePaths],
    ['login wrong cookie name', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } }, 200, { 'set-cookie': 'other=1; Path=/; Secure' }), loginFailurePaths],
    ['login redirect', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } }, 302, { 'set-cookie': `${COOKIE}; Path=/; Secure`, location: '/other' }), loginCleanupPaths],
    ['login malformed json', '/api/auth/login', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': `${COOKIE}; Path=/; Secure` } }), loginCleanupPaths],
    ['login missing user', '/api/auth/login', 1, () => json({ ok: true, data: {} }, 200, { 'set-cookie': `${COOKIE}; Path=/; Secure` }), loginCleanupPaths],
    ['login extra key', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER }, extra: true }, 200, { 'set-cookie': `${COOKIE}; Path=/; Secure` }), loginCleanupPaths],
    ['me redirect', '/api/users/me', 1, () => json({ ok: true, data: USER }, 302, { location: '/login' }), meCleanupPaths],
    ['me wrong media type', '/api/users/me', 1, () => new Response(JSON.stringify({ ok: true, data: USER }), { status: 200, headers: { 'content-type': 'application/jsonx' } }), meCleanupPaths],
    ['me malformed json', '/api/users/me', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }), meCleanupPaths],
    ['me missing data', '/api/users/me', 1, () => json({ ok: true }), meCleanupPaths],
    ['me extra key', '/api/users/me', 1, () => json({ ok: true, data: USER, extra: true }), meCleanupPaths],
    ['me wrong role', '/api/users/me', 1, () => json({ ok: true, data: { ...USER, role: 'admin' } }), meCleanupPaths],
    ['me changed id', '/api/users/me', 1, () => json({ ok: true, data: { ...USER, id: 42 } }), meCleanupPaths],
    ['business redirect', '/api/purchase-orders', 1, () => new Response(null, { status: 302, headers: { location: '/login' } }), businessOrLogoutFailurePaths],
    ['business malformed json', '/api/purchase-orders', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }), businessOrLogoutFailurePaths],
    ['business missing data', '/api/purchase-orders', 1, () => json({ ok: true }), businessOrLogoutFailurePaths],
    ['business extra key', '/api/purchase-orders', 1, () => json({ ok: true, data: [], extra: true }), businessOrLogoutFailurePaths],
    ['business error', '/api/purchase-orders', 1, () => json({ ok: false, error: { code: 'FAILED', message: 'no' } }, 500), businessOrLogoutFailurePaths],
    ['business invalid row', '/api/purchase-orders', 1, () => json({ ok: true, data: [{ id: -1 }] }), businessOrLogoutFailurePaths],
    ['logout redirect', '/api/auth/logout', 1, () => new Response(null, { status: 302, headers: { location: '/login' } }), businessOrLogoutFailurePaths],
    ['logout malformed json', '/api/auth/logout', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }), businessOrLogoutFailurePaths],
    ['logout missing data', '/api/auth/logout', 1, () => json({ ok: true }), businessOrLogoutFailurePaths],
    ['logout extra key', '/api/auth/logout', 1, () => json({ ok: true, data: { loggedOut: true, extra: true } }), businessOrLogoutFailurePaths],
    ['revoked redirect', '/api/users/me', 2, () => new Response(null, { status: 302, headers: { location: '/login' } }), revokedFailurePaths],
    ['revoked malformed json', '/api/users/me', 2, () => new Response('not-json', { status: 401, headers: { 'content-type': 'application/json' } }), revokedFailurePaths],
    ['revoked missing error', '/api/users/me', 2, () => json({ ok: false }, 401), revokedFailurePaths],
    ['revoked extra key', '/api/users/me', 2, () => json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, extra: true }, 401), revokedFailurePaths],
    ['revoked wrong code', '/api/users/me', 2, () => json({ ok: false, error: { code: 'FORBIDDEN', message: '로그인이 필요합니다.' } }, 401), revokedFailurePaths],
    ['revoked wrong status', '/api/users/me', 2, () => json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } }, 200), revokedFailurePaths],
  ];
  for (const [name, path, occurrence, response, expectedPaths] of cases) {
    await t.test(name, async () => {
      const scenario = makeTransactionFetch({ path, occurrence, response });
      await assert.rejects(
        verifyAuthenticatedBusinessTransaction({
          origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
          randomUuid: () => '22222222-2222-4222-8222-222222222222',
        }),
        (error) => error.message === 'Authenticated business transaction failed.',
      );
      assert.deepEqual(scenario.calls, expectedPaths);
      assert.equal(scenario.calls.filter((value) => value === '/api/auth/login').length <= 1, true);
      assert.equal(
        scenario.calls.filter((value) => value === '/api/auth/logout').length,
        expectedPaths.includes('/api/auth/logout') ? 1 : 0,
      );
    });
  }
});

test('business failure attempts one logout, does not retry login, and exposes no raw error', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/login') return html();
    if (url.pathname === '/api/auth/login') {
      return json({ ok: true, data: { user: USER } }, 200, {
        'set-cookie': `${COOKIE}; HttpOnly; Path=/; Secure`,
      });
    }
    if (url.pathname === '/api/users/me') return json({ ok: true, data: USER });
    if (url.pathname === '/api/purchase-orders') {
      throw new Error(`raw transport ${PASSWORD} ${COOKIE}`);
    }
    if (url.pathname === '/api/auth/logout') return json({ ok: true, data: { loggedOut: true } });
    throw new Error('unexpected');
  };
  await assert.rejects(
    verifyAuthenticatedBusinessTransaction({
      origin: ORIGIN, password: PASSWORD, fetchImpl,
      randomUuid: () => '22222222-2222-4222-8222-222222222222',
    }),
    (error) => error.message === 'Authenticated business transaction failed.'
      && !error.message.includes(PASSWORD)
      && !error.message.includes(COOKIE),
  );
  assert.deepEqual(paths, [
    '/login', '/api/auth/login', '/api/users/me',
    '/api/purchase-orders', '/api/auth/logout',
  ]);
});

test('cleanup failure remains generic and cleanup is attempted only once', async () => {
  const scenario = makeTransactionFetch({
    path: '/api/purchase-orders', occurrence: 1,
    response: () => { throw new Error(`business ${PASSWORD}`); },
  });
  const originalFetch = scenario.fetchImpl;
  scenario.fetchImpl = async (url, init) => {
    if (url.pathname === '/api/auth/logout') {
      scenario.calls.push(url.pathname);
      throw new Error(`cleanup ${COOKIE}`);
    }
    return originalFetch(url, init);
  };
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
  }), (error) => error.message === 'Authenticated business transaction failed.'
    && !error.message.includes(PASSWORD)
    && !error.message.includes(COOKIE));
  assert.equal(scenario.calls.filter((value) => value === '/api/auth/logout').length, 1);
});

test('an attempted logout is never repeated', async () => {
  const scenario = makeTransactionFetch({
    path: '/api/auth/logout', occurrence: 1,
    response: () => json({ ok: true, data: { loggedOut: false } }),
  });
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
  }));
  assert.equal(scenario.calls.filter((value) => value === '/api/auth/logout').length, 1);
});

test('multiple session cookies fail before me without comma splitting', async () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('Set-Cookie', `${COOKIE}; Path=/; Secure`);
  headers.append('Set-Cookie', 'isorder_sid=33333333-3333-4333-8333-333333333333; Path=/; Secure');
  const scenario = makeTransactionFetch({
    path: '/api/auth/login', occurrence: 1,
    response: () => new Response(JSON.stringify({ ok: true, data: { user: USER } }), { status: 200, headers }),
  });
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
  }));
  assert.deepEqual(scenario.calls, ['/login', '/api/auth/login']);
});

test('a combined ambiguous session cookie field fails closed without comma splitting', async () => {
  const combinedCookie = `${COOKIE}; Path=/, isorder_sid=33333333-3333-4333-8333-333333333333; Path=/`;
  const response = new Response(JSON.stringify({ ok: true, data: { user: USER } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': combinedCookie },
  });
  assert.deepEqual(response.headers.getSetCookie(), [combinedCookie]);
  const scenario = makeTransactionFetch({
    path: '/api/auth/login', occurrence: 1,
    response: () => response,
  });
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
  }), (error) => error.message === 'Authenticated business transaction failed.');
  assert.deepEqual(scenario.calls, ['/login', '/api/auth/login']);
});

test('invalid random sentinel fails before the first fetch', async () => {
  let fetchCalls = 0;
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    randomUuid: () => '../not-a-uuid',
  }));
  assert.equal(fetchCalls, 0);
});

test('timeout policy is bounded and an aborted request fails generically', async () => {
  let fetchCalls = 0;
  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
    requestTimeoutMs: 10_001,
  }));
  assert.equal(fetchCalls, 0);

  await assert.rejects(verifyAuthenticatedBusinessTransaction({
    origin: ORIGIN, password: PASSWORD,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      // Keep node:test alive long enough for AbortSignal.timeout() to fire.
      const keepAlive = setTimeout(() => {}, 100);
      signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    }),
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
    requestTimeoutMs: 1,
  }), (error) => error.message === 'Authenticated business transaction failed.');
});

test('runner verifies once, ignores transaction output, then emits only safe evidence', async () => {
  const events = [];
  const report = await runAuthenticatedBusinessSmoke({
    env: { ...BASE_ENV, AMBIENT_VALUE: 'ignored' },
    now: () => new Date(REPORT_INPUT.executedAt),
    verifyTransaction: async ({
      origin,
      password,
      fetchImpl,
      randomUuid,
      requestTimeoutMs,
    }) => {
      assert.equal(origin, ORIGIN);
      assert.equal(password, PASSWORD);
      assert.equal(typeof fetchImpl, 'function');
      assert.equal(typeof randomUuid, 'function');
      assert.equal(requestTimeoutMs, 10_000);
      events.push(['transaction']);
      return {
        password: PASSWORD,
        cookie: COOKIE,
        origin: ORIGIN,
        row: PURCHASE_ORDER_SUMMARY,
      };
    },
    appendSummary: async (summaryPath, contents) => {
      assert.equal(summaryPath, BASE_ENV.GITHUB_STEP_SUMMARY);
      events.push(['summary', contents]);
    },
    log: async (contents) => events.push(['log', contents]),
  });

  assert.deepEqual(events.map(([kind]) => kind), ['transaction', 'summary', 'log']);
  assert.deepEqual(report, {
    smokeVersion: AUTHENTICATED_SMOKE_VERSION,
    ...REPORT_INPUT,
    target: 'web',
    outcome: 'verified',
  });
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(JSON.parse(events[2][1]), report);
  const evidence = JSON.stringify({ events, report });
  for (const forbidden of [
    PASSWORD,
    COOKIE,
    ORIGIN,
    'deployment-smoke',
    'hio-runtime-smoke',
    'Sentinel collision',
    '/api/',
  ]) {
    assert.equal(evidence.includes(forbidden), false);
  }
});

test('invalid environment fails before transaction and every output dependency', async () => {
  const calls = [];
  await assert.rejects(runAuthenticatedBusinessSmoke({
    env: { ...BASE_ENV, GITHUB_SHA: 'A'.repeat(40) },
    verifyTransaction: async () => calls.push('transaction'),
    now: () => {
      calls.push('now');
      return new Date(REPORT_INPUT.executedAt);
    },
    appendSummary: async () => calls.push('summary'),
    log: async () => calls.push('log'),
  }), (error) => error.message === 'Authenticated business smoke failed.'
    && !error.message.includes(PASSWORD)
    && !error.message.includes(ORIGIN));
  assert.deepEqual(calls, []);
});

test('raw verify, now, summary, or log errors stay generic without a success log', async (t) => {
  const rawFailure = `${PASSWORD} ${COOKIE} ${ORIGIN} raw row`;
  const cases = [
    ['verify', {
      verifyTransaction: async () => { throw new Error(rawFailure); },
    }],
    ['now throws', {
      verifyTransaction: async () => {},
      now: () => { throw new Error(rawFailure); },
    }],
    ['now returns invalid date', {
      verifyTransaction: async () => {},
      now: () => new Date('not-a-date'),
    }],
    ['summary', {
      verifyTransaction: async () => {},
      now: () => new Date(REPORT_INPUT.executedAt),
      appendSummary: async () => { throw new Error(rawFailure); },
    }],
    ['log', {
      verifyTransaction: async () => {},
      now: () => new Date(REPORT_INPUT.executedAt),
      appendSummary: async () => {},
      log: async () => { throw new Error(rawFailure); },
    }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const logs = [];
      await assert.rejects(runAuthenticatedBusinessSmoke({
        env: BASE_ENV,
        appendSummary: async () => {},
        log: async (contents) => logs.push(contents),
        ...overrides,
      }), (error) => error.message === 'Authenticated business smoke failed.'
        && !error.message.includes(PASSWORD)
        && !error.message.includes(COOKIE)
        && !error.message.includes(ORIGIN)
        && !error.message.includes('raw row')
        && !error.message.includes('Invalid time value'));
      assert.deepEqual(logs, []);
    });
  }
});

test('CLI rejects arguments before fetch and emits no summary or sensitive output', () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'hio-authenticated-smoke-'));
  const summaryPath = path.join(temporaryDirectory, 'summary.md');
  const fetchMarkerPath = path.join(temporaryDirectory, 'fetch-called');
  const preloadPath = path.join(temporaryDirectory, 'preload.mjs');
  const scriptPath = fileURLToPath(
    new URL('./authenticated-business-smoke.mjs', import.meta.url),
  );
  writeFileSync(preloadPath, [
    "import { appendFileSync } from 'node:fs';",
    'globalThis.fetch = async () => {',
    "  appendFileSync(process.env.AUTHENTICATED_SMOKE_FETCH_MARKER, 'called\\n');",
    "  throw new Error('raw fetch failure');",
    '};',
    '',
  ].join('\n'), 'utf8');

  try {
    for (const args of [['unexpected'], ['one', 'two']]) {
      rmSync(summaryPath, { force: true });
      rmSync(fetchMarkerPath, { force: true });
      const result = spawnSync(process.execPath, [scriptPath, ...args], {
        env: {
          ...process.env,
          ...BASE_ENV,
          GITHUB_STEP_SUMMARY: summaryPath,
          AUTHENTICATED_SMOKE_FETCH_MARKER: fetchMarkerPath,
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
          NODE_NO_WARNINGS: '1',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Authenticated business smoke failed.\n');
      assert.equal(existsSync(summaryPath), false);
      assert.equal(existsSync(fetchMarkerPath), false);
      for (const forbidden of [PASSWORD, COOKIE, ORIGIN, ...args]) {
        assert.equal(`${result.stdout}${result.stderr}`.includes(forbidden), false);
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
