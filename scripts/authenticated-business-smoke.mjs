import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9]\d*$/;
const REPORT_INPUT_KEYS = [
  'executedAt',
  'gitSha',
  'runId',
  'runAttempt',
];
const REPORT_KEYS = [
  'smokeVersion',
  'executedAt',
  'gitSha',
  'runId',
  'runAttempt',
  'target',
  'outcome',
];

export const AUTHENTICATED_SMOKE_VERSION = 'authenticated-business-smoke-v1';

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function exactOrderedKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).join(',') === keys.join(',');
}

function matchesString(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
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

export function parseAuthenticatedSmokeEnvironment(env) {
  try {
    const runAttempt = Number(env?.GITHUB_RUN_ATTEMPT);
    if (!env
      || typeof env !== 'object'
      || Array.isArray(env)
      || env.CI !== 'true'
      || env.GITHUB_ACTIONS !== 'true'
      || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      || env.GITHUB_REF !== 'refs/heads/main'
      || !matchesString(env.GITHUB_SHA, GIT_SHA_PATTERN)
      || !matchesString(env.GITHUB_RUN_ID, RUN_ID_PATTERN)
      || !matchesString(env.GITHUB_RUN_ATTEMPT, RUN_ID_PATTERN)
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

export function buildAuthenticatedSmokeReport(input) {
  try {
    if (!exactKeys(input, REPORT_INPUT_KEYS)
      || !isCanonicalTimestamp(input.executedAt)
      || !matchesString(input.gitSha, GIT_SHA_PATTERN)
      || !matchesString(input.runId, RUN_ID_PATTERN)
      || !Number.isSafeInteger(input.runAttempt)
      || input.runAttempt < 1) {
      throw new Error('invalid report');
    }
    return Object.freeze({
      smokeVersion: AUTHENTICATED_SMOKE_VERSION,
      executedAt: input.executedAt,
      gitSha: input.gitSha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      target: 'web',
      outcome: 'verified',
    });
  } catch {
    throw new Error('Authenticated smoke report was invalid.');
  }
}

export function renderAuthenticatedSmokeSummary(report) {
  try {
    if (!exactOrderedKeys(report, REPORT_KEYS)
      || report.smokeVersion !== AUTHENTICATED_SMOKE_VERSION
      || report.target !== 'web'
      || report.outcome !== 'verified') {
      throw new Error('invalid report');
    }
    buildAuthenticatedSmokeReport({
      executedAt: report.executedAt,
      gitSha: report.gitSha,
      runId: report.runId,
      runAttempt: report.runAttempt,
    });
    return `## Authenticated business smoke\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  } catch {
    throw new Error('Authenticated smoke report was invalid.');
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
    if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) {
      throw new Error('invalid time');
    }
    const report = buildAuthenticatedSmokeReport({
      executedAt: currentTime.toISOString(),
      gitSha: environment.gitSha,
      runId: environment.runId,
      runAttempt: environment.runAttempt,
    });
    await appendSummary(
      environment.summaryPath,
      renderAuthenticatedSmokeSummary(report),
    );
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
