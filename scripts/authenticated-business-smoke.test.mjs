import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
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
    if (url.pathname === '/login') return new Response('<!doctype html>', { status: 200 });
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
    if (url.pathname === '/api/purchase-orders') return json({ ok: true, data: [] });
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
      if (url.pathname === '/login') return new Response('ok', { status: 200 });
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
  const cases = [
    ['login page redirect', '/login', 1, () => new Response(null, { status: 302, headers: { location: '/other' } })],
    ['login missing cookie', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } })],
    ['login wrong cookie name', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } }, 200, { 'set-cookie': 'other=1; Path=/; Secure' })],
    ['login redirect', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER } }, 302, { 'set-cookie': `${COOKIE}; Path=/; Secure`, location: '/other' })],
    ['login malformed json', '/api/auth/login', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': `${COOKIE}; Path=/; Secure` } })],
    ['login missing user', '/api/auth/login', 1, () => json({ ok: true, data: {} }, 200, { 'set-cookie': `${COOKIE}; Path=/; Secure` })],
    ['login extra key', '/api/auth/login', 1, () => json({ ok: true, data: { user: USER }, extra: true }, 200, { 'set-cookie': `${COOKIE}; Path=/; Secure` })],
    ['me redirect', '/api/users/me', 1, () => json({ ok: true, data: USER }, 302, { location: '/login' })],
    ['me wrong media type', '/api/users/me', 1, () => new Response(JSON.stringify({ ok: true, data: USER }), { status: 200, headers: { 'content-type': 'application/jsonx' } })],
    ['me malformed json', '/api/users/me', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['me missing data', '/api/users/me', 1, () => json({ ok: true })],
    ['me extra key', '/api/users/me', 1, () => json({ ok: true, data: USER, extra: true })],
    ['me wrong role', '/api/users/me', 1, () => json({ ok: true, data: { ...USER, role: 'admin' } })],
    ['me changed id', '/api/users/me', 1, () => json({ ok: true, data: { ...USER, id: 42 } })],
    ['business redirect', '/api/purchase-orders', 1, () => new Response(null, { status: 302, headers: { location: '/login' } })],
    ['business malformed json', '/api/purchase-orders', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['business missing data', '/api/purchase-orders', 1, () => json({ ok: true })],
    ['business extra key', '/api/purchase-orders', 1, () => json({ ok: true, data: [], extra: true })],
    ['business error', '/api/purchase-orders', 1, () => json({ ok: false, error: { code: 'FAILED', message: 'no' } }, 500)],
    ['business invalid row', '/api/purchase-orders', 1, () => json({ ok: true, data: [{ id: -1 }] })],
    ['logout redirect', '/api/auth/logout', 1, () => new Response(null, { status: 302, headers: { location: '/login' } })],
    ['logout malformed json', '/api/auth/logout', 1, () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['logout missing data', '/api/auth/logout', 1, () => json({ ok: true })],
    ['logout extra key', '/api/auth/logout', 1, () => json({ ok: true, data: { loggedOut: true, extra: true } })],
    ['revoked redirect', '/api/users/me', 2, () => new Response(null, { status: 302, headers: { location: '/login' } })],
    ['revoked malformed json', '/api/users/me', 2, () => new Response('not-json', { status: 401, headers: { 'content-type': 'application/json' } })],
    ['revoked missing error', '/api/users/me', 2, () => json({ ok: false }, 401)],
    ['revoked extra key', '/api/users/me', 2, () => json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, extra: true }, 401)],
    ['revoked wrong code', '/api/users/me', 2, () => json({ ok: false, error: { code: 'FORBIDDEN', message: '로그인이 필요합니다.' } }, 401)],
    ['revoked wrong status', '/api/users/me', 2, () => json({ ok: false, error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } }, 200)],
  ];
  for (const [name, path, occurrence, response] of cases) {
    await t.test(name, async () => {
      const scenario = makeTransactionFetch({ path, occurrence, response });
      await assert.rejects(
        verifyAuthenticatedBusinessTransaction({
          origin: ORIGIN, password: PASSWORD, fetchImpl: scenario.fetchImpl,
          randomUuid: () => '22222222-2222-4222-8222-222222222222',
        }),
        (error) => error.message === 'Authenticated business transaction failed.',
      );
      assert.equal(scenario.calls.filter((value) => value === '/api/auth/login').length <= 1, true);
    });
  }
});

test('business failure attempts one logout, does not retry login, and exposes no raw error', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/login') return new Response('ok', { status: 200 });
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
  assert.equal(scenario.calls.includes('/api/users/me'), false);
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
