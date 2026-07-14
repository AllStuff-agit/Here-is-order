# Wave 1B-S2 Authenticated Business Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every main deployment prove the real same-origin login, current-user, purchase-order read, logout, and revoked-session path using the already-provisioned fixed production identity.

**Architecture:** One Node Module owns the strict production origin/environment contract, one non-retrying authenticated HTTP transaction, redacted evidence, and its CLI adapter. It reuses the S1 identity constants and the shared purchase-order runtime schema. The existing `deploy-web` job installs root dependencies and runs this gate only after exact-version verification and public proxy smoke.

**Tech Stack:** Node.js 22.23.1 fetch/`Headers.getSetCookie()`, Node test runner, Zod runtime contracts from `@here-is-order/http-contract`, GitHub Actions, Cloudflare web/API Workers.

## Global Constraints

- S1 must already be merged, publicly deployed, and production `provision` evidence must be `production-smoke-identity-operation-v1` / `completed` before creating the S2 branch.
- Start S2 from the updated clean `main` in a new isolated worktree; do not continue on the merged S1 worktree branch.
- Reuse `SMOKE_IDENTITY` and `validateSmokeIdentityPassword` from `scripts/smoke-identity-contract.mjs`; do not duplicate identity or password policy.
- Accept only canonical four-label Workers origins whose hostname is `hereisorder-web`, one nonempty account label, `workers`, `dev`, with no credentials, port, path, query, hash, or trailing slash.
- Valid CLI invocation has zero arguments and runs only for main `push` or main `workflow_dispatch` in GitHub Actions.
- Execute exactly login page → login → current user → purchase-order read → logout → old-cookie 401; do not retry after login.
- Every request uses `redirect: 'manual'` and a fresh 10-second `AbortSignal.timeout`.
- Read the login cookie only with Node 22 `Headers.getSetCookie()`; do not comma-split `set-cookie`.
- Business response uses `decodeApiEnvelope(purchaseOrderSummaryListSchema, body)` and must be a success envelope.
- Password, cookie, identity projection, sentinel, URL, response header/body, business row/count, and raw error never enter logs, summaries, artifacts, or thrown public errors.
- Authenticated smoke step receives no Cloudflare credential, username, cookie, CLI endpoint, or failure bypass.
- No application route, D1 schema, identity lifecycle, authorization role, business write, automatic rollback, or D1 restore change is in S2.

---

## File Responsibility Map

- Create `scripts/authenticated-business-smoke.mjs`: exact origin/environment parsing, six-request transaction, cleanup, whitelist report/summary, and zero-argument CLI.
- Create `scripts/authenticated-business-smoke.test.mjs`: origin, cookie, identity, runtime schema, cleanup/no-retry, environment, evidence, and redaction tests.
- Modify `.github/workflows/deploy-worker.yml`: install root dependencies in `deploy-web` and add the required authenticated gate after public smoke.
- Modify `scripts/deploy-workflow.test.mjs`: lock dependency order, gate order, exact secret scope, and no-bypass behavior.
- Modify `README.md`: list the final automatic deployment sequence and secret.
- Modify `docs/design/cloudflare-deploy-guide.md`: evidence, failure phase, orphan-session recovery, and rotation/disable link.
- Modify `scripts/delivery-recovery-docs.test.mjs`: lock the authenticated gate and runbook.

---

### Task 0: Establish the S2 handoff and isolated worktree

**Files:**

- Verify only in `/home/ubuntu/workspace/projects/Here-is-order`; then create `.worktrees/wave-1b-authenticated-smoke-gate`.

**Interfaces:**

- Consumes: merged S1 `main` and one successful exact provision report.
- Produces: clean branch `feat/wave-1b-authenticated-smoke-gate` in its own worktree.

- [ ] **Step 1: Verify clean synchronized main and exact S1 provision evidence**

Use `superpowers:using-git-worktrees`, then run:

```bash
set -euo pipefail
cd /home/ubuntu/workspace/projects/Here-is-order
test -z "$(git status --porcelain)"
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
provision_run_id=''
while read -r run_id; do
  if gh run view "$run_id" --log | rg '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"provision","outcome":"completed"\}' >/dev/null; then
    provision_run_id="$run_id"
    break
  fi
done < <(gh run list --workflow manage-smoke-identity.yml --branch main \
  --event workflow_dispatch --status success --limit 20 \
  --json databaseId --jq '.[].databaseId')
test -n "$provision_run_id"
```

Expected: main is clean and byte-identical to `origin/main`, and one recent successful lifecycle run contains the exact create-only provision report. Do not inspect raw D1 state.

- [ ] **Step 2: Create and enter the isolated S2 worktree**

```bash
set -euo pipefail
cd /home/ubuntu/workspace/projects/Here-is-order
git check-ignore -q .worktrees
test ! -e .worktrees/wave-1b-authenticated-smoke-gate
git worktree add .worktrees/wave-1b-authenticated-smoke-gate \
  -b feat/wave-1b-authenticated-smoke-gate main
git -C .worktrees/wave-1b-authenticated-smoke-gate status --short --branch
```

Expected: output is only `## feat/wave-1b-authenticated-smoke-gate`; all following S2 task commands run with that worktree as their working directory.

