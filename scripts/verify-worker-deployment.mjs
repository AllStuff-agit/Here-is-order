import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseActiveDeployment } from './production-preflight.mjs';

export const DEPLOYMENT_VERIFICATION_VERSION = 'worker-active-version-verification-v1';

const WRANGLER_VERSION = '4.110.0';
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const MAX_NDJSON_BYTES = 64 * 1024;
const MAX_OUTPUT_AGE_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 1000;
const REST_TIMEOUT_MS = 10 * 1000;
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3 * 1000;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const TARGETS = Object.freeze({
  api: Object.freeze({
    target: 'api',
    workerName: 'hereisorder',
    configPath: 'wrangler.toml',
    workingDirectory: '.',
  }),
  web: Object.freeze({
    target: 'web',
    workerName: 'hereisorder-web',
    configPath: 'wrangler.jsonc',
    workingDirectory: 'frontend',
  }),
});
const REPORT_INPUT_KEYS = [
  'executedAt',
  'gitSha',
  'runId',
  'runAttempt',
  'target',
  'workerName',
  'deploymentId',
  'versionId',
  'trafficPercentage',
  'deploymentUrl',
];
const REPORT_KEYS = [
  'verificationVersion',
  ...REPORT_INPUT_KEYS,
  'outcome',
];
const WRANGLER_SESSION_KEYS = [
  'type',
  'version',
  'wrangler_version',
  'command_line_args',
  'log_file_path',
  'timestamp',
];
const WRANGLER_DEPLOY_KEYS = [
  'type',
  'version',
  'worker_name',
  'worker_tag',
  'version_id',
  'targets',
  'worker_name_overridden',
  'timestamp',
];

function hasExactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isNonblankCredential(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedNonblankString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function deploymentTimestampKey(value) {
  const match = typeof value === 'string' && value.match(RFC3339_UTC_PATTERN);
  if (!match) return null;
  return `${match.slice(1, 7).join('')}${(match[7] ?? '').padEnd(9, '0')}`;
}

function isAbsoluteNormalizedPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseDeploymentOrigin(value, workerName) {
  try {
    if (typeof value !== 'string') throw new Error('invalid URL');
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.port !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || value !== url.origin
      || labels.length !== 4
      || labels[0] !== workerName
      || labels[1].length === 0
      || labels[2] !== 'workers'
      || labels[3] !== 'dev') {
      throw new Error('invalid URL');
    }
    return url.origin;
  } catch {
    throw new Error('Worker deployment URL was invalid.');
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function getWorkerTarget(target) {
  if (typeof target !== 'string' || !Object.hasOwn(TARGETS, target)) {
    throw new Error('Worker deployment target was invalid.');
  }
  const selected = TARGETS[target];
  return selected;
}

export function parseWranglerDeployEvidence({ contents, target, gitSha, now }) {
  try {
    const selected = getWorkerTarget(target);
    if (typeof contents !== 'string'
      || Buffer.byteLength(contents, 'utf8') > MAX_NDJSON_BYTES
      || !contents.endsWith('\n')
      || !GIT_SHA_PATTERN.test(gitSha)
      || !(now instanceof Date)
      || !Number.isFinite(now.getTime())) {
      throw new Error('invalid input');
    }

    const body = contents.slice(0, -1);
    const lines = body.split('\n');
    if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
      throw new Error('invalid record count');
    }
    const records = lines.map((line) => {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid record');
      }
      return parsed;
    });
    const [session, deploy] = records;
    const expectedArgs = ['deploy', '--message', gitSha, '--strict'];
    if (!hasExactKeys(session, WRANGLER_SESSION_KEYS)
      || !hasExactKeys(deploy, WRANGLER_DEPLOY_KEYS)
      || session.type !== 'wrangler-session'
      || session.version !== 1
      || session.wrangler_version !== WRANGLER_VERSION
      || JSON.stringify(session.command_line_args) !== JSON.stringify(expectedArgs)
      || !isNonblankCredential(session.log_file_path)
      || deploy.type !== 'deploy'
      || deploy.version !== 1
      || deploy.worker_name !== selected.workerName
      || !(deploy.worker_tag === null || isBoundedNonblankString(deploy.worker_tag, 256))
      || deploy.worker_name_overridden !== false
      || !isUuid(deploy.version_id)
      || !Array.isArray(deploy.targets)
      || deploy.targets.length !== 1
      || !isCanonicalTimestamp(session.timestamp)
      || !isCanonicalTimestamp(deploy.timestamp)) {
      throw new Error('invalid deploy session');
    }

    const nowMs = now.getTime();
    const sessionMs = Date.parse(session.timestamp);
    const deployMs = Date.parse(deploy.timestamp);
    if (sessionMs > deployMs
      || sessionMs < nowMs - MAX_OUTPUT_AGE_MS
      || deployMs < nowMs - MAX_OUTPUT_AGE_MS
      || sessionMs > nowMs + FUTURE_TOLERANCE_MS
      || deployMs > nowMs + FUTURE_TOLERANCE_MS) {
      throw new Error('stale deploy session');
    }

    const evidence = {
      target: selected.target,
      workerName: selected.workerName,
      versionId: deploy.version_id,
      deploymentUrl: parseDeploymentOrigin(deploy.targets[0], selected.workerName),
    };
    return deepFreeze(evidence);
  } catch {
    throw new Error('Wrangler deploy evidence was invalid.');
  }
}

