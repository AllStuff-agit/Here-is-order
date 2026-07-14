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

function responseMediaType(response) {
  return response instanceof Response
    ? response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    : null;
}

async function exactJson(response) {
  const mediaType = responseMediaType(response);
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
  if (matching[0].includes(',')) throw new Error('invalid cookie');
  const pair = matching[0].split(';', 1)[0];
  if (!/^isorder_sid=[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(pair)) {
    throw new Error('invalid cookie');
  }
  return pair;
}

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
    if (!(page instanceof Response)
      || page.status !== 200
      || responseMediaType(page) !== 'text/html') {
      throw new Error('invalid login page');
    }

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
    if (business.status !== 200
      || businessEnvelope.ok !== true
      || businessEnvelope.data.length !== 0) {
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