---

### Task 1: Implement the non-retrying authenticated business transaction

**Files:**

- Create: `scripts/authenticated-business-smoke.mjs`
- Test: `scripts/authenticated-business-smoke.test.mjs`

**Interfaces:**

- Consumes: S1 `SMOKE_IDENTITY`, `validateSmokeIdentityPassword`; shared `decodeApiEnvelope`, `purchaseOrderSummaryListSchema`, and `apiErrorEnvelopeSchema`.
- Produces: `validateAuthenticatedSmokeOrigin(value)` and `verifyAuthenticatedBusinessTransaction({ origin, password, fetchImpl, randomUuid, requestTimeoutMs }) -> Promise<void>`.

- [ ] **Step 1: Write the failing happy-path and origin tests**

```js
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/authenticated-business-smoke.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement strict origin, response, identity, and cookie helpers**

```js
import { randomUUID } from 'node:crypto';

import {
  apiErrorEnvelopeSchema,
  decodeApiEnvelope,
} from '@here-is-order/http-contract/envelope';
import {
  purchaseOrderSummaryListSchema,
} from '@here-is-order/http-contract/purchase-orders';
import {
  SMOKE_IDENTITY,
  validateSmokeIdentityPassword,
} from './smoke-identity-contract.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateAuthenticatedSmokeOrigin(value) {
  try {
    if (typeof value !== 'string') throw new Error('invalid');
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:'
      || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash
      || value !== url.origin
      || labels.length !== 4
      || labels[0] !== 'hereisorder-web'
      || labels[1].length === 0
      || labels[2] !== 'workers'
      || labels[3] !== 'dev') {
      throw new Error('invalid');
    }
    return url;
  } catch {
    throw new Error('Authenticated smoke origin was invalid.');
  }
}

async function exactJson(response) {
  const mediaType = response instanceof Response
    ? response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    : null;
  if (!(response instanceof Response)
    || mediaType !== 'application/json') {
    throw new Error('invalid response');
  }
  return response.json();
}

function parseIdentity(value) {
  if (!exactKeys(value, ['id', 'username', 'name', 'role'])
    || !Number.isSafeInteger(value.id)
    || value.id <= 0
    || value.username !== SMOKE_IDENTITY.username
    || value.name !== SMOKE_IDENTITY.name
    || value.role !== SMOKE_IDENTITY.role) {
    throw new Error('invalid identity');
  }
  return Object.freeze({ ...value });
}