export function parseVerifiedActiveDeployment({ result, expectedVersionId, gitSha }) {
  try {
    if (!isUuid(expectedVersionId) || !GIT_SHA_PATTERN.test(gitSha)) {
      throw new Error('invalid expectation');
    }
    const active = parseActiveDeployment(result);
    if (active.versions.length !== 1
      || active.versions[0].versionId !== expectedVersionId
      || active.versions[0].percentage !== 100) {
      throw new Error('unexpected active version');
    }
    const matches = result.deployments.filter((entry) => entry?.id === active.deploymentId);
    const activeTimestampKey = matches.length === 1
      ? deploymentTimestampKey(matches[0].created_on)
      : null;
    const equallyNew = activeTimestampKey === null
      ? []
      : result.deployments.filter(
        (entry) => deploymentTimestampKey(entry?.created_on) === activeTimestampKey,
      );
    if (matches.length !== 1
      || equallyNew.length !== 1
      || matches[0]?.annotations?.['workers/message'] !== gitSha) {
      throw new Error('unexpected deployment annotation');
    }
    return deepFreeze({
      deploymentId: active.deploymentId,
      versionId: expectedVersionId,
      trafficPercentage: 100,
    });
  } catch {
    throw new Error('Expected active Worker deployment was invalid.');
  }
}

export function parseVerifiedWorkerVersion({ result, expectedVersionId, gitSha }) {
  try {
    if (!result
      || typeof result !== 'object'
      || Array.isArray(result)
      || !isUuid(expectedVersionId)
      || !GIT_SHA_PATTERN.test(gitSha)
      || result.id !== expectedVersionId
      || result.annotations?.['workers/message'] !== gitSha) {
      throw new Error('invalid version');
    }
    return deepFreeze({ versionId: expectedVersionId });
  } catch {
    throw new Error('Expected Worker version was invalid.');
  }
}

async function readCloudflareEnvelope({ url, apiToken, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw new Error('invalid response');
  }
  const envelope = await response.json();
  if (!envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || envelope.success !== true
    || !envelope.result
    || typeof envelope.result !== 'object'
    || Array.isArray(envelope.result)) {
    throw new Error('invalid envelope');
  }
  return envelope.result;
}

