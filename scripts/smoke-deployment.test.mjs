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

test('smokeApi checks the public health response contract', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url.pathname);
    return new Response(JSON.stringify({ ok: true, data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await smokeApi('https://api.example.com', {
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });

  assert.deepEqual(paths, ['/health']);
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
