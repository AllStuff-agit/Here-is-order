import { pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 41;
const DEFAULT_DELAY_MS = 3_000;
const DEFAULT_PROPAGATION_WAIT_MS = (DEFAULT_ATTEMPTS - 1) * DEFAULT_DELAY_MS;
const DEFAULT_TIMEOUT_MS = DEFAULT_PROPAGATION_WAIT_MS + 10_000;
const D1_READINESS_SCHEMA_VERSION = 'd1-required-schema-v1';

export const SMOKE_RETRY_POLICY = Object.freeze({
  attempts: DEFAULT_ATTEMPTS,
  delayMs: DEFAULT_DELAY_MS,
  propagationWaitMs: DEFAULT_PROPAGATION_WAIT_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

const createTimeoutError = () => new Error('Deployment smoke timed out.');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timeoutHandle);
    reject(createTimeoutError());
  };
  const timeoutHandle = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
});

export function validateDeploymentOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Deployment URL is required.');
  }

  const url = new URL(value.trim());
  if (url.protocol !== 'https:') {
    throw new Error('Deployment URL must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Deployment URL must not include credentials.');
  }
  if (url.pathname !== '/') {
    throw new Error('Deployment URL must be an origin without a path.');
  }
  if (url.search || url.hash) {
    throw new Error('Deployment URL must not include a query string or hash.');
  }

  return url;
}

async function retry(check, options) {
  const attempts = options.attempts ?? SMOKE_RETRY_POLICY.attempts;
  const delayMs = options.delayMs ?? SMOKE_RETRY_POLICY.delayMs;
  const timeoutMs = options.timeoutMs ?? SMOKE_RETRY_POLICY.timeoutMs;
  const sleepImpl = options.sleepImpl ?? sleep;
  const controller = new AbortController();
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(createTimeoutError());
    }, timeoutMs);
  });
  const retryPromise = (async () => {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await check(controller.signal);
        return;
      } catch (error) {
        if (controller.signal.aborted) {
          throw createTimeoutError();
        }
        lastError = error;
        if (attempt < attempts) {
          await sleepImpl(delayMs, controller.signal);
        }
      }
    }

    throw lastError;
  })();

  try {
    await Promise.race([retryPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expectedKeys].sort().join(',');
}

function isExactReadinessBody(body) {
  return hasExactKeys(body, ['ok', 'data'])
    && body.ok === true
    && hasExactKeys(body.data, ['ready', 'schemaVersion'])
    && body.data.ready === true
    && body.data.schemaVersion === D1_READINESS_SCHEMA_VERSION;
}

export async function smokeApi(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async (signal) => {
    const response = await fetchImpl(new URL('/health', baseUrl), {
      redirect: 'manual',
      signal,
    });
    if (response.status !== 200) {
      throw new Error(`API health returned HTTP ${response.status}.`);
    }

    const body = await response.json();
    if (body?.ok !== true || body?.data?.ok !== true) {
      throw new Error('API health returned an unexpected response.');
    }

    const readinessResponse = await fetchImpl(new URL('/ready', baseUrl), {
      redirect: 'manual',
      signal,
    });
    if (readinessResponse.status !== 200) {
      throw new Error(`API readiness returned HTTP ${readinessResponse.status}.`);
    }

    let readinessBody;
    try {
      readinessBody = await readinessResponse.json();
    } catch {
      throw new Error('API readiness returned an unexpected response.');
    }
    if (!isExactReadinessBody(readinessBody)) {
      throw new Error('API readiness returned an unexpected response.');
    }
  }, options);
}

export async function smokeWeb(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async (signal) => {
    const loginResponse = await fetchImpl(new URL('/login', baseUrl), {
      redirect: 'manual',
      signal,
    });
    if (loginResponse.status !== 200) {
      throw new Error(`Web login returned HTTP ${loginResponse.status}.`);
    }

    const proxyResponse = await fetchImpl(new URL('/api/users/me', baseUrl), {
      redirect: 'manual',
      signal,
    });
    if (proxyResponse.status !== 401) {
      throw new Error(`Web API proxy returned HTTP ${proxyResponse.status}; expected 401.`);
    }
  }, options);
}

async function main() {
  const [target, origin] = process.argv.slice(2);
  if (target === 'api') {
    await smokeApi(origin);
  } else if (target === 'web') {
    await smokeWeb(origin);
  } else {
    throw new Error('Usage: node scripts/smoke-deployment.mjs <api|web> <https-origin>');
  }

  console.log(`${target} deployment smoke test passed: ${validateDeploymentOrigin(origin).origin}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