export async function readVerifiedWorkerDeployment({
  accountId,
  apiToken,
  target,
  expectedVersionId,
  gitSha,
  fetchImpl = fetch,
}) {
  try {
    const selected = getWorkerTarget(target);
    if (!ACCOUNT_ID_PATTERN.test(accountId)
      || !isNonblankCredential(apiToken)
      || !isUuid(expectedVersionId)
      || !GIT_SHA_PATTERN.test(gitSha)
      || typeof fetchImpl !== 'function') {
      throw new Error('invalid request');
    }
    const scriptUrl = `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}`
      + `/workers/scripts/${encodeURIComponent(selected.workerName)}`;
    const readActiveDeployment = async () => {
      const deploymentResult = await readCloudflareEnvelope({
        url: `${scriptUrl}/deployments`,
        apiToken,
        fetchImpl,
      });
      return parseVerifiedActiveDeployment({
        result: deploymentResult,
        expectedVersionId,
        gitSha,
      });
    };
    const initialActive = await readActiveDeployment();
    const versionResult = await readCloudflareEnvelope({
      url: `${scriptUrl}/versions/${expectedVersionId}`,
      apiToken,
      fetchImpl,
    });
    parseVerifiedWorkerVersion({
      result: versionResult,
      expectedVersionId,
      gitSha,
    });
    const finalActive = await readActiveDeployment();
    if (finalActive.deploymentId !== initialActive.deploymentId
      || finalActive.versionId !== initialActive.versionId
      || finalActive.trafficPercentage !== initialActive.trafficPercentage) {
      throw new Error('active deployment changed during verification');
    }
    return finalActive;
  } catch {
    throw new Error('Cloudflare Worker deployment verification request failed.');
  }
}

export async function verifyWorkerDeploymentWithRetry({
  readAttempt,
  maxAttempts = RETRY_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (typeof readAttempt !== 'function'
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 10
    || !Number.isSafeInteger(retryDelayMs)
    || retryDelayMs < 0
    || retryDelayMs > 30_000
    || typeof sleep !== 'function') {
    throw new Error('Worker deployment retry policy was invalid.');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readAttempt();
    } catch {
      if (attempt === maxAttempts) break;
      try {
        await sleep(retryDelayMs);
      } catch {
        break;
      }
    }
  }
  throw new Error('Worker deployment did not become active.');
}

export function parseDeploymentVerificationEnvironment({ env, target }) {
  try {
    getWorkerTarget(target);
    const runAttempt = Number(env?.GITHUB_RUN_ATTEMPT);
    const paths = [
      env?.GITHUB_STEP_SUMMARY,
      env?.GITHUB_OUTPUT,
      env?.WRANGLER_OUTPUT_FILE_PATH,
    ];
    if (!env
      || typeof env !== 'object'
      || env.CI !== 'true'
      || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      || env.GITHUB_REF !== 'refs/heads/main'
      || !GIT_SHA_PATTERN.test(env.GITHUB_SHA)
      || !POSITIVE_INTEGER_PATTERN.test(env.GITHUB_RUN_ID)
      || !POSITIVE_INTEGER_PATTERN.test(env.GITHUB_RUN_ATTEMPT)
      || !Number.isSafeInteger(runAttempt)
      || runAttempt < 1
      || !ACCOUNT_ID_PATTERN.test(env.CLOUDFLARE_ACCOUNT_ID)
      || !isNonblankCredential(env.CLOUDFLARE_API_TOKEN)
      || !paths.every(isAbsoluteNormalizedPath)
      || new Set(paths).size !== paths.length
      || !env.WRANGLER_OUTPUT_FILE_PATH.endsWith('.ndjson')) {
      throw new Error('invalid environment');
    }
    return deepFreeze({
      gitSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      summaryPath: env.GITHUB_STEP_SUMMARY,
      outputPath: env.GITHUB_OUTPUT,
      wranglerOutputPath: env.WRANGLER_OUTPUT_FILE_PATH,
    });
  } catch {
    throw new Error('Worker deployment verification environment was invalid.');
  }
}