function optionalSessionCookie(response) {
  const values = response.headers.getSetCookie();
  const matching = values.filter((value) => value.startsWith('isorder_sid='));
  if (matching.length === 0) return null;
  if (matching.length !== 1) throw new Error('invalid cookie');
  const pair = matching[0].split(';', 1)[0];
  if (!/^isorder_sid=[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(pair)) {
    throw new Error('invalid cookie');
  }
  return pair;
}
```

- [ ] **Step 4: Write failing strictness, cleanup, and no-retry tests**


Add this response factory and exact table. Each override is used once; after a cookie is acquired the expected cleanup logout may add one final request.

```js
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
```

Use this exact cleanup assertion as the central regression test:

```js
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
```

Add these two exact edge tests:

```js
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
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    randomUuid: () => '22222222-2222-4222-8222-222222222222',
    requestTimeoutMs: 1,
  }), (error) => error.message === 'Authenticated business transaction failed.');
});
```

- [ ] **Step 5: Run the complete transaction suite and verify RED**

Run: `node --test scripts/authenticated-business-smoke.test.mjs`

Expected: FAIL because `verifyAuthenticatedBusinessTransaction` is not exported yet. The happy-path, strict response matrix, cleanup, cookie, origin, and sentinel cases all exist before the transaction state machine is implemented.

- [ ] **Step 6: Implement the exact transaction and cleanup state machine**


```js
async function fetchOnce(fetchImpl, url, { method = 'GET', headers, body, timeoutMs }) {
  return fetchImpl(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function requireLogout(fetchImpl, baseUrl, cookie, timeoutMs) {
  const response = await fetchOnce(fetchImpl, new URL('/api/auth/logout', baseUrl), {
    method: 'POST', headers: { Cookie: cookie }, timeoutMs,
  });
  const body = await exactJson(response);
  if (response.status !== 200
    || !exactKeys(body, ['ok', 'data'])
    || body.ok !== true
    || !exactKeys(body.data, ['loggedOut'])
    || body.data.loggedOut !== true) {
    throw new Error('invalid logout');
  }
}

export async function verifyAuthenticatedBusinessTransaction({
  origin,
  password,
  fetchImpl = fetch,
  randomUuid = randomUUID,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let cookie = null;
  let logoutAttempted = false;
  let failed = false;
  let cleanupFailed = false;
  try {
    const baseUrl = validateAuthenticatedSmokeOrigin(origin);
    validateSmokeIdentityPassword(password);
    if (typeof fetchImpl !== 'function'
      || typeof randomUuid !== 'function'
      || !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1
      || requestTimeoutMs > 10_000) {
      throw new Error('invalid dependencies');
    }
    const sentinelUuid = randomUuid();
    if (!UUID_PATTERN.test(sentinelUuid)) throw new Error('invalid sentinel');

    const page = await fetchOnce(fetchImpl, new URL('/login', baseUrl), {
      timeoutMs: requestTimeoutMs,
    });
    if (page.status !== 200) throw new Error('invalid login page');

    const login = await fetchOnce(fetchImpl, new URL('/api/auth/login', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SMOKE_IDENTITY.username, password }),
      timeoutMs: requestTimeoutMs,
    });
    cookie = optionalSessionCookie(login);
    const loginBody = await exactJson(login);
    if (login.status !== 200
      || cookie === null
      || !exactKeys(loginBody, ['ok', 'data'])
      || loginBody.ok !== true
      || !exactKeys(loginBody.data, ['user'])) {
      throw new Error('invalid login');
    }
    const loginUser = parseIdentity(loginBody.data.user);

    const me = await fetchOnce(fetchImpl, new URL('/api/users/me', baseUrl), {
      headers: { Cookie: cookie }, timeoutMs: requestTimeoutMs,
    });
    const meBody = await exactJson(me);
    if (me.status !== 200 || !exactKeys(meBody, ['ok', 'data']) || meBody.ok !== true) {
      throw new Error('invalid me');
    }
    const meUser = parseIdentity(meBody.data);
    if (meUser.id !== loginUser.id) throw new Error('identity changed');

    const businessUrl = new URL('/api/purchase-orders', baseUrl);
    businessUrl.searchParams.set('q', `hio-runtime-smoke-${sentinelUuid}`);
    const business = await fetchOnce(fetchImpl, businessUrl, {
      headers: { Cookie: cookie }, timeoutMs: requestTimeoutMs,
    });
    const businessBody = await exactJson(business);
    const businessEnvelope = decodeApiEnvelope(
      purchaseOrderSummaryListSchema,
      businessBody,
    );
    if (business.status !== 200 || businessEnvelope.ok !== true) {
      throw new Error('invalid business read');
    }

    logoutAttempted = true;
    await requireLogout(fetchImpl, baseUrl, cookie, requestTimeoutMs);

    const revoked = await fetchOnce(fetchImpl, new URL('/api/users/me', baseUrl), {
      headers: { Cookie: cookie }, timeoutMs: requestTimeoutMs,
    });
    const revokedBody = apiErrorEnvelopeSchema.parse(await exactJson(revoked));
    if (revoked.status !== 401
      || revokedBody.error.code !== 'UNAUTHORIZED'
      || revokedBody.error.message !== '로그인이 필요합니다.') {
      throw new Error('session not revoked');
    }
  } catch {
    failed = true;
  } finally {
    if (cookie !== null && !logoutAttempted) {
      logoutAttempted = true;
      try {
        await requireLogout(
          fetchImpl,
          validateAuthenticatedSmokeOrigin(origin),
          cookie,
          requestTimeoutMs,
        );
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (failed || cleanupFailed) {
    throw new Error('Authenticated business transaction failed.');
  }
}
```

The `finally` block deliberately does not retry a logout that was already attempted, even if its response or the revoked-session check failed.

- [ ] **Step 7: Run transaction tests and verify GREEN**


Run: `node --test scripts/authenticated-business-smoke.test.mjs`

Expected: all transaction/origin/cleanup tests pass, zero retry occurs after login, and no failure contains test secrets.
- [ ] **Step 8: Commit the transaction engine**

```bash
git add scripts/authenticated-business-smoke.mjs scripts/authenticated-business-smoke.test.mjs
git commit -m "feat: verify authenticated business transaction"
```

---

### Task 2: Add strict CI environment and redacted evidence

**Files:**

- Modify: `scripts/authenticated-business-smoke.mjs`
- Modify: `scripts/authenticated-business-smoke.test.mjs`

**Interfaces:**

- Consumes: Task 1 `verifyAuthenticatedBusinessTransaction`.
- Produces: `AUTHENTICATED_SMOKE_VERSION`, `parseAuthenticatedSmokeEnvironment(env)`, `buildAuthenticatedSmokeReport(input)`, `renderAuthenticatedSmokeSummary(report)`, `runAuthenticatedBusinessSmoke(options)`, and zero-argument CLI.

- [ ] **Step 1: Write failing environment and report tests**

```js
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AUTHENTICATED_SMOKE_VERSION,
  buildAuthenticatedSmokeReport,
  parseAuthenticatedSmokeEnvironment,
  renderAuthenticatedSmokeSummary,
  runAuthenticatedBusinessSmoke,
} from './authenticated-business-smoke.mjs';

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

test('environment accepts only main push/dispatch and the fixed web origin', () => {
  const parsed = parseAuthenticatedSmokeEnvironment(BASE_ENV);
  assert.equal(parsed.origin, ORIGIN);
  assert.equal(parsed.password, PASSWORD);
  assert.equal(parsed.runAttempt, 2);
  assert.doesNotThrow(() => parseAuthenticatedSmokeEnvironment({
    ...BASE_ENV, GITHUB_EVENT_NAME: 'workflow_dispatch',
  }));
  for (const patch of [
    { CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_SHA: 'short' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_STEP_SUMMARY: 'relative.md' }, { DEPLOYMENT_URL: 'https://evil.example' },
    { PRODUCTION_SMOKE_PASSWORD: 'short' },
  ]) {
    assert.throws(() => parseAuthenticatedSmokeEnvironment({ ...BASE_ENV, ...patch }));
  }
});

test('report and summary expose only the exact whitelist', () => {
  const report = buildAuthenticatedSmokeReport({
    executedAt: '2026-07-13T19:00:00.000Z',
    gitSha: 'a'.repeat(40),
    runId: '12345',
    runAttempt: 2,
  });
  assert.equal(AUTHENTICATED_SMOKE_VERSION, 'authenticated-business-smoke-v1');
  assert.deepEqual(report, {
    smokeVersion: 'authenticated-business-smoke-v1',
    executedAt: '2026-07-13T19:00:00.000Z',
    gitSha: 'a'.repeat(40),
    runId: '12345',
    runAttempt: 2,
    target: 'web',
    outcome: 'verified',
  });
  const summary = renderAuthenticatedSmokeSummary(report);
  assert.match(summary, /^## Authenticated business smoke\n/);
  for (const forbidden of ['deployment-smoke', PASSWORD, COOKIE, ORIGIN, 'purchase-orders']) {
    assert.equal(summary.includes(forbidden), false);
  }
});
```

- [ ] **Step 2: Run the new focused cases and verify RED**

Run: `node --test --test-name-pattern='environment|report|summary' scripts/authenticated-business-smoke.test.mjs`

Expected: FAIL because the CI/report exports do not exist.

- [ ] **Step 3: Implement exact environment and report validation**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTHENTICATED_SMOKE_VERSION = 'authenticated-business-smoke-v1';
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const REPORT_KEYS = [
  'smokeVersion', 'executedAt', 'gitSha', 'runId',
  'runAttempt', 'target', 'outcome',
];

export function parseAuthenticatedSmokeEnvironment(env) {
  try {
    const runAttempt = Number(env?.GITHUB_RUN_ATTEMPT);
    if (!env
      || env.CI !== 'true'
      || env.GITHUB_ACTIONS !== 'true'
      || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      || env.GITHUB_REF !== 'refs/heads/main'
      || !GIT_SHA_PATTERN.test(env.GITHUB_SHA)
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ID)
      || !RUN_ID_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
      || !Number.isSafeInteger(runAttempt)
      || runAttempt < 1
      || !path.isAbsolute(env.GITHUB_STEP_SUMMARY)
      || path.normalize(env.GITHUB_STEP_SUMMARY) !== env.GITHUB_STEP_SUMMARY) {
      throw new Error('invalid environment');
    }
    return Object.freeze({
      origin: validateAuthenticatedSmokeOrigin(env.DEPLOYMENT_URL).origin,
      password: validateSmokeIdentityPassword(env.PRODUCTION_SMOKE_PASSWORD),
      gitSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt,
      summaryPath: env.GITHUB_STEP_SUMMARY,
    });
  } catch {
    throw new Error('Authenticated smoke environment was invalid.');
  }
}

export function buildAuthenticatedSmokeReport({ executedAt, gitSha, runId, runAttempt }) {
  if (typeof executedAt !== 'string'
    || new Date(executedAt).toISOString() !== executedAt
    || !GIT_SHA_PATTERN.test(gitSha)
    || !RUN_ID_PATTERN.test(runId)
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1) {
    throw new Error('Authenticated smoke report was invalid.');
  }
  return Object.freeze({
    smokeVersion: AUTHENTICATED_SMOKE_VERSION,
    executedAt,
    gitSha,
    runId,
    runAttempt,
    target: 'web',
    outcome: 'verified',
  });
}

export function renderAuthenticatedSmokeSummary(report) {
  if (!report
    || Object.keys(report).join(',') !== REPORT_KEYS.join(',')
    || report.smokeVersion !== AUTHENTICATED_SMOKE_VERSION
    || report.target !== 'web'
    || report.outcome !== 'verified') {
    throw new Error('Authenticated smoke report was invalid.');
  }
  buildAuthenticatedSmokeReport(report);
  return `## Authenticated business smoke\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}
```

- [ ] **Step 4: Write failing runner redaction and ordering tests**

```js
test('runner verifies transaction, appends summary, then emits one safe report', async () => {
  const events = [];
  const report = await runAuthenticatedBusinessSmoke({
    env: BASE_ENV,
    now: () => new Date('2026-07-13T19:00:00.000Z'),
    verifyTransaction: async ({ origin, password }) => {
      assert.equal(origin, ORIGIN);
      assert.equal(password, PASSWORD);
      events.push(['transaction']);
    },
    appendSummary: async (_path, contents) => events.push(['summary', contents]),
    log: async (contents) => events.push(['log', contents]),
  });
  assert.deepEqual(events.map(([kind]) => kind), ['transaction', 'summary', 'log']);
  assert.equal(report.outcome, 'verified');
  const evidence = JSON.stringify({ events, report });
  for (const forbidden of [PASSWORD, COOKIE, ORIGIN, 'deployment-smoke']) {
    assert.equal(evidence.includes(forbidden), false);
  }
});

test('raw transaction or summary errors become one generic failure and never log success', async () => {
  const logs = [];
  await assert.rejects(runAuthenticatedBusinessSmoke({
    env: BASE_ENV,
    verifyTransaction: async () => { throw new Error(`${PASSWORD} ${COOKIE} raw row`); },
    appendSummary: async () => {},
    log: async (value) => logs.push(value),
  }), (error) => error.message === 'Authenticated business smoke failed.');
  assert.deepEqual(logs, []);

  await assert.rejects(runAuthenticatedBusinessSmoke({
    env: BASE_ENV,
    verifyTransaction: async () => {},
    appendSummary: async () => { throw new Error(`summary ${PASSWORD}`); },
    log: async (value) => logs.push(value),
  }), (error) => error.message === 'Authenticated business smoke failed.');
  assert.deepEqual(logs, []);
});

test('CLI rejects every argument before environment use with exact redacted stderr', () => {
  const scriptPath = fileURLToPath(
    new URL('./authenticated-business-smoke.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [scriptPath, 'unexpected'], {
    env: { ...process.env, ...BASE_ENV, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Authenticated business smoke failed.\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(PASSWORD), false);
});
```

- [ ] **Step 5: Implement runner and zero-argument CLI**

```js
export async function runAuthenticatedBusinessSmoke({
  env = process.env,
  fetchImpl = fetch,
  randomUuid = randomUUID,
  now = () => new Date(),
  verifyTransaction = verifyAuthenticatedBusinessTransaction,
  appendSummary = (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8'),
  log = (contents) => console.log(contents),
} = {}) {
  try {
    const environment = parseAuthenticatedSmokeEnvironment(env);
    await verifyTransaction({
      origin: environment.origin,
      password: environment.password,
      fetchImpl,
      randomUuid,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const currentTime = now();
    const report = buildAuthenticatedSmokeReport({
      executedAt: currentTime.toISOString(),
      gitSha: environment.gitSha,
      runId: environment.runId,
      runAttempt: environment.runAttempt,
    });
    await appendSummary(environment.summaryPath, renderAuthenticatedSmokeSummary(report));
    await log(JSON.stringify(report));
    return report;
  } catch {
    throw new Error('Authenticated business smoke failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const invocation = process.argv.slice(2).length === 0
    ? runAuthenticatedBusinessSmoke()
    : Promise.reject(new Error('invalid arguments'));
  invocation.catch(() => {
    console.error('Authenticated business smoke failed.');
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Run all authenticated smoke tests and verify GREEN**

Run: `node --test scripts/authenticated-business-smoke.test.mjs`

Expected: all origin/transaction/cleanup/environment/report/runner cases pass with no secret or raw response in output.

- [ ] **Step 7: Commit the CI adapter and evidence**

```bash
git add scripts/authenticated-business-smoke.mjs scripts/authenticated-business-smoke.test.mjs
git commit -m "feat: emit redacted authenticated smoke evidence"
```

---

### Task 3: Gate the verified web deployment on authenticated smoke

**Files:**

- Modify: `.github/workflows/deploy-worker.yml:204-257`
- Modify: `scripts/deploy-workflow.test.mjs`

**Interfaces:**

- Consumes: Task 2 zero-argument CLI and existing verified web deployment URL.
- Produces: required final `deploy-web` step with the repository password secret and no Cloudflare credential.

- [ ] **Step 1: Write the failing workflow contract tests**

```js
test('deploy-web installs both root and frontend locked dependencies', () => {
  const web = jobBlocks(workflow).find(({ name }) => name === 'deploy-web')?.body ?? '';
  const setup = listItemBlocks(web).find((block) => block.includes('uses: actions/setup-node@')) ?? '';
  assert.match(setup, /cache-dependency-path: \|\n\s+package-lock\.json\n\s+frontend\/package-lock\.json/);
  const commands = [...web.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1].trim());
  const rootIndex = commands.indexOf('npm ci');
  const frontendIndex = commands.indexOf('npm ci --prefix frontend');
  const buildIndex = commands.indexOf('npm run build:cloudflare --prefix frontend');
  assert.notEqual(rootIndex, -1);
  assert.notEqual(frontendIndex, -1);
  assert.notEqual(buildIndex, -1);
  assert.ok(rootIndex < frontendIndex);
  assert.ok(frontendIndex < buildIndex);
});

test('authenticated smoke is a required final gate after public proxy smoke', () => {
  const web = jobBlocks(workflow).find(({ name }) => name === 'deploy-web')?.body ?? '';
  const publicSmoke = listItemBlocks(web)
    .find((block) => block.includes('name: Smoke test web deployment and API proxy')) ?? '';
  const authenticated = listItemBlocks(web)
    .find((block) => block.includes('name: Smoke test authenticated business flow')) ?? '';
  assert.ok(publicSmoke);
  assert.ok(authenticated);
  assert.ok(web.indexOf(publicSmoke) < web.indexOf(authenticated));
  assert.match(authenticated, /^\s+run: node scripts\/authenticated-business-smoke\.mjs$/m);
  assert.match(authenticated, /DEPLOYMENT_URL: \$\{\{ steps\.verify-web\.outputs\.deployment-url \}\}/);
  assert.match(authenticated, /PRODUCTION_SMOKE_PASSWORD: \$\{\{ secrets\.PRODUCTION_SMOKE_PASSWORD \}\}/);
  assert.doesNotMatch(authenticated, /^\s+if:/m);
  assert.doesNotMatch(authenticated, /CLOUDFLARE_|username|cookie|continue-on-error|always\(|failure\(|\|\|\s*true/);
  const envKeys = [...authenticated.matchAll(/^\s{10}([A-Z][A-Z0-9_]+):/gm)]
    .map((match) => match[1]);
  assert.deepEqual(envKeys, ['DEPLOYMENT_URL', 'PRODUCTION_SMOKE_PASSWORD']);
  assert.doesNotMatch(workflow, /^env:/m);
  assert.doesNotMatch(web, /^    env:/m);
  const steps = listItemBlocks(web);
  assert.equal(steps.at(-1), authenticated);
  assert.equal((workflow.match(/secrets\.PRODUCTION_SMOKE_PASSWORD/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test scripts/deploy-workflow.test.mjs`

Expected: the new dependency/gate assertions fail.

- [ ] **Step 3: Install root dependencies in the clean deploy-web job**

Change the `actions/setup-node` cache block to:

```yaml
          cache-dependency-path: |
            package-lock.json
            frontend/package-lock.json
```

Add this static step before the existing frontend install:

```yaml
      - name: Install deployment dependencies
        run: npm ci
```

Keep the existing `npm ci --prefix frontend`. Root installation is required because the root Node script imports the root file dependency `@here-is-order/http-contract`; Node ESM does not resolve it from `frontend/node_modules`.

- [ ] **Step 4: Add the required authenticated step after public smoke**

```yaml
      - name: Smoke test authenticated business flow
        env:
          DEPLOYMENT_URL: ${{ steps.verify-web.outputs.deployment-url }}
          PRODUCTION_SMOKE_PASSWORD: ${{ secrets.PRODUCTION_SMOKE_PASSWORD }}
        run: node scripts/authenticated-business-smoke.mjs
```

Do not add `if`, `continue-on-error`, Cloudflare credentials, username, cookie, CLI argument, artifact upload, or fallback behavior.

- [ ] **Step 5: Run deployment and root contract tests**

Run: `node --test scripts/deploy-workflow.test.mjs scripts/authenticated-business-smoke.test.mjs`

Expected: all selected tests pass.

Run: `npm test`

Expected: all root Node and Vitest tests pass.

- [ ] **Step 6: Commit the required deployment gate**

```bash
git add .github/workflows/deploy-worker.yml scripts/deploy-workflow.test.mjs
git commit -m "ci: gate deployment on authenticated business smoke"
```

---

### Task 4: Document final evidence and recovery phases

**Files:**

- Modify: `README.md:123-150`
- Modify: `docs/design/cloudflare-deploy-guide.md:105-205`
- Modify: `scripts/delivery-recovery-docs.test.mjs`

**Interfaces:**

- Consumes: exact secret/report/gate names from Tasks 1-3 and S1 lifecycle runbook.
- Produces: final automatic deployment order, evidence whitelist, failure classification, and orphan-session response.

- [ ] **Step 1: Write failing docs contract tests**

```js
test('delivery docs require authenticated business smoke after public proxy smoke', () => {
  for (const file of ['README.md', 'docs/design/cloudflare-deploy-guide.md']) {
    const contents = fs.readFileSync(file, 'utf8');
    const publicIndex = contents.indexOf('웹/API proxy smoke');
    const authenticatedIndex = contents.indexOf('authenticated business smoke');
    assert.ok(publicIndex >= 0, `${file} must retain public proxy smoke`);
    assert.ok(authenticatedIndex > publicIndex, `${file} must order authenticated smoke last`);
    for (const required of [
      'PRODUCTION_SMOKE_PASSWORD',
      'authenticated-business-smoke-v1',
      'login → me → purchase-order read → logout → old-cookie 401',
      'disable',
      'rotate',
    ]) {
      assert.ok(contents.includes(required), `${file} must include ${required}`);
    }
  }
  const guide = fs.readFileSync('docs/design/cloudflare-deploy-guide.md', 'utf8');
  assert.ok(guide.includes('authenticated_business_smoked'));
  for (const required of [
    'smokeVersion: authenticated-business-smoke-v1',
    'executedAt', 'gitSha', 'runId', 'runAttempt',
    'target: web', 'outcome: verified',
    'orphan session', 'identity projection', 'raw URL/error',
  ]) {
    assert.ok(guide.includes(required), `deployment guide must include ${required}`);
  }
});
```

- [ ] **Step 2: Run docs tests and verify RED**

Run: `node --test scripts/delivery-recovery-docs.test.mjs`

Expected: FAIL because authenticated gate evidence and final phase are absent.

- [ ] **Step 3: Update README automatic deployment sequence and secret table**

```markdown
11. authenticated business smoke: `login → me → purchase-order read → logout → old-cookie 401`

Repository secret `PRODUCTION_SMOKE_PASSWORD`는 S1 provision readiness 이후에만 설치하며 deploy workflow의 마지막 authenticated business smoke step에만 전달합니다. 성공 evidence는 `authenticated-business-smoke-v1` whitelist뿐이고 secret value는 문서, log 또는 artifact에 남기지 않습니다.
```

- [ ] **Step 4: Update deployment guide evidence and failure table**

```markdown
#### Authenticated business smoke evidence

허용 evidence는 `smokeVersion: authenticated-business-smoke-v1`, `executedAt`, `gitSha`, `runId`, `runAttempt`, `target: web`, `outcome: verified`뿐이다. Password, cookie, identity projection, query sentinel, response header/body, business row/count, raw URL/error는 log, summary, artifact 또는 delivery record에 남기지 않는다.

| `web_proxy_smoked` | login page와 unauthenticated proxy가 통과 | fixed identity authenticated business smoke 실행; 실패 우회 금지 |
| `authenticated_business_smoked` | login → me → purchase-order read → logout → old-cookie 401 통과 | deployment 완료 증거 보존 |

Runner termination은 logout 전에 orphan session을 남길 수 있다. `sessions` row를 출력하지 말고, credential/session invalidation이 필요하면 S1 runbook의 `disable`로 모든 세션을 폐기한 뒤 secret을 교체하고 `rotate`로 identity를 재활성화한다.
```

- [ ] **Step 5: Run docs/workflow tests and verify GREEN**

Run: `node --test scripts/delivery-recovery-docs.test.mjs scripts/deploy-workflow.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 6: Commit final runbook**

```bash
git add README.md docs/design/cloudflare-deploy-guide.md scripts/delivery-recovery-docs.test.mjs
git commit -m "docs: document authenticated smoke gate"
```

---

### Task 5: Verify, review, merge, and prove S2 in production

**Files:**

- Verify/deliver only; no new source file expected.

**Interfaces:**

- Produces: reviewed S2 PR, merge SHA, successful production `authenticated-business-smoke-v1` evidence, and Wave 1 completion.

- [ ] **Step 1: Run the complete local gate**

```bash
set -euo pipefail
npm ci
npm test
npm run typecheck
npm run build
npm ci --prefix frontend
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run build:cloudflare --prefix frontend
git diff --check
test -z "$(git status --short)"
```

Expected: all commands exit 0 and worktree status is empty. Record the exact commands and pass/fail results in the PR body; do not invent test counts.

- [ ] **Step 2: Request independent spec and security review**

Use `superpowers:requesting-code-review` with separate spec-compliance and code-quality/security passes. Required focus:

- arbitrary-origin credential exfiltration;
- cookie parsing and multiple-cookie ambiguity;
- cleanup/no-retry semantics and orphan sessions;
- strict login/me/business/logout/revoked projections;
- runtime schema import in clean deploy-web job;
- secret/log/body/header/URL leakage;
- workflow ordering, scope, and bypass paths.

Expected: no unresolved blocker, high, or medium finding. Fix with TDD and rerun Step 1.

- [ ] **Step 3: Publish the S2 branch and PR**

Use `github:yeet` after verification and review.

```bash
set -euo pipefail
git push -u origin feat/wave-1b-authenticated-smoke-gate
s1_run_url=''
while read -r run_id run_url; do
  if gh run view "$run_id" --log | rg '\{"operationVersion":"production-smoke-identity-operation-v1","executedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","databaseName":"hereisorder","action":"provision","outcome":"completed"\}' >/dev/null; then
    s1_run_url="$run_url"
    break
  fi
done < <(gh run list --workflow manage-smoke-identity.yml --branch main \
  --event workflow_dispatch --status success --limit 20 \
  --json databaseId,url --jq '.[] | [.databaseId, .url] | @tsv')
test -n "$s1_run_url"
pr_body="$(printf '%s\n' \
  '## Summary' \
  '- Adds a strict six-request same-origin authenticated business smoke.' \
  '- Gates the verified web deployment after public proxy smoke.' \
  '- Documents whitelist evidence and orphan-session recovery.' \
  '' \
  '## Verification' \
  '- `npm ci` — passed' \
  '- `npm test` — passed' \
  '- `npm run typecheck` — passed' \
  '- `npm run build` — passed' \
  '- `npm ci --prefix frontend` — passed' \
  '- `npm run test --prefix frontend` — passed' \
  '- `npm run lint --prefix frontend` — passed' \
  '- `npm run build --prefix frontend` — passed' \
  '- `npm run build:cloudflare --prefix frontend` — passed' \
  '- `git diff --check` — passed' \
  '- `git status --short` — clean' \
  '' \
  '## Data impact' \
  '- DB change: login/logout sessions and audit facts during production smoke' \
  '- Migration change: none' \
  "- S1 lifecycle evidence: $s1_run_url")"
pr_url="$(gh pr create \
  --base main \
  --head feat/wave-1b-authenticated-smoke-gate \
  --title 'feat: gate deployment on authenticated business smoke' \
  --body "$pr_body")"
unset pr_body
pr_number="${pr_url##*/}"
test -n "$pr_number"
```

Expected: the PR body contains the literal pass results, data-impact statements, and one S1 run URL whose log has exact provision evidence. Apart from that approved GitHub evidence URL, do not add an identity projection, credential, cookie, sentinel, deployment origin, raw error, business row/count, account ID, or database UUID.

- [ ] **Step 4: Wait for checks, merge, and update main**

```bash
set -euo pipefail
pr_number="$(gh pr list --head feat/wave-1b-authenticated-smoke-gate --state open --limit 2 \
  --json number --jq 'if length == 1 then .[0].number else empty end')"
test -n "$pr_number"
gh pr checks "$pr_number" --watch
gh pr merge "$pr_number" --squash
merge_sha=''
for attempt in {1..30}; do
  pr_state="$(gh pr view "$pr_number" --json state --jq '.state')"
  if [ "$pr_state" = 'MERGED' ]; then
    merge_sha="$(gh pr view "$pr_number" --json mergeCommit --jq '.mergeCommit.oid')"
    break
  fi
  sleep 10
done
test -n "$merge_sha"
git -C /home/ubuntu/workspace/projects/Here-is-order pull --ff-only origin main
test "$(git -C /home/ubuntu/workspace/projects/Here-is-order rev-parse HEAD)" = "$merge_sha"
if git ls-remote --exit-code --heads origin feat/wave-1b-authenticated-smoke-gate >/dev/null 2>&1; then
  git push origin --delete feat/wave-1b-authenticated-smoke-gate
fi
```

Expected: required checks pass, the PR reaches exact `MERGED` state within five minutes, and local `main` equals both `origin/main` and the PR merge commit before production evidence is inspected.

- [ ] **Step 5: Watch the exact merge deployment**

```bash
set -euo pipefail
pr_number="$(gh pr list --head feat/wave-1b-authenticated-smoke-gate --state merged --limit 2 \
  --json number --jq 'if length == 1 then .[0].number else empty end')"
test -n "$pr_number"
merge_sha="$(gh pr view "$pr_number" --json mergeCommit --jq '.mergeCommit.oid')"
test "$(git -C /home/ubuntu/workspace/projects/Here-is-order rev-parse HEAD)" = "$merge_sha"
merge_run_id=''
for attempt in {1..30}; do
  merge_run_ids="$(gh run list --workflow deploy-worker.yml --branch main --event push --limit 50 \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$merge_sha\") | .databaseId")"
  merge_run_count="$(printf '%s\n' "$merge_run_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$merge_run_count" -gt 1 ]; then
    exit 1
  fi
  if [ "$merge_run_count" -eq 1 ]; then
    merge_run_id="$merge_run_ids"
    break
  fi
  sleep 10
done
test -n "$merge_run_id"
gh run watch "$merge_run_id" --exit-status
```

Expected: exact API/web version verification, API readiness, public web proxy smoke, and authenticated business smoke all pass for the merge SHA.

- [ ] **Step 6: Inspect only whitelist evidence and forbidden-marker absence**

```bash
set -euo pipefail
safe_log_path=/tmp/wave-1b-s2-safe-log.txt
trap 'rm -f "$safe_log_path"' EXIT
pr_number="$(gh pr list --head feat/wave-1b-authenticated-smoke-gate --state merged --limit 2 \
  --json number --jq 'if length == 1 then .[0].number else empty end')"
test -n "$pr_number"
merge_sha="$(gh pr view "$pr_number" --json mergeCommit --jq '.mergeCommit.oid')"
merge_run_ids="$(gh run list --workflow deploy-worker.yml --branch main --event push --status success --limit 50 \
  --json databaseId,headSha \
  --jq ".[] | select(.headSha == \"$merge_sha\") | .databaseId")"
merge_run_count="$(printf '%s\n' "$merge_run_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
test "$merge_run_count" -eq 1
merge_run_id="$merge_run_ids"
gh run view "$merge_run_id" --log > "$safe_log_path"
safe_report_matches="$(rg -o "\\{\"smokeVersion\":\"authenticated-business-smoke-v1\",\"executedAt\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z\",\"gitSha\":\"$merge_sha\",\"runId\":\"[1-9][0-9]*\",\"runAttempt\":[1-9][0-9]*,\"target\":\"web\",\"outcome\":\"verified\"\\}" "$safe_log_path")"
safe_report_count="$(printf '%s\n' "$safe_report_matches" | sed '/^$/d' | wc -l | tr -d ' ')"
test "$safe_report_count" -eq 1
unset safe_report_matches
if rg 'password_hash|isorder_sid|after_json|before_json|purchase_orders\s*:' "$safe_log_path"; then
  exit 1
fi
rm -f "$safe_log_path"
trap - EXIT
```

Expected: one whitelist authenticated report and no forbidden marker. The log file is transient, contains only GitHub run output, and is deleted immediately after inspection.

- [ ] **Step 7: Close Wave 1 and prepare Wave 2**

Record only merge SHA, deployment run URL, API/web version IDs already allowed by Wave 1B-R evidence, and the authenticated report whitelist. Mark Wave 1 complete. Then use `superpowers:finishing-a-development-branch` and run from the main checkout:

```bash
set -euo pipefail
cd /home/ubuntu/workspace/projects/Here-is-order
git worktree remove .worktrees/wave-1b-authenticated-smoke-gate
git branch -D feat/wave-1b-authenticated-smoke-gate
test -z "$(git status --short)"
git status --short --branch
```

Expected: S2 PR is confirmed merged, its production run passed, the isolated worktree/local squash branch are gone, and main is clean. Do not begin Wave 2 authorization implementation until its own brainstorming/design approval gate.
