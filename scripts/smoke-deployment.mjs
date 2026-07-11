import { pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

export async function smokeApi(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async () => {
    const response = await fetchImpl(new URL('/health', baseUrl), { redirect: 'manual' });
    if (response.status !== 200) {
      throw new Error(`API health returned HTTP ${response.status}.`);
    }

    const body = await response.json();
    if (body?.ok !== true || body?.data?.ok !== true) {
      throw new Error('API health returned an unexpected response.');
    }
  }, options);
}

export async function smokeWeb(origin, options = {}) {
  const baseUrl = validateDeploymentOrigin(origin);
  const fetchImpl = options.fetchImpl ?? fetch;

  await retry(async () => {
    const loginResponse = await fetchImpl(new URL('/login', baseUrl), { redirect: 'manual' });
    if (loginResponse.status !== 200) {
      throw new Error(`Web login returned HTTP ${loginResponse.status}.`);
    }

    const proxyResponse = await fetchImpl(new URL('/api/users/me', baseUrl), { redirect: 'manual' });
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