function validateReportInput(input) {
  if (!hasExactKeys(input, REPORT_INPUT_KEYS)) return false;
  let selected;
  try {
    selected = getWorkerTarget(input.target);
  } catch {
    return false;
  }
  try {
    return isCanonicalTimestamp(input.executedAt)
      && GIT_SHA_PATTERN.test(input.gitSha)
      && POSITIVE_INTEGER_PATTERN.test(input.runId)
      && Number.isSafeInteger(input.runAttempt)
      && input.runAttempt > 0
      && input.workerName === selected.workerName
      && isUuid(input.deploymentId)
      && isUuid(input.versionId)
      && input.trafficPercentage === 100
      && parseDeploymentOrigin(input.deploymentUrl, selected.workerName) === input.deploymentUrl;
  } catch {
    return false;
  }
}

export function buildWorkerDeploymentReport(input) {
  try {
    if (!validateReportInput(input)) throw new Error('invalid report');
    return deepFreeze({
      verificationVersion: DEPLOYMENT_VERIFICATION_VERSION,
      executedAt: input.executedAt,
      gitSha: input.gitSha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      target: input.target,
      workerName: input.workerName,
      deploymentId: input.deploymentId,
      versionId: input.versionId,
      trafficPercentage: input.trafficPercentage,
      deploymentUrl: input.deploymentUrl,
      outcome: 'verified',
    });
  } catch {
    throw new Error('Worker deployment verification report was invalid.');
  }
}

function isExactReport(report) {
  if (!hasExactKeys(report, REPORT_KEYS)
    || report.verificationVersion !== DEPLOYMENT_VERIFICATION_VERSION
    || report.outcome !== 'verified') {
    return false;
  }
  const input = Object.fromEntries(REPORT_INPUT_KEYS.map((key) => [key, report[key]]));
  return validateReportInput(input);
}

export function renderWorkerDeploymentSummary(report) {
  if (!isExactReport(report)) {
    throw new Error('Worker deployment verification report was invalid.');
  }
  return `## Worker active version verification\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

async function defaultVerifyActiveVersion({ evidence, environment }) {
  return verifyWorkerDeploymentWithRetry({
    readAttempt: () => readVerifiedWorkerDeployment({
      accountId: environment.accountId,
      apiToken: environment.apiToken,
      target: evidence.target,
      expectedVersionId: evidence.versionId,
      gitSha: environment.gitSha,
    }),
  });
}

export async function runWorkerDeploymentVerification({
  target,
  env = process.env,
  now = () => new Date(),
  readFile = (filePath) => fs.readFileSync(filePath, 'utf8'),
  verifyActiveVersion = defaultVerifyActiveVersion,
  appendSummary = (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8'),
  appendOutput = (filePath, contents) => fs.appendFileSync(filePath, contents, 'utf8'),
  log = (contents) => console.log(contents),
} = {}) {
  try {
    const selected = getWorkerTarget(target);
    const environment = parseDeploymentVerificationEnvironment({ env, target });
    const currentTime = now();
    if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) {
      throw new Error('invalid time');
    }
    const contents = await readFile(environment.wranglerOutputPath);
    const evidence = parseWranglerDeployEvidence({
      contents,
      target,
      gitSha: environment.gitSha,
      now: currentTime,
    });
    const state = await verifyActiveVersion({
      evidence,
      environment,
      target: selected,
    });
    const report = buildWorkerDeploymentReport({
      executedAt: currentTime.toISOString(),
      gitSha: environment.gitSha,
      runId: environment.runId,
      runAttempt: environment.runAttempt,
      target: selected.target,
      workerName: selected.workerName,
      deploymentId: state?.deploymentId,
      versionId: state?.versionId,
      trafficPercentage: state?.trafficPercentage,
      deploymentUrl: evidence.deploymentUrl,
    });

    await appendOutput(environment.outputPath, `deployment-url=${report.deploymentUrl}\n`);
    await appendSummary(environment.summaryPath, renderWorkerDeploymentSummary(report));
    await log(JSON.stringify(report));
    return report;
  } catch {
    throw new Error('Worker deployment verification failed.');
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const invocation = args.length === 1
    ? runWorkerDeploymentVerification({ target: args[0] })
    : Promise.reject(new Error('invalid arguments'));
  invocation.catch(() => {
    console.error('Worker deployment verification failed.');
    process.exitCode = 1;
  });
}
