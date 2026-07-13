import assert from 'node:assert/strict';
import test from 'node:test';

import {
  smokeApi,
  smokeWeb,
  validateDeploymentOrigin,
} from './smoke-deployment.mjs';

test('validateDeploymentOrigin accepts only a clean HTTPS origin', () => {
  assert.equal(validateDeploymentOrigin('https://api.example.com').origin, 'https://api.example.com');
  assert.throws(() => validateDeploymentOrigin('http://api.example.com'), /HTTPS/);
  assert.throws(() => validateDeploymentOrigin('https://user:pass@api.example.com'), /credentials/);
  assert.throws(() => validateDeploymentOrigin('https://api.example.com/path'), /origin/);
  assert.throws(() => validateDeploymentOrigin('https://api.example.com/?query=1'), /query|hash/);
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const HEALTH_BODY = { ok: true, data: { ok: true } };
const READINESS_BODY = {
  ok: true,
  data: {
    ready: true,
    schemaVersion: 'd1-required-schema-v1',
  },
};

test('smokeApi checks health then exact D1 readiness on the same origin', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ origin: url.origin, path: url.pathname, redirect: init?.redirect });
    return url.pathname === '/health'
      ? jsonResponse(HEALTH_BODY)
      : jsonResponse(READINESS_BODY);
  };

  await smokeApi('https://api.example.com', {
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });

  assert.deepEqual(requests, [
    { origin: 'https://api.example.com', path: '/health', redirect: 'manual' },
    { origin: 'https://api.example.com', path: '/ready', redirect: 'manual' },
  ]);
});

test('smokeApi rejects every non-exact readiness response', async (t) => {
  const cases = [
    ['HTTP 503', async () => jsonResponse({ secret: 'do-not-log' }, 503), /HTTP 503/],
    ['malformed JSON', async () => new Response('not-json secret', { status: 200 }), /unexpected response/],
    ['missing envelope field', async () => jsonResponse({
      ok: true,
      data: { ready: true },
    }), /unexpected response/],
    ['wrong schema version', async () => jsonResponse({
      ok: true,
      data: { ready: true, schemaVersion: 'd1-required-schema-v0' },
    }), /unexpected response/],
    ['extra envelope field', async () => jsonResponse({
      ...READINESS_BODY,
      leaked: 'row-data',
    }), /unexpected response/],
    ['redirect', async () => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.com/ready' },
    }), /HTTP 302/],
    ['transport failure', async () => {
      throw new Error('transport unavailable');
    }, /transport unavailable/],
  ];

  for (const [label, readinessResponse, expectedError] of cases) {
    await t.test(label, async () => {
      const fetchImpl = async (url) => url.pathname === '/health'
        ? jsonResponse(HEALTH_BODY)
        : readinessResponse();

      await assert.rejects(
        smokeApi('https://api.example.com', {
          attempts: 1,
          delayMs: 0,
          fetchImpl,
        }),
        expectedError,
      );
    });
  }
});

test('smokeApi retry restarts the health/readiness pair without logging response data', async () => {
  const paths = [];
  let readinessAttempts = 0;
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/health') return jsonResponse(HEALTH_BODY);
    readinessAttempts += 1;
    if (readinessAttempts === 1) {
      return jsonResponse({ secret: 'production-row-value' }, 503);
    }
    return jsonResponse(READINESS_BODY);
  };
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  try {
    await smokeApi('https://api.example.com', {
      attempts: 2,
      delayMs: 0,
      fetchImpl,
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(paths, ['/health', '/ready', '/health', '/ready']);
  assert.deepEqual(logs, []);
});

test('smokeWeb checks the login page and unauthenticated API proxy', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/login') {
      return new Response('<!doctype html>', { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  await smokeWeb('https://web.example.com', {
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });

  assert.deepEqual(paths, ['/login', '/api/users/me']);
});
